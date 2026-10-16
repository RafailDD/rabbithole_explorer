import type { Connect, Plugin } from "vite";

// Aircraft APIs send no CORS header, so the browser may not read them directly. While
// running locally, the Vite dev server fetches them for the page instead: the page asks
// /proxy/<feed>/<path> on its own origin, and this middleware relays it upstream.
// (Hosted builds will use a Cloudflare Worker for the same job; see CLAUDE.md.)
// Only the point-query paths below are relayed, so this is not an open proxy.

const FEEDS: Record<string, { base: string; path: RegExp }> = {
  adsblol: { base: "https://api.adsb.lol", path: /^\/v2\/(lat\/-?[\d.]+\/lon\/-?[\d.]+\/dist\/\d+|hex\/[0-9a-f]{6})$/ },
  // Full path of one aircraft for today (what adsb.lol's own map loads on click). Not part of
  // the documented API; fetched only for the aircraft the user clicks.
  adsbloltrace: { base: "https://adsb.lol/data/traces", path: /^\/[0-9a-f]{2}\/trace_full_[0-9a-f]{6}\.json$/ },
  adsbfi: { base: "https://opendata.adsb.fi", path: /^\/api\/(v3\/lat\/-?[\d.]+\/lon\/-?[\d.]+\/dist\/\d+|v2\/hex\/[0-9a-f]{6})$/ },
};

// adsb.lol rejects generic User-Agents and asks for contact info.
const USER_AGENT = "rabbithole_explorer/0.1 (+https://github.com/RafailDD/rabbithole_explorer; non-commercial hobby map)";

const handler: Connect.NextHandleFunction = async (req, res) => {
  const m = /^\/([a-z]+)(\/[^?]*)$/.exec(req.url ?? "");
  const feed = m ? FEEDS[m[1]] : undefined;
  // x-rhe-relay tells the page who answered: "error" = this relay failed, "feed" = relayed.
  if (!m || !feed || req.method !== "GET" || !feed.path.test(m[2])) {
    res.setHeader("x-rhe-relay", "error");
    res.statusCode = 404;
    res.end("unknown feed or path");
    return;
  }
  try {
    const upstream = await fetch(feed.base + m[2], {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    res.statusCode = upstream.status;
    res.setHeader("x-rhe-relay", "feed");
    res.setHeader("content-type", upstream.headers.get("content-type") ?? "application/json");
    res.setHeader("cache-control", "no-store");
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    res.setHeader("x-rhe-relay", "error");
    res.statusCode = 502;
    res.end(`upstream error: ${err instanceof Error ? err.message : String(err)}`);
  }
};

export function feedProxy(): Plugin {
  return {
    name: "feed-proxy",
    configureServer(server) {
      server.middlewares.use("/proxy", handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/proxy", handler);
    },
  };
}
