// The docked details panel (#details in index.html), shared by every layer.
// Only one item is selected at a time: when a layer shows its details, the previous owner
// is told to drop its selection (highlight, path…).

interface Owner {
  /** Called when another owner takes the panel, or the user closes it. */
  onDetailsClosed(): void;
}

let owner: Owner | undefined;

function panel(): HTMLElement | null {
  return document.getElementById("details");
}

/** Show `content` in the panel on behalf of `who` (replacing any other owner's content). */
export function showDetails(who: Owner, content: HTMLElement): void {
  const el = panel();
  if (!el) return;
  if (owner && owner !== who) {
    const prev = owner;
    owner = undefined;
    prev.onDetailsClosed();
  }
  owner = who;
  const close = document.createElement("button");
  close.className = "close";
  close.title = "Close (Esc)";
  close.textContent = "×";
  close.addEventListener("click", () => closeDetails());
  el.replaceChildren(close, content);
  el.hidden = false;
}

/** Close the panel. With `who`, only if that owner currently holds it. */
export function closeDetails(who?: Owner): void {
  if (who && owner !== who) return;
  const el = panel();
  if (el) {
    el.hidden = true;
    el.replaceChildren();
  }
  const prev = owner;
  owner = undefined;
  prev?.onDetailsClosed();
}

/** Does `who` currently hold the panel? */
export function ownsDetails(who: Owner): boolean {
  return owner === who;
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && owner) closeDetails();
});

/** Build a card: bold title + label/value rows. Text only (no HTML from feed data). */
export function buildCard(title: string, rows: [string, string | HTMLElement][]): HTMLElement {
  const div = document.createElement("div");
  div.className = "card";
  const t = document.createElement("strong");
  t.textContent = title;
  div.append(t);
  const dl = document.createElement("dl");
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    if (typeof v === "string") dd.textContent = v;
    else dd.append(v);
    dl.append(dt, dd);
  }
  div.append(dl);
  return div;
}
