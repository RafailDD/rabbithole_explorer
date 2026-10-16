import type { Map as MlMap } from "maplibre-gl";
import { BASEMAPS, maptilerKey, OVERLAYS, overlays, setMaptilerKey, setOverlays, switchBasemap } from "../basemaps";
import { addIcons } from "../map";
import { saveBasemap } from "../state";

/** "Map:" selector at the top of the panel, with labels toggle and the MapTiler key field. */
export function buildBasemapPicker(map: MlMap, currentId: string, changed: () => void): HTMLElement {
  let current = currentId;
  const wrap = document.createElement("div");
  wrap.className = "basemap";

  const sel = document.createElement("select");
  sel.id = "basemap-select";
  for (const b of BASEMAPS) {
    const o = document.createElement("option");
    o.value = b.id;
    o.textContent = b.label;
    o.selected = b.id === current;
    sel.append(o);
  }

  const extra = document.createElement("div");
  extra.className = "setting";

  // Over satellite imagery: place names, road names, borders, each on or off.
  const labels = document.createElement("div");
  for (const [id, text] of OVERLAYS) {
    const l = document.createElement("label");
    l.className = "group";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.id = `overlay-${id}`;
    box.checked = overlays().has(id);
    box.addEventListener("change", () => {
      const set = overlays();
      if (box.checked) set.add(id);
      else set.delete(id);
      setOverlays(set);
      void apply(sel.value);
    });
    l.append(box, ` ${text}`);
    labels.append(l);
  }

  const keyRow = document.createElement("div");
  const keyInput = document.createElement("input");
  keyInput.type = "password";
  keyInput.className = "url";
  keyInput.placeholder = "paste your MapTiler key";
  keyInput.id = "maptiler-key";
  const link = document.createElement("a");
  link.href = "https://cloud.maptiler.com/account/keys/";
  link.target = "_blank";
  link.rel = "noopener";
  link.textContent = "get a free key";
  const keyNote = document.createElement("div");
  keyNote.textContent = "Kept only in this browser; sent only to MapTiler.";
  keyRow.append(keyInput, link, " · ", keyNote);

  const status = document.createElement("div");
  status.className = "status";
  // Shown when zoomed in past what the chosen imagery can resolve.
  const blurNote = document.createElement("div");
  blurNote.className = "status";
  blurNote.id = "basemap-blur";
  const updateBlur = () => {
    const b = BASEMAPS.find((x) => x.id === current);
    const s = b?.sharpUntil;
    blurNote.textContent =
      s && map.getZoom() > s.zoom + 0.5
        ? `This imagery is ~${s.res} per pixel: zooming further only blurs it.${b?.id === "today" ? " It's for region-scale views (clouds, smoke)." : ""} For street level, use Satellite HD.`
        : "";
  };
  map.on("zoomend", updateBlur);

  const render = () => {
    keyInput.placeholder = maptilerKey() ? "key saved: paste a new one to replace" : "paste your MapTiler key";
    const b = BASEMAPS.find((x) => x.id === sel.value);
    extra.replaceChildren();
    if (b?.imagery) extra.append(labels);
    if (b?.needsKey) extra.append(keyRow);
  };

  const apply = async (id: string) => {
    status.textContent = "";
    status.classList.remove("error");
    const b = BASEMAPS.find((x) => x.id === id);
    if (b?.needsKey && !maptilerKey()) {
      status.textContent = "needs a MapTiler key (free): paste it above";
      status.classList.add("error");
      return;
    }
    try {
      await switchBasemap(map, id, addIcons);
      current = id;
      saveBasemap(id);
      updateBlur();
      changed();
    } catch (err) {
      status.textContent = `couldn't load this map: ${err instanceof Error ? err.message : String(err)}`;
      status.classList.add("error");
      sel.value = current;
      render();
    }
  };

  sel.addEventListener("change", () => {
    render();
    void apply(sel.value);
  });
  keyInput.addEventListener("change", () => {
    setMaptilerKey(keyInput.value);
    keyInput.value = "";
    render();
    void apply(sel.value);
  });

  const row = document.createElement("label");
  row.append("Map: ", sel);
  wrap.append(row, extra, status, blurNote);
  render();
  updateBlur();
  return wrap;
}
