import { HOSTED_RELAY, LOCAL_RELAY, relayUrl, setRelayUrl } from "../relay";

// "Relay:" selector: which rabbithole relay serves aircraft, ships and webcams.
// - Hosted: the relay this site was published with (only offered when there is one).
// - This computer: `npm run selfhost` (your own keys, no sharing with other visitors).
// - Custom: any other address, e.g. your own Cloudflare copy.
// A small line under it says whether the chosen relay answers.

export function buildRelayPicker(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "relay";
  const sel = document.createElement("select");
  sel.id = "relay-select";
  const options: [string, string][] = [];
  if (HOSTED_RELAY) options.push(["hosted", "Hosted (shared, nothing to set up)"]);
  options.push(["local", "This computer (npm run selfhost)"], ["custom", "Custom address…"]);
  for (const [value, text] of options) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = text;
    sel.append(o);
  }
  const input = document.createElement("input");
  input.type = "url";
  input.className = "url";
  input.id = "relay-url";
  input.placeholder = "https://rabbithole-relay.<you>.workers.dev";
  const note = document.createElement("div");
  note.className = "setting";

  const mode = (url: string) => (HOSTED_RELAY && url === HOSTED_RELAY ? "hosted" : url === LOCAL_RELAY ? "local" : "custom");
  const show = () => {
    const url = relayUrl();
    sel.value = mode(url);
    input.value = url;
    input.hidden = sel.value !== "custom";
  };

  let check = 0;
  const ping = async () => {
    const id = ++check;
    const url = relayUrl();
    note.textContent = `checking ${url}…`;
    const ok = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false);
    if (id !== check) return;
    note.textContent = ok
      ? `relay answering · ${url.replace(/^https?:\/\//, "")}`
      : sel.value === "local"
        ? "no relay on this computer: start it with npm run selfhost"
        : `relay not reachable at ${url}`;
    note.classList.toggle("error", !ok);
  };

  sel.addEventListener("change", () => {
    if (sel.value === "hosted") setRelayUrl(HOSTED_RELAY);
    else if (sel.value === "local") setRelayUrl(LOCAL_RELAY);
    input.hidden = sel.value !== "custom";
    if (sel.value === "custom") input.focus();
    else void ping();
  });
  const applyCustom = () => {
    if (setRelayUrl(input.value)) void ping();
    else note.textContent = "address must start with http:// or https://";
  };
  input.addEventListener("change", applyCustom);
  input.addEventListener("keydown", (e) => e.key === "Enter" && applyCustom());

  show();
  void ping();
  wrap.append("Relay: ", sel, input, note);
  return wrap;
}
