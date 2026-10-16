import { loadString, saveString } from "./storage";

// Address of the rabbithole relay (worker/), shared by every layer that needs one (aircraft,
// ships, webcams). Two ways to run the app:
// - hosted: the published site uses the relay it was built with (VITE_RELAY_URL);
// - self-hosted: `npm run selfhost` runs the relay on this computer (localhost:8787) with
//   your own keys.
// Chosen in the panel ("Relay:"), remembered in this browser.

const KEY = "rhe.relay.url";
/** The relay this build was made for (empty in a plain local build). */
export const HOSTED_RELAY = ((import.meta.env.VITE_RELAY_URL as string | undefined) || "").replace(/\/+$/, "");
export const LOCAL_RELAY = "http://localhost:8787";

const listeners: (() => void)[] = [];

export function relayUrl(): string {
  return loadString(KEY) || HOSTED_RELAY || LOCAL_RELAY;
}

/** Store a new address and tell the layers; returns false if it isn't an http(s) URL. */
export function setRelayUrl(v: string): boolean {
  const url = v.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+/.test(url)) return false;
  if (url === relayUrl()) return true;
  saveString(KEY, url);
  for (const fn of listeners) fn();
  return true;
}

/** Called after the relay address changes (layers reconnect / refetch). */
export function onRelayChange(fn: () => void): void {
  listeners.push(fn);
}
