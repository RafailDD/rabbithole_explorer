import { loadString, saveString } from "./storage";

/** Initial view: Western Europe and the Mediterranean (each browser then remembers its own view). */
export const HOME = { lng: 10, lat: 47, zoom: 4 };


/**
 * Where layers get their data.
 * - "live": the real public APIs.
 * - "fixtures": saved sample files under public/fixtures/ (offline, repeatable).
 * Set with `?feeds=fixtures` / `?feeds=live` (remembered in localStorage).
 */
export type FeedMode = "live" | "fixtures";

const params = new URLSearchParams(window.location.search);

function readFeedMode(): FeedMode {
  const fromUrl = params.get("feeds");
  if (fromUrl === "live" || fromUrl === "fixtures") {
    saveString("rhe.feeds", fromUrl);
    return fromUrl;
  }
  return loadString("rhe.feeds") === "fixtures" ? "fixtures" : "live";
}

export const FEED_MODE: FeedMode = readFeedMode();

/**
 * `?basemap=none` replaces the OpenFreeMap basemap with a plain background. Used by the
 * sandbox tests (no internet there) and handy to tell basemap cost from layer cost.
 */
export const BASEMAP_ENABLED = params.get("basemap") !== "none";

/** URL of a fixture file, relative to the page so it also works under a sub-path. */
export function fixtureUrl(name: string): string {
  return new URL(`fixtures/${name}`, document.baseURI).href;
}
