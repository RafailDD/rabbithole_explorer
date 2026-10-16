import type { GeoJSONSource, GeoJSONSourceSpecification, Map as MlMap } from "maplibre-gl";

export type FeatureCollection = GeoJSON.FeatureCollection;

export const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

/** What the toggle panel shows under a layer's name. */
export interface LayerStatus {
  text: string;
  error: boolean;
}

/**
 * One data layer = one GeoJSON source + its MapLibre style layer(s) + one poll timer.
 *
 * Hardware view: the GeoJSON source is a buffer the GPU draws from; `setData()` swaps in a
 * new buffer. The poll loop is a timer-driven fetch; `AbortController` is the "cancel
 * transfer" bit for an in-flight request.
 *
 * Contract: while disabled (or while the tab is hidden) a layer has no timer and no
 * request in flight, so it makes zero network requests.
 */
export abstract class DataLayer {
  /** Short id, used in the URL (`?layers=quakes,air`) and in MapLibre ids. */
  abstract readonly id: string;
  abstract readonly label: string;
  /** Short credit shown in the attribution line while the layer is on. */
  abstract readonly credit: string;
  /** The credit as shown in the attribution line; override to add links. */
  creditNodes(): (string | Node)[] {
    return [this.credit];
  }
  /** Poll period in ms; 0 means fetch once when enabled. */
  protected abstract readonly pollMs: number;
  /** Extra options for the GeoJSON source, e.g. clustering. */
  protected readonly sourceOptions: Partial<GeoJSONSourceSpecification> = {};
  /** Period of frame() in ms (local animation, no network); 0 = no animation. */
  protected readonly frameMs: number = 0;
  /** Called every frameMs while enabled and visible, e.g. to move icons between polls. */
  protected frame(): void {}

  /** Fetch new data. Must pass `signal` to fetch() so disable() can cancel it. */
  protected abstract load(signal: AbortSignal): Promise<FeatureCollection>;
  /** Add the MapLibre style layer(s) that draw `this.sourceId`. Called once. */
  protected abstract addStyleLayers(map: MlMap): void;

  onStatus: (status: LayerStatus) => void = () => {};

  /** Ids (see src/sources.ts) of the data sources this layer currently uses. */
  sourceIds(): string[] {
    return [];
  }

  /** Optional controls shown under the layer's checkbox. Call `changed` after a change. */
  renderSettings(_changed: () => void): HTMLElement | null {
    return null;
  }

  /** Status text after a successful load. */
  protected describe(fc: FeatureCollection): string {
    return `${fc.features.length} shown`;
  }

  protected map!: MlMap;
  private enabled = false;
  private paused = false;
  private timer: number | undefined;
  private ctrl: AbortController | undefined;
  private lastLoad = 0;
  private frameTimer: number | undefined;

  get sourceId(): string {
    return `${this.id}-src`;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Create the (empty, hidden) source and style layers. No network traffic. */
  attach(map: MlMap): void {
    this.map = map;
    map.addSource(this.sourceId, { ...this.sourceOptions, type: "geojson", data: EMPTY });
    this.addStyleLayers(map);
    this.setVisible(false);
  }

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.setVisible(true);
    this.status("loading…");
    if (!this.paused) {
      this.tick();
      this.startFrames();
    }
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.stopPolling();
    this.stopFrames();
    this.setVisible(false);
    this.setData(EMPTY);
    this.lastLoad = 0;
    this.status("off");
  }

  /** Tab hidden: stop the timer and cancel any request, keep what is drawn. */
  pause(): void {
    this.paused = true;
    this.stopPolling();
    this.stopFrames();
  }

  /** Tab visible again: refresh now if the data is stale, then resume the timer. */
  resume(): void {
    this.paused = false;
    if (!this.enabled) return;
    this.startFrames();
    const age = Date.now() - this.lastLoad;
    if (this.lastLoad === 0 || (this.pollMs > 0 && age >= this.pollMs)) this.tick();
    else if (this.pollMs > 0) this.schedule(this.pollMs - age);
  }

  /** Re-fetch after `delayMs` instead of waiting for the next poll (e.g. the map moved). */
  refreshSoon(delayMs: number): void {
    if (this.enabled && !this.paused) this.schedule(delayMs);
  }

  protected setData(fc: FeatureCollection): void {
    (this.map.getSource(this.sourceId) as GeoJSONSource | undefined)?.setData(fc);
  }

  protected status(text: string, error = false): void {
    this.onStatus({ text, error });
  }

  /** Style layers drawing any of this layer's sources (all named `<id>-…`). */
  private styleLayerIds(): string[] {
    const prefix = `${this.id}-`;
    return (this.map.getStyle().layers ?? [])
      .filter((l) => "source" in l && typeof l.source === "string" && l.source.startsWith(prefix))
      .map((l) => l.id);
  }

  private startFrames(): void {
    if (this.frameMs > 0 && this.frameTimer === undefined) {
      this.frameTimer = window.setInterval(() => this.frame(), this.frameMs);
    }
  }

  private stopFrames(): void {
    window.clearInterval(this.frameTimer);
    this.frameTimer = undefined;
  }

  private setVisible(on: boolean): void {
    for (const id of this.styleLayerIds()) this.map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
  }

  private stopPolling(): void {
    window.clearTimeout(this.timer);
    this.timer = undefined;
    this.ctrl?.abort();
    this.ctrl = undefined;
  }

  private schedule(delayMs: number): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.tick(), delayMs);
  }

  /** One poll cycle: fetch, draw, then arm the timer for the next one (never overlapping). */
  private async tick(): Promise<void> {
    this.timer = undefined;
    this.ctrl?.abort();
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    try {
      const fc = await this.load(ctrl.signal);
      if (ctrl.signal.aborted) return;
      this.setData(fc);
      this.lastLoad = Date.now();
      this.status(`${this.describe(fc)} · ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      if (ctrl.signal.aborted) return; // cancelled by disable()/pause(): not an error
      this.status(`error: ${err instanceof Error ? err.message : String(err)}`, true);
    }
    if (this.ctrl === ctrl) this.ctrl = undefined;
    // A refreshSoon() during the request already armed the timer: keep it.
    if (this.enabled && !this.paused && this.pollMs > 0 && this.timer === undefined) this.schedule(this.pollMs);
  }
}

/** An HTTP error with enough detail to tell who answered. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    /**
     * Who answered, from the x-rhe-relay header set by our relay (worker/):
     * "relay" = the relay itself failed, "feed" = relayed from the feed, "" = no relay involved.
     */
    readonly via: "relay" | "feed" | "",
  ) {
    super(`HTTP ${status}${body ? `: ${body}` : ""}`);
  }
}

/** fetch() + JSON parse, throwing HttpError on HTTP errors. */
export async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, cache: "no-store" });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 120);
    const via = res.headers.get("x-rhe-relay") === "error" ? "relay" : res.headers.has("x-rhe-relay") ? "feed" : "";
    throw new HttpError(res.status, body, via);
  }
  return (await res.json()) as T;
}
