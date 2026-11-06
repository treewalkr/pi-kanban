import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_STALL_MS, type SpawnPiInput, type SpawnResult } from "../src/autoreview";
import { HELP } from "../src/cli";
import { KanbanDb } from "../src/db";
import {
  CHARTER_LANE_SUFFIX,
  WORKER_ALLOWED_VERBS,
  DEFAULT_WORKER_MAX_CONCURRENT,
  DEFAULT_WORKER_TIMEOUT_MS,
  WORKER_LANES,
  charterFor,
  formatSnapshot,
  resolveWorkerMaxConcurrent,
  resolveWorkerTimeoutMs,
  startWorkerRunner,
  workerAuthor,
  workerArgs,
  workerEngine,
  workerPrompt,
  workerRules,
  WORKER_AUTHOR_PREFIX,
} from "../src/lane-workers";

let dir = "";
let db: KanbanDb;
const skillDirs: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kanban-lane-workers-"));
  db = new KanbanDb(join(dir, "t.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  for (const d of skillDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("charters", () => {
  test("charters exist for exactly the five charter lanes; backlog is the only writable one", () => {
    expect([...WORKER_LANES]).toEqual(["waiting", "backlog", "plan", "implement", "review"]);
    for (const lane of WORKER_LANES) {
      const charter = charterFor(lane);
      expect(charter).not.toBeNull();
      expect(charter!.charter.length).toBeGreaterThan(0);
      expect(charter!.charter.every((b) => b.trim().length > 0)).toBe(true);
      expect(charter!.writable).toBe(lane === "backlog");
    }
    expect(charterFor("done")).toBeNull();
    expect(charterFor("archive")).toBeNull();
    expect(charterFor("spike")).toBeNull();
    expect(WORKER_AUTHOR_PREFIX).toBe("pi-worker-");
    expect(workerAuthor("backlog")).toBe("pi-worker-backlog");
  });
});

describe("workerPrompt", () => {
  const snapshot = "abc12 · some card · 3d · normal";

  test("workerPrompt embeds charter, budget caps, snapshot, forbidden verbs, author, focus", () => {
    const prompt = workerPrompt({ laneId: "backlog", snapshot, focus: "stale cards" });

    // charter bullets
    for (const bullet of charterFor("backlog")!.charter) {
      expect(prompt).toContain(bullet);
    }
    // budget caps: 12 reads everywhere; 10 writes + 3 promotions on the writable lane only
    expect(prompt).toContain("Read at most 12 cards (`kanban brief <id>`)");
    expect(prompt).toContain("Write at most 10 card changes and promote at most 3 cards to Plan.");
    expect(workerPrompt({ laneId: "waiting", snapshot })).not.toContain("Write at most 10 card changes");

    // snapshot + focus
    expect(prompt).toContain(snapshot);
    expect(prompt).toContain("Focus for this run: stale cards");
    expect(workerPrompt({ laneId: "backlog", snapshot })).not.toContain("Focus for this run:");

    // the pinned allowed-verb sentence, character-for-character — and `question`
    // never appears as a standalone verb (v1's defect)
    const expected =
      "Act only through the kanban CLI. Allowed verbs: `ls`, `search`, `show`, `brief`, `stats`, `comment`, `edit`, " +
      "`mv` (within your lane), `handoff`, `link` — questions are `kanban comment <id> \"<question + recommended default>\" --kind question`. " +
      "Every card write lands in that card's thread; always pass `--author pi-worker-backlog`. " +
      "Never run `approve`, `reject`, `review`, `plan-review`, `elaborate`, `rm`, `lane rm`, `attach`, `ws`, `serve`, or `stop` — " +
      "gates, deletions, and loop-owned artifacts are out of your hands. Never touch cards outside your lane.";
    expect(prompt).toContain(expected);
    // no standalone `question` verb in the rules (v1's defect) — the skill body's
    // prose mentions `question`, so pin this on the rules text itself
    expect(workerRules("pi-worker-backlog")).not.toContain("`question`");
    for (const verb of WORKER_ALLOWED_VERBS) {
      expect(prompt).toContain(`\`${verb}\``);
    }

    // author, summary rule, identity
    expect(prompt).toContain("--author pi-worker-backlog");
    expect(prompt).toContain("summary of at most 10 lines");
    expect(prompt).toContain("lane worker (author `pi-worker-backlog`)");
    expect(prompt).toContain("<skill name=\"pi-kanban\"");
  });

  test("worker prompt forbids the gate and destructive verbs on every charted lane", () => {
    for (const lane of WORKER_LANES) {
      const prompt = workerPrompt({ laneId: lane, snapshot });
      for (const verb of ["approve", "reject", "review", "plan-review"]) {
        expect(prompt).toContain(`\`${verb}\``);
      }
    }
  });

  test("worker prompt pins thread-visible writes and the per-card author", () => {
    const backlog = workerPrompt({ laneId: "backlog", snapshot });
    expect(backlog).toContain("Every card write lands in that card's thread");
    expect(backlog).toContain("--author pi-worker-backlog");
    for (const verb of ["comment", "handoff", "edit", "mv", "link"]) {
      expect(backlog).toContain(`\`${verb}\``);
    }
    for (const lane of ["waiting", "plan", "implement", "review"] as const) {
      expect(workerPrompt({ laneId: lane, snapshot })).toContain("Write nothing — your summary is the deliverable");
    }
  });
});

describe("formatSnapshot", () => {
  test("one line per card with blocked marker; truncation tail", () => {
    const lines = formatSnapshot({
      laneId: "backlog",
      total: 3,
      truncated: false,
      cards: [
        { id: "abc12", title: "plain", ageDays: 3, priority: "normal", blocked: false },
        { id: "d26pe", title: "blocked one", ageDays: 0, priority: "high", blocked: true },
      ],
    });
    expect(lines).toBe("abc12 · plain · 3d · normal\nd26pe · blocked one · 0d · high · ⊘blocked");

    const capped = formatSnapshot({
      laneId: "backlog",
      total: 45,
      truncated: true,
      cards: [{ id: "abc12", title: "only", ageDays: 1, priority: "low", blocked: false }],
    });
    expect(capped).toBe("abc12 · only · 1d · low\n…and 44 more");
  });
});

describe("workerArgs and env knobs", () => {
  test("workerArgs: engine supplies the model, config the behavior — no default thinking", () => {
    const skillDir = mkdtempSync(join(tmpdir(), "kanban-worker-skill-"));
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: demo\ndescription: test skill\n---\n\nBe careful.\n");
    skillDirs.push(skillDir);
    expect(workerArgs(null)).toEqual([]);
    expect(workerArgs({})).toEqual([]);
    const engine = { id: "w", name: "W", harness: "pi" as const, provider: "zai", model: "glm-5.3", thinking: "low" as const, flags: ["--no-mcp"], seats: 1, enabled: true, updatedAt: 0 };
    const args = workerArgs(
      {
        skills: [skillDir],
        context: "be careful",
        tools: "read,write",
        extraArgs: ["--no-session"],
      },
      engine,
    );
    expect(args.slice(0, 6)).toEqual(["--provider", "zai", "--model", "glm-5.3", "--thinking", "low"]);
    expect(args).toContain("--skill");
    expect(args).toContain(skillDir);
    expect(args).toContain("--append-system-prompt");
    expect(args.join("\n")).toContain("be careful");
    expect(args.join("\n")).toContain("<skill name=");
    expect(args).toContain("--tools");
    expect(args).toContain("--no-session");
    expect(args.at(-1)).toBe("--no-mcp");
  });

  test("workerEngine: the worker lineup's first enabled pi engine, else pi default; null when the pi harness is off", () => {
    const db = new KanbanDb(join(mkdtempSync(join(tmpdir(), "kanban-worker-eng-")), "t.db"));
    expect(workerEngine(db)?.id).toBe("default");
    db.setEngine("sonnet", { name: "Sonnet", harness: "claude", model: "sonnet" });
    db.setEngine("off", { name: "Off", harness: "pi", model: "x", enabled: false });
    db.setEngine("flash", { name: "Flash", harness: "pi", provider: "zai", model: "glm-5.3-flash" });
    db.setAgentConfig("worker", { runsOn: ["sonnet", "off", "flash"] });
    expect(workerEngine(db)?.id).toBe("flash");
    db.setHarnessEnabled("pi", false);
    expect(workerEngine(db)).toBeNull();
    db.setHarnessEnabled("pi", true);
    expect(workerEngine(db)?.id).toBe("flash");
    db.close();
  });

  test("env knobs: invalid → default + console.warn", () => {
    expect(DEFAULT_WORKER_TIMEOUT_MS).toBe(15 * 60_000);
    expect(DEFAULT_WORKER_MAX_CONCURRENT).toBe(2);
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (m: unknown) => warns.push(String(m));
    try {
      expect(resolveWorkerTimeoutMs(undefined)).toBe(DEFAULT_WORKER_TIMEOUT_MS);
      expect(resolveWorkerTimeoutMs("60000")).toBe(60_000);
      expect(resolveWorkerTimeoutMs("abc")).toBe(DEFAULT_WORKER_TIMEOUT_MS);
      expect(resolveWorkerTimeoutMs("0")).toBe(DEFAULT_WORKER_TIMEOUT_MS);
      expect(resolveWorkerMaxConcurrent("3")).toBe(3);
      expect(resolveWorkerMaxConcurrent("12")).toBe(DEFAULT_WORKER_MAX_CONCURRENT);
      expect(resolveWorkerMaxConcurrent("x")).toBe(DEFAULT_WORKER_MAX_CONCURRENT);
    } finally {
      console.warn = orig;
    }
    expect(warns.some((w) => w.includes("KANBAN_WORKER_TIMEOUT_MS"))).toBe(true);
    expect(warns.some((w) => w.includes("KANBAN_WORKER_MAX_CONCURRENT"))).toBe(true);
  });
});

/** Queue through a second connection — the CLI/manager process shape the runner's watcher reacts to. */
function queueViaCli(input: { laneId: string; focus?: string }) {
  const writer = new KanbanDb(join(dir, "t.db"));
  try {
    return writer.queueLaneWorker(input);
  } finally {
    writer.close();
  }
}

/** A spawnFn over the spawnPi signature: records inputs, resolves from a test-controlled list. */
function fakeSpawnPi() {
  const calls: SpawnPiInput[] = [];
  const gates: Array<(result: SpawnResult) => void> = [];
  const spawnFn = (input: SpawnPiInput): Promise<SpawnResult> => {
    calls.push(input);
    return new Promise<SpawnResult>((resolve) => gates.push(resolve));
  };
  return {
    calls,
    gates,
    spawnFn,
    finishAll(result: SpawnResult): void {
      for (const g of gates.splice(0)) g(result);
    },
  };
}

describe("runner", () => {
  test("runner drains a queued run: claim, spawn with worker args, record summary/log/status done", async () => {
    db.createTask({ title: "card one", lane: "backlog" });
    const fake = fakeSpawnPi();
    const logs: string[] = [];
    const runner = startWorkerRunner({ db, cwd: dir, spawnFn: fake.spawnFn, watchIntervalMs: 10, log: (m) => logs.push(m) });

    const run = queueViaCli({ laneId: "backlog", focus: "groom it" });
    await sleep(50);

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.sessionId).toBe(`kanban-worker-backlog-${run.id}`);
    expect(call.cwd).toBe(dir);
    expect(call.timeoutMs).toBe(DEFAULT_WORKER_TIMEOUT_MS);
    expect(call.stallMs).toBe(DEFAULT_STALL_MS);
    expect(call.prompt).toContain("Focus for this run: groom it");
    expect(call.prompt).toContain(formatSnapshot(db.laneSnapshot("backlog"))); // the lane snapshot section
    expect(call.args).toEqual([]);

    // text + noise emits: summary is the trailing text lines, log keeps everything
    call.emit("→ Bash: kanban ls backlog");
    call.emit("text: groomed 2 cards, ranked 1");
    call.emit("text: asked one question on a vague card");
    fake.gates[0]!({ code: 0 });
    await sleep(30);

    const done = db.laneWorker(run.id)!;
    expect(done.status).toBe("done");
    expect(done.summary).toBe("groomed 2 cards, ranked 1\nasked one question on a vague card");
    expect(done.log).toContain("→ Bash: kanban ls backlog");
    expect(done.exitInfo).toBeUndefined();

    // a queued run without focus gets no focus line
    const second = queueViaCli({ laneId: "waiting" });
    await sleep(50);
    expect(fake.calls[1]!.prompt).not.toContain("Focus for this run:");
    fake.finishAll({ code: 0 });
    await sleep(30);
    // exit 0 without any text output is a failure ("ended without a verdict")
    const done2 = db.laneWorker(second.id)!;
    expect(done2.status).toBe("failed");
    expect(done2.exitInfo).toContain("ended without a verdict");

    runner.stop();
    expect(logs.some((l) => l.startsWith("backlog run ") && l.includes("started"))).toBe(true);
  });

  test("runner: one worker per lane — a second queued run for the same lane waits", async () => {
    const fake = fakeSpawnPi();
    const runner = startWorkerRunner({ db, cwd: dir, spawnFn: fake.spawnFn, watchIntervalMs: 10, log: () => {} });

    const first = queueViaCli({ laneId: "backlog" });
    const second = queueViaCli({ laneId: "backlog" });
    await sleep(50);

    expect(fake.calls).toHaveLength(1);
    expect(db.laneWorker(first.id)!.status).toBe("running");
    expect(db.laneWorker(second.id)!.status).toBe("queued");

    (fake.calls[0] as unknown as { emit: (l: string) => void }).emit("text: groomed");
    fake.finishAll({ code: 0 });
    await sleep(50);
    expect(db.laneWorker(first.id)!.status).toBe("done");
    expect(db.laneWorker(second.id)!.status).toBe("running");
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.sessionId).toBe(`kanban-worker-backlog-${second.id}`);

    runner.stop();
  });

  test("runner: global cap holds and releases; agents paused stops draining; failed spawn records exitInfo", async () => {
    const fake = fakeSpawnPi();
    const runner = startWorkerRunner({ db, cwd: dir, spawnFn: fake.spawnFn, maxConcurrent: 1, watchIntervalMs: 10, log: () => {} });

    const a = queueViaCli({ laneId: "backlog" });
    const b = queueViaCli({ laneId: "review" });
    await sleep(50);
    expect(fake.calls).toHaveLength(1); // cap 1 serializes different lanes
    expect(db.laneWorker(a.id)!.status).toBe("running");
    expect(db.laneWorker(b.id)!.status).toBe("queued");

    // failed spawn → failed with a deathReason-derived exitInfo
    fake.gates[0]!({ code: 1, stderrTail: "boom" });
    await sleep(50);
    expect(db.laneWorker(a.id)!.status).toBe("failed");
    expect(db.laneWorker(a.id)!.exitInfo).toContain("failed (exit 1 — boom) after");
    expect(db.laneWorker(b.id)!.status).toBe("running");
    fake.finishAll({ code: 0 });
    await sleep(30);

    // pause stops new drains; running workers are never killed
    db.setAgentsPaused(true);
    const c = queueViaCli({ laneId: "waiting" });
    await sleep(50);
    expect(db.laneWorker(c.id)!.status).toBe("queued");

    db.setAgentsPaused(false);
    // a fresh external write fires the watcher tick that resumes draining
    queueViaCli({ laneId: "implement" });
    await sleep(50);
    expect(db.laneWorker(c.id)!.status).toBe("running");

    runner.stop();
  });

  test("start reaps orphaned running rows with an explicit reason", async () => {
    const run = db.queueLaneWorker({ laneId: "backlog" });
    db.claimLaneWorker(run.id, "kanban-worker-backlog-stale", Date.now());
    const fake = fakeSpawnPi();
    const runner = startWorkerRunner({ db, cwd: dir, spawnFn: fake.spawnFn, watchIntervalMs: 10, log: () => {} });
    expect(db.laneWorker(run.id)!.status).toBe("failed");
    expect(db.laneWorker(run.id)!.exitInfo).toBe("server restarted — run lost; re-dispatch if needed");
    runner.stop();
  });
});

describe("env wiring", () => {
  test("charter lanes suffix and allowed verbs match the CLI help", () => {
    expect(CHARTER_LANE_SUFFIX).toBe("waiting, backlog, plan, implement, review");
    for (const verb of WORKER_ALLOWED_VERBS) {
      expect(HELP).toContain(` ${verb} `);
    }
  });
});
