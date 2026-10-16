import { loadString, saveString } from "./storage";

// Address of our Cloudflare Worker relay (worker/), shared by every layer that needs it
// (ships, webcams). Set in the Ships or Webcams options; remembered in this browser.

const KEY = "rhe.relay.url";
const DEFAULT = (import.meta.env.VITE_RELAY_URL as string | undefined) || "http://localhost:8787";

export function relayUrl(): string {
  return loadString(KEY) || DEFAULT;
}

/** Store a new address; returns false if it isn't an http(s) URL. */
export function setRelayUrl(v: string): boolean {
  const url = v.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) return false;
  saveString(KEY, url);
  return true;
}
