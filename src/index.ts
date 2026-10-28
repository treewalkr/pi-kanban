import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { app } from "./app";
import { startAutoReview } from "./autoreview";
import { KanbanDb, defaultDbPath } from "./db";
import { registerShutdown, runShutdown } from "./shutdown";
import "./dev-reload"; // watch marker: rewritten by POST /restart to trigger a bun --watch reload

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

/**
 * Serve one file from dist per request — no boot-time route table, so a
 * rebuilt dist (new asset hashes) is picked up live instead of 404-ing the
 * fresh index.html into a white page (the 10/29 incident).
 */
export function distResponse(dist: string, urlPath: string): Response | null {
  const clean = urlPath.split("?")[0].replace(/^\/+/, "") || "index.html"; // "/" → SPA entry
  if (clean.includes("..") || clean.endsWith("/")) return null;
  const file = resolve(dist, clean);
  if (!file.startsWith(resolve(dist) + sep) || !existsSync(file)) return null;
  const dot = clean.lastIndexOf(".");
  const type = dot === -1 ? undefined : MIME[clean.slice(dot)];
  return new Response(Bun.file(file), type ? { headers: { "content-type": type } } : {});
}

export interface BootOptions {
  port?: number;
  /** Skip the occupied-port guard — used by the self-respawn restart flow. */
  sharePort?: boolean;
  autoReview?: boolean;
  /** Overrides the dist directory (tests point this at a temp dir). */
  dist?: string;
}

export interface HealthInfo {
  ok: boolean;
  shareToken?: string;
}

/** Pure verdict for the occupied-port guard — unit-tested without sockets. */
export function shareDecision(opts: {
  occupied: boolean;
  requested: boolean; // KANBAN_SHARE_PORT / opts.sharePort
  force: boolean; // KANBAN_SHARE_FORCE=1 — explicit human override
  health: HealthInfo | null; // GET /health of the occupying listener, if it speaks kanban
  token?: string; // our KANBAN_SHARE_TOKEN — the self-respawn parent passes its own
}): { allow: boolean; error?: string } {
  if (!opts.occupied) return { allow: true };
  if (!opts.requested) {
    return {
      allow: false,
      error: `port already has a kanban server — stop it first (lsof -nP -iTCP:<port> -sTCP:LISTEN), or set KANBAN_SHARE_PORT=1 to share deliberately`,
    };
  }
  if (opts.force) return { allow: true };
  if (opts.health?.ok && opts.health.shareToken === opts.token) return { allow: true }; // self-respawn
  return {
    allow: false,
    error:
      `port is already serving ${opts.health?.ok ? "another kanban board" : "an unknown listener"} — ` +
      `KANBAN_SHARE_PORT belongs to the self-respawn flow only. Stop it first ` +
      `(lsof -nP -iTCP:<port> -sTCP:LISTEN), use a scratch port (scripts/repro.sh), ` +
      `or set KANBAN_SHARE_FORCE=1 to share deliberately`,
  };
}

/** Ask the occupying listener whether it is one of us (750 ms — a stuck port should not hang boot). */
async function healthOf(port: number): Promise<HealthInfo | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(750) });
    return (await res.json()) as HealthInfo;
  } catch {
    return null;
  }
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

  // single-server guard: SO_REUSEPORT would stack N silent listeners on one
  // port (each with its own agent loop — the concurrent-session incident), so
  // probe before binding and refuse to share — KANBAN_SHARE_PORT only works
  // for the self-respawn child, whose parent handed it a matching share token
  const occupied = await portInUse(port);
  const decision = shareDecision({
    occupied,
    requested: opts.sharePort || process.env.KANBAN_SHARE_PORT === "1",
    force: process.env.KANBAN_SHARE_FORCE === "1",
    health: occupied ? await healthOf(port) : null,
    token: process.env.KANBAN_SHARE_TOKEN,
  });
  if (!decision.allow) throw new Error(`port ${port} ${decision.error}`);
  if (occupied && decision.allow) {
    console.warn(`[boot] sharing port ${port} with a live listener (deliberate) — boards will alternate`);
  }

  const server = app;
  const dist = opts.dist ?? join(import.meta.dir, "..", "web", "dist");
  if (existsSync(dist)) {
    const index = () => new Response(Bun.file(join(dist, "index.html")));
    server.get("/", index);
    // SPA fallback: real files (hashed assets, favicon) serve per request so a
    // rebuilt dist never strands index.html referencing routes that no longer exist
    server.get("/*", ({ path }) => distResponse(dist, path) ?? (path.includes(".") ? new Response("not found", { status: 404 }) : index()));
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
