import type { LayerSpecification, Map as MlMap, StyleSpecification } from "maplibre-gl";
import { loadString, saveString } from "./storage";

// Background maps ("basemaps"). Vector styles come from OpenFreeMap (free, no key);
// imagery from EOX (Sentinel-2 cloudless, 10 m), NASA GIBS (yesterday's VIIRS, 250 m)
// and MapTiler (sharp, needs a free key the user pastes in; kept in this browser only).
// Switching style keeps all data layers: see switchBasemap().

const OFM = "https://tiles.openfreemap.org/styles";
const KEY_KEY = "rhe.maptiler.key";
const OVERLAYS_KEY = "rhe.basemap.overlays";

export interface Basemap {
  id: string;
  label: string;
  /** Ids in src/sources.ts this basemap uses (for the About panel). */
  sources: string[];
  imagery?: boolean;
  needsKey?: boolean;
  /** Zoom beyond which the imagery only gets blurrier, and its ground resolution. */
  sharpUntil?: { zoom: number; res: string };
}

export const BASEMAPS: Basemap[] = [
  { id: "colour", label: "Colour", sources: ["openfreemap"] },
  { id: "light", label: "Light", sources: ["openfreemap"] },
  { id: "dark", label: "Dark", sources: ["openfreemap"] },
  { id: "bw", label: "Black & white", sources: ["openfreemap"] },
  { id: "sat", label: "Satellite (EOX, 10 m)", sources: ["eox"], imagery: true, sharpUntil: { zoom: 14, res: "10 m" } },
  { id: "sathd", label: "Satellite HD (MapTiler)", sources: ["maptiler"], imagery: true, needsKey: true },
  { id: "today", label: "Satellite, yesterday (NASA, 250 m)", sources: ["nasagibs"], imagery: true, sharpUntil: { zoom: 8, res: "250 m" } },
];

/** Backgrounds on which light-coloured icons read better. */
export function isDarkBasemap(id: string): boolean {
  return id === "dark" || BASEMAPS.some((b) => b.id === id && b.imagery);
}

/** Fonts for text in our own layers (e.g. cluster counts), whatever the background. */
export const GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";

export const BLANK_STYLE: StyleSpecification = {
  version: 8,
  glyphs: GLYPHS,
  sources: {},
  layers: [{ id: "background", type: "background", paint: { "background-color": "#e9edf0" } }],
};

let current = "colour";

/** Source ids (src/sources.ts) the current background map uses. */
export function currentBasemapSources(): string[] {
  const b = BASEMAPS.find((x) => x.id === current);
  if (!b) return [];
  return b.imagery && overlays().size ? [...b.sources, "openfreemap"] : b.sources;
}

export function maptilerKey(): string {
  return loadString(KEY_KEY) || (import.meta.env.VITE_MAPTILER_KEY as string | undefined) || "";
}

export function setMaptilerKey(key: string): void {
  saveString(KEY_KEY, key.trim());
}

/** What to draw over satellite imagery: any of "places", "roads", "borders" (default all). */
export type Overlay = "places" | "roads" | "borders";
export const OVERLAYS: [Overlay, string][] = [
  ["places", "place names"],
  ["roads", "road names"],
  ["borders", "borders"],
];

export function overlays(): Set<Overlay> {
  const raw = loadString(OVERLAYS_KEY);
  return new Set((raw ?? "places,roads,borders").split(",").filter((x): x is Overlay => OVERLAYS.some(([o]) => o === x)));
}

export function setOverlays(set: Set<Overlay>): void {
  saveString(OVERLAYS_KEY, [...set].join(","));
}

let positronCache: StyleSpecification | undefined;
async function positron(): Promise<StyleSpecification> {
  positronCache ??= (await (await fetch(`${OFM}/positron`)).json()) as StyleSpecification;
  // Deep copy: callers modify it.
  return JSON.parse(JSON.stringify(positronCache)) as StyleSpecification;
}

/** Black & white: Positron recoloured, roads and text in black, land white, water grey. */
function blackAndWhite(style: StyleSpecification): StyleSpecification {
  for (const l of style.layers) {
    const id = l.id;
    const p = (l as { paint?: Record<string, unknown> }).paint ?? {};
    if (l.type === "background") p["background-color"] = "#ffffff";
    else if (l.type === "raster") (l as { layout?: Record<string, unknown> }).layout = { visibility: "none" }; // shaded relief
    else if (l.type === "fill") p["fill-color"] = /water/.test(id) ? "#a8a8a8" : /building/.test(id) ? "#e4e4e4" : "#ffffff";
    else if (l.type === "line") {
      p["line-color"] = /water/.test(id) ? "#a8a8a8" : /boundary/.test(id) ? "#000000" : /rail/.test(id) ? "#555555" : "#000000";
      if (/highway|road|tunnel|bridge/.test(id) && typeof p["line-width"] !== "undefined") p["line-opacity"] = 0.85;
    } else if (l.type === "symbol") {
      p["text-color"] = "#000000";
      p["text-halo-color"] = "#ffffff";
      p["text-halo-width"] = 1.5;
    }
    (l as { paint?: Record<string, unknown> }).paint = p;
  }
  return style;
}

/** Place names, road names and/or borders from Positron, restyled to read on top of imagery. */
function imageryLabels(style: StyleSpecification, want: Set<Overlay>): { sources: StyleSpecification["sources"]; layers: LayerSpecification[] } {
  const keep = style.layers.filter(
    (l) =>
      (want.has("places") && l.type === "symbol" && /^(label_|water_name|airport)/.test(l.id)) ||
      (want.has("roads") && l.type === "symbol" && /^highway-name/.test(l.id)) ||
      (want.has("borders") && l.type === "line" && /^boundary/.test(l.id)),
  );
  for (const l of keep) {
    const p = ((l as { paint?: Record<string, unknown> }).paint ??= {});
    if (l.type === "symbol") {
      p["text-color"] = "#ffffff";
      p["text-halo-color"] = "rgba(0,0,0,0.8)";
      p["text-halo-width"] = 1.4;
    } else {
      p["line-color"] = "rgba(255,255,255,0.7)";
    }
  }
  return { sources: { openmaptiles: style.sources.openmaptiles }, layers: keep };
}

const GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";
const GIBS_LAYERS: [string, string][] = [
  ["VIIRS_NOAA20_CorrectedReflectance_TrueColor", "VIIRS NOAA-20"],
  ["VIIRS_SNPP_CorrectedReflectance_TrueColor", "VIIRS Suomi-NPP"],
  ["VIIRS_NOAA21_CorrectedReflectance_TrueColor", "VIIRS NOAA-21"],
  ["MODIS_Terra_CorrectedReflectance_TrueColor", "MODIS Terra"],
];
let gibsChoice: { layer: string; name: string; date: string } | undefined;

function daysAgoUtc(n: number): string {
  return new Date(Date.now() - n * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * NASA's daily mosaics sometimes have big holes (a satellite's data for a region missing:
 * the tile comes back almost all black). Check the 4 world tiles at zoom 1 of each satellite,
 * yesterday first, and use the first complete one. A complete zoom-1 tile is ~15-25 kB, a
 * mostly empty one ~2-4 kB.
 */
async function pickGibs(): Promise<{ layer: string; name: string; date: string }> {
  if (gibsChoice) return gibsChoice;
  for (const date of [daysAgoUtc(1), daysAgoUtc(2)]) {
    for (const [layer, name] of GIBS_LAYERS) {
      try {
        const sizes = await Promise.all(
          ["0/0", "0/1", "1/0", "1/1"].map(async (yx) => {
            const r = await fetch(`${GIBS}/${layer}/default/${date}/GoogleMapsCompatible_Level9/1/${yx}.jpg`);
            return r.ok ? (await r.arrayBuffer()).byteLength : 0;
          }),
        );
        if (sizes.every((s) => s > 8000)) return (gibsChoice = { layer, name, date });
      } catch {
        // try the next one
      }
    }
  }
  return (gibsChoice = { layer: GIBS_LAYERS[0][0], name: GIBS_LAYERS[0][1], date: daysAgoUtc(1) });
}

/** Build the MapLibre style for a basemap id ("none" = plain background, for tests). */
export async function buildStyle(id: string): Promise<StyleSpecification | string> {
  const style = await buildStyleInner(id);
  current = id;
  return style;
}

async function buildStyleInner(id: string): Promise<StyleSpecification | string> {
  if (id === "none") return BLANK_STYLE;
  if (id === "light") return `${OFM}/positron`;
  if (id === "colour") return `${OFM}/liberty`;
  if (id === "dark") return `${OFM}/dark`;
  if (id === "bw") return blackAndWhite(await positron());

  // Imagery: one raster source + optional labels on top.
  let raster: StyleSpecification["sources"][string];
  if (id === "sathd") {
    const key = maptilerKey();
    if (!key) throw new Error("no MapTiler key");
    raster = {
      type: "raster",
      url: `https://api.maptiler.com/tiles/satellite-v2/tiles.json?key=${encodeURIComponent(key)}`,
      tileSize: 512,
      attribution: '<a href="https://www.maptiler.com/copyright/" target="_blank">© MapTiler</a>',
    };
  } else if (id === "today") {
    const g = await pickGibs();
    raster = {
      type: "raster",
      tiles: [`${GIBS}/${g.layer}/default/${g.date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`],
      tileSize: 256,
      maxzoom: 9,
      attribution: `<a href="https://earthdata.nasa.gov/gibs" target="_blank">NASA EOSDIS GIBS</a> (${g.name}, ${g.date})`,
    };
  } else {
    raster = {
      type: "raster",
      tiles: ["https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/{z}/{y}/{x}.jpg"],
      tileSize: 256,
      // EOX serves tiles up to z17 (upsampled on their side): using them avoids the visible
      // seams MapLibre's own over-zooming leaves at tile edges.
      maxzoom: 17,
      attribution:
        '<a href="https://s2maps.eu" target="_blank">Sentinel-2 cloudless 2023</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2023, CC BY-NC-SA 4.0)',
    };
  }
  const style: StyleSpecification = {
    version: 8,
    glyphs: GLYPHS,
    sources: { imagery: raster },
    layers: [
      { id: "background", type: "background", paint: { "background-color": "#0b1a26" } },
      { id: "imagery", type: "raster", source: "imagery" },
    ],
  };
  const want = overlays();
  if (want.size) {
    const base = await positron();
    const labels = imageryLabels(base, want);
    style.glyphs = base.glyphs;
    style.sprite = base.sprite;
    Object.assign(style.sources, labels.sources);
    style.layers.push(...labels.layers);
  }
  return style;
}

/**
 * Switch the background map, keeping every data layer (sources named "*-src" and the style
 * layers drawing them) on top with its current data. Icons are re-added afterwards.
 */
export async function switchBasemap(map: MlMap, id: string, addIcons: (m: MlMap, dark: boolean) => void): Promise<void> {
  const style = await buildStyle(id);
  map.once("style.load", () => addIcons(map, isDarkBasemap(id)));
  map.setStyle(style, {
    diff: false,
    transformStyle: (prev, next) => {
      if (!prev) return next;
      const ours = Object.fromEntries(Object.entries(prev.sources).filter(([k]) => k.endsWith("-src")));
      const ourLayers = prev.layers.filter((l) => "source" in l && typeof l.source === "string" && l.source in ours);
      return { ...next, sources: { ...next.sources, ...ours }, layers: [...next.layers, ...ourLayers] };
    },
  });
}
