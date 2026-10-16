import { currentBasemapSources } from "../basemaps";
import { BASEMAP_ENABLED, FEED_MODE } from "../config";
import type { LayerRegistry } from "../layers/registry";
import { SOURCES } from "../sources";
import { loadString, saveString } from "../storage";

/** Small helper: create an element with optional class and text. */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const OPEN_KEY = "rhe.ui.open";
const FOLD_KEY = "rhe.ui.panel";

/**
 * Left-hand panel: title with a fold button, then (in the body) one row per layer with its
 * checkbox, a ▸/▾ button that shows or hides the layer's options, and its status line.
 * Which sections are open, and whether the whole panel is folded, is remembered.
 */
export function buildPanel(root: HTMLElement, registry: LayerRegistry, openAbout: () => void): void {
  root.replaceChildren();
  const open = new Set((loadString(OPEN_KEY) ?? "").split(",").filter(Boolean));
  const saveOpen = () => saveString(OPEN_KEY, [...open].join(","));

  const head = el("div", "panel-head");
  const title = el("h1", undefined, "rabbithole explorer");
  if (FEED_MODE === "fixtures") title.append(" ", el("span", "badge", "SAMPLES"));
  const fold = el("button", "fold");
  fold.id = "panel-fold";
  const body = el("div", "panel-body");
  body.id = "panel-body";
  const setFolded = (folded: boolean) => {
    body.hidden = folded;
    fold.textContent = folded ? "+" : "−";
    fold.title = folded ? "Show the panel" : "Fold the panel";
    saveString(FOLD_KEY, folded ? "folded" : "open");
  };
  fold.addEventListener("click", () => setFolded(!body.hidden));
  head.append(title, fold);
  root.append(head, body);
  setFolded(loadString(FOLD_KEY) === "folded");

  const list = el("ul", "layers");
  for (const layer of registry.layers) {
    const li = el("li");
    const row = el("div", "layer-row");
    const label = el("label");
    const box = el("input");
    box.type = "checkbox";
    box.dataset.layer = layer.id;
    box.checked = layer.isEnabled;
    box.addEventListener("change", () => registry.setEnabled(layer.id, box.checked));
    label.append(box, ` ${layer.label}`);
    row.append(label);
    const status = el("div", "status", layer.isEnabled ? "loading…" : "off");
    status.dataset.status = layer.id;
    layer.onStatus = (s) => {
      status.textContent = s.text;
      status.classList.toggle("error", s.error);
    };
    li.append(row);
    const settings = layer.renderSettings(() => registry.onChange());
    if (settings) {
      const toggle = el("button", "expand");
      toggle.dataset.expand = layer.id;
      const show = (on: boolean) => {
        settings.hidden = !on;
        toggle.textContent = on ? "▾" : "▸";
        toggle.title = on ? "Hide options" : "Show options";
        toggle.setAttribute("aria-expanded", String(on));
      };
      toggle.addEventListener("click", () => {
        const on = settings.hidden;
        if (on) open.add(layer.id);
        else open.delete(layer.id);
        saveOpen();
        show(on);
      });
      show(open.has(layer.id));
      row.append(toggle);
      li.append(settings);
    }
    li.append(status);
    list.append(li);
  }
  body.append(list);

  const about = el("button", "link", "About the data");
  about.addEventListener("click", openAbout);
  body.append(about);

  // Developer switch (only in `npm run dev`, never in the published site): read the real
  // feeds, or the saved sample files in public/fixtures/ used for offline testing.
  if (import.meta.env.DEV) {
    const dev = el("div", "dev");
    const sel = el("select");
    for (const [mode, text] of [["live", "live feeds"], ["fixtures", "saved samples"]]) {
      const o = el("option", undefined, text);
      o.value = mode;
      o.selected = mode === FEED_MODE;
      sel.append(o);
    }
    sel.addEventListener("change", () => {
      const url = new URL(window.location.href);
      url.searchParams.set("feeds", sel.value);
      window.location.replace(url.href);
    });
    dev.title = "Developer option: test with saved sample data instead of the live feeds";
    dev.append("dev · data: ", sel);
    body.append(dev);
  }
}

/** Always-visible credit line for the data layers that are on (basemap credit is MapLibre's). */
export function updateCredits(root: HTMLElement, registry: LayerRegistry, openAbout: () => void): void {
  const on = registry.layers.filter((l) => l.isEnabled);
  const link = el("button", "link", "About the data");
  link.addEventListener("click", openAbout);
  const parts: (string | Node)[] = on.length ? ["Data: "] : [];
  on.forEach((l, i) => parts.push(...(i ? [" · "] : []), ...l.creditNodes()));
  if (on.length) parts.push(" · ");
  root.replaceChildren(...parts, link);
}

/** "About the data" dialog: every source, its credit and terms, and whether it is in use. */
export function buildAbout(dialog: HTMLDialogElement, registry: LayerRegistry): () => void {
  const render = () => {
    dialog.replaceChildren();
    dialog.append(el("h2", undefined, "About the data"));
    dialog.append(
      el(
        "p",
        undefined,
        "Each layer is fetched directly by your browser from the sources below. No tracking, no accounts, no stored history. " +
          "Data from your own receiver (when added) never leaves your browser.",
      ),
    );
    const dl = el("dl");
    for (const s of SOURCES) {
      const dt = el("dt");
      const a = el("a", undefined, s.name);
      a.href = s.url;
      a.target = "_blank";
      a.rel = "noopener";
      const inUse = (BASEMAP_ENABLED && currentBasemapSources().includes(s.id)) || registry.layers.some((l) => l.isEnabled && l.sourceIds().includes(s.id));
      dt.append(a, " ", el("span", inUse ? "badge on" : "badge", inUse ? "in use" : s.planned ? "planned" : "off"));
      dl.append(dt, el("dd", undefined, `${s.credit}. ${s.terms}`));
    }
    dialog.append(dl);
    const close = el("button", undefined, "Close");
    close.addEventListener("click", () => dialog.close());
    dialog.append(close);
  };
  return () => {
    render();
    dialog.showModal();
  };
}
