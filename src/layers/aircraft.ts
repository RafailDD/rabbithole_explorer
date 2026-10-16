import { Popup, type GeoJSONSource, type Map as MlMap, type MapLayerMouseEvent } from "maplibre-gl";
import { FEED_MODE, fixtureUrl } from "../config";
import { onRelayChange, relayUrl } from "../relay";
import { loadString, saveString } from "../storage";
import { DataLayer, EMPTY, fetchJson, HttpError, type FeatureCollection } from "./base";
import { buildCard, closeDetails, showDetails } from "../ui/details";
import { distanceKm, lookupRoute, type RouteGuess } from "./routes";

/** One aircraft as the ADSBx-v2-style APIs return it (only the fields we use). */
interface AdsbRecord {
  hex: string;
  flight?: string;
  t?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground";
  alt_geom?: number;
  gs?: number;
  track?: number;
  true_heading?: number;
  mag_heading?: number;
  seen_pos?: number;
}

/**
 * adsb.lol trace file (readsb format). Each point: [seconds after `timestamp`, lat, lon,
 * altitude ft or "ground", ground speed, track, flags, ...]. Flags bit 1 = stale,
 * bit 2 = start of a new flight leg.
 */
interface TraceFile {
  timestamp: number;
  trace: [number, number, number, number | "ground" | null, number | null, number | null, number, ...unknown[]][];
}

/** Path of the selected aircraft's current flight, from its trace. */
interface FlightPath {
  hex: string;
  state: "loading" | "ok" | "none";
  coords: [number, number][];
  /** Time (ms) of the last trace point; our own polled positions continue the line after it. */
  endT: number;
  /** Take-off time if the trace shows it, else when the trace of this leg starts. */
  departed?: number;
  since?: number;
}

interface AdsbResponse {
  ac?: AdsbRecord[];
  aircraft?: AdsbRecord[];
}

/** What we keep in memory per aircraft. Never written to storage. */
interface Track {
  hex: string;
  flight: string;
  type: string;
  alt: number;
  ground: boolean;
  gs: number | null;
  track: number;
  source: string;
  /** Last real position and its time (local clock, ms). */
  lon: number;
  lat: number;
  t: number;
  /** Real positions received since the layer was turned on, for the trail. */
  trail: [number, number, number][]; // lon, lat, time
}

// airplanes.live removed 14 Oct 2026: it refuses unknown apps ("contact us"). Re-add once
// we have their permission (path: `airplaneslive/v2/point/${lat}/${lon}/${nm}`).
type FeedId = "adsblol" | "adsbfi";

const FEEDS: Record<
  FeedId,
  { name: string; credit: string; path: (lat: number, lon: number, nm: number) => string; hexPath: (hex: string) => string }
> = {
  adsblol: {
    name: "adsb.lol",
    credit: "Aircraft: adsb.lol (ODbL)",
    path: (la, lo, nm) => `adsblol/v2/lat/${la}/lon/${lo}/dist/${nm}`,
    hexPath: (hex) => `adsblol/v2/hex/${hex}`,
  },
  adsbfi: {
    name: "adsb.fi",
    credit: "Aircraft: adsb.fi",
    path: (la, lo, nm) => `adsbfi/api/v3/lat/${la}/lon/${lo}/dist/${nm}`,
    hexPath: (hex) => `adsbfi/api/v2/hex/${hex}`,
  },
};

const MIN_ZOOM = 5;
const MAX_NM = 250;
const STALE_S = 60; // drop positions older than this
const MIN_GAP_MS = 2000; // never query faster than this, even while panning
const FAST_POLL_NM = 100; // query radius at or below which we poll every 5 s instead of 10 s
const MAX_EXTRAPOLATE_S = 30; // stop dead-reckoning an aircraft we have not heard about for this long
const TRAIL_MS = 10 * 60 * 1000; // trail length kept in memory
const FEED_KEY = "rhe.air.feed";

/** Great-circle distance in nautical miles. */
function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return distanceKm(lat1, lon1, lat2, lon2) / 1.852;
}

/**
 * Public ADS-B aircraft around the view centre.
 *
 * - Polls every 5 s (zoomed in) or 10 s (wide view), and re-queries shortly after the map
 *   stops moving. Radius = min(250 nm, half the view diagonal).
 * - Between polls, moves every aircraft once a second from its last speed and track
 *   ("dead reckoning"); the next real position corrects it.
 * - Keeps a 10-minute trail per aircraft, in memory only, from positions received while the
 *   layer is on.
 */
export class AircraftLayer extends DataLayer {
  readonly id = "air";
  readonly label = "Aircraft (public feed)";
  protected readonly frameMs = 1000;

  private feed: FeedId = (loadString(FEED_KEY) as FeedId) in FEEDS ? (loadString(FEED_KEY) as FeedId) : "adsblol";
  private tooFar = false;
  private lastQuery = "";
  private lastStart = 0;
  private lastNm = MAX_NM;
  private tracks = new Map<string, Track>();
  /** Small hover tooltip (callsign + altitude); details go in the docked panel. */
  private tip: Popup | undefined;
  /** Hex of the aircraft whose card is open; the card follows it. */
  private selected: string | undefined;
  private route: { hex: string; state: "loading" | "none" | "error" | RouteGuess } | undefined;
  private routeCtrl: AbortController | undefined;
  private path: FlightPath | undefined;
  private pathCtrl: AbortController | undefined;
  /** Area the last public query covered (for the antenna overlay's comparison). */
  private covered: { lat: number; lon: number; km: number } | undefined;
  /** Hexes the antenna overlay also hears: drawn with a green ring. */
  private heard = new Set<string>();
  /** Extra card rows supplied by other layers (the antenna overlay). */
  extraRows: (hex: string) => [string, string][] = () => [];

  /** Public aircraft and their estimated positions now (empty when off or zoomed out). */
  publicPositions(): Map<string, [number, number]> {
    const out = new Map<string, [number, number]>();
    if (!this.isEnabled || this.tooFar) return out;
    const now = Date.now();
    for (const tr of this.tracks.values()) out.set(tr.hex, this.position(tr, now));
    return out;
  }

  /** Circle the public data currently covers, or undefined when off / zoomed out. */
  coverage(): { lat: number; lon: number; km: number } | undefined {
    return this.isEnabled && !this.tooFar ? this.covered : undefined;
  }

  /** Set which aircraft the antenna overlay hears; redraws the rings now. */
  setHeard(hexes: Set<string>): void {
    const same = hexes.size === this.heard.size && [...hexes].every((h) => this.heard.has(h));
    this.heard = hexes;
    if (!same && this.isEnabled && !this.tooFar) this.setData(this.render(false));
  }

  protected get pollMs(): number {
    return this.lastNm <= FAST_POLL_NM ? 5000 : 10000;
  }

  get credit(): string {
    return FEED_MODE === "fixtures" ? "Aircraft: adsb.lol sample (ODbL)" : `${FEEDS[this.feed].credit} · routes: VRS standing data`;
  }

  sourceIds(): string[] {
    return FEED_MODE === "fixtures" ? ["adsblol"] : [...new Set([this.feed, "adsblol", "vrsroutes"])];
  }

  private get trailSourceId(): string {
    return `${this.id}-trails-src`;
  }

  attach(map: MlMap): void {
    super.attach(map);
    onRelayChange(() => {
      this.backoffUntil = {};
      this.refreshSoon(0);
    });
    map.on("moveend", () => {
      if (FEED_MODE === "fixtures" || this.queryKey() === this.lastQuery) return;
      this.refreshSoon(Math.max(700, this.lastStart + MIN_GAP_MS - Date.now()));
    });
  }

  disable(): void {
    this.deselect();
    this.lastQuery = "";
    this.tracks.clear();
    this.setTrails(EMPTY);
    super.disable();
  }

  renderSettings(changed: () => void): HTMLElement | null {
    if (FEED_MODE === "fixtures") return null;
    const wrap = document.createElement("div");
    wrap.className = "setting";
    const sel = document.createElement("select");
    sel.title = "Aircraft data source";
    for (const [id, f] of Object.entries(FEEDS)) {
      const o = document.createElement("option");
      o.value = id;
      o.textContent = f.name;
      o.selected = id === this.feed;
      sel.append(o);
    }
    sel.addEventListener("change", () => {
      this.feed = sel.value as FeedId;
      saveString(FEED_KEY, this.feed);
      this.lastQuery = "";
      this.refreshSoon(0);
      changed();
    });
    wrap.append("source: ", sel);
    return wrap;
  }

  protected describe(fc: FeatureCollection): string {
    const followed = this.selected ? this.tracks.get(this.selected) : undefined;
    if (this.tooFar && followed) return `following ${followed.flight || followed.hex.toUpperCase()} · zoom in (≥ ${MIN_ZOOM}) to see all aircraft`;
    if (this.tooFar) return `zoom in to see aircraft (zoom ≥ ${MIN_ZOOM})`;
    const src = FEED_MODE === "fixtures" ? "fixture" : FEEDS[this.feed].name;
    return `${fc.features.length} aircraft · ${src} · every ${this.pollMs / 1000} s`;
  }

  /** Centre (rounded to ~1 km) and radius of the query the current view needs. */
  private query(): { lat: number; lon: number; nm: number } {
    const c = this.map.getCenter();
    const ne = this.map.getBounds().getNorthEast();
    const nm = Math.max(1, Math.min(MAX_NM, Math.ceil(distanceNm(c.lat, c.lng, ne.lat, ne.lng))));
    return { lat: Math.round(c.lat * 100) / 100, lon: Math.round(c.wrap().lng * 100) / 100, nm };
  }

  private queryKey(): string {
    if (this.map.getZoom() < MIN_ZOOM) return "too-far";
    const q = this.query();
    return `${this.feed}/${q.lat}/${q.lon}/${q.nm}`;
  }

  /** Per source: until when to send nothing after it said "too many requests" (HTTP 429). */
  private backoffUntil: Partial<Record<FeedId, number>> = {};

  /** GET one relayed feed path, with errors that say who answered. */
  private async get(path: string, signal: AbortSignal): Promise<AdsbRecord[]> {
    const url = FEED_MODE === "fixtures" ? fixtureUrl("aircraft-adsblol.json") : `${relayUrl()}/air/${path}`;
    try {
      const data = await fetchJson<AdsbResponse>(url, signal);
      return data.ac ?? data.aircraft ?? [];
    } catch (err) {
      if (FEED_MODE === "fixtures" || signal.aborted) throw err;
      // Network failure: nothing answered at the relay address.
      if (err instanceof TypeError) throw new Error(`relay not reachable at ${relayUrl()} (choose another under "Relay:")`);
      if (!(err instanceof HttpError)) throw err;
      // Three different answerers: something that isn't our relay, our relay, or the feed itself.
      if (err.via === "relay") throw new Error(`relay: ${err.message}`);
      if (err.via === "") throw new Error(`no rabbithole relay at ${relayUrl()} (HTTP ${err.status})`);
      if (err.status === 429) {
        this.backoffUntil[this.feed] = Date.now() + 30000;
        throw new Error(`${FEEDS[this.feed].name} asks us to slow down (429): pausing 30 s`);
      }
      throw new Error(`${FEEDS[this.feed].name} answered ${err.message}`);
    }
  }

  protected async load(signal: AbortSignal): Promise<FeatureCollection> {
    this.tooFar = this.map.getZoom() < MIN_ZOOM;
    this.lastQuery = this.queryKey();
    const live = FEED_MODE === "live";
    const wait = (this.backoffUntil[this.feed] ?? 0) - Date.now();
    if (live && wait > 0) throw new Error(`${FEEDS[this.feed].name} asked us to slow down: next try in ${Math.ceil(wait / 1000)} s`);
    let records: AdsbRecord[] = [];
    if (!this.tooFar) {
      this.lastStart = Date.now();
      if (live) {
        const q = this.query();
        this.lastNm = q.nm;
        this.covered = { lat: q.lat, lon: q.lon, km: q.nm * 1.852 };
        records = await this.get(FEEDS[this.feed].path(q.lat, q.lon, q.nm), signal);
      } else {
        this.covered = { lat: 43.58, lon: 7.12, km: 150 * 1.852 }; // what the fixture was recorded with
        records = await this.get("", signal);
      }
    } else if (!(live && this.selected)) {
      // Zoomed out and nothing to follow: no request at all.
      this.tracks.clear();
      this.setTrails(EMPTY);
      return EMPTY;
    }
    // Keep following the selected aircraft when it is outside the queried area or the map is
    // zoomed out: one small extra request for just that aircraft.
    const sel = this.selected;
    let keep: string | undefined;
    if (live && sel && /^[0-9a-f]{6}$/.test(sel) && !records.some((r) => r.hex === sel)) {
      try {
        records.push(...(await this.get(FEEDS[this.feed].hexPath(sel), signal)).filter((r) => r.hex === sel));
      } catch (err) {
        if (signal.aborted) throw err;
        keep = sel; // a failed lookup is not "gone": keep showing it until the next answer
      }
    }
    this.update(records, FEED_MODE === "fixtures" ? "adsb.lol (sample)" : FEEDS[this.feed].name, keep);
    const fc = this.render(true);
    this.followSelected(fc, true);
    return fc;
  }

  /** Merge a fresh response into the in-memory tracks. */
  private update(records: AdsbRecord[], source: string, keep?: string): void {
    const now = Date.now();
    const seen = new Set<string>();
    for (const a of records) {
      if (typeof a.lat !== "number" || typeof a.lon !== "number") continue;
      const age = a.seen_pos ?? 0;
      if (age > STALE_S) continue;
      const t = now - age * 1000;
      const ground = a.alt_baro === "ground";
      let tr = this.tracks.get(a.hex);
      if (!tr) {
        tr = { hex: a.hex, flight: "", type: "", alt: 0, ground, gs: null, track: 0, source, lon: a.lon, lat: a.lat, t, trail: [] };
        this.tracks.set(a.hex, tr);
      }
      tr.flight = (a.flight ?? "").trim() || tr.flight;
      tr.type = a.t ?? tr.type;
      tr.ground = ground;
      tr.alt = ground ? 0 : typeof a.alt_baro === "number" ? a.alt_baro : (a.alt_geom ?? tr.alt);
      tr.gs = a.gs ?? null;
      tr.track = a.track ?? a.true_heading ?? a.mag_heading ?? tr.track;
      tr.source = source;
      tr.lon = a.lon;
      tr.lat = a.lat;
      tr.t = t;
      const last = tr.trail[tr.trail.length - 1];
      if (!last || last[0] !== a.lon || last[1] !== a.lat) tr.trail.push([a.lon, a.lat, t]);
      while (tr.trail.length && now - tr.trail[0][2] > TRAIL_MS) tr.trail.shift();
      seen.add(a.hex);
    }
    // Aircraft missing from this answer left the area or stopped reporting.
    for (const hex of this.tracks.keys()) if (!seen.has(hex) && hex !== keep) this.tracks.delete(hex);
  }

  /** Estimated position now: last real position moved along its track at its ground speed. */
  private position(tr: Track, now: number): [number, number] {
    if (FEED_MODE === "fixtures" || tr.ground || !tr.gs || tr.gs < 30) return [tr.lon, tr.lat];
    const dtH = Math.min((now - tr.t) / 1000, MAX_EXTRAPOLATE_S) / 3600;
    const distDeg = (tr.gs * dtH) / 60; // 1 nm = 1/60° of latitude
    const rad = (tr.track * Math.PI) / 180;
    const lat = tr.lat + distDeg * Math.cos(rad);
    const lon = tr.lon + (distDeg * Math.sin(rad)) / Math.cos((tr.lat * Math.PI) / 180);
    return [lon, lat];
  }

  /** Build the aircraft points (and, with `trails`, the trail lines) for the current time. */
  private render(trails: boolean): FeatureCollection {
    const now = Date.now();
    const points: GeoJSON.Feature[] = [];
    const lines: GeoJSON.Feature[] = [];
    for (const tr of this.tracks.values()) {
      const pos = this.position(tr, now);
      points.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: pos },
        properties: { ...this.trackProps(tr), sel: tr.hex === this.selected, heard: this.heard.has(tr.hex) },
      });
      // Only the selected aircraft gets a path: its trace (if loaded), then the positions we
      // polled ourselves after the trace ends, then its estimated position now.
      if (trails && tr.hex === this.selected) {
        const p = this.path?.hex === tr.hex ? this.path : undefined;
        const coords: number[][] = p ? [...p.coords] : [];
        const after = p?.endT ?? 0;
        for (const [lo, la, t] of tr.trail) if (t > after) coords.push([lo, la]);
        coords.push(pos);
        if (coords.length >= 2) lines.push({ type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: {} });
      }
    }
    if (trails) this.setTrails({ type: "FeatureCollection", features: lines });
    return { type: "FeatureCollection", features: points };
  }

  /** Once a second: move every aircraft along its track (no network). */
  protected frame(): void {
    if ((this.tooFar && !this.selected) || this.tracks.size === 0 || FEED_MODE === "fixtures") return;
    const fc = this.render(true);
    this.setData(fc);
    this.followSelected(fc, false);
  }

  private setTrails(fc: FeatureCollection): void {
    (this.map.getSource(this.trailSourceId) as GeoJSONSource | undefined)?.setData(fc);
  }

  /** Show the selected aircraft's details in the shared docked panel (src/ui/details.ts). */
  private showDetails(): void {
    const tr = this.selected ? this.tracks.get(this.selected) : undefined;
    if (tr) showDetails(this, this.card(this.trackProps(tr)));
  }

  /** The panel was closed (×, Esc) or taken by another layer: drop our selection. */
  onDetailsClosed(): void {
    this.clearSelection();
  }

  /** On data updates: refresh the panel, or deselect if the aircraft has gone. */
  private followSelected(_fc: FeatureCollection, refresh: boolean): void {
    if (!this.selected) return;
    if (!this.tracks.has(this.selected)) {
      this.deselect(); // aircraft left the area or stopped reporting
      return;
    }
    if (refresh) this.showDetails();
  }

  /** Fetch today's trace of the selected aircraft once and keep its current flight leg. */
  private loadPath(hex: string): void {
    this.pathCtrl?.abort();
    if (FEED_MODE === "fixtures" || !/^[0-9a-f]{6}$/.test(hex)) {
      this.path = { hex, state: "none", coords: [], endT: 0 };
      return;
    }
    const ctrl = new AbortController();
    this.pathCtrl = ctrl;
    this.path = { hex, state: "loading", coords: [], endT: 0 };
    const url = `${relayUrl()}/air/adsbloltrace/${hex.slice(-2)}/trace_full_${hex}.json`;
    fetchJson<TraceFile>(url, ctrl.signal)
      .then((file) => parseTrace(hex, file), () => (ctrl.signal.aborted ? undefined : ({ hex, state: "none", coords: [], endT: 0 } as FlightPath)))
      .then((path) => {
        if (!path || this.selected !== hex) return;
        this.path = path;
        this.render(true); // draw the path now rather than at the next frame
        this.showDetails();
      });
  }

  /** Forget the selection: panel, highlight, route, path. */
  private deselect(): void {
    closeDetails(this);
    this.clearSelection();
  }

  private clearSelection(): void {
    const had = this.selected !== undefined;
    this.selected = undefined;
    this.route = undefined;
    this.path = undefined;
    this.routeCtrl?.abort();
    this.pathCtrl?.abort();
    this.setTrails(EMPTY);
    if (had && this.isEnabled) this.setData(this.render(false)); // drop the highlight now
  }

  /** Fetch the route for the selected aircraft once, then redraw its card. */
  private loadRoute(hex: string, callsign: string, lon: number, lat: number): void {
    this.routeCtrl?.abort();
    if (FEED_MODE === "fixtures" || !callsign) {
      this.route = { hex, state: "none" };
      return;
    }
    const ctrl = new AbortController();
    this.routeCtrl = ctrl;
    this.route = { hex, state: "loading" };
    lookupRoute(callsign, lat, lon, ctrl.signal)
      .then((r) => ({ hex, state: r ?? ("none" as const) }))
      .catch((err) => (ctrl.signal.aborted ? undefined : { hex, state: "error" as const, err }))
      .then((result) => {
        if (!result || this.selected !== hex) return;
        this.route = { hex, state: result.state };
        this.showDetails();
      });
  }

  private trackProps(tr: Track): Record<string, unknown> {
    return { hex: tr.hex, flight: tr.flight, type: tr.type, alt: tr.alt, ground: tr.ground, gs: tr.gs, track: tr.track, source: tr.source };
  }

  protected addStyleLayers(map: MlMap): void {
    map.addSource(this.trailSourceId, { type: "geojson", data: EMPTY });
    map.addLayer({
      id: `${this.id}-trails`,
      type: "line",
      source: this.trailSourceId,
      paint: { "line-color": "#d9480f", "line-width": 2, "line-opacity": 0.8 },
    });
    // Green ring under aircraft the antenna overlay also hears ("heard by both").
    map.addLayer({
      id: `${this.id}-heard`,
      type: "circle",
      source: this.sourceId,
      filter: ["==", ["get", "heard"], true],
      paint: { "circle-radius": 13, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#2b8a3e", "circle-stroke-width": 2 },
    });
    const layerId = `${this.id}-planes`;
    map.addLayer({
      id: layerId,
      type: "symbol",
      source: this.sourceId,
      layout: {
        "icon-image": ["case", ["get", "sel"], "plane-selected", ["get", "ground"], "plane-ground", "plane"],
        "icon-rotate": ["get", "track"],
        "icon-rotation-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        // Selected aircraft on top, then high aircraft above low ones.
        "symbol-sort-key": ["case", ["get", "sel"], 1e6, ["get", "alt"]],
      },
    });
    map.on("click", layerId, (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f || f.geometry.type !== "Point") return;
      const p = f.properties ?? {};
      const [lon, lat] = f.geometry.coordinates as [number, number];
      this.deselect();
      this.selected = String(p.hex ?? "");
      this.loadRoute(this.selected, String(p.flight ?? ""), lon, lat);
      this.loadPath(this.selected);
      this.setData(this.render(true)); // highlight + path now, not at the next frame
      this.showDetails();
    });
    // A click on empty map (no aircraft under it) deselects; Esc is handled in src/ui/details.ts.
    map.on("click", (e) => {
      if (!this.selected || !this.isEnabled) return;
      if (map.queryRenderedFeatures(e.point, { layers: [layerId] }).length === 0) this.deselect();
    });
    // Hover: small tooltip with callsign and altitude, so the map stays visible.
    map.on("mousemove", layerId, (e: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      const p = e.features?.[0]?.properties;
      if (!p) return;
      const alt = p.ground ? "ground" : `${(Math.round(Number(p.alt) / 100) * 100).toLocaleString("en")} ft`;
      this.tip ??= new Popup({ closeButton: false, closeOnClick: false, className: "hover-tip", offset: 14 });
      this.tip.setLngLat(e.lngLat).setText(`${p.flight || String(p.hex).toUpperCase()} · ${alt}`).addTo(map);
    });
    map.on("mouseleave", layerId, () => {
      map.getCanvas().style.cursor = "";
      this.tip?.remove();
    });
  }

  /** Details card. Built with textContent only (no HTML injection from feed data). */
  private card(p: Record<string, unknown>): HTMLElement {
    const gs = p.gs === null || p.gs === undefined ? null : Number(p.gs);
    const rows: [string, string][] = [];
    const route = this.route && this.route.hex === p.hex ? this.route.state : undefined;
    if (route === "loading") rows.push(["Route", "looking up…"]);
    else if (route === "none") rows.push(["Route", FEED_MODE === "fixtures" ? "not looked up (fixtures)" : "none on file"]);
    else if (route === "error") rows.push(["Route", "lookup failed"]);
    else if (route) {
      rows.push(["Route", route.plausible ? route.text : `${route.text} (doesn't match its position: probably outdated)`]);
      const tr = this.tracks.get(String(p.hex));
      if (route.plausible && route.to && tr && gs && gs > 50 && !tr.ground) {
        const [lon, lat] = this.position(tr, Date.now());
        const km = distanceKm(lat, lon, route.to.lat, route.to.lon);
        const eta = new Date(Date.now() + (km / (gs * 1.852)) * 3600 * 1000);
        const hhmm = eta.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        rows.push(["To go", `≈ ${Math.round(km)} km, ETA ≈ ${hhmm} (rough: straight line at current speed)`]);
      }
    }
    const path = this.path && this.path.hex === p.hex ? this.path : undefined;
    const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (path?.state === "loading") rows.push(["Path", "loading…"]);
    else if (path?.departed) {
      const min = Math.round((Date.now() - path.departed) / 60000);
      rows.push(["Departed", `≈ ${hhmm(path.departed)} (${Math.floor(min / 60)} h ${min % 60} min ago)`]);
    } else if (path?.since) rows.push(["Path", `tracked since ${hhmm(path.since)} (take-off not in today's trace)`]);
    else if (path?.state === "none" && FEED_MODE === "live") rows.push(["Path", "not available right now"]);
    rows.push(
      ["ICAO hex", String(p.hex ?? "").toUpperCase()],
      ["Type", String(p.type || "—")],
      ["Altitude", p.ground ? "on ground" : `${Number(p.alt).toLocaleString("en")} ft`],
      ["Speed", gs === null ? "—" : `${Math.round(gs)} kt`],
      ["Track", `${Math.round(Number(p.track))}°`],
      ...this.extraRows(String(p.hex ?? "")),
      ["Source", String(p.source ?? "")],
    );
    return buildCard(String(p.flight || "no callsign"), rows);
  }
}

/**
 * Keep the current flight of a trace. A trace holds the whole day, often several flights.
 * The current flight starts at the last of: a leg marker (flag bit 2), a take-off (ground →
 * airborne), or a gap of more than 20 min (the aircraft sat on the ground out of receiver
 * coverage).
 */
function parseTrace(hex: string, file: TraceFile): FlightPath {
  const pts = (file.trace ?? []).filter((q) => typeof q[1] === "number" && typeof q[2] === "number");
  if (pts.length === 0) return { hex, state: "none", coords: [], endT: 0 };
  const time = (q: (typeof pts)[number]) => (file.timestamp + q[0]) * 1000;
  let start = 0;
  let tookOff = false;
  for (let i = pts.length - 1; i > 0; i--) {
    if (pts[i - 1][3] === "ground" && pts[i][3] !== "ground") {
      start = i;
      tookOff = true;
      break;
    }
    if (pts[i][6] & 2 || pts[i][0] - pts[i - 1][0] > 20 * 60) {
      start = i;
      break;
    }
  }
  const leg = pts.slice(start);
  const first = leg[0];
  // Seen low right at the start of the flight: close enough to call it the take-off time.
  const lowStart = typeof first[3] === "number" && first[3] < 8000;
  return {
    hex,
    state: "ok",
    coords: leg.map((q) => [q[2], q[1]]),
    endT: time(leg[leg.length - 1]),
    departed: tookOff || lowStart ? time(first) : undefined,
    since: time(first),
  };
}
