import { Popup, type Map as MlMap, type MapLayerMouseEvent } from "maplibre-gl";
import { FEED_MODE, fixtureUrl } from "../config";
import { loadString, saveString } from "../storage";
import { buildCard, closeDetails, showDetails } from "../ui/details";
import { DataLayer, fetchJson, type FeatureCollection } from "./base";

// Two USGS services, both readable directly by the browser (CORS OK):
// - summary feeds: ready-made GeoJSON files (fast, CDN-cached, with felt reports and alerts)
//   for the common combinations;
// - the FDSN event query for any other magnitude/period combination, in its compact text
//   format (GeoJSON is ~20× bigger). It returns at most 20,000 events: above that we ask
//   for the 20,000 biggest and say so.
const SUMMARY = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary";
const FDSN = "https://earthquake.usgs.gov/fdsnws/event/1";
const MAX_EVENTS = 20000;

const MAGS: [string, string, number][] = [
  // [id, label, minimum magnitude]
  ["all", "all magnitudes", -9],
  ["1.0", "M1+", 1],
  ["2.5", "M2.5+", 2.5],
  ["4.0", "M4+", 4],
  ["4.5", "M4.5+", 4.5],
  ["5.0", "M5+", 5],
  ["6.0", "M6+", 6],
  ["7.0", "M7+", 7],
];
const PERIODS: [string, string, number][] = [
  // [id, label, hours]
  ["hour", "past hour", 1],
  ["day", "past day", 24],
  ["week", "past week", 24 * 7],
  ["month", "past month", 24 * 30],
  ["year", "past year", 24 * 365],
  ["5y", "past 5 years", 24 * 365 * 5],
  ["20y", "past 20 years", 24 * 365 * 20],
];
// USGS summary feeds exist for these magnitudes × hour/day/week/month.
const SUMMARY_MAGS = new Set(["all", "1.0", "2.5", "4.5"]);
const SUMMARY_PERIODS = new Set(["hour", "day", "week", "month"]);

const MAG_KEY = "rhe.quakes.mag";
const PERIOD_KEY = "rhe.quakes.period";
const HOUR = 3600 * 1000;
// Age colours, oldest last. Must match "circle-color" below.
// Recent = cool and bright, old = warm background (like IRIS's Seismic Monitor).
const AGE_KEY: [string, string, number][] = [
  ["#9c36b5", "< 1 h", 1],
  ["#e64980", "< 1 day", 24],
  ["#f03e3e", "< 1 week", 24 * 7],
  ["#fd7e14", "< 1 month", 24 * 30],
  ["#fab005", "< 1 year", 24 * 365],
  ["#ffd43b", "older", Infinity],
];

/** USGS event page links must stay on usgs.gov (never trust a URL from a feed blindly). */
function safeUsgsUrl(u: unknown): string | null {
  try {
    const url = new URL(String(u));
    return url.protocol === "https:" && url.hostname.endsWith("usgs.gov") ? url.href : null;
  } catch {
    return null;
  }
}

function ago(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  if (min < 60 * 24 * 60) return `${Math.round(min / 1440)} days ago`;
  return `${(min / 525600).toFixed(1)} years ago`;
}

function pick<T extends [string, string, number]>(list: T[], key: string, fallback: string): T {
  const v = loadString(key);
  return list.find((x) => x[0] === v) ?? list.find((x) => x[0] === fallback)!;
}

/**
 * Earthquakes from USGS: any minimum magnitude × period. Circles sized by magnitude,
 * coloured by age. Refreshed every 5 minutes (every 30 for a year or more).
 */
export class QuakesLayer extends DataLayer {
  readonly id = "quakes";
  readonly label = "Earthquakes";
  readonly credit = "Earthquakes: USGS";

  private mag = pick(MAGS, MAG_KEY, "2.5");
  private period = pick(PERIODS, PERIOD_KEY, "week");
  private note = "";
  private last: FeatureCollection | undefined;
  private selected: string | undefined;
  private tip: Popup | undefined;

  protected get pollMs(): number {
    return this.period[2] >= 24 * 365 ? 30 * 60 * 1000 : 5 * 60 * 1000;
  }

  sourceIds(): string[] {
    return ["usgs"];
  }

  disable(): void {
    closeDetails(this);
    this.selected = undefined;
    this.last = undefined;
    super.disable();
  }

  renderSettings(changed: () => void): HTMLElement | null {
    const wrap = document.createElement("div");
    wrap.className = "setting";
    // Colour key for the circles' age.
    const legend = document.createElement("div");
    legend.className = "legend";
    for (const [color, text] of AGE_KEY) {
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = color;
      legend.append(dot, ` ${text} `);
    }
    if (FEED_MODE === "fixtures") {
      wrap.append(legend);
      return wrap;
    }
    const select = (id: string, list: [string, string, number][], current: string, onPick: (v: string) => void) => {
      const sel = document.createElement("select");
      sel.id = id;
      for (const [value, text] of list) {
        const o = document.createElement("option");
        o.value = value;
        o.textContent = text;
        o.selected = value === current;
        sel.append(o);
      }
      sel.addEventListener("change", () => {
        onPick(sel.value);
        closeDetails(this);
        this.refreshSoon(0);
        changed();
      });
      return sel;
    };
    const magSel = select("quakes-mag", MAGS, this.mag[0], (v) => {
      this.mag = MAGS.find((m) => m[0] === v)!;
      saveString(MAG_KEY, v);
    });
    const perSel = select("quakes-period", PERIODS, this.period[0], (v) => {
      this.period = PERIODS.find((m) => m[0] === v)!;
      saveString(PERIOD_KEY, v);
    });
    wrap.append(magSel, " ", perSel, legend);
    return wrap;
  }

  protected describe(fc: FeatureCollection): string {
    const what = FEED_MODE === "fixtures" ? "sample (M2.5+, week)" : `${this.mag[1]}, ${this.period[1]}`;
    return `${fc.features.length.toLocaleString("en")} quakes · ${what}${this.note ? ` · ${this.note}` : ""}`;
  }

  /** Summary feed (GeoJSON) → our properties. */
  private fromGeoJson(data: FeatureCollection, now: number): GeoJSON.Feature[] {
    return data.features
      .filter((f) => f.geometry?.type === "Point" && typeof f.properties?.mag === "number")
      .map((f) => {
        const p = f.properties ?? {};
        const id = String(f.id ?? p.code ?? "");
        return {
          type: "Feature" as const,
          geometry: f.geometry,
          properties: {
            id,
            mag: p.mag,
            place: p.place ?? "",
            time: p.time,
            ageH: (now - Number(p.time)) / HOUR,
            depth: (f.geometry as GeoJSON.Point).coordinates[2] ?? null,
            magType: p.magType ?? "",
            status: p.status ?? "",
            tsunami: p.tsunami ?? 0,
            felt: p.felt ?? null,
            alert: p.alert ?? null,
            kind: p.type ?? "earthquake",
            url: p.url ?? "",
            sel: id === this.selected,
          },
        };
      });
  }

  /** FDSN text format: EventID|Time|Latitude|Longitude|Depth/km|…|MagType|Magnitude|MagAuthor|EventLocationName */
  private fromText(text: string, now: number): GeoJSON.Feature[] {
    const out: GeoJSON.Feature[] = [];
    for (const line of text.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const c = line.split("|");
      const lat = Number(c[2]);
      const lon = Number(c[3]);
      const mag = Number(c[10]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(mag)) continue;
      const time = Date.parse(`${c[1]}Z`);
      out.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lon, lat] },
        properties: {
          id: c[0],
          mag,
          place: c[12] ?? "",
          time,
          ageH: (now - time) / HOUR,
          depth: c[4] === "" ? null : Number(c[4]),
          magType: c[9] ?? "",
          url: `https://earthquake.usgs.gov/earthquakes/eventpage/${encodeURIComponent(c[0])}`,
          kind: "earthquake",
          sel: c[0] === this.selected,
        },
      });
    }
    return out;
  }

  protected async load(signal: AbortSignal): Promise<FeatureCollection> {
    const now = Date.now();
    this.note = "";
    let features: GeoJSON.Feature[];
    if (FEED_MODE === "fixtures") {
      features = this.fromGeoJson(await fetchJson<FeatureCollection>(fixtureUrl("quakes-usgs-2.5_week.geojson"), signal), now);
    } else if (SUMMARY_MAGS.has(this.mag[0]) && SUMMARY_PERIODS.has(this.period[0])) {
      const file = `${this.mag[0] === "all" ? "all" : this.mag[0]}_${this.period[0]}`;
      features = this.fromGeoJson(await fetchJson<FeatureCollection>(`${SUMMARY}/${file}.geojson`, signal), now);
    } else {
      // Round the start time (to the hour, or the day for a year or more) so the same query is
      // repeated exactly and USGS can answer from its cache: a big query takes ~30 s the first
      // time and under a second after that.
      const iso = new Date(now - this.period[2] * HOUR).toISOString();
      const start = this.period[2] >= 24 * 365 ? iso.slice(0, 10) : `${iso.slice(0, 13)}:00:00`;
      const q = `starttime=${start}${this.mag[2] > -9 ? `&minmagnitude=${this.mag[2]}` : ""}`;
      const count = await fetchJson<{ count: number }>(`${FDSN}/count?format=geojson&${q}`, signal).catch(() => ({ count: 0 }));
      if (count.count > 5000) this.status(`loading ${Math.min(count.count, MAX_EVENTS).toLocaleString("en")} quakes… (a big query can take ~30 s the first time)`);
      let res: Response;
      try {
        res = await fetch(`${FDSN}/query?format=text&${q}&orderby=magnitude&limit=${MAX_EVENTS}`, { signal });
      } catch (err) {
        if (signal.aborted) throw err;
        this.refreshSoon(60000); // the first big query of the day can time out; USGS caches it meanwhile
        throw new Error("USGS didn't answer in time (big query): retrying in a minute (or pick a higher magnitude)");
      }
      if (res.status === 204) features = []; // no events
      else if (!res.ok) throw new Error(`USGS answered HTTP ${res.status}`);
      else features = this.fromText(await res.text(), now);
      if (count.count > MAX_EVENTS) this.note = `the ${MAX_EVENTS.toLocaleString("en")} biggest of ${count.count.toLocaleString("en")}`;
    }
    // Draw big quakes on top; the newest on top among equals is not needed.
    this.last = { type: "FeatureCollection", features };
    if (this.selected && !features.some((f) => f.properties?.id === this.selected)) closeDetails(this);
    return this.last;
  }

  /** The panel was closed or taken by another layer: drop the highlight. */
  onDetailsClosed(): void {
    if (this.selected === undefined) return;
    this.selected = undefined;
    this.redrawSelection();
  }

  private redrawSelection(): void {
    if (!this.last) return;
    for (const f of this.last.features) if (f.properties) f.properties.sel = f.properties.id === this.selected;
    this.setData(this.last);
  }

  protected addStyleLayers(map: MlMap): void {
    const layerId = `${this.id}-circles`;
    map.addLayer({
      id: layerId,
      type: "circle",
      source: this.sourceId,
      paint: {
        // Radius grows with magnitude (energy is ~32× per step, so keep it gentle) and with zoom:
        // small dots for the whole world, bigger circles when zoomed in.
        "circle-radius": [
          "interpolate", ["linear"], ["zoom"],
          1, ["interpolate", ["linear"], ["get", "mag"], 1, 1, 4, 1.5, 5, 2.5, 6, 4, 7, 6, 8, 9],
          6, ["interpolate", ["linear"], ["get", "mag"], 1, 2, 2.5, 4, 4.5, 8, 6, 13, 8, 22],
        ],
        "circle-color": ["step", ["get", "ageH"], AGE_KEY[0][0], ...AGE_KEY.slice(1).flatMap(([color], i) => [AGE_KEY[i][2], color])],
        "circle-opacity": ["case", ["<", ["get", "ageH"], 24 * 7], 0.9, 0.7],
        "circle-stroke-color": ["case", ["get", "sel"], "#1d2329", "#ffffff"],
        // Hairline outlines at world zoom; a ring for the selected quake.
        // (MapLibre needs zoom as the outermost input, so the "selected" case goes inside.)
        "circle-stroke-width": [
          "interpolate", ["linear"], ["zoom"],
          1, ["case", ["get", "sel"], 2.5, 0],
          4, ["case", ["get", "sel"], 2.5, 0.5],
          6, ["case", ["get", "sel"], 2.5, 1],
        ],
      },
      layout: {
        // Newest on top (higher key = drawn later).
        "circle-sort-key": ["-", 0, ["get", "ageH"]],
      },
    });

    map.on("click", layerId, (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      this.selected = String(f.properties?.id ?? "");
      this.redrawSelection();
      const full = this.last?.features.find((x) => x.properties?.id === this.selected);
      showDetails(this, this.card(full?.properties ?? f.properties ?? {}));
    });
    // A click on empty map (no quake under it) deselects.
    map.on("click", (e) => {
      if (!this.selected || !this.isEnabled) return;
      if (map.queryRenderedFeatures(e.point, { layers: [layerId] }).length === 0) closeDetails(this);
    });
    map.on("mousemove", layerId, (e: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      const p = e.features?.[0]?.properties;
      if (!p) return;
      this.tip ??= new Popup({ closeButton: false, closeOnClick: false, className: "hover-tip", offset: 10 });
      this.tip.setLngLat(e.lngLat).setText(`M ${Number(p.mag).toFixed(1)} · ${ago(Number(p.time))}`).addTo(map);
    });
    map.on("mouseleave", layerId, () => {
      map.getCanvas().style.cursor = "";
      this.tip?.remove();
    });
  }

  private card(p: Record<string, unknown>): HTMLElement {
    const time = Number(p.time);
    const rows: [string, string | HTMLElement][] = [
      ["Where", String(p.place || "—")],
      ["When", `${new Date(time).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} (${ago(time)})`],
      ["Magnitude", `${Number(p.mag).toFixed(1)} ${p.magType ? `(${p.magType})` : ""}`.trim()],
      ["Depth", p.depth === null || p.depth === undefined ? "—" : `${Math.round(Number(p.depth))} km`],
    ];
    if (p.kind && p.kind !== "earthquake") rows.push(["Type", String(p.kind)]);
    if (p.felt) rows.push(["Felt reports", String(p.felt)]);
    if (p.alert) rows.push(["PAGER alert", String(p.alert)]);
    if (Number(p.tsunami) === 1) rows.push(["Tsunami", "flagged by USGS (check official warnings)"]);
    rows.push(["Status", p.status === "reviewed" ? "reviewed by a seismologist" : "automatic (may change)"]);
    const href = safeUsgsUrl(p.url);
    if (href) {
      const a = document.createElement("a");
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "USGS event page";
      rows.push(["More", a]);
    }
    rows.push(["Source", "USGS"]);
    return buildCard(`M ${Number(p.mag).toFixed(1)} earthquake`, rows);
  }
}
