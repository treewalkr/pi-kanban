import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultLaneContext, KanbanDb, type Engine } from "../src/db";
import { CLAUDE_BUILD_TOOLS, CLAUDE_READ_TOOLS, claudeFlags, isClaudeSessionId } from "../src/claude";
import {
  BUILDER_AUTHOR,
  DEFAULT_GATE_TIMEOUT_MS,
  DEFAULT_STALL_MS,
  DEFAULT_TIMEOUT_MS,
  PLANNER_AUTHOR,
  PLAN_REVIEWER_AUTHOR,
  PLAN_SECTIONS,
  PLAN_TEMPLATE,
  REVIEWER_AUTHOR,
  activitySnapshot,
  agentFlags,
  applyProjectOverride,
  builderPlanPrompt,
  builderPrompt,
  deathReason,
  defaultGate,
  defaultSpawn,
  durationFor,
  evaluateLaneContext,
  formatPiEvent,
  killAgentSessions,
  MAX_SKILL_CHARS,
  modelConfigLabel,
  plannerPrompt,
  planReviewerPrompt,
  resolvedModelConfig,
  resumePrompt,
  reviewerPrompt,
  sessionIdFor,
  skillActivationPrompt,
  startAutoReview,
  type AgentJob,
  type AutoReviewOptions,
  type GateFn,
  type SpawnContext,
  type SpawnFn,
  type SpawnResult,
} from "../src/autoreview";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pre-engines pool shape → engines + lineups, for the dispatch tests: each
 * slot below maxWorkers becomes a one-seat engine (disabled with the pool),
 * and every covered role's lineup lists them in slot order.
 */
type ShimSlot = { provider?: string; model?: string; thinking?: "" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" };
function poolShim(db: KanbanDb, id: string, pool: { name?: string; enabled?: boolean; roles: string[]; slots: ShimSlot[]; maxWorkers?: number }): void {
  for (const e of db.engines()) if (e.id.startsWith(`${id}-`)) db.deleteEngine(e.id);
  const ids = pool.slots.slice(0, pool.maxWorkers ?? pool.slots.length).map((slot, i) => {
    const eid = `${id}-${i}`;
    db.setEngine(eid, { name: `${pool.name ?? id} ${i}`, harness: "pi", ...slot, thinking: slot.thinking || undefined, enabled: pool.enabled !== false });
    return eid;
  });
  for (const role of pool.roles) db.setAgentConfig(role, { ...(db.agentConfig(role) ?? {}), runsOn: ids });
}
/** A full Engine from a partial (unit tests of the flag builders). */
function eng(e: Partial<Engine>): Engine {
  return { id: "e", name: "E", harness: "pi", flags: [], seats: 1, enabled: true, updatedAt: 0, ...e };
}
function deletePoolShim(db: KanbanDb, id: string): void {
  for (const e of db.engines()) if (e.id.startsWith(`${id}-`)) db.deleteEngine(e.id);
}


/** Run with the agent env vars cleared, then set from `env`, restoring after. */
const AGENT_ENV_KEYS = ["KANBAN_AUTOREVIEW_MODEL", "KANBAN_AUTOREVIEW_THINKING", "KANBAN_AUTOREVIEW_GATE"];
let savedAgentEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedAgentEnv = Object.fromEntries(AGENT_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of AGENT_ENV_KEYS) delete process.env[k];
});

function withAgentEnv(env: Record<string, string>, run: () => void): void {
  const saved = Object.fromEntries(AGENT_ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of AGENT_ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    run();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** A temp skill dir with a frontmatter'd SKILL.md — cleaned up in afterEach. */
const skillDirs: string[] = [];
function makeSkill(name: string, body: string): string {
  const skillDir = mkdtempSync(join(tmpdir(), "kanban-skill-"));
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: test skill\n---\n\n${body}`);
  skillDirs.push(skillDir);
  return skillDir;
}

afterEach(() => {
  for (const d of skillDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedAgentEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Records every spawn (job + spawn ctx); the test resolves each one when its "agent" is done. */
function fakeSpawn() {
  const calls: Array<{ job: AgentJob; ctx: SpawnContext; finish: (result: SpawnResult) => void }> = [];
  const spawnFn: SpawnFn = (job, ctx) =>
    new Promise<SpawnResult>((resolve) => calls.push({ job, ctx, finish: resolve }));
  return { calls, spawnFn };
}

let dir = "";
let db: KanbanDb | null = null;
let writer: KanbanDb | null = null;
let stop: (() => void) | null = null;

function setup(): { dbFile: string; writer: KanbanDb } {
  dir = mkdtempSync(join(tmpdir(), "kanban-autoreview-"));
  const dbFile = join(dir, "t.db");
  writer = new KanbanDb(dbFile);
  return { dbFile, writer };
}

afterEach(() => {
  stop?.();
  db?.close();
  writer?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  stop = null;
  db = null;
  writer = null;
  dir = "";
});

function withFakePi<T>(scriptBody: string, run: () => Promise<T>): Promise<T> {
  const fakeDir = mkdtempSync(join(tmpdir(), "fake-pi-"));
  const fakePi = join(fakeDir, "pi");
  writeFileSync(fakePi, `#!${process.execPath}\n${scriptBody}\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${fakeDir}:${oldPath}`;
  return Promise.resolve()
    .then(run)
    .finally(() => {
      process.env.PATH = oldPath;
      rmSync(fakeDir, { recursive: true, force: true });
    });
}

function start(spawnFn: SpawnFn, dbFile: string, extra: Partial<AutoReviewOptions> = {}) {
  db = new KanbanDb(dbFile);
  const handle = startAutoReview({ db, cwd: dir, spawnFn, watchIntervalMs: 50, gate: null, ...extra });
  stop = () => handle.stop();
  return handle;
}

/** A card in review with a builder handoff as the last comment — the armed state. */
function cardInReview(w: KanbanDb, title = "ship it") {
  const card = w.createTask({ title, lane: "review" });
  w.createComment(card.id, { author: "pi-builder", kind: "handoff", body: "done, please review" });
  return card;
}

/** A card in the plan lane with a plan attached — one human action from the gate. */
function cardInPlan(w: KanbanDb, title = "plan me") {
  const card = w.createTask({ title, lane: "plan" });
  w.attach(card.id, "plan", "# plan v1\nstep one");
  return card;
}

/** A project-tagged card in review with a builder handoff — the armed state. */
function cardOnProject(w: KanbanDb, project: string, title = "ship it") {
  const card = w.createTask({ title, lane: "review", project });
  w.createComment(card.id, { author: BUILDER_AUTHOR, kind: "handoff", body: "done, please review" });
  return card;
}

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
    expect(args).not.toContain("--no-mcp"); // a pi flag never reaches claude
    expect(args).not.toContain("-edit");
    expect(args.slice(-2)).toEqual(["--max-turns", "40"]);
    expect(claudeFlags("builder", eng({ harness: "claude" }), null)[4]).toBe("sonnet");
    expect(claudeFlags("builder", eng({ harness: "claude" }), null)).toContain(CLAUDE_BUILD_TOOLS.join(","));
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
  });

  test("modelConfigLabel: provider · model · thinking, default-model fallback, claude labelled by harness", () => {
    expect(modelConfigLabel({ provider: "anthropic", model: "claude-x", thinking: "high" })).toBe("anthropic · claude-x · high");
    expect(modelConfigLabel({ model: "gemini-4-argon", thinking: "high" })).toBe("gemini-4-argon · high");
    expect(modelConfigLabel({})).toBe("default model");
    expect(modelConfigLabel({ harness: "claude", model: "opus" })).toBe("claude · opus");
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
    db = new KanbanDb(dbFile);
    const handle = startAutoReview({ db, cwd: dir, spawnFn, stallMs: 123_456, watchIntervalMs: 50, gate: null });
    stop = () => handle.stop();
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
    expect(lines[1]).toBe("model: anthropic · claude-x · high");
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
    expect(lines[1]).toBe("model: default model");
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
    ctx.emit("session started");
    ctx.emit("→ bash: bun test");
    const snap = activitySnapshot().sessions[0]!;
    expect(snap.role).toBe("reviewer");
    expect(snap.modelLabel).toBe("default model · max");
    expect(snap.log).toEqual(["model: default model · max", "session started", "→ bash: bun test"]);
    finish({ code: 0 });
    await sleep(20);
    expect(activitySnapshot().sessions.some((s) => s.taskId === card.id)).toBe(false);
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
      db = new KanbanDb(dbFile);
      const handle = startAutoReview({
        db,
        cwd: dir,
        spawnFn,
        watchIntervalMs: 50,
        gate: null,
        log: (msg) => logs.push(msg),
      });
      stop = () => handle.stop();
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
    stop = () => {
      hA.stop();
      hB.stop();
      dbA.close();
      dbB.close();
    };
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
  stop = () => {
    hA.stop();
    hB.stop();
    dbA.close();
    dbB.close();
  };
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
  stop = () => {
    h.stop();
    try {
      dbA.close();
    } catch {}
  };
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
  stop = () => {
    h.stop();
    dbA.close();
  };
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
  stop = () => {
    h.stop();
    dbA.close();
  };
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
  stop = () => {
    h.stop();
    dbA.close();
  };
  await sleep(300);
  expect(fake.calls.length).toBe(1);
  expect(fake.calls[0]!.job.role).toBe("planner");
  expect(writer.leaseFor(card.id)?.ownerPid).toBe(process.pid);
});

test("plannerPrompt names a per-run plan file so concurrent runs never clobber", () => {
  const task = { id: "k7x9", title: "t", note: "", laneId: "plan", project: "", parentId: null, position: 1, createdAt: 1, updatedAt: 1 };
  expect(plannerPrompt(task as never, 1234)).toContain("/tmp/plan-k7x9-ya.md");
});

describe("applyProjectOverride", () => {
  test("a present lineup replaces whole; present scalars replace (trimmed); absent keys inherit", () => {
    expect(
      applyProjectOverride(
        { runsOn: ["a", "b"], context: "ctx", tools: "bash", skills: ["s1"], extraArgs: ["--x"], timeoutMs: 120_000 },
        { runsOn: ["c"], tools: "   ", context: " c2 " },
      ),
    ).toEqual({ runsOn: ["c"], context: "c2", tools: "bash", skills: ["s1"], extraArgs: ["--x"], timeoutMs: 120_000 });
    // an empty override lineup inherits the actor's — lineups never merge
    expect(applyProjectOverride({ runsOn: ["a"] }, { runsOn: [] })).toEqual({ runsOn: ["a"] });
  });

  test("a present [] replaces skills and extraArgs wholesale", () => {
    expect(applyProjectOverride({ context: "a", skills: ["s1"], extraArgs: ["--x"] }, { skills: [] })).toEqual({
      context: "a",
      skills: [],
      extraArgs: ["--x"],
    });
    expect(applyProjectOverride({ skills: ["s1"], extraArgs: ["--x"] }, { extraArgs: [] })).toEqual({
      skills: ["s1"],
      extraArgs: [],
    });
  });

  test("null/empty inputs collapse to null; a lone override builds the config", () => {
    expect(applyProjectOverride(null, null)).toBeNull();
    expect(applyProjectOverride(null, {})).toBeNull();
    expect(applyProjectOverride({}, {})).toBeNull();
    expect(applyProjectOverride(null, { context: "m" })).toEqual({ context: "m" });
    expect(applyProjectOverride({ skills: [] }, {})).toEqual({ skills: [] });
    expect(applyProjectOverride({ context: "a" }, null)).toEqual({ context: "a" });
    expect(applyProjectOverride({ timeoutMs: 60_000 }, { timeoutMs: 90_000 })).toEqual({ timeoutMs: 90_000 });
  });
});

describe("project overrides", () => {
  test("an override lineup beats the actor lineup for that project only", async () => {
    const { dbFile, writer: w } = setup();
    w.setEngine("b", { name: "B", harness: "pi", model: "b" });
    w.setEngine("c", { name: "C", harness: "pi", model: "c", thinking: "low" });
    w.setAgentConfig("reviewer", { runsOn: ["b"] });
    w.setProjectAgentConfig("demo", "reviewer", { runsOn: ["c"] });
    cardOnProject(w, "demo");
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await sleep(150);

    expect(calls.length).toBe(1);
    expect(calls[0].ctx.engine).toMatchObject({ id: "c", model: "c", thinking: "low" });
    calls[0].finish({ code: 0 });
    await sleep(150);

    // deleting the override row restores the actor lineup
    w.setProjectAgentConfig("demo", "reviewer", null);
    cardOnProject(w, "demo", "second");
    await sleep(150);
    expect(calls.length).toBe(2);
    expect(calls[1].ctx.engine.id).toBe("b");
    calls[1].finish({ code: 0 });
  });

  test("the env pin still beats a project override", async () => {
    const { dbFile, writer: w } = setup();
    w.setEngine("c", { name: "C", harness: "pi", model: "c" });
    w.setEngine("env", { name: "Env", harness: "pi", model: "m-env" });
    w.setProjectAgentConfig("demo", "reviewer", { runsOn: ["c"] });
    cardOnProject(w, "demo");
    process.env.KANBAN_ENGINE = "env";
    const seen: string[] = [];
    const spawnFn: SpawnFn = (job, ctx) => {
      const flags = agentFlags(job.role, ctx.engine, ctx.config);
      seen.push(flags[flags.indexOf("--model") + 1]!);
      return Promise.resolve({ code: 1 });
    };
    try {
      start(spawnFn, dbFile);
      await sleep(150);
    } finally {
      delete process.env.KANBAN_ENGINE;
    }
    expect(seen[0]).toBe("m-env");
  });

  test("override timeoutMs and skills reach the spawn seam", async () => {
    const { dbFile, writer: w } = setup();
    const skillDir = makeSkill("lens", "review with perf in mind");
    w.setProjectAgentConfig("demo", "reviewer", { timeoutMs: 21 * 60_000, skills: [skillDir] });
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    cardOnProject(w, "demo");
    await sleep(150);

    expect(calls.length).toBe(1);
    expect(calls[0].ctx.timeoutMs).toBe(21 * 60_000);
    expect(calls[0].ctx.config?.skills).toEqual([skillDir]);
    calls[0].finish({ code: 0 });
    await sleep(150);

    // a card on an un-overridden tag keeps the loop default timeout
    cardOnProject(w, "other", "un-overridden tag");
    await sleep(150);
    expect(calls.length).toBe(2);
    expect(calls[1].ctx.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    calls[1].finish({ code: 0 });
    await sleep(150);

    // a present [] means none
    w.setProjectAgentConfig("demo", "reviewer", { skills: [] });
    cardOnProject(w, "demo", "no skills");
    await sleep(150);
    expect(calls.length).toBe(3);
    expect(calls[2].ctx.config?.skills).toEqual([]);
    calls[2].finish({ code: 0 });
  });

  test("custom lane actor spawn applies the project override", async () => {
    const { dbFile, writer: w } = setup();
    w.createLane({ name: "Design" });
    w.setLaneContext("design", {
      actors: [{ id: "designer", author: "pi-designer", instructions: "Design {id}." }],
      triggers: [{ kind: "on-enter" }],
    });
    w.setEngine("board", { name: "Board", harness: "pi", model: "board" });
    w.setEngine("d", { name: "D", harness: "pi", model: "d" });
    w.setAgentConfig("designer", { runsOn: ["board"] });
    w.setProjectAgentConfig("demo", "designer", { runsOn: ["d"] });
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    const designCard = w.createTask({ title: "design me", lane: "design", project: "demo" });
    await sleep(150);

    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("designer");
    expect(calls[0].job.task.id).toBe(designCard.id);
    expect(calls[0].ctx.engine.model).toBe("d");
    calls[0].finish({ code: 0 });
    await sleep(150);

    // a design card on a tag without an override keeps the board actor config
    const otherCard = w.createTask({ title: "design me too", lane: "design", project: "other" });
    await sleep(150);
    const otherSpawn = calls.find((c) => c.job.task.id === otherCard.id);
    expect(otherSpawn).toBeDefined();
    expect(otherSpawn!.ctx.engine.model).toBe("board");
    otherSpawn!.finish({ code: 0 });
  });

  test("override marker appears on the spawn start log", async () => {
    const { dbFile, writer: w } = setup();
    w.setEngine("c", { name: "C", harness: "pi", model: "c" });
    w.setProjectAgentConfig("demo", "reviewer", { runsOn: ["c"] });
    const logs: string[] = [];
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile, { log: (msg) => logs.push(msg) });
    cardOnProject(w, "demo");
    await sleep(150);

    expect(calls.length).toBe(1);
    const markedLine = logs.find((l) => l.includes(`start ${calls[0]!.job.task.id}`));
    expect(markedLine).toBeDefined();
    expect(markedLine!.endsWith("on engine C — project 'demo' override")).toBe(true);
    calls[0]!.finish({ code: 0 });
    await sleep(150);

    // without an override the line is byte-identical to today's
    w.setProjectAgentConfig("demo", "reviewer", null);
    cardOnProject(w, "demo", "un-overridden");
    await sleep(150);
    expect(calls.length).toBe(2);
    const plainLine = logs.find((l) => l.includes(`start ${calls[1]!.job.task.id}`));
    expect(plainLine).toBeDefined();
    expect(plainLine!.endsWith("on engine pi default")).toBe(true);
    expect(plainLine!.includes("override")).toBe(false);
    calls[1]!.finish({ code: 0 });
  });
});

describe("pre-spawn gate", () => {
  test("red gate: no reviewer session, one gate comment, card disarms", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const logs: string[] = [];
    const { calls, spawnFn } = fakeSpawn();
    const redGate: GateFn = async () => ({ ok: false, output: "1 fail\nexpected 1, got 2" });
    start(spawnFn, dbFile, { gate: redGate, log: (msg) => logs.push(msg) });
    await sleep(100);

    expect(calls.length).toBe(0);
    const comments = w.comments(card.id);
    expect(comments.length).toBe(2);
    const last = comments[comments.length - 1]!;
    expect(last.author).toBe(REVIEWER_AUTHOR);
    expect(last.kind).toBe("question");
    expect(last.body).toContain("pre-review gate");
    expect(last.body).toContain("expected 1, got 2");
    expect(logs.some((l) => l.includes("gate red — no session spawned"))).toBe(true);
    const parked = w.tasks().find((t) => t.id === card.id)!;
    expect(parked.laneId).toBe("waiting");
    expect(parked.previousLane).toBe("review");
    expect(w.waiting(card.id)).toBe("question");

    w.createTask({ title: "noise" });
    await sleep(150);
    expect(calls.length).toBe(0);
    expect(w.comments(card.id).length).toBe(2);
  });

  test("human comment re-arms a red-gated card: exactly one more gate comment", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const { calls, spawnFn } = fakeSpawn();
    const redGate: GateFn = async () => ({ ok: false, output: "1 fail\nexpected 1, got 2" });
    start(spawnFn, dbFile, { gate: redGate });
    await sleep(100);

    expect(calls.length).toBe(0);
    expect(w.comments(card.id).filter((c) => c.body.startsWith("pre-review gate:")).length).toBe(1);
    expect(w.tasks().find((t) => t.id === card.id)!.laneId).toBe("waiting");

    const reply = w.comment(card.id, { author: "user", kind: "comment", body: "re-arm" });
    expect(reply.moved).toBe("returned");
    expect(reply.task.laneId).toBe("review");
    await sleep(100);

    const gateComments = w.comments(card.id).filter((c) => c.body.startsWith("pre-review gate:"));
    expect(gateComments.length).toBe(2);
    for (const c of gateComments) {
      expect(c.author).toBe(REVIEWER_AUTHOR);
    }
    expect(calls.length).toBe(0);
    expect(w.tasks().find((t) => t.id === card.id)!.laneId).toBe("waiting");

    w.createTask({ title: "noise" });
    await sleep(150);
    expect(w.comments(card.id).filter((c) => c.body.startsWith("pre-review gate:")).length).toBe(2);
  });

  test("gate-red parks the card; a human reply with a green gate spawns the reviewer", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const { calls, spawnFn } = fakeSpawn();
    let gateRed = true;
    const flipGate: GateFn = async () => (gateRed ? { ok: false, output: "1 fail" } : { ok: true, output: "" });
    start(spawnFn, dbFile, { gate: flipGate });
    await sleep(100);

    expect(calls.length).toBe(0);
    expect(w.tasks().find((t) => t.id === card.id)!.laneId).toBe("waiting");
    expect(w.tasks().find((t) => t.id === card.id)!.previousLane).toBe("review");

    gateRed = false;
    const reply = w.comment(card.id, { author: "user", kind: "comment", body: "tests fixed" });
    expect(reply.moved).toBe("returned");
    expect(reply.task.laneId).toBe("review");
    await sleep(100);

    expect(calls.length).toBe(1);
    expect(calls[0]!.job.role).toBe("reviewer");
    calls[0]!.finish({ code: 0 });
  });

  test("green gate: the reviewer session spawns exactly as before", async () => {
    const { dbFile, writer: w } = setup();
    cardInReview(w);
    const { calls, spawnFn } = fakeSpawn();
    const greenGate: GateFn = async () => ({ ok: true, output: "" });
    start(spawnFn, dbFile, { gate: greenGate });
    await sleep(100);

    expect(calls.length).toBe(1);
    expect(calls[0]!.job.role).toBe("reviewer");
    calls[0]!.finish({ code: 0 });
  });

  test("gate: null skips the gate (start helper default)", async () => {
    const { dbFile, writer: w } = setup();
    cardInReview(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await sleep(100);

    expect(calls.length).toBe(1);
    expect(calls[0]!.job.role).toBe("reviewer");
    calls[0]!.finish({ code: 0 });
  });

  test("gate error fails open: session spawns, no gate comment", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const logs: string[] = [];
    const { calls, spawnFn } = fakeSpawn();
    const throwingGate: GateFn = async () => {
      throw new Error("gate exploded");
    };
    start(spawnFn, dbFile, { gate: throwingGate, log: (msg) => logs.push(msg) });
    await sleep(100);

    expect(calls.length).toBe(1);
    expect(calls[0]!.job.role).toBe("reviewer");
    expect(w.comments(card.id).length).toBe(1);
    expect(logs.some((l) => l.includes("gate could not run"))).toBe(true);
    calls[0]!.finish({ code: 0 });
  });

  test("KANBAN_AUTOREVIEW_GATE=0 disables the gate when no gate option is passed", async () => {
    const { dbFile, writer: w } = setup();
    cardInReview(w);
    const { calls, spawnFn } = fakeSpawn();
    withAgentEnv({ KANBAN_AUTOREVIEW_GATE: "0" }, () => {
      start(spawnFn, dbFile, { gate: undefined });
    });
    await sleep(100);

    expect(calls.length).toBe(1);
    expect(calls[0]!.job.role).toBe("reviewer");
    calls[0]!.finish({ code: 0 });
  });

  test("no gate option and no env: defaultGate gates reviewer jobs", async () => {
    const { dbFile, writer: w } = setup();
    const card = cardInReview(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile, { gate: undefined });
    await sleep(100);

    expect(calls.length).toBe(0);
    const comments = w.comments(card.id);
    expect(comments.some((c) => c.body.startsWith("pre-review gate:"))).toBe(true);
  });

  test("gate receives the project's test command; unset passes undefined", async () => {
    const { dbFile, writer: w } = setup();
    const alphaDir = join(dir, "alpha-repo");
    mkdirSync(alphaDir);
    w.setProjectRepo("alpha", alphaDir);
    w.setProjectTestCmd("alpha", "cargo test");
    cardOnProject(w, "alpha", "routed");
    const gateCalls: Array<{ cwd: string; timeoutMs: number; command: string | undefined }> = [];
    const gateFn: GateFn = async (cwd, timeoutMs, command) => {
      gateCalls.push({ cwd, timeoutMs, command });
      return { ok: true, output: "" };
    };
    const logs: string[] = [];
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile, { gate: gateFn, log: (m) => logs.push(m) });
    await sleep(150);

    expect(calls.length).toBe(1);
    expect(gateCalls[0]).toEqual({ cwd: alphaDir, timeoutMs: DEFAULT_GATE_TIMEOUT_MS, command: "cargo test" });
    expect(logs.some((l) => l.includes("running pre-spawn test gate (cargo test)"))).toBe(true);
    calls[0].finish({ code: 0 });
    await sleep(150);

    // a tag without a command keeps today's unparenthesised log and an undefined command
    const betaCard = cardOnProject(w, "beta", "no command");
    await sleep(150);
    expect(calls.length).toBe(2);
    expect(gateCalls[1]!.command).toBeUndefined();
    const gateLine = logs.find((l) => l.includes(`${betaCard.id}: running pre-spawn test gate`));
    expect(gateLine).toBeDefined();
    expect(gateLine!.endsWith("running pre-spawn test gate")).toBe(true);
    calls[1].finish({ code: 0 });
  });

  test("gate-red fail comment names the project's command", async () => {
    const { dbFile, writer: w } = setup();
    w.setProjectTestCmd("alpha", "cargo test");
    const alphaCard = cardOnProject(w, "alpha", "routed red");
    const redGate: GateFn = async () => ({ ok: false, output: "1 fail\nexpected 1, got 2" });
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile, { gate: redGate });
    await sleep(150);

    expect(calls.length).toBe(0);
    const lastAlpha = w.comments(alphaCard.id).at(-1)!;
    expect(lastAlpha.kind).toBe("question");
    expect(lastAlpha.body.startsWith("pre-review gate: `cargo test` failed — no reviewer session spawned.")).toBe(true);
    expect(lastAlpha.body).toContain("expected 1, got 2");
    const parked = w.tasks().find((t) => t.id === alphaCard.id)!;
    expect(parked.laneId).toBe("waiting");

    // a tag without a command keeps today's `bun test` text
    const betaCard = cardOnProject(w, "beta", "no command red");
    await sleep(150);
    expect(calls.length).toBe(0);
    const lastBeta = w.comments(betaCard.id).at(-1)!;
    expect(lastBeta.kind).toBe("question");
    expect(lastBeta.body.startsWith("pre-review gate: `bun test` failed — no reviewer session spawned.")).toBe(true);
  });

  test("no v4 settings: gate call, messages, and spawn config are today's", async () => {
    const { dbFile, writer: w } = setup();
    w.setAgentConfig("reviewer", { context: "a" });
    const card = cardInReview(w);
    let gateRed = true;
    const gateCalls: Array<{ cwd: string; timeoutMs: number; command: string | undefined }> = [];
    const gateFn: GateFn = async (cwd, timeoutMs, command) => {
      gateCalls.push({ cwd, timeoutMs, command });
      return gateRed ? { ok: false, output: "1 fail" } : { ok: true, output: "" };
    };
    const logs: string[] = [];
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile, { gate: gateFn, log: (m) => logs.push(m) });
    await sleep(150);

    expect(calls.length).toBe(0);
    expect(gateCalls[0]).toEqual({ cwd: dir, timeoutMs: DEFAULT_GATE_TIMEOUT_MS, command: undefined });
    const last = w.comments(card.id).at(-1)!;
    expect(last.kind).toBe("question");
    expect(last.body.startsWith("pre-review gate: `bun test` failed — no reviewer session spawned.")).toBe(true);

    gateRed = false;
    const card2 = cardInReview(w, "second");
    await sleep(150);
    expect(calls.length).toBe(1);
    expect(calls[0].job.task.id).toBe(card2.id);
    expect(calls[0].ctx.config).toEqual({ context: "a" });
    expect(calls[0].ctx.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    const startLine = logs.find((l) => l.includes(`start ${card2.id}`));
    expect(startLine).toBeDefined();
    expect(startLine!.includes("override")).toBe(false);
    calls[0].finish({ code: 0 });
  });
});

describe("defaultGate", () => {
  test("green suite: ok, output kept", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "kanban-gate-pass-"));
    try {
      writeFileSync(
        join(tmpDir, "sample.test.ts"),
        `import { test, expect } from "bun:test";\ntest("pass", () => expect(1).toBe(1));\n`,
      );
      const res = await defaultGate(tmpDir, 10_000);
      rmSync(tmpDir, { recursive: true, force: true });
      expect(res.ok).toBe(true);
      expect(res.output).toContain("1 pass");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("red suite: not ok, failure text kept", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "kanban-gate-fail-"));
    try {
      writeFileSync(
        join(tmpDir, "sample.test.ts"),
        `import { test, expect } from "bun:test";\ntest("fail", () => expect(1).toBe(2));\n`,
      );
      const res = await defaultGate(tmpDir, 10_000);
      rmSync(tmpDir, { recursive: true, force: true });
      expect(res.ok).toBe(false);
      expect(res.output).toContain("1 fail");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("timeout kills the run and reports it", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "kanban-gate-timeout-"));
    try {
      writeFileSync(
        join(tmpDir, "sample.test.ts"),
        `import { test } from "bun:test";\ntest("slow", async () => await new Promise((r) => setTimeout(r, 30_000)));\n`,
      );
      const res = await defaultGate(tmpDir, 1_000);
      rmSync(tmpDir, { recursive: true, force: true });
      expect(res.ok).toBe(false);
      expect(res.output).toContain("bun test timed out after 1s");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("custom command runs via sh -c and names itself in the timeout text", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "kanban-gate-cmd-"));
    try {
      const green = await defaultGate(tmpDir, 10_000, "echo gate-ok");
      expect(green.ok).toBe(true);
      expect(green.output).toContain("gate-ok");

      const red = await defaultGate(tmpDir, 10_000, "exit 7");
      expect(red.ok).toBe(false);

      const slow = await defaultGate(tmpDir, 1_000, "sleep 30");
      expect(slow.ok).toBe(false);
      expect(slow.output).toContain("sleep 30 timed out after 1s");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("project routing", () => {
  function recordingSpawn() {
    const calls: Array<{ job: AgentJob; ctx: SpawnContext; finish: (result: SpawnResult) => void }> = [];
    const spawnFn: SpawnFn = (job, ctx) =>
      new Promise<SpawnResult>((resolve) => calls.push({ job, ctx, finish: resolve }));
    return { calls, spawnFn };
  }

  test("per-card spawn cwd: routed project spawns in its repo; un-routed falls back to serve cwd", async () => {
    const { dbFile, writer: w } = setup();
    const alphaDir = join(dir, "alpha-repo");
    mkdirSync(alphaDir);
    w.setProjectRepo("alpha", alphaDir);
    const routed = w.createTask({ title: "routed", lane: "review", project: "alpha" });
    w.createComment(routed.id, { author: BUILDER_AUTHOR, kind: "handoff", body: "done, please review" });

    const { calls, spawnFn } = recordingSpawn();
    withAgentEnv({}, () => start(spawnFn, dbFile));
    await sleep(150);
    expect(calls.map((c) => [c.job.task.id, c.ctx.cwd])).toEqual([[routed.id, alphaDir]]);

    // an un-routed tag keeps the serve launch dir
    const fallback = w.createTask({ title: "fallback", lane: "review", project: "beta" });
    w.createComment(fallback.id, { author: BUILDER_AUTHOR, kind: "handoff", body: "done, please review" });
    await sleep(150);
    expect(calls).toHaveLength(1); // serial default slot — the routed spawn is still in flight
    calls[0].finish({ code: 0 });
    await sleep(200);
    expect(calls).toHaveLength(2);
    expect(calls[1].job.task.id).toBe(fallback.id);
    expect(calls[1].ctx.cwd).toBe(dir);

    // resume mode routes through the same per-card cwd
    const dead = w.createTask({ title: "dead builder", lane: "implement", project: "alpha" });
    w.createComment(dead.id, { author: BUILDER_AUTHOR, kind: "comment", body: "session died: crash" });
    w.setCardSession(dead.id, "builder", "kanban-x-builder-1");
    w.queueResume(dead.id);
    calls[1].finish({ code: 0 });
    await sleep(200);
    const resume = calls.find((c) => c.job.task.id === dead.id && c.job.mode === "resume");
    expect(resume).toBeDefined();
    expect(resume!.ctx.cwd).toBe(alphaDir);
  });

  test("startup banner reports fallback cwd and routed project count", () => {
    const { dbFile, writer: w } = setup();
    const { spawnFn } = fakeSpawn();
    const boot = (): string[] => {
      const lines: string[] = [];
      const loopDb = new KanbanDb(dbFile);
      const handle = startAutoReview({ db: loopDb, cwd: dir, spawnFn, watchIntervalMs: 50, gate: null, log: (m) => lines.push(m) });
      handle.stop();
      loopDb.close();
      return lines;
    };

    expect(boot()[0]).toBe(
      `enabled — agents run in ${dir}, stall 10 min / cap 120 min, block cap 3, test gate off`,
    );

    const repo1 = join(dir, "repo-1");
    const repo2 = join(dir, "repo-2");
    mkdirSync(repo1);
    mkdirSync(repo2);
    w.setProjectRepo("alpha", repo1);
    w.setProjectRepo("beta", repo2);
    w.setProjectGate("gamma", true); // registered but un-routed — not counted

    expect(boot()[0]).toBe(
      `enabled — agents run in ${dir} +2 routed projects, stall 10 min / cap 120 min, block cap 3, test gate off`,
    );
  });

  test("pre-review gate runs in the card's repo and skips on test_gate=0", async () => {
    const { dbFile, writer: w } = setup();
    const alphaDir = join(dir, "alpha-repo");
    mkdirSync(alphaDir);
    w.setProjectRepo("alpha", alphaDir);
    const routed = w.createTask({ title: "gated routed", lane: "review", project: "alpha" });
    w.createComment(routed.id, { author: BUILDER_AUTHOR, kind: "handoff", body: "done, please review" });

    const gateCalls: string[] = [];
    const gateFn: GateFn = async (cwd) => {
      gateCalls.push(cwd);
      return { ok: true, output: "" };
    };
    const logs: string[] = [];
    const { calls, spawnFn } = recordingSpawn();
    withAgentEnv({}, () => start(spawnFn, dbFile, { gate: gateFn, log: (m) => logs.push(m) }));
    await sleep(150);
    expect(gateCalls).toEqual([alphaDir]);
    expect(calls).toHaveLength(1);
    calls[0].finish({ code: 0 });
    await sleep(150);

    // an un-routed tag gates on the serve cwd
    const fallback = w.createTask({ title: "gated fallback", lane: "review", project: "beta" });
    w.createComment(fallback.id, { author: BUILDER_AUTHOR, kind: "handoff", body: "done, please review" });
    await sleep(200);
    expect(gateCalls).toEqual([alphaDir, dir]);
    calls[1].finish({ code: 0 });
    await sleep(150);

    // test_gate=0 skips the gate; the reviewer still spawns
    w.setProjectGate("beta", false);
    const skipped = w.createTask({ title: "gate skipped", lane: "review", project: "beta" });
    w.createComment(skipped.id, { author: BUILDER_AUTHOR, kind: "handoff", body: "done, please review" });
    await sleep(200);
    expect(gateCalls).toHaveLength(2);
    const skipSpawn = calls.find((c) => c.job.task.id === skipped.id);
    expect(skipSpawn).toBeDefined();
    expect(logs).toContain(`reviewer ${skipped.id}: test gate off for project 'beta' — skipping`);
  });
});

// ---------- lane contexts: the generic interpreter (card 3n96c) ----------

describe("lane contexts", () => {
  test("roleFor has no hardcoded lane-id branches; contexts drive cleared, renamed, and custom lanes", async () => {
    // source-level: the loop's roleFor body carries no lane-id literals
    const src = readFileSync(new URL("../src/autoreview.ts", import.meta.url), "utf-8");
    const body = src.slice(src.indexOf("const roleFor"), src.indexOf("const enqueue"));
    expect(body).not.toContain('task.laneId === "plan"');
    expect(body).not.toContain('task.laneId === "implement"');
    expect(body).not.toContain('task.laneId === "review"');

    const { dbFile, writer: w } = setup();
    // clearing a lane's context disarms the loop on that lane
    w.setLaneContext("review", null);
    const card = cardInReview(w);
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await sleep(150);
    expect(calls.length).toBe(0);

    // attaching a context to the same lane arms its actors again
    w.setLaneContext("review", {
      actors: [{ id: "reviewer", author: REVIEWER_AUTHOR, instructions: `Review card {id} "{title}" hard.` }],
      triggers: [{ kind: "on-enter" }],
    });
    await sleep(150);
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("reviewer");
    expect(calls[0].job.prompt).toContain(`Review card ${card.id} "ship it" hard.`);
    calls[0].finish({ code: 0 });
    await sleep(20);

    // renaming a lane keeps its workflow: contexts key on lane id, not name
    w.updateLane("plan", { name: "Product Design" });
    const card2 = w.createTask({ title: "plan me", lane: "plan" });
    w.attach(card2.id, "plan", "# plan v1");
    await sleep(150);
    const pr = calls.find((c) => c.job.role === "plan-reviewer");
    expect(pr).toBeDefined();
    expect(pr!.job.task.id).toBe(card2.id);
    pr!.finish({ code: 0 });
  });

  test("custom Design lane with own template, actor, exit rule, and gate runs end-to-end with zero code changes", async () => {
    const { dbFile, writer: w } = setup();
    w.createLane({ name: "Design" });
    w.setLaneContext("design", {
      artifact: "design",
      template: "# Design Spec\n## Layout",
      actors: [{ id: "designer", author: "pi-designer", instructions: `Design card {id} "{title}" against the template.` }],
      triggers: [{ kind: "on-enter" }],
      exits: [{ on: { author: "pi-designer", kind: "comment", prefix: "design: pass" }, action: "park" }],
      gate: { approveTarget: "plan", requireArtifact: "design", rejectPrefix: "design rejected" },
    });
    const card = w.createTask({ title: "redesign header", lane: "design" });
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("designer");
    expect(calls[0].job.prompt).toContain(`Design card ${card.id} "redesign header" against the template.`);
    expect(calls[0].job.prompt).toContain("--- design template and review checklist ---");
    expect(calls[0].job.prompt).toContain("## Layout");
    calls[0].finish({ code: 0 });
    await sleep(20);

    // the designer's pass verdict parks the card at the human gate (exit rule)
    w.comment(card.id, { author: "pi-designer", kind: "comment", body: "design: pass — see the spec" });
    await sleep(150);
    expect(w.resolveTask(card.id).laneId).toBe("waiting");
    expect(w.resolveTask(card.id).previousLane).toBe("design");
    expect(db!.waiting(card.id)).toBe("gate");

    // the human gate approves into the plan lane, arming the planner
    w.attach(card.id, "design", "# spec");
    w.approveTask(card.id);
    await sleep(200);
    const planner = calls.find((c) => c.job.role === "planner");
    expect(planner).toBeDefined();
    expect(planner!.job.task.id).toBe(card.id);
    expect(w.resolveTask(card.id).laneId).toBe("plan");
    planner!.finish({ code: 0 });
  });

  test("custom lane caps park for a human after max agent cycles", async () => {
    const { dbFile, writer: w } = setup();
    w.createLane({ name: "Design" });
    w.setLaneContext("design", {
      actors: [{ id: "designer", author: "pi-designer", instructions: "Design {id}." }],
      triggers: [{ kind: "comment", commentKind: "review", author: "pi-design-reviewer", targetActor: "designer" }, { kind: "human-comment" }],
      cap: { max: 2, scope: "thread", match: { author: "pi-design-reviewer", kind: "review" }, author: "pi-design-reviewer", message: "design cap: {max} cycles on {id}" },
    });
    const card = w.createTask({ title: "gfx", lane: "design" });
    w.createComment(card.id, { author: "pi-design-reviewer", kind: "review", body: "review: block — first" });
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await sleep(150);
    // cycle 1: one block since the thread started, under the cap of 2
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("designer");
    // the fake designer leaves its own comment, then finishes — no death trace
    w.createComment(card.id, { author: "pi-designer", kind: "handoff", body: "design v1 done" });
    calls[0].finish({ code: 0 });
    await sleep(20);

    // the second reviewer block is cycle 2 of 2 — the cap parks the card instead of re-arming
    w.createComment(card.id, { author: "pi-design-reviewer", kind: "review", body: "review: block — second" });
    await sleep(150);
    expect(calls.length).toBe(1); // capped
    const last = w.comments(card.id).at(-1)!;
    expect(last.author).toBe("pi-design-reviewer");
    expect(last.kind).toBe("question");
    expect(last.body).toBe(`design cap: 2 cycles on ${card.id}`);
    expect(w.resolveTask(card.id).laneId).toBe("waiting"); // the cap question parks the card

    // a human reply returns the card and re-arms the designer (the cap never gates a human's reply)
    w.comment(card.id, { author: "user", body: "redo it with the new palette" });
    await sleep(150);
    expect(calls.length).toBe(2);
    expect(calls[1].job.role).toBe("designer");
    calls[1].finish({ code: 0 });
  });

  test("evaluateLaneContext: a blocked card yields no actor and re-arms on unblock", () => {
    const { writer: w } = setup();
    const ctx = defaultLaneContext("implement")!;
    const blocker = w.createTask({ title: "blocker", lane: "implement" });
    const card = w.createTask({ title: "card", lane: "implement" });
    w.comment(card.id, { author: "user", body: "ready to build" });

    // armed human comment → actor.id === "builder"
    const ev1 = evaluateLaneContext(w, w.resolveTask(card.id), ctx);
    expect(ev1.actor?.id).toBe("builder");

    // after setBlockedBy → toEqual({ actor: null })
    w.setBlockedBy(card.id, [blocker.id]);
    const ev2 = evaluateLaneContext(w, w.resolveTask(card.id), ctx);
    expect(ev2).toEqual({ actor: null });

    // after the blocker → Done → actor.id === "builder"
    w.updateTask(blocker.id, { lane: "done" });
    const ev3 = evaluateLaneContext(w, w.resolveTask(card.id), ctx);
    expect(ev3.actor?.id).toBe("builder");
  });

  test("a blocked implement card gets no builder and nothing queued", async () => {
    const { dbFile, writer: w } = setup();
    const blocker = w.createTask({ title: "blocker", lane: "implement" });
    const card = w.createTask({ title: "card", lane: "implement" });
    w.comment(card.id, { author: "user", body: "build it" });
    w.setBlockedBy(card.id, [blocker.id]);

    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await sleep(150);
    expect(calls.length).toBe(0);
    expect(activitySnapshot().sessions.some((s) => s.taskId === card.id)).toBe(false);
    expect(activitySnapshot().queued.some((q) => q.taskId === card.id)).toBe(false);

    // unrelated write bumps data_version
    w.createTask({ title: "unrelated", lane: "backlog" });
    await sleep(150);
    expect(calls.length).toBe(0);
    expect(activitySnapshot().sessions.some((s) => s.taskId === card.id)).toBe(false);
    expect(activitySnapshot().queued.some((q) => q.taskId === card.id)).toBe(false);
  });

  test("a blocked card in plan is not armed on entry", async () => {
    const { dbFile, writer: w } = setup();
    const blocker = w.createTask({ title: "blocker", lane: "implement" });
    const card = w.createTask({ title: "card", lane: "backlog" });
    w.setBlockedBy(card.id, [blocker.id]);
    w.updateTask(card.id, { lane: "plan" });

    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await sleep(150);
    expect(calls.length).toBe(0);

    w.updateTask(blocker.id, { lane: "done" });
    await sleep(200);
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("planner");
    expect(calls[0].job.task.id).toBe(card.id);
    calls[0].finish({ code: 0 });
  });

  test("unblocking re-arms the loop with no new comment", async () => {
    const { dbFile, writer: w } = setup();
    const blocker = w.createTask({ title: "blocker", lane: "implement" });
    const card = w.createTask({ title: "card", lane: "implement" });
    w.comment(card.id, { author: "user", body: "build it" });
    w.setBlockedBy(card.id, [blocker.id]);

    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await sleep(150);
    expect(calls.length).toBe(0);

    w.updateTask(blocker.id, { lane: "done" });
    await sleep(200);
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("builder");
    expect(calls[0].job.task.id).toBe(card.id);
    expect(db!.nextTask().task?.id).toBe(card.id);
    calls[0].finish({ code: 0 });
  });

  test("a spawn queued before the block does not run when the slot frees", async () => {
    const { dbFile, writer: w } = setup();
    const blocker = w.createTask({ title: "blocker", lane: "implement" });
    const elab = w.createTask({ title: "elab", lane: "backlog" });
    w.queueElaboration(elab.id);

    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await sleep(150);

    // elaboration occupies the default slot
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("elaborator");

    // while elaborator runs, an armed implement card is queued
    const card = w.createTask({ title: "card", lane: "implement" });
    w.comment(card.id, { author: "user", body: "build it" });
    await sleep(150);
    expect(activitySnapshot().queued.some((q) => q.taskId === card.id)).toBe(true);

    // block the card, then finish the elaborator
    w.setBlockedBy(card.id, [blocker.id]);
    calls[0].finish({ code: 0 });
    await sleep(150);

    // does not run: dropped from queue
    expect(calls.length).toBe(1);
    expect(activitySnapshot().queued.some((q) => q.taskId === card.id)).toBe(false);

    // after unblocking, card spawns
    w.updateTask(blocker.id, { lane: "done" });
    await sleep(200);
    expect(calls.length).toBe(2);
    expect(calls[1].job.task.id).toBe(card.id);
    expect(calls[1].job.role).toBe("builder");
    calls[1].finish({ code: 0 });
  });

  test("a queued resume waits for the blocker and keeps its session id", async () => {
    const { dbFile, writer: w } = setup();
    const blocker = w.createTask({ title: "blocker", lane: "implement" });
    const card = w.createTask({ title: "dead builder", lane: "implement" });
    w.createComment(card.id, { author: BUILDER_AUTHOR, kind: "comment", body: "session died: timeout after 20m" });
    w.setCardSession(card.id, "builder", "kanban-x-builder-blocked");
    w.queueResume(card.id);
    w.setBlockedBy(card.id, [blocker.id]);

    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile);
    await sleep(150);

    expect(calls.length).toBe(0);
    expect(w.resumeRequests().some((r) => r.taskId === card.id)).toBe(true);

    w.updateTask(blocker.id, { lane: "done" });
    await sleep(200);

    expect(calls.length).toBe(1);
    expect(calls[0].job.mode).toBe("resume");
    expect(calls[0].job.sessionId).toBe("kanban-x-builder-blocked");
    expect(w.resumeRequests().some((r) => r.taskId === card.id)).toBe(false);
    calls[0].finish({ code: 0 });
  });

  test("a resume already queued is persisted when blocked and survives a restart", async () => {
    const { dbFile, writer: w } = setup();
    const blocker = w.createTask({ title: "blocker", lane: "implement" });
    const elab = w.createTask({ title: "elab", lane: "backlog" });
    w.queueElaboration(elab.id);

    const logs: string[] = [];
    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile, { log: (msg) => logs.push(msg) });
    await sleep(150);

    // elaborator occupies the slot
    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("elaborator");

    // dead card with resume queued behind the running elaborator
    const d = w.createTask({ title: "dead card", lane: "implement" });
    w.createComment(d.id, { author: BUILDER_AUTHOR, kind: "comment", body: "session died: crash" });
    w.setCardSession(d.id, "builder", "kanban-x-builder-restart");
    w.queueResume(d.id);
    await sleep(150);

    // block the dead card, then finish the elaborator
    w.setBlockedBy(d.id, [blocker.id]);
    calls[0].finish({ code: 0 });
    await sleep(150);

    expect(calls.length).toBe(1);
    expect(w.resumeRequests().some((r) => r.taskId === d.id)).toBe(true);
    expect(logs).toContain(`builder ${d.id}: blocked — resume held, request kept until its blockers land`);

    // restart the loop while still blocked
    stop!();
    db!.close();
    db = null;

    const fakeSpawn2 = fakeSpawn();
    start(fakeSpawn2.spawnFn, dbFile);
    await sleep(150);

    expect(fakeSpawn2.calls.length).toBe(0);
    expect(w.resumeRequests().some((r) => r.taskId === d.id)).toBe(true);

    // unblock: resumes with stored session id
    w.updateTask(blocker.id, { lane: "done" });
    await sleep(200);

    expect(fakeSpawn2.calls.length).toBe(1);
    expect(fakeSpawn2.calls[0].job.mode).toBe("resume");
    expect(fakeSpawn2.calls[0].job.sessionId).toBe("kanban-x-builder-restart");
    expect(w.resumeRequests().some((r) => r.taskId === d.id)).toBe(false);
    fakeSpawn2.calls[0].finish({ code: 0 });
  });

  test("a resume blocked during its pre-spawn gate hands its request back", async () => {
    const { dbFile, writer: w } = setup();
    const blocker = w.createTask({ title: "blocker", lane: "implement" });
    const card = w.createTask({ title: "review card", lane: "review" });
    w.createComment(card.id, { author: REVIEWER_AUTHOR, kind: "comment", body: "session died: stall" });
    w.setCardSession(card.id, "reviewer", "kanban-x-reviewer-gate");
    w.queueResume(card.id);

    let releaseGate: ((res: { ok: boolean; output: string }) => void) | undefined;
    let notifyGateStarted: (() => void) | undefined;
    const gateStarted = new Promise<void>((r) => { notifyGateStarted = r; });
    const gatePromise = new Promise<{ ok: boolean; output: string }>((r) => { releaseGate = r; });

    let gateMode: "hold" | "fast" = "hold";
    const testGate: GateFn = async () => {
      if (gateMode === "hold") {
        notifyGateStarted?.();
        return gatePromise;
      }
      return { ok: true, output: "" };
    };

    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile, { gate: testGate });

    await gateStarted;
    w.setBlockedBy(card.id, [blocker.id]);
    releaseGate!({ ok: true, output: "" });
    await sleep(150);

    expect(calls.length).toBe(0);
    expect(w.resumeRequests().some((r) => r.taskId === card.id)).toBe(true);

    gateMode = "fast";
    w.updateTask(blocker.id, { lane: "done" });
    await sleep(200);

    expect(calls.length).toBe(1);
    expect(calls[0].job.mode).toBe("resume");
    expect(calls[0].job.sessionId).toBe("kanban-x-reviewer-gate");
    expect(w.resumeRequests().some((r) => r.taskId === card.id)).toBe(false);
    calls[0].finish({ code: 0 });
  });

  test("a card blocked during the pre-spawn gate does not spawn when the gate clears", async () => {
    const { dbFile, writer: w } = setup();
    const blocker = w.createTask({ title: "blocker", lane: "implement" });
    const card = cardInReview(w);

    let releaseGate: ((res: { ok: boolean; output: string }) => void) | undefined;
    let notifyGateStarted: (() => void) | undefined;
    const gateStarted = new Promise<void>((r) => { notifyGateStarted = r; });
    const gatePromise = new Promise<{ ok: boolean; output: string }>((r) => { releaseGate = r; });

    let gateMode: "hold" | "fast" = "hold";
    const testGate: GateFn = async () => {
      if (gateMode === "hold") {
        notifyGateStarted?.();
        return gatePromise;
      }
      return { ok: true, output: "" };
    };

    const { calls, spawnFn } = fakeSpawn();
    start(spawnFn, dbFile, { gate: testGate });

    await gateStarted;
    w.setBlockedBy(card.id, [blocker.id]);
    releaseGate!({ ok: true, output: "" });
    await sleep(150);

    expect(calls.length).toBe(0);

    gateMode = "fast";
    w.updateTask(blocker.id, { lane: "done" });
    await sleep(200);

    expect(calls.length).toBe(1);
    expect(calls[0].job.role).toBe("reviewer");
    expect(calls[0].job.task.id).toBe(card.id);
    calls[0].finish({ code: 0 });
  });
});
