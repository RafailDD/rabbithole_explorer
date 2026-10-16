import { Popup, type GeoJSONSource, type Map as MlMap, type MapLayerMouseEvent } from "maplibre-gl";
import { FEED_MODE, fixtureUrl } from "../config";
import { loadString, saveString } from "../storage";
import { buildCard, closeDetails, showDetails } from "../ui/details";
import type { AircraftLayer } from "./aircraft";
import { DataLayer, EMPTY, fetchJson, type FeatureCollection } from "./base";
import { distanceKm } from "./routes";

// DRAFT until tested with a real RTL-SDR (see CLAUDE.md).
//
// Reads a local ADS-B decoder's aircraft.json (dump1090-fa, readsb, tar1090, or
// tools/fake-decoder.mjs) once a second and compares it with the public feed by ICAO hex:
//   - heard by both: public aircraft get a green ring (drawn by the aircraft layer);
//   - only mine: magenta aircraft the public feed doesn't have;
//   - only public: public aircraft within my current reception range that I don't hear.
// Everything stays in this browser tab: the decoder data is never uploaded or stored.

interface DecoderRecord {
  hex: string;
  flight?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground";
  gs?: number;
  track?: number;
  seen?: number;
  rssi?: number;
  messages?: number;
}

interface Heard {
  hex: string;
  flight: string;
  pos?: [number, number];
  alt: number | "ground" | null;
  gs: number | null;
  track: number;
  rssi: number | null;
  seen: number;
  messages: number | null;
}

const URL_KEY = "rhe.antenna.url";
const DEFAULT_URL = "http://localhost:8090/data/aircraft.json";
const STALE_S = 60;

/** Circle as a closed line, for the reception range. */
function circle(lat: number, lon: number, km: number): GeoJSON.Feature {
  const pts: number[][] = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * 2 * Math.PI;
    pts.push([lon + (km / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.sin(a), lat + (km / 110.57) * Math.cos(a)]);
  }
  return { type: "Feature", geometry: { type: "LineString", coordinates: pts }, properties: {} };
}

export class AntennaLayer extends DataLayer {
  readonly id = "mine";
  readonly label = "My antenna (draft)";
  readonly credit = "My antenna: local decoder (stays on this device)";
  protected readonly pollMs = 1000;

  private url = loadString(URL_KEY) || DEFAULT_URL;
  private station: { lat: number; lon: number } | undefined;
  private stationFor = ""; // decoder URL the station position was read from
  private heard = new Map<string, Heard>();
  private counts = { both: 0, bothNoPos: 0, mine: 0, publicOnly: 0, noPos: 0, rangeKm: 0 };
  private note = "";
  private selected: string | undefined;
  private tip: Popup | undefined;

  constructor(private readonly air: AircraftLayer) {
    super();
    // Add a "My antenna" row to the public aircraft card.
    air.extraRows = (hex) => {
      if (!this.isEnabled) return [];
      const h = this.heard.get(hex);
      return [["My antenna", h ? `heard${h.rssi !== null ? ` · ${h.rssi} dBFS` : ""}${h.pos ? "" : " · no position"}` : "not heard"]];
    };
  }

  sourceIds(): string[] {
    return ["decoder"];
  }

  private get decoderUrl(): string {
    return FEED_MODE === "fixtures" ? fixtureUrl("decoder-aircraft.json") : this.url;
  }

  private get rangeSourceId(): string {
    return `${this.id}-range-src`;
  }

  disable(): void {
    closeDetails(this);
    this.heard.clear();
    this.air.setHeard(new Set());
    (this.map.getSource(this.rangeSourceId) as GeoJSONSource | undefined)?.setData(EMPTY);
    super.disable();
  }

  renderSettings(changed: () => void): HTMLElement | null {
    const wrap = document.createElement("div");
    wrap.className = "setting";
    if (FEED_MODE === "fixtures") {
      wrap.textContent = "decoder: fixture (synthetic)";
      return wrap;
    }
    const input = document.createElement("input");
    input.type = "url";
    input.value = this.url;
    input.title = "Your decoder's aircraft.json (dump1090-fa, readsb, tar1090, or tools/fake-decoder.mjs)";
    input.className = "url";
    const apply = () => {
      const v = input.value.trim();
      if (!/^https?:\/\//.test(v) || v === this.url) return;
      this.url = v;
      saveString(URL_KEY, v);
      this.station = undefined;
      this.stationFor = "";
      this.refreshSoon(0);
      changed();
    };
    input.addEventListener("change", apply);
    input.addEventListener("keydown", (e) => e.key === "Enter" && apply());
    const legend = document.createElement("div");
    legend.className = "legend";
    for (const [cls, text] of [["ring", "both"], ["mine", "only mine"]] as const) {
      const dot = document.createElement("span");
      dot.className = `dot ${cls}`;
      legend.append(dot, ` ${text} `);
    }
    wrap.append("decoder: ", input, legend);
    return wrap;
  }

  protected describe(): string {
    const c = this.counts;
    let s = `both ${c.both}`;
    if (c.bothNoPos) s += ` (${c.bothNoPos} placed only by the public feed)`;
    s += ` · only mine ${c.mine} · only public ${c.publicOnly}`;
    if (c.noPos) s += ` · ${c.noPos} heard without position`;
    if (c.rangeKm) s += ` · range ${Math.round(c.rangeKm)} km`;
    return this.note ? `${s} (${this.note})` : s;
  }

  /** receiver.json sits next to aircraft.json in dump1090/readsb/tar1090. */
  private async loadStation(signal: AbortSignal): Promise<void> {
    if (this.stationFor === this.decoderUrl) return;
    this.stationFor = this.decoderUrl;
    const url =
      FEED_MODE === "fixtures" ? fixtureUrl("decoder-receiver.json") : this.decoderUrl.replace(/aircraft\.json(\?.*)?$/, "receiver.json");
    try {
      const r = await fetchJson<{ lat?: number; lon?: number }>(url, signal);
      this.station = typeof r.lat === "number" && typeof r.lon === "number" ? { lat: r.lat, lon: r.lon } : undefined;
    } catch {
      if (signal.aborted) this.stationFor = "";
      this.station = undefined; // older decoders don't publish it; comparison still works
    }
  }

  protected async load(signal: AbortSignal): Promise<FeatureCollection> {
    await this.loadStation(signal);
    let data: { aircraft?: DecoderRecord[]; ac?: DecoderRecord[] };
    try {
      data = await fetchJson(this.decoderUrl, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      throw new Error(
        `can't read the decoder (${err instanceof Error ? err.message : String(err)}). ` +
          "Is it running, and does it send Access-Control-Allow-Origin? Fake one: node tools/fake-decoder.mjs",
      );
    }
    this.heard.clear();
    for (const a of data.aircraft ?? data.ac ?? []) {
      if (!a.hex || (a.seen ?? 0) > STALE_S) continue;
      const hex = a.hex.toLowerCase();
      this.heard.set(hex, {
        hex,
        flight: (a.flight ?? "").trim(),
        pos: typeof a.lat === "number" && typeof a.lon === "number" ? [a.lon, a.lat] : undefined,
        alt: a.alt_baro ?? null,
        gs: a.gs ?? null,
        track: a.track ?? 0,
        rssi: a.rssi ?? null,
        seen: a.seen ?? 0,
        messages: a.messages ?? null,
      });
    }
    return this.compare();
  }

  /** Compare with the public feed; returns the "only mine" aircraft to draw. */
  private compare(): FeatureCollection {
    const pub = this.air.publicPositions();
    const cov = this.air.coverage();
    const both = new Set<string>();
    const mine: GeoJSON.Feature[] = [];
    let noPos = 0;
    let bothNoPos = 0;
    let rangeKm = 0;
    for (const h of this.heard.values()) {
      if (h.pos && this.station) rangeKm = Math.max(rangeKm, distanceKm(this.station.lat, this.station.lon, h.pos[1], h.pos[0]));
      if (pub.has(h.hex)) {
        both.add(h.hex);
        if (!h.pos) bothNoPos++; // my antenna got its messages but no position; the public feed places it
      }
      else if (h.pos) {
        mine.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: h.pos },
          properties: { hex: h.hex, flight: h.flight, track: h.track, sel: h.hex === this.selected },
        });
      } else noPos++;
    }
    // "Only public" only means something inside the area my antenna currently reaches.
    let publicOnly = 0;
    if (this.station && rangeKm > 0) {
      for (const [hex, [lon, lat]] of pub) {
        if (!this.heard.has(hex) && distanceKm(this.station.lat, this.station.lon, lat, lon) <= rangeKm) publicOnly++;
      }
    }
    this.counts = { both: both.size, bothNoPos, mine: mine.length, publicOnly, noPos, rangeKm };
    this.air.setHeard(both);

    // Explain when the comparison can't be trusted.
    if (!this.air.isEnabled) this.note = "turn on Aircraft to compare";
    else if (!cov) this.note = "zoom in to compare";
    else if (this.station && distanceKm(cov.lat, cov.lon, this.station.lat, this.station.lon) + rangeKm > cov.km) {
      this.note = "public feed doesn't cover your whole range here: pan to your station";
    } else if (!this.station) this.note = "station position unknown: no 'only public' count";
    else this.note = "";

    const range = this.map.getSource(this.rangeSourceId) as GeoJSONSource | undefined;
    if (this.station) {
      const feats: GeoJSON.Feature[] = [{ type: "Feature", geometry: { type: "Point", coordinates: [this.station.lon, this.station.lat] }, properties: { station: true } }];
      if (rangeKm > 0) feats.push(circle(this.station.lat, this.station.lon, rangeKm));
      range?.setData({ type: "FeatureCollection", features: feats });
    } else range?.setData(EMPTY);

    if (this.selected) {
      const h = this.heard.get(this.selected);
      if (!h || both.has(h.hex)) closeDetails(this);
      else showDetails(this, this.card(h));
    }
    return { type: "FeatureCollection", features: mine };
  }

  onDetailsClosed(): void {
    this.selected = undefined;
    if (this.isEnabled) this.setData(this.compare());
  }

  protected addStyleLayers(map: MlMap): void {
    map.addSource(this.rangeSourceId, { type: "geojson", data: EMPTY });
    map.addLayer({
      id: `${this.id}-range`,
      type: "line",
      source: this.rangeSourceId,
      filter: ["==", ["geometry-type"], "LineString"],
      paint: { "line-color": "#c2255c", "line-width": 1.5, "line-dasharray": [3, 3], "line-opacity": 0.7 },
    });
    map.addLayer({
      id: `${this.id}-station`,
      type: "circle",
      source: this.rangeSourceId,
      filter: ["==", ["geometry-type"], "Point"],
      paint: { "circle-radius": 5, "circle-color": "#c2255c", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 },
    });
    const layerId = `${this.id}-planes`;
    map.addLayer({
      id: layerId,
      type: "symbol",
      source: this.sourceId,
      layout: {
        "icon-image": ["case", ["get", "sel"], "plane-selected", "plane-mine"],
        "icon-rotate": ["get", "track"],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    });
    map.on("click", layerId, (e: MapLayerMouseEvent) => {
      const hex = String(e.features?.[0]?.properties?.hex ?? "");
      const h = this.heard.get(hex);
      if (!h) return;
      this.selected = hex;
      showDetails(this, this.card(h));
      this.setData(this.compare());
    });
    map.on("click", (e) => {
      if (this.selected && map.queryRenderedFeatures(e.point, { layers: [layerId] }).length === 0) closeDetails(this);
    });
    map.on("mousemove", layerId, (e: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      const p = e.features?.[0]?.properties;
      if (!p) return;
      this.tip ??= new Popup({ closeButton: false, closeOnClick: false, className: "hover-tip", offset: 14 });
      this.tip.setLngLat(e.lngLat).setText(`${p.flight || String(p.hex).toUpperCase()} · only my antenna`).addTo(map);
    });
    map.on("mouseleave", layerId, () => {
      map.getCanvas().style.cursor = "";
      this.tip?.remove();
    });
  }

  private card(h: Heard): HTMLElement {
    const rows: [string, string][] = [
      ["Heard by", "only my antenna (not in the public feed right now)"],
      ["ICAO hex", h.hex.toUpperCase()],
      ["Altitude", h.alt === "ground" ? "on ground" : h.alt === null ? "—" : `${Number(h.alt).toLocaleString("en")} ft`],
      ["Speed", h.gs === null ? "—" : `${Math.round(h.gs)} kt`],
      ["Signal", h.rssi === null ? "—" : `${h.rssi} dBFS`],
      ["Messages", h.messages === null ? "—" : String(h.messages)],
      ["Last heard", `${h.seen.toFixed(1)} s ago`],
      ["Status", "draft feature: not yet tested with real hardware"],
    ];
    return buildCard(h.flight || "no callsign", rows);
  }
}
