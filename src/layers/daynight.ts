import type { Map as MlMap } from "maplibre-gl";
import { DataLayer, type FeatureCollection } from "./base";

// Night side of the Earth, computed locally from the sun's position (no network).
// Redrawn once a minute; the terminator moves ~0.25° per minute.

const RAD = Math.PI / 180;

/** Sub-solar point (where the sun is overhead) for a date: [lon, lat] in degrees. */
export function subsolar(date: Date): [number, number] {
  // Low-precision solar position (accurate to ~0.01°, plenty for a map).
  const d = date.getTime() / 86400000 - 10957.5; // days since J2000.0
  const g = (357.529 + 0.98560028 * d) * RAD; // mean anomaly
  const q = 280.459 + 0.98564736 * d; // mean longitude
  const l = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD; // ecliptic longitude
  const e = (23.439 - 0.00000036 * d) * RAD; // obliquity
  const dec = Math.asin(Math.sin(e) * Math.sin(l));
  const ra = Math.atan2(Math.cos(e) * Math.sin(l), Math.cos(l));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24; // hours
  let lon = (ra / RAD - gmst * 15) % 360;
  if (lon < -180) lon += 360;
  if (lon > 180) lon -= 360;
  return [lon, dec / RAD];
}

/** Night polygon: between the terminator and the pole facing away from the sun. */
export function nightPolygon(date: Date): GeoJSON.Feature {
  const [sunLon, sunLat] = subsolar(date);
  const dec = (Math.abs(sunLat) < 0.01 ? 0.01 : sunLat) * RAD; // avoid tan(0)
  const ring: [number, number][] = [];
  for (let lon = -180; lon <= 180; lon += 1) {
    const lat = Math.atan(-Math.cos((lon - sunLon) * RAD) / Math.tan(dec)) / RAD;
    ring.push([lon, Math.max(-85, Math.min(85, lat))]);
  }
  const pole = sunLat > 0 ? -85 : 85; // northern summer: night reaches the south pole
  ring.push([180, pole], [-180, pole], ring[0]);
  return { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: {} };
}

export class DayNightLayer extends DataLayer {
  readonly id = "night";
  readonly label = "Day / night";
  readonly credit = "Day/night: computed in your browser";
  protected readonly pollMs = 60 * 1000;

  protected describe(): string {
    const [lon, lat] = subsolar(new Date());
    return `sun overhead at ${lat.toFixed(1)}°, ${lon.toFixed(1)}° · updated every minute`;
  }

  protected async load(): Promise<FeatureCollection> {
    return { type: "FeatureCollection", features: [nightPolygon(new Date())] };
  }

  protected addStyleLayers(map: MlMap): void {
    map.addLayer({
      id: `${this.id}-shade`,
      type: "fill",
      source: this.sourceId,
      paint: { "fill-color": "#0b1530", "fill-opacity": 0.35, "fill-antialias": false },
    });
  }
}
