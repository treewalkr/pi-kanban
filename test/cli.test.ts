import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KanbanDb, type Task } from "../src/db";

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
  expect(badFile.stderr).toContain("cannot read plan file");

  const usage = await cli("attach", task.id);
  expect(usage.code).toBe(1);
  expect(usage.stderr).toContain("usage: kanban attach");

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
  const verdict = JSON.parse(passed.stdout) as { kind: string; author: string; body: string };
  expect(verdict).toMatchObject({ kind: "review", author: "pi-plan-reviewer", body: "plan review: pass — meets the checklist" });
  expect((JSON.parse((await cli("show", task.id, "--json")).stdout) as Task).laneId).toBe("plan");

  const blocked = await cli(
    "plan-review", task.id, "--block", "--message", "vague", "--finding", "AC2 untested", "--author", "pi-plan-reviewer", "--json",
  );
  expect(blocked.code).toBe(0);
  expect((JSON.parse(blocked.stdout) as { body: string }).body).toContain("- AC2 untested");

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

  // with only a backlog card tagged
  const projOnlyBacklog = "next-e2e-backlog-only";
  const onlyBacklog = JSON.parse(
    (await cli("add", "only backlog card", "--project", projOnlyBacklog, "--json")).stdout,
  ) as Task;

  const outBacklog = await cli("next", "--project", projOnlyBacklog);
  expect(outBacklog.code).toBe(0);
  expect(outBacklog.stdout).toContain(onlyBacklog.id);
  expect(outBacklog.stdout).toContain("Backlog");
});

test("next --json: Task object; null and exit 0 when nothing to pull forward", async () => {
  const proj = "next-e2e-json";
  const card = JSON.parse(
    (await cli("add", "review task", "--project", proj, "--json")).stdout,
  ) as Task;
  await cli("mv", card.id, "review");

  const resJson = await cli("next", "--project", proj, "--json");
  expect(resJson.code).toBe(0);
  const task = JSON.parse(resJson.stdout) as Task & { blocked: number };
  expect(task.id).toBe(card.id);
  expect(task.laneId).toBe("review");
  expect(task.title).toBe("review task");
  expect(task.blocked).toBe(0);

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
  expect(JSON.parse(blockedJson.stdout)).toEqual({ task: null, blocked: 1 });
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
