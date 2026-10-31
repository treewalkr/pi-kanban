import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LANES, type Task } from "../src/db";

const root = join(import.meta.dir, "..");
let dir = "";
let dbFile = "";
let stub = "";

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "kanban-gh-cli-")));
  dbFile = join(dir, "t.db");
  stub = join(dir, "fake-gh");
  // stub gh: keys off the --json fields argument (it always follows --json)
  writeFileSync(
    stub,
    `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    state,mergedAt,title) echo '{"state":"OPEN","mergedAt":null,"title":"stubbed pr"}'; exit 0;;
    state,title) echo '{"state":"OPEN","title":"stubbed issue"}'; exit 0;;
    number,title,body,url) echo '[{"number":12,"title":"First issue","body":"body twelve","url":"https://github.com/o/r/issues/12"},{"number":13,"title":"Second","body":"","url":"https://github.com/o/r/issues/13"}]'; exit 0;;
  esac
done
echo "stub: unhandled args: $*" >&2
exit 1
`,
  );
  chmodSync(stub, 0o755);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(...args: string[]): Promise<CliResult> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: root,
    env: { ...process.env, KANBAN_DB: dbFile, NO_COLOR: "1", KANBAN_GH_SYNC_MS: "0" },
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

async function cliWithGh(...args: string[]): Promise<CliResult> {
  const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
    cwd: root,
    env: { ...process.env, KANBAN_DB: dbFile, NO_COLOR: "1", KANBAN_GH_BIN: stub },
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

async function addCard(title: string, lane = "backlog"): Promise<string> {
  const res = await cli("add", title, "--lane", lane, "--json");
  expect(res.code).toBe(0);
  return (JSON.parse(res.stdout) as Task).id;
}

test("kanban attach with a pr url stores a gh link, not a file", async () => {
  const id = await addCard("gh attach target");
  const linked = await cli("attach", id, "https://github.com/o/r/pull/12");
  expect(linked.code).toBe(0);
  expect(linked.stdout).toMatch(/✓ linked o\/r#12 \(pr\) to/);

  const files = await cli("files", id, "--json");
  expect(JSON.parse(files.stdout)).toEqual([]); // a gh link is not a versioned file

  // --as with a gh ref is an error, never a silent ignore
  const asFlag = await cli("attach", id, "https://github.com/o/r/pull/12", "--as", "plan");
  expect(asFlag.code).toBe(1);
  expect(asFlag.stderr).toContain("--as is for file attachments");

  // url-shaped but not a valid gh ref never falls through to readFileSync
  const badUrl = await cli("attach", id, "https://github.com/o/r/pull/12/files");
  expect(badUrl.code).toBe(1);
  expect(badUrl.stderr).toContain("not a GitHub pr/issue ref");

  // file attach behavior is untouched
  const planFile = join(dir, "plan.md");
  writeFileSync(planFile, "# the plan");
  const fileAttach = await cli("attach", id, planFile);
  expect(fileAttach.code).toBe(0);
  expect(fileAttach.stdout).toMatch(/attached plan v1 to/);
});

test("kanban attach with a stub gh prints the fetched state", async () => {
  const id = await addCard("gh attach with stub");
  const res = await cliWithGh("attach", id, "https://github.com/o/r/pull/12");
  expect(res.code).toBe(0);
  expect(res.stdout).toContain("✓ linked o/r#12 (pr) to");
  expect(res.stdout).toContain("state: OPEN");
});

test("kanban gh unlink removes by url, shorthand, or bare #n", async () => {
  const id = await addCard("gh unlink target");
  await cli("attach", id, "https://github.com/o/r/pull/12");
  await cli("attach", id, "https://github.com/o/r/issues/13");

  const byUrl = await cli("gh", "unlink", id, "https://github.com/o/r/pull/12");
  expect(byUrl.code).toBe(0);
  expect(byUrl.stdout).toContain(`✓ unlinked o/r#12 from`);

  const byShorthand = await cli("gh", "unlink", id, "gh:o/r#13");
  expect(byShorthand.code).toBe(0);
  expect(byShorthand.stdout).toContain("✓ unlinked o/r#13 from");

  const missing = await cli("gh", "unlink", id, "#99");
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain(`no GitHub link matching '#99' on card '${id}'`);
});

test("kanban show prints gh lines; --json carries ghLinks", async () => {
  const id = await addCard("gh show target");
  await cli("attach", id, "https://github.com/o/r/pull/12");
  // state may be unsynced (KANBAN_GH_SYNC_MS=0 runs) or cached OPEN (stub-gh runs share this db)
  expect((await cli("show", id)).stdout).toMatch(/gh: o\/r#12 \(pr · (unsynced|OPEN)\)/);

  const asJson = JSON.parse((await cli("show", id, "--json")).stdout) as {
    ghLinks: Array<{ url: string; kind: string }>;
  };
  expect(asJson.ghLinks).toEqual([
    expect.objectContaining({ url: "https://github.com/o/r/pull/12", kind: "pr" }),
  ]);
});

test("kanban import gh:owner/repo with stub gh creates backlog cards", async () => {
  const lanes = JSON.parse((await cli("lane", "ls", "--json")).stdout) as Array<{ id: string }>;
  expect(lanes.map((l) => l.id)).toEqual(DEFAULT_LANES.map((l) => l.id)); // sanity: fresh board

  const imported = await cliWithGh("import", "gh:o/r");
  expect(imported.code).toBe(0);
  expect(imported.stdout).toContain("✓ imported 2 issues from o/r (0 skipped)");
  expect(imported.stdout).toContain("#12 → ");

  const backlog = JSON.parse((await cli("ls", "backlog", "--json")).stdout) as Task[];
  expect(backlog.map((t) => t.title)).toEqual(expect.arrayContaining(["#12 First issue", "#13 Second"]));

  const rerun = await cliWithGh("import", "gh:o/r");
  expect(rerun.stdout).toContain("(2 skipped)");

  const badRef = await cli("import", "o/r");
  expect(badRef.code).toBe(1);
  expect(badRef.stderr).toContain("usage: kanban import gh:<owner>/<repo> [--limit <n>]");
});
