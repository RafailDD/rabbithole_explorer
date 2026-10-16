import type { Map as MlMap } from "maplibre-gl";
import type { DataLayer } from "./base";

/**
 * Holds every layer and switches them on/off. Also pauses all layers while the browser
 * tab is hidden, so a background tab makes no requests.
 */
export class LayerRegistry {
  readonly layers: DataLayer[] = [];
  onChange: () => void = () => {};

  constructor(private readonly map: MlMap) {
    document.addEventListener("visibilitychange", () => {
      const hidden = document.visibilityState === "hidden";
      for (const layer of this.layers) {
        if (hidden) layer.pause();
        else layer.resume();
      }
    });
  }

  register(layer: DataLayer): void {
    layer.attach(this.map);
    if (document.visibilityState === "hidden") layer.pause();
    this.layers.push(layer);
  }

  get(id: string): DataLayer | undefined {
    return this.layers.find((l) => l.id === id);
  }

  setEnabled(id: string, on: boolean): void {
    const layer = this.get(id);
    if (!layer || layer.isEnabled === on) return;
    if (on) layer.enable();
    else layer.disable();
    this.onChange();
  }

  enabledIds(): string[] {
    return this.layers.filter((l) => l.isEnabled).map((l) => l.id);
  }
}
