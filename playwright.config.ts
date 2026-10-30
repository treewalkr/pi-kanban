import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  testMatch: /.*\.e2e\.ts$/,
  timeout: 30_000,
  reporter: "line",
  use: { baseURL: "http://127.0.0.1:4621" },
  webServer: {
    command: "bun run build && REPRO_PORT=4621 REPRO_TTL=900 bash scripts/repro.sh",
    url: "http://127.0.0.1:4621",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
