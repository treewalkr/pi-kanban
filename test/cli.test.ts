import { expect, test } from "bun:test";
import { join } from "node:path";
import { type Task } from "../src/db";
import { cli, cliIn, dir, useCliDb } from "./cli.helpers";

useCliDb();

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

test("archive auto shows default, sets days, turns off", async () => {
  const shown = await cli("archive", "auto");
  expect(shown.code).toBe(0);
  expect(shown.stdout.trim()).toBe("auto-archive: 7d");

  const set = await cli("archive", "auto", "14");
  expect(set.code).toBe(0);
  expect(set.stdout.trim()).toBe("auto-archive: 14d");
  expect(JSON.parse((await cli("archive", "auto", "--json")).stdout)).toEqual({ autoArchiveDays: 14 });

  const off = await cli("archive", "auto", "off");
  expect(off.code).toBe(0);
  expect(off.stdout.trim()).toBe("auto-archive: off");
  expect((await cli("archive", "auto")).stdout.trim()).toBe("auto-archive: off");

  // 0 is the numeric spelling of off
  expect((await cli("archive", "auto", "0")).stdout.trim()).toBe("auto-archive: off");
  expect(JSON.parse((await cli("archive", "auto", "--json")).stdout)).toEqual({ autoArchiveDays: 0 });
});

test("archive auto rejects out-of-range input", async () => {
  const bad = await cli("archive", "auto", "400");
  expect(bad.code).toBe(1);
  expect(bad.stderr).toContain("auto-archive days must be between 0 and 365");

  // `kanban archive <id>` still moves a card — the subcommand didn't eat the id path
  const added = await cli("add", "archive regression", "--json");
  const task = JSON.parse(added.stdout) as Task;
  const archived = await cli("archive", task.id, "--json");
  expect(archived.code).toBe(0);
  expect(JSON.parse(archived.stdout).laneId).toBe("archive");
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

  const titles = JSON.parse((await cli("search", "flux", "--json")).stdout) as {
    results: Array<{ kind: string; id: string; title: string }>;
  };
  expect(titles.results[0]!.kind).toBe("title");
  expect(titles.results[0]!.title).toBe("flux capacitor search");

  // multi-word positional args join into one query
  const checklists = JSON.parse((await cli("search", "calibrate", "the", "flux", "--json")).stdout) as {
    results: Array<{ kind: string; id: string }>;
  };
  expect(checklists.results).toHaveLength(2);
  expect(checklists.results.every((r) => r.kind === "checklist")).toBe(true);

  const scoped = JSON.parse(
    (await cli("search", "calibrate", "--project", "delorean", "--json")).stdout,
  ) as { results: Array<{ id: string }> };
  expect(scoped.results).toHaveLength(1);
  expect(scoped.results[0]!.id).toBeTruthy();

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
