import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { KanbanDb } from "../src/db";

const exec = promisify(execFile);
const root = join(import.meta.dir, "..");
const noticePath = join(root, "src", "notice.ts");
const driverPath = join(root, "test", "fixtures", "notice-driver.mjs");

let dir = "";
let dbFile = "";
let homeDir = "";

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "kanban-notice-")));
  dbFile = join(dir, "t.db");
  const seed = new KanbanDb(dbFile);
  seed.createTask({ title: "notice seed card", note: "secret note text that must never surface" });
  seed.close();
  // Sandbox HOME whose installed CLI is this workspace's cli.ts — the post-merge
  // machine (~/.bun/bin/kanban → main checkout) behaves exactly like this, and the
  // workspace must pass its own gate before the merge lands.
  homeDir = join(dir, "home");
  const binDir = join(homeDir, ".bun", "bin");
  mkdirSync(binDir, { recursive: true });
  symlinkSync(join(root, "src", "cli.ts"), join(binDir, "kanban"));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface DriverResult {
  scenario: string;
  node: string;
  sends: Array<{ customType: string; display: boolean; content: string }>;
  overview?: string | null;
  dbExists?: boolean;
  sendsAfterStart?: number;
  sendsAfterChange?: number;
  sendsAfterIdle?: number;
}

/** Run the driver under plain Node — the exact runtime class pi uses (jiti is more permissive).
 *  HOME points at the sandbox install so CLI resolution (branch 2) is exercised for real. */
async function driver(scenario: string, env: Record<string, string> = {}): Promise<DriverResult> {
  const proc = await exec("node", [driverPath, noticePath, scenario, root], {
    cwd: root,
    env: { ...process.env, KANBAN_DB: dbFile, HOME: homeDir, ...env },
    timeout: 30_000,
  });
  return JSON.parse(proc.stdout.trim()) as DriverResult;
}

test("notice.ts imports only node: builtins plus the type-only pi import", () => {
  const src = readFileSync(noticePath, "utf8");
  const specs = [...src.matchAll(/from ["']([^"']+)["']/g)].map((m) => m[1]!);
  expect(specs.length).toBeGreaterThan(0);
  for (const spec of specs) {
    expect(spec === "@earendil-works/pi-coding-agent" || spec.startsWith("node:")).toBe(true);
  }
  const piImport = src.match(/import\s+type\s+\{[^}]*\}\s+from\s+["']@earendil-works\/pi-coding-agent["']/);
  expect(piImport).not.toBeNull(); // the pi import is type-only — erased at runtime
  expect(src.includes("bun:")).toBe(false); // never touches bun builtins — not even in comments
  expect(src.includes('from "./db"') || src.includes('from "./render"') || src.includes('from "./search"')).toBe(false);
});

test("notice: loads and reads under plain Node via the CLI subprocess", async () => {
  const result = await driver("read");
  expect(result.node).toMatch(/^v\d+\.\d+\.\d+$/); // plain Node, not bun
  expect(result.overview).toContain("backlog 1");
  expect(result.overview).toContain("waiting 0");
  expect(result.overview).not.toContain("secret note text"); // overview only — never card bodies

  // branch-1 override (KANBAN_CLI) reads the same board
  const viaEnv = await driver("read", { KANBAN_CLI: join(root, "src", "cli.ts") });
  expect(viaEnv.overview).toBe(result.overview);
});

test("notice: sends at session start, re-sends on board change, quiet when unchanged", async () => {
  const result = await driver("wiring", { KANBAN_NOTICE_INTERVAL_MS: "1000" });
  expect(result.node).toMatch(/^v\d+\.\d+\.\d+$/);
  expect(result.sendsAfterStart).toBe(1); // exactly one send at start
  const first = result.sends[0]!;
  expect(first.customType).toBe("kanban-notice");
  expect(first.display).toBe(false);
  expect(first.content.startsWith("[kanban board]\n")).toBe(true);

  expect(result.sendsAfterChange).toBe(2); // re-sends when the board's shape changes
  const second = result.sends[1]!;
  expect(second.content).not.toBe(first.content);
  expect(second.content).toContain("backlog 2"); // the added card shows in the counts line

  expect(result.sendsAfterIdle).toBe(2); // no further send over an idle interval
}, 20_000);

test("notice: KANBAN_NOTICE=0 disables; absent DB stays silent and un-created", async () => {
  const disabled = await driver("disabled", { KANBAN_NOTICE: "0" });
  expect(disabled.sendsAfterStart).toBe(0);
  expect(disabled.sends).toHaveLength(0);

  const absentDb = join(dir, "absent.db");
  expect(existsSync(absentDb)).toBe(false);
  const result = await driver("absent-db", { KANBAN_DB: absentDb });
  expect(result.sendsAfterStart).toBe(0);
  expect(result.dbExists).toBe(false); // the existsSync pre-check prevented board creation
}, 15_000);
