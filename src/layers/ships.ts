import { Popup, type Map as MlMap, type MapLayerMouseEvent } from "maplibre-gl";
import { FEED_MODE, fixtureUrl } from "../config";
import { relayUrl, setRelayUrl } from "../relay";
import { buildCard, closeDetails, showDetails } from "../ui/details";
import { DataLayer, EMPTY, fetchJson, type FeatureCollection } from "./base";

// Ships from AISStream, through our Cloudflare Worker relay (worker/): AISStream forbids
// browser connections and needs a secret key, which only the relay holds. The page opens one
// WebSocket to the relay while the layer is on, sends its view box, and gets the ships in it
// every 2 s. No history is kept; ships unheard for 30 minutes are dropped.

/** Ship as the relay sends it: [mmsi, lon, lat, cog, sog, heading, type, name, dest, status, len, ageS]. */
type Row = [number, number, number, number | null, number | null, number | null, number | null, string, string, number | null, number | null, number];

interface Ship {
  mmsi: number;
  lon: number;
  lat: number;
  cog: number | null;
  sog: number | null;
  heading: number | null;
  type: number | null;
  name: string;
  dest: string;
  status: number | null;
  len: number | null;
  t: number; // when we last got a position (ms, local clock)
}

const MAX_SPAN_DEG = 20; // same limit as the relay
const MIN_SPAN_DEG = 1; // smallest area asked from the relay
const STALE_MS = 30 * 60 * 1000;

// Categories from the AIS ship-type code (ITU-R M.1371). Colours must match the icons below.
export const SHIP_CATS: [string, string, string][] = [
  // [id, label, colour]
  ["cargo", "cargo", "#2f9e44"],
  ["tanker", "tanker", "#e03131"],
  ["passenger", "passenger", "#1c7ed6"],
  ["fishing", "fishing", "#f08c00"],
  ["leisure", "sailing / pleasure", "#ae3ec9"],
  ["fast", "high-speed", "#fcc419"],
  ["service", "tug / pilot / service", "#0ca678"],
  ["other", "other / unknown", "#868e96"],
];

function category(type: number | null): string {
  if (type === null) return "other";
  if (type >= 70 && type <= 79) return "cargo";
  if (type >= 80 && type <= 89) return "tanker";
  if (type >= 60 && type <= 69) return "passenger";
  if (type === 30) return "fishing";
  if (type === 36 || type === 37) return "leisure";
  if (type >= 40 && type <= 49) return "fast";
  if ((type >= 31 && type <= 35) || (type >= 50 && type <= 59)) return "service";
  return "other";
}

const TYPE_TEXT: Record<number, string> = {
  30: "fishing", 31: "towing", 32: "towing (large)", 33: "dredging / underwater ops", 34: "diving ops",
  35: "special craft", 36: "sailing", 37: "pleasure craft", 50: "pilot", 51: "search and rescue", 52: "tug",
  53: "port tender", 54: "anti-pollution", 55: "law enforcement", 58: "medical transport",
};

function typeText(t: number | null): string {
  if (t === null || t === 0) return "not given";
  if (TYPE_TEXT[t]) return TYPE_TEXT[t];
  if (t >= 20 && t <= 29) return "wing in ground";
  if (t >= 40 && t <= 49) return "high-speed craft";
  if (t >= 60 && t <= 69) return "passenger";
  if (t >= 70 && t <= 79) return "cargo";
  if (t >= 80 && t <= 89) return "tanker";
  return `other (${t})`;
}

const NAV_STATUS = [
  "under way (engine)", "at anchor", "not under command", "restricted manoeuvrability", "constrained by draught",
  "moored", "aground", "fishing", "under way (sailing)",
];

export class ShipsLayer extends DataLayer {
  readonly id = "ships";
  readonly label = "Ships (AIS)";
  readonly credit = "Ships: AISStream";
  protected readonly pollMs = 0; // live push over a WebSocket, not polling

  private relay = relayUrl();
  private ws: WebSocket | undefined;
  private retry: number | undefined;
  private ships = new Map<number, Ship>();
  private box: [number, number, number, number] | undefined;
  private note = "";
  private selected: number | undefined;
  private tip: Popup | undefined;

  sourceIds(): string[] {
    return ["aisstream"];
  }

  attach(map: MlMap): void {
    super.attach(map);
    map.on("moveend", () => this.sendBox());
  }

  disable(): void {
    closeDetails(this);
    this.closeSocket();
    this.ships.clear();
    super.disable();
  }

  pause(): void {
    super.pause();
    this.closeSocket(); // nothing streams while the tab is hidden
  }

  resume(): void {
    super.resume();
    if (this.isEnabled && FEED_MODE === "live") this.openSocket();
  }

  renderSettings(changed: () => void): HTMLElement | null {
    const wrap = document.createElement("div");
    wrap.className = "setting";
    const legend = document.createElement("div");
    legend.className = "legend";
    for (const [, text, color] of SHIP_CATS) {
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = color;
      legend.append(dot, ` ${text} `);
    }
    if (FEED_MODE === "fixtures") {
      wrap.append("relay: saved sample", legend);
      return wrap;
    }
    const input = document.createElement("input");
    input.type = "url";
    input.className = "url";
    input.id = "relay-url";
    input.value = this.relay;
    input.title = "Address of your rabbithole relay (Cloudflare Worker), e.g. https://rabbithole-relay.<you>.workers.dev";
    const apply = () => {
      if (input.value.trim().replace(/\/+$/, "") === this.relay || !setRelayUrl(input.value)) return;
      this.relay = relayUrl();
      this.closeSocket();
      if (this.isEnabled) this.openSocket();
      changed();
    };
    input.addEventListener("change", apply);
    input.addEventListener("keydown", (e) => e.key === "Enter" && apply());
    wrap.append("relay: ", input, legend);
    return wrap;
  }

  protected describe(): string {
    if (this.note) return this.note;
    const live = FEED_MODE === "fixtures" ? "saved sample" : "AISStream via relay";
    return `${this.ships.size.toLocaleString("en")} ships · ${live}`;
  }

  protected async load(signal: AbortSignal): Promise<FeatureCollection> {
    if (FEED_MODE === "fixtures") {
      const data = await fetchJson<{ ships: Row[] }>(fixtureUrl("ships-sample.json"), signal);
      this.merge(data.ships, true);
      return this.render();
    }
    this.openSocket();
    return this.render();
  }

  // ---- WebSocket to the relay ----

  private openSocket(): void {
    if (this.ws || !this.isEnabled) return;
    this.relay = relayUrl(); // may have been changed in the Webcams options
    window.clearTimeout(this.retry);
    const url = `${this.relay.replace(/^http/, "ws")}/ships`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.note = `bad relay address: ${this.relay}`;
      this.status(this.note, true);
      return;
    }
    this.ws = ws;
    this.note = "connecting to the relay…";
    this.status(this.note);
    ws.onopen = () => {
      this.note = "";
      this.sendBox(true);
    };
    ws.onmessage = (e) => this.onMessage(String(e.data));
    ws.onclose = () => {
      if (this.ws !== ws) return; // closed on purpose
      this.ws = undefined;
      this.note = `relay not reachable at ${this.relay} (is it running / deployed?): retrying in 10 s`;
      this.status(this.note, true);
      this.retry = window.setTimeout(() => this.openSocket(), 10000);
    };
  }

  private closeSocket(): void {
    window.clearTimeout(this.retry);
    const ws = this.ws;
    this.ws = undefined;
    this.box = undefined;
    ws?.close(1000, "layer off");
  }

  /** Tell the relay which area we look at (it only sends ships inside it). */
  private sendBox(force = false): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const b = this.map.getBounds();
    // Ask for at least 1° x 1° around the view, rounded outwards to 0.1°: AISStream has no
    // snapshot, so a wider area keeps ships known while panning and zooming nearby.
    const pad = (lo: number, hi: number): [number, number] => {
      const extra = Math.max(0, MIN_SPAN_DEG - (hi - lo)) / 2;
      return [Math.floor((lo - extra) * 10) / 10, Math.ceil((hi + extra) * 10) / 10];
    };
    const [w, e] = pad(b.getWest(), b.getEast());
    const [s, n] = pad(b.getSouth(), b.getNorth());
    const box: [number, number, number, number] = [Math.max(-180, w), Math.max(-90, s), Math.min(180, e), Math.min(90, n)];
    if (box[2] - box[0] > MAX_SPAN_DEG || box[3] - box[1] > MAX_SPAN_DEG) {
      this.note = "zoom in to see ships (view up to 20° wide)";
      this.status(this.note);
      this.box = undefined;
      return;
    }
    if (!force && this.box && this.box.every((v, i) => v === box[i])) return;
    this.box = box;
    this.note = "";
    this.ws.send(JSON.stringify({ box }));
  }

  private onMessage(text: string): void {
    let m: { t: string; full?: boolean; ships?: Row[]; msg?: string; upstream?: string };
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m.t === "status") {
      this.note = m.msg ?? "";
      this.status(this.note, !/zoom in/.test(this.note));
      return;
    }
    if (m.t === "ships" && m.ships) {
      this.merge(m.ships, !!m.full);
      this.note = m.upstream && m.upstream !== "on" && m.upstream !== "connecting" ? m.upstream : "";
      const fc = this.render();
      this.setData(fc);
      // AISStream has no snapshot: ships appear as they report (every few seconds to 3 minutes).
      const hint =
        this.note || this.ships.size ? "" : m.upstream === "connecting" ? " · relay connecting to AISStream…" : " · connected, waiting for ships to report (up to 3 min)";
      this.status(`${this.describe()}${hint} · ${new Date().toLocaleTimeString()}`, !!this.note);
      if (this.selected !== undefined) {
        const s = this.ships.get(this.selected);
        if (s) showDetails(this, this.card(s));
        else closeDetails(this);
      }
    }
  }

  /** Merge rows from the relay or the fixture. A full update replaces what's outside the box. */
  private merge(rows: Row[], full: boolean): void {
    const now = Date.now();
    if (full) {
      const b = this.box;
      for (const [k, s] of this.ships) if (!b || s.lon < b[0] || s.lon > b[2] || s.lat < b[1] || s.lat > b[3]) this.ships.delete(k);
    }
    for (const r of rows) {
      const [mmsi, lon, lat, cog, sog, heading, type, name, dest, status, len, ageS] = r;
      this.ships.set(mmsi, { mmsi, lon, lat, cog, sog, heading, type, name, dest, status, len, t: now - ageS * 1000 });
    }
    for (const [k, s] of this.ships) if (now - s.t > STALE_MS && FEED_MODE === "live") this.ships.delete(k);
  }

  private render(): FeatureCollection {
    if (!this.ships.size) return EMPTY;
    const features: GeoJSON.Feature[] = [];
    for (const s of this.ships.values()) {
      const moving = (s.sog ?? 0) >= 0.5;
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        properties: {
          mmsi: s.mmsi,
          name: s.name,
          cat: category(s.type),
          rot: s.heading ?? s.cog ?? 0,
          moving,
          size: s.len ? Math.min(1.4, Math.max(0.7, 0.6 + s.len / 250)) : 0.8,
          sel: s.mmsi === this.selected,
        },
      });
    }
    return { type: "FeatureCollection", features };
  }

  onDetailsClosed(): void {
    this.selected = undefined;
    if (this.isEnabled) this.setData(this.render());
  }

  protected addStyleLayers(map: MlMap): void {
    const layerId = `${this.id}-icons`;
    map.addLayer({
      id: layerId,
      type: "symbol",
      source: this.sourceId,
      layout: {
        // Moving ships: hull pointing along heading/course; stopped ones: a dot.
        "icon-image": ["case", ["get", "sel"], "ship-selected", ["get", "moving"], ["concat", "ship-", ["get", "cat"]], ["concat", "ship-stop-", ["get", "cat"]]],
        "icon-rotate": ["get", "rot"],
        "icon-rotation-alignment": "map",
        "icon-size": ["get", "size"],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "symbol-sort-key": ["case", ["get", "sel"], 1, 0],
      },
    });
    map.on("click", layerId, (e: MapLayerMouseEvent) => {
      const mmsi = Number(e.features?.[0]?.properties?.mmsi);
      const s = this.ships.get(mmsi);
      if (!s) return;
      this.selected = mmsi;
      showDetails(this, this.card(s));
      this.setData(this.render());
    });
    map.on("click", (e) => {
      if (this.selected !== undefined && map.queryRenderedFeatures(e.point, { layers: [layerId] }).length === 0) closeDetails(this);
    });
    map.on("mousemove", layerId, (e: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      const s = this.ships.get(Number(e.features?.[0]?.properties?.mmsi));
      if (!s) return;
      this.tip ??= new Popup({ closeButton: false, closeOnClick: false, className: "hover-tip", offset: 12 });
      this.tip.setLngLat(e.lngLat).setText(`${s.name || "unnamed"} · ${typeText(s.type)}`).addTo(map);
    });
    map.on("mouseleave", layerId, () => {
      map.getCanvas().style.cursor = "";
      this.tip?.remove();
    });
  }

  private card(s: Ship): HTMLElement {
    const ageS = Math.round((Date.now() - s.t) / 1000);
    const rows: [string, string][] = [
      ["Type", typeText(s.type)],
      ["Status", s.status !== null && NAV_STATUS[s.status] ? NAV_STATUS[s.status] : "—"],
      ["Speed", s.sog === null ? "—" : `${s.sog.toFixed(1)} kn`],
      ["Course", s.cog === null ? "—" : `${Math.round(s.cog)}°`],
      ["Heading", s.heading === null ? "—" : `${Math.round(s.heading)}°`],
      ["Destination", s.dest || "—"],
      ["Length", s.len ? `${s.len} m` : "—"],
      ["MMSI", String(s.mmsi)],
      ["Last report", ageS < 120 ? `${ageS} s ago` : `${Math.round(ageS / 60)} min ago`],
      ["Source", "AISStream (via our relay)"],
    ];
    return buildCard(s.name || "unnamed vessel", rows);
  }
}
