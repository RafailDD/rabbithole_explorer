#!/usr/bin/env node
// Fake ADS-B decoder: stands in for dump1090-fa / readsb until there is real hardware.
//
// Serves, like a real decoder, with a CORS header so the app may read it:
//   http://localhost:8090/data/aircraft.json   (dump1090/readsb format)
//   http://localhost:8090/data/receiver.json   (station position)
//
// Modes:
//   default ("live-derived"): every 5 s, fetch the public aircraft around the station from
//     adsb.lol and pretend to hear a realistic subset: likelier when close, a few without
//     position (Mode S only), plus two made-up aircraft only "we" hear. Positions are moved
//     along their track between fetches, like a real 1 Hz decoder.
//   --replay <file>: serve a recorded aircraft.json (e.g. from a real decoder) as-is.
//
// Usage: node tools/fake-decoder.mjs [--port 8090] [--lat 43.66] [--lon 7.215]
//                                     [--range-km 150] [--replay file.json]
// Defaults to Nice airport (a made-up station). No dependencies; Node 22+.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const PORT = Number(args.port ?? 8090);
const ST = { lat: Number(args.lat ?? 43.66), lon: Number(args.lon ?? 7.215) };
const RANGE_KM = Number(args["range-km"] ?? 150);
const REPLAY = args.replay;
const UA = "rabbithole_explorer-fake-decoder/0.1 (+https://github.com/RafailDD/rabbithole_explorer)";

function distKm(a, b, c, d) {
  const r = Math.PI / 180;
  const x = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(x));
}

/** Stable pseudo-random number in [0,1) per (hex, minute): reception doesn't flicker every second. */
function chance(hex, salt) {
  let h = 2166136261;
  for (const ch of hex + salt) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

let heard = []; // [{rec, t}] last fetched subset
let lastError = "";

async function refresh() {
  const nm = Math.min(250, Math.ceil(RANGE_KM / 1.852));
  const url = `https://api.adsb.lol/v2/lat/${ST.lat}/lon/${ST.lon}/dist/${nm}`;
  try {
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const minute = String(Math.floor(Date.now() / 60000));
    const t = Date.now();
    heard = [];
    for (const a of data.ac ?? []) {
      if (typeof a.lat !== "number") continue;
      const d = distKm(ST.lat, ST.lon, a.lat, a.lon);
      const p = Math.max(0, 1 - (d / RANGE_KM) ** 2); // close aircraft are heard more reliably
      if (chance(a.hex, minute) > p) continue;
      const rec = {
        hex: a.hex,
        flight: a.flight,
        alt_baro: a.alt_baro,
        gs: a.gs,
        track: a.track,
        lat: a.lat,
        lon: a.lon,
        seen: 0.5,
        seen_pos: 1,
        rssi: Math.round((-6 - 24 * (d / RANGE_KM)) * 10) / 10,
        messages: Math.round(200 + 3000 * p),
      };
      if (chance(a.hex, "nopos") < 0.1) {
        // Heard, but no position decoded (Mode S only).
        delete rec.lat;
        delete rec.lon;
        delete rec.seen_pos;
      }
      heard.push({ rec, t });
    }
    lastError = "";
  } catch (err) {
    lastError = String(err.message || err);
    console.warn("fake-decoder: adsb.lol fetch failed:", lastError);
  }
}

/** Two aircraft only "we" hear: circling the station (fffff0/fffff1 are unassigned ICAO addresses). */
function onlyMine(now) {
  const out = [];
  [
    { hex: "fffff0", flight: "TEST01  ", km: 25, period: 600, alt: 2500, gs: 95 },
    { hex: "fffff1", flight: "", km: 45, period: 900, alt: 1200, gs: 80 },
  ].forEach((s) => {
    const ang = ((now / 1000) % s.period) / s.period * 2 * Math.PI;
    const lat = ST.lat + (s.km / 111.2) * Math.cos(ang);
    const lon = ST.lon + (s.km / (111.2 * Math.cos((ST.lat * Math.PI) / 180))) * Math.sin(ang);
    const track = ((ang * 180) / Math.PI + 90) % 360;
    out.push({ hex: s.hex, flight: s.flight, alt_baro: s.alt, gs: s.gs, track, lat, lon, seen: 0.2, seen_pos: 0.4, rssi: -7.5, messages: 400 });
  });
  return out;
}

/** Move a record along its track to `now` (dead reckoning, ≤ 30 s). */
function advance({ rec, t }, now) {
  if (typeof rec.lat !== "number" || !rec.gs || rec.alt_baro === "ground") return rec;
  const dtH = Math.min((now - t) / 1000, 30) / 3600;
  const deg = (rec.gs * dtH) / 60;
  const rad = ((rec.track ?? 0) * Math.PI) / 180;
  return { ...rec, lat: rec.lat + deg * Math.cos(rad), lon: rec.lon + (deg * Math.sin(rad)) / Math.cos((rec.lat * Math.PI) / 180) };
}

function aircraftJson() {
  const now = Date.now();
  if (REPLAY) {
    const file = JSON.parse(readFileSync(REPLAY, "utf8"));
    return { ...file, now: now / 1000 };
  }
  return { now: now / 1000, messages: 100000, aircraft: [...heard.map((h) => advance(h, now)), ...onlyMine(now)] };
}

const server = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  const path = (req.url ?? "").split("?")[0];
  if (path === "/data/aircraft.json") res.end(JSON.stringify(aircraftJson()));
  else if (path === "/data/receiver.json") res.end(JSON.stringify({ version: "fake-decoder", refresh: 1000, lat: ST.lat, lon: ST.lon }));
  else {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found", try: "/data/aircraft.json" }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`fake decoder on http://localhost:${PORT}/data/aircraft.json`);
  console.log(REPLAY ? `replaying ${REPLAY}` : `live-derived from adsb.lol around ${ST.lat}, ${ST.lon}, range ${RANGE_KM} km`);
});
if (!REPLAY) {
  refresh();
  setInterval(refresh, 5000);
}
