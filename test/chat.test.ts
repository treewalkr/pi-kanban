import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHAT_SESSION_ID_PREFIX,
  ChatManager,
  MANAGER_SESSION_ID,
  chatSeed,
  chatSystemAppend,
  DEFAULT_CHAT_IDLE_TIMEOUT_MS,
  defaultChatSessionFactory,
  projectEntries,
  THINKING_BLOCK_CAP,
  type ChatHandle,
  type ChatSessionFactory,
} from "../src/chat";
import { KanbanDb, KanbanError } from "../src/db";

let dir = "";
let db: KanbanDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kanban-chat-"));
  db = new KanbanDb(join(dir, "t.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A fake SDK session: only the surface ChatHandleImpl touches. */
function fakeSession(overrides: Record<string, unknown> = {}) {
  const listeners = new Set<(event: unknown) => void>();
  return {
    subscribe: (listener: (event: unknown) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isStreaming: false,
    isCompacting: false,
    model: null,
    thinkingLevel: "off",
    getSteeringMessages: () => [] as string[],
    getFollowUpMessages: () => [] as string[],
    agent: { state: {} },
    prompt: async () => {},
    steer: async () => "queued" as const,
    followUp: async () => "queued" as const,
    abort: async () => {},
    dispose: () => {},
    ...overrides,
  };
}

function factorySpy(sessions: unknown[]) {
  let count = 0;
  const factory: ChatSessionFactory = async (opts) => {
    count += 1;
    const session = fakeSession();
    sessions.push({ ...opts, session });
    return session as never;
  };
  return { factory, count: () => count };
}

test("get returns one alive handle per card and memoizes concurrent creation", async () => {
  const one = db.createTask({ title: "one" });
  const sessions: unknown[] = [];
  const { factory, count } = factorySpy(sessions);
  const manager = new ChatManager({ cwd: dir, db, createSession: factory });

  const [a, b] = await Promise.all([manager.get(one.id), manager.get(one.id)]);
  expect(a).toBe(b);
  expect(count()).toBe(1); // parallel gets share one factory invocation

  const again = await manager.get(one.id);
  expect(again).toBe(a);
  expect(manager.peek(one.id)).toBe(a);
  expect(manager.peek("zzzzz")).toBeNull();
  expect(manager.sessionCount()).toBe(1);
});

test("deterministic id: fresh card creates kanban-chat-<id>, existing file resumes it", async () => {
  const fresh = db.createTask({ title: "fresh" });
  const sessions: unknown[] = [];
  const { factory } = factorySpy(sessions);
  const sessionDir = join(dir, "sessions");
  const manager = new ChatManager({ cwd: dir, db, sessionDir, createSession: factory });

  const handle = await manager.get(fresh.id);
  expect(handle.sessionId).toBe(CHAT_SESSION_ID_PREFIX + fresh.id);
  const first = sessions[0] as { sessionManager: { getSessionId(): string } };
  expect(first.sessionManager.getSessionId()).toBe(handle.sessionId);
  await manager.disposeAll();

  // A pre-written session file under the same dir is opened, not re-created.
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const id = CHAT_SESSION_ID_PREFIX + fresh.id;
  const pre = SessionManager.create(dir, sessionDir, { id });
  pre.appendMessage({ role: "user", content: "hello from disk", timestamp: 1 });

  const resumeSessions: unknown[] = [];
  const { factory: resumeFactory } = factorySpy(resumeSessions);
  const manager2 = new ChatManager({ cwd: dir, db, sessionDir, createSession: resumeFactory });
  const resumed = await manager2.get(fresh.id);
  expect(resumed.sessionId).toBe(id);
  const history = resumed.historyFromDisk();
  expect(history.some((m) => m.role === "user" && m.content === "hello from disk")).toBe(true);
  await manager2.disposeAll();
});

test("prompt while streaming without behavior conflicts; steer/followUp queue", async () => {
  const busy = db.createTask({ title: "busy" });
  const sessions: unknown[] = [];
  const { factory } = factorySpy(sessions);
  const manager = new ChatManager({ cwd: dir, db, createSession: factory });
  const handle: ChatHandle = await manager.get(busy.id);
  const live = sessions[0] as { session: Record<string, unknown> };
  live.session.isStreaming = true;

  try {
    await handle.send({ type: "prompt", message: "hi" });
    expect.unreachable();
  } catch (e) {
    expect((e as Error).message).toBe("chat is streaming — send steer or followUp");
    expect((e as { code: string }).code).toBe("conflict");
  }

  const steered = (await handle.send({ type: "steer", message: "s" })) as { accepted: boolean; disposition: string };
  expect(steered).toEqual({ accepted: true, disposition: "queued" });
  const followUp = (await handle.send({ type: "followUp", message: "f" })) as { accepted: boolean };
  expect(followUp.accepted).toBe(true);

  const queued = (await handle.send({ type: "prompt", message: "q", streamingBehavior: "followUp" })) as { accepted: boolean };
  expect(queued.accepted).toBe(true);
  await manager.disposeAll();
});

test("prompt resolves on the preflight callback instead of awaiting the run", async () => {
  const card = db.createTask({ title: "preflight" });
  const sessions: unknown[] = [];
  const { factory } = factorySpy(sessions);
  const manager = new ChatManager({ cwd: dir, db, createSession: factory });
  const handle: ChatHandle = await manager.get(card.id);
  const live = sessions[0] as { session: Record<string, unknown> };
  // Mirror the real SDK (dist/core/agent-session.js): preflight fires at _startRun
  // and prompt() then awaits the whole LLM + tool loop before resolving.
  live.session.prompt = async (_msg: string, opts?: { preflightResult?: (d: string) => void }) => {
    opts?.preflightResult?.("started");
    await new Promise(() => {});
  };

  const result = (await Promise.race([
    handle.send({ type: "prompt", message: "hi" }),
    Bun.sleep(250).then(() => "blocked-waiting-for-full-run"),
  ])) as { accepted: boolean; disposition: string };
  expect(result).toEqual({ accepted: true, disposition: "started" });

  // A rejection before preflight (validation/auth) is a conflict refusal.
  live.session.prompt = async () => {
    throw new Error("no model selected");
  };
  try {
    await handle.send({ type: "prompt", message: "again" });
    expect.unreachable();
  } catch (e) {
    expect((e as Error).message).toBe("no model selected");
    expect((e as { code: string }).code).toBe("conflict");
  }
  await manager.disposeAll();
});

test("get keys handles by the resolved task id: a unique prefix reuses the live handle", async () => {
  const card = db.createTask({ title: "prefix-me" });
  const { factory } = factorySpy([]);
  const manager = new ChatManager({ cwd: dir, db, createSession: factory });
  const full = await manager.get(card.id);
  const viaPrefix = await manager.get(card.id.slice(0, 4)); // unique prefix of the id
  expect(viaPrefix).toBe(full);
  expect(manager.sessionCount()).toBe(1);
  await manager.disposeAll();
});

test("idle expiry disposes; a streaming session never idles out", async () => {
  let now = 1_000_000;
  const idleOne = db.createTask({ title: "idle-one" });
  const idleTwo = db.createTask({ title: "idle-two" });
  const sessions: unknown[] = [];
  const { factory } = factorySpy(sessions);
  const manager = new ChatManager({
    cwd: dir,
    db,
    createSession: factory,
    idleTimeoutMs: DEFAULT_CHAT_IDLE_TIMEOUT_MS,
    now: () => now,
  });

  const shutdowns: unknown[] = [];
  const handle = await manager.get(idleOne.id);
  handle.onEvent((e) => shutdowns.push(e));
  now += DEFAULT_CHAT_IDLE_TIMEOUT_MS + 1;
  await Bun.sleep(400); // the idle sweep ticks at 250ms
  expect(manager.peek(idleOne.id)).toBeNull();
  expect(shutdowns).toContainEqual({ type: "shutdown", reason: "idle" });

  const streamingSessions: unknown[] = [];
  const { factory: streamingFactory } = factorySpy(streamingSessions);
  const manager2 = new ChatManager({ cwd: dir, db, createSession: streamingFactory, now: () => now });
  const live = await manager2.get(idleTwo.id);
  (streamingSessions[0] as { session: Record<string, unknown> }).session.isStreaming = true;
  now += DEFAULT_CHAT_IDLE_TIMEOUT_MS * 2;
  await Bun.sleep(400);
  expect(live.isAlive()).toBe(true);
  await manager2.disposeAll();
  expect(manager2.sessionCount()).toBe(0);
});

test("disposeAll emits shutdown with reason server on every listener", async () => {
  const d1 = db.createTask({ title: "d1" });
  const d2 = db.createTask({ title: "d2" });
  const sessions: unknown[] = [];
  const { factory } = factorySpy(sessions);
  const manager = new ChatManager({ cwd: dir, db, createSession: factory, idleTimeoutMs: 0 });
  const a = await manager.get(d1.id);
  const b = await manager.get(d2.id);
  const got: unknown[] = [];
  a.onEvent((e) => got.push(e));
  b.onEvent((e) => got.push(e));
  await manager.disposeAll();
  expect(got).toContainEqual({ type: "shutdown", reason: "server" });
  expect(manager.sessionCount()).toBe(0);
  expect(a.isAlive()).toBe(false);
  expect(b.isAlive()).toBe(false);
});

test("first prompt carries the seed; system append carries the skill body and gate rules", async () => {
  const seeded = db.createTask({ title: "seeded", note: "the note body" });
  const sessions: unknown[] = [];
  const { factory } = factorySpy(sessions);
  const manager = new ChatManager({ cwd: dir, db, createSession: factory });
  const handle = await manager.get(seeded.id);

  const capture = sessions[0] as { session: Record<string, unknown>; sessionManager: { appendMessage(m: unknown): string } };
  const prompts: string[] = [];
  capture.session.prompt = async (text: string) => {
    prompts.push(text);
    // Mirror the real SDK: a prompt appends the user entry, so later prompts skip the seed.
    capture.sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
  };

  const id = seeded.id;
  const resolved = seeded;
  const laneName = db.lanes().find((l) => l.id === resolved.laneId)!.name;
  await handle.send({ type: "prompt", message: "what next?" });
  await handle.send({ type: "prompt", message: "verbatim second" });

  const seed = chatSeed(resolved, laneName);
  expect(prompts[0].startsWith(seed)).toBe(true);
  expect(prompts[0]).toContain(id);
  expect(prompts[0]).toContain("the note body");
  expect(prompts[0]).toContain(`kanban brief ${id}`);
  expect(prompts[0].endsWith("what next?")).toBe(true);
  expect(prompts[1]).toBe("verbatim second"); // later prompts are bare

  const append = (sessions[0] as { appendSystemPrompt: string }).appendSystemPrompt;
  expect(append).toContain(`<skill name="pi-kanban"`);
  expect(append).toContain("--author pi-chat");
  expect(append).toContain("Never run kanban approve, kanban reject, kanban review, or kanban plan-review");
  expect(append).toContain(`kanban card ${id} "seeded"`);
  await manager.disposeAll();
});

test("history projection caps thinking blocks and the message tail", () => {
  const long = "x".repeat(THINKING_BLOCK_CAP + 50);
  const entries = [
    ...Array.from({ length: 120 }, (_, i) => ({
      type: "message",
      id: `e${i}`,
      message: { role: "user", content: `m${i}` },
    })),
    {
      type: "message",
      id: "e-thinking",
      message: { role: "assistant", content: [{ type: "thinking", thinking: long }, { type: "text", text: "done" }] },
    },
    { type: "message", id: "e-tool", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }] } },
    { type: "message", id: "e-result", message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", isError: false } },
    { type: "message", id: "e-system", message: { role: "system", content: "hidden" } },
  ];
  const { messages, truncated } = projectEntries(entries);
  expect(truncated).toBe(true);
  expect(messages.length).toBe(100);
  const thinkingMsg = messages.find((m) => m.role === "assistant" && m.entryId === "e-thinking");
  if (thinkingMsg?.role !== "assistant") throw new Error("assistant message lost");
  expect(thinkingMsg.blocks.find((b) => b.type === "thinking")).toEqual({
    type: "thinking",
    thinking: "x".repeat(THINKING_BLOCK_CAP),
    truncated: true,
  });
  expect(thinkingMsg.blocks.find((b) => b.type === "text")).toEqual({ type: "text", text: "done" });

  const toolMsg = messages.find((m) => m.role === "assistant" && m.entryId === "e-tool");
  if (toolMsg?.role !== "assistant") throw new Error("tool message lost");
  expect(toolMsg.blocks[0]).toEqual({ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: { command: "ls" } });

  expect(messages.some((m) => m.role === "toolResult" && m.toolCallId === "call-1")).toBe(true);
  expect(messages.some((m) => m.role === "user" && m.content === "m0")).toBe(false); // tail-capped away
  expect(messages.some((m) => m.role === "user" && m.content === "m119")).toBe(true);
  expect(messages.some((m) => m.role === "user" && m.content === "hidden")).toBe(false); // system skipped
});

test("history projection carries per-message times from the session entries", () => {
  const entries = [
    {
      type: "message",
      id: "u1",
      timestamp: "2026-11-05T08:00:02.000Z",
      message: { role: "user", content: "go", timestamp: 1000 }, // message timestamp wins
    },
    {
      type: "message",
      id: "a1",
      timestamp: "2026-11-05T08:00:05.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] }, // entry ISO fallback
    },
    {
      type: "message",
      id: "t1",
      message: { role: "toolResult", toolCallId: "c1" }, // neither — key omitted
    },
    {
      type: "message",
      id: "u2",
      timestamp: "nope",
      message: { role: "user", content: "legacy" }, // garbage ISO — key omitted
    },
  ];
  const { messages } = projectEntries(entries);
  expect(messages[0]).toMatchObject({ role: "user", at: 1000 });
  expect(messages[1]).toMatchObject({ role: "assistant", at: Date.parse("2026-11-05T08:00:05.000Z") });
  expect(messages[2]).toMatchObject({ role: "toolResult" });
  expect("at" in messages[2]).toBe(false);
  expect(messages[3]).toMatchObject({ role: "user" });
  expect("at" in messages[3]).toBe(false);
});

test("active tool events replay to new listeners; end and agent_end clear them", async () => {
  const tools = db.createTask({ title: "tools" });
  let sessionListener: ((event: unknown) => void) | undefined;
  const manager = new ChatManager({
    cwd: dir,
    db,
    idleTimeoutMs: 0,
    createSession: async () =>
      fakeSession({
        subscribe: (listener: (event: unknown) => void) => {
          sessionListener = listener;
          return () => {};
        },
      }) as never,
  });
  const handle = await manager.get(tools.id);
  if (!sessionListener) throw new Error("session listener not captured");

  // Nothing running yet: a fresh listener gets no replay.
  const early: unknown[] = [];
  handle.onEvent((e) => early.push(e))();
  expect(early).toEqual([]);

  sessionListener({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: {} });
  sessionListener({ type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", args: {}, partialResult: "v2" });
  sessionListener({ type: "tool_execution_start", toolCallId: "call-1/nested", toolName: "read", args: {}, parentToolCallId: "call-1" });

  const replay: unknown[] = [];
  handle.onEvent((e) => replay.push(e));
  expect(replay.map((e) => (e as { toolCallId: string }).toolCallId)).toEqual(["call-1", "call-1/nested"]);
  expect((replay[0] as { partialResult: unknown }).partialResult).toBe("v2"); // latest update wins
  expect(handle.activeToolEvents().length).toBe(2);

  sessionListener({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: {}, isError: false });
  expect(handle.activeToolEvents().map((e) => (e as { toolCallId: string }).toolCallId)).toEqual([]); // nested `<id>/` ids die with the parent

  sessionListener({ type: "tool_execution_start", toolCallId: "call-2", toolName: "edit", args: {} });
  sessionListener({ type: "agent_end", messages: [] });
  expect(handle.activeToolEvents()).toEqual([]);
  await manager.disposeAll();
});

test("real SDK session constructs in-memory under bun", async () => {
  let sdk: typeof import("@earendil-works/pi-coding-agent");
  try {
    sdk = await import("@earendil-works/pi-coding-agent");
  } catch {
    return; // package import broken → pass here; the suite fails loudly elsewhere
  }
  const sessionManager = sdk.SessionManager.inMemory(dir);
  const session = await defaultChatSessionFactory({ cwd: dir, sessionManager, appendSystemPrompt: "chat append" });
  expect(typeof session.subscribe).toBe("function");
  session.dispose();
});

// ---------- board manager session (card d26pe) ----------

test('get("board") builds the manager handle: kanban-manager id, charter system append, overview seed', async () => {
  db.createTask({ title: "the next thing", lane: "backlog", priority: "high" });
  db.createTask({ title: "parked question", lane: "waiting" });
  const sessions: unknown[] = [];
  const { factory } = factorySpy(sessions);
  const manager = new ChatManager({ cwd: dir, db, createSession: factory });

  const handle = await manager.get("board");
  expect(handle.sessionId).toBe(MANAGER_SESSION_ID);
  expect(manager.peek("board")).toBe(handle);
  expect(manager.sessionCount()).toBe(1);

  const capture = sessions[0] as {
    appendSystemPrompt: string;
    session: Record<string, unknown>;
    sessionManager: { appendMessage(m: unknown): string };
  };
  expect(capture.appendSystemPrompt).toContain("board manager");
  expect(capture.appendSystemPrompt).toContain("`pi-manager`");
  expect(capture.appendSystemPrompt).toContain('<skill name="pi-kanban"');
  expect(capture.appendSystemPrompt).toContain("kanban worker run <lane>");
  expect(capture.appendSystemPrompt).toContain("Propose before you dispatch");
  expect(capture.appendSystemPrompt).toContain(
    "Never run `kanban approve`, `kanban reject`, `kanban review`, or `kanban plan-review`",
  );

  const prompts: string[] = [];
  capture.session.prompt = async (text: string) => {
    prompts.push(text);
    capture.sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
  };
  await handle.send({ type: "prompt", message: "what needs attention?" });
  expect(prompts[0]).toContain("You are the board manager (`pi-manager`)");
  expect(prompts[0]).toContain("Snapshot of the board as this session starts:");
  expect(prompts[0]).toContain("Backlog 1"); // lane counts from the seeded db
  expect(prompts[0]).toContain("the next thing");
  expect(prompts[0]).toContain("waiting on you:");
  // a second prompt skips the seed
  await handle.send({ type: "prompt", message: "and now?" });
  expect(prompts[1]).not.toContain("Snapshot of the board");
  await manager.disposeAll();
});

test('"board" is never a card id: resolveTask throws while the manager handle works', async () => {
  const card = db.createTask({ title: "a real card" });
  expect(() => db.resolveTask("board")).toThrow(new KanbanError("no task matching 'board'", "not-found"));

  const sessions: unknown[] = [];
  const { factory } = factorySpy(sessions);
  const manager = new ChatManager({ cwd: dir, db, createSession: factory });
  const boardHandle = await manager.get("board");
  const cardHandle = await manager.get(card.id);
  expect(boardHandle).not.toBe(cardHandle);
  expect(cardHandle.sessionId).toBe(CHAT_SESSION_ID_PREFIX + card.id);
  await manager.disposeAll();
});

test("manager handle idle-expires and resumes with a fresh overview seed", async () => {
  let now = 1_000_000;
  const sessions: unknown[] = [];
  const { factory } = factorySpy(sessions);
  const manager = new ChatManager({
    cwd: dir,
    db,
    createSession: factory,
    idleTimeoutMs: DEFAULT_CHAT_IDLE_TIMEOUT_MS,
    now: () => now,
  });

  const handle = await manager.get("board");
  now += DEFAULT_CHAT_IDLE_TIMEOUT_MS + 1;
  await Bun.sleep(400); // the idle sweep ticks at 250ms
  expect(manager.peek("board")).toBeNull();

  // board changed while the manager was away — the rebuilt handle seeds from fresh numbers
  db.createTask({ title: "later card", lane: "review" });
  const resumed = await manager.get("board");
  expect(resumed).not.toBe(handle);
  const capture2 = sessions[1] as {
    session: Record<string, unknown>;
    sessionManager: { appendMessage(m: unknown): string };
  };
  const prompts2: string[] = [];
  capture2.session.prompt = async (text: string) => {
    prompts2.push(text);
    capture2.sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
  };
  await resumed.send({ type: "prompt", message: "back" });
  expect(prompts2[0]).toContain("Snapshot of the board as this session starts:");
  expect(prompts2[0]).toContain("later card");
  expect(prompts2[0]).toContain("Review 1");
  await manager.disposeAll();
});

test("per-card chat cwd: routed card spawns in its project repo; board manager on fallback", async () => {
  const alphaDir = join(dir, "alpha-repo");
  mkdirSync(alphaDir);
  db.setProjectRepo("alpha", alphaDir);
  const routed = db.createTask({ title: "routed card", project: "alpha" });
  const fallback = db.createTask({ title: "fallback card", project: "beta" }); // un-routed tag

  const sessions: unknown[] = [];
  const { factory } = factorySpy(sessions);
  const sessionDir = join(dir, "sessions");
  const manager = new ChatManager({ cwd: dir, db, sessionDir, createSession: factory });

  await manager.get(routed.id);
  await manager.get(fallback.id);
  await manager.get("board");

  const cwdOf = (sessionId: string): string => {
    const hit = sessions.find(
      (s) => (s as { sessionManager: { getSessionId(): string } }).sessionManager.getSessionId() === sessionId,
    );
    expect(hit).toBeDefined();
    return (hit as { cwd: string }).cwd;
  };

  expect(cwdOf(CHAT_SESSION_ID_PREFIX + routed.id)).toBe(alphaDir); // routed card builds in its repo
  expect(cwdOf(CHAT_SESSION_ID_PREFIX + fallback.id)).toBe(dir); // un-routed tag → serve cwd
  expect(cwdOf(MANAGER_SESSION_ID)).toBe(dir); // board manager stays on the fallback

  // disk-history lookup is keyed by the same per-card cwd: a session file written
  // in the routed repo is found there, and the fallback cwd does not see it
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const routedSessionId = CHAT_SESSION_ID_PREFIX + routed.id;
  const pre = SessionManager.create(alphaDir, sessionDir, { id: routedSessionId });
  pre.appendMessage({ role: "user", content: "hello from the routed repo", timestamp: 1 });
  expect(manager.historyFromDisk(routed.id).sessionId).toBe(routedSessionId);
  expect(manager.historyFromDisk(fallback.id).sessionId).toBeNull();

  await manager.disposeAll();
});
