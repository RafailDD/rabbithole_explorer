import { Map as MlMap, NavigationControl, ScaleControl, setWorkerUrl, type StyleSpecification } from "maplibre-gl";
// MapLibre v6 decodes tiles in a Web Worker (a second thread, like a coprocessor). Let Vite
// bundle that worker and tell MapLibre where it ended up.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import { HOME } from "./config";

setWorkerUrl(workerUrl);

export function createMap(container: HTMLElement, style: StyleSpecification | string): MlMap {
  const map = new MlMap({
    container,
    style,
    center: [HOME.lng, HOME.lat],
    zoom: HOME.zoom,
    hash: true, // map position in the URL as #zoom/lat/lon
    attributionControl: { compact: false },
    // Strictly 2D: no tilt, no rotation.
    maxPitch: 0,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new ScaleControl({ unit: "metric" }), "bottom-right");
  return map;
}

type Pt = [number, number];

// Must match SHIP_CATS in src/layers/ships.ts (kept here to avoid an import cycle).
const SHIP_COLOURS: [string, string][] = [
  ["cargo", "#2f9e44"], ["tanker", "#e03131"], ["passenger", "#1c7ed6"], ["fishing", "#f08c00"],
  ["leisure", "#ae3ec9"], ["fast", "#fcc419"], ["service", "#0ca678"], ["other", "#868e96"],
];

// Top-down airliner on a 24×24 grid, nose up.
const PLANE: Pt[] = [
  [12, 1], [13.4, 3.5], [13.4, 9], [22, 14], [22, 16], [13.4, 13.5], [13, 19], [16, 21.5], [16, 23],
  [12, 22], [8, 23], [8, 21.5], [11, 19], [10.6, 13.5], [2, 16], [2, 14], [10.6, 9], [10.6, 3.5],
];

// Ship hull, bow up, on a 24×24 grid.
const HULL: Pt[] = [[12, 2], [16.5, 8], [16.5, 21], [7.5, 21], [7.5, 8]];
const DOT: Pt[] = Array.from({ length: 12 }, (_, i) => [12 + 5 * Math.sin((i * Math.PI) / 6), 12 + 5 * Math.cos((i * Math.PI) / 6)] as Pt);

/** Draw a filled, white-outlined polygon icon (24 px, rendered at 2× for sharpness). */
const PLAY: Pt[] = [[7, 4], [20, 12], [7, 20]];

function addPolygonIcon(map: MlMap, name: string, pts: Pt[], fill: string, outline = "#ffffff"): void {
  if (map.hasImage(name)) return;
  const ratio = 2;
  const size = 24 * ratio;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(ratio, ratio);
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.strokeStyle = outline;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.fill();
  map.addImage(name, ctx.getImageData(0, 0, size, size), { pixelRatio: ratio });
}

/**
 * Register the shared icons. All point north at rotation 0. On dark and satellite
 * backgrounds (`dark`), public aircraft are yellow with a dark outline so they stand out.
 */
export function addIcons(map: MlMap, dark = false): void {
  addPolygonIcon(map, "plane", PLANE, dark ? "#ffd43b" : "#1f4e8c", dark ? "#1d2329" : "#ffffff");
  addPolygonIcon(map, "plane-ground", PLANE, "#8a939b");
  addPolygonIcon(map, "plane-selected", PLANE, "#d9480f");
  addPolygonIcon(map, "plane-mine", PLANE, "#c2255c");
  // Ships: one hull (moving) and one dot (stopped) per category; colours as in SHIP_CATS.
  for (const [cat, color] of SHIP_COLOURS) {
    addPolygonIcon(map, `ship-${cat}`, HULL, color);
    addPolygonIcon(map, `ship-stop-${cat}`, DOT, color);
  }
  addPolygonIcon(map, "ship-selected", HULL, "#d9480f", "#1d2329");
  // Live video: a "play" triangle.
  addPolygonIcon(map, "play", PLAY, "#e03131");
  addPolygonIcon(map, "play-selected", PLAY, "#d9480f", "#1d2329");
}
