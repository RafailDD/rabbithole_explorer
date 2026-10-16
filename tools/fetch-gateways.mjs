#!/usr/bin/env node
// Snapshot of LoRaWAN gateways from the Packet Broker Mapper (The Things Network and the
// networks peering with it) into a small static file the app loads in one go:
//   public/data/lora-gateways.json
// Packet Broker asks users to cache, so the app never calls their API itself: run this
// script about once a day (later: a scheduled GitHub Action).
//
// Kept: gateways with a location, updated in the last 7 days. Positions rounded to 3
// decimals (~100 m): many gateways are in people's homes. No gateway IDs or EUIs are kept.
//
// Usage: node tools/fetch-gateways.mjs [--from saved-api-answer.json]
// Needs Node 22+ and internet. Takes ~5 s (downloads ~6 MB).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const API = "https://mapper.packetbroker.net/api/v2/gateways";
const UA = "rabbithole_explorer/0.1 (+https://github.com/RafailDD/rabbithole_explorer)";
const OUT = new URL("../public/data/lora-gateways.json", import.meta.url);
const MAX_AGE_H = 7 * 24;

const from = process.argv.indexOf("--from");
let all;
if (from > 0) {
  all = JSON.parse(readFileSync(process.argv[from + 1], "utf8"));
} else {
  console.log(`fetching ${API} …`);
  const res = await fetch(API, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  all = await res.json();
}

const now = Date.now();
const nets = []; // network labels, referenced by index to keep the file small
const netIndex = new Map();
const rows = [];
let online = 0;
for (const g of all) {
  const loc = g.location;
  if (!loc || typeof loc.latitude !== "number" || typeof loc.longitude !== "number") continue;
  if (loc.latitude === 0 && loc.longitude === 0) continue;
  const ageH = (now - Date.parse(g.updatedAt)) / 3600000;
  if (!(ageH <= MAX_AGE_H)) continue;
  const net = g.tenantID ? `${g.tenantID}` : `net ${g.netID}`;
  if (!netIndex.has(net)) {
    netIndex.set(net, nets.length);
    nets.push(net);
  }
  const placement = g.antennaPlacement === "INDOOR" ? 1 : g.antennaPlacement === "OUTDOOR" ? 2 : 0;
  if (g.online) online++;
  rows.push([
    Math.round(loc.longitude * 1000) / 1000,
    Math.round(loc.latitude * 1000) / 1000,
    g.online ? 1 : 0,
    netIndex.get(net),
    placement,
    g.antennaCount ?? 0,
    Math.round(ageH),
  ]);
}

const out = {
  generated: new Date(now).toISOString(),
  source: "Packet Broker Mapper (mapper.packetbroker.net), The Things Network and peering networks",
  fields: ["lon", "lat", "online", "net", "placement (0 unknown, 1 indoor, 2 outdoor)", "antennas", "updated hours before generated"],
  nets,
  rows,
};
mkdirSync(new URL("../public/data/", import.meta.url), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
console.log(`wrote ${rows.length} gateways (${online} online, ${nets.length} networks) of ${all.length} to public/data/lora-gateways.json`);
