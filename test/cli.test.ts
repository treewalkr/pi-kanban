import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KanbanDb, type Task } from "../src/db";
import { applyServeEnv, parse } from "../src/cli";

const root = join(import.meta.dir, "..");
let dir = "";
let dbFile = "";

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "kanban-cli-")));
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

async function cliIn(cwd: string, ...args: string[]): Promise<CliResult> {
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
  const helpOut = (await cli("help")).stdout;
  expect(helpOut).toContain("usage:");
  expect(helpOut).toContain("what's next: lane priority, then card priority, then oldest; skips blocked");
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
  expect(badFile.stderr).toContain("cannot read file");

  const usage = await cli("attach", task.id);
  expect(usage.code).toBe(1);
  expect(usage.stderr).toContain("usage: kanban attach");

  await cli("rm", task.id, "--json");
});

test("kanban diff: adjacent pair by default, any pair with --from/--to", async () => {
  const added = await cli("add", "diff card", "--json");
  const task = JSON.parse(added.stdout) as Task;

  const designFile = join(dir, "diff-design.md");
  await Bun.write(designFile, "# design v1");
  await cli("attach", task.id, designFile, "--as", "design.md");
  await Bun.write(designFile, "# design v2");
  await cli("attach", task.id, designFile, "--as", "design.md");

  const onlyFile = join(dir, "only.txt");
  await Bun.write(onlyFile, "single version");
  await cli("attach", task.id, onlyFile, "--as", "only.txt");

  const d = await cli("diff", task.id, "design.md");
  expect(d.code).toBe(0);
  expect(d.stdout).toContain("design.md v1 → v2");
  expect(d.stdout).toContain("--- a/v1");
  expect(d.stdout).toContain("-# design v1");
  expect(d.stdout).toContain("+# design v2");

  const pair = await cli("diff", task.id, "design.md", "--from", "1", "--to", "2");
  expect(pair.code).toBe(0);
  expect(pair.stdout).toContain("design.md v1 → v2");

  const unknown = await cli("diff", task.id, "nope.md");
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain("no file 'nope.md' on card");
  expect(unknown.stderr).toContain("design.md");

  const single = await cli("diff", task.id, "only.txt");
  expect(single.code).toBe(1);
  expect(single.stderr).toContain("only v1 of 'only.txt' — nothing to diff");

  const noV = await cli("diff", task.id, "design.md", "--from", "9");
  expect(noV.code).toBe(1);
  expect(noV.stderr).toContain("no v9 of 'design.md' — versions v1–v2");

  const badRange = await cli("diff", task.id, "design.md", "--from", "2", "--to", "1");
  expect(badRange.code).toBe(1);
  expect(badRange.stderr).toContain("invalid range: v2 → v1");

  const asJson = await cli("diff", task.id, "design.md", "--json");
  expect(asJson.code).toBe(0);
  const parsed = JSON.parse(asJson.stdout) as { name: string; from: { version: number }; to: { version: number }; patch: string };
  expect(parsed.name).toBe("design.md");
  expect(parsed.from.version).toBe(1);
  expect(parsed.to.version).toBe(2);
  expect(parsed.patch).toContain("+# design v2");

  const badFlag = await cli("diff", task.id, "design.md", "--from", "abc");
  expect(badFlag.code).toBe(1);
  expect(badFlag.stderr).toContain("--from must be a positive integer (got 'abc')");

  const show = await cli("show", task.id);
  expect(show.stdout).toContain("kanban diff <id> <name>");

  await cli("rm", task.id, "--json");
});

test("attach --as, files, cat: named card files with versioned reads", async () => {
  const added = await cli("add", "card files", "--json");
  const task = JSON.parse(added.stdout) as Task;

  const designFile = join(dir, "design.md");
  await Bun.write(designFile, "# design v1\nthree columns");
  const first = await cli("attach", task.id, designFile, "--as", "design.md", "--json");
  expect(JSON.parse(first.stdout)).toMatchObject({ kind: "design.md", version: 1 });

  await Bun.write(designFile, "# design v2\nthree columns, tuned");
  const second = await cli("attach", task.id, designFile, "--as", "design.md");
  expect(second.stdout).toContain("attached design.md v2");

  const logFile = join(dir, "repro.txt");
  await Bun.write(logFile, "port 4611: ok");
  await cli("attach", task.id, logFile, "--as", "repro-log.txt");

  const files = await cli("files", task.id);
  expect(files.stdout).toContain("design.md");
  expect(files.stdout).toContain("repro-log.txt");
  expect(files.stdout).toContain("v2");
  expect(files.stdout).not.toContain("no files");

  const show = await cli("show", task.id);
  expect(show.stdout).toContain("files:");
  expect(show.stdout).toContain("design.md v2");
  expect(show.stdout).toContain("(kanban cat");

  const catLatest = await cli("cat", task.id, "design.md");
  expect(catLatest.stdout).toBe("# design v2\nthree columns, tuned\n");
  const catOld = await cli("cat", task.id, "design.md", "--v", "1");
  expect(catOld.stdout).toBe("# design v1\nthree columns\n");

  const unknown = await cli("cat", task.id, "nope.md");
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain("no file 'nope.md'");
  expect(unknown.stderr).toContain("design.md"); // error lists what exists
  expect(unknown.stderr).toContain("repro-log.txt");

  const badVersion = await cli("cat", task.id, "design.md", "--v", "9");
  expect(badVersion.code).toBe(1);
  expect(badVersion.stderr).toContain("no v9 of 'design.md'");

  const brief = await cli("brief", task.id, "--json");
  expect(JSON.parse(brief.stdout).files.map((f: { kind: string }) => f.kind)).toEqual([
    "design.md",
    "repro-log.txt",
  ]);

  await cli("rm", task.id, "--json");
});

test("attach rejects reserved and malformed names up front", async () => {
  const added = await cli("add", "name rules", "--json");
  const task = JSON.parse(added.stdout) as Task;
  const file = join(dir, "any.md");
  await Bun.write(file, "content");

  const reserved = await cli("attach", task.id, file, "--as", "session");
  expect(reserved.code).toBe(1);
  expect(reserved.stderr).toContain("reserved");

  const bad = await cli("attach", task.id, file, "--as", "Design Doc");
  expect(bad.code).toBe(1);
  expect(bad.stderr).toContain("invalid file name");

  const empty = await cli("files", task.id);
  expect(empty.stdout).toContain("no files");

  await cli("rm", task.id, "--json");
});

test("attach stores the plan source as an absolute path", async () => {
  const planPath = join(dir, "cwd-plan.md");
  await Bun.write(planPath, "# plan");
  const added = await cli("add", "absolute source card", "--lane", "plan", "--json");
  const task = JSON.parse(added.stdout) as Task;

  const res = await cliIn(dir, "attach", task.id, "cwd-plan.md", "--json");
  expect(res.code).toBe(0);
  const plan = JSON.parse(res.stdout);
  expect(plan.source).toBe(planPath);

  const brief = JSON.parse((await cli("brief", task.id, "--json")).stdout) as {
    task: Task;
    plan: { source: string; content: string };
    comments: Array<{ body: string }>;
  };
  expect(brief.plan.source).toBe(planPath);

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
  expect(human.stdout).toContain("── today");
  expect(human.stdout).toContain("[review]");
  expect(human.stdout).toContain("▶ ");
  expect(human.stdout).toContain("just now");

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

test("plan-review records pass/block verdicts on a plan-lane card", async () => {
  const task = JSON.parse((await cli("add", "plan card", "--lane", "plan", "--json")).stdout) as Task;
  const planFile = join(dir, "plan.md");
  await Bun.write(planFile, "# plan v1\nsteps");
  await cli("attach", task.id, planFile);

  const passed = await cli("plan-review", task.id, "--pass", "--message", "meets the checklist", "--author", "pi-plan-reviewer", "--json");
  expect(passed.code).toBe(0);
  const verdict = JSON.parse(passed.stdout) as { comment: { kind: string; author: string; body: string }; task: Task };
  expect(verdict.comment).toMatchObject({ kind: "review", author: "pi-plan-reviewer", body: "plan review: pass — meets the checklist" });
  expect(verdict.task.laneId).toBe("waiting"); // the pass parked it at the human gate
  expect((JSON.parse((await cli("show", task.id, "--json")).stdout) as Task).previousLane).toBe("plan");
  await cli("mv", task.id, "plan"); // return it for the block verdict below

  const blocked = await cli(
    "plan-review", task.id, "--block", "--message", "vague", "--finding", "AC2 untested", "--author", "pi-plan-reviewer", "--json",
  );
  expect(blocked.code).toBe(0);
  expect((JSON.parse(blocked.stdout) as { comment: { body: string } }).comment.body).toContain("- AC2 untested");

  const parkedLine = await cli("plan-review", task.id, "--pass", "--message", "fine now", "--author", "pi-plan-reviewer");
  expect(parkedLine.code).toBe(0);
  expect(parkedLine.stdout).toContain("☉ parked in Waiting on you — approve or reject it");

  const usage = await cli("plan-review", task.id);
  expect(usage.code).toBe(1);
  expect(usage.stderr).toContain("usage: kanban plan-review");
  const stray = await cli("plan-review", task.id, "--pass", "--finding", "x");
  expect(stray.code).toBe(1);
  expect(stray.stderr).toContain("--finding is only valid with 'plan-review --block'");
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

test("next: prints the highest-priority card for a project", async () => {
  const proj = "next-e2e-priority";
  const backlog = JSON.parse(
    (await cli("add", "backlog card", "--project", proj, "--json")).stdout,
  ) as Task;
  const review = JSON.parse(
    (await cli("add", "review card", "--project", proj, "--json")).stdout,
  ) as Task;
  await cli("mv", review.id, "review");

  const out = await cli("next", "--project", proj);
  expect(out.code).toBe(0);
  expect(out.stdout).toContain(review.id);
  expect(out.stdout).toContain("Review");
  expect(out.stdout).not.toContain("waiting on you");

  // with only a backlog card tagged
  const projOnlyBacklog = "next-e2e-backlog-only";
  const onlyBacklog = JSON.parse(
    (await cli("add", "only backlog card", "--project", projOnlyBacklog, "--json")).stdout,
  ) as Task;

  const outBacklog = await cli("next", "--project", projOnlyBacklog);
  expect(outBacklog.code).toBe(0);
  expect(outBacklog.stdout).toContain(onlyBacklog.id);
  expect(outBacklog.stdout).toContain("Backlog");

  // park the review card with a question -> next prints ☉ 1 waiting on you
  await cli("comment", review.id, "what db?", "--kind", "question");
  const outWaiting = await cli("next", "--project", proj);
  expect(outWaiting.code).toBe(0);
  expect(outWaiting.stdout).toContain("☉ 1 waiting on you");
  expect(outWaiting.stdout).toContain(backlog.id);
});

test("next --json: Task object; null and exit 0 when nothing to pull forward", async () => {
  const proj = "next-e2e-json";
  const card = JSON.parse(
    (await cli("add", "review task", "--project", proj, "--json")).stdout,
  ) as Task;
  await cli("mv", card.id, "review");

  const resJson = await cli("next", "--project", proj, "--json");
  expect(resJson.code).toBe(0);
  const task = JSON.parse(resJson.stdout) as Task & { blocked: number; waiting: number };
  expect(task.id).toBe(card.id);
  expect(task.laneId).toBe("review");
  expect(task.title).toBe("review task");
  expect(task.blocked).toBe(0);
  expect(task.waiting).toBe(0);

  const emptyProj = "next-e2e-empty";
  const emptyJson = await cli("next", "--project", emptyProj, "--json");
  expect(emptyJson.code).toBe(0);
  expect(JSON.parse(emptyJson.stdout)).toBeNull();

  const emptyHuman = await cli("next", "--project", emptyProj);
  expect(emptyHuman.code).toBe(0);
  expect(emptyHuman.stdout.trim()).toBe("nothing to pull forward");

  // all candidate cards blocked -> task null + blocked count surfaced in both modes
  const allBlockedProj = "next-e2e-all-blocked";
  const blocker = JSON.parse(
    (await cli("add", "blocker", "--project", "other-proj", "--lane", "backlog", "--json")).stdout,
  ) as Task;
  await cli(
    "add",
    "blocked card",
    "--project",
    allBlockedProj,
    "--lane",
    "review",
    "--blocked-by",
    blocker.id,
    "--json",
  );

  const blockedHuman = await cli("next", "--project", allBlockedProj);
  expect(blockedHuman.code).toBe(0);
  expect(blockedHuman.stdout).toContain("nothing to pull forward");
  expect(blockedHuman.stdout).toContain("⚠ 1 blocked card(s) skipped");

  const blockedJson = await cli("next", "--project", allBlockedProj, "--json");
  expect(blockedJson.code).toBe(0);
  expect(JSON.parse(blockedJson.stdout)).toEqual({ task: null, blocked: 1, waiting: 0 });

  // waiting-only project -> task null + waiting count surfaced in both modes
  const waitingProj = "next-e2e-waiting-only";
  const waitCard = JSON.parse(
    (await cli("add", "wait card", "--project", waitingProj, "--lane", "implement", "--json")).stdout,
  ) as Task;
  await cli("comment", waitCard.id, "need human?", "--kind", "question");

  const waitHuman = await cli("next", "--project", waitingProj);
  expect(waitHuman.code).toBe(0);
  expect(waitHuman.stdout).toContain("nothing to pull forward");
  expect(waitHuman.stdout).toContain("☉ 1 waiting on you");

  const waitJson = await cli("next", "--project", waitingProj, "--json");
  expect(waitJson.code).toBe(0);
  expect(JSON.parse(waitJson.stdout)).toEqual({ task: null, blocked: 0, waiting: 1 });
});


test("stop: SIGTERMs a live kanban server and frees the port; quiet when none", async () => {
  const port = 4690 + (Date.now() % 200);
  const server = Bun.spawn(["bun", "src/index.ts"], {
    cwd: root,
    env: { ...process.env, KANBAN_DB: join(dir, "stop.db"), PORT: String(port) },
    stdout: "ignore",
    stderr: "ignore",
  });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      up = (await res.json()).ok === true;
    } catch {
      /* still booting */
    }
  }
  expect(up).toBe(true);

  const stopped = await cli("stop", "--port", String(port));
  expect(stopped.code).toBe(0);
  expect(stopped.stdout).toContain(`stopped the kanban server on port ${port}`);
  expect(await server.exited).toBe(0);

  const none = await cli("stop", "--port", String(port));
  expect(none.code).toBe(0);
  expect(none.stdout).toContain("no server listening");
}, 15_000);

test("triage: priority and blocked-by CLI flags, mv warning, ls glyphs, and show detail", async () => {
  const proj = "triage-cli-test";

  // Create blocker cards
  const b1Json = JSON.parse((await cli("add", "blocker one", "--project", proj, "--json")).stdout) as Task;
  const b2Json = JSON.parse((await cli("add", "blocker two", "--project", proj, "--json")).stdout) as Task;

  // Add card with --priority and multiple --blocked-by
  const depAdd = await cli(
    "add",
    "urgent dependent",
    "--project",
    proj,
    "--priority",
    "high",
    "--blocked-by",
    b1Json.id,
    "--blocked-by",
    b2Json.id,
    "--json",
  );
  expect(depAdd.code).toBe(0);
  const dep = JSON.parse(depAdd.stdout) as Task;
  expect(dep.priority).toBe("high");

  // show prints priority and blocked by lines
  const show1 = await cli("show", dep.id);
  expect(show1.code).toBe(0);
  expect(show1.stdout).toContain("priority: high");
  expect(show1.stdout).toContain(`blocked by: ${b1Json.id}  blocker one`);
  expect(show1.stdout).toContain(`blocked by: ${b2Json.id}  blocker two`);

  // blocker show prints blocking lines
  const showB1 = await cli("show", b1Json.id);
  expect(showB1.stdout).toContain(`blocking:   ${dep.id}  urgent dependent`);

  // show --json carries blockedBy and blocking
  const show1Json = JSON.parse((await cli("show", dep.id, "--json")).stdout) as Task & {
    blockedBy: string[];
    blocking: string[];
  };
  expect(show1Json.blockedBy).toEqual([b1Json.id, b2Json.id]);
  expect(show1Json.blocking).toEqual([]);

  // mv into plan warns about blockers and exits 0
  const mvPlan = await cli("mv", dep.id, "plan");
  expect(mvPlan.code).toBe(0);
  expect(mvPlan.stdout).toContain(`⚠ blocked by: ${b1Json.id}, ${b2Json.id}`);

  // ls glyphs: ▲ before title, ⊘ after title
  const lsOut = await cli("ls", "plan", "--project", proj);
  expect(lsOut.code).toBe(0);
  expect(lsOut.stdout).toContain("▲ urgent dependent ⊘");

  // ls --json carries priority and blockedBy
  const lsJson = JSON.parse((await cli("ls", "plan", "--project", proj, "--json")).stdout) as Array<
    Task & { blockedBy: string[] }
  >;
  const found = lsJson.find((t) => t.id === dep.id);
  expect(found?.priority).toBe("high");
  expect(found?.blockedBy).toEqual([b1Json.id, b2Json.id]);

  // edit --priority low --clear-blocked-by
  const edit1 = await cli("edit", dep.id, "--priority", "low", "--clear-blocked-by", "--json");
  expect(edit1.code).toBe(0);
  const edited = JSON.parse(edit1.stdout) as Task;
  expect(edited.priority).toBe("low");

  // show after clear has low priority and no blocked by
  const show2 = await cli("show", dep.id);
  expect(show2.stdout).toContain("priority: low");
  expect(show2.stdout).not.toContain("blocked by:");

  // edit --blocked-by replaces set
  const edit2 = await cli("edit", dep.id, "--blocked-by", b1Json.id);
  expect(edit2.code).toBe(0);

  // mv into implement warns with single blocker
  const mvImp = await cli("mv", dep.id, "implement");
  expect(mvImp.code).toBe(0);
  expect(mvImp.stdout).toContain(`⚠ blocked by: ${b1Json.id}`);

  // soft blocking: unblock by moving blocker to done
  await cli("mv", b1Json.id, "done");
  // now moving dep within implement does not warn
  const mvImpAgain = await cli("mv", dep.id, "implement");
  expect(mvImpAgain.stdout).not.toContain("⚠ blocked by:");
});

test("add --elaborate queues elaboration; elaborate re-queues; unknown id fails", async () => {
  // JSON add with --elaborate
  const addJson = await cli("add", "Fix login json", "--elaborate", "--json");
  expect(addJson.code).toBe(0);
  const taskJson = JSON.parse(addJson.stdout) as Task;
  expect(taskJson.title).toBe("Fix login json");

  // Plain add with --elaborate
  const addPlain = await cli("add", "Fix login plain", "--elaborate");
  expect(addPlain.code).toBe(0);
  expect(addPlain.stdout).toContain("Fix login plain");
  expect(addPlain.stdout).toContain("✨ elaboration queued — the auto-agent loop");

  const inspectDb = new KanbanDb(dbFile);
  try {
    const reqs = inspectDb.elaborationRequests();
    const reqIds = reqs.map((r) => r.taskId);
    expect(reqIds).toContain(taskJson.id);

    // clear elaboration for taskJson
    inspectDb.clearElaboration(taskJson.id);
    expect(inspectDb.elaborationRequests().map((r) => r.taskId)).not.toContain(taskJson.id);

    // re-queue via `kanban elaborate <id>`
    const elab = await cli("elaborate", taskJson.id);
    expect(elab.code).toBe(0);
    expect(elab.stdout).toContain(`elaboration queued for ${taskJson.id}`);
    expect(inspectDb.elaborationRequests().map((r) => r.taskId)).toContain(taskJson.id);

    // json elaborate
    const elabJson = await cli("elaborate", taskJson.id, "--json");
    expect(elabJson.code).toBe(0);
    expect(JSON.parse(elabJson.stdout)).toMatchObject({ id: taskJson.id });

    // unknown id fails
    const failElab = await cli("elaborate", "nope");
    expect(failElab.code).toBe(1);
    expect(failElab.stderr).toContain("no task matching 'nope'");
  } finally {
    inspectDb.close();
  }
});

test("moving a parent into done with active children warns, never blocks", async () => {
  const pRes = await cli("add", "parent card", "--json");
  const parent = JSON.parse(pRes.stdout) as Task;
  const cRes = await cli("add", "child card", "--parent", parent.id, "--json");
  const child = JSON.parse(cRes.stdout) as Task;

  const doneRes = await cli("done", parent.id);
  expect(doneRes.code).toBe(0);
  expect(doneRes.stdout).toContain(`warning: 1 children still active (${child.id}) — advance or archive them if the work is done`);

  const showRes = await cli("show", parent.id, "--json");
  expect(showRes.code).toBe(0);
  expect((JSON.parse(showRes.stdout) as Task).laneId).toBe("done");
});

test("done warning fires for mv, handoff and review --approve into done", async () => {
  // mv into done
  const p1 = JSON.parse((await cli("add", "p1", "--json")).stdout) as Task;
  const c1 = JSON.parse((await cli("add", "c1", "--parent", p1.id, "--json")).stdout) as Task;
  const mvRes = await cli("mv", p1.id, "done");
  expect(mvRes.code).toBe(0);
  expect(mvRes.stdout).toContain(`warning: 1 children still active (${c1.id}) — advance or archive them if the work is done`);

  // handoff into done
  const p2 = JSON.parse((await cli("add", "p2", "--json")).stdout) as Task;
  const c2 = JSON.parse((await cli("add", "c2", "--parent", p2.id, "--json")).stdout) as Task;
  const handoffRes = await cli("handoff", p2.id, "done", "--message", "done work");
  expect(handoffRes.code).toBe(0);
  expect(handoffRes.stdout).toContain(`warning: 1 children still active (${c2.id}) — advance or archive them if the work is done`);

  // review --approve into done
  const p3 = JSON.parse((await cli("add", "p3", "--lane", "review", "--json")).stdout) as Task;
  const c3 = JSON.parse((await cli("add", "c3", "--parent", p3.id, "--json")).stdout) as Task;
  const reviewRes = await cli("review", p3.id, "--approve");
  expect(reviewRes.code).toBe(0);
  expect(reviewRes.stdout).toContain(`warning: 1 children still active (${c3.id}) — advance or archive them if the work is done`);

  // verify children untouched
  const c1Show = JSON.parse((await cli("show", c1.id, "--json")).stdout) as Task;
  const c2Show = JSON.parse((await cli("show", c2.id, "--json")).stdout) as Task;
  const c3Show = JSON.parse((await cli("show", c3.id, "--json")).stdout) as Task;
  expect(c1Show.laneId).toBe(c1.laneId);
  expect(c2Show.laneId).toBe(c2.laneId);
  expect(c3Show.laneId).toBe(c3.laneId);
});

test("no done warning for childless cards or children in done/archive", async () => {
  // childless card
  const childless = JSON.parse((await cli("add", "childless", "--json")).stdout) as Task;
  const res1 = await cli("done", childless.id);
  expect(res1.code).toBe(0);
  expect(res1.stdout).not.toContain("warning:");

  // parent whose children are in Done and Archive
  const parent = JSON.parse((await cli("add", "parent-clean", "--json")).stdout) as Task;
  const cDone = JSON.parse((await cli("add", "cdone", "--parent", parent.id, "--lane", "done", "--json")).stdout) as Task;
  const cArchive = JSON.parse((await cli("add", "carchive", "--parent", parent.id, "--lane", "archive", "--json")).stdout) as Task;

  const res2 = await cli("done", parent.id);
  expect(res2.code).toBe(0);
  expect(res2.stdout).not.toContain("warning:");

  const pShow = JSON.parse((await cli("show", parent.id, "--json")).stdout) as Task;
  expect(pShow.laneId).toBe("done");
});

test("kanban check reports seeded violations and exits 0", async () => {
  const violDb = join(dir, "check-viol.db");
  const run = (...args: string[]) => {
    const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
      cwd: root,
      env: { ...process.env, KANBAN_DB: violDb, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).then(([stdout, stderr, code]) => ({ stdout, stderr, code }));
  };

  // 1. (a) done parent with active child
  const p1 = JSON.parse((await run("add", "parent-1", "--lane", "done", "--json")).stdout) as Task;
  const c1 = JSON.parse((await run("add", "child-1", "--parent", p1.id, "--lane", "backlog", "--json")).stdout) as Task;

  // 2. (b) child behind parent (parent in implement with plan, child in backlog)
  const p2 = JSON.parse((await run("add", "parent-2", "--lane", "implement", "--json")).stdout) as Task;
  const planPath = join(dir, "p2-plan.md");
  writeFileSync(planPath, "# Plan for p2");
  await run("attach", p2.id, planPath);
  const c2 = JSON.parse((await run("add", "child-2", "--parent", p2.id, "--lane", "backlog", "--json")).stdout) as Task;

  // 3. (c) card in implement with no attached plan
  const card3 = JSON.parse((await run("add", "card-3", "--lane", "implement", "--json")).stdout) as Task;

  const res = await run("check");
  expect(res.code).toBe(0);
  expect(res.stdout).toContain(`⚠ ${p1.id} done with active children: ${c1.id}`);
  expect(res.stdout).toContain(`⚠ ${c2.id} in backlog behind parent ${p2.id} (implement)`);
  expect(res.stdout).toContain(`⚠ ${card3.id} in implement with no attached plan`);

  const jsonRes = await run("check", "--json");
  expect(jsonRes.code).toBe(0);
  expect(JSON.parse(jsonRes.stdout)).toEqual([
    {
      kind: "done-parent-active-children",
      cardId: p1.id,
      childIds: [c1.id],
    },
    {
      kind: "child-behind-parent",
      cardId: c2.id,
      parentId: p2.id,
      cardLaneId: "backlog",
      parentLaneId: "implement",
    },
    {
      kind: "missing-plan",
      cardId: card3.id,
      laneId: "implement",
    },
  ]);
});

test("kanban check on a clean board prints nothing and exits 0", async () => {
  const cleanDb = join(dir, "check-clean.db");
  const run = (...args: string[]) => {
    const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
      cwd: root,
      env: { ...process.env, KANBAN_DB: cleanDb, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).then(([stdout, stderr, code]) => ({ stdout, stderr, code }));
  };

  const res = await run("check");
  expect(res.code).toBe(0);
  expect(res.stdout).toBe("");

  const jsonRes = await run("check", "--json");
  expect(jsonRes.code).toBe(0);
  expect(JSON.parse(jsonRes.stdout)).toEqual([]);
});

test("mv promotes a backlog card to plan; show and ls confirm", async () => {
  const added = await cli("add", "promote me", "--lane", "backlog", "--json");
  expect(added.code).toBe(0);
  const task = JSON.parse(added.stdout) as Task;
  expect(task.laneId).toBe("backlog");

  const moved = await cli("mv", task.id, "plan");
  expect(moved.code).toBe(0);
  expect(moved.stdout).toContain("→ Plan");

  const shown = await cli("show", task.id);
  expect(shown.stdout).toMatch(/Plan \(plan\)/);

  const listed = await cli("ls", "plan", "--json");
  const planTasks = JSON.parse(listed.stdout) as Task[];
  expect(planTasks).toHaveLength(1);
  expect(planTasks[0].id).toBe(task.id);
});

test("kanban stats: board + card modes, --json roundtrip", async () => {
  // Usage error on multiple arguments
  const bad = await cli("stats", "a", "b");
  expect(bad.code).toBe(1);
  expect(bad.stderr).toContain("usage: kanban stats [id]");

  // Board mode --json
  const boardJsonRes = await cli("stats", "--json");
  expect(boardJsonRes.code).toBe(0);
  const boardPayload = JSON.parse(boardJsonRes.stdout);
  expect(typeof boardPayload.board.wip).toBe("number");
  expect(boardPayload.board.throughput).toHaveLength(8);

  // Human board mode
  const boardHuman = await cli("stats");
  expect(boardHuman.code).toBe(0);
  expect(boardHuman.stdout).toContain("wip:");
  expect(boardHuman.stdout).toContain("throughput (done/week):");
  expect(boardHuman.stdout).toContain("lane dwell:");
  expect(boardHuman.stdout).toContain("projects:");

  // Create a card and test card mode
  const addRes = await cli("add", "stats test card", "--lane", "plan", "--json");
  const task = JSON.parse(addRes.stdout) as Task;

  // Card mode --json
  const cardJsonRes = await cli("stats", task.id, "--json");
  expect(cardJsonRes.code).toBe(0);
  const cardStats = JSON.parse(cardJsonRes.stdout);
  expect(cardStats.taskId).toBe(task.id);
  expect(Array.isArray(cardStats.laneTimes)).toBe(true);
  expect(typeof cardStats.cycleMs).toBe("number");

  // Human card mode
  const cardHuman = await cli("stats", task.id);
  expect(cardHuman.code).toBe(0);
  expect(cardHuman.stdout).toContain("cycle:");
  expect(cardHuman.stdout).toContain("gate wait:");
  expect(cardHuman.stdout).toContain("lane times:");
  expect(cardHuman.stdout).toContain("loop health:");
});

test("link/unlink roundtrip: ✓ output, show --json, unlink --json", async () => {
  const addA = await cli("add", "Card Alpha", "--json");
  const a = JSON.parse(addA.stdout) as Task;
  const addB = await cli("add", "Card Beta", "--json");
  const b = JSON.parse(addB.stdout) as Task;

  // missing positional usage error
  const missA = await cli("link", a.id);
  expect(missA.code).toBe(1);
  expect(missA.stderr).toContain("usage: kanban link <id> <other-id>");

  const missUnlink = await cli("unlink", a.id);
  expect(missUnlink.code).toBe(1);
  expect(missUnlink.stderr).toContain("usage: kanban unlink <id> <other-id>");

  // link a b plain output
  const linkRes = await cli("link", a.id, b.id);
  expect(linkRes.code).toBe(0);
  expect(linkRes.stdout).toContain("✓ linked");
  expect(linkRes.stdout).toContain(a.id);
  expect(linkRes.stdout).toContain(b.id);

  // show --json has links containing b.id
  const showAJson = await cli("show", a.id, "--json");
  expect(showAJson.code).toBe(0);
  const showAData = JSON.parse(showAJson.stdout);
  expect(showAData.links).toContain(b.id);

  // plain show lists b.id AND title
  const showAPlain = await cli("show", a.id);
  expect(showAPlain.code).toBe(0);
  expect(showAPlain.stdout).toContain(b.id);
  expect(showAPlain.stdout).toContain("Card Beta");

  // unlink a b --json prints {"removed":true}
  const unlinkRes = await cli("unlink", a.id, b.id, "--json");
  expect(unlinkRes.code).toBe(0);
  expect(JSON.parse(unlinkRes.stdout)).toEqual({ removed: true });

  // re-unlink prints {"removed":false}, exit 0
  const reUnlinkRes = await cli("unlink", a.id, b.id, "--json");
  expect(reUnlinkRes.code).toBe(0);
  expect(JSON.parse(reUnlinkRes.stdout)).toEqual({ removed: false });

  // plain re-unlink prints were not linked
  const reUnlinkPlain = await cli("unlink", a.id, b.id);
  expect(reUnlinkPlain.code).toBe(0);
  expect(reUnlinkPlain.stdout).toContain("were not linked");
});

test("ws set → show → clear roundtrip", async () => {
  const addRes = await cli("add", "Workspace card", "--json");
  expect(addRes.code).toBe(0);
  const task = JSON.parse(addRes.stdout) as Task;

  // bare ws <id> -> exit 1, usage message
  const bareRes = await cli("ws", task.id);
  expect(bareRes.code).toBe(1);
  expect(bareRes.stderr).toContain("usage: kanban ws <id> <branch> | kanban ws <id> --clear");

  // both branch and --clear -> exit 1, usage message
  const bothRes = await cli("ws", task.id, "acme", "--clear");
  expect(bothRes.code).toBe(1);
  expect(bothRes.stderr).toContain("usage: kanban ws <id> <branch> | kanban ws <id> --clear");

  // ws <id> acme exit 0, stdout ✓ workspace acme recorded on <id>
  const setRes = await cli("ws", task.id, "acme");
  expect(setRes.code).toBe(0);
  expect(setRes.stdout).toContain(`✓ workspace acme recorded on ${task.id}`);

  // show --json -> workspace: "acme"
  const showJson = await cli("show", task.id, "--json");
  expect(showJson.code).toBe(0);
  expect(JSON.parse(showJson.stdout).workspace).toBe("acme");

  // show (text) prints workspace: acme
  const showText = await cli("show", task.id);
  expect(showText.code).toBe(0);
  expect(showText.stdout).toContain("workspace: acme");

  // --clear -> ✓ workspace cleared on <id> and workspace: null
  const clearRes = await cli("ws", task.id, "--clear");
  expect(clearRes.code).toBe(0);
  expect(clearRes.stdout).toContain(`✓ workspace cleared on ${task.id}`);

  const showClearedJson = await cli("show", task.id, "--json");
  expect(showClearedJson.code).toBe(0);
  expect(JSON.parse(showClearedJson.stdout).workspace).toBeNull();

  const showClearedText = await cli("show", task.id);
  expect(showClearedText.code).toBe(0);
  expect(showClearedText.stdout).toContain("workspace: —");
});




test("ls --tag filters AND across repeats in text output and --json alike", async () => {
  const a = await cli("add", "ui polish card", "--tag", "ui", "--json");
  const b = await cli("add", "ui and review-loop card", "--tag", "ui", "--tag", "review-loop", "--json");
  const c = await cli("add", "untagged card", "--json");
  const ui = JSON.parse(a.stdout) as Task;
  const both = JSON.parse(b.stdout) as Task;
  const none = JSON.parse(c.stdout) as Task;

  const text = await cli("ls", "--tag", "ui", "--tag", "review-loop");
  expect(text.code).toBe(0);
  expect(text.stdout).toContain(both.title);
  expect(text.stdout).not.toContain(ui.title);
  expect(text.stdout).not.toContain(none.title);
  expect(text.stdout).toContain("● Backlog  1");

  const all = await cli("ls");
  expect(all.stdout).toContain(ui.title);
  expect(all.stdout).toContain(both.title);
  expect(all.stdout).toContain(none.title);

  const json = await cli("ls", "--tag", "ui", "--tag", "review-loop", "--json");
  expect(json.code).toBe(0);
  const rows = JSON.parse(json.stdout) as Task[];
  expect(rows.map((t) => t.id)).toEqual([both.id]);

  const singleJson = await cli("ls", "--tag", "ui", "--json");
  const singleRows = JSON.parse(singleJson.stdout) as Task[];
  expect(singleRows.map((t) => t.id).sort()).toEqual([ui.id, both.id].sort());
});

test("add --tag sets tags and show prints the tags row", async () => {
  const added = await cli("add", "tagged via cli", "--tag", "ui", "--tag", "review-loop", "--json");
  const task = JSON.parse(added.stdout) as Task;
  expect(task.tags).toEqual(["ui", "review-loop"]);

  const shown = await cli("show", task.id);
  expect(shown.stdout).toContain("tags:    #ui #review-loop");

  const listed = await cli("ls", "--json");
  const row = (JSON.parse(listed.stdout) as Task[]).find((t) => t.id === task.id)!;
  expect(row.tags).toEqual(["ui", "review-loop"]);
});

test("edit --tag replaces tags; --clear-tags empties them; empty edit still errors with --tag in usage", async () => {
  const added = await cli("add", "edit tags card", "--json");
  const task = JSON.parse(added.stdout) as Task;

  const replaced = await cli("edit", task.id, "--tag", "a", "--tag", "b", "--json");
  expect(replaced.code).toBe(0);
  expect((JSON.parse(replaced.stdout) as Task).tags).toEqual(["a", "b"]);

  const cleared = await cli("edit", task.id, "--clear-tags", "--json");
  expect(cleared.code).toBe(0);
  expect((JSON.parse(cleared.stdout) as Task).tags).toEqual([]);

  const empty = await cli("edit", task.id);
  expect(empty.code).toBe(1);
  expect(empty.stderr).toContain("--tag");
});

test("search --tag scopes results to tagged cards", async () => {
  await cli("add", "widget polish", "--tag", "ui", "--json");
  await cli("add", "polish the footer", "--json");

  const scoped = await cli("search", "ui", "--tag", "ui");
  expect(scoped.code).toBe(0);
  expect(scoped.stdout).toContain("tag: ui");
  expect(scoped.stdout).not.toContain("polish the footer");

  const json = await cli("search", "ui", "--tag", "ui", "--json");
  const results = JSON.parse(json.stdout) as Array<{ task: Task }>;
  expect(results.length).toBeGreaterThan(0);
  expect(results.every((r) => r.task.tags.includes("ui"))).toBe(true);
});

test("lane limit sets, shows in lane ls, clears with off", async () => {
  const wipDb = join(dir, "lane-limit.db");
  const run = (...args: string[]) => {
    const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
      cwd: root,
      env: { ...process.env, KANBAN_DB: wipDb, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).then(([stdout, stderr, code]) => ({ stdout, stderr, code }));
  };

  const set = await run("lane", "limit", "impl", "2");
  expect(set.code).toBe(0);
  expect(set.stdout).toContain("implement  wip limit 2");

  await run("add", "limit-a", "--lane", "implement");
  await run("add", "limit-b", "--lane", "implement");
  const ls = await run("lane", "ls");
  expect(ls.stdout).toMatch(/implement.*2\/2/);

  const off = await run("lane", "limit", "impl", "off");
  expect(off.code).toBe(0);
  expect(off.stdout).toContain("implement  wip limit cleared");
  const lsAfter = await run("lane", "ls");
  expect(lsAfter.stdout).toMatch(/Test \+ Implement \(implement\)\s+2\b/);
  expect(lsAfter.stdout).not.toContain("2/2");

  for (const bad of [["0"], ["abc"], []] as const) {
    const res = await run("lane", "limit", "impl", ...bad);
    expect(res.code).toBe(1);
  }
  expect((await run("lane", "limit", "impl", "0")).stderr).toContain("wip limit must be an integer from 1 to 999 (or 'off' to clear)");
  expect((await run("lane", "limit", "impl")).stderr).toContain("usage: kanban lane limit <ref> <n|off>");

  const badSub = await run("lane", "badsub");
  expect(badSub.code).toBe(1);
  expect(badSub.stderr).toContain("limit");
});

test("approve into an over-limit Implement warns but still succeeds", async () => {
  const gateDb = join(dir, "wip-approve.db");
  const run = (...args: string[]) => {
    const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
      cwd: root,
      env: { ...process.env, KANBAN_DB: gateDb, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).then(([stdout, stderr, code]) => ({ stdout, stderr, code }));
  };

  await run("lane", "limit", "impl", "1");
  // card B already in implement (occupies the 1 slot)
  await run("add", "already-building", "--lane", "implement");
  // card A: plan-gate ready (mv to plan + attach plan)
  const a = JSON.parse((await run("add", "gate-card", "--lane", "plan", "--json")).stdout) as Task;
  const planPath = join(dir, "gate-plan.md");
  writeFileSync(planPath, "# Gate plan");
  const attached = await run("attach", a.id, planPath);
  expect(attached.code).toBe(0);

  const res = await run("approve", a.id);
  expect(res.code).toBe(0);
  expect(res.stdout).toContain("→ Test + Implement");
  expect(res.stdout).toContain("⚠ implement over WIP limit: 2/1");

  const shown = JSON.parse((await run("show", a.id, "--json")).stdout) as Task;
  expect(shown.laneId).toBe("implement");
});

test("check prints wip-over-limit, JSON carries it, exit stays 0", async () => {
  const checkDb = join(dir, "wip-check.db");
  const run = (...args: string[]) => {
    const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
      cwd: root,
      env: { ...process.env, KANBAN_DB: checkDb, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).then(([stdout, stderr, code]) => ({ stdout, stderr, code }));
  };

  await run("lane", "limit", "impl", "1");
  const a = JSON.parse((await run("add", "over-a", "--lane", "implement", "--json")).stdout) as Task;
  const b = JSON.parse((await run("add", "over-b", "--lane", "implement", "--json")).stdout) as Task;
  writeFileSync(join(dir, "a.md"), "p");
  writeFileSync(join(dir, "b.md"), "p");
  await run("attach", a.id, join(dir, "a.md"));
  await run("attach", b.id, join(dir, "b.md"));

  const res = await run("check");
  expect(res.code).toBe(0);
  expect(res.stdout).toContain("⚠ implement over WIP limit: 2/1");

  const jsonRes = await run("check", "--json");
  expect(jsonRes.code).toBe(0);
  const violations = JSON.parse(jsonRes.stdout) as Array<{ kind: string; laneId?: string; limit?: number; count?: number }>;
  expect(violations).toContainEqual({ kind: "wip-over-limit", laneId: "implement", limit: 1, count: 2 });
});

test("serve: --agents and --auto-review both set KANBAN_AUTO_REVIEW=1", () => {
  const orig = process.env.KANBAN_AUTO_REVIEW;
  try {
    for (const flag of ["--agents", "--auto-review"]) {
      delete process.env.KANBAN_AUTO_REVIEW;
      const parsed = parse([flag]);
      applyServeEnv(parsed.flags);
      expect(process.env.KANBAN_AUTO_REVIEW).toBe("1");
    }

    delete process.env.KANBAN_AUTO_REVIEW;
    const parsedNone = parse([]);
    applyServeEnv(parsedNone.flags);
    expect(process.env.KANBAN_AUTO_REVIEW).toBeUndefined();
  } finally {
    if (orig !== undefined) process.env.KANBAN_AUTO_REVIEW = orig;
    else delete process.env.KANBAN_AUTO_REVIEW;
  }
});
