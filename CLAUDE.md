# CLAUDE.md — rabbithole_explorer

Read this first in every session. Technical briefing for the project; it holds **no personal
details about the owner**. Those live in a separate **private notes repo** (`OWNER.md`: who the
owner is, how to work with him, his setup, background research). If that repo is attached to
the session (e.g. cloned next to this one), read its `OWNER.md` first; if not, ask the owner to
attach it or work from this file alone. Priority: **the owner's messages win, then `OWNER.md`,
then this file.**

## Working rules

- Claude writes and tests all code; the owner tests in batches and reports problems at once.
  So test every step thoroughly in the sandbox (fixtures + live, smoke test extended per
  feature) before the PR, then give a short "what's new / how to try it" note.
- Before any command or script for the owner: list what it assumes is installed (tools,
  versions, accounts, keys) and anything long-running; after each step say what he should see
  and the likely cause if not.
- One branch per step, one PR per step into `main` (only when the owner asks), labelled
  `milestone: v0.<step> <name>`. One clear commit per step; update the step table below.
- Ask before big or hard-to-undo decisions. Be honest when something doesn't work.
- Runs on the owner's free credits: **be economical** (small steps, no unnecessary
  exploration, dependencies or huge file reads). Stop when a step is done.
- **Public repo: never commit personal details** (names, location, home or work details,
  hardware owned, emails, keys, decoder recordings, quotes attributed to the owner). Personal
  context goes in the private notes repo, never here. Never put a model name in commits,
  code or docs.
- MIT (`LICENSE`, RafailDD, 2026). Borrowed code under `vendor/<project>/` with a header naming
  source file + commit, listed in `THIRD_PARTY_NOTICES.md`.

## Product

A lightweight, free **2D** map aggregating public live "what's around me" data (aircraft,
ships, satellites, earthquakes, LoRa gateways…). Every data type is an **independent,
toggleable layer**. Signature feature: a **personal RTL-SDR overlay** — a local decoder's
`aircraft.json` drawn over the public feeds, matched by ICAO hex (MMSI later): "heard by both",
"only my antenna", "only public", with counts. Overlay data stays local, never uploaded.

Positioning vs God's Eye View (3D Cesium, maxes out integrated GPUs; has a local RTL-SDR layer since
Sep 2026 but no heard/missed diff) and GodsView AI (closed, hosted): **open source, no
tracking, smooth on integrated graphics, own-antenna vs public comparison.** The comparison
stays **draft** until tested with real hardware.

## Decisions

| Topic | Decision |
| --- | --- |
| Fork vs fresh | Fresh. May copy GEV's Cesium-free pieces (MIT): aircraft.json adapter (`src/layers/localAdsb/feeds.js`, `src/sources/adsbRecords.js`), later the WebUSB decoder (`src/sdr/`). Into `vendor/gev/` with header + `THIRD_PARTY_NOTICES.md`. `@jtarrio/webrtlsdr` / `@jtarrio/signals` are Apache-2.0: include licence text. Don't copy GEV datasets. Never copy GPL/AGPL code (tar1090, readsb, AIS-catcher, ShadowBroker); reading for ideas is OK. |
| Stack | TypeScript + Vite, no UI framework (plain DOM). Static build (`base: './'`). |
| Map | MapLibre GL JS. One GeoJSON source + symbol layer per data layer, rotated icons, **never DOM markers**. |
| Basemaps (14 Oct) | "Map:" selector: **Colour (Liberty, default since 14 Oct)**, Light (Positron), Dark, Black & white (Positron recoloured in code), Satellite (EOX Sentinel-2 cloudless 2023, 10 m, CC BY-NC-SA, no key), Satellite HD (MapTiler `satellite-v2`, **needs a free MapTiler key**, pasted in the panel, localStorage `rhe.maptiler.key` or `VITE_MAPTILER_KEY`; never committed), Satellite yesterday (NASA GIBS, 250 m, maxzoom 9; picks the first complete daily mosaic among NOAA-20 / Suomi-NPP / NOAA-21 / MODIS Terra by checking the 4 zoom-1 tiles' sizes, since single satellites sometimes have big holes). EOX uses its own tiles up to z17 (avoids client over-zoom seams). Picker shows a "~X m per pixel, zooming only blurs" note past each imagery's useful zoom. Imagery gets OFM place names / road names / borders, each toggled separately (`rhe.basemap.overlays`). **Not Esri World Imagery** (terms). `?map=<id>` + localStorage `rhe.basemap`. Switching keeps data layers via `setStyle(transformStyle)`; planes yellow on dark/imagery. |
| Layer system | Registry; each layer: enable/disable, own poll timer, `AbortController`. **Disabled layer = zero network requests.** State in URL (`?layers=a,b`) + localStorage (always try/catch). |
| Performance | Integrated graphics: no `backdrop-filter`/blur, no heavy shadows/animations, pause all timers when tab hidden, satellites in a Web Worker. |
| Aircraft | **No CORS on any aircraft feed** (probe). Relayed by the Worker (`/air/<feed>/<path>`, allowlisted paths only, descriptive User-Agent, identical requests within 2 s share one upstream fetch, `x-rhe-relay` header exposed so the page can tell relay errors from feed errors). The Vite dev proxy is gone (8a). **From Cloudflare Workers the feeds refuse us** (16 Oct, tested on the deployed relay): adsb.fi answers 403 "Attention Required! | Cloudflare" (bot protection), adsb.lol 429 after one request (per-IP limits; Workers share outgoing IPs), trace files still OK. adsb.lol has no API keys yet ("planned, for feeders"). So: hosted aircraft show a readable "blocked / rate-limiting this relay … npm run selfhost, then Relay → This computer" message (5 min pause after a 403, 30 s after a 429); self-hosted relays (home IP) work. Options later: adsb.lol permission/key, or a relay with its own IP (free-tier VM). adsb.lol `/v2/lat/{lat}/lon/{lon}/dist/{nm}` (≤250 nm) from view centre, radius = min(250 nm, half view diagonal), poll 5 s (radius ≤ 100 nm) / 10 s, icons dead-reckoned at 1 Hz between polls (no extra requests). **Path only for the clicked aircraft** (14 Oct), from adsb.lol's trace file `adsb.lol/data/traces/<last 2 hex>/trace_full_<hex>.json` (undocumented, no CORS → relay; ODbL; sometimes slow → card says "not available"), cut to the current flight (last take-off, leg marker or >20 min gap), plus our own polled positions; gone on deselect. Card shows departure time when the take-off is in the trace. **The selected aircraft is followed outside the queried area and when zoomed out** (14 Oct): one extra `/v2/hex/<hex>` (adsb.fi `/api/v2/hex/<hex>`) request per poll, only while it's outside the area. HTTP 429 → that source pauses 30 s (per source). Not used: schedule times / airline ETA (only in commercial databases like FR24/FlightAware, whose terms forbid scraping). Route on click from VRS standing data (CC0, CORS, `vrs-standing-data.adsb.lol/routes/XX/CALLSIGN.json`), checked against position; rough ETA = straight line ÷ ground speed, labelled as such. adsb.lol `/api/0/routeset` returns empty 201 (dead). "zoom in" below ~zoom 5. Fallback selectable: adsb.fi `/v3/lat/…/lon/…/dist/…`. airplanes.live **removed** (refuses apps that haven't contacted them; re-add later with permission). **Not OpenSky** (OAuth secret). |
| Earthquakes | USGS, browser-direct (whole world, no relay). Two selects (14 Oct, "like IRIS Seismic Monitor"): min magnitude (all/1/2.5/4/4.5/5/6/7) × period (hour/day/week/month/year/5 y/20 y); default M2.5+ week. Summary GeoJSON feeds when the combo exists (all/1.0/2.5/4.5 × hour–month), else FDSN `query?format=text` (GeoJSON is ~20× bigger) with `orderby=magnitude&limit=20000` + `count` → "the 20,000 biggest of N". Start time rounded (hour / day for ≥ 1 year) so USGS caches: uncached 5-year M4+ ≈ 30 s, cached ≈ 0.6 s. Poll 5 min (30 min for ≥ 1 year). Circles: radius by magnitude and zoom (dots at world zoom), colour by age (purple < 1 h, pink < 1 day, red < 1 week, orange < 1 month, amber < 1 year, yellow older), newest on top. Click → shared details panel (place, time, magnitude, depth, felt, PAGER, tsunami flag, status, USGS link restricted to usgs.gov). EMSC (Europe detail) possible later. |
| Ships | AISStream via free Cloudflare Worker + Durable Object `worker/` (AISStream forbids browser connections; key is a Cloudflare secret `AISSTREAM_KEY`, locally `worker/.dev.vars`, **never committed**). Browser WebSocket `<relay>/ships` sends its view box `{box:[w,s,e,n]}`, padded to ≥ 1° × 1° and rounded outwards to 0.1° (AISStream has no snapshot; a 0.01° box at high zoom missed a whole port: 0 ships, 15 Oct); one upstream AISStream connection shared by all viewers (≤ 10 boxes, closed when nobody watches); boxes wider than 20° → "zoom in". Relay sends changed ships every 2 s (compact arrays), drops ships silent for 30 min; origin allowlist `ALLOWED_ORIGINS`. Connect only while the layer is on. Relay URL in the panel (localStorage `rhe.relay.url`, default `VITE_RELAY_URL` or `http://localhost:8787`). Icons coloured by AIS type category (hull when moving, dot when stopped); static data (type, name, destination) arrives only every ~6 min and many small craft never send a type. No MMSI search (ethics row). Later: own AIS-catcher (`http://<host>:8100/api/ships.json`, has CORS). |
| Webcams (15 Oct: "Windy + hand-picked live streams") | **Windy Webcams API v3, free plan**, key `WINDY_KEY` in the relay (Cloudflare secret / `worker/.dev.vars`, never committed). Relay `/webcams/tile/z/x/y` → Windy `map/clusters` for exactly that tile (Windy accepts at most 360/2^z degrees of latitude per zoom z), compact rows, cached 10 min in the Worker's memory + browser `max-age=300`; origin allowlist. Rate limit 300 requests/min per key. Page asks tiles at z = floor(map zoom), max 20 tiles ("zoom in" beyond), poll 10 min + 0.6 s after moves. Circles: single cam blue (grey offline), clusters lighter with count; click cluster → zoom +2; click cam → card with the latest picture (URL exactly as Windy gives it, never wider than its own size), place, age, "Timelapse (last 24 h)" (Windy's player iframe, loaded on click), windy.com page + camera's own site. **Windy terms** (read 15 Oct): visible credit "Webcams provided by windy.com – add new webcam" linking windy.com and windy.com/webcams/add (`creditNodes()`), no key exposure, no bulk scanning, no redistribution (fixtures are made up), don't block the free plan's ads, **no publishing of graphics showing webcam images (README screenshots at step 8 must not show webcam pictures)**. Live video: `public/data/live-streams.json`, 24 hand-picked YouTube live webcams (ports, airports, volcanoes, nature, skylines; no security/CCTV cameras, no walking tours or re-streams of others' content, no daily-changing video IDs); positions approximate; `embed: false` for 4 French channels that disallow embedding (card links to YouTube). Nothing loads from YouTube until a click; player from youtube-nocookie.com, muted autoplay. `npm run streams` (`tools/check-streams.mjs`, `--write` stores the date) checks each is live and embeddable: watch page, or (datacenter IPs get "not a bot") oEmbed + the `hqdefault_live.jpg` thumbnail. Refresh the list by hand when streams die. |
| Hosted vs self-hosted (8a) | One codebase, two ways to run: **hosted** (published site built with `VITE_RELAY_URL` = the owner's relay; visitors set up nothing) and **self-hosted** (`npm run setup` writes your own keys to `worker/.dev.vars`; `npm run selfhost` starts the relay on :8787 via `wrangler dev` and Vite on :5173; no Cloudflare account). A third: own Cloudflare copy (`wrangler deploy`). "Relay:" picker in the panel (Hosted only offered when the build has one / This computer / Custom), health check line under it, layers reconnect on change (`onRelayChange`). Relay limits are vars (`SHIPS_MAX_SPAN_DEG`, `WEBCAM_CACHE_S`, overridable in `.dev.vars`); the ships relay sends `{t:"hello", maxSpan}`. Providers still limit per key/IP (AISStream 1 connection/key ≤ 10 boxes, Windy 300/min). |
| Satellites | CelesTrak OMM JSON **fetched browser-direct (CORS OK)**, cached in localStorage for 2 h per group (policy: 1 download / 2 h per data set; stale copy kept on errors). Groups: Space stations, GPS, Weather (default on), Brightest (`visual`, off). satellite.js 7.1.0 SGP4 in a Web Worker, positions at 1 Hz; worker exists only while the layer is on. Click → details (altitude, speed, period, inclination, element age) + dashed ground track ±1 orbit (split at the antimeridian). ISS drawn larger and on top. Verified: ISS within ~1–3 km of wheretheiss.at. |
| LoRa | Packet Broker Mapper `mapper.packetbroker.net/api/v2/gateways` (no filter = all 187k gateways, ~6 MB; `netID=000013` needs `&tenantID=ttn`; `distanceWithin[latitude/longitude/distance(m)]` works). The page never calls it: `tools/fetch-gateways.mjs` (`npm run gateways`) writes `public/data/lora-gateways.json` (committed; ~420 kB, ~107 kB gz): located gateways updated ≤ 7 days (~15.6k, ~3k with Packet Broker's `online` flag), positions rounded to 3 decimals, no IDs/EUIs, networks by index. Clusters (MapLibre GeoJSON `cluster`, `clusterProperties.online`), green = online, grey = seen this week, toggle to hide non-online. Refreshed daily at build time by the Pages workflow (8c); `npm run gateways` by hand for local use. |
| Antenna overlay | Settings field for decoder URL (dump1090-fa / readsb / tar1090 `aircraft.json`), 1 s poll, ICAO match, all client-side. Chrome 142+ shows a one-time Local Network Access prompt; decoder must send `Access-Control-Allow-Origin` (dump1090-fa SkyAware does on `/skyaware/data/*.json`; tar1090 needs a lighttpd rule). Until hardware: **fake decoder** script replaying a recorded `aircraft.json` on localhost with CORS. |
| Legal / ethics | Non-commercial, non-surveillance. **No military layer/filter, no owner names, no stored history, no search/watchlists/alerts by registration, tail or MMSI.** Short trails in memory only. Always-visible attribution line + "About the data" panel crediting every source (see `src/sources.ts`). |
| Licence | MIT + `THIRD_PARTY_NOTICES.md`. |

### Feed CORS status (step 0 probe, Chrome 155, 13 Oct 2026)

| Feed | Browser-direct? | Notes |
| --- | --- | --- |
| adsb.lol | **no** (CORS) | reachable; needs proxy |
| adsb.fi | **no** (CORS) | reachable; needs proxy |
| airplanes.live | **no** (CORS) | reachable; needs proxy |
| USGS | yes | 34 kB, 49 quakes (2.5+ day) |
| EMSC | yes | could add European detail later |
| CelesTrak | yes | contrary to the early research notes |
| Packet Broker | yes, but returned `[]` (3 B) | the 50 km `distanceWithin` filter is probably wrong; recheck at step 7 |
| OpenFreeMap | yes | |
| RainViewer | yes | for the "later" radar layer |

## Sandbox notes (for Claude)

- Network widened on 13 Oct 2026: the sandbox reaches the live feeds and
  OpenFreeMap. Run the smoke test against live data too; the owner only judges smoothness
  and feel on real hardware. Node's fetch needs `NODE_USE_ENV_PROXY=1` in the sandbox (egress
  proxy) (Vite itself no longer fetches anything upstream).
- workerd (`wrangler dev`) can't use the sandbox egress proxy: run a small Node `ws` bridge on :8091 (scratchpad, `NODE_USE_ENV_PROXY=1`) forwarding to `wss://stream.aisstream.io/v0/stream`, and start `npx wrangler dev --var AISSTREAM_URL:http://localhost:8091`. The smoke test's live ships checks use :8787 (`NO_AIS=1` skips them: one AISStream connection per key, don't compete with the deployed relay). For HTTPS upstreams (aircraft, Windy): a Node forwarder on :8092 (scratchpad `fwd.mjs`, `/<host>/<path>` → `https://<host>/<path>`) and `UPSTREAM_PROXY=http://localhost:8092` in `worker/.dev.vars` (test-only var; then `npm run selfhost` works in the sandbox). wrangler 4.151.1 prints "Proxy environment variables detected", so the forwarders may become unnecessary: untested.
- Stop Vite with `pkill -f "[v]ite --port"` in its **own** Bash call: any pattern matches the
  shell whose command line also started Vite.
- **airplanes.live returns 403 from the sandbox** (and from a home connection too) ("contact us with project details"). Re-add
  only after asking them for permission.
- adsb.lol rejects generic User-Agents: the proxy sends
  `rabbithole_explorer/0.1 (+repo URL)`. The hosted Worker must do the same.
- Headless Chromium via the globally installed Playwright (software WebGL: no perf
  conclusions).
- Sandbox Node is 22; the target is Node 24. Keep `engines` compatible with both.

## Code map

- `index.html`, `src/main.ts` — entry; builds map, registry, panel.
- `src/map.ts` — MapLibre setup (2D only: no pitch/rotation), worker URL, shared icons (`arrow`).
- `src/layers/base.ts` — `DataLayer`: one GeoJSON source + style layers + poll timer +
  `AbortController`; `pause()/resume()` for hidden tab; optional `frameMs`/`frame()` local
  animation (stops when off or hidden). Extra sources must be named `<id>-…` so they hide
  with the layer. New layers subclass it.
- `src/layers/registry.ts` — `LayerRegistry`: enable/disable, visibilitychange pause.
- `src/layers/aircraft.ts` — public aircraft: view-centre point query (radius = min(250 nm,
  half diagonal)), 5/10 s poll + re-query 0.7 s after the map stops (≥ 2 s apart, skipped if the
  rounded query is unchanged), none below zoom 5. In-memory `tracks` map per hex; `frame()`
  (1 Hz) dead-reckons positions and redraws points + the selected aircraft's path (`air-trails-src`). `parseTrace()` splits a day's trace into flights. Source select (adsb.lol / adsb.fi) in
  localStorage `rhe.air.feed`. Selection UI (14 Oct: popups hid the map): click → details in the
  docked `#details` panel (top-right; bottom sheet on phones), selected plane + path in orange;
  hover → small tooltip (callsign · altitude); × / Esc / click on empty map deselects.
  Registrations deliberately not shown.
- `src/layers/ships.ts` — ships layer (see Decisions); fixtures `public/fixtures/ships-sample.json`.
- `worker/` — Cloudflare Worker `rabbithole-relay` (own `package.json`, wrangler 4.151.1): `src/index.ts` = `/health`, `/air/<feed>/<path>` (aircraft), `/ships` → Durable Object `ShipsRelay` (SQLite class, free plan). `AISSTREAM_URL` var overrides the upstream (sandbox bridge). `/status` = JSON diagnostics (upstream state, HTTP of last connect, messages received, last close/error, ship counts; no ship or viewer data). Every upstream close or error while viewers watch is shown in the panel. **AISStream allows one connection per key** (a second one is cut with 1006 within ~2 s): never run sandbox probes or a local relay with the same key while the deployed relay is in use; the relay reports "key already in use" and waits 60 s. AISStream sends **binary frames, which arrive as a `Blob` on Cloudflare** (Node gives text): the relay reads them with `blob.text()`; the sandbox bridge forwards binary to reproduce this. Durable Object instance name `INSTANCE` (`ships-v2`): bump it to force a fresh instance (an old instance kept running old code after a deploy, 15 Oct). Commands in `worker/`: `npm run dev` (:8787), `npx wrangler secret put AISSTREAM_KEY`, `npx wrangler deploy`.
- `src/relay.ts` + `src/ui/relay-picker.ts` — relay address (localStorage `rhe.relay.url`; default `VITE_RELAY_URL`, else
  `http://localhost:8787`), change listeners, the "Relay:" picker. `tools/setup.mjs` / `tools/selfhost.mjs` — `npm run setup` /
  `npm run selfhost` (see Decisions).
- `src/layers/quakes.ts` — USGS earthquakes (see Decisions). Feed choice in localStorage `rhe.quakes.feed`.
- `src/ui/details.ts` — shared docked details panel: one owner at a time (`showDetails(owner, el)`,
  `closeDetails(owner?)`, owner's `onDetailsClosed()` drops its highlight), Esc closes,
  `buildCard()` for title + rows. Every layer with a click card uses it.
- `src/layers/antenna.ts` — antenna overlay (**draft**), layer id `mine`: polls the decoder URL
  (localStorage `rhe.antenna.url`, default `http://localhost:8090/data/aircraft.json`) at 1 Hz,
  reads `receiver.json` next to it for the station, matches by hex against
  `AircraftLayer.publicPositions()`. Both → green ring drawn by the aircraft layer
  (`setHeard()`, layer `air-heard`); only mine → magenta planes; only public = public aircraft
  inside my current max range; position-less matches counted separately. Range ring + station
  dot (`mine-range-src`). Adds a "My antenna" row to aircraft cards (`extraRows`).
- `tools/fake-decoder.mjs` — stand-in decoder on :8090 with CORS: live-derived from adsb.lol
  around a station (distance-weighted reception, ~10 % without position, two made-up
  "only mine" aircraft `fffff0/1`), or `--replay file`. Fixtures: `decoder-*.json` (synthetic).
- `src/layers/satellites.ts` + `src/layers/sat.worker.ts` — satellites (see Decisions). Groups in
  localStorage `rhe.sats.groups`, element cache in `rhe.sats.cache.<group>`. The smoke test
  uses fixtures for satellites; `LIVE_SATS=1` adds one live CelesTrak load (don't run it
  more than once per 2 h). Vite's build warns about satellite.js's optional WASM build
  (`node:worker_threads`): harmless, nothing of it is bundled.
- `src/basemaps.ts` — basemap list, `buildStyle(id)`, `switchBasemap()` (keeps every `*-src` source and
  its layers on top), black-and-white recolouring, imagery labels. `src/ui/basemap-picker.ts` — the
  "Map:" selector, labels toggle, MapTiler key field.
- `src/layers/lora.ts` — LoRa gateways from `public/data/lora-gateways.json` (see Decisions); `DataLayer.sourceOptions`
  enables clustering. Offline toggle in localStorage `rhe.lora.offline`. All styles carry `glyphs` (OFM fonts) so
  our own text (cluster counts) renders on every background.
- `src/layers/daynight.ts` — "Day / night" layer: night polygon from the sub-solar point (low-precision solar
  position, checked against the solstices), redrawn every minute, no network. Registered first = drawn underneath.
- `src/layers/webcams.ts` — Windy webcams via the relay (see Decisions); `src/layers/streams.ts` — hand-picked YouTube live
  video. `src/relay.ts` — the relay URL shared by ships and webcams (localStorage `rhe.relay.url`). `DataLayer.creditNodes()`
  lets a layer's attribution contain links.
- `src/layers/routes.ts` — route guess for a clicked callsign + plausibility (detour ratio < 1.3).
- `src/state.ts` — `?layers=` URL param + localStorage (`rhe.layers`); URL wins. Map view in `#zoom/lat/lon` hash (MapLibre).
- `src/config.ts` — home view (Western Europe), `?feeds=live|fixtures` (default live, remembered), `?basemap=none`.
- `src/sources.ts` — every data source (id, credit, terms, `planned`) for the About panel; layers report active ids via `sourceIds()`.
- `src/ui/panel.ts` — panel (fold button `#panel-fold`, remembered `rhe.ui.panel`), one row per layer with a ▸/▾
  button folding its options (open set remembered `rhe.ui.open`; tests call `expand(page, id)` first), credit line,
  About dialog (DOM built with textContent, no innerHTML). Dev-only "data: live feeds / saved samples" switch.
- `src/ui/search.ts` — place search: coordinates (decimal or DMS) parsed locally; anything else → OSM Nominatim
  on Enter only (max 1/s, no type-ahead); red pin in `search-src`. Places only, never aircraft/registrations.
- `public/fixtures/` — hand-written sample data. `tools/` — feed probe, smoke test.

Versions pinned: maplibre-gl 6.11.2 (ESM-only; worker wired via `?worker&url` + `setWorkerUrl`),
vite 8.3.1, typescript 5.9.3. Commands: `npm run selfhost` (relay + app), `npm run setup` (keys), `npm run dev` (app only), `npm run build` (tsc + vite),
`npm run preview`. Sandbox test: run `npx vite` in background, then
`NODE_PATH=$(npm root -g) node tools/smoke-test.cjs` (`NO_LIVE=1` skips the live-feed checks; `MAPTILER_KEY=…` adds the HD check; start
`NODE_USE_ENV_PROXY=1 node tools/fake-decoder.mjs` first for the live antenna check).

## Step plan and status

Do one step at a time; after each: commit, update this table, give test instructions, stop.
History before the public repo (PR numbers, dates) is in the private notes repo.

| # | Step | Status |
| --- | --- | --- |
| 0 | Feed probe `tools/feed-probe.html` (status, CORS, size, time per feed) | **Done** (results above) |
| 1 | Map shell + layer framework (Vite+TS+MapLibre+Positron; registry, toggle panel, URL+localStorage, attribution line, About panel skeleton, fixture dummy layer) | **Done** |
| 2 | Aircraft layer (adsb.lol + adsb.fi via Vite dev proxy, fixtures mode), rotated icons, details panel, path of clicked plane, route + rough ETA, 1 Hz dead reckoning | **Done** |
| 3 | Earthquakes (USGS) | **Done** |
| 4 | Antenna overlay (**draft**): decoder URL, fake decoder replay, ICAO matching, both/mine/public styling + counts | **Done**, **still draft until tested with real hardware** |
| 5 | Ships: Cloudflare Worker + DO relaying AISStream; signup + deploy guide | **Done** (relay deployed on Cloudflare) |
| 5c | Cameras: Windy webcams (relay, clustered tiles, picture + timelapse card) + 24 hand-picked YouTube live streams | **Done** |
| 6 | Satellites: CelesTrak browser fetch + 2 h cache (stations, GPS, weather), Web Worker propagation 1 Hz | **Done** (built before step 5) |
| 6b | Basemaps: light / colour / dark / black & white / satellite (EOX, MapTiler, NASA) | **Done** |
| 7 | LoRa gateways: snapshot script + clustered circles | **Done** |
| 7b | UI fixes (14 Oct): follow selected plane, demo removed, collapsible panel, search bar, road names on imagery, Colour default, clearer dev switch | **Done** |
| 8 | Go public: README + screenshots, licences, Pages Action, snapshot Actions, Lighthouse. **Ask before going public.** | 8a **done** in sandbox, PR #1 (`milestone: v0.8a relay + self-host`) (aircraft through the relay, self-host mode, relay picker, wrangler 4.151.1 = 0 audit issues). 8b **done** in sandbox: README (what it is, layers, privacy, how it works, three ways to run, keys, development, credits) + 4 screenshots in `docs/screenshots/` (aircraft London, quakes Pacific, satellites + night, LoRa Europe; no webcams, no home location). 8c **done** in sandbox: `.github/workflows/site.yml` (every push/PR: `npm ci`, build, relay type-check; daily 04:17 UTC + pushes to main: fresh LoRa snapshot at build time, no daily commits; Pages deploy only when the repo is public; `VITE_RELAY_URL` from repo variable `RELAY_URL`); `https://rafaildd.github.io` added to `ALLOWED_ORIGINS` (live after the next relay deploy). Rehearsed in a clean worktree; built site checked with `vite preview` (Hosted option shown and selected, no errors). 8d **done** in sandbox: Lighthouse on the built site (desktop: accessibility 100, best practices 96, SEO 91; performance ~43 in the sandbox only because WebGL runs in software, no conclusion for real hardware); fixes: meta description, inline SVG favicon, aria-labels on the relay picker. Personal-details/key scan of every file in every commit: clean; the only finding is the owner's GitHub display name on GitHub-made merge commits (owner to change the profile name; optional history rewrite before going public). Remaining "errors": relay health check when no relay runs (expected), robots.txt (project Pages live under a subpath; only the domain root counts). **Ask before making anything public.** |

## Ideas backlog ("anything relating to a map is a candidate overlay")

Every idea becomes an independent toggleable layer like the others. Before building one,
check: a free/open source with terms that allow it, browser CORS (else relay/snapshot), and
the legal/ethics row above. Notes per idea:

| Idea | Likely source | Notes |
| --- | --- | --- |
| Visitor counter by country (overlay + full list under the toggle) | Our Cloudflare Worker (step 5): country from Cloudflare's `CF-IPCountry` header, one counter per country | Idea, parked (15 Oct). If built: count page loads only (no IPs, cookies or IDs stored, so not unique visitors), stated on the About panel. Only meaningful once public. |
| Geocaching | OpenCaching network (opencaching.de / .pl / .us…) via its OKAPI (open, free consumer key) | geocaching.com's API is partner-only: not usable. |
| User-curated maps with messages | Community maps the owner has collected (to be listed) | Review each one before integrating: its terms/licence and API or export, and whether pins or messages identify private people or addresses (if so, not shown as such: legal/ethics row). |
| Crime reports | Official open data, aggregated: UK data.police.uk (anonymised street-level API), France data.gouv.fr crime statistics per commune (yearly), US city open-data portals | Aggregated / area-level only (choropleth by area), never incident pins tied to people or homes. |
| Camera feeds | Public scenic and traffic webcams: Windy Webcams API (key via Worker), road-authority traffic cams with open terms | **No private or unsecured cameras** (insecam-style), no CCTV/ALPR/surveillance cameras (study section H). |
| Curated list of driving videos (low priority) | A known site lets you pick a country or city and watch someone drive around it (video). How to do it: to be worked out, likely a hand-curated list of public videos (city, coordinates, link), one pin per city, the video opening in the details panel | Respect the video platform's embed terms; privacy-friendly embeds (no-cookie player); credit the creators. |
| Weather radar | RainViewer (tiles + JSON, CORS OK in probe) | Personal/educational use, attribution with link. |
| Wildfires | NASA FIRMS (free map key) | Hotspots from satellites, near real time. |
| Volcanoes | Smithsonian GVP / USGS volcano feeds | |
| Aurora forecast | NOAA SWPC OVATION JSON | |
| Ocean buoys, tides | NOAA NDBC, national tide services | |
| Air quality / radiation | OpenAQ (key), Safecast (open) | |
| Own AIS-catcher overlay | An own receiver (`:8100/api/ships.json`, CORS) | After ships (step 5) and hardware. |
| In-page WebUSB decoding | GEV `src/sdr` (MIT) + webrtlsdr (Apache-2.0) | Chrome only; Linux needs a udev rule + blacklist `dvb_usb_rtl28xxu`; webrtlsdr lacks RTL-SDR Blog V4L. |
