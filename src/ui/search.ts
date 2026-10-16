import type { GeoJSONSource, Map as MlMap } from "maplibre-gl";

// Place search at the top of the panel.
// - Coordinates ("43.58, 7.12", "43.58 7.12", "43°34'50\"N 7°07'30\"E") are understood
//   locally: no request.
// - Anything else (address, town, country) goes to OpenStreetMap's Nominatim, only when the
//   user presses Enter / the button (their policy: max 1 request/s, no type-ahead).
// Only places are searched: never aircraft, registrations or ships.

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const PIN_SRC = "search-src"; // "*-src" so it survives background map switches

interface Place {
  display_name: string;
  lat: string;
  lon: string;
  boundingbox?: [string, string, string, string]; // south, north, west, east
}

/** Parse decimal or degrees-minutes-seconds coordinates; null if it isn't coordinates. */
export function parseCoords(text: string): [number, number] | null {
  const t = text.trim();
  const dec = /^(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)$/.exec(t);
  if (dec) {
    const lat = Number(dec[1]);
    const lon = Number(dec[2]);
    return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lat, lon] : null;
  }
  // 43°34'50"N 7°07'30"E (minutes/seconds optional, any order of N/S then E/W)
  const part = String.raw`(\d+(?:\.\d+)?)\s*°\s*(?:(\d+(?:\.\d+)?)\s*['′]\s*)?(?:(\d+(?:\.\d+)?)\s*["″]\s*)?([NSEW])`;
  const dms = new RegExp(`^${part}[\\s,]+${part}$`, "i").exec(t);
  if (dms) {
    const val = (d: string, m?: string, s?: string, h?: string) =>
      (Number(d) + Number(m ?? 0) / 60 + Number(s ?? 0) / 3600) * (/[SW]/i.test(h ?? "") ? -1 : 1);
    const a = { v: val(dms[1], dms[2], dms[3], dms[4]), h: dms[4].toUpperCase() };
    const b = { v: val(dms[5], dms[6], dms[7], dms[8]), h: dms[8].toUpperCase() };
    const lat = /[NS]/.test(a.h) ? a.v : b.v;
    const lon = /[EW]/.test(b.h) ? b.v : a.v;
    return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? [lat, lon] : null;
  }
  return null;
}

export function buildSearch(map: MlMap): HTMLElement {
  const wrap = document.createElement("form");
  wrap.className = "search";
  wrap.setAttribute("role", "search");
  const input = document.createElement("input");
  input.type = "search";
  input.id = "search-input";
  input.placeholder = "Search place, address or lat, lon";
  input.autocomplete = "off";
  const go = document.createElement("button");
  go.type = "submit";
  go.textContent = "Go";
  const results = document.createElement("ul");
  results.className = "search-results";
  results.id = "search-results";
  const note = document.createElement("div");
  note.className = "status";
  wrap.append(input, go, results, note);

  let lastRequest = 0;

  const pin = (lon: number, lat: number) => {
    if (!map.getSource(PIN_SRC)) {
      map.addSource(PIN_SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "search-pin",
        type: "circle",
        source: PIN_SRC,
        paint: { "circle-radius": 7, "circle-color": "#e03131", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2.5 },
      });
    }
    (map.getSource(PIN_SRC) as GeoJSONSource).setData({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: {} });
  };

  const goTo = (p: Place) => {
    results.replaceChildren();
    const lat = Number(p.lat);
    const lon = Number(p.lon);
    pin(lon, lat);
    const bb = p.boundingbox?.map(Number);
    if (bb && bb.every(Number.isFinite) && (bb[1] - bb[0] > 0.001 || bb[3] - bb[2] > 0.001)) {
      map.fitBounds([[bb[2], bb[0]], [bb[3], bb[1]]], { padding: 40, maxZoom: 16, duration: 800 });
    } else map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 15), duration: 800 });
  };

  wrap.addEventListener("submit", async (e) => {
    e.preventDefault();
    note.textContent = "";
    note.classList.remove("error");
    results.replaceChildren();
    const q = input.value.trim();
    if (!q) {
      (map.getSource(PIN_SRC) as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    const c = parseCoords(q);
    if (c) {
      pin(c[1], c[0]);
      map.flyTo({ center: [c[1], c[0]], zoom: Math.max(map.getZoom(), 11), duration: 800 });
      return;
    }
    if (Date.now() - lastRequest < 1100) {
      note.textContent = "one search per second, please";
      return;
    }
    lastRequest = Date.now();
    note.textContent = "searching…";
    try {
      const url = `${NOMINATIM}?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`;
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const places = (await res.json()) as Place[];
      note.textContent = places.length ? "Search by OpenStreetMap Nominatim" : "nothing found";
      if (places.length === 1) goTo(places[0]);
      else
        for (const p of places) {
          const li = document.createElement("li");
          const b = document.createElement("button");
          b.type = "button";
          b.className = "link";
          b.textContent = p.display_name;
          b.addEventListener("click", () => goTo(p));
          li.append(b);
          results.append(li);
        }
    } catch (err) {
      note.textContent = `search failed: ${err instanceof Error ? err.message : String(err)}`;
      note.classList.add("error");
    }
  });
  return wrap;
}
