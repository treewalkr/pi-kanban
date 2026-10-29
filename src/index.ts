import { existsSync, statSync } from "node:fs";
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
  // isFile, not existsSync: a bare directory path (/assets) would pass and throw EISDIR when served
  if (!file.startsWith(resolve(dist) + sep) || !statSync(file, { throwIfNoEntry: false })?.isFile()) return null;
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
  /** Test seam for the TCP probe (default: portInUse). */
  probePort?: (port: number) => Promise<boolean>;
  /** Test seam for the incumbent health check (default: fetchIncumbentHealth). */
  checkHealth?: (port: number, token: string | undefined) => Promise<IncumbentHealth | null>;
}

export interface IncumbentHealth {
  ok: boolean;
  booted?: number;
  share?: "granted";
}

/**
 * Ask the port's incumbent whether it is one of us and whether it vouches for
 * us: a respawn child presents the one-shot token its parent minted, and the
 * incumbent answers share:"granted" exactly once (restart.ts). Unreachable →
 * null; a responder that is not a kanban /health → { ok: false }.
 */
export async function fetchIncumbentHealth(port: number, token: string | undefined): Promise<IncumbentHealth | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: token ? { "x-kanban-share-token": token } : {},
      signal: AbortSignal.timeout(2000),
    });
    const body = await res.json().catch(() => null);
    if (body && typeof body === "object" && "ok" in body) return body as IncumbentHealth;
    return { ok: false };
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

function envMs(name: string): number | undefined {
  const val = process.env[name]?.trim();
  if (!val) return undefined;
  const n = Number(val);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

export async function boot(opts: BootOptions = {}): Promise<void> {
  const port = opts.port ?? Number(process.env.PORT ?? 4600);

  // single-server guard: SO_REUSEPORT would stack N silent listeners on one
  // port (each with its own agent loop — the concurrent-session incident), so
  // probe before binding; sharing is vouched one-shot by the self-respawn
  // parent's minted token — anything else that asks to share gets refused
  const probePort = opts.probePort ?? portInUse;
  const checkHealth = opts.checkHealth ?? fetchIncumbentHealth;
  const sharing = opts.sharePort === true || process.env.KANBAN_SHARE_PORT === "1";
  const forced = process.env.KANBAN_SHARE_FORCE === "1";
  if (sharing && !forced) {
    if (await probePort(port)) {
      const health = await checkHealth(port, process.env.KANBAN_SHARE_TOKEN);
      if (health === null) {
        // occupant unreachable — the respawn race: the parent may exit between
        // our TCP probe and this health check. Binding is correct, not risky.
        console.warn(`[boot] port ${port} probe hit a dying listener — binding anyway`);
      } else if (health.share === "granted") {
        console.warn(`[boot] port ${port} vouched by the incumbent — self-respawn share`);
      } else if (health.ok) {
        const iso = typeof health.booted === "number" ? new Date(health.booted).toISOString() : "unknown";
        throw new Error(
          `port ${port} is held by a healthy kanban server (booted ${iso}) — refusing to share; ` +
            `for board repros use a scratch port (scripts/repro.sh), stop it first ` +
            `(lsof -nP -iTCP:${port} -sTCP:LISTEN), or set KANBAN_SHARE_PORT=1 KANBAN_SHARE_FORCE=1 to force`,
        );
      } else {
        throw new Error(
          `port ${port} is held by a non-kanban server — refusing to share; use another PORT, ` +
            `or set KANBAN_SHARE_PORT=1 KANBAN_SHARE_FORCE=1 to force`,
        );
      }
    }
  } else if (!sharing) {
    if (await probePort(port)) {
      throw new Error(
        `port ${port} already has a server — stop it first (lsof -nP -iTCP:${port} -sTCP:LISTEN), ` +
          `or set KANBAN_SHARE_PORT=1 KANBAN_SHARE_FORCE=1 to share deliberately`,
      );
    }
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
    const timeoutMs = envMs("KANBAN_AUTOREVIEW_TIMEOUT_MS");
    const stallMs = envMs("KANBAN_AUTOREVIEW_STALL_MS");
    const handle = startAutoReview({
      db: new KanbanDb(defaultDbPath()),
      cwd: process.cwd(),
      log: (message) => console.log(`[autoreview] ${message}`),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(stallMs !== undefined ? { stallMs } : {}),
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

if (import.meta.main) {
  try {
    await boot();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
