import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KanbanDb } from "../src/db";

const root = join(import.meta.dir, "..");
let dir = "";
let fatDb = "";
const CARDS = 220;

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "kanban-pipe-")));
  fatDb = join(dir, "fat.db");
  const db = new KanbanDb(fatDb);
  const note = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ".repeat(12);
  for (let i = 0; i < CARDS; i++) db.createTask({ title: `bulk card ${i}`.padEnd(40, "x"), note });
  db.close();
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Real OS pipe + external reader — the only harness shape that reproduces the
 * 64 KiB exit-drop (Bun's stdout:"pipe" stdio channel does not). */
async function pipedCli(inner: string): Promise<{ code: number; stdout: string }> {
  const proc = Bun.spawn(["bash", "-c", `bun src/cli.ts ${inner} | cat`], {
    cwd: root,
    env: { ...process.env, KANBAN_DB: fatDb, NO_COLOR: "1" },
    stdout: "pipe",
  });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return { code, stdout };
}

test("ls --json through a real pipe is byte-complete and valid JSON beyond 64 KiB", async () => {
  const { code, stdout } = await pipedCli("ls --json");
  expect(code).toBe(0);
  expect(Buffer.byteLength(stdout)).toBeGreaterThan(65536);
  expect(JSON.parse(stdout)).toHaveLength(CARDS);
});

test("search --json through a real pipe is byte-complete and valid JSON", async () => {
  const { code, stdout } = await pipedCli("search bulk --json");
  expect(code).toBe(0);
  const results = JSON.parse(stdout) as { task: { title: string } }[];
  expect(results).toHaveLength(20); // MAX_RESULTS cap, src/search.ts:24
  expect(results.every((r) => r.task.title.includes("bulk"))).toBe(true);
});

test("next --json through a real pipe is byte-complete and valid JSON", async () => {
  const { code, stdout } = await pipedCli("next --json");
  expect(code).toBe(0);
  const parsed = JSON.parse(stdout) as { id: string; title: string };
  expect(typeof parsed.id).toBe("string");
  expect(parsed.title).toContain("bulk");
});

test("a reader that closes early (EPIPE) keeps exit code 0", async () => {
  const proc = Bun.spawn(
    ["bash", "-c", "set -o pipefail; bun src/cli.ts ls --json | head -c 100 > /dev/null"],
    { cwd: root, env: { ...process.env, KANBAN_DB: fatDb, NO_COLOR: "1" }, stdout: "ignore", stderr: "ignore" },
  );
  expect(await proc.exited).toBe(0);
});
