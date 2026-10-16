import "./style.css";
import { AircraftLayer } from "./layers/aircraft";
import { AntennaLayer } from "./layers/antenna";
import { DayNightLayer } from "./layers/daynight";
import { LoraLayer } from "./layers/lora";
import { QuakesLayer } from "./layers/quakes";
import { SatellitesLayer } from "./layers/satellites";
import { StreamsLayer } from "./layers/streams";
import { WebcamsLayer } from "./layers/webcams";
import { ShipsLayer } from "./layers/ships";
import { LayerRegistry } from "./layers/registry";
import { BASEMAPS, buildStyle, isDarkBasemap } from "./basemaps";
import { BASEMAP_ENABLED } from "./config";
import { addIcons, createMap } from "./map";
import { initialBasemap, initialLayerIds, saveLayerIds } from "./state";
import { buildBasemapPicker } from "./ui/basemap-picker";
import { buildSearch } from "./ui/search";
import { buildAbout, buildPanel, updateCredits } from "./ui/panel";

// Background map: from the URL / localStorage; "none" (plain) for the offline tests. If the
// chosen one can't be built (e.g. MapTiler without a key), fall back to Colour.
const basemapId = BASEMAP_ENABLED ? initialBasemap(BASEMAPS.map((b) => b.id)) : "none";
const style = await buildStyle(basemapId).catch(() => buildStyle("colour"));
const map = createMap(document.getElementById("map")!, style);

map.on("error", (e) => console.warn("map:", e.error?.message ?? e));

map.on("load", () => {
  addIcons(map, isDarkBasemap(basemapId));

  const registry = new LayerRegistry(map);
  registry.register(new DayNightLayer()); // first = drawn underneath everything else
  registry.register(new QuakesLayer());
  registry.register(new LoraLayer());
  registry.register(new SatellitesLayer());
  registry.register(new WebcamsLayer());
  registry.register(new StreamsLayer());
  registry.register(new ShipsLayer());
  const air = new AircraftLayer();
  registry.register(air);
  registry.register(new AntennaLayer(air));

  const panel = document.getElementById("panel")!;
  const credits = document.getElementById("credits")!;
  const openAbout = buildAbout(document.getElementById("about") as HTMLDialogElement, registry);

  for (const id of initialLayerIds([])) registry.setEnabled(id, true);
  buildPanel(panel, registry, openAbout);
  const layersList = panel.querySelector(".layers")!;
  layersList.before(buildSearch(map));
  if (BASEMAP_ENABLED) layersList.before(buildBasemapPicker(map, basemapId, () => updateCredits(credits, registry, openAbout)));

  const sync = () => {
    saveLayerIds(registry.enabledIds());
    updateCredits(credits, registry, openAbout);
  };
  registry.onChange = sync;
  sync();

  // Exposed for the automated browser test only (tools/smoke-test.cjs).
  if (import.meta.env.DEV) Object.assign(window, { __rhe: { map, registry } });
});
