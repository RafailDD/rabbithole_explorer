// npm run selfhost: run the whole thing on this computer, with your own keys.
//   relay (worker/, Cloudflare's runtime running locally) on http://localhost:8787
//   app (Vite dev server)                                on http://localhost:5173
// No Cloudflare account needed. Ctrl+C stops both. Keys: npm run setup (worker/.dev.vars).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const worker = fileURLToPath(new URL("../worker", import.meta.url));
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

if (Number(process.versions.node.split(".")[0]) < 22) {
  console.error(`Node 22 or newer needed (this is ${process.version}).`);
  process.exit(1);
}
if (!existsSync(new URL("../worker/node_modules", import.meta.url))) {
  console.log("First run: installing the relay's tools (worker/, about a minute)…");
  if (spawnSync(npm, ["install"], { cwd: worker, stdio: "inherit" }).status !== 0) process.exit(1);
}
const vars = existsSync(new URL("../worker/.dev.vars", import.meta.url)) ? readFileSync(new URL("../worker/.dev.vars", import.meta.url), "utf8") : "";
for (const [key, what] of [["AISSTREAM_KEY", "ships"], ["WINDY_KEY", "webcams"]]) {
  if (!new RegExp(`^${key}=.+`, "m").test(vars)) console.log(`Note: no ${key}, so ${what} won't load. Add it with: npm run setup`);
}

const procs = [];
function run(tag, cmd, args, cwd) {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  const out = (buf) => {
    for (const line of buf.toString().split("\n")) if (line.trim()) console.log(`[${tag}] ${line}`);
  };
  p.stdout.on("data", out);
  p.stderr.on("data", out);
  p.on("exit", (code) => {
    console.log(`[${tag}] stopped${code ? ` (exit code ${code})` : ""}`);
    stop();
  });
  procs.push(p);
}
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const p of procs) p.kill();
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

run("relay", npx, ["wrangler", "dev", "--port", "8787"], worker);
run("app", npx, ["vite", "--port", "5173", "--strictPort"], root);
console.log('\nOpen http://localhost:5173 and pick "Relay: This computer" in the panel. Ctrl+C stops both.\n');
