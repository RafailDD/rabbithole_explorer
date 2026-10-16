import { loadString, saveString } from "./storage";

// Which layers are on, kept in two places:
// - the URL (`?layers=quakes,air`), so a copied link reproduces the view;
// - localStorage, so a plain reload of the bare address keeps the last choice.
// The URL wins when it has a `layers` parameter (even an empty one).
// The map position lives in the URL hash (`#zoom/lat/lon`), handled by MapLibre.

const KEY = "rhe.layers";

export function initialLayerIds(defaults: string[]): string[] {
  const fromUrl = new URLSearchParams(window.location.search).get("layers");
  const raw = fromUrl ?? loadString(KEY);
  if (raw === null) return defaults;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function saveLayerIds(ids: string[]): void {
  const value = ids.join(",");
  saveString(KEY, value);
  const url = new URL(window.location.href);
  url.searchParams.set("layers", value);
  // Keep commas readable in the address bar.
  const search = url.search.replace(/%2C/gi, ",");
  window.history.replaceState(window.history.state, "", `${url.pathname}${search}${url.hash}`);
}

// Background map: `?map=<id>` in the URL, else localStorage, else "colour".
const MAP_KEY = "rhe.basemap";

export function initialBasemap(valid: string[]): string {
  const fromUrl = new URLSearchParams(window.location.search).get("map");
  if (fromUrl && valid.includes(fromUrl)) return fromUrl;
  const stored = loadString(MAP_KEY);
  return stored && valid.includes(stored) ? stored : "colour";
}

export function saveBasemap(id: string): void {
  saveString(MAP_KEY, id);
  const url = new URL(window.location.href);
  url.searchParams.set("map", id);
  const search = url.search.replace(/%2C/gi, ",");
  window.history.replaceState(window.history.state, "", `${url.pathname}${search}${url.hash}`);
}
