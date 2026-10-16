import { defineConfig } from "vite";
import { feedProxy } from "./tools/feed-proxy";

export default defineConfig({
  // Relative asset paths, so the same build works on GitHub Pages under /rabbithole_explorer/.
  base: "./",
  server: { port: 5173 },
  plugins: [feedProxy()],
  // MapLibre v6 runs its tile parsing in an ES-module Web Worker (see src/map.ts).
  worker: { format: "es" },
  // MapLibre alone is ~1 MB minified (~280 kB gzipped); that is expected.
  build: { chunkSizeWarningLimit: 1200 },
});
