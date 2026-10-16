// rabbithole relay: a Cloudflare Worker between the browser and AISStream.
//
// AISStream (live AIS ship positions) forbids browser connections and needs a secret key, so
// the browser talks to this Worker instead:
//
//   browser ──WebSocket /ships, sends its view box──► Worker ──► ShipsRelay (Durable Object)
//                                                                 │ one AISStream connection with
//   browser ◄── ships in its box, every 2 s ───────────────────── │ every viewer's box; closed
//                                                                 ▼ when nobody is watching
//
// A Durable Object is a single long-lived instance with memory: like one shared peripheral
// that every request is routed to. Nothing is stored on disk; ships are kept in memory for
// 30 minutes at most (no history), and no viewer data is logged.

export interface Env {
  SHIPS: DurableObjectNamespace;
  AISSTREAM_KEY: string;
  WINDY_KEY: string;
  /** Biggest view (degrees) the ships relay accepts; bigger views get "zoom in". */
  SHIPS_MAX_SPAN_DEG?: string;
  /** How long a webcam tile is kept, in seconds. */
  WEBCAM_CACHE_S?: string;
  /** Tests only: send every HTTPS upstream request through this forwarder as <proxy>/<host>/<path>. */
  UPSTREAM_PROXY?: string;
  ALLOWED_ORIGINS: string;
  /** Override for tests: a fake upstream (ws:// or http://). */
  AISSTREAM_URL?: string;
}

const UPSTREAM = "https://stream.aisstream.io/v0/stream";
const FLUSH_MS = 2000; // send updates to viewers every 2 s
const STALE_MS = 30 * 60 * 1000; // forget ships not heard for 30 min
const DEFAULT_MAX_SPAN_DEG = 20; // biggest view box we relay by default (zoom in for more)
const MAX_VIEWERS = 50;
// Name of the single relay instance. Changing it starts a fresh instance on the next deploy
// (an old instance can keep running old code, and its AISStream connection, for a while).
const INSTANCE = "ships-v2";

function allowed(origin: string | null, env: Env): boolean {
  if (!origin) return false;
  return env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).includes(origin);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const origin = req.headers.get("origin");
    if (url.pathname === "/health") {
      return new Response("ok", { headers: allowed(origin, env) ? { "access-control-allow-origin": origin! } : {} });
    }
    const air = url.pathname.match(/^\/air\/([a-z]+)(\/.*)$/);
    if (air) {
      if (!allowed(origin, env)) return new Response("origin not allowed", { status: 403 });
      return airProxy(air[1], air[2], env, origin!);
    }
    const tile = url.pathname.match(/^\/webcams\/tile\/(\d+)\/(\d+)\/(\d+)$/);
    if (tile) {
      if (!allowed(origin, env)) return new Response("origin not allowed", { status: 403 });
      return webcamTile(Number(tile[1]), Number(tile[2]), Number(tile[3]), env, origin!);
    }
    if (url.pathname === "/status") {
      // Diagnostics for the owner, readable in a browser: counters only, no ship or viewer data.
      return env.SHIPS.get(env.SHIPS.idFromName(INSTANCE)).fetch(req);
    }
    if (url.pathname === "/ships") {
      // Only our own pages may use this relay (protects the free quota and the key's limits).
      if (!allowed(origin, env)) return new Response("origin not allowed", { status: 403 });
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a WebSocket", { status: 426 });
      return env.SHIPS.get(env.SHIPS.idFromName(INSTANCE)).fetch(req);
    }
    return new Response("rabbithole relay: /air/<feed>/<path>, /ships (WebSocket), /webcams/tile/z/x/y, /health, /status", { status: 404 });
  },
};

/** fetch() for HTTPS upstreams, through the test forwarder when UPSTREAM_PROXY is set. */
function upstream(url: string, env: Env, init?: RequestInit): Promise<Response> {
  if (!env.UPSTREAM_PROXY) return fetch(url, init);
  const u = new URL(url);
  return fetch(`${env.UPSTREAM_PROXY}/${u.host}${u.pathname}${u.search}`, init);
}

// ---- Aircraft (adsb.lol, adsb.fi) ----
//
// These APIs send no CORS header, so browsers may not read them directly: we fetch them for the
// page. Only the point-query, single-aircraft and trace paths below are relayed (not an open
// proxy). Identical requests within 2 s share one upstream fetch (several viewers looking at the
// same area). x-rhe-relay tells the page who answered: "error" = this relay, "feed" = upstream.

const AIR_FEEDS: Record<string, { base: string; path: RegExp; ttlMs: number }> = {
  adsblol: { base: "https://api.adsb.lol", path: /^\/v2\/(lat\/-?[\d.]+\/lon\/-?[\d.]+\/dist\/\d+|hex\/[0-9a-f]{6})$/, ttlMs: 2000 },
  // Today's full path of one aircraft (what adsb.lol's own map loads on click); undocumented.
  adsbloltrace: { base: "https://adsb.lol/data/traces", path: /^\/[0-9a-f]{2}\/trace_full_[0-9a-f]{6}\.json$/, ttlMs: 30000 },
  adsbfi: { base: "https://opendata.adsb.fi", path: /^\/api\/(v3\/lat\/-?[\d.]+\/lon\/-?[\d.]+\/dist\/\d+|v2\/hex\/[0-9a-f]{6})$/, ttlMs: 2000 },
};
// adsb.lol rejects generic User-Agents and asks for contact info.
const USER_AGENT = "rabbithole_explorer/0.1 (+https://github.com/RafailDD/rabbithole_explorer; non-commercial hobby map)";
const airCache = new Map<string, { at: number; status: number; type: string; body: ArrayBuffer }>();

async function airProxy(feedId: string, path: string, env: Env, origin: string): Promise<Response> {
  const cors = { "access-control-allow-origin": origin, "access-control-expose-headers": "x-rhe-relay", vary: "origin", "cache-control": "no-store" };
  const feed = AIR_FEEDS[feedId];
  if (!feed || !feed.path.test(path)) return new Response("unknown feed or path", { status: 404, headers: { ...cors, "x-rhe-relay": "error" } });
  const key = feedId + path;
  const hit = airCache.get(key);
  if (hit && Date.now() - hit.at < feed.ttlMs) {
    return new Response(hit.body, { status: hit.status, headers: { ...cors, "x-rhe-relay": "feed", "content-type": hit.type } });
  }
  try {
    const res = await upstream(feed.base + path, env, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.arrayBuffer();
    const type = res.headers.get("content-type") ?? "application/json";
    if (airCache.size > 2000) airCache.clear(); // bounded memory
    if (res.ok || res.status === 404) airCache.set(key, { at: Date.now(), status: res.status, type, body });
    return new Response(body, { status: res.status, headers: { ...cors, "x-rhe-relay": "feed", "content-type": type } });
  } catch (err) {
    return new Response(`upstream error: ${err instanceof Error ? err.message : String(err)}`, { status: 502, headers: { ...cors, "x-rhe-relay": "error" } });
  }
}

// ---- Webcams (Windy Webcams API, free plan) ----
//
// The page asks for one map tile at a time; we ask Windy's map/clusters endpoint for exactly
// that tile (it accepts at most one tile's height per zoom level) and keep the answer for
// 10 minutes, so panning back and forth and other viewers cost no extra Windy requests.
// Windy's terms: key kept secret, only our own pages served (origin check above), image and
// player URLs passed on unchanged, no bulk scanning (tiles only for what someone looks at).

const tileCache = new Map<string, { at: number; body: string }>();

function tileBounds(z: number, x: number, y: number): { n: number; s: number; e: number; w: number } {
  const n2 = 2 ** z;
  const lat = (yy: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n2))) * 180) / Math.PI;
  return { w: (x / n2) * 360 - 180, e: ((x + 1) / n2) * 360 - 180, n: lat(y), s: lat(y + 1) };
}

interface WindyCam {
  webcamId: number;
  title: string;
  status: string;
  lastUpdatedOn?: string;
  clusterSize?: number;
  location?: { city?: string; region?: string; country?: string; latitude: number; longitude: number };
  images?: { current?: { thumbnail?: string; preview?: string }; sizes?: { preview?: { width: number; height: number } } };
  player?: { day?: string };
  urls?: { detail?: string; provider?: string };
}

async function webcamTile(z: number, x: number, y: number, env: Env, origin: string): Promise<Response> {
  const headers = { "content-type": "application/json", "access-control-allow-origin": origin, vary: "origin", "cache-control": "max-age=300" };
  if (z < 1 || z > 16 || x >= 2 ** z || y >= 2 ** z) return new Response('{"error":"bad tile"}', { status: 400, headers });
  if (!env.WINDY_KEY?.trim()) return new Response('{"error":"relay has no Windy key (wrangler secret put WINDY_KEY)"}', { status: 503, headers });
  const key = `${z}/${x}/${y}`;
  const hit = tileCache.get(key);
  const ttlMs = (Number(env.WEBCAM_CACHE_S) || 600) * 1000;
  if (hit && Date.now() - hit.at < ttlMs) return new Response(hit.body, { headers });
  const b = tileBounds(z, x, y);
  const q = new URLSearchParams({
    northLat: b.n.toFixed(5),
    southLat: b.s.toFixed(5),
    eastLon: b.e.toFixed(5),
    westLon: b.w.toFixed(5),
    zoom: String(z),
    include: "location,images,player,urls",
  });
  const res = await upstream(`https://api.windy.com/webcams/api/v3/map/clusters?${q}`, env, {
    headers: { "x-windy-api-key": env.WINDY_KEY.trim() },
  });
  if (!res.ok) {
    const msg = res.status === 429 ? "Windy rate limit reached: try again in a minute" : `Windy answered HTTP ${res.status}`;
    return new Response(JSON.stringify({ error: msg }), { status: 502, headers });
  }
  const cams = (await res.json()) as WindyCam[];
  // Compact rows: [id, lon, lat, clusterSize, title, place, active, updated, preview, w, h, player, detail, provider]
  const rows = cams
    .filter((c) => c.location)
    .map((c) => {
      const l = c.location!;
      const size = c.images?.sizes?.preview;
      return [
        c.webcamId, l.longitude, l.latitude, c.clusterSize ?? 1, c.title,
        [l.city, l.region, l.country].filter(Boolean).join(", "),
        c.status === "active" ? 1 : 0, c.lastUpdatedOn ?? "",
        c.images?.current?.preview ?? "", size?.width ?? 0, size?.height ?? 0,
        c.player?.day ?? "", c.urls?.detail ?? "", c.urls?.provider ?? "",
      ];
    });
  const body = JSON.stringify({ cams: rows });
  if (tileCache.size > 5000) tileCache.clear(); // bounded memory
  tileCache.set(key, { at: Date.now(), body });
  return new Response(body, { headers });
}

/** [west, south, east, north] in degrees. */
type Box = [number, number, number, number];

interface Ship {
  mmsi: number;
  lon: number;
  lat: number;
  cog: number | null;
  sog: number | null;
  heading: number | null;
  type: number | null;
  name: string;
  dest: string;
  status: number | null;
  len: number | null;
  t: number; // last position time (ms)
  u: number; // last change of any kind (position or static data): what gets sent
}

interface Viewer {
  box: Box | null;
  /** Time of the last flush to this viewer; ships updated after it are sent next time. */
  sentAt: number;
  needsFull: boolean;
}

const inBox = (s: Ship, b: Box) => s.lon >= b[0] && s.lon <= b[2] && s.lat >= b[1] && s.lat <= b[3];
const clean = (s: unknown) => String(s ?? "").replace(/@+$/, "").trim();
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export class ShipsRelay {
  private viewers = new Map<WebSocket, Viewer>();
  private ships = new Map<number, Ship>();
  private upstream: WebSocket | null = null;
  private upstreamBoxes = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastError = "";
  private connecting = false;
  private stats = { connects: 0, lastConnect: "", raw: 0, unreadable: 0, unreadableSample: "", messages: 0, lastMessageAt: 0, lastClose: "", upstreamErrors: 0 };

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === "/status") return this.statusPage();
    if (this.viewers.size >= MAX_VIEWERS) return new Response("busy", { status: 503 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    this.viewers.set(server, { box: null, sentAt: 0, needsFull: true });
    server.addEventListener("message", (e) => this.onViewerMessage(server, e.data));
    const bye = () => this.dropViewer(server);
    server.addEventListener("close", bye);
    server.addEventListener("error", bye);
    if (!this.timer) this.timer = setInterval(() => this.flush(), FLUSH_MS);
    // Tell the page this relay's limits (a self-hosted relay may allow bigger views).
    this.send(server, { t: "hello", maxSpan: Number(this.env.SHIPS_MAX_SPAN_DEG) || DEFAULT_MAX_SPAN_DEG });
    return new Response(null, { status: 101, webSocket: client });
  }

  private statusPage(): Response {
    const now = Date.now();
    const st = this.stats;
    const body = {
      viewers: this.viewers.size,
      viewersWithBox: [...this.viewers.values()].filter((v) => v.box).length,
      upstream: this.upstream ? "open" : this.connecting ? "connecting" : "closed",
      key: this.env.AISSTREAM_KEY ? `set (${this.env.AISSTREAM_KEY.trim().length} characters)` : "MISSING",
      connects: st.connects,
      lastConnect: st.lastConnect,
      framesReceived: st.raw,
      framesUnreadable: st.unreadable,
      unreadableSample: st.unreadableSample,
      messagesReceived: st.messages,
      lastMessageSecondsAgo: st.lastMessageAt ? Math.round((now - st.lastMessageAt) / 1000) : null,
      lastClose: st.lastClose,
      lastError: this.lastError,
      shipsInMemory: this.ships.size,
      shipsWithPosition: [...this.ships.values()].filter((s) => s.t).length,
    };
    return new Response(JSON.stringify(body, null, 2), { headers: { "content-type": "application/json" } });
  }

  private send(ws: WebSocket, msg: unknown): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      this.dropViewer(ws);
    }
  }

  private onViewerMessage(ws: WebSocket, data: unknown): void {
    let msg: { box?: unknown };
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    const b = msg.box;
    if (!Array.isArray(b) || b.length !== 4 || !b.every((x) => typeof x === "number" && Number.isFinite(x))) return;
    const box = b as Box;
    const v = this.viewers.get(ws);
    if (!v) return;
    const maxSpan = Number(this.env.SHIPS_MAX_SPAN_DEG) || DEFAULT_MAX_SPAN_DEG;
    if (box[2] - box[0] > maxSpan || box[3] - box[1] > maxSpan) {
      v.box = null;
      this.send(ws, { t: "status", msg: "zoom in to see ships" });
    } else {
      v.box = box;
      v.needsFull = true;
    }
    this.syncUpstream();
  }

  private dropViewer(ws: WebSocket): void {
    if (!this.viewers.delete(ws)) return;
    try {
      ws.close(1000, "bye");
    } catch {
      // already closed
    }
    this.syncUpstream();
  }

  /** One upstream connection subscribed to every viewer's box; none when nobody watches. */
  private syncUpstream(): void {
    const boxes = [...this.viewers.values()].filter((v) => v.box).map((v) => v.box!);
    if (boxes.length === 0) {
      this.upstream?.close(1000, "no viewers");
      this.upstream = null;
      this.upstreamBoxes = "";
      if (this.viewers.size === 0 && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      return;
    }
    // AISStream wants [[lat, lon], [lat, lon]] corners.
    const subscription = boxes.slice(0, 10).map((b) => [[b[1], b[0]], [b[3], b[2]]]);
    const key = JSON.stringify(subscription);
    if (key === this.upstreamBoxes && (this.upstream || this.connecting)) return;
    this.upstreamBoxes = key;
    if (this.upstream) this.subscribe(this.upstream, subscription); // same connection, new area
    else if (!this.connecting) void this.connect(subscription); // connect() subscribes to the latest boxes
  }

  private subscribe(ws: WebSocket, boxes: number[][][]): void {
    ws.send(
      JSON.stringify({
        APIKey: this.env.AISSTREAM_KEY.trim(),
        BoundingBoxes: boxes,
        FilterMessageTypes: ["PositionReport", "StandardClassBPositionReport", "ExtendedClassBPositionReport", "ShipStaticData", "StaticDataReport"],
      }),
    );
  }

  private fail(msg: string): void {
    this.lastError = msg;
    this.broadcastStatus(msg);
  }

  private async connect(boxes: number[][][]): Promise<void> {
    if (!this.env.AISSTREAM_KEY?.trim()) {
      this.fail("relay has no AISStream key (wrangler secret put AISSTREAM_KEY)");
      this.upstreamBoxes = "";
      return;
    }
    this.connecting = true;
    this.stats.connects++;
    let ws: WebSocket;
    try {
      const res = await fetch(this.env.AISSTREAM_URL ?? UPSTREAM, { headers: { upgrade: "websocket" } });
      this.stats.lastConnect = `HTTP ${res.status} at ${new Date().toISOString()}`;
      if (!res.webSocket) throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
      ws = res.webSocket;
      ws.accept();
    } catch (err) {
      this.connecting = false;
      this.upstreamBoxes = "";
      this.fail(`AISStream unreachable from the relay: ${err instanceof Error ? err.message : String(err)}; retrying in 30 s`);
      setTimeout(() => this.syncUpstream(), 30000);
      return;
    }
    this.connecting = false;
    // Never keep two: AISStream allows one connection per key and cuts the newer one.
    if (this.upstream && this.upstream !== ws) this.upstream.close(1000, "replaced");
    this.upstream = ws;
    const openedAt = Date.now();
    let received = 0;
    ws.addEventListener("message", (e) => {
      received++;
      // AISStream sends binary frames; on Cloudflare they arrive as a Blob (Node gives text).
      const d: unknown = e.data;
      if (d instanceof Blob) void d.text().then((t) => this.onUpstream(t));
      else this.onUpstream(d);
    });
    ws.addEventListener("close", (e) => {
      this.stats.lastClose = `${e.code} ${e.reason || ""} at ${new Date().toISOString()}`.trim();
      if (this.upstream !== ws) return;
      this.upstream = null;
      this.upstreamBoxes = "";
      if (this.viewers.size === 0) return;
      // Cut within seconds with nothing received: the key is in use by another connection
      // (AISStream allows one per key). Wait longer so we don't fight over it.
      const busy = received <= 1 && Date.now() - openedAt < 15000 && e.code !== 1000;
      const wait = busy ? 60000 : 5000;
      // Any close while people watch is worth showing (a refused key closes with a normal code).
      this.fail(
        busy
          ? "AISStream refused the connection: this key is already in use elsewhere (one connection per key: another relay, a local wrangler dev, or a test script); retrying in 60 s"
          : `AISStream closed the connection (${e.code}${e.reason ? " " + e.reason : ""}); retrying in 5 s`,
      );
      setTimeout(() => this.syncUpstream(), wait);
    });
    // Boxes may have changed while connecting: subscribe to the latest ones.
    // AISStream closes the connection unless the subscription arrives within 3 s.
    const latest = [...this.viewers.values()].filter((v) => v.box).map((v) => [[v.box![1], v.box![0]], [v.box![3], v.box![2]]]).slice(0, 10);
    if (latest.length) {
      this.upstreamBoxes = JSON.stringify(latest);
      this.subscribe(ws, latest);
    } else this.subscribe(ws, boxes);
  }

  private broadcastStatus(msg: string): void {
    for (const ws of this.viewers.keys()) this.send(ws, { t: "status", msg });
  }

  private onUpstream(data: unknown): void {
    let m: { MessageType?: string; MetaData?: Record<string, unknown>; Message?: Record<string, Record<string, unknown>>; error?: string };
    this.stats.raw++;
    let text = "";
    try {
      text = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
      m = JSON.parse(text);
    } catch {
      this.stats.unreadable++;
      if (!this.stats.unreadableSample) {
        const kind = typeof data === "string" ? "text" : Object.prototype.toString.call(data);
        this.stats.unreadableSample = `${kind}: ${text.slice(0, 80)}`;
      }
      return;
    }
    this.stats.messages++;
    this.stats.lastMessageAt = Date.now();
    if (m.error) {
      this.stats.upstreamErrors++;
      this.fail(`AISStream: ${m.error}`);
      return;
    }
    if (m.MetaData) this.lastError = ""; // data flows again
    const meta = m.MetaData ?? {};
    const mmsi = num(meta.MMSI);
    const body = m.Message?.[m.MessageType ?? ""] ?? {};
    if (!mmsi) return;
    const now = Date.now();
    let s = this.ships.get(mmsi);
    if (!s) {
      s = { mmsi, lon: NaN, lat: NaN, cog: null, sog: null, heading: null, type: null, name: "", dest: "", status: null, len: null, t: 0, u: 0 };
      this.ships.set(mmsi, s);
    }
    if (clean(meta.ShipName) && clean(meta.ShipName) !== s.name) {
      s.name = clean(meta.ShipName);
      s.u = now;
    }
    switch (m.MessageType) {
      case "PositionReport":
      case "StandardClassBPositionReport":
      case "ExtendedClassBPositionReport": {
        const lat = num(body.Latitude) ?? num(meta.latitude);
        const lon = num(body.Longitude) ?? num(meta.longitude);
        if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
        s.lat = lat;
        s.lon = lon;
        s.cog = num(body.Cog) !== null && (body.Cog as number) < 360 ? (body.Cog as number) : null;
        s.sog = num(body.Sog) !== null && (body.Sog as number) < 102.3 ? (body.Sog as number) : null;
        s.heading = num(body.TrueHeading) !== null && (body.TrueHeading as number) < 360 ? (body.TrueHeading as number) : null;
        if (num(body.NavigationalStatus) !== null) s.status = body.NavigationalStatus as number;
        if (m.MessageType === "ExtendedClassBPositionReport") {
          if (clean(body.Name)) s.name = clean(body.Name);
          if (num(body.Type)) s.type = body.Type as number;
        }
        s.t = now;
        s.u = now;
        break;
      }
      case "ShipStaticData": {
        if (clean(body.Name)) s.name = clean(body.Name);
        if (num(body.Type)) s.type = body.Type as number;
        s.dest = clean(body.Destination);
        const d = body.Dimension as Record<string, number> | undefined;
        if (d && d.A + d.B > 0) s.len = d.A + d.B;
        s.u = now; // static data changed: send it even if the position didn't
        break;
      }
      case "StaticDataReport": {
        const a = body.ReportA as Record<string, unknown> | undefined;
        const b = body.ReportB as Record<string, unknown> | undefined;
        if (a?.Valid && clean(a.Name)) s.name = clean(a.Name);
        if (b?.Valid && num(b.ShipType)) s.type = b.ShipType as number;
        const d = b?.Dimension as Record<string, number> | undefined;
        if (b?.Valid && d && d.A + d.B > 0) s.len = d.A + d.B;
        s.u = now;
        break;
      }
    }
  }

  /** Every 2 s: each viewer gets the ships in its box (all of them after a box change). */
  private flush(): void {
    const now = Date.now();
    for (const [mmsi, s] of this.ships) if (now - s.t > STALE_MS && s.t > 0) this.ships.delete(mmsi);
    for (const [ws, v] of this.viewers) {
      if (!v.box) continue;
      const out: unknown[] = [];
      for (const s of this.ships.values()) {
        if (!s.t || !inBox(s, v.box)) continue;
        if (!v.needsFull && s.u <= v.sentAt) continue;
        out.push([s.mmsi, s.lon, s.lat, s.cog, s.sog, s.heading, s.type, s.name, s.dest, s.status, s.len, Math.round((now - s.t) / 1000)]);
      }
      if (out.length || v.needsFull) this.send(ws, { t: "ships", full: v.needsFull, ships: out, upstream: this.lastError || (this.upstream ? "on" : "connecting") });
      v.needsFull = false;
      v.sentAt = now;
    }
  }
}
