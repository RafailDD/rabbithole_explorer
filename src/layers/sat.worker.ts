// Satellite propagation in a Web Worker (a second thread, so the map never stutters).
// Messages in:
//   { type: "set", sats: { id, name, group, omm }[] }  replace the satellite set
//   { type: "tick", time }                              positions at `time` (ms)
//   { type: "track", id, time }                         ground track ±1 orbit around `time`
// Messages out:
//   { type: "positions", time, ids, data }  data = Float64Array [lon, lat, altKm, speedKmS] × n
//   { type: "track", id, coords }           [lon, lat][] (may cross the antimeridian)
import { degreesLat, degreesLong, eciToGeodetic, gstime, json2satrec, propagate, type OMMJsonObject, type SatRec } from "satellite.js";

interface Sat {
  id: string;
  rec: SatRec;
  periodMin: number;
}

let sats: Sat[] = [];

function position(rec: SatRec, date: Date): [number, number, number, number] | null {
  const pv = propagate(rec, date);
  if (!pv || typeof pv.position !== "object") return null;
  const geo = eciToGeodetic(pv.position, gstime(date));
  const v = pv.velocity;
  const lon = degreesLong(geo.longitude);
  const lat = degreesLat(geo.latitude);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return [lon, lat, geo.height, Math.hypot(v.x, v.y, v.z)];
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === "set") {
    sats = [];
    for (const s of msg.sats as { id: string; omm: OMMJsonObject }[]) {
      try {
        const rec = json2satrec(s.omm);
        sats.push({ id: s.id, rec, periodMin: (2 * Math.PI) / rec.no }); // rec.no: rad/min
      } catch {
        // Skip malformed element sets.
      }
    }
  } else if (msg.type === "tick") {
    const date = new Date(msg.time);
    const ids: string[] = [];
    const data = new Float64Array(sats.length * 4);
    let n = 0;
    for (const s of sats) {
      const p = position(s.rec, date);
      if (!p) continue;
      data.set(p, n * 4);
      ids.push(s.id);
      n++;
    }
    const out = data.slice(0, n * 4);
    (self as unknown as Worker).postMessage({ type: "positions", time: msg.time, ids, data: out }, [out.buffer]);
  } else if (msg.type === "track") {
    const s = sats.find((x) => x.id === msg.id);
    if (!s) return;
    // One orbit back and one ahead, at most 360 points each way.
    const span = s.periodMin * 60 * 1000;
    const step = Math.max(30 * 1000, span / 360);
    const coords: [number, number][] = [];
    for (let t = msg.time - span; t <= msg.time + span; t += step) {
      const p = position(s.rec, new Date(t));
      if (p) coords.push([p[0], p[1]]);
    }
    (self as unknown as Worker).postMessage({ type: "track", id: msg.id, coords });
  }
};
