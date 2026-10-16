import { Popup, type Map as MlMap, type MapLayerMouseEvent } from "maplibre-gl";
import { FEED_MODE, fixtureUrl } from "../config";
import { relayUrl } from "../relay";
import { buildCard, closeDetails, showDetails } from "../ui/details";
import { DataLayer, fetchJson, type FeatureCollection } from "./base";

// Public webcams from the Windy Webcams API (free plan), through our relay (worker/), which
// holds the key. The page asks for the map tiles covering the view; Windy groups nearby
// cameras into clusters suited to the zoom level. Images and players come straight from
// Windy's servers, unchanged (their terms), and are loaded only when a camera is clicked.

/** As the relay sends it: [id, lon, lat, clusterSize, title, place, active, updated, preview, w, h, player, detail, provider]. */
type Row = [number, number, number, number, string, string, number, string, string, number, number, string, string, string];

const TILE_TTL_MS = 10 * 60 * 1000;
const MAX_TILES = 20;

function a(text: string, href: string): HTMLAnchorElement {
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = text;
  return link;
}

function ago(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return "just now";
  if (min < 120) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} days ago`;
}

export class WebcamsLayer extends DataLayer {
  readonly id = "webcams";
  readonly label = "Webcams (Windy)";
  readonly credit = "Webcams provided by windy.com – add new webcam";
  protected readonly pollMs = TILE_TTL_MS;

  private tiles = new Map<string, { at: number; rows: Row[] }>();
  private cams = new Map<number, Row>();
  private note = "";
  private tip: Popup | undefined;

  sourceIds(): string[] {
    return ["windy"];
  }

  creditNodes(): (string | Node)[] {
    // Wording and links required by the Windy Webcams API terms.
    return ["Webcams provided by ", a("windy.com", "https://www.windy.com/"), " – ", a("add new webcam", "https://www.windy.com/webcams/add")];
  }

  attach(map: MlMap): void {
    super.attach(map);
    map.on("moveend", () => this.refreshSoon(600));
  }

  disable(): void {
    closeDetails(this);
    this.cams.clear();
    super.disable();
  }

  onDetailsClosed(): void {}

  protected describe(): string {
    if (this.note) return this.note;
    let total = 0;
    for (const r of this.cams.values()) total += r[3];
    return `${total.toLocaleString("en")} webcams in view${FEED_MODE === "fixtures" ? " · saved sample" : ""}`;
  }

  /** Tiles (Windy zoom = floor of the map zoom) covering the view. */
  private viewTiles(): [number, number, number][] {
    const z = Math.max(1, Math.min(16, Math.floor(this.map.getZoom())));
    const n = 2 ** z;
    const b = this.map.getBounds();
    const tx = (lon: number) => Math.floor(((lon + 180) / 360) * n);
    const ty = (lat: number) => {
      const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
      return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
    };
    const x0 = tx(Math.max(-180, b.getWest()));
    const x1 = Math.min(n - 1, tx(Math.min(179.999, b.getEast())));
    const y0 = ty(b.getNorth());
    const y1 = Math.min(n - 1, ty(b.getSouth()));
    const out: [number, number, number][] = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push([z, x, y]);
    return out;
  }

  protected async load(signal: AbortSignal): Promise<FeatureCollection> {
    this.note = "";
    let rows: Row[];
    if (FEED_MODE === "fixtures") {
      rows = (await fetchJson<{ cams: Row[] }>(fixtureUrl("webcams-sample.json"), signal)).cams;
    } else {
      const want = this.viewTiles();
      if (want.length > MAX_TILES) {
        this.note = "zoom in to see webcams";
        this.cams.clear();
        return this.render();
      }
      const now = Date.now();
      const relay = relayUrl();
      let error = "";
      await Promise.all(
        want.map(async ([z, x, y]) => {
          const key = `${z}/${x}/${y}`;
          const hit = this.tiles.get(key);
          if (hit && now - hit.at < TILE_TTL_MS) return;
          try {
            const res = await fetch(`${relay}/webcams/tile/${key}`, { signal });
            const body = (await res.json()) as { cams?: Row[]; error?: string };
            if (!res.ok || !body.cams) throw new Error(body.error ?? `relay answered HTTP ${res.status}`);
            this.tiles.set(key, { at: now, rows: body.cams });
          } catch (err) {
            if (signal.aborted) throw err;
            error ||= err instanceof TypeError ? `relay not reachable at ${relay} (is it deployed?)` : String((err as Error).message);
          }
        }),
      );
      for (const [k, t] of this.tiles) if (now - t.at > TILE_TTL_MS) this.tiles.delete(k);
      rows = want.flatMap(([z, x, y]) => this.tiles.get(`${z}/${x}/${y}`)?.rows ?? []);
      if (error && rows.length === 0) throw new Error(error); // shown in red
      if (error) this.note = `some areas missing: ${error}`;
    }
    this.cams = new Map(rows.map((r) => [r[0], r]));
    return this.render();
  }

  private render(): FeatureCollection {
    const features: GeoJSON.Feature[] = [];
    for (const r of this.cams.values()) {
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [r[1], r[2]] },
        properties: { id: r[0], n: r[3], active: r[6] === 1 },
      });
    }
    return { type: "FeatureCollection", features };
  }

  protected addStyleLayers(map: MlMap): void {
    const dots = `${this.id}-dots`;
    map.addLayer({
      id: dots,
      type: "circle",
      source: this.sourceId,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["get", "n"], 1, 6, 10, 10, 100, 14, 1000, 19],
        "circle-color": ["case", [">", ["get", "n"], 1], "#4c6ef5", ["get", "active"], "#3b5bdb", "#868e96"],
        "circle-opacity": 0.9,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.5,
      },
    });
    map.addLayer({
      id: `${this.id}-count`,
      type: "symbol",
      source: this.sourceId,
      filter: [">", ["get", "n"], 1],
      layout: {
        "text-field": ["to-string", ["get", "n"]],
        "text-font": ["Noto Sans Bold"],
        "text-size": 11,
        "text-allow-overlap": true,
        "text-ignore-placement": true,
      },
      paint: { "text-color": "#ffffff" },
    });
    map.on("click", dots, (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      const r = this.cams.get(Number(f?.properties?.id));
      if (!r) return;
      if (r[3] > 1) {
        // A cluster: zoom in towards it.
        map.easeTo({ center: [r[1], r[2]], zoom: Math.min(16, map.getZoom() + 2) });
        return;
      }
      showDetails(this, this.card(r));
    });
    map.on("mousemove", dots, (e: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      const r = this.cams.get(Number(e.features?.[0]?.properties?.id));
      if (!r) return;
      this.tip ??= new Popup({ closeButton: false, closeOnClick: false, className: "hover-tip", offset: 12 });
      this.tip.setLngLat(e.lngLat).setText(r[3] > 1 ? `${r[3]} webcams · click to zoom in` : r[4]).addTo(map);
    });
    map.on("mouseleave", dots, () => {
      map.getCanvas().style.cursor = "";
      this.tip?.remove();
    });
  }

  private card(r: Row): HTMLElement {
    const [, , , , title, place, active, updated, preview, w, , player, detail, provider] = r;
    const card = buildCard(title, [
      ["Place", place || "—"],
      ["Picture", active ? `updated ${ago(updated)}` : `camera offline (last picture ${ago(updated)})`],
    ]);
    card.classList.add("media-card");
    const media = document.createElement("div");
    if (preview) {
      const img = document.createElement("img");
      img.className = "media";
      img.src = preview; // URL exactly as Windy gives it
      img.alt = `Latest picture from ${title}`;
      if (w) img.style.maxWidth = `${w}px`; // never stretched beyond its own size
      media.append(img);
    } else media.textContent = "(no picture in the saved sample)";
    card.insertBefore(media, card.querySelector("dl"));
    const links = document.createElement("p");
    links.className = "links";
    if (player) {
      const btn = document.createElement("button");
      btn.textContent = "▶ Timelapse (last 24 h)";
      btn.addEventListener("click", () => {
        const frame = document.createElement("iframe");
        frame.className = "media";
        frame.src = player;
        frame.title = `Timelapse: ${title}`;
        frame.allow = "fullscreen";
        media.replaceChildren(frame);
        btn.remove();
      });
      links.append(btn, " ");
    }
    if (detail) links.append(a("windy.com page", detail), " ");
    if (provider) links.append(a("camera's own site", provider));
    const credit = document.createElement("p");
    credit.className = "small";
    credit.append("Webcams provided by ", a("windy.com", "https://www.windy.com/"));
    card.append(links, credit);
    return card;
  }
}
