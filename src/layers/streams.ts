import { Popup, type Map as MlMap, type MapLayerMouseEvent } from "maplibre-gl";
import { buildCard, closeDetails, showDetails } from "../ui/details";
import { DataLayer, fetchJson, type FeatureCollection } from "./base";

// Hand-picked live video webcams on YouTube (public/data/live-streams.json, checked with
// `npm run streams`). Nothing is loaded from YouTube until a stream is clicked; the player
// then uses YouTube's privacy-enhanced domain (youtube-nocookie.com) and starts muted.

interface Stream {
  video: string;
  title: string;
  place: string;
  lat: number;
  lon: number;
  channel: string;
  kind: string;
  /** false: the owner disallows embedding, so the card only links to YouTube. */
  embed?: boolean;
}

function a(text: string, href: string): HTMLAnchorElement {
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = text;
  return link;
}

export class StreamsLayer extends DataLayer {
  readonly id = "streams";
  readonly label = "Live video (YouTube)";
  readonly credit = "Live video: YouTube channels";
  protected readonly pollMs = 0; // a fixed list, loaded once

  private streams: Stream[] = [];
  private selected: string | undefined;
  private tip: Popup | undefined;

  sourceIds(): string[] {
    return ["youtube"];
  }

  disable(): void {
    closeDetails(this);
    super.disable();
  }

  onDetailsClosed(): void {
    this.selected = undefined;
    if (this.isEnabled) this.setData(this.render());
  }

  protected describe(): string {
    return `${this.streams.length} hand-picked live webcams · nothing loads until you click one`;
  }

  protected async load(signal: AbortSignal): Promise<FeatureCollection> {
    const data = await fetchJson<{ streams: Stream[] }>(new URL("data/live-streams.json", document.baseURI).href, signal);
    this.streams = data.streams;
    return this.render();
  }

  private render(): FeatureCollection {
    return {
      type: "FeatureCollection",
      features: this.streams.map((s) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [s.lon, s.lat] },
        properties: { video: s.video, sel: s.video === this.selected },
      })),
    };
  }

  protected addStyleLayers(map: MlMap): void {
    const icons = `${this.id}-icons`;
    map.addLayer({
      id: icons,
      type: "symbol",
      source: this.sourceId,
      layout: {
        "icon-image": ["case", ["get", "sel"], "play-selected", "play"],
        "icon-size": ["interpolate", ["linear"], ["zoom"], 2, 0.8, 8, 1.1],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    });
    map.on("click", icons, (e: MapLayerMouseEvent) => {
      const s = this.streams.find((x) => x.video === e.features?.[0]?.properties?.video);
      if (!s) return;
      this.selected = s.video;
      showDetails(this, this.card(s));
      this.setData(this.render());
    });
    map.on("click", (e) => {
      if (this.selected !== undefined && map.queryRenderedFeatures(e.point, { layers: [icons] }).length === 0) closeDetails(this);
    });
    map.on("mousemove", icons, (e: MapLayerMouseEvent) => {
      map.getCanvas().style.cursor = "pointer";
      const s = this.streams.find((x) => x.video === e.features?.[0]?.properties?.video);
      if (!s) return;
      this.tip ??= new Popup({ closeButton: false, closeOnClick: false, className: "hover-tip", offset: 12 });
      this.tip.setLngLat(e.lngLat).setText(`▶ ${s.title}`).addTo(map);
    });
    map.on("mouseleave", icons, () => {
      map.getCanvas().style.cursor = "";
      this.tip?.remove();
    });
  }

  private card(s: Stream): HTMLElement {
    const watch = `https://www.youtube.com/watch?v=${encodeURIComponent(s.video)}`;
    const card = buildCard(s.title, [
      ["Place", s.place],
      ["Channel", s.channel],
    ]);
    card.classList.add("media-card");
    if (s.embed !== false) {
      const frame = document.createElement("iframe");
      frame.className = "media";
      frame.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(s.video)}?autoplay=1&mute=1&playsinline=1&rel=0`;
      frame.title = s.title;
      frame.allow = "autoplay; fullscreen; picture-in-picture";
      frame.referrerPolicy = "strict-origin-when-cross-origin";
      card.insertBefore(frame, card.querySelector("dl"));
    }
    const links = document.createElement("p");
    links.className = "links";
    links.append(a(s.embed === false ? "▶ Watch on YouTube (owner allows no embedding)" : "Open on YouTube", watch));
    const note = document.createElement("p");
    note.className = "small";
    note.textContent = "Live streams can stop or move; video from YouTube (privacy-enhanced mode).";
    card.append(links, note);
    return card;
  }
}
