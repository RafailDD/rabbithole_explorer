// npm run setup: store your own AISStream and Windy keys for the self-hosted relay.
// Writes worker/.dev.vars (git-ignored, stays on this computer). Run again any time to change
// a key; press Enter to keep the current one. Aircraft need no key.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const FILE = new URL("../worker/.dev.vars", import.meta.url);
const KEYS = [
  ["AISSTREAM_KEY", "AISStream key (ships)", "free at https://aisstream.io (sign in with GitHub, then API Keys)"],
  ["WINDY_KEY", "Windy Webcams key (webcams)", "free at https://api.windy.com (Webcams API, free plan)"],
];

const lines = existsSync(FILE) ? readFileSync(FILE, "utf8").split("\n") : [];
const current = new Map(lines.map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
const mask = (v) => (v ? `${v.slice(0, 4)}…${v.slice(-2)}` : "not set");

const rl = createInterface({ input: process.stdin, terminal: false });
const input = rl[Symbol.asyncIterator](); // one answer per line, typed or piped
console.log("Keys for your own relay. They are saved only in worker/.dev.vars on this computer.\n");
for (const [name, label, where] of KEYS) {
  console.log(`${label}: ${where}`);
  process.stdout.write(`  ${name} [${mask(current.get(name))}] (Enter = keep): `);
  const answer = String((await input.next()).value ?? "").trim();
  if (answer) current.set(name, answer);
  console.log();
}
rl.close();

// Keep any other settings already in the file (e.g. SHIPS_MAX_SPAN_DEG), rewrite the keys.
const others = lines.filter((l) => l.trim() && !/^(AISSTREAM_KEY|WINDY_KEY)=/.test(l) && !l.startsWith("# rabbithole"));
const out = ["# rabbithole relay settings for `npm run selfhost` (git-ignored: never commit this file)"];
for (const [name] of KEYS) if (current.get(name)) out.push(`${name}=${current.get(name)}`);
writeFileSync(FILE, [...out, ...others, ""].join("\n"));
console.log("Saved worker/.dev.vars. Start everything with: npm run selfhost");
