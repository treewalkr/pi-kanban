import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_GATE_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  REVIEWER_AUTHOR,
  agentFlags,
  applyProjectOverride,
  defaultGate,
  type GateFn,
  type SpawnFn,
} from "../src/autoreview";
import {
  cardInReview,
  cardOnProject,
  dir,
  fakeSpawn,
  makeSkill,
  setup,
  sleep,
  start,
  useAutoReviewHooks,
  withAgentEnv,
} from "./autoreview.helpers";

useAutoReviewHooks();

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

  test("KANBAN_AGENTS_GATE=0 disables the gate when no gate option is passed", async () => {
    const { dbFile, writer: w } = setup();
    cardInReview(w);
    const { calls, spawnFn } = fakeSpawn();
    withAgentEnv({ KANBAN_AGENTS_GATE: "0" }, () => {
      start(spawnFn, dbFile, { gate: undefined });
    });
    await sleep(100);

    expect(calls.length).toBe(1);
    expect(calls[0]!.job.role).toBe("reviewer");
    calls[0]!.finish({ code: 0 });
  });

  test("deprecated KANBAN_AUTOREVIEW_GATE=0 also disables the gate", async () => {
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
