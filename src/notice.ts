/**
 * Kanban board notice — a pi extension delivered by install.sh as a symlink at
 * `~/.pi/agent/extensions/kanban-notice.ts`.
 *
 * Node-safe by contract: pi runs extensions under Node + jiti, where this repo's
 * `db.ts` (bun's sqlite module) cannot load. So this module's ONLY imports are `node:*`
 * builtins plus a type-only `import type { ExtensionAPI }` (erased at runtime),
 * and it reads the board solely by spawning the installed bun-backed CLI
 * (`kanban overview` — human output, ANSI-free because piped stdout is not a TTY).
 * The overview text doubles as the change signature: the notice re-sends only
 * when the board's shape changes.
 */
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Kill switch: KANBAN_NOTICE=0 disables the extension entirely. */
export function noticeEnabled(): boolean {
  return process.env.KANBAN_NOTICE !== "0";
}

/** Poll period for board-shape checks (default 30s, never below 1s). */
export function noticeIntervalMs(): number {
  return Math.max(1000, Number(process.env.KANBAN_NOTICE_INTERVAL_MS) || 30000);
}

/** The message body: a `[kanban board]` line plus the raw overview output. */
export function noticeText(overview: string): string {
  return `[kanban board]\n${overview}`;
}

/** execFile as a promise; any failure (spawn error, non-zero exit, timeout) → null. */
function execFileText(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const text = stdout.trim();
      resolve(text ? text : null);
    });
  });
}

/**
 * The entire Node-safe read path: resolve the installed CLI, refuse to run when the
 * board file does not exist (the CLI's constructor would materialize a board — a
 * notice loop must never create state), then spawn one short-lived `overview` read.
 * Null is always silent — a notice must never raise.
 */
export async function readOverview(): Promise<string | null> {
  // 1. Resolve the CLI: explicit override → canonical install → dev-load beside the repo.
  let cli: string | null = process.env.KANBAN_CLI ?? null;
  let spawnAsScript = false; // false: the cli IS the executable (shebang bun); true: run `bun <cli>`
  if (!cli) {
    const installed = join(homedir(), ".bun", "bin", "kanban");
    if (existsSync(installed)) {
      cli = installed;
    } else {
      try {
        const repoRoot = dirname(dirname(realpathSync(fileURLToPath(import.meta.url))));
        const devCli = join(repoRoot, "src", "cli.ts");
        if (existsSync(devCli)) {
          cli = devCli;
          spawnAsScript = true;
        }
      } catch {
        return null;
      }
    }
  }
  if (!cli) return null;

  // 2. Resolve the DB from the CLI's own repo and refuse when it does not exist.
  let dbPath: string;
  if (process.env.KANBAN_DB) {
    dbPath = process.env.KANBAN_DB;
  } else {
    try {
      const repoRoot = dirname(dirname(realpathSync(cli)));
      dbPath = join(repoRoot, "data", "kanban.db");
    } catch {
      return null;
    }
  }
  if (!existsSync(dbPath)) return null;

  // 3. One short-lived read; inherited env; nothing written anywhere.
  return spawnAsScript ? execFileText("bun", [cli, "overview"]) : execFileText(cli, ["overview"]);
}

/** Thin wiring only: no processes, timers, or watchers start until session_start. */
export default function (pi: ExtensionAPI): void {
  let timer: ReturnType<typeof setInterval> | undefined;
  let last: string | null = null;
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (inFlight) return; // skip a tick while the previous spawn is unsettled
    inFlight = true;
    try {
      const overview = await readOverview();
      if (overview !== null && overview !== last) {
        last = overview;
        await pi.sendMessage({ customType: "kanban-notice", content: noticeText(overview), display: false });
      }
    } catch {
      // a notice must never break a session
    } finally {
      inFlight = false;
    }
  };

  pi.on("session_start", async () => {
    if (!noticeEnabled()) return;
    await tick();
    timer = setInterval(() => {
      void tick();
    }, noticeIntervalMs());
  });

  // Idempotent teardown — spawns are one-shot, so the interval is all there is to close.
  pi.on("session_shutdown", () => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  });
}
