import { existsSync } from "node:fs";
import { join } from "node:path";
import staticPlugin from "@elysiajs/static";
import { app } from "./app";
import { startAutoReview } from "./autoreview";
import { KanbanDb, defaultDbPath } from "./db";
import { registerShutdown, runShutdown } from "./shutdown";
import "./dev-reload"; // watch marker: rewritten by POST /restart to trigger a bun --watch reload

export interface BootOptions {
  port?: number;
  /** Skip the occupied-port guard — used by the self-respawn restart flow. */
  sharePort?: boolean;
  autoReview?: boolean;
}

async function portInUse(port: number): Promise<boolean> {
  try {
    const probe = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
    probe.end();
    return true;
  } catch {
    return false; // ECONNREFUSED → nothing listens
  }
}

export async function boot(opts: BootOptions = {}): Promise<void> {
  const port = opts.port ?? Number(process.env.PORT ?? 4600);
  const dist = join(import.meta.dir, "..", "web", "dist");

  // single-server guard: SO_REUSEPORT would stack N silent listeners on one
  // port (each with its own agent loop — the concurrent-session incident), so
  // probe before binding and refuse to share
  if (!(opts.sharePort || process.env.KANBAN_SHARE_PORT === "1")) {
    if (await portInUse(port)) {
      throw new Error(
        `port ${port} already has a kanban server — stop it first (lsof -nP -iTCP:${port} -sTCP:LISTEN), ` +
          `or set KANBAN_SHARE_PORT=1 to share deliberately`,
      );
    }
  }

  const server = app;
  if (existsSync(dist)) {
    // alwaysStatic registers one route per built file (no catch-all), leaving the SPA fallback to us
    const staticRoutes = await staticPlugin({ assets: dist, prefix: "/", alwaysStatic: true, indexHTML: false });
    const index = () => new Response(Bun.file(join(dist, "index.html")));
    server.use(staticRoutes);
    server.get("/", index);
    server.get("/*", ({ path }) => (path.includes(".") ? new Response("not found", { status: 404 }) : index()));
  }

  server.listen({ port, hostname: "127.0.0.1" });
  console.log(
    `kanban on http://127.0.0.1:${port}${existsSync(dist) ? "" : " (api only — run `bun run build` for the web ui)"}`,
  );

  if (opts.autoReview ?? process.env.KANBAN_AUTO_REVIEW === "1") {
    // own connection, like the CLI — the reviewer/builder children talk to the
    // board through the kanban CLI, never through this process
    const handle = startAutoReview({
      db: new KanbanDb(defaultDbPath()),
      cwd: process.cwd(),
      log: (message) => console.log(`[autoreview] ${message}`),
    });
    registerShutdown(() => handle.stop());
  }

  // graceful signals: terminate agent children, release leases, then exit —
  // a killed server must not leave orphans writing to the board
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      void (async () => {
        await runShutdown();
        process.exit(0);
      })();
    });
  }
}

if (import.meta.main) await boot();
