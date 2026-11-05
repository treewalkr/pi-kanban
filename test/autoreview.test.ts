import { stampSessionLog } from "../src/session-log";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KanbanDb } from "../src/db";
import { CLAUDE_BUILD_TOOLS, CLAUDE_READ_TOOLS, claudeFlags, isClaudeSessionId } from "../src/claude";
import {
  BUILDER_AUTHOR,
  DEFAULT_STALL_MS,
  DEFAULT_TIMEOUT_MS,
  REVIEWER_AUTHOR,
  activitySnapshot,
  agentFlags,
  builderPlanPrompt,
  builderPrompt,
  deathReason,
  defaultSpawn,
  durationFor,
  formatPiEvent,
  killAgentSession,
  killAgentSessions,
  MAX_SKILL_CHARS,
  modelConfigLabel,
  plannerPrompt,
  planReviewerPrompt,
  resolvedModelConfig,
  reviewerPrompt,
  sessionIdFor,
  skillActivationPrompt,
  startAutoReview,
  type AgentJob,
  type SpawnContext,
  type SpawnFn,
  type SpawnResult,
} from "../src/autoreview";
import {
  cardInPlan,
  cardInReview,
  db,
  deletePoolShim,
  dir,
  eng,
  fakeSpawn,
  makeSkill,
  poolShim,
  setDb,
  setStop,
  setup,
  skillDirs,
  sleep,
  start,
  stop,
  useAutoReviewHooks,
  withAgentEnv,
  withFakePi,
} from "./autoreview.helpers";

useAutoReviewHooks();

describe("skillActivationPrompt", () => {
  test("wraps each SKILL.md body in pi's skill block (dir or file path, frontmatter stripped)", () => {
    const skillDir = makeSkill("demo", "# Rules\nBe terse.");
    const expected = `<skill name="demo" location="${join(skillDir, "SKILL.md")}">\nReferences are relative to ${skillDir}.\n\n# Rules\nBe terse.\n</skill>`;
    expect(skillActivationPrompt([skillDir])).toBe(expected);
    expect(skillActivationPrompt([join(skillDir, "SKILL.md")])).toBe(expected);
  });

  test("missing paths warn and skip — a spawn never dies on a skill", () => {
    const warns: string[] = [];
    const empty = mkdtempSync(join(tmpdir(), "kanban-skill-empty-"));
    skillDirs.push(empty);
    expect(skillActivationPrompt(["/nope/definitely-not", empty], (m) => warns.push(m))).toBe("");
    expect(warns[0]).toBe("skill /nope/definitely-not not found — skipped");
    expect(warns[1]).toContain(`skill ${empty} unreadable (`);
    expect(warns[1]).toContain("— skipped");
  });

  test("caps a giant skill body at MAX_SKILL_CHARS", () => {
    const warns: string[] = [];
    const out = skillActivationPrompt([makeSkill("big", "x".repeat(MAX_SKILL_CHARS + 5_000))], (m) => warns.push(m));
    const body = out.slice(out.indexOf("\n\n") + 2).replace(/\n<\/skill>$/, "");
    expect(body.length).toBe(MAX_SKILL_CHARS);
    expect(warns[0]).toContain("truncated");
  });
});

describe("agent pause", () => {
  test("a paused board spawns nothing; unpausing resumes on the unpause write itself", async () => {
    const { dbFile, writer: w } = setup();
    cardInReview(w);
    w.setAgentsPaused(true);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile); // startup scan is gated too
    w.createTask({ title: "noise" }); // watcher fires — still nothing
    await sleep(200);
    expect(calls.length).toBe(0);

    w.setAgentsPaused(false); // cross-connection write wakes the loop's watcher
    await sleep(200);
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("reviewer");
    calls[0].finish({ code: 0 });
  });

  test("killAgentSessions ends in-flight sessions through the pause registry", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    let killed = false;
    let resolveSpawn!: (r: SpawnResult) => void;
    const spawnFn: SpawnFn = (_job, ctx) => {
      ctx.track(() => {
        killed = true;
        resolveSpawn({ code: 143 });
      });
      return new Promise<SpawnResult>((r) => (resolveSpawn = r));
    };
    start(spawnFn, dbFile);
    await sleep(150); // the reviewer session is in flight

    expect(killAgentSessions()).toBe(1);
    expect(killed).toBe(true);
    await sleep(50);
    // the killed session leaves a death trace; its own comment disarms the card
    const last = w.comments(card.id).at(-1)!;
    expect(last.author).toBe(REVIEWER_AUTHOR);
    expect(last.body).toContain("comment on this card to re-trigger");
  });
});

describe("auto-review", () => {
  test("reviewer spawns for a card waiting in review", () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("reviewer");
    expect(calls[0].job.task.id).toBe(card.id);
    expect(calls[0].job.prompt).toContain(`kanban brief ${card.id}`);
    expect(calls[0].job.prompt).toContain("--author pi-reviewer");
  });

  test("stop() traces the kill on every in-flight card (restart kill must not be silent)", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const { spawnFn } = fakeSpawn(); // never resolves — the session stays in flight
    const handle = start(spawnFn, dbFile);
    await sleep(150); // let the drain loop spawn the reviewer
    handle.stop();
    const last = w.comments(card.id).at(-1)!;
    expect(last.author).toBe(REVIEWER_AUTHOR);
    expect(last.body).toContain(`${KanbanDb.SESSION_DIED_PREFIX}session killed by server restart/shutdown`);
    expect(last.body).toContain("comment on this card to re-run");
  });

  test("approve ends the loop: no re-spawn on later board writes", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await w.handoff(card.id, "done", { kind: "review", author: REVIEWER_AUTHOR, message: "approved" });
    calls[0].finish({ code: 0 });
    await sleep(20);
    w.createTask({ title: "noise" }); // unrelated write kicks the watcher
    await sleep(150);
    expect(calls.length).toBe(1);
  });

  test("block spawns the builder; handoff back re-arms the reviewer; approve ends it", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);

    // reviewer blocks: card to implement, findings on the note
    await w.handoff(card.id, "implement", {
      kind: "review",
      author: REVIEWER_AUTHOR,
      message: "found issues",
      findings: ["src/a.ts:1 off by one"],
    });
    calls[0].finish({ code: 0 });
    await sleep(20);
    expect(calls.length).toBe(2);
    expect(calls[1].job.role).toBe("builder");
    expect(calls[1].job.task.id).toBe(card.id);
    expect(calls[1].job.prompt).toContain("pi-builder");

    // builder fixes and hands back to review
    await w.handoff(card.id, "review", { author: BUILDER_AUTHOR, message: "fixed, tests green" });
    calls[1].finish({ code: 0 });
    await sleep(20);
    expect(calls.length).toBe(3);
    expect(calls[2].job.role).toBe("reviewer");

    // second pass approves
    await w.handoff(card.id, "done", { kind: "review", author: REVIEWER_AUTHOR, message: "approved" });
    calls[2].finish({ code: 0 });
    await sleep(20);
    w.createTask({ title: "noise" });
    await sleep(150);
    expect(calls.length).toBe(3);
    expect(db!.tasks().find((t) => t.id === card.id)!.laneId).toBe("done");
  });

  test("three block cycles hit the cap: no builder spawn, cap comment posted once", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    for (let i = 1; i <= 3; i++) {
      await w.handoff(card.id, "implement", {
        kind: "review",
        author: REVIEWER_AUTHOR,
        message: `block ${i}`,
        findings: ["x"],
      });
      if (i < 3) await w.handoff(card.id, "review", { author: BUILDER_AUTHOR, message: "fixed" });
    }
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    expect(calls.length).toBe(0);
    const thread = db!.comments(card.id);
    const last = thread.at(-1)!;
    expect(last.author).toBe(REVIEWER_AUTHOR);
    expect(last.kind).toBe("question");
    expect(last.body).toContain("cap");
    const parked = w.tasks().find((t) => t.id === card.id)!;
    expect(parked.laneId).toBe("waiting");
    expect(parked.previousLane).toBe("implement");
    // the cap comment already disarmed the card — a later write must not repost it
    w.createTask({ title: "noise" });
    await sleep(150);
    expect(db!.comments(card.id).length).toBe(thread.length);
    expect(calls.length).toBe(0);
  });

  test("block-cap parks in waiting; a human reply re-arms the builder in findings mode", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    for (let i = 1; i <= 3; i++) {
      await w.handoff(card.id, "implement", {
        kind: "review",
        author: REVIEWER_AUTHOR,
        message: `block ${i}`,
        findings: ["x"],
      });
      if (i < 3) await w.handoff(card.id, "review", { author: BUILDER_AUTHOR, message: "fixed" });
    }
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    expect(calls.length).toBe(0);
    expect(w.tasks().find((t) => t.id === card.id)!.laneId).toBe("waiting");

    const reply = w.comment(card.id, { author: "user", kind: "comment", body: "addressed" });
    expect(reply.moved).toBe("returned");
    expect(reply.task.laneId).toBe("implement");
    await sleep(100);

    expect(calls.length).toBe(1);
    expect(calls[0]!.job.role).toBe("builder");
    expect(calls[0]!.job.mode).toBe("findings");
    calls[0]!.finish({ code: 0 });
  });

  test("reviewer crash (non-zero exit) posts a failure comment and does not hot-loop", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    calls[0].finish({ code: 1 });
    await sleep(20);
    const last = db!.comments(card.id).at(-1)!;
    expect(last.author).toBe(REVIEWER_AUTHOR);
    expect(last.body).toContain("failed");
    w.createTask({ title: "noise" });
    await sleep(150);
    expect(calls.length).toBe(1);
  });

  test("reviewer exiting cleanly without a verdict leaves a nudge comment", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    calls[0].finish({ code: 0 });
    await sleep(20);
    const last = db!.comments(card.id).at(-1)!;
    expect(last.author).toBe(REVIEWER_AUTHOR);
    expect(last.body).toContain("without a verdict");
  });

  test("reviewer comment (no verdict) is an acceptable end — no extra failure comment", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const before = w.comments(card.id).length;
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await w.createComment(card.id, {
      author: REVIEWER_AUTHOR,
      kind: "comment",
      body: "could not locate the work in this repo — needs manual review",
    });
    calls[0].finish({ code: 0 });
    await sleep(20);
    expect(db!.comments(card.id).length).toBe(before + 1);
  });

  test("in-flight card is not spawned twice by repeated scans", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await w.createComment(card.id, { author: "pi-builder", body: "still eligible, last author is the builder" });
    await sleep(150);
    expect(calls.length).toBe(1);
  });

  test("two eligible cards are reviewed serially", async () => {
    const { dbFile, writer: w } = setup();
    cardInReview(w, "first");
    cardInReview(w, "second");
    const { calls, spawnFn } = fakeSpawn();
    withAgentEnv({}, () => start(spawnFn, dbFile));
    expect(calls.length).toBe(1);
    const firstId = calls[0].job.task.id;
    await w.handoff(firstId, "done", { kind: "review", author: REVIEWER_AUTHOR, message: "approved" });
    calls[0].finish({ code: 0 });
    await sleep(20);
    expect(calls.length).toBe(2);
    expect(calls[1].job.task.id).not.toBe(firstId);
  });

  test("KANBAN_AUTOREVIEW_MAX_PARALLEL is gone from src and README", () => {
    const autoreviewSrc = readFileSync(join(import.meta.dir, "../src/autoreview.ts"), "utf8");
    const readmeSrc = readFileSync(join(import.meta.dir, "../README.md"), "utf8");
    expect(autoreviewSrc).not.toContain("KANBAN_AUTOREVIEW_MAX_PARALLEL");
    expect(readmeSrc).not.toContain("KANBAN_AUTOREVIEW_MAX_PARALLEL");
  });

  test("uncovered roles stay serial on the single default slot regardless of env", async () => {
    const { dbFile, writer: w } = setup();
    cardInReview(w, "first");
    cardInReview(w, "second");
    const { calls, spawnFn } = fakeSpawn();
    const orig = process.env.KANBAN_AUTOREVIEW_MAX_PARALLEL;
    process.env.KANBAN_AUTOREVIEW_MAX_PARALLEL = "8";
    try {
      start(spawnFn, dbFile);
      expect(calls.length).toBe(1);
      const firstId = calls[0].job.task.id;
      calls[0].finish({ code: 0 });
      await sleep(20);
      expect(calls.length).toBe(2);
      expect(calls[1].job.task.id).not.toBe(firstId);
    } finally {
      if (orig === undefined) delete process.env.KANBAN_AUTOREVIEW_MAX_PARALLEL;
      else process.env.KANBAN_AUTOREVIEW_MAX_PARALLEL = orig;
    }
  });

  test("global max workers caps total in-flight sessions below pool capacity", async () => {
    const { dbFile, writer: w } = setup();
    poolShim(w, "heavy", {
      name: "heavy",
      enabled: true,
      roles: ["reviewer"],
      slots: [{ model: "m1" }, { model: "m2" }, { model: "m3" }],
    });
    w.setMaxWorkers(2);
    const first = cardInReview(w, "first");
    await sleep(2);
    const second = cardInReview(w, "second");
    await sleep(2);
    const third = cardInReview(w, "third");
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    expect(calls.length).toBe(2);
    expect(new Set(calls.map((c) => c.job.task.id))).toEqual(new Set([first.id, second.id]));

    calls[0].finish({ code: 0 });
    await sleep(50);

    expect(calls.length).toBe(3);
    expect(calls[2].job.task.id).toBe(third.id);
  });

  test("a free default slot stays waiting when the global cap is full", async () => {
    const { dbFile, writer: w } = setup();
    poolShim(w, "heavy", {
      name: "heavy",
      enabled: true,
      roles: ["reviewer"],
      slots: [{ model: "m1" }, { model: "m2" }],
    });
    w.setMaxWorkers(2);
    const first = cardInReview(w, "first");
    await sleep(2);
    const second = cardInReview(w, "second");
    await sleep(2);
    const third = w.createTask({ title: "third", lane: "plan" });
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    expect(calls.length).toBe(2);
    expect(calls.every((c) => c.job.role === "reviewer")).toBe(true);

    calls[0].finish({ code: 0 });
    await sleep(50);

    expect(calls.length).toBe(3);
    expect(calls[2].job.task.id).toBe(third.id);
    expect(calls[2].job.role).toBe("planner");
  });

  test("pool maxWorkers throttles a pool below its slot count", async () => {
    const { dbFile, writer: w } = setup();
    poolShim(w, "heavy", {
      name: "heavy",
      enabled: true,
      roles: ["reviewer"],
      slots: [{ model: "m1" }, { model: "m2" }, { model: "m3" }],
      maxWorkers: 2,
    });
    const first = cardInReview(w, "first");
    await sleep(2);
    const second = cardInReview(w, "second");
    await sleep(2);
    const third = cardInReview(w, "third");
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    expect(calls.length).toBe(2);
    expect(new Set(calls.map((c) => c.job.task.id))).toEqual(new Set([first.id, second.id]));

    calls[0].finish({ code: 0 });
    await sleep(50);

    expect(calls.length).toBe(3);
    expect(calls[2].job.task.id).toBe(third.id);
  });

  test("absent pool maxWorkers behaves as slots.length", async () => {
    const { dbFile, writer: w } = setup();
    poolShim(w, "heavy", {
      name: "heavy",
      enabled: true,
      roles: ["reviewer"],
      slots: [{ model: "m1" }, { model: "m2" }, { model: "m3" }],
    });
    cardInReview(w, "first");
    await sleep(2);
    cardInReview(w, "second");
    await sleep(2);
    cardInReview(w, "third");
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    expect(calls.length).toBe(3);
  });

  test("builder crash posts a failure comment, not another builder spawn", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await w.handoff(card.id, "implement", {
      kind: "review",
      author: REVIEWER_AUTHOR,
      message: "found issues",
      findings: ["x"],
    });
    calls[0].finish({ code: 0 });
    await sleep(20);
    expect(calls.length).toBe(2);
    calls[1].finish({ code: 1 });
    await sleep(20);
    const last = db!.comments(card.id).at(-1)!;
    expect(last.author).toBe(BUILDER_AUTHOR);
    expect(last.body.startsWith(KanbanDb.SESSION_DIED_PREFIX)).toBe(true);
    expect(last.body).toContain("findings unaddressed, needs a human. comment on this card to re-trigger.");
    w.createTask({ title: "noise" });
    await sleep(150);
    expect(calls.length).toBe(2);

    // Also test plan-mode builder crash
    const planCard = cardInPlan(w);
    await w.approveTask(planCard.id);
    await sleep(200);
    expect(calls.length).toBe(3);
    expect(calls[2].job.mode).toBe("plan");
    calls[2].finish({ code: 1 });
    await sleep(20);
    const lastPlan = db!.comments(planCard.id).at(-1)!;
    expect(lastPlan.body.startsWith(KanbanDb.SESSION_DIED_PREFIX)).toBe(true);
    expect(lastPlan.body).toContain("plan not built, needs a human. comment on this card to re-trigger.");
  });

  test("prompts embed the card id and the verdict commands", () => {
    const task = { id: "abc12", title: "quotes \"ok\"", laneId: "review" } as never;
    const prompt = reviewerPrompt(task);
    expect(prompt).toContain("abc12");
    expect(prompt).toContain("review abc12 --approve");
    expect(prompt).toContain("review abc12 --block");
    expect(prompt).toContain("--finding");

    expect(builderPlanPrompt(task)).toContain("--kind question");
    expect(builderPrompt(task)).toContain("--kind question");
    expect(plannerPrompt(task)).toContain("--kind question");
  });

  test("reviewer prompt teaches severity tiers", () => {
    const task = { id: "abc12", title: "t", laneId: "review" } as never;
    const prompt = reviewerPrompt(task);
    expect(prompt).toContain("Fail (only when at least one finding is [blocker])");
    expect(prompt).toContain('list any [minor]/[nit] observations at the end');
    expect(prompt).toContain(
      "[blocker] must fix before done; [minor] should fix; [nit] style or preference. A review with only [minor]/[nit] findings is a Pass."
    );
    expect(prompt).toContain('finding "[blocker] <file:line — issue>"');
  });

  test("reviewer prompt demands proof and routes unverifiable concerns to comments", () => {
    const task = { id: "abc12", title: "proof", laneId: "review" } as never;
    const prompt = reviewerPrompt(task);
    expect(prompt).toContain("Prove every finding");
    expect(prompt).toContain("failing repro (command + observed output)");
    expect(prompt).toContain(`kanban comment abc12 "<concern>" --author pi-reviewer`);
  });

  test("builder prompt allows challenging findings that cite no proof", () => {
    const task = { id: "abc12", title: "proof", laneId: "implement" } as never;
    expect(builderPrompt(task)).toContain("A finding that cites no proof may be challenged");
  });

  test("builder prompt ranks findings by severity", () => {
    const task = { id: "abc12", title: "t", laneId: "implement" } as never;
    const prompt = builderPrompt(task);
    expect(prompt).toContain("Fix every [blocker] finding; fix [minor]s when cheap");
    expect(prompt).toContain(
      "[nit]s may be deferred with a one-line note in the handoff message."
    );
  });

  test("builder plan prompt advances child cards as their steps land", () => {
    const task = { id: "abc12", title: "advance children", laneId: "implement" } as never;
    const prompt = builderPlanPrompt(task);
    expect(prompt).toContain("Advance child cards as their steps land");
    expect(prompt).toContain("kanban show abc12");
    expect(prompt).toContain("kanban handoff <child-id> done");
    expect(prompt).toContain("--author pi-builder");
  });

  test("reviewer prompt checks child lanes before approving a parent", () => {
    const task = { id: "abc12", title: "check truthfulness", laneId: "review" } as never;
    const prompt = reviewerPrompt(task);
    expect(prompt).toContain("Check board truthfulness");
    expect(prompt).toContain("their lanes must match the work");
    expect(prompt).toContain("block finding");
  });

  test("auto-review prompts tell agents to read AGENTS.md and REVIEW.md", () => {
    const task = { id: "abc12", title: "t", laneId: "review" } as never;
    expect(reviewerPrompt(task)).toContain("AGENTS.md and REVIEW.md");
    expect(builderPrompt(task)).toContain("AGENTS.md and REVIEW.md");
    expect(builderPlanPrompt(task)).toContain("AGENTS.md and REVIEW.md");
  });

  test("REVIEW.md seeds landed rules and the append format", () => {
    const body = readFileSync(fileURLToPath(new URL("../REVIEW.md", import.meta.url)), "utf8");
    expect(body).toContain("Findings require proof");
    expect(body).toContain("(brs9w)");
    expect(body).toContain("[blocker] / [minor] / [nit]");
    expect(body).toContain("(xetf8)");
    expect(body).toContain("## Lessons");
    expect(body).toContain("<!-- format: - YYYY-MM-DD");
    expect(body).not.toContain("5pa2e");
  });

  test("AGENTS.md documents the REVIEW.md append rule", () => {
    const body = readFileSync(fileURLToPath(new URL("../AGENTS.md", import.meta.url)), "utf8");
    expect(body).toContain("append one dated line to `REVIEW.md`");
  });

  test("GLOSSARY.md defines core board vocabulary without implementation details", () => {
    const body = readFileSync(fileURLToPath(new URL("../GLOSSARY.md", import.meta.url)), "utf8");
    expect(body).toContain("## Language");
    for (const term of [
      "**Card**:",
      "**Lane**:",
      "**Project**:",
      "**Thread**:",
      "**Comment kind**:",
      "**Plan**:",
      "**Seam**:",
      "**Brief**:",
      "**Gate**:",
      "**Project override**:",
      "**Per-project test command**:",
      "**Planner**",
      "**Plan reviewer**",
      "**Builder**",
      "**Reviewer**",
    ]) {
      expect(body).toContain(term);
    }
    expect(body).toContain("_Avoid_:");
    expect(body).not.toContain("src/db.ts");
    expect(body).not.toContain("SQLite");
    expect(body).not.toContain("Elysia");
    expect(body).not.toContain("Svelte");
  });

  test("docs/adr documents the ADR format and records the first gate ADR", () => {
    const readme = readFileSync(fileURLToPath(new URL("../docs/adr/README.md", import.meta.url)), "utf8");
    expect(readme).toContain("0001-slug.md");
    expect(readme).toContain("Hard to reverse");
    expect(readme).toContain("Surprising without context");
    expect(readme).toContain("The result of a real trade-off");

    const adr1 = readFileSync(
      fileURLToPath(new URL("../docs/adr/0001-agents-never-run-the-gate.md", import.meta.url)),
      "utf8",
    );
    expect(adr1).toContain("# Agents never run the gate");
    expect(adr1).toContain("Waiting on you");
    expect(adr1).toContain("approve");
    expect(adr1).toContain("reject");
  });

  test("all agent prompts reference GLOSSARY.md and planner challenges fuzzy terms", () => {
    const task = { id: "abc12", title: "t", laneId: "plan" } as never;
    for (const prompt of [
      plannerPrompt(task),
      planReviewerPrompt(task),
      builderPlanPrompt(task),
      builderPrompt(task),
      reviewerPrompt(task),
    ]) {
      expect(prompt).toContain("Read GLOSSARY.md if present and use its vocabulary");
      expect(prompt).toContain("update it inline when a term crystallizes");
    }
    expect(plannerPrompt(task)).toContain(
      "challenge fuzzy terms against the glossary instead of inventing synonyms",
    );
  });

  test("agentFlags: reviewer defaults to thinking max, builder to nothing", () => {
    withAgentEnv({}, () => {
      expect(agentFlags("reviewer", eng({}), null)).toEqual(["--thinking", "max"]);
      expect(agentFlags("builder", eng({}), null)).toEqual([]);
    });
  });

  test("two reviewer cards spawn concurrently under a 2-slot pool; a third waits", async () => {
    const { dbFile, writer: w } = setup();
    poolShim(w, "rev-pool", {
      name: "reviewer pool",
      enabled: true,
      roles: ["reviewer"],
      slots: [{ model: "slot-0" }, { model: "slot-1" }],
    });
    const first = cardInReview(w, "first");
    await sleep(2);
    const second = cardInReview(w, "second");
    await sleep(2);
    const third = cardInReview(w, "third");
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await sleep(50);

    expect(calls.length).toBe(2);
    expect(new Set(calls.map((c) => c.job.task.id))).toEqual(new Set([first.id, second.id]));

    calls[0].finish({ code: 0 });
    await sleep(50);

    expect(calls.length).toBe(3);
    expect(calls[2].job.task.id).toBe(third.id);
  });

  test("builder-only pool never takes reviewer jobs; uncovered roles share the default slot", async () => {
    const { dbFile, writer: w } = setup();
    poolShim(w, "b-pool", {
      name: "builder pool",
      enabled: true,
      roles: ["builder"],
      slots: [{ model: "b-0" }, { model: "b-1" }],
    });
    const first = cardInReview(w, "first");
    await sleep(2);
    const second = cardInReview(w, "second");
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await sleep(50);

    // reviewer is uncovered → single implicit default slot, serial
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("reviewer");
    const firstId = calls[0].job.task.id;

    calls[0].finish({ code: 0 });
    await sleep(50);

    expect(calls.length).toBe(2);
    expect(calls[1].job.role).toBe("reviewer");
    expect(calls[1].job.task.id).not.toBe(firstId);
  });

  test("the engine supplies the model; the actor config supplies behavior", async () => {
    const { dbFile, writer: w } = setup();
    w.setAgentConfig("reviewer", { context: "a" });
    poolShim(w, "rev-pool", {
      name: "rev",
      enabled: true,
      roles: ["reviewer"],
      slots: [{ model: "b" }],
    });
    cardInReview(w);
    let captured: Parameters<SpawnFn>[1] | null = null;
    const spawnFn: SpawnFn = (job, ctx) => {
      captured = ctx;
      return Promise.resolve({ code: 0 });
    };
    start(spawnFn, dbFile);
    await sleep(50);

    expect(captured!.engine.model).toBe("b");
    expect(captured!.config).toMatchObject({ context: "a", runsOn: ["rev-pool-0"] });
  });

  test("a provider-quota death cools the slot and the next spawn fails over to the healthy slot", async () => {
    const { dbFile, writer: w } = setup();
    poolShim(w, "rev-pool", {
      name: "Reviewers",
      enabled: true,
      roles: ["reviewer"],
      slots: [{ provider: "zcode", model: "zcode" }, { provider: "okay", model: "okay" }],
    });
    const card1 = cardInReview(w, "card 1");
    const spawnedModels: string[] = [];
    const spawnFn: SpawnFn = async (job, ctx) => {
      const model = ctx.engine.model ?? "";
      spawnedModels.push(model);
      if (model === "zcode") {
        return {
          code: 1,
          stderrTail:
            "Start Plan has no active model quota (expired, pending or exhausted)\nNo fallback to another plan was made",
        };
      }
      ctx.emit("text: working");
      return { code: 0 };
    };

    start(spawnFn, dbFile);
    await sleep(60);

    // Card 1 spawned on zcode and died with quota error
    expect(spawnedModels).toEqual(["zcode"]);

    // Create card 2: slot 0 (zcode) is cooling, so card 2 must fail over to slot 1 (okay)
    const card2 = cardInReview(w, "card 2");
    await sleep(60);
    expect(spawnedModels).toEqual(["zcode", "okay"]);

    // Create card 3: slot 0 (zcode) is still cooling, card 3 must also get okay, never zcode
    const card3 = cardInReview(w, "card 3");
    await sleep(60);
    expect(spawnedModels).toEqual(["zcode", "okay", "okay"]);
  });

  test("a cooling slot requalifies after cooldown expiry; re-saving a pool resets cooldowns instantly", async () => {
    const { dbFile, writer: w } = setup();
    const pool = { name: "Reviewers", enabled: true, roles: ["reviewer"], slots: [{ provider: "p0", model: "s0" }, { provider: "p1", model: "s1" }] };
    poolShim(w, "rev-pool", pool);
    const spawnedModels: string[] = [];
    let s0ShouldFail = true;
    const spawnFn: SpawnFn = async (job, ctx) => {
      const model = ctx.engine.model ?? "";
      spawnedModels.push(model);
      if (model === "s0" && s0ShouldFail) {
        return {
          code: 1,
          stderrTail: "Start Plan has no active model quota (expired, pending or exhausted)",
        };
      }
      ctx.emit("text: working");
      return { code: 0 };
    };

    // Card 1 and Card 2 in review before start
    cardInReview(w, "card 1");
    await sleep(2);
    cardInReview(w, "card 2");

    start(spawnFn, dbFile, { cooldownMs: 50 });

    // Card 1 on s0 dies and cools slot 0. Card 2 immediately gets slot 1 (s1) because s0 is cooling
    await sleep(60);
    expect(spawnedModels).toEqual(["s0", "s1"]);

    // Wait for 50ms cooldown to expire, and let s0 succeed
    await sleep(60);
    s0ShouldFail = false;

    // Card 3 created after expiry -> slot 0 (s0) is re-allocated!
    cardInReview(w, "card 3");
    await sleep(60);
    expect(spawnedModels).toEqual(["s0", "s1", "s0"]);

    // Separately: fail slot 0 again
    s0ShouldFail = true;
    cardInReview(w, "card 4");
    await sleep(60);
    expect(spawnedModels).toEqual(["s0", "s1", "s0", "s0"]);

    // Slot 0 is cooling. Re-saving the pool bumps updatedAt and resets cooldowns instantly!
    poolShim(w, "rev-pool", {
      name: pool.name,
      enabled: pool.enabled,
      roles: pool.roles,
      slots: pool.slots,
    });
    s0ShouldFail = false;

    // Card 5 created -> slot 0 is allocatable immediately!
    cardInReview(w, "card 5");
    await sleep(60);
    expect(spawnedModels).toEqual(["s0", "s1", "s0", "s0", "s0"]);
  });

  test("a quota-reached-with-wait-hint death applies the capped cooldown to the slot", async () => {
    const { dbFile, writer: w } = setup();
    poolShim(w, "p1", {
      name: "Reviewers",
      enabled: true,
      roles: ["reviewer"],
      slots: [{ model: "m1" }],
    });
    cardInReview(w, "card 1");
    const spawnFn: SpawnFn = async () => ({
      code: 1,
      stderrTail:
        "Quota reached. Please wait 4h55m33s. Next: switch models or try again after reset.",
    });

    start(spawnFn, dbFile);
    await sleep(60);

    const snapshot = activitySnapshot();
    expect(snapshot.incidents).toHaveLength(1);
    const inc = snapshot.incidents[0];
    expect(inc.cause).toBe("provider-quota");
    // Capped from 4h55m33s to 60 min (3_600_000 ms)
    expect(inc.cooldownUntil - inc.lastSeenAt).toBe(60 * 60_000);
  });

  test("activitySnapshot exposes incidents and engine summaries after a provider-quota death", async () => {
    const { dbFile, writer: w } = setup();
    poolShim(w, "rev-pool", {
      name: "Reviewers",
      enabled: true,
      roles: ["reviewer"],
      slots: [{ provider: "zcode", model: "zcode" }, { provider: "okay", model: "okay" }],
    });
    cardInReview(w, "card 1");
    const spawnFn: SpawnFn = async () => ({
      code: 1,
      stderrTail: "Start Plan has no active model quota (expired, pending or exhausted)",
    });

    const now = Date.now();
    start(spawnFn, dbFile);
    await sleep(60);

    const snapshot = activitySnapshot();
    expect(snapshot.incidents[0]).toEqual({
      account: "pi:zcode",
      engineId: "rev-pool-0",
      engineName: "Reviewers 0",
      cause: "provider-quota",
      count: expect.any(Number),
      firstSeenAt: expect.any(Number),
      lastSeenAt: expect.any(Number),
      cooldownUntil: expect.any(Number),
    });
    expect(snapshot.incidents[0].cooldownUntil).toBeGreaterThan(now);
    const zcode = snapshot.engines.find((e) => e.engineId === "rev-pool-0")!;
    expect(zcode).toMatchObject({ account: "pi:zcode", seats: 1, lastCause: "provider-quota" });
    expect(zcode.coolingUntil).toBeGreaterThan(now);
    expect(snapshot.engines.find((e) => e.engineId === "rev-pool-1")?.coolingUntil).toBeUndefined();
  });

  test("a quota death cools every engine on the same account, not just the one that hit it", async () => {
    const { dbFile, writer: w } = setup();
    // two engines on one zcode account, then a different account as the last fallback
    poolShim(w, "rev-pool", {
      name: "Reviewers",
      roles: ["reviewer"],
      slots: [
        { provider: "zcode", model: "flash" },
        { provider: "zcode", model: "turbo" },
        { provider: "zai", model: "glm" },
      ],
    });
    cardInReview(w, "card 1");
    const spawned: string[] = [];
    const spawnFn: SpawnFn = async (job, ctx) => {
      spawned.push(ctx.engine.model ?? "");
      if (ctx.engine.provider === "zcode") return { code: 1, stderrTail: "Start Plan has no active model quota" };
      ctx.emit("text: working");
      return { code: 0 };
    };
    start(spawnFn, dbFile, { retryDelayMs: 5 });
    await sleep(120);
    // the old per-slot health would have burned the retry on "turbo" (same exhausted account)
    expect(spawned).toEqual(["flash", "glm"]);
  });

  test("a rate-limit death auto-retries via the resume queue, bounded at two, then parks as today", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const spawnedCalls: Array<{ mode?: string; sessionId?: string }> = [];
    const spawnFn: SpawnFn = async (job) => {
      spawnedCalls.push({ mode: job.mode, sessionId: job.sessionId });
      return { code: 1, stderrTail: "429 Too Many Requests" };
    };

    start(spawnFn, dbFile, { retryDelayMs: 5 });
    // Wait for all 3 spawns: spawn 1 (dies, queues 5ms delay) -> spawn 2 (dies, queues 10ms delay) -> spawn 3 (dies, exhausts retries)
    await sleep(200);

    expect(spawnedCalls).toHaveLength(3);
    expect(spawnedCalls[0].mode).toBeUndefined();
    expect(spawnedCalls[1].mode).toBe("resume");
    expect(spawnedCalls[1].sessionId).toBeDefined();
    expect(spawnedCalls[2].mode).toBe("resume");
    expect(spawnedCalls[2].sessionId).toBe(spawnedCalls[1].sessionId);

    const comments = db!.comments(card.id);
    const diedComments = comments.filter((c) => c.body.startsWith(KanbanDb.SESSION_DIED_PREFIX));
    expect(diedComments).toHaveLength(3);
    expect(diedComments[0].body).toEndWith("— auto-retry 1/2 (rate-limit)");
    expect(diedComments[1].body).toEndWith("— auto-retry 2/2 (rate-limit)");
    expect(diedComments[2].body).toEndWith("; comment on this card to re-trigger.");
    expect(diedComments[2].body).not.toContain("auto-retry");

    // Total spawns cap at 3, no 4th after exhaustion
    await sleep(50);
    expect(spawnedCalls).toHaveLength(3);
    expect(db!.resumeRequests()).toHaveLength(0);
  });

  test("a non-retryable death parks with today's comment, unchanged", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    let spawns = 0;
    const spawnFn: SpawnFn = async () => {
      spawns++;
      return { code: 1, stderrTail: "Error: ECONNREFUSED" };
    };
    start(spawnFn, dbFile, { retryDelayMs: 5 });
    await sleep(50);

    expect(spawns).toBe(1);
    const last = db!.comments(card.id).at(-1)!;
    expect(last.author).toBe(REVIEWER_AUTHOR);
    expect(last.body).toStartWith(
      "session died: auto-review failed (exit 1 — Error: ECONNREFUSED) after",
    );
    expect(last.body).toEndWith("; comment on this card to re-trigger.");
    expect(last.body).not.toContain("auto-retry");
    expect(db!.resumeRequests()).toHaveLength(0);
  });

  test("all slots cooling parks the card with one consolidated incident comment", async () => {
    const { dbFile, writer: w } = setup();
    poolShim(w, "p1", {
      name: "Reviewers",
      enabled: true,
      roles: ["reviewer"],
      slots: [{ model: "zcode" }],
    });
    const card = cardInReview(w);
    let spawns = 0;
    const spawnFn: SpawnFn = async () => {
      spawns++;
      return {
        code: 1,
        stderrTail:
          "Start Plan has no active model quota (expired, pending or exhausted)\nNo fallback to another plan was made",
      };
    };

    start(spawnFn, dbFile);
    await sleep(60);

    expect(spawns).toBe(1);
    const last = db!.comments(card.id).at(-1)!;
    expect(last.body).toStartWith(KanbanDb.SESSION_DIED_PREFIX);
    expect(last.body).toContain("'Reviewers 0' provider-quota ×1");
    expect(last.body).toContain("— every engine in the lineup is cooling down:");
    expect(last.body).toEndWith("; comment on this card to re-trigger.");
    expect(db!.resumeRequests()).toHaveLength(0);
  });

  test("pool edits apply to the next spawn", async () => {
    const { dbFile, writer: w } = setup();
    poolShim(w, "p-edit", {
      name: "edit pool",
      enabled: true,
      roles: ["reviewer"],
      slots: [{ model: "m-a" }],
    });
    cardInReview(w, "first");
    await sleep(2);
    cardInReview(w, "second");

    const configs: any[] = [];
    const calls: Array<{ finish: (res: SpawnResult) => void }> = [];
    const spawnFn: SpawnFn = (job, ctx) => {
      configs.push(ctx.engine);
      return new Promise<SpawnResult>((resolve) => calls.push({ finish: resolve }));
    };
    start(spawnFn, dbFile);
    await sleep(50);

    expect(calls.length).toBe(1);
    expect(configs[0].model).toBe("m-a");

    // while spawn 1 is in flight, edit pool
    poolShim(w, "p-edit", {
      name: "edit pool",
      enabled: true,
      roles: ["reviewer"],
      slots: [{ model: "m-b" }],
    });

    calls[0].finish({ code: 0 });
    await sleep(50);

    expect(calls.length).toBe(2);
    expect(configs[1].model).toBe("m-b");
  });

  test("deleting a pool mid-flight lets the session finish normally", async () => {
    // 1. Delete mid-flight
    {
      const { dbFile, writer: w } = setup();
      poolShim(w, "p-del", {
        name: "del pool",
        enabled: true,
        roles: ["reviewer"],
        slots: [{ model: "m-1" }],
      });
      const card = cardInReview(w);
      const { calls, spawnFn } = fakeSpawn();
      start(spawnFn, dbFile);
      await sleep(50);

      expect(calls.length).toBe(1);
      deletePoolShim(w, "p-del");

      calls[0].finish({ code: 0 });
      await sleep(50);

      const last = db!.comments(card.id).at(-1)!;
      expect(last.author).toBe(REVIEWER_AUTHOR);
      expect(last.body).toContain("without a verdict");
      expect(calls.length).toBe(1);
      stop?.();
    }

    // 2. Set enabled: false mid-flight
    {
      const { dbFile, writer: w } = setup();
      poolShim(w, "p-dis", {
        name: "dis pool",
        enabled: true,
        roles: ["reviewer"],
        slots: [{ model: "m-1" }],
      });
      const card = cardInReview(w);
      const { calls, spawnFn } = fakeSpawn();
      start(spawnFn, dbFile);
      await sleep(50);

      expect(calls.length).toBe(1);
      poolShim(w, "p-dis", {
        name: "dis pool",
        enabled: false,
        roles: ["reviewer"],
        slots: [{ model: "m-1" }],
      });

      calls[0].finish({ code: 0 });
      await sleep(50);

      const last = db!.comments(card.id).at(-1)!;
      expect(last.author).toBe(REVIEWER_AUTHOR);
      expect(last.body).toContain("without a verdict");
      expect(calls.length).toBe(1);
      stop?.();
    }
  });

  test("pause kill ends every in-flight session across slots", async () => {
    const { dbFile, writer: w } = setup();
    poolShim(w, "p-pause", {
      name: "pause pool",
      enabled: true,
      roles: ["reviewer"],
      slots: [{ model: "s-0" }, { model: "s-1" }],
    });
    const c1 = cardInReview(w, "card 1");
    await sleep(2);
    const c2 = cardInReview(w, "card 2");

    const spawnFn: SpawnFn = (job, ctx) =>
      new Promise<SpawnResult>((resolve) => {
        ctx.track(() => {
          resolve({ code: 143 });
        });
      });

    start(spawnFn, dbFile);
    await sleep(50);

    const killed = killAgentSessions();
    expect(killed).toBe(2);

    await sleep(50);
    const last1 = db!.comments(c1.id).at(-1)!;
    expect(last1.body).toStartWith(KanbanDb.SESSION_DIED_PREFIX);
    expect(last1.body).toContain("exit 143");
    const last2 = db!.comments(c2.id).at(-1)!;
    expect(last2.body).toStartWith(KanbanDb.SESSION_DIED_PREFIX);
    expect(last2.body).toContain("exit 143");
  });

  test("agentFlags: the engine maps onto pi flags, the actor's behavior follows, engine flags last", () => {
    const skillDir = makeSkill("demo", "# Rules\nBe terse.");
    const engine = eng({ provider: "anthropic", model: "claude-opus-4-5", thinking: "high", flags: ["--offline"] });
    expect(
      agentFlags("reviewer", engine, {
        skills: [skillDir],
        context: "we value perf",
        tools: "-edit",
        extraArgs: ["--no-mcp"],
      }),
    ).toEqual([
      "--provider",
      "anthropic",
      "--model",
      "claude-opus-4-5",
      "--thinking",
      "high",
      "--skill",
      skillDir,
      "--append-system-prompt",
      `we value perf\n\n<skill name="demo" location="${join(skillDir, "SKILL.md")}">\nReferences are relative to ${skillDir}.\n\n# Rules\nBe terse.\n</skill>`,
      "--tools",
      "-edit",
      "--no-mcp",
      "--offline",
    ]);
  });

  test("claudeFlags: model alias, /tmp writable, skills as prompt text, role allowlist, no pi-only fields", () => {
    const skillDir = makeSkill("demo", "Be terse.");
    const engine = eng({ harness: "claude", model: "opus", flags: ["--max-turns", "40"] });
    const args = claudeFlags("planner", engine, { skills: [skillDir], context: "ctx", tools: "-edit", extraArgs: ["--no-mcp"] });
    expect(args.slice(0, 5)).toEqual(["--output-format", "stream-json", "--verbose", "--model", "opus"]);
    expect(args).toContain("--add-dir");
    expect(args[args.indexOf("--append-system-prompt") + 1]).toContain('<skill name="demo"');
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(CLAUDE_READ_TOOLS.join(","));
    expect(args).not.toContain("--effort"); // unset effort = claude's own default
    expect(args).not.toContain("--no-mcp"); // a pi flag never reaches claude
    expect(args).not.toContain("-edit");
    expect(args.slice(-2)).toEqual(["--max-turns", "40"]);
    expect(claudeFlags("builder", eng({ harness: "claude" }), null)[4]).toBe("sonnet");
    expect(claudeFlags("builder", eng({ harness: "claude" }), null)).toContain(CLAUDE_BUILD_TOOLS.join(","));
    const effort = claudeFlags("builder", eng({ harness: "claude", model: "opus", thinking: "xhigh" }), null);
    expect(effort[effort.indexOf("--effort") + 1]).toBe("xhigh");
  });

  test("resolvedModelConfig: the engine's fields; thinking falls back to the role default on pi only", () => {
    expect(resolvedModelConfig("reviewer", eng({}))).toEqual({ harness: "pi", thinking: "max" });
    expect(resolvedModelConfig("builder", eng({}))).toEqual({ harness: "pi" });
    expect(resolvedModelConfig("reviewer", eng({ provider: "anthropic", model: "claude-x", thinking: "high" }))).toEqual({
      harness: "pi",
      provider: "anthropic",
      model: "claude-x",
      thinking: "high",
    });
    expect(resolvedModelConfig("reviewer", eng({ harness: "claude", model: "sonnet" }))).toEqual({ harness: "claude", model: "sonnet" });
    expect(resolvedModelConfig("builder", eng({ harness: "claude", model: "opus", thinking: "high" }))).toEqual({ harness: "claude", model: "opus", thinking: "high" });
  });

  test("modelConfigLabel: provider · model · thinking, default-model fallback, claude labelled by harness", () => {
    expect(modelConfigLabel({ provider: "anthropic", model: "claude-x", thinking: "high" })).toBe("anthropic · claude-x · high");
    expect(modelConfigLabel({ model: "gemini-4-argon", thinking: "high" })).toBe("gemini-4-argon · high");
    expect(modelConfigLabel({})).toBe("default model");
    expect(modelConfigLabel({ harness: "claude", model: "opus" })).toBe("claude · opus");
    expect(modelConfigLabel({ harness: "claude", model: "opus", thinking: "max" })).toBe("claude · opus · max");
  });

  test("KANBAN_ENGINE pins every spawn to one engine, beating project and actor lineups", async () => {
    const { dbFile, writer: w } = setup();
    w.setEngine("a", { name: "A", harness: "pi", model: "a" });
    w.setEngine("b", { name: "B", harness: "pi", model: "b" });
    w.setAgentConfig("reviewer", { runsOn: ["a"] });
    cardInReview(w);
    const models: string[] = [];
    const spawnFn: SpawnFn = (_job, ctx) => {
      models.push(ctx.engine.model ?? "");
      return Promise.resolve({ code: 1 });
    };
    process.env.KANBAN_ENGINE = "B";
    try {
      start(spawnFn, dbFile);
      await sleep(30);
    } finally {
      delete process.env.KANBAN_ENGINE;
    }
    expect(models).toEqual(["b"]);
  });

  test("a claude engine gets a UUID session id; a pi resume onto claude starts fresh", async () => {
    const { dbFile, writer: w } = setup();
    w.setEngine("sonnet", { name: "Sonnet", harness: "claude", model: "sonnet" });
    w.setAgentConfig("reviewer", { runsOn: ["sonnet"] });
    cardInReview(w);
    const seen: Array<{ engine: string; sessionId?: string }> = [];
    const spawnFn: SpawnFn = (job, ctx) => {
      seen.push({ engine: ctx.engine.harness, sessionId: job.sessionId });
      return Promise.resolve({ code: 1 });
    };
    start(spawnFn, dbFile);
    await sleep(30);
    expect(seen[0]!.engine).toBe("claude");
    expect(isClaudeSessionId(seen[0]!.sessionId)).toBe(true);
    expect(isClaudeSessionId("kanban-abc-reviewer-xyz")).toBe(false);
  });

  test("defaults: 2h total cap, 10 min stall window", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(7_200_000);
    expect(DEFAULT_STALL_MS).toBe(600_000);
  });

  test("spawn carries the board config: context, skills and timeout reach the session", async () => {
    const { dbFile, writer: w } = setup();
    cardInReview(w);
    w.setEngine("opus", { name: "Opus", harness: "pi", model: "claude-opus-4-5" });
    w.setAgentConfig("reviewer", {
      runsOn: ["opus"],
      skills: [makeSkill("lens", "review with perf in mind")],
      context: "we value perf over features",
      timeoutMs: 300_000,
    });
    const seen: Array<{ flags: string[]; timeoutMs: number }> = [];
    const spawnFn: SpawnFn = (job, ctx) => {
      seen.push({ flags: agentFlags(job.role, ctx.engine, ctx.config), timeoutMs: ctx.timeoutMs });
      return Promise.resolve({ code: 1 }); // session "fails": no verdict, so the loop stops here
    };
    start(spawnFn, dbFile);
    await sleep(20);
    expect(seen[0]!.flags).toContain("--append-system-prompt");
    expect(seen[0]!.flags).toContain("--skill");
    expect(seen[0]!.flags).toContain("claude-opus-4-5");
    expect(seen[0]!.timeoutMs).toBe(300_000);
  });

  test("spawn context carries stallMs from loop options", async () => {
    const { dbFile, writer: w } = setup();
    cardInReview(w);
    w.setAgentConfig("reviewer", { timeoutMs: 300_000 });
    let seenCtx: SpawnContext | null = null;
    const spawnFn: SpawnFn = (_job, ctx) => {
      seenCtx = ctx;
      return Promise.resolve({ code: 1 });
    };
    const handle = startAutoReview({ db: setDb(new KanbanDb(dbFile)), cwd: dir, spawnFn, stallMs: 123_456, watchIntervalMs: 50, gate: null });
    setStop(() => handle.stop());
    await sleep(20);
    expect(seenCtx).not.toBeNull();
    expect(seenCtx!.stallMs).toBe(123_456);
    expect(seenCtx!.timeoutMs).toBe(300_000);
  });

  test("spawn context uses DEFAULT_STALL_MS when stallMs is omitted", async () => {
    const { dbFile, writer: w } = setup();
    cardInReview(w);
    let seenCtx: SpawnContext | null = null;
    const spawnFn: SpawnFn = (_job, ctx) => {
      seenCtx = ctx;
      return Promise.resolve({ code: 1 });
    };
    start(spawnFn, dbFile);
    await sleep(20);
    expect(seenCtx).not.toBeNull();
    expect(seenCtx!.stallMs).toBe(DEFAULT_STALL_MS);
  });

  test("spawn injects configured skills into the session's system prompt", async () => {
    const { dbFile, writer: w } = setup();
    cardInReview(w);
    const skillDir = makeSkill("caveman", "Answer first. Keep every fact. Cut the fluff.");
    w.setAgentConfig("reviewer", { skills: [skillDir] });
    const seen: string[][] = [];
    const spawnFn: SpawnFn = (job, ctx) => {
      seen.push(agentFlags(job.role, ctx.engine, ctx.config));
      return Promise.resolve({ code: 1 });
    };
    start(spawnFn, dbFile);
    await sleep(20);
    const appended = seen[0]![seen[0]!.indexOf("--append-system-prompt") + 1]!;
    expect(appended).toContain(`<skill name="caveman" location="${join(skillDir, "SKILL.md")}">`);
    expect(appended).toContain("Answer first. Keep every fact. Cut the fluff.");
    expect(appended).toContain("</skill>");
  });

  test("sessionIdFor: fresh per role and per spawn, valid pi session id", () => {
    const task = { id: "abc12", title: "t", laneId: "plan" } as never;
    const planner = sessionIdFor({ task, role: "planner", prompt: "" }, 1_000);
    const builder = sessionIdFor({ task, role: "builder", prompt: "" }, 1_000);
    const later = sessionIdFor({ task, role: "planner", prompt: "" }, 2_000);
    for (const id of [planner, builder, later]) {
      expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/);
      expect(id).toStartWith("kanban-abc12-");
    }
    expect(planner).not.toBe(builder);
    expect(planner).not.toBe(later);
  });

  test("every fresh spawn persists its minted session id", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await sleep(20);
    expect(calls.length).toBe(1);
    expect(calls[0].job.sessionId).toBeDefined();
    expect(calls[0].job.sessionId).toStartWith(`kanban-${card.id}-reviewer-`);
    const stored = db!.cardSession(card.id);
    expect(stored).toEqual({ role: "reviewer", sessionId: calls[0].job.sessionId! });
  });

  test("formatPiEvent renders signal events, drops noise", () => {
    expect(formatPiEvent('{"type":"session","version":3,"id":"x","cwd":"/y"}')).toBe("session started");
    expect(
      formatPiEvent(
        '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"looks good\\nverdict soon"}]}}',
      ),
    ).toBe("text: looks good verdict soon");
    expect(formatPiEvent('{"type":"message_end","message":{"role":"user","content":[]}}')).toBeNull();
    expect(formatPiEvent('{"type":"tool_execution_start","toolName":"bash","args":{"command":"bun test"}}')).toBe(
      "→ bash: bun test",
    );
    expect(formatPiEvent('{"type":"tool_execution_end","toolName":"bash","durationMs":240,"isError":false}')).toBe(
      "✓ bash 240ms",
    );
    expect(formatPiEvent('{"type":"tool_execution_end","toolName":"edit","isError":true}')).toBe("✗ edit");
    expect(
      formatPiEvent('{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"errorMessage":"529 overloaded"}'),
    ).toBe("retry 1/3: 529 overloaded");
    expect(formatPiEvent('{"type":"compaction_start","reason":"threshold"}')).toBe("compacting (threshold)");
    expect(formatPiEvent('{"type":"message_update","usage":{"input":10}}')).toBeNull();
    expect(
      formatPiEvent('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hel"}}'),
    ).toBeNull();
    expect(formatPiEvent("not json")).toBeNull();
    const long = "x".repeat(400);
    expect(formatPiEvent(`{"type":"tool_execution_start","toolName":"bash","args":{"command":"${long}"}}`)!.length).toBeLessThanOrEqual(220);
  });

  test("formatPiEvent renders model errors, exhausted retries and unknown error events", () => {
    expect(
      formatPiEvent(
        '{"type":"message_end","message":{"role":"assistant","stopReason":"error","errorMessage":"usage limit reached"}}',
      ),
    ).toBe("✗ model error: usage limit reached");
    expect(
      formatPiEvent('{"type":"message_end","message":{"role":"assistant","stopReason":"error"}}'),
    ).toBe("✗ model error: unknown error");
    expect(
      formatPiEvent('{"type":"auto_retry_end","success":false,"finalError":"429 quota exceeded"}'),
    ).toBe("retries exhausted: 429 quota exceeded");
    expect(
      formatPiEvent('{"type":"auto_retry_end","success":true}'),
    ).toBeNull();
    expect(
      formatPiEvent('{"type":"compaction_end","errorMessage":"disk full"}'),
    ).toBe("✗ compaction failed: disk full");
    expect(
      formatPiEvent('{"type":"compaction_end"}'),
    ).toBeNull();
    expect(formatPiEvent('{"type":"agent_settled","aborted":true}')).toBe("settled (aborted)");
    expect(formatPiEvent('{"type":"agent_settled","aborted":false}')).toBe("settled");
    expect(formatPiEvent('{"type":"whatever","errorMessage":"boom"}')).toBe("⚠ whatever: boom");
    expect(formatPiEvent('{"type":"whatever"}')).toBeNull();
    expect(formatPiEvent('{"type":"whatever","errorMessage":"   "}')).toBeNull();
  });

  test("durationFor rounds seconds and minutes accurately", () => {
    expect(durationFor(8)).toBe("8s");
    expect(durationFor(59)).toBe("59s");
    expect(durationFor(60)).toBe("1 min");
    expect(durationFor(1200)).toBe("20 min");
  });

  test("deathReason names timeouts, exit codes and silent clean exits", () => {
    expect(deathReason({ code: 1, stalled: true, stalledAfterMs: 600_000 }, 720, [])).toBe(
      "stalled after 12 min — no output for 10 min",
    );
    expect(deathReason({ code: 1, timedOut: true }, 1200, [])).toBe("timed out after 20 min");
    expect(
      deathReason({ code: 1, stderrTail: "line\nError: ECONNREFUSED" }, 4, []),
    ).toBe("failed (exit 1 — Error: ECONNREFUSED) after 4s");
    expect(deathReason({ code: 0 }, 8, [])).toBe(
      "ended without a verdict after 8s — model returned no output",
    );
    expect(deathReason({ code: 0 }, 30, ["session started", "text: looks good"])).toBe(
      "ended without a verdict after 30s",
    );
  });

  test("stderr tail is captured on exit 0 and lands in the session attachment", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const spawnFn: SpawnFn = (_job, context) => {
      context.emit("session started");
      return Promise.resolve({ code: 0, stderrTail: "provider: usage limit reached (HTTP 429)" });
    };
    start(spawnFn, dbFile);
    await sleep(30);
    const logs = db!.attachments(card.id, "session");
    expect(logs.length).toBe(1);
    expect(logs[0]!.content).toContain("stderr tail:");
    expect(logs[0]!.content).toContain("provider: usage limit reached (HTTP 429)");
  });

  test("reviewer death comment names exit code, stderr line and duration", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const spawnFn: SpawnFn = () =>
      Promise.resolve({ code: 1, stderrTail: "line\nError: ECONNREFUSED" });
    start(spawnFn, dbFile);
    await sleep(30);
    const last = db!.comments(card.id).at(-1)!;
    expect(last.author).toBe(REVIEWER_AUTHOR);
    expect(last.body).toStartWith(
      "session died: auto-review failed (exit 1 — Error: ECONNREFUSED) after",
    );
    expect(last.body).toEndWith("; comment on this card to re-trigger.");
  });

  test("reviewer death comment names a stall kill", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const spawnFn: SpawnFn = () =>
      Promise.resolve({ code: 1, stalled: true, stalledAfterMs: 600_000 });
    start(spawnFn, dbFile);
    await sleep(30);
    const last = db!.comments(card.id).at(-1)!;
    expect(last.author).toBe(REVIEWER_AUTHOR);
    expect(last.body).toStartWith("session died: auto-review stalled after");
    expect(last.body).toContain("no output for 10 min");
    expect(last.body).toEndWith("— auto-retry 1/2 (stall)");
  });

  test("defaultSpawn kills a silent session at the stall window and reports stalled", async () => {
    await withFakePi(
      `console.log(JSON.stringify({ type: "session" }));\nawait Bun.sleep(60_000);`,
      async () => {
        const { dbFile, writer: w } = setup();
        const card = cardInReview(w);
        const logs: string[] = [];
        const emitted: string[] = [];
        const job: AgentJob = { task: card, role: "reviewer", prompt: "review" };
        const ctx: SpawnContext = {
          cwd: dir,
          timeoutMs: 30_000,
          stallMs: 500,
          config: null,
          engine: eng({}),
          log: (msg) => logs.push(msg),
          emit: (line) => emitted.push(line),
          track: () => () => {},
        };
        const start = Date.now();
        const result = await defaultSpawn(job, ctx);
        expect(Date.now() - start).toBeLessThan(5000);
        expect(result.code).toBe(1);
        expect(result.stalled).toBe(true);
        expect(result.stalledAfterMs).toBe(500);
        expect(result.timedOut).toBeUndefined();
        expect(logs.some((l) => l.includes("stalled — no output for 0.5s, killed"))).toBe(true);
      },
    );
  });

  test("defaultSpawn lets a continuously streaming session finish naturally", async () => {
    await withFakePi(
      `for (let i = 0; i < 12; i++) {\n  console.log(JSON.stringify({ type: "message_update" }));\n  await Bun.sleep(100);\n}\nprocess.exit(0);`,
      async () => {
        const { dbFile, writer: w } = setup();
        const card = cardInReview(w);
        const logs: string[] = [];
        const emitted: string[] = [];
        const job: AgentJob = { task: card, role: "reviewer", prompt: "review" };
        const ctx: SpawnContext = {
          cwd: dir,
          timeoutMs: 30_000,
          stallMs: 500,
          config: null,
          engine: eng({}),
          log: (msg) => logs.push(msg),
          emit: (line) => emitted.push(line),
          track: () => () => {},
        };
        const start = Date.now();
        const result = await defaultSpawn(job, ctx);
        expect(Date.now() - start).toBeGreaterThanOrEqual(1000);
        expect(result.code).toBe(0);
        expect(result.stalled).toBeUndefined();
        expect(result.timedOut).toBeUndefined();
      },
    );
  }, 20_000); // streams 12×100ms through a fake pi — 5s default flakes under full-suite load

  test("defaultSpawn still kills an endless stream at the total cap", async () => {
    await withFakePi(
      `while (true) {\n  console.log(JSON.stringify({ type: "message_update" }));\n  await Bun.sleep(50);\n}`,
      async () => {
        const { dbFile, writer: w } = setup();
        const card = cardInReview(w);
        const logs: string[] = [];
        const emitted: string[] = [];
        const job: AgentJob = { task: card, role: "reviewer", prompt: "review" };
        const ctx: SpawnContext = {
          cwd: dir,
          timeoutMs: 800,
          stallMs: 5_000,
          config: null,
          engine: eng({}),
          log: (msg) => logs.push(msg),
          emit: (line) => emitted.push(line),
          track: () => () => {},
        };
        const start = Date.now();
        const result = await defaultSpawn(job, ctx);
        expect(Date.now() - start).toBeLessThan(5000);
        expect(result.code).toBe(1);
        expect(result.timedOut).toBe(true);
        expect(result.stalled).toBeUndefined();
      },
    );
  });

  test("simulated spawn exiting 0 without a verdict leaves a reason comment and a diagnostic attachment", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const spawnFn: SpawnFn = () =>
      Promise.resolve({ code: 0, stderrTail: "quota exceeded" });
    start(spawnFn, dbFile);
    await sleep(30);
    const last = db!.comments(card.id).at(-1)!;
    expect(last.body).toContain("session died: auto-review ended without a verdict after");
    expect(last.body).toContain("model returned no output");
    expect(last.body).toEndWith("— auto-retry 1/2 (no-output)");
    const logs = db!.attachments(card.id, "session");
    expect(logs.length).toBe(1);
    expect(logs[0]!.content).toContain("stderr tail:");
    expect(logs[0]!.content).toContain("quota exceeded");
  });

  test("every finished session records its model config in header and first log line", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    w.setEngine("x", { name: "X", harness: "pi", provider: "anthropic", model: "claude-x", thinking: "high" });
    w.setAgentConfig("reviewer", { runsOn: ["x"] });
    const spawnFn: SpawnFn = (_job, context) => {
      context.emit("session started");
      return Promise.resolve({ code: 0 });
    };
    start(spawnFn, dbFile);
    await sleep(30);
    const logs = db!.attachments(card.id, "session");
    expect(logs.length).toBe(1);
    const lines = logs[0]!.content.split("\n");
    expect(lines[0]).toStartWith("pi-reviewer · anthropic · claude-x · high · ");
    expect(lines[1]).toMatch(/^\d{2}:\d{2}:\d{2} model: anthropic · claude-x · high$/);
  });

  test("silent sessions still record their header and model config", async () => {
    const { dbFile, writer: w } = setup();
    const card = w.createTask({ title: "silent builder", lane: "plan" });
    w.attach(card.id, "plan", "# Plan", "user");
    w.approveTask(card.id, { author: "user" }); // moves to implement, arms builder
    const spawnFn: SpawnFn = () => Promise.resolve({ code: 0 });
    start(spawnFn, dbFile);
    await sleep(40);
    const logs = db!.attachments(card.id, "session");
    expect(logs.length).toBe(1);
    const lines = logs[0]!.content.split("\n");
    expect(lines[0]).toStartWith("pi-builder · default model · ");
    expect(lines[1]).toMatch(/^\d{2}:\d{2}:\d{2} model: default model$/);
  });

  test("activity registry: session lists with emitted lines, clears when the job ends", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    let ctx!: SpawnContext;
    let finish!: (result: SpawnResult) => void;
    const spawnFn: SpawnFn = (job, context) => {
      ctx = context;
      return new Promise<SpawnResult>((resolve) => (finish = resolve));
    };
    start(spawnFn, dbFile);
    expect(activitySnapshot().sessions.map((s) => s.taskId)).toEqual([card.id]);
    const born = activitySnapshot().sessions[0]!;
    expect(born.lastActivityAt).toBe(born.startedAt); // no output yet — activity starts at birth
    await sleep(20);
    ctx.emit("session started");
    const stirred = activitySnapshot().sessions[0]!;
    expect(stirred.lastActivityAt).toBeGreaterThan(born.startedAt); // a formatted line is activity
    ctx.emit("→ bash: bun test");
    const snap = activitySnapshot().sessions[0]!;
    expect(snap.role).toBe("reviewer");
    expect(snap.modelLabel).toBe("default model · max");
    expect(snap.log).toEqual(["model: default model · max", "session started", "→ bash: bun test"]);
    finish({ code: 0 });
    await sleep(20);
    expect(activitySnapshot().sessions.some((s) => s.taskId === card.id)).toBe(false);
  });

  test("activity registry: each log line carries its arrival time in logAt", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    let ctx!: SpawnContext;
    let finish!: (result: SpawnResult) => void;
    const spawnFn: SpawnFn = (_job, context) => {
      ctx = context;
      return new Promise<SpawnResult>((resolve) => (finish = resolve));
    };
    start(spawnFn, dbFile);
    await sleep(20);
    ctx.emit("session started");
    await sleep(5);
    ctx.emit("→ bash: bun test");
    const snap = activitySnapshot().sessions[0]!;
    expect(snap.log).toEqual(["model: default model · max", "session started", "→ bash: bun test"]);
    expect(snap.logAt.length).toBe(3);
    expect(snap.logAt.every((t, i) => i === 0 || t >= snap.logAt[i - 1]!)).toBe(true);
    expect(snap.logAt[0]).toBeGreaterThanOrEqual(snap.startedAt);
    expect(snap.logAt[2]).toBeLessThanOrEqual(snap.lastActivityAt); // touch() bumps lastActivityAt without an emit
    expect(snap.logAt[2]).toBeLessThanOrEqual(Date.now());
    finish({ code: 0 });
    await sleep(20);
  });

  test("activity registry: logAt trims in lockstep with log at the line cap", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    let ctx!: SpawnContext;
    let finish!: (result: SpawnResult) => void;
    const spawnFn: SpawnFn = (_job, context) => {
      ctx = context;
      return new Promise<SpawnResult>((resolve) => (finish = resolve));
    };
    start(spawnFn, dbFile);
    await sleep(20);
    for (let i = 0; i < 160; i++) ctx.emit(`line ${i}`);
    const snap = activitySnapshot().sessions[0]!;
    expect(snap.log.length).toBe(150);
    expect(snap.logAt.length).toBe(150);
    expect(snap.log[149]).toBe("line 159");
    finish({ code: 0 });
    await sleep(20);
  });

  test("saved session log stamps each entry and keeps the header", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    let ctx!: SpawnContext;
    let finish!: (result: SpawnResult) => void;
    const spawnFn: SpawnFn = (_job, context) => {
      ctx = context;
      return new Promise<SpawnResult>((resolve) => (finish = resolve));
    };
    start(spawnFn, dbFile);
    await sleep(20);
    ctx.emit("session started");
    const snap = activitySnapshot().sessions[0]!;
    finish({ code: 0 });
    await sleep(20);
    const logs = db!.attachments(card.id, "session");
    expect(logs.length).toBe(1);
    const content = logs[0]!.content;
    expect(content.split("\n")[0]).toMatch(/^pi-reviewer · default model · max · .* · \d+s$/);
    const body = content.slice(content.indexOf("\n") + 1);
    expect(body).toBe(stampSessionLog(snap.log, snap.logAt));
    expect(content.split("\n")[1]).toMatch(/^\d{2}:\d{2}:\d{2} model: default model · max$/);
  });

  test("card stats still sum a stamped session log's duration", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const spawnFn: SpawnFn = (_job, context) => {
      context.emit("session started");
      return Promise.resolve({ code: 0 });
    };
    start(spawnFn, dbFile);
    await sleep(40);
    const stats = db!.cardStats(card.id);
    expect(stats.sessions.count).toBe(1);
    expect(stats.sessions.totalMs).toBeGreaterThanOrEqual(1000);
  });

  test("activity registry: raw child output counts as activity even when the formatter drops it", async () => {
    // the zcode case: stream bytes flow but every line formats to null — the log
    // stays silent while lastActivityAt keeps proving the session alive
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    let ctx!: SpawnContext;
    let finish!: (result: SpawnResult) => void;
    const spawnFn: SpawnFn = (_job, context) => {
      ctx = context;
      return new Promise<SpawnResult>((resolve) => (finish = resolve));
    };
    start(spawnFn, dbFile);
    const born = activitySnapshot().sessions[0]!;
    await sleep(20);
    ctx.touch?.();
    const touched = activitySnapshot().sessions[0]!;
    expect(touched.lastActivityAt).toBeGreaterThan(born.startedAt);
    expect(touched.log).toEqual(["model: default model · max"]); // nothing formatted — only the spawn line
    finish({ code: 0 });
    await sleep(20);
    expect(activitySnapshot().sessions.length).toBe(0);
  });

  test("killAgentSession ends one session through the normal death path", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const other = cardInReview(w, "other card");
    let killed = false;
    let resolveSpawn!: (r: SpawnResult) => void;
    const spawnFn: SpawnFn = (job, ctx) => {
      ctx.track(() => {
        killed = true;
        resolveSpawn({ code: 143 });
      });
      return new Promise<SpawnResult>((r) => (resolveSpawn = r));
    };
    start(spawnFn, dbFile);
    await sleep(150); // one of the two cards holds the serial drain slot

    // the drain is serial — kill whichever session is actually live, not a guessed id
    const live = activitySnapshot().sessions[0]!;
    expect([card.id, other.id]).toContain(live.taskId);
    expect(killAgentSession("nope")).toBe(false); // unknown id: nothing to kill
    expect(killAgentSession(live.taskId)).toBe(true);
    expect(killed).toBe(true);
    await sleep(50);
    // the killed session leaves a death trace; the untouched card keeps its handoff as the last comment
    const last = w.comments(live.taskId).at(-1)!;
    expect(last.author).toBe(REVIEWER_AUTHOR);
    expect(last.body).toContain("comment on this card to re-trigger");
    const survivor = live.taskId === card.id ? other.id : card.id;
    expect(w.comments(survivor).at(-1)!.kind).toBe("handoff");
    // the killed id is gone; whatever holds the drain slot next is not it
    expect(activitySnapshot().sessions.every((s) => s.taskId !== live.taskId)).toBe(true);
  });

  test("activity registry: stop() clears sessions even with a pending spawn", () => {
    const { dbFile, writer: w } = setup();
    cardInReview(w);
    const spawnFn: SpawnFn = () => new Promise<SpawnResult>(() => {});
    const handle = start(spawnFn, dbFile);
    expect(activitySnapshot().sessions.length).toBe(1);
    handle.stop();
    expect(activitySnapshot().sessions.length).toBe(0);
  });

  test("queued jobs appear in activitySnapshot while another session runs", async () => {
    const { dbFile, writer: w } = setup();
    const first = cardInReview(w, "first");
    await sleep(2);
    const second = cardInReview(w, "second");
    const { calls, spawnFn } = fakeSpawn();
    withAgentEnv({}, () => start(spawnFn, dbFile));
    expect(calls.length).toBe(1);
    expect(activitySnapshot().sessions.map((s) => s.taskId)).toEqual([first.id]);
    expect(activitySnapshot().queued).toEqual([
      expect.objectContaining({ taskId: second.id, role: "reviewer", enqueuedAt: expect.any(Number) }),
    ]);
  });

  test("a queued job moves from queued to sessions when it starts", async () => {
    const { dbFile, writer: w } = setup();
    const first = cardInReview(w, "first");
    await sleep(2);
    const second = cardInReview(w, "second");
    const { calls, spawnFn } = fakeSpawn();
    withAgentEnv({}, () => start(spawnFn, dbFile));
    expect(calls.length).toBe(1);
    const firstId = calls[0].job.task.id;
    await w.handoff(firstId, "done", { kind: "review", author: REVIEWER_AUTHOR, message: "approved" });
    calls[0].finish({ code: 0 });
    await sleep(20);
    expect(calls.length).toBe(2);
    expect(activitySnapshot().sessions.map((s) => s.taskId)).toEqual([second.id]);
    expect(activitySnapshot().queued).toEqual([]);
  });

  test("a stale queue entry is dropped when roleFor no longer matches", async () => {
    const { dbFile, writer: w } = setup();
    const first = cardInReview(w, "first");
    await sleep(2);
    const second = cardInReview(w, "second");
    const { calls, spawnFn } = fakeSpawn();
    withAgentEnv({}, () => start(spawnFn, dbFile));
    expect(calls.length).toBe(1);
    expect(activitySnapshot().queued.map((q) => q.taskId)).toEqual([second.id]);
    await w.createComment(second.id, { author: REVIEWER_AUTHOR, kind: "comment", body: "no verdict" });
    await w.handoff(first.id, "done", { kind: "review", author: REVIEWER_AUTHOR, message: "approved" });
    calls[0].finish({ code: 0 });
    await sleep(20);
    expect(calls.length).toBe(1);
    expect(activitySnapshot().queued).toEqual([]);
    expect(activitySnapshot().sessions).toEqual([]);
  });

  test("enqueue logs 'queued — behind' while a session runs", async () => {
    const { dbFile, writer: w } = setup();
    const first = cardInReview(w, "first");
    const logs: string[] = [];
    const { calls, spawnFn } = fakeSpawn();
    withAgentEnv({}, () => {
      const handle = startAutoReview({
        db: setDb(new KanbanDb(dbFile)),
        cwd: dir,
        spawnFn,
        watchIntervalMs: 50,
        gate: null,
        log: (msg) => logs.push(msg),
      });
      setStop(() => handle.stop());
    });
    expect(calls.length).toBe(1);
    expect(logs.some((l) => l.includes("queued"))).toBe(false);

    const second = cardInReview(w, "second");
    await sleep(80);

    const queuedLog = logs.find((l) => l.includes("queued"));
    expect(queuedLog).toBeDefined();
    expect(queuedLog).toMatch(new RegExp(`^reviewer queued ${second.id} — behind reviewer ${first.id}$`));
  });

  test("a queued resume re-spawns the dead role with the stored session id", async () => {
    const { dbFile, writer: w } = setup();
    const card = w.createTask({ title: "dead builder", lane: "implement" });
    w.createComment(card.id, { author: BUILDER_AUTHOR, kind: "comment", body: "session died: timeout after 20m" });
    w.setCardSession(card.id, "builder", "kanban-x-builder-1");
    w.queueResume(card.id);

    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await sleep(50);

    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("builder");
    expect(calls[0].job.sessionId).toBe("kanban-x-builder-1");
    expect(calls[0].job.prompt).toContain("continues that same session");
    expect(calls[0].job.prompt).toContain(`kanban handoff ${card.id} review`);
  });

  test("one resume serviced when two loops share the db", async () => {
    const { dbFile, writer: w } = setup();
    const card = w.createTask({ title: "shared db resume", lane: "implement" });
    w.createComment(card.id, { author: BUILDER_AUTHOR, kind: "comment", body: "session died: crash" });
    w.setCardSession(card.id, "builder", "kanban-x-builder-shared");
    w.queueResume(card.id);

    const a = fakeSpawn();
    const b = fakeSpawn();
    const dbA = new KanbanDb(dbFile);
    const dbB = new KanbanDb(dbFile);
    const hA = startAutoReview({ db: dbA, cwd: dir, spawnFn: a.spawnFn, watchIntervalMs: 50, gate: null });
    const hB = startAutoReview({ db: dbB, cwd: dir, spawnFn: b.spawnFn, watchIntervalMs: 50, gate: null });
    setStop(() => {
      hA.stop();
      hB.stop();
      dbA.close();
      dbB.close();
    });
    await sleep(500);
    expect(a.calls.length + b.calls.length).toBe(1);
  });

  test("a resume job is dropped when the card is no longer dead at take time", async () => {
    const { dbFile, writer: w } = setup();
    const card = w.createTask({ title: "no longer dead", lane: "implement" });
    w.createComment(card.id, { author: BUILDER_AUTHOR, kind: "comment", body: "session died: crash" });
    w.setCardSession(card.id, "builder", "kanban-x-builder-drop");
    w.queueResume(card.id);

    // Human comments before loop starts/drains → card no longer dead
    w.createComment(card.id, { author: "user", kind: "comment", body: "i fixed it manually" });

    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await sleep(150);

    expect(calls.length).toBe(0);
    expect(db!.resumeRequests()).toEqual([]);
  });

  test("a resumed session streams into activity and saves its transcript", async () => {
    const { dbFile, writer: w } = setup();
    const card = w.createTask({ title: "activity transcript", lane: "implement" });
    w.createComment(card.id, { author: BUILDER_AUTHOR, kind: "comment", body: "session died: crash" });
    w.setCardSession(card.id, "builder", "kanban-x-builder-act");
    w.queueResume(card.id);

    let ctx!: SpawnContext;
    let finish!: (result: SpawnResult) => void;
    const spawnFn: SpawnFn = (_job, context) => {
      ctx = context;
      return new Promise<SpawnResult>((resolve) => (finish = resolve));
    };
    start(spawnFn, dbFile);
    await sleep(50);

    ctx.emit("→ bash: bun test");
    const snap = activitySnapshot().sessions.find((s) => s.taskId === card.id);
    expect(snap?.modelLabel).toBe("default model");
    expect(snap?.log).toEqual(["model: default model", "→ bash: bun test"]);

    finish({ code: 0 });
    await sleep(50);

    const attachments = db!.attachments(card.id, "session");
    expect(attachments.length).toBe(1);
    expect(attachments[0].content).toMatch(/^pi-builder · default model ·/);
  });

  test("the resume-start comment clears waiting-dead; a second death re-posts a fresh reason", async () => {
    const { dbFile, writer: w } = setup();
    const card = w.createTask({ title: "death cycle", lane: "implement" });
    w.createComment(card.id, { author: BUILDER_AUTHOR, kind: "comment", body: "session died: first failure" });
    w.setCardSession(card.id, "builder", "kanban-x-builder-cycle");
    expect(w.waiting(card.id)).toBe("dead");

    w.queueResume(card.id);

    let finish!: (result: SpawnResult) => void;
    const spawnFn: SpawnFn = () => new Promise<SpawnResult>((resolve) => (finish = resolve));
    start(spawnFn, dbFile);
    await sleep(50);

    const startComment = db!.comments(card.id).at(-1)!;
    expect(startComment.author).toBe("kanban");
    expect(startComment.kind).toBe("comment");
    expect(startComment.body).toStartWith("session resumed: ");
    expect(startComment.body).toContain("kanban-x-builder-cycle");
    expect(db!.waiting(card.id)).toBeNull();

    finish({ code: 1, stderrTail: "second failure reason" });
    await sleep(50);

    expect(db!.waiting(card.id)).toBe("dead");
    const deathComment = db!.comments(card.id).at(-1)!;
    expect(deathComment.author).toBe(BUILDER_AUTHOR);
    expect(deathComment.body).toStartWith("session died: ");
    expect(deathComment.body).toContain("second failure reason");
  });

  test("a fresh re-run mints a new session id — the pointer follows", async () => {
    const { dbFile, writer: w } = setup();
    const card = w.createTask({ title: "fresh re-run", lane: "implement" });
    // Simulate plan approval to arm the builder
    w.createComment(card.id, { author: "user", kind: "approval", body: "plan approved — build it" });
    w.createComment(card.id, { author: BUILDER_AUTHOR, kind: "comment", body: "session died: exit 1" });
    w.setCardSession(card.id, "builder", "kanban-old-session-id");

    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);

    // Human comment re-arms the builder
    await w.createComment(card.id, { author: "user", kind: "comment", body: "try again" });
    await sleep(50);

    expect(calls.length).toBe(1);
    expect(calls[0].job.sessionId).not.toBe("kanban-old-session-id");
    expect(db!.cardSession(card.id)?.sessionId).toBe(calls[0].job.sessionId);
  });
});
