import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  testMatch: /.*\.e2e\.ts$/,
  timeout: 30_000,
  reporter: "line",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:4621" },
  webServer: {
    // KANBAN_GH_SYNC_MS=0: e2e is hermetic — the server never spawns gh; the
    // pending-state chip is asserted instead (real-gh behavior is unit-tested)
    command: "bun run build && REPRO_PORT=4621 REPRO_TTL=900 KANBAN_GH_SYNC_MS=0 bash scripts/repro.sh",
    url: "http://127.0.0.1:4621",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
