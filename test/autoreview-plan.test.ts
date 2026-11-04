import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KanbanDb } from "../src/db";
import {
  BUILDER_AUTHOR,
  PLANNER_AUTHOR,
  PLAN_REVIEWER_AUTHOR,
  PLAN_SECTIONS,
  PLAN_TEMPLATE,
  REVIEWER_AUTHOR,
  agentFlags,
  builderPlanPrompt,
  plannerPrompt,
  planReviewerPrompt,
  startAutoReview,
  type SpawnFn,
  type SpawnResult,
} from "../src/autoreview";
import {
  cardInPlan,
  cardInReview,
  db,
  dir,
  eng,
  fakeSpawn,
  setStop,
  setup,
  sleep,
  start,
  useAutoReviewHooks,
  withAgentEnv,
} from "./autoreview.helpers";

useAutoReviewHooks();

describe("auto-plan", () => {
  test("planner spawns for a bare card in the plan lane; its own comment disarms it", async () => {
    const { dbFile, writer: w } = setup();
    const card = w.createTask({ title: "fresh idea", lane: "plan" });
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("planner");
    expect(calls[0].job.prompt).toContain(`kanban brief ${card.id}`);
    expect(calls[0].job.prompt).toContain("kanban attach");

    // planner finishes: attaches a plan and comments → disarmed
    w.attach(card.id, "plan", "# v2");
    await w.createComment(card.id, { author: PLANNER_AUTHOR, body: "plan v2 attached" });
    calls[0].finish({ code: 0 });
    await sleep(20);
    w.createTask({ title: "noise" });
    await sleep(150);
    expect(calls.length).toBe(1); // no re-spawn
  });

  test("rejection re-arms the planner; the prompt points at the feedback", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInPlan(w);
    await w.createComment(card.id, { author: PLANNER_AUTHOR, body: "plan v1 attached" });
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    expect(calls.length).toBe(0); // disarmed by the planner's comment

    await w.rejectTask(card.id, "use SSE, not polling");
    await sleep(200);
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("planner");
    expect(calls[0].job.prompt).toContain("rejection");
    expect(db!.resolveTask(card.id).laneId).toBe("plan");
  });

  test("a plan attached outside the loop routes to the plan reviewer, not a re-plan", async () => {
    const { dbFile, writer: w } = setup();
    const card = w.createTask({ title: "planned in chat", lane: "plan" });
    w.attach(card.id, "plan", "# Plan v1\nwritten in a chat session at the human's direction");
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("plan-reviewer");
  });

  test("a fresh external plan after a rejection goes to review, not a re-plan", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInPlan(w);
    await w.createComment(card.id, { author: PLANNER_AUTHOR, body: "plan v1 attached" });
    await w.rejectTask(card.id, "tighten step 2");
    await sleep(5); // keep the v2 attachment strictly newer than the rejection
    await w.attach(card.id, "plan", "# Plan v2\naddresses the rejection");
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("plan-reviewer");
  });

  const PASS = "plan review: pass";
  const BLOCK = "plan review: block";

  /** A card whose planner just handed off — armed for the plan reviewer. */
  function planReady(w: KanbanDb, title = "plan ready") {
    const card = w.createTask({ title, lane: "plan" });
    w.attach(card.id, "plan", "# plan v1\nsteps");
    w.createComment(card.id, { author: PLANNER_AUTHOR, kind: "handoff", body: "plan v1 attached — over to pi-plan-reviewer" });
    return card;
  }

  function planVerdict(w: KanbanDb, card: { id: string }, verdict: "pass" | "block", body: string) {
    return w.createComment(card.id, { author: PLAN_REVIEWER_AUTHOR, kind: "review", body });
  }

  test("planner handoff arms the plan reviewer; its prompt carries the checklist", async () => {
    const { dbFile, writer: w } = setup();
    const card = planReady(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("plan-reviewer");
    expect(calls[0].job.task.id).toBe(card.id);
    expect(calls[0].job.prompt).toContain(`plan-review ${card.id} --pass`);
    expect(calls[0].job.prompt).toContain(`plan-review ${card.id} --block`);
    expect(calls[0].job.prompt).toContain("Review checklist");
    expect(calls[0].job.prompt).toContain("Never move the card");

    await planVerdict(w, card, "pass", `${PASS} — executable`);
    calls[0].finish({ code: 0 });
    await sleep(20);
    w.createTask({ title: "noise" });
    await sleep(150);
    expect(calls.length).toBe(1); // pass leaves the card at the human gate
  });

  test("a passing verdict parks the card in waiting; approve from there arms the plan-build builder", async () => {
    const { dbFile, writer: w } = setup();
    const card = planReady(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await w.planReview(card.id, { verdict: "pass", message: "executable end to end", author: PLAN_REVIEWER_AUTHOR });
    calls[0].finish({ code: 0 });
    await sleep(20);
    const parked = db!.resolveTask(card.id);
    expect(parked.laneId).toBe("waiting");
    expect(parked.previousLane).toBe("plan");
    w.createTask({ title: "noise" });
    await sleep(150);
    expect(calls.length).toBe(1); // a parked card never spawns a role

    await w.approveTask(card.id); // the human gate works on a card parked from plan
    await sleep(200);
    expect(calls.length).toBe(2);
    expect(calls[1].job.role).toBe("builder");
    expect(calls[1].job.mode).toBe("plan");
    expect(db!.resolveTask(card.id).laneId).toBe("implement");
  });

  test("plan-review block re-arms the planner with the findings", async () => {
    const { dbFile, writer: w } = setup();
    const card = planReady(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await planVerdict(w, card, "block", `${BLOCK} — vague tests\n- AC2 has no test`);
    calls[0].finish({ code: 0 });
    await sleep(20);
    expect(calls.length).toBe(2);
    expect(calls[1].job.role).toBe("planner");
    expect(calls[1].job.prompt).toContain("plan-review");
    expect(db!.resolveTask(card.id).laneId).toBe("plan");
  });

  test("two blocks since the last human comment hit the plan-review cap", async () => {
    const { dbFile, writer: w } = setup();
    const card = planReady(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    // block 1 → planner
    await planVerdict(w, card, "block", `${BLOCK} — 1`);
    calls[0].finish({ code: 0 });
    await sleep(20);
    expect(calls[1]!.job.role).toBe("planner");
    await w.createComment(card.id, { author: PLANNER_AUTHOR, kind: "handoff", body: "plan v2 attached — over to pi-plan-reviewer" });
    calls[1].finish({ code: 0 });
    await sleep(20);
    expect(calls[2]!.job.role).toBe("plan-reviewer");
    // block 2 → cap, not a third planner run
    await planVerdict(w, card, "block", `${BLOCK} — 2`);
    calls[2].finish({ code: 0 });
    await sleep(20);
    const last = db!.comments(card.id).at(-1)!;
    expect(last.author).toBe(PLAN_REVIEWER_AUTHOR);
    expect(last.kind).toBe("question");
    expect(last.body).toContain("cap");
    const parked = db!.resolveTask(card.id);
    expect(parked.laneId).toBe("waiting");
    expect(parked.previousLane).toBe("plan");
    w.createTask({ title: "noise" });
    await sleep(150);
    expect(calls.length).toBe(3); // cap comment disarmed the card
  });

  test("a human rejection resets the plan-review block count", async () => {
    const { dbFile, writer: w } = setup();
    const card = planReady(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    for (let round = 1; round <= 2; round++) {
      await planVerdict(w, card, "block", `${BLOCK} — ${round}`);
      calls.at(-1)!.finish({ code: 0 });
      await sleep(20);
      if (round === 1) {
        await w.createComment(card.id, { author: PLANNER_AUTHOR, kind: "handoff", body: "plan v2 — over to pi-plan-reviewer" });
        calls.at(-1)!.finish({ code: 0 });
        await sleep(20);
      }
    }
    expect(db!.comments(card.id).at(-1)!.body).toContain("cap"); // two blocks → capped

    await w.rejectTask(card.id, "shrink the scope"); // human feedback resets the count
    await sleep(200);
    expect(calls.at(-1)!.job.role).toBe("planner");
    await w.createComment(card.id, { author: PLANNER_AUTHOR, kind: "handoff", body: "plan v3 — over to pi-plan-reviewer" });
    calls.at(-1)!.finish({ code: 0 });
    await sleep(20);
    await planVerdict(w, card, "block", `${BLOCK} — after reset`);
    calls.at(-1)!.finish({ code: 0 });
    await sleep(20);
    expect(calls.at(-1)!.job.role).toBe("planner"); // 1 block since the human comment — not capped
    expect(db!.comments(card.id).at(-1)!.body).not.toContain("cap");
  });

  test("plan-reviewer crash posts a failure comment and does not hot-loop", async () => {
    const { dbFile, writer: w } = setup();
    const card = planReady(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    calls[0].finish({ code: 1 });
    await sleep(20);
    const last = db!.comments(card.id).at(-1)!;
    expect(last.author).toBe(PLAN_REVIEWER_AUTHOR);
    expect(last.body).toContain("failed");
    w.createTask({ title: "noise" });
    await sleep(150);
    expect(calls.length).toBe(1);
  });

  test("plan-reviewer failure: a human comment re-runs the reviewer, not the planner", async () => {
    const { dbFile, writer: w } = setup();
    const card = planReady(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    calls[0].finish({ code: 1 });
    await sleep(20);
    const last = db!.comments(card.id).at(-1)!;
    expect(last.author).toBe(PLAN_REVIEWER_AUTHOR);
    expect(last.body).toContain("failed");

    await w.createComment(card.id, { author: "user", body: "re-run the review" });
    await sleep(200);
    expect(calls.length).toBe(2);
    expect(calls[1].job.role).toBe("plan-reviewer");
    expect(calls[1].job.prompt).toContain(`plan-review ${card.id} --pass`);
    expect(calls.map((c) => c.job.role)).not.toContain("planner");
    expect(db!.attachments(card.id, "plan").length).toBe(1);
  });

  test("plan-reviewer cannot-evaluate: a human comment re-runs the reviewer", async () => {
    const { dbFile, writer: w } = setup();
    const card = planReady(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    expect(calls.length).toBe(1);
    const threadBefore = db!.comments(card.id).length;
    await w.createComment(card.id, {
      author: PLAN_REVIEWER_AUTHOR,
      kind: "comment",
      body: "cannot evaluate the plan — repo unreadable",
    });
    calls[0].finish({ code: 0 });
    await sleep(20);
    expect(db!.comments(card.id).length).toBe(threadBefore + 1);

    await w.createComment(card.id, { author: "user", body: "fixed repo, try again" });
    await sleep(200);
    expect(calls.length).toBe(2);
    expect(calls[1].job.role).toBe("plan-reviewer");
  });

  test("plan-review cap: a human comment re-runs the reviewer on the same plan", async () => {
    const { dbFile, writer: w } = setup();
    const card = planReady(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    // block 1 → planner
    await planVerdict(w, card, "block", `${BLOCK} — 1`);
    calls[0].finish({ code: 0 });
    await sleep(20);
    expect(calls[1]!.job.role).toBe("planner");
    await w.attach(card.id, "plan", "# plan v2\nrevised");
    await w.createComment(card.id, { author: PLANNER_AUTHOR, kind: "handoff", body: "plan v2 attached — over to pi-plan-reviewer" });
    calls[1].finish({ code: 0 });
    await sleep(20);
    expect(calls[2]!.job.role).toBe("plan-reviewer");
    // block 2 → cap
    await planVerdict(w, card, "block", `${BLOCK} — 2`);
    calls[2].finish({ code: 0 });
    await sleep(20);
    const last = db!.comments(card.id).at(-1)!;
    expect(last.author).toBe(PLAN_REVIEWER_AUTHOR);
    expect(last.body).toContain("cap");
    expect(db!.attachments(card.id, "plan").length).toBe(2);
    expect(db!.resolveTask(card.id).laneId).toBe("waiting");

    const reply = w.comment(card.id, { author: "user", kind: "comment", body: "give it another look" });
    expect(reply.moved).toBe("returned");
    expect(reply.task.laneId).toBe("plan");
    await sleep(200);
    expect(calls.length).toBe(4);
    expect(calls[3].job.role).toBe("plan-reviewer");
    expect(db!.attachments(card.id, "plan").length).toBe(2);
  });

  test("plan-review cap parks from plan; approve from waiting arms the plan-build builder", async () => {
    const { dbFile, writer: w } = setup();
    const card = planReady(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    // block 1 → planner
    await planVerdict(w, card, "block", `${BLOCK} — 1`);
    calls[0].finish({ code: 0 });
    await sleep(20);
    await w.createComment(card.id, { author: PLANNER_AUTHOR, kind: "handoff", body: "plan v2 attached — over to pi-plan-reviewer" });
    calls[1].finish({ code: 0 });
    await sleep(20);
    // block 2 → cap parks the card at the gate
    await planVerdict(w, card, "block", `${BLOCK} — 2`);
    calls[2].finish({ code: 0 });
    await sleep(20);

    const parked = db!.resolveTask(card.id);
    expect(parked.laneId).toBe("waiting");
    expect(parked.previousLane).toBe("plan");
    expect(calls.length).toBe(3);

    await w.approveTask(card.id); // the human gate works on a card parked by the plan-review cap
    await sleep(200);
    expect(calls.length).toBe(4);
    expect(calls[3].job.role).toBe("builder");
    expect(calls[3].job.mode).toBe("plan");
    expect(db!.resolveTask(card.id).laneId).toBe("implement");
  });

  test("human comment after a pass re-arms the planner (unchanged)", async () => {
    const { dbFile, writer: w } = setup();
    const card = planReady(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("plan-reviewer");

    await planVerdict(w, card, "pass", `${PASS} — executable`);
    calls[0].finish({ code: 0 });
    await sleep(20);
    w.createTask({ title: "noise" });
    await sleep(150);
    expect(calls.length).toBe(1); // pass leaves the card at the human gate

    await w.createComment(card.id, { author: "user", body: "actually revise step 2" });
    await sleep(200);
    expect(calls.length).toBe(2);
    expect(calls[1].job.role).toBe("planner");
  });

  test("rejection after a reviewer failure still re-arms the planner", async () => {
    const { dbFile, writer: w } = setup();
    const card = planReady(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    calls[0].finish({ code: 1 });
    await sleep(20);
    const last = db!.comments(card.id).at(-1)!;
    expect(last.author).toBe(PLAN_REVIEWER_AUTHOR);
    expect(last.body).toContain("failed");

    await w.rejectTask(card.id, "rewrite it");
    await sleep(200);
    expect(calls.length).toBe(2);
    expect(calls[1].job.role).toBe("planner");
  });

  test("plan reviewer defaults to thinking max; prompt forbids the gate", () => {
    const task = { id: "abc12", title: "plan me", laneId: "plan" } as never;
    withAgentEnv({}, () => {
      expect(agentFlags("plan-reviewer", eng({}), null)).toEqual(["--thinking", "max"]);
    });
    expect(planReviewerPrompt(task)).toContain("never run kanban approve/reject");
  });

  test("approval arms the plan-build builder; its handoff re-arms the reviewer", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInPlan(w);
    await w.approveTask(card.id); // approval comment + move to implement
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("builder");
    expect(calls[0].job.mode).toBe("plan");
    expect(calls[0].job.prompt).toContain("had its plan approved");

    // builder builds and hands off to review → reviewer takes over
    await w.handoff(card.id, "review", { author: BUILDER_AUTHOR, message: "built, tests green" });
    calls[0].finish({ code: 0 });
    await sleep(20);
    expect(calls.length).toBe(2);
    expect(calls[1].job.role).toBe("reviewer");
  });

  test("agent-authored approval never arms the builder", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInPlan(w);
    await w.approveTask(card.id, { author: "pi-planner" }); // a rogue agent approving its own plan
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await sleep(150);
    expect(calls.length).toBe(0);
  });

  test("planner question parks the card; the human reply returns it and re-arms the planner", async () => {
    const { dbFile, writer: w } = setup();
    const card = w.createTask({ title: "ambiguous idea", lane: "plan" });
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    expect(calls.length).toBe(1);
    expect(calls[0].job.prompt).toContain("--kind question");

    // planner asks via w.comment → parks in waiting
    w.comment(card.id, { author: PLANNER_AUTHOR, kind: "question", body: "Q1: SSE or polling? default: SSE" });
    expect(db!.resolveTask(card.id).laneId).toBe("waiting");
    calls[0].finish({ code: 0 });
    await sleep(20);
    w.createTask({ title: "noise" });
    await sleep(150);
    expect(calls.length).toBe(1);
    expect(db!.comments(card.id).at(-1)!.kind).toBe("question");

    // the human answers via w.comment → returns to plan, planner runs again
    w.comment(card.id, { author: "user", body: "SSE" });
    expect(db!.resolveTask(card.id).laneId).toBe("plan");
    await sleep(200);
    expect(calls.length).toBe(2);
    expect(calls[1].job.role).toBe("planner");
  });

  test("builder question parks; human reply re-arms the builder in findings mode", async () => {
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
    expect(calls[1].job.role).toBe("builder");
    expect(calls[1].job.mode).toBe("findings");

    // builder asks a question instead of fixing
    w.comment(card.id, { author: BUILDER_AUTHOR, kind: "question", body: "which approach?" });
    expect(db!.resolveTask(card.id).laneId).toBe("waiting");
    calls[1].finish({ code: 0 });
    await sleep(20);

    w.createTask({ title: "noise" });
    await sleep(150);
    expect(calls.length).toBe(2); // no spawns while parked

    // human replies
    w.comment(card.id, { author: "user", body: "use approach A" });
    expect(db!.resolveTask(card.id).laneId).toBe("implement");
    await sleep(200);

    expect(calls.length).toBe(3);
    expect(calls[2].job.role).toBe("builder");
    expect(calls[2].job.mode).toBe("findings");
    expect(calls[2].job.prompt).toContain("was blocked in review");
  });

  test("builder question in the plan flow; reply re-arms the builder in plan mode", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInPlan(w);
    await w.approveTask(card.id);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("builder");
    expect(calls[0].job.mode).toBe("plan");

    // builder asks a question
    w.comment(card.id, { author: BUILDER_AUTHOR, kind: "question", body: "should step 2 use postgres?" });
    expect(db!.resolveTask(card.id).laneId).toBe("waiting");
    calls[0].finish({ code: 0 });
    await sleep(20);

    w.createTask({ title: "noise" });
    await sleep(150);
    expect(calls.length).toBe(1);

    // human replies
    w.comment(card.id, { author: "user", body: "no, sqlite" });
    expect(db!.resolveTask(card.id).laneId).toBe("implement");
    await sleep(200);

    expect(calls.length).toBe(2);
    expect(calls[1].job.role).toBe("builder");
    expect(calls[1].job.mode).toBe("plan");
    expect(calls[1].job.prompt).toContain("had its plan approved");
  });

  test("planner crash posts a failure comment and does not hot-loop", async () => {
    const { dbFile, writer: w } = setup();
    const card = w.createTask({ title: "doomed", lane: "plan" });
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    calls[0].finish({ code: 1 });
    await sleep(20);
    const last = db!.comments(card.id).at(-1)!;
    expect(last.author).toBe(PLANNER_AUTHOR);
    expect(last.body).toContain("auto-plan failed");
    w.createTask({ title: "noise" });
    await sleep(150);
    expect(calls.length).toBe(1);
  });

  test("planner defaults to thinking max; prompt forbids moving the card or touching the gate", () => {
    const task = { id: "abc12", title: "plan me", laneId: "plan" } as never;
    withAgentEnv({}, () => {
      expect(agentFlags("planner", eng({}), null)).toEqual(["--thinking", "max"]);
    });
    expect(plannerPrompt(task)).toContain("Never move the card");
    expect(plannerPrompt(task)).toContain("never run kanban approve/reject");
    expect(builderPlanPrompt(task)).toContain("never run kanban approve/reject");
  });

  test("plan template file carries every required section, in order", () => {
    const templatePart = PLAN_TEMPLATE.split(/^## Review checklist$/m)[0]!;
    const headings = [...templatePart.matchAll(/^### (.+)$/gm)].map((m) => m[1]!.trim());
    expect(headings).toEqual([...PLAN_SECTIONS]);
    expect(PLAN_TEMPLATE).toContain("## Review checklist");
    expect(PLAN_TEMPLATE).toContain("N/A — reason");
    // xjwxd — every test entry lives at a named public seam
    expect(templatePart).toContain(
      "| AC | Type (unit / integration / e2e) | Seam (public interface — why) | File | Test name | Asserts | Command |",
    );
    expect(templatePart).toContain("highest seam that can observe the behavior");
    expect(templatePart).toContain("`N/A — reason` is allowed only when no public seam");
    expect(PLAN_TEMPLATE.split(/^## Review checklist$/m)[1]!).toContain("names no seam");
  });

  test("plannerPrompt embeds the template and makes the planner self-check against the checklist", () => {
    const prompt = plannerPrompt({ id: "abc12", title: "plan me", laneId: "plan" } as never);
    expect(prompt).toContain(PLAN_TEMPLATE.trim());
    for (const section of PLAN_SECTIONS) expect(prompt).toContain(`### ${section}`);
    expect(prompt).toContain("Review checklist");
    expect(prompt).toContain("Seam (public interface — why)");
  });

  test("planner prompt teaches the redundancy check and cites where it looked", () => {
    const task = { id: "abc12", title: "redundant?", laneId: "plan" } as never;
    const prompt = plannerPrompt(task);
    expect(prompt).toContain("redundancy check");
    expect(prompt).toContain("existing implementation");
    expect(prompt).toContain("cite where you looked");
  });

  test("SKILL.md auto-plan section documents failed-review routing", () => {
    const skillPath = join(import.meta.dir, "..", "skills", "pi-kanban", "SKILL.md");
    const skillContent = readFileSync(skillPath, "utf8");
    const [_, planSection] = skillContent.split(/## Auto-plan loop\n/);
    expect(planSection).toBeDefined();
    const [autoPlanText] = planSection.split(/## Auto-review loop\n/);
    expect(autoPlanText).toBeDefined();
    expect(autoPlanText).toContain("any human comment re-runs the");
    expect(autoPlanText).toContain("no re-plan");
    expect(autoPlanText).toContain("re-arms the");
  });

  test("SKILL.md documents backlog readiness and out-of-scope memory", () => {
    const skillPath = join(import.meta.dir, "..", "skills", "pi-kanban", "SKILL.md");
    const skillContent = readFileSync(skillPath, "utf8");
    expect(skillContent).toContain("planner-ready only when its note states");
    expect(skillContent).toContain("user-perspective behavior");
    expect(skillContent).toContain("redundancy check");
    expect(skillContent).toContain("out of scope: <why>");
    expect(skillContent).toContain("Delete (`rm`) only noise");
  });
});

// ---------- cross-process leases ----------

test("two server loops on one db → exactly one planner spawns", async () => {
  const { dbFile, writer } = setup();
  writer.createTask({ title: "race me", lane: "plan" });
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

test("stop kills in-flight children and releases the lease", async () => {
  const { dbFile, writer } = setup();
  const card = writer.createTask({ title: "long runner", lane: "plan" });
  const kills: number[] = [];
  let spawns = 0;
  const spawnFn: SpawnFn = (_job, ctx) => {
    spawns += 1;
    return new Promise<SpawnResult>((resolve) => {
      ctx.track(() => {
        kills.push(1);
        resolve({ code: 143 });
      });
    });
  };
  const dbA = new KanbanDb(dbFile);
  const h = startAutoReview({ db: dbA, cwd: dir, spawnFn, watchIntervalMs: 50, gate: null });
  setStop(() => {
    h.stop();
    try {
      dbA.close();
    } catch {}
  });
  await sleep(300);
  expect(spawns).toBe(1);
  expect(writer.leaseFor(card.id)).not.toBeNull(); // held while the session runs
  h.stop();
  dbA.close();
  await sleep(100);
  expect(kills.length).toBe(1); // child terminated, not orphaned
  expect(writer.leaseFor(card.id)).toBeNull(); // lease released on shutdown
  const stopped = writer.comments(card.id);
  expect(stopped.length).toBe(1); // stop traces the kill on the card (zqued)
  expect(stopped[0]!.body).toContain("session killed by server restart/shutdown");
  expect(stopped[0]!.body).not.toContain("143"); // …but no exit-143 failure comment
});

test("lease released after a session finishes normally", async () => {
  const { dbFile, writer } = setup();
  const card = writer.createTask({ title: "quick one", lane: "plan" });
  const fake = fakeSpawn();
  const dbA = new KanbanDb(dbFile);
  const h = startAutoReview({ db: dbA, cwd: dir, spawnFn: fake.spawnFn, watchIntervalMs: 50, gate: null });
  setStop(() => {
    h.stop();
    dbA.close();
  });
  await sleep(300);
  expect(fake.calls.length).toBe(1);
  fake.calls[0]!.finish({ code: 0 });
  await sleep(200);
  expect(writer.leaseFor(card.id)).toBeNull();
});

test("session finish untracks kill handle so stop() does not invoke it", async () => {
  const { dbFile, writer } = setup();
  writer.createTask({ title: "track cleanup", lane: "plan" });
  let killCalled = false;
  let finishSession!: () => void;
  const spawnFn: SpawnFn = (_job, ctx) => {
    ctx.track(() => {
      killCalled = true;
    });
    return new Promise<SpawnResult>((resolve) => {
      finishSession = () => resolve({ code: 0 });
    });
  };
  const dbA = new KanbanDb(dbFile);
  const h = startAutoReview({ db: dbA, cwd: dir, spawnFn, watchIntervalMs: 50, gate: null });
  setStop(() => {
    h.stop();
    dbA.close();
  });
  await sleep(300);
  expect(finishSession).toBeDefined();
  finishSession();
  await sleep(200);
  h.stop();
  expect(killCalled).toBe(false);
});

test("stale lease is reclaimed on scan and session spawns", async () => {
  const { dbFile, writer } = setup();
  const card = writer.createTask({ title: "crashed owner card", lane: "plan" });
  const raw = new Database(dbFile);
  try {
    raw.query(
      "INSERT INTO agent_leases (task_id, role, owner_pid, boot_id, heartbeat_at) VALUES (?, ?, ?, ?, ?)",
    ).run(card.id, "planner", 99999, 1, Date.now() - 120_000);
  } finally {
    raw.close();
  }

  expect(writer.leaseFor(card.id)).not.toBeNull();
  expect(writer.leaseFor(card.id, 60_000)).toBeNull();

  const fake = fakeSpawn();
  const dbA = new KanbanDb(dbFile);
  const h = startAutoReview({ db: dbA, cwd: dir, spawnFn: fake.spawnFn, watchIntervalMs: 50, gate: null });
  setStop(() => {
    h.stop();
    dbA.close();
  });
  await sleep(300);
  expect(fake.calls.length).toBe(1);
  expect(fake.calls[0]!.job.role).toBe("planner");
  expect(writer.leaseFor(card.id)?.ownerPid).toBe(process.pid);
});

test("plannerPrompt names a per-run plan file so concurrent runs never clobber", () => {
  const task = { id: "k7x9", title: "t", note: "", laneId: "plan", project: "", parentId: null, position: 1, createdAt: 1, updatedAt: 1 };
  expect(plannerPrompt(task as never, 1234)).toContain("/tmp/plan-k7x9-ya.md");
});
