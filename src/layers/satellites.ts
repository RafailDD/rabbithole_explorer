import { Popup, type GeoJSONSource, type Map as MlMap, type MapLayerMouseEvent } from "maplibre-gl";
import { FEED_MODE, fixtureUrl } from "../config";
import { loadString, saveString } from "../storage";
import { buildCard, closeDetails, showDetails } from "../ui/details";
import { DataLayer, EMPTY, fetchJson, type FeatureCollection } from "./base";
import SatWorker from "./sat.worker?worker";

// Satellites from CelesTrak orbital elements (OMM JSON, readable by the browser: CORS OK),
// propagated with SGP4 (satellite.js) in a Web Worker once a second.
// CelesTrak asks for at most one download per data set per 2 hours: each group is cached
// in localStorage for 2 h and only re-fetched after that (a stale copy is kept on errors).

interface Omm {
  OBJECT_NAME: string;
  OBJECT_ID: string;
  NORAD_CAT_ID: number;
  EPOCH: string;
  MEAN_MOTION: number;
  INCLINATION: number;
  [k: string]: unknown;
}

const GROUPS: Record<string, { label: string; color: string }> = {
  stations: { label: "Space stations", color: "#7048e8" },
  "gps-ops": { label: "GPS", color: "#0c8599" },
  weather: { label: "Weather", color: "#e67700" },
  visual: { label: "Brightest", color: "#495057" },
};
const DEFAULT_GROUPS = ["stations", "gps-ops", "weather"];
const GROUPS_KEY = "rhe.sats.groups";
const CACHE_MS = 2 * 3600 * 1000;
const CELESTRAK = "https://celestrak.org/NORAD/elements/gp.php";

interface Cached {
  t: number;
  data: Omm[];
}

function readCache(group: string): Cached | undefined {
  try {
    const raw = loadString(`rhe.sats.cache.${group}`);
    const c = raw ? (JSON.parse(raw) as Cached) : undefined;
    return c && Array.isArray(c.data) ? c : undefined;
  } catch {
    return undefined;
  }
}

/** Split a ground track where it crosses the antimeridian, so it doesn't streak across the map. */
function splitTrack(coords: [number, number][]): number[][][] {
  const parts: number[][][] = [[]];
  for (let i = 0; i < coords.length; i++) {
    if (i > 0 && Math.abs(coords[i][0] - coords[i - 1][0]) > 180) parts.push([]);
    parts[parts.length - 1].push(coords[i]);
  }
  return parts.filter((p) => p.length > 1);
}

export class SatellitesLayer extends DataLayer {
  readonly id = "sats";
  readonly label = "Satellites";
  readonly credit = "Satellites: CelesTrak";
  protected readonly pollMs = CACHE_MS; // re-check the element sets every 2 h
  protected readonly frameMs = 1000; // move them every second

  private groups = new Set<string>(
    (loadString(GROUPS_KEY) ?? DEFAULT_GROUPS.join(",")).split(",").filter((g) => g in GROUPS),
  );
  private worker: Worker | undefined;
  private meta = new Map<string, { name: string; group: string; norad: number; epoch: string; incl: number; periodMin: number }>();
  private elementsAge = 0;
  /** Time (ms) of the positions currently drawn; read by the smoke test. */
  posTime = 0;
  private last: FeatureCollection = EMPTY;
  private selected: string | undefined;
  private tip: Popup | undefined;

  sourceIds(): string[] {
    return ["celestrak"];
  }

  private get trackSourceId(): string {
    return `${this.id}-track-src`;
  }

  enable(): void {
    this.worker = new SatWorker();
    this.worker.onmessage = (e) => this.onWorker(e.data);
    super.enable();
  }

  disable(): void {
    closeDetails(this);
    this.worker?.terminate();
    this.worker = undefined;
    this.meta.clear();
    this.last = EMPTY;
    super.disable();
  }

  renderSettings(changed: () => void): HTMLElement | null {
    const wrap = document.createElement("div");
    wrap.className = "setting";
    for (const [id, g] of Object.entries(GROUPS)) {
      const label = document.createElement("label");
      label.className = "group";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = this.groups.has(id);
      box.dataset.group = id;
      box.addEventListener("change", () => {
        if (box.checked) this.groups.add(id);
        else this.groups.delete(id);
        saveString(GROUPS_KEY, [...this.groups].join(","));
        closeDetails(this);
        this.refreshSoon(0);
        changed();
      });
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = g.color;
      label.append(box, dot, ` ${g.label}`);
      wrap.append(label);
    }
    return wrap;
  }

  protected describe(): string {
    const n = this.meta.size;
    if (this.groups.size === 0) return "pick at least one group";
    if (FEED_MODE === "fixtures") return `${n} satellites · fixture`;
    const age = this.elementsAge ? ` · downloaded ${Math.round((Date.now() - this.elementsAge) / 60000)} min ago` : "";
    return `${n} satellites${age}`;
  }

  /** Element sets for one group: fixture, fresh cache, or a new download (max 1 per 2 h). */
  private async groupData(group: string, signal: AbortSignal): Promise<{ data: Omm[]; t: number }> {
    if (FEED_MODE === "fixtures") return { data: await fetchJson<Omm[]>(fixtureUrl(`sats-${group}.json`), signal), t: Date.now() };
    const cached = readCache(group);
    if (cached && Date.now() - cached.t < CACHE_MS) return cached;
    try {
      const data = await fetchJson<Omm[]>(`${CELESTRAK}?GROUP=${encodeURIComponent(group)}&FORMAT=json`, signal);
      if (!Array.isArray(data)) throw new Error("unexpected answer");
      saveString(`rhe.sats.cache.${group}`, JSON.stringify({ t: Date.now(), data }));
      return { data, t: Date.now() };
    } catch (err) {
      if (cached && !signal.aborted) return cached; // keep using the stale copy rather than retrying
      throw err;
    }
  }

  protected async load(signal: AbortSignal): Promise<FeatureCollection> {
    const sats: { id: string; omm: Omm }[] = [];
    this.meta.clear();
    let oldest = 0;
    for (const group of this.groups) {
      const { data, t } = await this.groupData(group, signal);
      oldest = oldest ? Math.min(oldest, t) : t;
      for (const omm of data) {
        const id = String(omm.NORAD_CAT_ID);
        if (this.meta.has(id)) continue; // same satellite in two groups
        this.meta.set(id, {
          name: omm.OBJECT_NAME,
          group,
          norad: omm.NORAD_CAT_ID,
          epoch: omm.EPOCH,
          incl: omm.INCLINATION,
          periodMin: 1440 / omm.MEAN_MOTION,
        });
        sats.push({ id, omm });
      }
    }
    this.elementsAge = oldest;
    this.worker?.postMessage({ type: "set", sats });
    this.frame(); // positions now, not in a second
    return this.last;
  }

  protected frame(): void {
    if (this.meta.size) this.worker?.postMessage({ type: "tick", time: Date.now() });
  }

  private onWorker(msg: { type: string; time?: number; ids?: string[]; data?: Float64Array; id?: string; coords?: [number, number][] }): void {
    if (!this.isEnabled) return;
    if (msg.type === "positions" && msg.ids && msg.data) {
      const features: GeoJSON.Feature[] = [];
      msg.ids.forEach((id, i) => {
        const m = this.meta.get(id);
        if (!m) return;
        const d = msg.data!;
        features.push({
          type: "Feature",
          geometry: { type: "Point", coordinates: [d[i * 4], d[i * 4 + 1]] },
          properties: { id, name: m.name, group: m.group, color: GROUPS[m.group].color, alt: d[i * 4 + 2], speed: d[i * 4 + 3], sel: id === this.selected, iss: m.norad === 25544 },
        });
      });
      this.last = { type: "FeatureCollection", features };
      this.posTime = msg.time ?? 0;
      this.setData(this.last);
      if (this.selected) {
        const f = features.find((x) => x.properties?.id === this.selected);
        if (f) showDetails(this, this.card(f.properties ?? {}));
        else closeDetails(this);
      }
    } else if (msg.type === "track" && msg.id === this.selected && msg.coords) {
      const track = this.map.getSource(this.trackSourceId) as GeoJSONSource | undefined;
      track?.setData({ type: "Feature", geometry: { type: "MultiLineString", coordinates: splitTrack(msg.coords) }, properties: {} });
    }
  }

  onDetailsClosed(): void {
    this.selected = undefined;
    (this.map.getSource(this.trackSourceId) as GeoJSONSource | undefined)?.setData(EMPTY);
  }

  protected addStyleLayers(map: MlMap): void {
    map.addSource(this.trackSourceId, { type: "geojson", data: EMPTY });
    map.addLayer({
      id: `${this.id}-track`,
      type: "line",
      source: this.trackSourceId,
      paint: { "line-color": "#7048e8", "line-width": 1.5, "line-dasharray": [2, 2], "line-opacity": 0.8 },
    });
    const layerId = `${this.id}-dots`;
    map.addLayer({
      id: layerId,
      type: "circle",
      source: this.sourceId,
      paint: {
        "circle-radius": ["case", ["get", "iss"], 7, ["get", "sel"], 6, 4],
        "circle-color": ["get", "color"],
        "circle-stroke-color": ["case", ["get", "sel"], "#1d2329", "#ffffff"],
        "circle-stroke-width": ["case", ["get", "sel"], 2.5, 1],
      },
      // The ISS on top of the spacecraft docked to it, then the selected one.
      layout: { "circle-sort-key": ["case", ["get", "iss"], 2, ["get", "sel"], 1, 0] },
    });
    map.on("click", layerId, (e: MapLayerMouseEvent) => {
      const p = e.features?.[0]?.properties;
      if (!p) return;
      this.selected = String(p.id);
      showDetails(this, this.card(p));
      this.worker?.postMessage({ type: "track", id: this.selected, time: Date.now() });
    });
    map.on("click", (e) => {
      if (this.selected && map.queryRenderedFeatures(e.point, { layers: [layerId] }).length === 0) closeDetails(this);
    });
    map.on("mousemove", layerId, (e: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      const p = e.features?.[0]?.properties;
      if (!p) return;
      this.tip ??= new Popup({ closeButton: false, closeOnClick: false, className: "hover-tip", offset: 10 });
      this.tip.setLngLat(e.lngLat).setText(`${p.name} · ${Math.round(Number(p.alt)).toLocaleString("en")} km`).addTo(map);
    });
    map.on("mouseleave", layerId, () => {
      map.getCanvas().style.cursor = "";
      this.tip?.remove();
    });
  }

  private card(p: Record<string, unknown>): HTMLElement {
    const m = this.meta.get(String(p.id));
    const epochMs = m ? Date.parse(m.epoch.endsWith("Z") ? m.epoch : `${m.epoch}Z`) : NaN;
    const ageH = Number.isFinite(epochMs) ? (Date.now() - epochMs) / 3600000 : NaN;
    const rows: [string, string][] = [
      ["Group", m ? GROUPS[m.group].label : "—"],
      ["NORAD ID", String(m?.norad ?? "—")],
      ["Altitude", `${Math.round(Number(p.alt)).toLocaleString("en")} km`],
      ["Speed", `${Number(p.speed).toFixed(2)} km/s`],
      ["Orbit", m ? `${m.periodMin < 200 ? `${Math.round(m.periodMin)} min` : `${(m.periodMin / 60).toFixed(1)} h`} per orbit, ${m.incl.toFixed(1)}° inclination` : "—"],
      ["Elements", Number.isFinite(ageH) ? `${ageH < 48 ? `${Math.round(ageH)} h` : `${Math.round(ageH / 24)} days`} old (older = less precise)` : "—"],
      ["Path", "dashed line: one orbit back and one ahead"],
      ["Source", "CelesTrak (SGP4 propagation in your browser)"],
    ];
    return buildCard(String(p.name), rows);
  }
}
