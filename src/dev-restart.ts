import { join } from "node:path";

let running = false;

/**
 * The restart behind POST /dev/restart — only armed when the server runs with
 * KANBAN_DEV=1 (i.e. `bun run dev:api`). Rebuilds web/dist first so the reloaded
 * server serves fresh assets, then rewrites src/dev-reload.ts; bun --watch reacts
 * to the content change by restarting the process. A failed build leaves the
 * running server alone — the errors land in the dev terminal.
 */
export async function defaultDevRestart(): Promise<void> {
  if (running) return; // a restart is already building — let it finish
  running = true;
  try {
    const root = join(import.meta.dir, "..");
    console.log("[dev] rebuilding web (bun run build)…");
    const build = Bun.spawn(["bun", "run", "build"], {
      cwd: root,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    if ((await build.exited) !== 0) {
      console.error("[dev] build failed — server not restarted");
      return;
    }
    await Bun.write(
      join(import.meta.dir, "dev-reload.ts"),
      `// rewritten by POST /dev/restart — bun --watch reloads on the content change\nexport const restartStamp = ${Date.now()};\n`,
    );
    console.log("[dev] build ok — restarting server…");
  } finally {
    running = false;
  }
}
