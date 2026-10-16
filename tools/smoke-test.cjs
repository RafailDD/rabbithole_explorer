// Headless-browser smoke test for the map shell (used in Claude's sandbox; optional for you).
// Needs: a running dev server (`npm run dev`) and Playwright with Chromium.
// Usage:  NODE_PATH=$(npm root -g) node tools/smoke-test.cjs [http://localhost:5173/]
// Runs with ?basemap=none to keep it fast. The live checks need internet (NO_LIVE=1 skips
// them); in Claude's sandbox start Vite with NODE_USE_ENV_PROXY=1. Software WebGL, so no
// performance conclusions.
"use strict";
const { chromium } = require("playwright");

const BASE = process.argv[2] || "http://localhost:5173/";
// Framework checks use the antenna layer in fixtures mode: it polls a fixture every second.
const FIXTURE = /decoder-aircraft\.json/;
// The fixtures (recorded aircraft, fake decoder) are around the French Riviera.
const RIVIERA = "#8/43.6/7.2";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(ok, what) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures++;
}

async function openPage(browser, query, hash = "", withBasemap = false) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  const state = {};
  const hits = { n: 0 };
  // Chrome logs every HTTP error as "Failed to load resource" without the URL; check the
  // responses instead, allowing the expected "nothing on file" 404s (route, trace).
  page.on("console", (m) => {
    if (m.type() !== "error" || /^Failed to load resource/.test(m.text())) return;
    // NASA GIBS occasionally serves a tile without its CORS header; the map just skips that tile.
    if (/gibs\.earthdata\.nasa\.gov.*CORS/.test(m.text())) return console.log("INFO  NASA GIBS served one tile without CORS (skipped by the map)");
    // USGS times out (without CORS headers) on big uncached FDSN queries; the layer retries in a minute.
    if (/earthquake\.usgs\.gov\/fdsnws.*CORS/.test(m.text())) return console.log("INFO  USGS FDSN timed out on an uncached query (layer retries)");
    // Nominatim sometimes refuses the sandbox's shared IP (answer without CORS header); the search box says so.
    if (/nominatim\.openstreetmap\.org.*CORS/.test(m.text())) return void (state.nominatimRefused = true);
    errors.push(m.text());
  });
  page.on("response", (r) => {
    if (/tiles\.maps\.eox\.at/.test(r.url())) r.status() === 200 ? tiles.eox++ : tiles.bad++;
    if (/gibs\.earthdata\.nasa\.gov/.test(r.url())) r.status() === 200 ? tiles.gibs++ : tiles.bad++;
    if (/tiles\.openfreemap\.org/.test(r.url()) && r.status() === 200) tiles.ofm++;
    // adsb.lol's trace server sometimes times out (relay answers 502); the app says "not available".
    const expected404 =
      (r.status() === 404 && /vrs-standing-data|adsbloltrace/.test(r.url())) ||
      (r.status() === 502 && /adsbloltrace/.test(r.url())) ||
      // adsb.lol rate-limits bursts (this test opens many live sessions quickly); the app backs off 30 s.
      (r.status() === 429 && /\/proxy\//.test(r.url()));
    if (r.status() === 429) console.log(`INFO  rate-limited by the feed (429): ${r.url().replace(/^.*\/proxy\//, "")}`);
    if (r.status() >= 400 && !expected404) errors.push(`HTTP ${r.status()} ${r.url()}`);
  });
  page.on("pageerror", (e) => errors.push(e.message));
  const proxy = { n: 0 };
  const usgs = { n: 0 };
  const dec = { n: 0 };
  const sat = { n: 0 };
  const tiles = { eox: 0, gibs: 0, ofm: 0, bad: 0 };
  const lora = { snap: 0, api: 0 };
  const requests = [];
  page.on("request", (r) => {
    requests.push(r.url());
    if (FIXTURE.test(r.url())) hits.n++;
    if (r.url().includes("/proxy/")) proxy.n++;
    if (/earthquake\.usgs\.gov|quakes-usgs/.test(r.url())) usgs.n++;
    if (/decoder-aircraft|:8090\/data\/aircraft/.test(r.url())) dec.n++;
    if (/celestrak\.org|sats-/.test(r.url())) sat.n++;
    if (/lora-gateways\.json/.test(r.url())) lora.snap++;
    if (/packetbroker\.net/.test(r.url())) lora.api++;
  });
  await page.goto(`${BASE}?${withBasemap ? "" : "basemap=none"}${query}${hash}`);
  await page.waitForFunction(() => window.__rhe !== undefined, null, { timeout: 20000 });
  return Object.assign(state, { ctx, page, errors, hits, proxy, usgs, dec, sat, tiles, lora, requests });
}

const isChecked = (page) => page.isChecked('input[data-layer="mine"]');
// Layer options are folded away by default: open a layer's section before using them.
async function expand(page, id) {
  const t = await page.$(`[data-expand="${id}"]`);
  if (t && (await t.getAttribute("aria-expanded")) !== "true") await t.click();
}

(async () => {
  const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });

  // 1. Fresh visit, nothing enabled: zero fixture requests.
  const a = await openPage(browser, "&feeds=fixtures", RIVIERA);
  await sleep(6000);
  check(!(await isChecked(a.page)), "fresh visit: antenna layer off by default");
  check(a.hits.n === 0, `fresh visit: 0 requests while off (got ${a.hits.n})`);
  check(a.proxy.n === 0 && a.usgs.n === 0 && a.dec.n === 0 && a.sat.n === 0 && a.lora.snap === 0, `fresh visit: no aircraft, quake, decoder or satellite requests (got ${a.proxy.n}/${a.usgs.n}/${a.dec.n}/${a.sat.n})`);

  // 2. Turn it on: requests start, features drawn, URL updated.
  await a.page.check('input[data-layer="mine"]');
  await sleep(3500);
  check(a.hits.n >= 2, `on: polls every second (got ${a.hits.n} requests in 3.5 s)`);
  const drawn = await a.page.evaluate(() => window.__rhe.map.queryRenderedFeatures({ layers: ["mine-planes"] }).length);
  check(drawn > 0, `on: ${drawn} aircraft rendered`);
  check(a.page.url().includes("layers=mine"), `on: URL has layers=mine (${a.page.url()})`);
  check((await a.page.textContent("#credits")).includes("My antenna"), "on: credit line names the layer");

  // 3. Turn it off: no more requests.
  await a.page.uncheck('input[data-layer="mine"]');
  await sleep(300);
  const before = a.hits.n;
  await sleep(5000);
  check(a.hits.n === before, `off: 0 requests in 5 s (got ${a.hits.n - before})`);
  check(/layers=(&|#|$)/.test(a.page.url()), `off: URL has empty layers= (${a.page.url()})`);

  // 4. On again, then reload the bare address: localStorage restores it.
  await a.page.check('input[data-layer="mine"]');
  await a.page.goto(`${BASE}?basemap=none`);
  await a.page.waitForFunction(() => window.__rhe !== undefined);
  check(await isChecked(a.page), "reload of bare URL: state restored from localStorage");

  // 5. Hidden tab: polling pauses, resumes when visible.
  await sleep(1000);
  const setHidden = (hidden) => a.page.evaluate((h) => {
    Object.defineProperty(document, "visibilityState", { value: h ? "hidden" : "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
  await setHidden(true);
  await sleep(300);
  const hiddenStart = a.hits.n;
  await sleep(5000);
  check(a.hits.n === hiddenStart, `hidden tab: 0 requests in 5 s (got ${a.hits.n - hiddenStart})`);
  await setHidden(false);
  await sleep(1500);
  check(a.hits.n > hiddenStart, "visible again: polling resumes");

  // 6. About dialog opens and lists sources.
  await a.page.click("#panel button.link");
  const aboutText = await a.page.textContent("#about");
  check(/adsb\.lol/.test(aboutText) && /OpenFreeMap/.test(aboutText), "About panel lists sources");
  await a.page.click("#about button:not(.link)");
  await a.page.screenshot({ path: process.env.SHOT || require("path").join(require("os").tmpdir(), "rhe-smoke.png") });
  check(a.errors.length === 0, `no console errors (${a.errors.join(" | ")})`);
  await a.ctx.close();

  // 7. A copied URL reproduces the state in a fresh browser profile (empty localStorage).
  const b = await openPage(browser, "&feeds=fixtures&layers=mine", RIVIERA);
  check(await isChecked(b.page), "copied URL ?layers=mine: layer on in a fresh profile");
  await b.ctx.close();
  const c = await openPage(browser, "&layers=");
  check(!(await isChecked(c.page)), "copied URL ?layers= : layer off in a fresh profile");
  await c.ctx.close();

  // 7b. Panel: demo layer gone, sections folded by default and remembered, panel folds.
  const pn = await openPage(browser, "&feeds=fixtures", RIVIERA);
  check(!(await pn.page.$('input[data-layer="demo"]')), "panel: no demo layer");
  check(await pn.page.$eval('li:has([data-layer="sats"]) .setting', (e) => e.hidden), "panel: layer options folded by default");
  await expand(pn.page, "sats");
  await pn.page.reload();
  await pn.page.waitForFunction(() => window.__rhe !== undefined);
  check(!(await pn.page.$eval('li:has([data-layer="sats"]) .setting', (e) => e.hidden)), "panel: an opened section stays open after reload");
  await pn.page.click("#panel-fold");
  check(await pn.page.$eval("#panel-body", (e) => e.hidden), "panel: fold button hides the panel body");
  await pn.page.click("#panel-fold");
  check(!(await pn.page.$eval("#panel-body", (e) => e.hidden)), "panel: fold button shows it again");
  // Search: coordinates are handled locally (no request), with a pin.
  await pn.page.fill("#search-input", "43.58, 7.12");
  await pn.page.press("#search-input", "Enter");
  await sleep(1500);
  const sc = await pn.page.evaluate(() => { const c = window.__rhe.map.getCenter(); return { lat: c.lat, lng: c.lng, pin: window.__rhe.map.querySourceFeatures("search-src").length }; });
  check(Math.abs(sc.lat - 43.58) < 0.01 && Math.abs(sc.lng - 7.12) < 0.01 && sc.pin > 0, `search: "43.58, 7.12" flies there and drops a pin (${sc.lat.toFixed(3)}, ${sc.lng.toFixed(3)})`);
  await pn.page.fill("#search-input", "48°51'30\"N 2°17'40\"E");
  await pn.page.press("#search-input", "Enter");
  await sleep(1500);
  const sd = await pn.page.evaluate(() => window.__rhe.map.getCenter());
  check(Math.abs(sd.lat - 48.858) < 0.01 && Math.abs(sd.lng - 2.294) < 0.01, `search: degrees-minutes-seconds understood (${sd.lat.toFixed(3)}, ${sd.lng.toFixed(3)})`);
  if (!process.env.NO_LIVE) {
    await pn.page.fill("#search-input", "Marseille, France");
    await pn.page.press("#search-input", "Enter");
    await pn.page.waitForFunction(() => /Nominatim|nothing|failed/.test(document.querySelector(".search .status")?.textContent || ""), null, { timeout: 15000 }).catch(() => {});
    const first = await pn.page.$("#search-results button");
    if (first) await first.click();
    await sleep(1500);
    const sa = await pn.page.evaluate(() => window.__rhe.map.getCenter());
    const sNote = (await pn.page.textContent(".search .status").catch(() => "")) || "";
    if (/search failed/.test(sNote) && pn.nominatimRefused) console.log(`INFO  search: Nominatim refused this IP (no CORS header); the app said "${sNote}"`);
    else check(Math.abs(sa.lat - 43.3) < 0.1 && Math.abs(sa.lng - 5.37) < 0.1, `search: "Marseille, France" via Nominatim (${sa.lat.toFixed(3)}, ${sa.lng.toFixed(3)})`);
  }
  check(pn.errors.length === 0, `panel/search: no console errors (${pn.errors.join(" | ")})`);
  await pn.ctx.close();

  // 7c. Day/night: one night polygon, computed locally (no requests).
  const dn = await openPage(browser, "&layers=night", "#1.5/20/0");
  await dn.page.waitForFunction(() => /sun overhead/.test(document.querySelector('[data-status="night"]').textContent), null, { timeout: 10000 }).catch(() => {});
  await sleep(1000);
  const shade = await dn.page.evaluate(() => window.__rhe.map.querySourceFeatures("night-src").length);
  check(shade > 0 && /sun overhead/.test(await dn.page.textContent('[data-status="night"]')), `day/night: night side drawn (${await dn.page.textContent('[data-status="night"]')})`);
  check(dn.errors.length === 0, `day/night: no console errors (${dn.errors.join(" | ")})`);
  await dn.ctx.close();

  // 8. Aircraft from the recorded fixture: drawn, and a click opens the card.
  const f = await openPage(browser, "&feeds=fixtures&layers=air", RIVIERA);
  await f.page.waitForFunction(() => /aircraft · fixture/.test(document.querySelector('[data-status="air"]').textContent), null, { timeout: 10000 });
  // Drawing happens a frame or two after the data arrives.
  await f.page.waitForFunction(() => window.__rhe.map.queryRenderedFeatures({ layers: ["air-planes"] }).length > 5, null, { timeout: 10000 }).catch(() => {});
  const planes = await f.page.evaluate(() => window.__rhe.map.queryRenderedFeatures({ layers: ["air-planes"] }).length);
  check(planes > 5, `fixtures: ${planes} aircraft rendered`);
  const pt = await f.page.evaluate(() => {
    const m = window.__rhe.map;
    // Pick a plane clear of the panel (top-left) and the controls.
    const pts = m.queryRenderedFeatures({ layers: ["air-planes"] }).map((f) => m.project(f.geometry.coordinates));
    const p = pts.find((q) => q.x > 320 && q.x < 1180 && q.y > 80 && q.y < 640) || pts[0];
    return { x: p.x, y: p.y };
  });
  await f.page.mouse.click(pt.x, pt.y);
  await sleep(500);
  const cardText = (await f.page.textContent(".card").catch(() => "")) || "";
  check(/ICAO hex/.test(cardText) && /Altitude/.test(cardText), "fixtures: click opens the details panel");
  check((await f.page.$$(".maplibregl-popup:not(.hover-tip)")).length === 0, "fixtures: no popup box over the map");
  const sel = await f.page.evaluate(() => window.__rhe.map.queryRenderedFeatures({ layers: ["air-planes"] }).filter((x) => x.properties.sel).length);
  check(sel === 1, `fixtures: selected aircraft highlighted (${sel})`);
  await f.page.keyboard.press("Escape");
  await sleep(300);
  check(await f.page.$eval("#details", (e) => e.hidden), "fixtures: Esc closes the details panel");
  await f.page.mouse.click(pt.x, pt.y);
  await sleep(300);
  const empty = await f.page.evaluate(() => {
    const m = window.__rhe.map;
    for (let y = 300; y < 700; y += 20) for (let x = 300; x < 900; x += 20)
      if (m.queryRenderedFeatures([x, y], { layers: ["air-planes"] }).length === 0) return { x, y };
    return null;
  });
  if (empty) {
    await f.page.mouse.click(empty.x, empty.y);
    await sleep(300);
    check(await f.page.$eval("#details", (e) => e.hidden), "fixtures: click on empty map closes the panel");
  }
  check(f.errors.length === 0, `fixtures: no console errors (${f.errors.join(" | ")})`);
  await f.ctx.close();

  // 8b. Earthquakes from the fixture; panel; switching selection between layers.
  const q = await openPage(browser, "&feeds=fixtures&layers=quakes,air", "#4/30/20");
  await q.page.waitForFunction(() => /380 quakes/.test(document.querySelector('[data-status="quakes"]').textContent), null, { timeout: 10000 }).catch(() => {});
  check(/380 quakes/.test(await q.page.textContent('[data-status="quakes"]')), `quakes fixture: ${await q.page.textContent('[data-status="quakes"]')}`);
  await q.page.waitForFunction(() => window.__rhe.map.queryRenderedFeatures({ layers: ["quakes-circles"] }).length > 5, null, { timeout: 10000 }).catch(() => {});
  const qpt = await q.page.evaluate(() => {
    const m = window.__rhe.map;
    const pts = m.queryRenderedFeatures({ layers: ["quakes-circles"] }).map((f) => m.project(f.geometry.coordinates));
    const p = pts.find((v) => v.x > 320 && v.x < 900 && v.y > 80 && v.y < 640);
    return p ? { x: p.x, y: p.y } : null;
  });
  check(!!qpt, "quakes fixture: circles rendered in view");
  if (qpt) {
    await q.page.mouse.click(qpt.x, qpt.y);
    await sleep(500);
    const qt = (await q.page.textContent("#details").catch(() => "")) || "";
    check(/earthquake/.test(qt) && /Depth/.test(qt) && /USGS event page/.test(qt), "quakes: click opens details (magnitude, depth, USGS link)");
    const qsel = await q.page.evaluate(() => window.__rhe.map.queryRenderedFeatures({ layers: ["quakes-circles"] }).filter((f) => f.properties.sel).length);
    check(qsel === 1, `quakes: selected quake highlighted (${qsel})`);
    await q.page.keyboard.press("Escape");
    await sleep(500);
    const qsel2 = await q.page.evaluate(() => window.__rhe.map.queryRenderedFeatures({ layers: ["quakes-circles"] }).filter((f) => f.properties.sel).length);
    check((await q.page.$eval("#details", (e) => e.hidden)) && qsel2 === 0, "quakes: Esc closes the panel and clears the highlight");
  }
  check(q.errors.length === 0, `quakes: no console errors (${q.errors.join(" | ")})`);
  await q.ctx.close();
  if (!process.env.NO_LIVE) {
    const ql = await openPage(browser, "&feeds=live&layers=quakes");
    const okq = await ql.page
      .waitForFunction(() => /[\d,]+ quakes · M2\.5\+, past week/.test(document.querySelector('[data-status="quakes"]').textContent), null, { timeout: 15000 })
      .then(() => true, () => false);
    check(okq, `quakes live: ${await ql.page.textContent('[data-status="quakes"]')}`);
    await expand(ql.page, "quakes");
    await ql.page.selectOption("#quakes-mag", "4.5");
    await ql.page.selectOption("#quakes-period", "month");
    const okm = await ql.page
      .waitForFunction(() => /quakes · M4\.5\+, past month/.test(document.querySelector('[data-status="quakes"]').textContent), null, { timeout: 15000 })
      .then(() => true, () => false);
    check(okm, `quakes live: M4.5+ past month from the summary feed (${await ql.page.textContent('[data-status="quakes"]')})`);
    // Any other combination goes to the FDSN query (text format).
    await ql.page.selectOption("#quakes-mag", "5.0");
    await ql.page.selectOption("#quakes-period", "5y");
    const ok5 = await ql.page
      .waitForFunction(() => /^[\d,]{5,} quakes · M5\+, past 5 years/.test(document.querySelector('[data-status="quakes"]').textContent), null, { timeout: 60000 })
      .then(() => true, () => false);
    check(ok5, `quakes live: M5+ past 5 years via FDSN (${await ql.page.textContent('[data-status="quakes"]')})`);
    // Above 20,000 events: the biggest 20,000, and the status says so.
    await ql.page.selectOption("#quakes-mag", "4.0");
    const ok20 = await ql.page
      .waitForFunction(() => /20,000 quakes · M4\+, past 5 years · the 20,000 biggest of [\d,]+/.test(document.querySelector('[data-status="quakes"]').textContent), null, { timeout: 90000 })
      .then(() => true, () => false);
    const st20 = await ql.page.textContent('[data-status="quakes"]');
    if (!ok20 && /didn't answer in time/.test(st20)) console.log(`INFO  quakes live: USGS timed out on the uncached 20k query, explained to the user (${st20})`);
    else check(ok20, `quakes live: capped at the 20,000 biggest (${st20})`);
    await ql.page.evaluate(() => window.__rhe.map.jumpTo({ zoom: 1.5, center: [140, 10] }));
    await sleep(3000);
    const drawn20 = await ql.page.evaluate(() => window.__rhe.map.queryRenderedFeatures({ layers: ["quakes-circles"] }).length);
    if (ok20) check(drawn20 > 1000, `quakes live: ${drawn20} circles drawn for 20,000 quakes`);
    await ql.page.uncheck('input[data-layer="quakes"]');
    const n0 = ql.usgs.n;
    await sleep(3000);
    check(ql.usgs.n === n0, "quakes live: off makes no requests");
    check(ql.errors.length === 0, `quakes live: no console errors (${ql.errors.join(" | ")})`);
    await ql.ctx.close();
  }

  // 8c. Antenna overlay (draft) against the synthetic decoder fixture.
  const an = await openPage(browser, "&feeds=fixtures&layers=air,mine", "#8/43.58/7.12");
  const anOk = await an.page
    .waitForFunction(() => /both \d+.* · only mine 2/.test(document.querySelector('[data-status="mine"]').textContent), null, { timeout: 10000 })
    .then(() => true, () => false);
  const anStatus = await an.page.textContent('[data-status="mine"]');
  const both = Number((anStatus.match(/both (\d+)/) || [])[1] || 0);
  check(anOk && both > 20, `antenna fixture: ${anStatus}`);
  check(/placed only by the public feed/.test(anStatus) && /only public \d+/.test(anStatus), "antenna fixture: counts position-less matches and only-public");
  await sleep(1500);
  const rings = await an.page.evaluate(() => window.__rhe.map.queryRenderedFeatures({ layers: ["air-heard"] }).length);
  const mineDrawn = await an.page.evaluate(() => window.__rhe.map.queryRenderedFeatures({ layers: ["mine-planes"] }).length);
  check(rings > 5, `antenna fixture: ${rings} green rings on aircraft heard by both`);
  check(mineDrawn >= 1, `antenna fixture: ${mineDrawn} 'only mine' aircraft drawn`);
  const decRate = an.dec.n;
  await sleep(3000);
  check(an.dec.n - decRate >= 2, `antenna fixture: polls the decoder about once a second (${an.dec.n - decRate} in 3 s)`);
  const mpt = await an.page.evaluate(() => {
    const m = window.__rhe.map;
    const f = m.queryRenderedFeatures({ layers: ["mine-planes"] })[0];
    if (!f) return null;
    const p = m.project(f.geometry.coordinates);
    return { x: p.x, y: p.y };
  });
  if (mpt) {
    await an.page.mouse.click(mpt.x, mpt.y);
    await sleep(600);
    check(/only my antenna/.test((await an.page.textContent("#details")) || ""), "antenna fixture: click on an 'only mine' aircraft opens its details");
  }
  // A public aircraft's card says whether my antenna hears it.
  const rpt = await an.page.evaluate(() => {
    const m = window.__rhe.map;
    const f = m.queryRenderedFeatures({ layers: ["air-heard"] }).find((x) => { const p = m.project(x.geometry.coordinates); return p.x > 320 && p.x < 900; });
    if (!f) return null;
    const p = m.project(f.geometry.coordinates);
    return { x: p.x, y: p.y };
  });
  if (rpt) {
    await an.page.mouse.click(rpt.x, rpt.y);
    await sleep(600);
    check(/My antenna\s*heard/.test((await an.page.textContent("#details")) || ""), "antenna fixture: public aircraft card shows 'My antenna: heard'");
  }
  await an.page.uncheck('input[data-layer="mine"]');
  await sleep(500);
  const offN = an.dec.n;
  const ringsOff = await an.page.evaluate(() => window.__rhe.map.queryRenderedFeatures({ layers: ["air-heard"] }).length);
  await sleep(3000);
  check(an.dec.n === offN && ringsOff === 0, `antenna off: no decoder requests, rings gone (${an.dec.n - offN} req, ${ringsOff} rings)`);
  check(an.errors.length === 0, `antenna fixture: no console errors (${an.errors.join(" | ")})`);
  await an.ctx.close();
  // Live: against tools/fake-decoder.mjs if it is running on :8090.
  if (!process.env.NO_LIVE) {
    const up = await fetch("http://localhost:8090/data/aircraft.json").then((r) => r.ok, () => false);
    if (up) {
      const al = await openPage(browser, "&feeds=live&layers=air,mine", "#7.5/43.58/7.12");
      const okl = await al.page
        .waitForFunction(() => /both [1-9]\d*.* · only mine 2/.test(document.querySelector('[data-status="mine"]').textContent), null, { timeout: 20000 })
        .then(() => true, () => false);
      check(okl, `antenna live (fake decoder): ${await al.page.textContent('[data-status="mine"]')}`);
      check(al.errors.length === 0, `antenna live: no console errors (${al.errors.join(" | ")})`);
      await al.ctx.close();
    } else console.log("SKIP  antenna live: fake decoder not running on :8090");
  }

  // 8d. Satellites from fixture element sets (live CelesTrak only with LIVE_SATS=1: their
  // policy is one download per data set per 2 h, and every test profile starts uncached).
  const st = await openPage(browser, "&feeds=fixtures&layers=sats", "#1.5/20/0");
  const stOk = await st.page
    .waitForFunction(() => /\d+ satellites/.test(document.querySelector('[data-status="sats"]').textContent), null, { timeout: 15000 })
    .then(() => true, () => false);
  const stText = await st.page.textContent('[data-status="sats"]');
  check(stOk && Number((stText.match(/(\d+) satellites/) || [])[1]) > 100, `satellites fixture: ${stText}`);
  await sleep(1500);
  const issAt = () => st.page.evaluate(() => {
    const src = window.__rhe.map.getSource("sats-src")._data;
    const f = (src.features || src.geojson?.features || []).find((x) => x.properties.iss);
    return f ? { lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], t: window.__rhe.registry.get("sats").posTime } : null;
  });
  const i0 = await issAt();
  await sleep(2100);
  const i1 = await issAt();
  check(i0 && i1 && (i0.lon !== i1.lon || i0.lat !== i1.lat), "satellites: positions update every second (worker)");
  const dots = await st.page.evaluate(() => window.__rhe.map.queryRenderedFeatures({ layers: ["sats-dots"] }).length);
  check(dots > 50, `satellites: ${dots} dots rendered`);
  if (i1) {
    // Centre the map on the ISS, then click the middle of the screen.
    await st.page.evaluate((p) => window.__rhe.map.jumpTo({ center: [p.lon, p.lat] }), i1);
    await sleep(1200);
    const ipt = await st.page.evaluate(() => {
      const m = window.__rhe.map;
      const src = m.getSource("sats-src")._data;
      const f = (src.features || src.geojson?.features || []).find((x) => x.properties.iss);
      const q = m.project(f.geometry.coordinates);
      return { x: q.x, y: q.y };
    });
    await st.page.mouse.click(ipt.x, ipt.y);
    await sleep(800);
    const sd = (await st.page.textContent("#details")) || "";
    check(/ISS/.test(sd) && /Altitude/.test(sd) && /per orbit/.test(sd), `satellites: click on the ISS opens its details (${sd.slice(1, 30)})`);
    const trk = await st.page.evaluate(() => window.__rhe.map.querySourceFeatures("sats-track-src").length);
    check(trk > 0, `satellites: ground track drawn (${trk} pieces)`);
    await st.page.keyboard.press("Escape");
    await sleep(500);
    const trk2 = await st.page.evaluate(() => window.__rhe.map.querySourceFeatures("sats-track-src").length);
    check(trk2 === 0, "satellites: Esc removes the ground track");
  }
  const satBefore = Number((stText.match(/(\d+) satellites/) || [])[1]);
  await expand(st.page, "sats");
  await st.page.uncheck('input[data-group="weather"]');
  await st.page.waitForFunction((b) => Number((document.querySelector('[data-status="sats"]').textContent.match(/(\d+) satellites/) || [])[1]) < b, satBefore, { timeout: 8000 }).catch(() => {});
  const satAfter = Number(((await st.page.textContent('[data-status="sats"]')).match(/(\d+) satellites/) || [])[1]);
  check(satAfter < satBefore, `satellites: unticking Weather drops the count (${satBefore} → ${satAfter})`);
  // ISS position vs an independent tracker (wheretheiss.at) at the same instant.
  if (!process.env.NO_LIVE) {
    const me = await issAt();
    const ref = await fetch(`https://api.wheretheiss.at/v1/satellites/25544/positions?timestamps=${Math.round(me.t / 1000)}`).then((r) => r.json(), () => null);
    if (ref && ref[0]) {
      const r = Math.PI / 180;
      const a = Math.sin(((ref[0].latitude - me.lat) * r) / 2) ** 2 + Math.cos(me.lat * r) * Math.cos(ref[0].latitude * r) * Math.sin(((ref[0].longitude - me.lon) * r) / 2) ** 2;
      const km = 2 * 6371 * Math.asin(Math.sqrt(a));
      check(km < 25, `satellites: ISS within ${km.toFixed(1)} km of wheretheiss.at (limit 25 km)`);
    } else console.log("SKIP  satellites: wheretheiss.at unreachable");
  }
  check(st.errors.length === 0, `satellites: no console errors (${st.errors.join(" | ")})`);
  await st.ctx.close();
  if (process.env.LIVE_SATS) {
    const sl = await openPage(browser, "&feeds=live&layers=sats", "#1.5/20/0");
    const okl = await sl.page
      .waitForFunction(() => /\d+ satellites · downloaded \d+ min ago/.test(document.querySelector('[data-status="sats"]').textContent), null, { timeout: 30000 })
      .then(() => true, () => false);
    check(okl, `satellites live (CelesTrak): ${await sl.page.textContent('[data-status="sats"]')}`);
    const cel = sl.sat.n;
    await sl.page.reload();
    await sl.page.waitForFunction(() => /\d+ satellites/.test(document.querySelector('[data-status="sats"]')?.textContent || ""), null, { timeout: 15000 }).catch(() => {});
    check(sl.sat.n === cel, `satellites live: reload uses the 2 h cache (${sl.sat.n - cel} new CelesTrak requests)`);
    check(sl.errors.length === 0, `satellites live: no console errors (${sl.errors.join(" | ")})`);
    await sl.ctx.close();
  }

  // 8f. LoRa gateways from the static snapshot (never Packet Broker's API from the page).
  const lo = await openPage(browser, "&layers=lora", "#4.5/48/6");
  const loOk = await lo.page
    .waitForFunction(() => /[\d,]+ gateways \([\d,]+ online\) · snapshot/.test(document.querySelector('[data-status="lora"]').textContent), null, { timeout: 15000 })
    .then(() => true, () => false);
  const loText = await lo.page.textContent('[data-status="lora"]');
  const total = Number((loText.match(/([\d,]+) gateways/) || [])[1]?.replace(/,/g, "") || 0);
  const onl = Number((loText.match(/\(([\d,]+) online/) || [])[1]?.replace(/,/g, "") || 0);
  check(loOk && total > 1000 && onl > 100, `lora: ${loText}`);
  await sleep(1500);
  const clusters = await lo.page.evaluate(() => window.__rhe.map.queryRenderedFeatures({ layers: ["lora-clusters"] }).length);
  check(clusters > 5, `lora: ${clusters} clusters drawn at zoom 4.5`);
  // Click the biggest cluster near the centre: the map zooms in.
  const cpt = await lo.page.evaluate(() => {
    const m = window.__rhe.map;
    const f = m.queryRenderedFeatures({ layers: ["lora-clusters"] })
      .map((x) => ({ x, p: m.project(x.geometry.coordinates) }))
      .filter((o) => o.p.x > 320 && o.p.x < 950 && o.p.y > 80 && o.p.y < 640)
      .sort((a, b) => b.x.properties.point_count - a.x.properties.point_count)[0];
    return f ? { x: f.p.x, y: f.p.y } : null;
  });
  const z0 = await lo.page.evaluate(() => window.__rhe.map.getZoom());
  if (cpt) {
    await lo.page.mouse.click(cpt.x, cpt.y);
    await sleep(1500);
  }
  const z1 = await lo.page.evaluate(() => window.__rhe.map.getZoom());
  check(z1 > z0 + 0.5, `lora: clicking a cluster zooms in (${z0.toFixed(1)} → ${z1.toFixed(1)})`);
  // Zoom right in on the densest area and click a single gateway.
  await lo.page.evaluate(() => window.__rhe.map.jumpTo({ zoom: 13 }));
  await sleep(1500);
  const gpt = await lo.page.evaluate(() => {
    const m = window.__rhe.map;
    const f = m.queryRenderedFeatures({ layers: ["lora-points"] }).map((x) => m.project(x.geometry.coordinates)).find((p) => p.x > 320 && p.x < 950 && p.y > 80 && p.y < 640);
    return f ? { x: f.x, y: f.y } : null;
  });
  if (gpt) {
    await lo.page.mouse.click(gpt.x, gpt.y);
    await sleep(600);
    const gd = (await lo.page.textContent("#details")) || "";
    check(/LoRaWAN gateway/.test(gd) && /Network/.test(gd) && /rounded/.test(gd), "lora: click on a gateway opens its details");
    await lo.page.keyboard.press("Escape");
  } else console.log("SKIP  lora: no single gateway in view at zoom 13");
  await expand(lo.page, "lora");
  await lo.page.uncheck("#lora-offline");
  await sleep(800);
  const onlyText = await lo.page.textContent('[data-status="lora"]');
  check(new RegExp(`^${onl.toLocaleString("en")} gateways`).test(onlyText), `lora: 'online only' shows ${onl} (${onlyText.slice(0, 40)})`);
  await lo.page.check("#lora-offline");
  check(lo.lora.snap === 1 && lo.lora.api === 0, `lora: snapshot loaded once, Packet Broker API never called (${lo.lora.snap}/${lo.lora.api})`);
  await lo.page.uncheck('input[data-layer="lora"]');
  await sleep(500);
  const gone = await lo.page.evaluate(() => window.__rhe.map.queryRenderedFeatures({ layers: ["lora-clusters", "lora-points"] }).length);
  check(gone === 0, "lora off: nothing drawn");
  check(lo.errors.length === 0, `lora: no console errors (${lo.errors.join(" | ")})`);
  await lo.ctx.close();

  // 8g. Ships: saved sample, then the live relay (worker/, `npx wrangler dev` on :8787) if running.
  const sh = await openPage(browser, "&feeds=fixtures&layers=ships", "#8/43.4/7.3");
  const shOk = await sh.page
    .waitForFunction(() => /[\d,]+ ships · saved sample/.test(document.querySelector('[data-status="ships"]').textContent), null, { timeout: 10000 })
    .then(() => true, () => false);
  check(shOk, `ships fixture: ${await sh.page.textContent('[data-status="ships"]')}`);
  await sleep(1500);
  const shPts = await sh.page.evaluate(() => {
    const m = window.__rhe.map;
    return m.queryRenderedFeatures({ layers: ["ships-icons"] }).map((f) => m.project(f.geometry.coordinates)).filter((p) => p.x > 320 && p.x < 900 && p.y > 80 && p.y < 640).map((p) => ({ x: p.x, y: p.y }));
  });
  check(shPts.length > 5, `ships fixture: ${shPts.length} ships drawn in view`);
  if (shPts[0]) {
    await sh.page.mouse.click(shPts[0].x, shPts[0].y);
    await sleep(500);
    const sc2 = (await sh.page.textContent("#details")) || "";
    check(/MMSI/.test(sc2) && /Speed/.test(sc2) && /Type/.test(sc2), "ships fixture: click opens the ship's details");
  }
  check(sh.errors.length === 0, `ships fixture: no console errors (${sh.errors.join(" | ")})`);
  await sh.ctx.close();
  if (!process.env.NO_LIVE) {
    const up = await fetch("http://localhost:8787/health").then((r) => r.ok, () => false);
    // NO_AIS=1: AISStream allows one connection per key; don't compete with a deployed relay.
    if (up && process.env.NO_AIS) console.log("SKIP  ships live: NO_AIS set");
    else if (up) {
      const sl = await openPage(browser, "&feeds=live&layers=ships", "#9/43.55/7.1");
      const slOk = await sl.page
        .waitForFunction(() => /[1-9][\d,]* ships · AISStream via relay/.test(document.querySelector('[data-status="ships"]').textContent), null, { timeout: 30000 })
        .then(() => true, () => false);
      check(slOk, `ships live (relay): ${await sl.page.textContent('[data-status="ships"]')}`);
      await sl.page.evaluate(() => window.__rhe.map.jumpTo({ zoom: 3.5 }));
      await sleep(1500);
      check(/zoom in/.test(await sl.page.textContent('[data-status="ships"]')), "ships live: wide view asks to zoom in");
      await sl.page.uncheck('input[data-layer="ships"]');
      await sleep(500);
      check(await sl.page.evaluate(() => window.__rhe.registry.get("ships").ws === undefined), "ships live: off closes the connection to the relay");
      check(sl.errors.length === 0, `ships live: no console errors (${sl.errors.join(" | ")})`);
      await sl.ctx.close();
    } else console.log("SKIP  ships live: relay not running on :8787");
    // A relay that isn't there: a clear message, no crash.
    const sx = await openPage(browser, "&feeds=live&layers=ships", "#9/43.55/7.1");
    await sx.page.evaluate(() => localStorage.setItem("rhe.relay.url", "http://localhost:9"));
    await sx.page.reload();
    await sx.page.waitForFunction(() => /not reachable/.test(document.querySelector('[data-status="ships"]')?.textContent || ""), null, { timeout: 15000 }).catch(() => {});
    check(/not reachable/.test(await sx.page.textContent('[data-status="ships"]')), `ships: unreachable relay explained (${await sx.page.textContent('[data-status="ships"]')})`);
    await sx.ctx.close();
  }

  // 8h. Webcams (Windy via the relay) and hand-picked live video (YouTube).
  const wf = await openPage(browser, "&feeds=fixtures&layers=webcams,streams", "#8/43.6/7.15");
  await wf.page.waitForFunction(() => /webcams in view · saved sample/.test(document.querySelector('[data-status="webcams"]').textContent), null, { timeout: 10000 }).catch(() => {});
  check(/14 webcams in view/.test(await wf.page.textContent('[data-status="webcams"]')), `webcams fixture: ${await wf.page.textContent('[data-status="webcams"]')}`);
  check(/Webcams provided by windy\.com – add new webcam/.test(await wf.page.textContent("#credits")), "webcams: Windy credit with its links in the attribution line");
  check((await wf.page.$$eval('#credits a[href^="https://www.windy.com"]', (l) => l.length)) === 2, "webcams: credit links to windy.com and the add-webcam page");
  check(/24 hand-picked live webcams/.test(await wf.page.textContent('[data-status="streams"]')), `streams: ${await wf.page.textContent('[data-status="streams"]')}`);
  // Nothing from YouTube or Windy's image servers before a click.
  check(wf.requests.filter((u) => /youtube|ytimg|imgproxy\.windy/.test(u)).length === 0, "webcams/streams: no YouTube or Windy image request before a click");
  // Wait until a feature matching `pred` (JS expression over its properties `p`) is drawn, then click it.
  const clickFeature = async (pg, layer, pred) => {
    const pt = await pg
      .waitForFunction(
        ([layer, pred]) => {
          const m = window.__rhe.map;
          const f = m.queryRenderedFeatures({ layers: [layer] }).find((x) => new Function("p", `return ${pred}`)(x.properties));
          return f ? m.project(f.geometry.coordinates) : false;
        },
        [layer, pred],
        { timeout: 15000 },
      )
      .then((h) => h.jsonValue(), () => null);
    if (pt) await pg.mouse.click(pt.x, pt.y);
    return pt;
  };
  await clickFeature(wf.page, "webcams-dots", "p.n === 1 && p.active");
  await sleep(500);
  const wcard = await wf.page.textContent("#details").catch(() => "");
  check(/Sample: harbour view/.test(wcard) && /updated/.test(wcard), `webcams fixture: click opens the camera card`);
  await wf.page.keyboard.press("Escape");
  await wf.page.evaluate(() => window.__rhe.map.jumpTo({ center: [-155.28, 19.41], zoom: 6 }));
  await sleep(1500);
  await clickFeature(wf.page, "streams-icons", "p.video === 'ygQ1iv8iZr8'");
  await sleep(1000);
  const sframe = await wf.page.$eval("#details iframe", (f) => f.src).catch(() => "");
  check(/^https:\/\/www\.youtube-nocookie\.com\/embed\/ygQ1iv8iZr8\?autoplay=1&mute=1/.test(sframe), `streams: click plays the stream muted from youtube-nocookie (${sframe.slice(0, 70)})`);
  await wf.page.keyboard.press("Escape");
  check((await wf.page.$("#details iframe")) === null, "streams: closing the card removes the player");
  await wf.page.evaluate(() => window.__rhe.map.jumpTo({ center: [8.742, 41.922], zoom: 7 }));
  await sleep(800);
  await clickFeature(wf.page, "streams-icons", "p.video === 'u89M4sHi0jA'");
  await sleep(500);
  check(
    (await wf.page.$("#details iframe")) === null && /Watch on YouTube/.test(await wf.page.textContent("#details")),
    "streams: no-embed stream (Ajaccio) offers a YouTube link instead of a player",
  );
  check(wf.errors.length === 0, `webcams/streams fixture: no console errors (${wf.errors.join(" | ")})`);
  await wf.ctx.close();
  if (!process.env.NO_LIVE && (await fetch("http://localhost:8787/health").then((r) => r.ok, () => false))) {
    const wl = await openPage(browser, "&feeds=live&layers=webcams", "#9/43.6/7.1");
    const wlOk = await wl.page
      .waitForFunction(() => /^[1-9][\d,]* webcams in view/.test(document.querySelector('[data-status="webcams"]').textContent), null, { timeout: 20000 })
      .then(() => true, () => false);
    check(wlOk, `webcams live (relay): ${await wl.page.textContent('[data-status="webcams"]')}`);
    await clickFeature(wl.page, "webcams-dots", "p.n === 1 && p.active");
    await wl.page.waitForFunction(() => document.querySelector("#details img.media")?.complete, null, { timeout: 15000 }).catch(() => {});
    const img = await wl.page.$eval("#details img.media", (i) => ({ src: i.src, w: i.naturalWidth, shown: i.getBoundingClientRect().width })).catch(() => null);
    check(!!img && /^https:\/\/imgproxy\.windy\.com\//.test(img.src) && img.w > 0, `webcams live: card shows Windy's picture (${img && `${img.w}px wide`})`);
    check(!!img && img.shown <= img.w + 0.5, `webcams live: picture never stretched (${img && `${Math.round(img.shown)} ≤ ${img.w}`})`);
    const tl = await wl.page.$("#details .links button");
    if (tl) await tl.click();
    const player = await wl.page.$eval("#details iframe", (f) => f.src).catch(() => "");
    check(/^https:\/\/webcams\.windy\.com\/webcams\/public\/embed\/player\/\d+\/day$/.test(player), "webcams live: timelapse button opens Windy's player");
    await wl.page.keyboard.press("Escape");
    // Zoomed out over Europe: clusters with counts.
    await wl.page.evaluate(() => window.__rhe.map.jumpTo({ center: [8, 46], zoom: 4.5 }));
    await wl.page.waitForFunction(() => window.__rhe.map.queryRenderedFeatures({ layers: ["webcams-count"] }).length > 3, null, { timeout: 20000 }).catch(() => {});
    const nClusters = await wl.page.evaluate(() => window.__rhe.map.queryRenderedFeatures({ layers: ["webcams-count"] }).length);
    check(nClusters > 3, `webcams live: ${nClusters} clusters with counts over Europe (${await wl.page.textContent('[data-status="webcams"]')})`);
    await wl.page.uncheck('input[data-layer="webcams"]');
    const before = wl.requests.length;
    await wl.page.evaluate(() => window.__rhe.map.jumpTo({ center: [2.35, 48.85], zoom: 9 }));
    await sleep(2000);
    check(wl.requests.slice(before).filter((u) => /webcams\/tile/.test(u)).length === 0, "webcams off: no tile requests when moving the map");
    check(wl.errors.length === 0, `webcams live: no console errors (${wl.errors.join(" | ")})`);
    await wl.ctx.close();
  } else console.log("SKIP  webcams live: relay not running on :8787");

  // 8e. Background maps (needs internet): switching keeps the data layers and their data.
  if (!process.env.NO_LIVE) {
    const bm = await openPage(browser, "&feeds=fixtures&layers=quakes,air&map=light", "#7/43.6/7.2", true);
    await bm.page.waitForFunction(() => window.__rhe.map.queryRenderedFeatures({ layers: ["air-planes"] }).length > 3, null, { timeout: 20000 }).catch(() => {});
    const count = () => bm.page.evaluate(() => ({
      planes: window.__rhe.map.queryRenderedFeatures({ layers: ["air-planes"] }).length,
      quakes: window.__rhe.map.getLayer("quakes-circles") ? 1 : 0,
      icon: window.__rhe.map.hasImage("plane"),
    }));
    const c0 = await count();
    check(c0.planes > 3, `basemap light: ${c0.planes} aircraft drawn`);
    for (const id of ["bw", "dark", "colour", "sat", "today"]) {
      await bm.page.selectOption("#basemap-select", id);
      await bm.page.waitForFunction(() => window.__rhe.map.isStyleLoaded(), null, { timeout: 20000 }).catch(() => {});
      await sleep(2500);
      const c = await count();
      check(c.planes > 3 && c.quakes === 1 && c.icon, `basemap ${id}: data layers kept (${c.planes} aircraft, icons ${c.icon})`);
      check(bm.page.url().includes(`map=${id}`), `basemap ${id}: remembered in the URL`);
    }
    check(bm.tiles.eox > 0, `basemap sat: EOX tiles loaded (${bm.tiles.eox})`);
    check(bm.tiles.gibs > 0, `basemap today: NASA GIBS tiles loaded (${bm.tiles.gibs})`);
    check(bm.tiles.bad === 0, `basemap: no failed imagery tiles (${bm.tiles.bad})`);
    // Zoomed past what 250 m imagery resolves: the picker says so (and not when zoomed out).
    await bm.page.evaluate(() => window.__rhe.map.jumpTo({ zoom: 11 }));
    await sleep(800);
    const blur = (await bm.page.textContent("#basemap-blur")) || "";
    await bm.page.evaluate(() => window.__rhe.map.jumpTo({ zoom: 6 }));
    await sleep(800);
    const blur2 = (await bm.page.textContent("#basemap-blur")) || "";
    check(/250 m per pixel/.test(blur) && blur2 === "", `basemap today: blur note at zoom 11 only ("${blur.slice(0, 40)}…")`);
    await bm.page.evaluate(() => window.__rhe.map.jumpTo({ zoom: 7 }));
    const roads = await bm.page.evaluate(() => !!window.__rhe.map.getLayer("highway-name-major"));
    check(roads, "basemap imagery: road names drawn over the imagery");
    // Borders off, names kept.
    await bm.page.uncheck("#overlay-borders");
    await bm.page.waitForFunction(() => window.__rhe.map.isStyleLoaded() && !window.__rhe.map.getLayer("boundary_2"), null, { timeout: 15000 }).catch(() => {});
    await sleep(1500);
    const ov = await bm.page.evaluate(() => ({ b: !!window.__rhe.map.getLayer("boundary_2"), p: !!window.__rhe.map.getLayer("label_city"), pl: window.__rhe.map.queryRenderedFeatures({ layers: ["air-planes"] }).length }));
    check(!ov.b && ov.p && ov.pl > 3, `basemap imagery: borders off, names kept, data kept (${JSON.stringify(ov)})`);
    await bm.page.check("#overlay-borders");
    await sleep(1500);
    const labels = await bm.page.evaluate(() => !!window.__rhe.map.getLayer("label_city"));
    check(labels, "basemap today: place names drawn over the imagery");
    // MapTiler HD, only when a key is passed in at run time (MAPTILER_KEY env; never stored in the repo).
    if (process.env.MAPTILER_KEY) {
      let mtBad = 0;
      let mtOk = 0;
      bm.page.on("response", (r) => { if (/api\.maptiler\.com/.test(r.url())) r.status() === 200 ? mtOk++ : mtBad++; });
      await bm.page.evaluate((k) => localStorage.setItem("rhe.maptiler.key", k), process.env.MAPTILER_KEY);
      await bm.page.selectOption("#basemap-select", "sathd");
      await sleep(4000);
      const c = await count();
      check(mtOk > 0 && mtBad === 0 && c.planes > 3, `basemap sathd: MapTiler tiles load (${mtOk} ok, ${mtBad} failed), data kept`);
      await bm.page.selectOption("#basemap-select", "light");
      await sleep(1500);
    }
    // MapTiler without a key: explains, keeps the current map.
    await bm.page.evaluate(() => localStorage.removeItem("rhe.maptiler.key"));
    await bm.page.selectOption("#basemap-select", "sathd");
    await sleep(800);
    const st2 = (await bm.page.textContent(".basemap .status")) || "";
    check(/MapTiler key/.test(st2) && !!(await bm.page.$("#maptiler-key")), `basemap sathd without key: asks for a key ("${st2}")`);
    // Reload keeps the choice (URL); a bare address keeps it via localStorage.
    await bm.page.selectOption("#basemap-select", "bw");
    await sleep(2000);
    await bm.page.goto(`${BASE}#6/43.6/7.2`);
    await bm.page.waitForFunction(() => window.__rhe !== undefined, null, { timeout: 20000 });
    check((await bm.page.$eval("#basemap-select", (e) => e.value)) === "bw", "basemap: choice remembered after reload");
    check(bm.errors.length === 0, `basemap: no console errors (${bm.errors.join(" | ")})`);
    await bm.ctx.close();
    const df = await openPage(browser, "", "#6/43.6/7.2", true);
    check((await df.page.$eval("#basemap-select", (e) => e.value)) === "colour", "basemap: Colour is the default for a new visitor");
    await df.ctx.close();
  }

  // 9. Zoomed out below zoom 5: no aircraft requests at all.
  const z = await openPage(browser, "&feeds=live&layers=air", "#4/43.58/7.12");
  await sleep(4000);
  check(z.proxy.n === 0, `zoom 4: 0 aircraft requests (got ${z.proxy.n})`);
  check(/zoom in/.test(await z.page.textContent('[data-status="air"]')), "zoom 4: status says zoom in");
  if (!process.env.NO_LIVE) {
    await z.page.evaluate(() => window.__rhe.map.jumpTo({ zoom: 9 }));
    // adsb.lol can be slow, or rate-limit this test's burst (the app then pauses 30 s).
    const fast = await z.page
      .waitForFunction(() => /every 5 s/.test(document.querySelector('[data-status="air"]').textContent), null, { timeout: 70000 })
      .then(() => true, () => false);
    check(fast, `zoom 9: polls every 5 s (${await z.page.textContent('[data-status="air"]')})`);
  }
  await z.ctx.close();

  // 10. Live feed through the dev proxy (needs internet in the test environment).
  if (!process.env.NO_LIVE) {
    const l = await openPage(browser, "&feeds=live&layers=air", "#6.5/46.5/3"); // busy airspace over France
    const liveOk = await l.page
      .waitForFunction(() => /\d+ aircraft · adsb\.lol/.test(document.querySelector('[data-status="air"]').textContent), null, { timeout: 20000 })
      .then(() => true, () => false);
    check(liveOk, `live: ${await l.page.textContent('[data-status="air"]')}`);
    // Between polls, aircraft move once a second without new requests (dead reckoning).
    await sleep(2000); // let the planes render first
    const snap = () => l.page.evaluate(() => {
      const src = window.__rhe.map.getSource("air-src")._data; // last data handed to the map
      const f = (src.features || src.geojson?.features || []).find((x) => x.properties.gs > 300);
      return f ? f.properties.hex + "@" + f.geometry.coordinates.join(",") : "";
    });
    const reqBefore = l.proxy.n;
    const s0 = await snap();
    await sleep(1600);
    const s1 = await snap();
    if (l.proxy.n === reqBefore) check(s0 !== "" && s0 !== s1, `live: aircraft move between polls (${s0 ? "moved" : "no data"})`);
    else console.log("SKIP  live: a poll landed during the motion check");
    const trails = await l.page.evaluate(() => window.__rhe.map.querySourceFeatures("air-trails-src").length);
    check(trails === 0, `live: no paths drawn while nothing is selected (got ${trails})`);
    // The details panel keeps following its aircraft on the next updates.
    const lp = await l.page.evaluate(() => {
      const m = window.__rhe.map;
      const pts = m.queryRenderedFeatures({ layers: ["air-planes"] }).filter((f) => !f.properties.ground && f.properties.gs > 150)
        .map((f) => m.project(f.geometry.coordinates));
      return pts.find((q) => q.x > 320 && q.x < 1180 && q.y > 80 && q.y < 640) || null;
    });
    if (lp) {
      await l.page.mouse.click(lp.x, lp.y);
      await sleep(500);
      const hex0 = await l.page.evaluate(() => (document.querySelector("#details .card")?.textContent.match(/ICAO hex([0-9A-F]{6})/) || [])[1] || "");
      await sleep(11000);
      const hex1 = await l.page.evaluate(() => (document.querySelector("#details .card")?.textContent.match(/ICAO hex([0-9A-F]{6})/) || [])[1] || "gone");
      check(hex0 && hex1 === hex0, `live: details panel stays on its aircraft across updates (${hex0} → ${hex1})`);
      // adsb.lol's trace server is sometimes slow: give the path up to 20 s to resolve.
      await l.page.waitForFunction(() => !/loading/.test(document.querySelector(".card")?.textContent || ""), null, { timeout: 20000 }).catch(() => {});
      const ct = (await l.page.textContent(".card").catch(() => "")) || "";
      check(/Route/.test(ct) && !/looking up/.test(ct), `live: card shows a route result (${(ct.match(/Route(.*?)ICAO/) || [])[1] || "none"})`);
      check(/Departed|Path/.test(ct) && !/loading/.test(ct), `live: card shows flight path info (${(ct.match(/(Departed|Path)(.*?)ICAO/) || [])[0] || "none"})`);
      const trails2 = await l.page.evaluate(() => window.__rhe.map.querySourceFeatures("air-trails-src").length);
      check(trails2 > 0, `live: a path is drawn for the selected aircraft (${trails2} tile pieces)`);
      // Zoomed out below 5: the selected aircraft stays (one request for just it), with its path.
      await l.page.evaluate(() => window.__rhe.map.jumpTo({ zoom: 3.5 }));
      await l.page.waitForFunction(() => /following/.test(document.querySelector('[data-status="air"]').textContent), null, { timeout: 30000 }).catch(() => {});
      await sleep(1500); // let the map redraw with only the followed plane
      const fol = await l.page.textContent('[data-status="air"]');
      const folDrawn = await l.page.evaluate(() => window.__rhe.map.queryRenderedFeatures({ layers: ["air-planes"] }).length);
      const folOpen = !(await l.page.$eval("#details", (e) => e.hidden));
      check(/following/.test(fol) && folDrawn === 1 && folOpen, `live: zoomed out, the selected plane stays (${fol.slice(0, 50)}; ${folDrawn} drawn, panel ${folOpen ? "open" : "closed"})`);
      // Panned far away at a normal zoom: still followed.
      await l.page.evaluate(() => window.__rhe.map.jumpTo({ zoom: 7, center: [-60, 10] }));
      await sleep(12000);
      const far = await l.page.evaluate(() => window.__rhe.map.getSource("air-src")._data);
      const farFeats = far.features || far.geojson?.features || [];
      check(farFeats.some((f) => f.properties.sel), "live: panned far away, the selected plane is still tracked");
      await l.page.evaluate(() => window.__rhe.map.jumpTo({ zoom: 6.5, center: [3, 46.5] }));
      await l.page.click("#details .close").catch(() => {});
      await sleep(1500);
      const trails3 = await l.page.evaluate(() => window.__rhe.map.querySourceFeatures("air-trails-src").length);
      check(trails3 === 0, `live: path disappears when the card closes (got ${trails3})`);
    } else {
      console.log("SKIP  live: no fast aircraft in view to test card following");
    }
    // If the feed rate-limited this test's burst, the app pauses 30 s: wait that out first.
    await l.page.waitForFunction(() => !/slow down/.test(document.querySelector('[data-status="air"]').textContent), null, { timeout: 45000 }).catch(() => {});
    await sleep(2500);
    const beforePan = l.proxy.n;
    await l.page.evaluate(() => window.__rhe.map.panBy([300, 0], { duration: 0 }));
    await sleep(3500);
    check(l.proxy.n > beforePan, "live: panning triggers a new query");
    await expand(l.page, "air");
    await l.page.selectOption('li:has([data-layer="air"]) select', "adsbfi");
    const fiOk = await l.page
      .waitForFunction(() => /aircraft · adsb\.fi/.test(document.querySelector('[data-status="air"]').textContent), null, { timeout: 20000 })
      .then(() => true, () => false);
    check(fiOk, `live: switch to adsb.fi (${await l.page.textContent('[data-status="air"]')})`);
    check((await l.page.textContent("#credits")).includes("adsb.fi"), "live: credit line follows the source");
    await l.page.uncheck('input[data-layer="air"]');
    await sleep(500);
    const offStart = l.proxy.n;
    await sleep(11000);
    check(l.proxy.n === offStart, `live off: 0 aircraft requests in 11 s (got ${l.proxy.n - offStart})`);
    check(l.errors.length === 0, `live: no console errors (${l.errors.join(" | ")})`);
    await l.ctx.close();
  }

  await browser.close();
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
