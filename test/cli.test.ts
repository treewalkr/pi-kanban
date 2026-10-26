import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "../src/db";

const root = join(import.meta.dir, "..");
let dir = "";
let dbFile = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kanban-cli-"));
  dbFile = join(dir, "t.db");
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

test("add → ls --json → mv → done → rm roundtrip", async () => {
  const added = await cli("add", "fix the flux capacitor", "--lane", "plan", "--project", "delorean", "--json");
  expect(added.code).toBe(0);
  const task = JSON.parse(added.stdout) as Task;
  expect(task.title).toBe("fix the flux capacitor");
  expect(task.laneId).toBe("plan");
  expect(task.project).toBe("delorean");

  await cli("add", "second card", "--json");

  const listed = await cli("ls", "--json");
  expect(JSON.parse(listed.stdout)).toHaveLength(2);

  const moved = await cli("mv", task.id, "impl", "--json");
  expect(JSON.parse(moved.stdout).laneId).toBe("implement");

  const nexted = await cli("mv", task.id.slice(0, 3), "--next", "--json");
  expect(JSON.parse(nexted.stdout).laneId).toBe("review");

  const done = await cli("done", task.id, "--json");
  expect(JSON.parse(done.stdout).laneId).toBe("done");

  const removed = await cli("rm", task.id, "--json");
  expect(JSON.parse(removed.stdout).ok).toBe(true);
  expect(JSON.parse((await cli("ls", "--json")).stdout)).toHaveLength(1);
});

test("archive moves a card out of the way and mv brings it back", async () => {
  const added = await cli("add", "ship it", "--lane", "review", "--json");
  const task = JSON.parse(added.stdout) as Task;

  const archived = await cli("archive", task.id, "--json");
  expect(archived.code).toBe(0);
  expect(JSON.parse(archived.stdout).laneId).toBe("archive");

  const restored = await cli("mv", task.id, "backlog", "--json");
  expect(JSON.parse(restored.stdout).laneId).toBe("backlog");

  await cli("rm", task.id, "--json");
});

test("human ls output groups by lane", async () => {
  await cli("add", "human readable", "--lane", "back");
  const out = await cli("ls");
  expect(out.code).toBe(0);
  expect(out.stdout).toContain("Backlog");
  expect(out.stdout).toContain("human readable");
  expect(out.stdout).toContain("(empty)");
});

test("lane subcommands roundtrip", async () => {
  expect((await cli("lane", "add", "Parking Lot")).code).toBe(0);
  const lanes = await cli("lane", "ls", "--json");
  expect(JSON.parse(lanes.stdout).map((l: { id: string }) => l.id)).toContain("parking-lot");
  expect((await cli("lane", "rename", "park", "Long Term Parking")).code).toBe(0);
  expect((await cli("lane", "rm", "parking-lot")).code).toBe(0);
});

test("errors exit 1 with a message on stderr", async () => {
  const bad = await cli("mv", "zzzzz", "done");
  expect(bad.code).toBe(1);
  expect(bad.stderr).toContain("no task matching");

  const unknown = await cli("frobnicate");
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain("unknown command");

  const flagless = await cli("edit", "zzzzz");
  expect(flagless.code).toBe(1);
});

test("help and version exit 0", async () => {
  expect((await cli("help")).stdout).toContain("usage:");
  expect((await cli("version")).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
});

test("hierarchy: add --parent, ls nesting, show tree, rm cascade", async () => {
  const before = JSON.parse((await cli("ls", "--json")).stdout).length;

  const epic = JSON.parse((await cli("add", "auth epic", "--lane", "plan", "--json")).stdout) as Task;
  const story = JSON.parse((await cli("add", "oauth login", "--parent", epic.id, "--json")).stdout) as Task;
  expect(story.parentId).toBe(epic.id);
  expect(story.laneId).toBe("plan"); // inherits the parent's lane

  const sub = JSON.parse((await cli("add", "provider config", "--parent", story.id, "--json")).stdout) as Task;
  expect(sub.parentId).toBe(story.id);

  const humanLs = await cli("ls", "plan");
  expect(humanLs.stdout).toMatch(/└ \S+  oauth login/);
  expect(humanLs.stdout).toMatch(/ {4}└ \S+  provider config/);

  const show = await cli("show", story.id);
  expect(show.stdout).toContain("parent:");
  expect(show.stdout).toContain(epic.id);
  expect(show.stdout).toContain("children:");
  expect(show.stdout).toContain(sub.id);

  const deep = await cli("add", "too deep", "--parent", sub.id);
  expect(deep.code).toBe(1);
  expect(deep.stderr).toContain("epic → story → subtask");

  const guarded = await cli("rm", epic.id);
  expect(guarded.code).toBe(1);
  expect(guarded.stderr).toContain("descendant");

  expect((await cli("rm", epic.id, "--force")).code).toBe(0);
  expect(JSON.parse((await cli("ls", "--json")).stdout)).toHaveLength(before);
});

test("edit --parent reparents and --clear-parent detaches", async () => {
  const a = JSON.parse((await cli("add", "anchor", "--json")).stdout) as Task;
  const b = JSON.parse((await cli("add", "drifter", "--json")).stdout) as Task;
  expect(JSON.parse((await cli("edit", b.id, "--parent", a.id, "--json")).stdout).parentId).toBe(a.id);
  expect(JSON.parse((await cli("edit", b.id, "--clear-parent", "--json")).stdout).parentId).toBeNull();
  await cli("rm", a.id);
  await cli("rm", b.id);
});

test("attach versions a plan file; show prints the latest; bad file fails", async () => {
  const added = await cli("add", "planned work", "--lane", "plan", "--json");
  const task = JSON.parse(added.stdout) as Task;

  const planFile = join(dir, "plan.md");
  await Bun.write(planFile, "# plan v1\nuse the flux capacitor");
  const first = await cli("attach", task.id, planFile, "--json");
  expect(first.code).toBe(0);
  expect(JSON.parse(first.stdout)).toMatchObject({ version: 1, content: "# plan v1\nuse the flux capacitor", source: planFile });

  await Bun.write(planFile, "# plan v2\nuse the mr fusion");
  await cli("attach", task.id, planFile);
  const show = await cli("show", task.id);
  expect(show.stdout).toContain("plan:");
  expect(show.stdout).toContain("v2");
  expect(show.stdout).toContain("use the mr fusion");
  expect(show.stdout).not.toContain("use the flux capacitor"); // latest only

  const badFile = await cli("attach", task.id, join(dir, "nope.md"));
  expect(badFile.code).toBe(1);
  expect(badFile.stderr).toContain("cannot read plan file");

  const usage = await cli("attach", task.id);
  expect(usage.code).toBe(1);
  expect(usage.stderr).toContain("usage: kanban attach");

  await cli("rm", task.id, "--json");
});

test("comment/comments roundtrip; show prints the thread; usage errors exit 1", async () => {
  const task = JSON.parse((await cli("add", "threaded card", "--json")).stdout) as Task;

  const commented = await cli("comment", task.id, "picked this up", "--author", "pi-builder", "--json");
  expect(commented.code).toBe(0);
  expect(JSON.parse(commented.stdout)).toMatchObject({ author: "pi-builder", kind: "comment", body: "picked this up", taskId: task.id });

  await cli("comment", task.id, "needs a second pass", "--kind", "review");
  const listed = JSON.parse((await cli("comments", task.id, "--json")).stdout) as Array<{ body: string; kind: string }>;
  expect(listed.map((m) => m.body)).toEqual(["picked this up", "needs a second pass"]);
  expect(listed[1]!.kind).toBe("review");

  const asked = await cli("comment", task.id, "Q1: SSE or polling? default SSE", "--kind", "question", "--author", "pi-planner", "--json");
  expect(asked.code).toBe(0);
  expect(JSON.parse(asked.stdout)).toMatchObject({ kind: "question", author: "pi-planner" });

  const human = await cli("comments", task.id);
  expect(human.stdout).toContain("pi-builder");
  expect(human.stdout).toContain("picked this up");

  const show = await cli("show", task.id);
  expect(show.stdout).toContain("thread:");
  expect(show.stdout).toContain("needs a second pass");

  const usage = await cli("comment", task.id);
  expect(usage.code).toBe(1);
  expect(usage.stderr).toContain("usage: kanban comment");

  const noTask = await cli("comment", "zzzzz", "hi");
  expect(noTask.code).toBe(1);
  expect(noTask.stderr).toContain("no task");

  await cli("rm", task.id, "--json");
});

test("handoff moves + records; review --approve/--block with findings", async () => {
  const task = JSON.parse((await cli("add", "baton card", "--lane", "review", "--json")).stdout) as Task;

  const bad = await cli("handoff", task.id, "implement");
  expect(bad.code).toBe(1);
  expect(bad.stderr).toContain("usage: kanban handoff");

  const passed = await cli(
    "handoff", task.id, "implement",
    "--message", "build done, please review", "--author", "pi-builder", "--json",
  );
  expect(passed.code).toBe(0);
  const result = JSON.parse(passed.stdout) as { task: Task; comment: { kind: string; author: string } };
  expect(result.task.laneId).toBe("implement");
  expect(result.comment).toMatchObject({ kind: "handoff", author: "pi-builder" });

  await cli("mv", task.id, "review");
  const approved = await cli("review", task.id, "--approve", "--json");
  expect(approved.code).toBe(0);
  const approveResult = JSON.parse(approved.stdout) as { task: Task; comment: { kind: string; body: string } };
  expect(approveResult.task.laneId).toBe("done");
  expect(approveResult.comment).toMatchObject({ kind: "review", body: "approved" });

  const blocked = await cli(
    "review", task.id, "--block",
    "--message", "flux capacitor leaks",
    "--finding", "Fix leak src/flux.ts:10",
    "--finding", "Add leak test",
    "--json",
  );
  expect(blocked.code).toBe(0);
  const blockResult = JSON.parse(blocked.stdout) as { task: Task; comment: { kind: string } };
  expect(blockResult.task.laneId).toBe("implement");
  expect(blockResult.comment.kind).toBe("review");
  const after = JSON.parse((await cli("show", task.id, "--json")).stdout) as Task;
  expect(after.note).toContain("- [ ] Fix leak src/flux.ts:10");
  expect(after.note).toContain("- [ ] Add leak test");

  const neither = await cli("review", task.id);
  expect(neither.code).toBe(1);
  expect(neither.stderr).toContain("usage: kanban review");

  const noMsg = await cli("review", task.id, "--block");
  expect(noMsg.code).toBe(1);
  expect(noMsg.stderr).toContain("--block needs --message");

  const strayFinding = await cli("review", task.id, "--approve", "--finding", "x");
  expect(strayFinding.code).toBe(1);
  expect(strayFinding.stderr).toContain("--finding is only valid with 'review --block'");

  const handoffFinding = await cli("handoff", task.id, "review", "--message", "m", "--finding", "x");
  expect(handoffFinding.code).toBe(1);
  expect(handoffFinding.stderr).toContain("--finding is only valid with 'review --block'");
  const unmoved = JSON.parse((await cli("show", task.id, "--json")).stdout) as Task;
  expect(unmoved.laneId).toBe("implement");

  const serveFinding = await cli("serve", "--finding", "x");
  expect(serveFinding.code).toBe(1);
  expect(serveFinding.stderr).toContain("--finding is only valid with 'review --block'");

  await cli("rm", task.id, "--json");
});

test("brief prints pickup context: note, plan, and thread", async () => {
  const task = JSON.parse((await cli("add", "briefed card", "--lane", "implement", "--json")).stdout) as Task;
  await cli("edit", task.id, "--note", "the note body");

  const planFile = join(dir, "brief-plan.md");
  await Bun.write(planFile, "# the attached plan");
  await cli("attach", task.id, planFile);
  await cli("comment", task.id, "prior session found the flux capacitor", "--author", "pi-builder");

  const asJson = JSON.parse((await cli("brief", task.id, "--json")).stdout) as {
    task: Task;
    plan: { content: string };
    comments: Array<{ body: string }>;
  };
  expect(asJson.task.id).toBe(task.id);
  expect(asJson.plan?.content).toBe("# the attached plan");
  expect(asJson.comments.map((m) => m.body)).toContain("prior session found the flux capacitor");

  const human = await cli("brief", task.id);
  expect(human.stdout).toContain("the note body");
  expect(human.stdout).toContain("the attached plan");
  expect(human.stdout).toContain("prior session found the flux capacitor");

  const usage = await cli("brief");
  expect(usage.code).toBe(1);
  expect(usage.stderr).toContain("usage: kanban brief");

  await cli("rm", task.id, "--json");
});

test("search ranks titles, checklists and notes; --project scopes; empty query fails", async () => {
  await cli(
    "add", "flux capacitor search", "--project", "delorean",
    "--note", "- [ ] calibrate the flux\nsee the plutonium sourcing doc",
  );
  await cli("add", "unrelated card", "--project", "other", "--note", "- [ ] calibrate the flux");

  const titles = JSON.parse((await cli("search", "flux", "--json")).stdout) as Array<{
    kind: string;
    task: Task;
  }>;
  expect(titles[0]!.kind).toBe("title");
  expect(titles[0]!.task.title).toBe("flux capacitor search");

  // multi-word positional args join into one query
  const checklists = JSON.parse((await cli("search", "calibrate", "the", "flux", "--json")).stdout) as Array<{
    kind: string;
    task: Task;
  }>;
  expect(checklists).toHaveLength(2);
  expect(checklists.every((r) => r.kind === "checklist")).toBe(true);

  const scoped = JSON.parse(
    (await cli("search", "calibrate", "--project", "delorean", "--json")).stdout,
  ) as Array<{ task: Task }>;
  expect(scoped).toHaveLength(1);
  expect(scoped[0]!.task.project).toBe("delorean");

  const human = await cli("search", "plutonium");
  expect(human.stdout).toContain("note:");
  expect(human.stdout).toContain("plutonium");

  const none = await cli("search", "no-such-thing");
  expect(none.code).toBe(0);
  expect(none.stdout).toContain("no matches");

  const empty = await cli("search");
  expect(empty.code).toBe(1);
  expect(empty.stderr).toContain("usage: kanban search");
});
