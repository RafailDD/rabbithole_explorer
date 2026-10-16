// Checks public/data/live-streams.json: is each YouTube stream still live and embeddable?
// Usage: npm run streams  (add --write to store today's date in "checked" when all pass)
// Reads the public watch page once per stream; run it by hand now and then, not on a timer.
import { readFileSync, writeFileSync } from "node:fs";

const FILE = new URL("../public/data/live-streams.json", import.meta.url);
const data = JSON.parse(readFileSync(FILE, "utf8"));
let bad = 0;

// The watch page is the best source, but YouTube asks datacenter IPs to sign in ("not a bot").
// Fallback: oEmbed answers 200 only for an existing, embeddable video, and the "_live"
// thumbnail exists only while a stream is live.
async function check(id) {
  const res = await fetch(`https://www.youtube.com/watch?v=${id}`, { headers: { "accept-language": "en", "user-agent": "Mozilla/5.0" } });
  const html = await res.text();
  if (!/not a bot/.test(html)) {
    if (/"status":"(ERROR|UNPLAYABLE)"/.test(html)) return "GONE";
    if (/"playableInEmbed":false/.test(html)) return "NO EMBED";
    return /"isLiveNow":true/.test(html) ? "live" : "NOT LIVE";
  }
  const o = await fetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${id}`);
  if (o.status === 401 || o.status === 403) return "NO EMBED";
  if (!o.ok) return "GONE";
  return liveThumb(id);
}

async function liveThumb(id) {
  const t = await fetch(`https://i.ytimg.com/vi/${id}/hqdefault_live.jpg`, { method: "HEAD" });
  return t.ok ? "live" : "NOT LIVE";
}
for (const s of data.streams) {
  let verdict;
  try {
    verdict = await check(s.video);
    // Link-only streams (owner disallows embedding) only need to be live.
    if (s.embed === false && verdict === "NO EMBED") verdict = await liveThumb(s.video);
  } catch (err) {
    verdict = `ERROR ${err.message}`;
  }
  if (verdict !== "live") bad++;
  console.log(`${verdict.padEnd(9)} ${s.video}  ${s.title}`);
}
console.log(`\n${data.streams.length - bad}/${data.streams.length} live and embeddable`);
if (process.argv.includes("--write") && bad === 0) {
  data.checked = new Date().toISOString().slice(0, 10);
  writeFileSync(FILE, JSON.stringify(data, null, 2) + "\n");
}
process.exitCode = bad ? 1 : 0;
