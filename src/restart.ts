import { join } from "node:path";
import { runShutdown } from "./shutdown";

let running = false;

/**
 * Per-process random token: /health exposes it, and a self-respawn child
 * carries it in KANBAN_SHARE_TOKEN. boot() only lets a sharer bind when the
 * occupying server's token matches, so a cargo-culted KANBAN_SHARE_PORT=1
 * can never stack a second board on the production port (10/29 incident).
 */
export const shareToken = crypto.randomUUID();

/**
 * Rebuild web/dist so a restarted server serves fresh assets. Returns false on
 * failure — the running server is left alone and the errors land in its log.
 */
async function buildWeb(): Promise<boolean> {
  const root = join(import.meta.dir, "..");
  console.log("[restart] rebuilding web (bun run build)…");
  const build = Bun.spawn(["bun", "run", "build"], {
    cwd: root,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await build.exited) !== 0) {
    console.error("[restart] build failed — server not restarted");
    return false;
  }
  return true;
}

/**
 * Dev restart (KANBAN_DEV=1, `bun run dev:api`): rewrite the watch marker in
 * src/dev-reload.ts; bun --watch reacts to the content change by reloading.
 */
export async function devWatchRestart(): Promise<void> {
  if (running) return; // a restart is already building — let it finish
  running = true;
  try {
    if (!(await buildWeb())) return;
    await Bun.write(
      join(import.meta.dir, "dev-reload.ts"),
      `// rewritten by POST /restart — bun --watch reloads on the content change\nexport const restartStamp = ${Date.now()};\n`,
    );
    console.log("[restart] build ok — reloading dev server…");
  } finally {
    running = false;
  }
}

/**
 * Production restart (`kanban serve`): re-exec this very command line as a
 * detached child, then exit. The child re-binds 127.0.0.1:4600 (SO_REUSEPORT
 * makes the brief overlap harmless) and inherits stdout/stderr, so a serve
 * launched under nohup keeps logging to the same file.
 */
export async function serveRestart(): Promise<void> {
  if (running) return;
  running = true;
  try {
    if (!(await buildWeb())) return;
    console.log("[restart] build ok — draining sessions, respawning server…");
    await runShutdown(); // terminate agent children, release leases — no orphans
    Bun.spawn([process.execPath, ...process.argv.slice(1)], {
      detached: true,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        // the replacement may bind while we exit — sharing the port is safe here,
        // and the token proves to the child that WE are who it is replacing
        KANBAN_SHARE_PORT: "1",
        KANBAN_SHARE_TOKEN: shareToken,
      },
    });
    setTimeout(() => process.exit(0), 150); // give the spawn a beat to take
  } finally {
    running = false;
  }
}
