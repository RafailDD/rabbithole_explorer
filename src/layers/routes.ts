// Route guess for one clicked aircraft, from its callsign.
//
// ADS-B itself carries no origin or destination. The Virtual Radar Server community
// "standing data" (CC0, public domain) maps airline callsigns to their usual airports;
// adsb.lol serves it as static files with CORS, so the browser fetches it directly. It is
// crowd-sourced and sometimes outdated, so every route is checked against where the
// aircraft actually is before it is shown as plausible.

const BASE = "https://vrs-standing-data.adsb.lol/routes";

interface VrsAirport {
  icao: string;
  iata?: string;
  name?: string;
  location?: string;
  lat: number;
  lon: number;
}

interface VrsRoute {
  airport_codes?: string;
  _airports?: VrsAirport[];
}

export interface RouteGuess {
  /** e.g. "FRA Frankfurt-am-Main → ALG Algiers" (full multi-stop route). */
  text: string;
  /** False when the aircraft is far off every leg: the data is probably outdated. */
  plausible: boolean;
  /** Destination of the leg the aircraft seems to be flying. */
  to?: VrsAirport;
}

/** Great-circle distance in km. */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

const label = (a: VrsAirport) => `${a.iata || a.icao} ${a.location || a.name || ""}`.trim();

/**
 * Look up the route for a callsign. Returns null when nothing is on file (common for
 * private flights, whose callsign is just their registration).
 */
export async function lookupRoute(callsign: string, lat: number, lon: number, signal: AbortSignal): Promise<RouteGuess | null> {
  const cs = callsign.trim().toUpperCase();
  if (!/^[A-Z0-9]{3,8}$/.test(cs)) return null;
  const res = await fetch(`${BASE}/${cs.slice(0, 2)}/${cs}.json`, { signal });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`route lookup HTTP ${res.status}`);
  const route = (await res.json()) as VrsRoute;
  const airports = (route._airports ?? []).filter((a) => typeof a.lat === "number" && typeof a.lon === "number");
  if (airports.length < 2) return null;

  // Pick the leg the aircraft is most nearly "between": smallest detour ratio
  // (origin→plane→destination) / (origin→destination).
  let best = { ratio: Infinity, to: airports[1] };
  for (let i = 0; i + 1 < airports.length; i++) {
    const a = airports[i];
    const b = airports[i + 1];
    const direct = Math.max(distanceKm(a.lat, a.lon, b.lat, b.lon), 50);
    const ratio = (distanceKm(a.lat, a.lon, lat, lon) + distanceKm(lat, lon, b.lat, b.lon)) / direct;
    if (ratio < best.ratio) best = { ratio, to: b };
  }
  return { text: airports.map(label).join(" → "), plausible: best.ratio < 1.3, to: best.to };
}
