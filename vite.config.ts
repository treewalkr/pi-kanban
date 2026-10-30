import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// The brand button (web/src/lib/Brand.svelte) scrambles to this on click.
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  root: "web",
  plugins: [svelte()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: { outDir: "dist" }, // relative to root → web/dist
  server: { port: 5174 },
});
