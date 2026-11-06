import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatManager, type ChatSessionFactory } from "../src/chat";
import {
  CHAT_BACKEND_ENTRY,
  CLAUDE_CHAT_PROVIDER,
  ClaudeStreamMapper,
  claudeChatArgs,
  claudeChatModels,
  readBackend,
  transcriptRecap,
  type ClaudeChild,
  type ClaudeRunner,
} from "../src/claude-chat";
import { CLAUDE_MODELS } from "../src/claude";
import { KanbanDb } from "../src/db";

let dir = "";
let db: KanbanDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kanban-claude-chat-"));
  db = new KanbanDb(join(dir, "t.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const se = (event: Record<string, unknown>, parent: string | null = null) => JSON.stringify({ type: "stream_event", event, parent_tool_use_id: parent });

/** One tool round-trip then a text reply — the shape `claude -p --include-partial-messages` prints. */
const TURN = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "s" }),
  se({ type: "message_start", message: { id: "m1", model: "claude-haiku-5-5", role: "assistant", content: [] } }),
  se({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: "Bash", input: {} } }),
  se({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":' } }),
  se({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"echo hi"}' } }),
  JSON.stringify({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "echo hi" } }] }, parent_tool_use_id: null }),
  se({ type: "content_block_stop", index: 0 }),
  se({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 2, output_tokens: 7 } }),
  se({ type: "message_stop" }),
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "hi", is_error: false }] }, parent_tool_use_id: null }),
  se({ type: "message_start", message: { id: "m2", model: "claude-haiku-5-5", role: "assistant", content: [] } }),
  se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "do" } }),
  se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ne" } }),
  JSON.stringify({ type: "assistant", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "done" }] }, parent_tool_use_id: null }),
  se({ type: "content_block_stop", index: 0 }),
  se({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }),
  se({ type: "message_stop" }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }),
];

test("mapper turns stream-json into pi events and transcript messages", () => {
  const events: Record<string, any>[] = [];
  const messages: Record<string, any>[] = [];
  const mapper = new ClaudeStreamMapper("haiku", { emit: (e) => events.push(e), message: (m) => messages.push(m) }, () => 1);
  for (const line of TURN) mapper.feed(line);

  expect(mapper.sawInit).toBe(true);
  expect(mapper.result).toEqual({ isError: false, text: "done" });
  expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult", "assistant"]); // whole `assistant` dupes ignored
  expect(messages[0].content).toEqual([{ type: "toolCall", id: "tu1", name: "Bash", arguments: { command: "echo hi" } }]);
  expect(messages[0].stopReason).toBe("toolUse");
  expect(messages[0].provider).toBe(CLAUDE_CHAT_PROVIDER);
  expect(messages[1]).toMatchObject({ toolCallId: "tu1", toolName: "Bash", isError: false, content: [{ type: "text", text: "hi" }] });
  expect(messages[2].content).toEqual([{ type: "text", text: "done" }]);

  const updates = events.filter((e) => e.type === "message_update").map((e) => e.assistantMessageEvent.type);
  expect(updates).toEqual(["toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end", "text_start", "text_delta", "text_delta", "text_end"]);
  expect(events.find((e) => e.type === "tool_execution_start")).toMatchObject({ toolCallId: "tu1", toolName: "Bash" });
  expect(events.find((e) => e.type === "tool_execution_end")).toMatchObject({ toolCallId: "tu1", isError: false });
});

test("mapper falls back to whole assistant messages and skips subagent traffic", () => {
  const messages: Record<string, any>[] = [];
  const mapper = new ClaudeStreamMapper("sonnet", { emit: () => {}, message: (m) => messages.push(m) });
  mapper.feed(se({ type: "message_start", message: { id: "sub" } }, "tu9"));
  mapper.feed(JSON.stringify({ type: "assistant", message: { id: "x", content: [{ type: "text", text: "inside" }] }, parent_tool_use_id: "tu9" }));
  mapper.feed(JSON.stringify({ type: "assistant", message: { id: "y", content: [{ type: "text", text: "whole" }], stop_reason: "end_turn" }, parent_tool_use_id: null }));
  mapper.feed("not json");
  expect(mapper.current).toBeNull();
  expect(messages).toHaveLength(1);
  expect(messages[0].content).toEqual([{ type: "text", text: "whole" }]);
});

test("claude chat models follow the probe, the master switch and per-alias switches", () => {
  const probe = { id: "claude", label: "Claude Code", status: "ready" as const, detail: "v", models: CLAUDE_MODELS };
  expect(claudeChatModels(probe, true, new Set()).map((m) => m.id)).toEqual(["sonnet", "opus", "haiku"]);
  expect(claudeChatModels(probe, true, new Set(["claude:opus"])).map((m) => m.id)).toEqual(["sonnet", "haiku"]);
  expect(claudeChatModels(probe, false, new Set())).toEqual([]);
  expect(claudeChatModels({ ...probe, status: "missing" }, true, new Set())).toEqual([]);
  expect(claudeChatModels(probe, true, new Set())[0]).toMatchObject({ provider: CLAUDE_CHAT_PROVIDER, harness: "claude" });
});

test("recap keeps user/assistant text, newest last, bounded", () => {
  const entries = [
    { type: "message", message: { role: "user", content: "first question" } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "first answer" }, { type: "toolCall" }] } },
    { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "noise" }] } },
    { type: "custom", customType: "x" },
  ];
  const recap = transcriptRecap(entries);
  expect(recap).toContain("Human: first question");
  expect(recap).toContain("Assistant: first answer");
  expect(recap).not.toContain("noise");
  expect(transcriptRecap([])).toBe("");
});

test("args create the claude session first, resume it after", () => {
  const backend = { harness: "claude" as const, model: "opus", effort: "high", claudeSessionId: "u", started: false };
  const first = claudeChatArgs(backend, "sys");
  expect(first.slice(0, 3)).toEqual(["-p", "--session-id", "u"]);
  expect(first).toContain("--include-partial-messages");
  expect(first.join(" ")).toContain("--model opus --effort high");
  expect(claudeChatArgs({ ...backend, started: true }, "sys").slice(0, 3)).toEqual(["-p", "--resume", "u"]);
});

// ── manager: harness swaps over one transcript ────────────────────────────

function fakeSession() {
  let model: { provider: string; id: string } | null = null;
  return {
    subscribe: () => () => {},
    isStreaming: false,
    isCompacting: false,
    get model() {
      return model;
    },
    thinkingLevel: "off",
    getSteeringMessages: () => [] as string[],
    getFollowUpMessages: () => [] as string[],
    getAvailableThinkingLevels: () => ["off"],
    supportsThinking: () => false,
    agent: { state: {} },
    modelRuntime: { getModel: (provider: string, id: string) => ({ provider, id }) },
    setModel: async (m: { provider: string; id: string }) => {
      model = m;
    },
    setThinkingLevel: () => {},
    prompt: async () => {},
    steer: async () => "queued" as const,
    followUp: async () => "queued" as const,
    abort: async () => {},
    dispose: () => {},
  };
}

/** A runner that replays TURN and records each spawn's args + stdin. */
function fakeRunner(lines = TURN) {
  const calls: { args: string[]; stdin: string }[] = [];
  const runner: ClaudeRunner = ({ args, stdin }) => {
    calls.push({ args, stdin });
    let release: (code: number) => void = () => {};
    const exited = new Promise<number>((r) => (release = r));
    const child: ClaudeChild = {
      lines: (async function* () {
        for (const line of lines) yield line;
        release(0);
      })(),
      exited,
      stderr: Promise.resolve(""),
      kill: () => release(143),
    };
    return child;
  };
  return { runner, calls };
}

async function settle(handle: { state(): { isStreaming: boolean } }): Promise<void> {
  for (let i = 0; i < 100 && handle.state().isStreaming; i++) await Bun.sleep(5);
}

test("switching a pi chat to claude-code runs turns on claude and writes the shared transcript", async () => {
  const task = db.createTask({ title: "swap me" });
  const sessions: unknown[] = [];
  const createSession: ChatSessionFactory = async () => {
    const s = fakeSession();
    sessions.push(s);
    return s as never;
  };
  const { runner, calls } = fakeRunner();
  const manager = new ChatManager({ cwd: dir, db, sessionDir: join(dir, "s"), createSession, claudeRunner: runner, idleTimeoutMs: 0 });

  const pi = await manager.get(task.id);
  const shutdowns: unknown[] = [];
  pi.onEvent((e) => shutdowns.push(e));
  const state = await manager.setModel(task.id, CLAUDE_CHAT_PROVIDER, "haiku");
  expect(state.model).toEqual({ provider: CLAUDE_CHAT_PROVIDER, id: "haiku" });
  expect(state.thinkingLevels).toContain("xhigh");
  expect(shutdowns).toContainEqual({ type: "shutdown", reason: "switch" }); // old SSE streams close
  expect(pi.isAlive()).toBe(false);

  const claude = await manager.get(task.id);
  expect(claude).not.toBe(pi);
  const events: Record<string, any>[] = [];
  claude.onEvent((e) => events.push(e as never));
  expect(await claude.send({ type: "prompt", message: "hello" })).toEqual({ accepted: true, disposition: "started" });
  await settle(claude);

  expect(calls[0].args.slice(0, 2)).toEqual(["-p", "--session-id"]);
  expect(calls[0].stdin).toContain("hello");
  expect(calls[0].stdin).toContain(task.id); // fresh chat: the card seed rides the first prompt
  expect(events.at(-1)?.type).toBe("agent_end");
  const roles = claude.state().messages.map((m) => m.role);
  expect(roles).toEqual(["user", "assistant", "toolResult", "assistant"]);

  // second turn resumes claude's session
  await claude.send({ type: "prompt", message: "again" });
  await settle(claude);
  expect(calls[1].args.slice(0, 2)).toEqual(["-p", "--resume"]);

  // and back to pi: a new pi session over the same transcript, model applied
  const back = await manager.setModel(task.id, "anthropic", "claude-sonnet");
  expect(back.model).toEqual({ provider: "anthropic", id: "claude-sonnet" });
  expect(back.messages.filter((m) => m.role === "assistant")).toHaveLength(4);
  expect(sessions).toHaveLength(2);
  await manager.disposeAll();

  // a fresh manager reopening the file resumes on pi (latest backend entry)
  const reopened = new ChatManager({ cwd: dir, db, sessionDir: join(dir, "s"), createSession, claudeRunner: runner, idleTimeoutMs: 0 });
  const h = await reopened.get(task.id);
  expect(h.state().model?.provider).not.toBe(CLAUDE_CHAT_PROVIDER);
  await reopened.disposeAll();
});

test("a chat parked on claude resumes there; the off switch falls back to pi", async () => {
  const task = db.createTask({ title: "park" });
  const createSession: ChatSessionFactory = async () => fakeSession() as never;
  const { runner } = fakeRunner();
  const opts = { cwd: dir, db, sessionDir: join(dir, "s"), createSession, claudeRunner: runner, idleTimeoutMs: 0 };
  const manager = new ChatManager(opts);
  await manager.setModel(task.id, CLAUDE_CHAT_PROVIDER, "opus");
  const h = await manager.get(task.id);
  await h.send({ type: "prompt", message: "hi" });
  await settle(h);
  await manager.disposeAll();

  const again = new ChatManager(opts);
  const resumed = await again.get(task.id);
  expect(resumed.state().model).toEqual({ provider: CLAUDE_CHAT_PROVIDER, id: "opus" });
  await again.disposeAll();

  db.setHarnessEnabled("claude", false);
  const off = new ChatManager(opts);
  expect((await off.get(task.id)).state().model?.provider).not.toBe(CLAUDE_CHAT_PROVIDER);
  await expect(off.setModel(task.id, CLAUDE_CHAT_PROVIDER, "opus")).rejects.toThrow(/switched off/);
  await off.disposeAll();
});

test("a fresh chat seeds on a claude engine at the head of the manager lineup", async () => {
  db.setEngine("sonnet", { name: "Sonnet", harness: "claude", model: "sonnet", thinking: "high" });
  db.setDefaultEngine("sonnet");
  const task = db.createTask({ title: "seed" });
  const { runner } = fakeRunner();
  const manager = new ChatManager({ cwd: dir, db, createSession: async () => fakeSession() as never, claudeRunner: runner, idleTimeoutMs: 0 });
  const h = await manager.get(task.id);
  expect(h.state().model).toEqual({ provider: CLAUDE_CHAT_PROVIDER, id: "sonnet" });
  expect(h.state().thinkingLevel).toBe("high");
  await manager.disposeAll();
});

test("prompt while claude runs conflicts; followUp queues and drains as the next turn", async () => {
  const task = db.createTask({ title: "queue" });
  const gate: { open?: () => void } = {};
  const calls: string[] = [];
  const runner: ClaudeRunner = ({ stdin }) => {
    calls.push(stdin);
    let release: (code: number) => void = () => {};
    const exited = new Promise<number>((r) => (release = r));
    const wait = calls.length === 1 ? new Promise<void>((r) => (gate.open = r)) : Promise.resolve();
    return {
      lines: (async function* () {
        await wait;
        for (const line of TURN) yield line;
        release(0);
      })(),
      exited,
      stderr: Promise.resolve(""),
      kill: () => release(143),
    };
  };
  const manager = new ChatManager({ cwd: dir, db, createSession: async () => fakeSession() as never, claudeRunner: runner, idleTimeoutMs: 0 });
  await manager.setModel(task.id, CLAUDE_CHAT_PROVIDER, "sonnet");
  const h = await manager.get(task.id);
  await h.send({ type: "prompt", message: "one" });
  await expect(h.send({ type: "prompt", message: "two" })).rejects.toThrow(/streaming/);
  expect(await h.send({ type: "prompt", message: "two", streamingBehavior: "steer" })).toEqual({ accepted: true, disposition: "queued" });
  expect(h.state().queued.followUp).toEqual(["two"]);
  await expect(manager.setModel(task.id, "anthropic", "x")).rejects.toThrow(/streaming/);
  gate.open?.();
  await Bun.sleep(20);
  await settle(h);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toBe("two");
  await manager.disposeAll();
});

test("a failed claude run lands as an error message", async () => {
  const task = db.createTask({ title: "fail" });
  const { runner } = fakeRunner([JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" })]);
  const manager = new ChatManager({ cwd: dir, db, createSession: async () => fakeSession() as never, claudeRunner: runner, idleTimeoutMs: 0 });
  await manager.setModel(task.id, CLAUDE_CHAT_PROVIDER, "haiku");
  const h = await manager.get(task.id);
  await h.send({ type: "prompt", message: "x" });
  await settle(h);
  const last = h.state().messages.at(-1);
  expect(last).toMatchObject({ role: "assistant", stopReason: "error", errorMessage: "boom" });
  await manager.disposeAll();
});

test("readBackend reads the latest backend entry", async () => {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const sm = SessionManager.create(dir, join(dir, "s"), { id: "x" });
  expect(readBackend(sm)).toBeNull();
  sm.appendCustomEntry(CHAT_BACKEND_ENTRY, { harness: "claude", model: "opus", claudeSessionId: "u", started: true });
  expect(readBackend(sm)).toMatchObject({ harness: "claude", model: "opus", started: true });
  sm.appendCustomEntry(CHAT_BACKEND_ENTRY, { harness: "pi" });
  expect(readBackend(sm)).toEqual({ harness: "pi" });
});
