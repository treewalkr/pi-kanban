import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KanbanDb, type Engine } from "../src/db";
import {
  BUILDER_AUTHOR,
  startAutoReview,
  type AgentJob,
  type AutoReviewOptions,
  type SpawnContext,
  type SpawnFn,
  type SpawnResult,
} from "../src/autoreview";

/** Shared fixtures for the autoreview*.test.ts files (split so `bun test --parallel` can spread them). */
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pre-engines pool shape → engines + lineups, for the dispatch tests: each
 * slot below maxWorkers becomes a one-seat engine (disabled with the pool),
 * and every covered role's lineup lists them in slot order.
 */
export type ShimSlot = { provider?: string; model?: string; thinking?: "" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" };
export function poolShim(db: KanbanDb, id: string, pool: { name?: string; enabled?: boolean; roles: string[]; slots: ShimSlot[]; maxWorkers?: number }): void {
  for (const e of db.engines()) if (e.id.startsWith(`${id}-`)) db.deleteEngine(e.id);
  const ids = pool.slots.slice(0, pool.maxWorkers ?? pool.slots.length).map((slot, i) => {
    const eid = `${id}-${i}`;
    db.setEngine(eid, { name: `${pool.name ?? id} ${i}`, harness: "pi", ...slot, thinking: slot.thinking || undefined, enabled: pool.enabled !== false });
    return eid;
  });
  for (const role of pool.roles) db.setAgentConfig(role, { ...(db.agentConfig(role) ?? {}), runsOn: ids });
}
/** A full Engine from a partial (unit tests of the flag builders). */
export function eng(e: Partial<Engine>): Engine {
  return { id: "e", name: "E", harness: "pi", flags: [], seats: 1, enabled: true, updatedAt: 0, ...e };
}
export function deletePoolShim(db: KanbanDb, id: string): void {
  for (const e of db.engines()) if (e.id.startsWith(`${id}-`)) db.deleteEngine(e.id);
}


/** Run with the agent env vars cleared, then set from `env`, restoring after. */
export const AGENT_ENV_KEYS = ["KANBAN_AUTOREVIEW_MODEL", "KANBAN_AUTOREVIEW_THINKING", "KANBAN_AUTOREVIEW_GATE"];
export let savedAgentEnv: Record<string, string | undefined> = {};

function saveAgentEnv(): void {
  savedAgentEnv = Object.fromEntries(AGENT_ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of AGENT_ENV_KEYS) delete process.env[k];
}

export function withAgentEnv(env: Record<string, string>, run: () => void): void {
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
export const skillDirs: string[] = [];
export function makeSkill(name: string, body: string): string {
  const skillDir = mkdtempSync(join(tmpdir(), "kanban-skill-"));
  writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: test skill\n---\n\n${body}`);
  skillDirs.push(skillDir);
  return skillDir;
}

function cleanupSkillsAndEnv(): void {
  for (const d of skillDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedAgentEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** Records every spawn (job + spawn ctx); the test resolves each one when its "agent" is done. */
export function fakeSpawn() {
  const calls: Array<{ job: AgentJob; ctx: SpawnContext; finish: (result: SpawnResult) => void }> = [];
  const spawnFn: SpawnFn = (job, ctx) =>
    new Promise<SpawnResult>((resolve) => calls.push({ job, ctx, finish: resolve }));
  return { calls, spawnFn };
}

export let dir = "";
export let db: KanbanDb | null = null;
export let writer: KanbanDb | null = null;
export let stop: (() => void) | null = null;

export function setup(): { dbFile: string; writer: KanbanDb } {
  dir = mkdtempSync(join(tmpdir(), "kanban-autoreview-"));
  const dbFile = join(dir, "t.db");
  writer = new KanbanDb(dbFile);
  return { dbFile, writer };
}

function teardownLoop(): void {
  stop?.();
  db?.close();
  writer?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  stop = null;
  db = null;
  writer = null;
  dir = "";
}

export function withFakePi<T>(scriptBody: string, run: () => Promise<T>): Promise<T> {
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

export function start(spawnFn: SpawnFn, dbFile: string, extra: Partial<AutoReviewOptions> = {}) {
  db = new KanbanDb(dbFile);
  const handle = startAutoReview({ db, cwd: dir, spawnFn, watchIntervalMs: 50, gate: null, ...extra });
  stop = () => handle.stop();
  return handle;
}

/** A card in review with a builder handoff as the last comment — the armed state. */
export function cardInReview(w: KanbanDb, title = "ship it") {
  const card = w.createTask({ title, lane: "review" });
  w.createComment(card.id, { author: "pi-builder", kind: "handoff", body: "done, please review" });
  return card;
}

/** A card in the plan lane with a plan attached — one human action from the gate. */
export function cardInPlan(w: KanbanDb, title = "plan me") {
  const card = w.createTask({ title, lane: "plan" });
  w.attach(card.id, "plan", "# plan v1\nstep one");
  return card;
}

/** A project-tagged card in review with a builder handoff — the armed state. */
export function cardOnProject(w: KanbanDb, project: string, title = "ship it") {
  const card = w.createTask({ title, lane: "review", project });
  w.createComment(card.id, { author: BUILDER_AUTHOR, kind: "handoff", body: "done, please review" });
  return card;
}

/** Tests that build their own loop hand its db / teardown back here so teardownLoop cleans up. */
export function setDb<T extends KanbanDb | null>(next: T): T {
  db = next;
  return next;
}
export function setStop(next: () => void): void {
  stop = next;
}

/** Each test file calls this once at top level: registers the env save/restore and loop teardown hooks. */
export function useAutoReviewHooks(): void {
  beforeEach(saveAgentEnv);
  afterEach(cleanupSkillsAndEnv);
  afterEach(teardownLoop);
}
