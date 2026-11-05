import { afterAll, beforeAll } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION, headState } from "../src/version";

/** Shared harness for the cli*.test.ts files (split so `bun test --parallel` can spread them). */
export const root = join(import.meta.dir, "..");
export let dir = "";
export let dbFile = "";

function makeDb(): void {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "kanban-cli-")));
  dbFile = join(dir, "t.db");
}

function dropDb(): void {
  rmSync(dir, { recursive: true, force: true });
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function cli(...args: string[]): Promise<CliResult> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: root,
    env: { ...process.env, KANBAN_DB: dbFile, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export async function cliIn(cwd: string, ...args: string[]): Promise<CliResult> {
  const proc = Bun.spawn(["bun", join(root, "src/cli.ts"), ...args], {
    cwd,
    env: { ...process.env, KANBAN_DB: dbFile, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Fake kanban /health on an ephemeral port — lets `check` tests pin --port away from the real 4600.
 * With `activity`, /activity is served too (what `ps` reads for live sessions). */
export function fakeServe(
  health: Record<string, unknown>,
  activity?: {
    sessions?: unknown[];
    queued?: unknown[];
    incidents?: unknown[];
    engines?: unknown[];
  },
): { port: number; stop: () => void } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) =>
      req.url.endsWith("/activity") && activity
        ? new Response(
            JSON.stringify({
              sessions: [],
              queued: [],
              incidents: [],
              engines: [],
              ...activity,
            }),
          )
        : new Response(JSON.stringify({ ok: true, booted: Date.now(), ...health })),
  });
  if (server.port === undefined) throw new Error("ephemeral port not assigned");
  return { port: server.port, stop: () => server.stop(true) };
}

/** A healthy serve: version matches this CLI, boot commit matches this checkout's HEAD. */
export function healthyServe(): { port: number; stop: () => void } {
  const head = headState()?.head ?? "";
  return fakeServe({ version: VERSION, git: { commit: head, head, dirty: false } });
}

/** Each test file calls this once at top level: a fresh temp KANBAN_DB for the file, removed after. */
export function useCliDb(): void {
  beforeAll(makeDb);
  afterAll(dropDb);
}
