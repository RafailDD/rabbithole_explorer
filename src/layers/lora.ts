import { Popup, type GeoJSONSource, type GeoJSONSourceSpecification, type Map as MlMap, type MapLayerMouseEvent } from "maplibre-gl";
import { loadString, saveString } from "../storage";
import { buildCard, closeDetails, showDetails } from "../ui/details";
import { DataLayer, fetchJson, type FeatureCollection } from "./base";

// LoRaWAN gateways of The Things Network and the networks peering with it, from a static
// snapshot made by tools/fetch-gateways.mjs (Packet Broker asks users to cache: the app never
// calls their API). Drawn as clusters that split as you zoom in.
//
// "Online" is Packet Broker's own flag (about 3,000 worldwide). Many more gateways update
// their record every hour without that flag; they're shown in grey as "seen this week".

interface Snapshot {
  generated: string;
  nets: string[];
  rows: [number, number, number, number, number, number, number][];
}

const OFFLINE_KEY = "rhe.lora.offline";
const PLACEMENT = ["unknown", "indoor", "outdoor"];
const ONLINE = "#2f9e44";
const OTHER = "#868e96";

export class LoraLayer extends DataLayer {
  readonly id = "lora";
  readonly label = "LoRa gateways (TTN & peers)";
  readonly credit = "LoRa gateways: Packet Broker / The Things Network";
  protected readonly pollMs = 0; // static snapshot: load once
  protected readonly sourceOptions: Partial<GeoJSONSourceSpecification> = {
    cluster: true,
    clusterRadius: 40,
    clusterMaxZoom: 12,
    // Per cluster: how many of its gateways are online (for the colour and the tooltip).
    clusterProperties: { online: ["+", ["case", ["get", "online"], 1, 0]] },
  };

  private all: GeoJSON.Feature[] = [];
  private generated = "";
  private showOffline = loadString(OFFLINE_KEY) !== "off";
  private selected: GeoJSON.Feature | undefined;
  private tip: Popup | undefined;

  sourceIds(): string[] {
    return ["packetbroker"];
  }

  disable(): void {
    closeDetails(this);
    this.all = [];
    super.disable();
  }

  renderSettings(changed: () => void): HTMLElement | null {
    const wrap = document.createElement("div");
    wrap.className = "setting";
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = "lora-offline";
    box.checked = this.showOffline;
    box.addEventListener("change", () => {
      this.showOffline = box.checked;
      saveString(OFFLINE_KEY, box.checked ? "on" : "off");
      closeDetails(this);
      if (this.isEnabled && this.all.length) {
        const fc = this.visible();
        this.setData(fc);
        this.status(this.describe(fc));
      }
      changed();
    });
    label.append(box, " include gateways not online now");
    const legend = document.createElement("div");
    legend.className = "legend";
    for (const [color, text] of [[ONLINE, "online now"], [OTHER, "seen this week"]]) {
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.style.background = color;
      legend.append(dot, ` ${text} `);
    }
    wrap.append(label, legend);
    return wrap;
  }

  protected describe(fc: FeatureCollection): string {
    const online = fc.features.filter((f) => f.properties?.online).length;
    const when = this.generated ? ` · snapshot ${new Date(this.generated).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}` : "";
    return `${fc.features.length.toLocaleString("en")} gateways (${online.toLocaleString("en")} online)${when}`;
  }

  private visible(): FeatureCollection {
    return { type: "FeatureCollection", features: this.showOffline ? this.all : this.all.filter((f) => f.properties?.online) };
  }

  protected async load(signal: AbortSignal): Promise<FeatureCollection> {
    let snap: Snapshot;
    try {
      snap = await fetchJson<Snapshot>(new URL("data/lora-gateways.json", document.baseURI).href, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      throw new Error("no gateway snapshot: run  node tools/fetch-gateways.mjs");
    }
    this.generated = snap.generated;
    this.all = snap.rows.map(([lon, lat, online, net, placement, antennas, ageH]) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: { online: online === 1, net: snap.nets[net] ?? "?", placement: PLACEMENT[placement] ?? "unknown", antennas, ageH },
    }));
    return this.visible();
  }

  onDetailsClosed(): void {
    this.selected = undefined;
    (this.map.getSource(`${this.id}-sel-src`) as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: [] });
  }

  protected addStyleLayers(map: MlMap): void {
    map.addSource(`${this.id}-sel-src`, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    // Clusters: size by count, colour from grey (none online) to green (all online).
    map.addLayer({
      id: `${this.id}-clusters`,
      type: "circle",
      source: this.sourceId,
      filter: ["has", "point_count"],
      paint: {
        "circle-radius": ["step", ["get", "point_count"], 12, 10, 15, 100, 19, 1000, 24],
        "circle-color": ["interpolate", ["linear"], ["/", ["get", "online"], ["get", "point_count"]], 0, OTHER, 0.5, ONLINE],
        "circle-opacity": 0.8,
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.5,
      },
    });
    map.addLayer({
      id: `${this.id}-counts`,
      type: "symbol",
      source: this.sourceId,
      filter: ["has", "point_count"],
      layout: {
        "text-field": ["get", "point_count_abbreviated"],
        "text-font": ["Noto Sans Bold"],
        "text-size": 11,
        "text-allow-overlap": true,
      },
      paint: { "text-color": "#ffffff" },
    });
    const pointId = `${this.id}-points`;
    map.addLayer({
      id: pointId,
      type: "circle",
      source: this.sourceId,
      filter: ["!", ["has", "point_count"]],
      paint: {
        "circle-radius": 5,
        "circle-color": ["case", ["get", "online"], ONLINE, OTHER],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.5,
      },
    });
    map.addLayer({
      id: `${this.id}-selected`,
      type: "circle",
      source: `${this.id}-sel-src`,
      paint: { "circle-radius": 8, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": "#1d2329", "circle-stroke-width": 2.5 },
    });

    // Click a cluster: zoom in until it splits. Click a gateway: details.
    map.on("click", `${this.id}-clusters`, async (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f || f.geometry.type !== "Point") return;
      const zoom = await (map.getSource(this.sourceId) as GeoJSONSource).getClusterExpansionZoom(Number(f.properties?.cluster_id));
      // At least one full zoom level, so the click always visibly does something.
      map.easeTo({ center: f.geometry.coordinates as [number, number], zoom: Math.min(Math.max(zoom, map.getZoom() + 1), 16) });
    });
    map.on("click", pointId, (e: MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f || f.geometry.type !== "Point") return;
      this.selected = { type: "Feature", geometry: f.geometry, properties: f.properties };
      (map.getSource(`${this.id}-sel-src`) as GeoJSONSource).setData({ type: "FeatureCollection", features: [this.selected] });
      showDetails(this, this.card(f.properties ?? {}));
    });
    map.on("click", (e) => {
      if (this.selected && map.queryRenderedFeatures(e.point, { layers: [pointId] }).length === 0) closeDetails(this);
    });

    for (const layer of [`${this.id}-clusters`, pointId]) {
      map.on("mousemove", layer, (e: MapLayerMouseEvent) => {
        map.getCanvas().style.cursor = "pointer";
        const p = e.features?.[0]?.properties;
        if (!p) return;
        const text = p.point_count
          ? `${Number(p.point_count).toLocaleString("en")} gateways (${p.online} online) · click to zoom`
          : `${p.net} · ${p.online ? "online" : "seen this week"}`;
        this.tip ??= new Popup({ closeButton: false, closeOnClick: false, className: "hover-tip", offset: 12 });
        this.tip.setLngLat(e.lngLat).setText(text).addTo(map);
      });
      map.on("mouseleave", layer, () => {
        map.getCanvas().style.cursor = "";
        this.tip?.remove();
      });
    }
  }

  private card(p: Record<string, unknown>): HTMLElement {
    const ageH = Number(p.ageH);
    const rows: [string, string][] = [
      ["Network", String(p.net) === "ttn" ? "The Things Network" : String(p.net)],
      ["Status", p.online ? "online (Packet Broker)" : "not online now; record updated this week"],
      ["Updated", ageH < 1 ? "in the hour before the snapshot" : `${ageH} h before the snapshot`],
      ["Antenna", `${PLACEMENT.includes(String(p.placement)) ? String(p.placement) : "unknown"}${Number(p.antennas) > 1 ? `, ${p.antennas} antennas` : ""}`],
      ["Position", "rounded to ~100 m (many gateways are in homes)"],
      ["Snapshot", this.generated ? new Date(this.generated).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—"],
      ["Source", "Packet Broker Mapper"],
    ];
    return buildCard("LoRaWAN gateway", rows);
  }
}
