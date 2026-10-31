import { afterEach, beforeEach, expect, test } from "bun:test";
import { chat } from "../web/src/lib/chat.svelte";
import type { ChatMessage } from "../src/chat";
import type { Task } from "../src/db";

// ── fakes ────────────────────────────────────────────────────────────────────

let fetchCalls: Array<{ method: string; path: string; body?: unknown }> = [];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Serves GET/POST /chat/:id from a mutable state object; records every call. */
function mockChatFetch(state: { get: Record<string, unknown>; postStatus?: number; postBody?: unknown }) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    fetchCalls.push({ method, path: url.pathname, body });
    if (method === "GET" && url.pathname.startsWith("/chat/")) {
      const cardId = url.pathname.split("/")[2];
      return jsonResponse(200, state.get[cardId] ?? emptyChatState());
    }
    if (method === "POST" && url.pathname.startsWith("/chat/")) {
      if (state.postStatus !== undefined) return jsonResponse(state.postStatus, state.postBody);
      return jsonResponse(200, body?.type === "abort" ? { stopped: true } : { accepted: true, disposition: "started" });
    }
    return jsonResponse(404, { error: "not found", code: "not-found" });
  };
}

function emptyChatState() {
  return {
    running: false,
    sessionId: null,
    isStreaming: false,
    isCompacting: false,
    queued: { steering: [], followUp: [] },
    model: { provider: "zai", id: "glm-5.3" },
    thinkingLevel: "off",
    messages: [],
    messagesTruncated: false,
  };
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  emit(event: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  fail(): void {
    this.onerror?.();
  }
}

let originalFetch: typeof globalThis.fetch | undefined;
let originalEventSource: unknown;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalEventSource = (globalThis as any).EventSource;
  fetchCalls = [];
  FakeEventSource.instances = [];
  (globalThis as any).fetch = mockChatFetch({ get: {} });
  (globalThis as any).EventSource = FakeEventSource;
  chat.close();
});

afterEach(() => {
  chat.close();
  (globalThis as any).fetch = originalFetch;
  (globalThis as any).EventSource = originalEventSource;
  for (const key of ["fetch", "EventSource"]) {
    if ((globalThis as any)[key] === undefined) delete (globalThis as any)[key];
  }
});

const HISTORY: ChatMessage[] = [
  { role: "user", content: "hello", entryId: "e1" },
  { role: "assistant", blocks: [{ type: "text", text: "hi there" }], entryId: "e2" },
];

function stateWith(messages: ChatMessage[], isStreaming = false) {
  return { ...emptyChatState(), messages, isStreaming };
}

test("open loads history and connects; deltas build the streaming message; message_end finalizes", async () => {
  (globalThis as any).fetch = mockChatFetch({ get: { t1: stateWith(HISTORY) } });

  await chat.open("t1");
  expect(chat.openCardId).toBe("t1");
  expect(chat.messages).toEqual(HISTORY);
  expect(chat.modelLabel).toBe("zai/glm-5.3");
  const source = FakeEventSource.instances[0];
  expect(source.url.endsWith("/chat/t1/events")).toBe(true);
  expect(chat.status).toBe("connecting"); // ready only once the stream says connected
  source.emit({ type: "connected", isStreaming: false });
  expect(chat.status).toBe("ready");

  // assistant message_start resets the streaming message with the received blocks
  source.emit({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "" }] } });
  expect(chat.streaming.isStreaming).toBe(true);
  expect(chat.streaming.streamingMessage?.content).toEqual([{ type: "text", text: "" }]);

  source.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "stream" } });
  source.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "ing" } });
  expect(chat.streaming.streamingMessage?.content[0]).toEqual({ type: "text", text: "streaming" });

  // message_end is authoritative: finalizes into messages and clears streaming
  source.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "streaming" }] } });
  expect(chat.messages.length).toBe(3);
  const finalized = chat.messages[2];
  if (finalized.role !== "assistant") throw new Error("expected assistant");
  expect(finalized.blocks).toEqual([{ type: "text", text: "streaming" }]);
  expect(chat.streaming.isStreaming).toBe(false);
  expect(chat.streaming.streamingMessage).toBeNull();

  // tool calls track through tools; non-assistant starts are ignored
  source.emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: {} });
  source.emit({ type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", partialResult: "out" });
  expect(chat.tools.get("call-1")).toMatchObject({ toolName: "bash", partial: "out" });
  source.emit({ type: "agent_end", messages: [] });
  expect(chat.streaming.isStreaming).toBe(false);
  expect(chat.tools.size).toBe(0);
});

test("message_end normalizes legacy toolCall blocks, caps thinking, and appends toolResult rows", async () => {
  (globalThis as any).fetch = mockChatFetch({ get: {} });
  await chat.open("t1");
  const source = FakeEventSource.instances[0];

  // The wire forwards SDK blocks verbatim (legacy id/name/arguments spellings included).
  source.emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "x".repeat(3000) },
        { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
      ],
    },
  });
  const finalized = chat.messages[0];
  if (finalized.role !== "assistant") throw new Error("expected assistant");
  expect(finalized.blocks).toEqual([
    { type: "thinking", thinking: "x".repeat(2000), truncated: true },
    { type: "toolCall", toolCallId: "c1", toolName: "bash", input: { command: "ls" } },
  ]);

  // toolResult message_end appends its ✓/✗ activity row instead of being dropped.
  source.emit({ type: "message_end", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: true } });
  expect(chat.messages[1]).toEqual({
    role: "toolResult",
    toolCallId: "c1",
    toolName: "bash",
    isError: true,
    entryId: expect.any(String),
  });
});

test("tools map is reactive: start/update/end re-run effects (copy-on-write, not in-place mutation)", async () => {
  (globalThis as any).fetch = mockChatFetch({ get: {} });
  await chat.open("t1");
  const source = FakeEventSource.instances[0];
  const $ = await import("svelte/internal/client");
  const sizes: number[] = [];
  const stop = $.effect_root(() => {
    $.user_effect(() => {
      sizes.push(chat.tools.size);
    });
  });
  $.flush();

  source.emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash" });
  $.flush();
  expect(chat.tools.size).toBe(1);
  expect(sizes).toEqual([0, 1]); // an in-place Map.set would leave this at [0]

  source.emit({ type: "tool_execution_update", toolCallId: "c1", toolName: "bash", partialResult: "out" });
  expect(chat.tools.get("c1")).toMatchObject({ toolName: "bash", partial: "out" });

  source.emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", isError: false });
  await Bun.sleep(1_100); // the end row lingers 1s, then drops
  $.flush();
  expect(chat.tools.size).toBe(0);
  expect(sizes.at(-1)).toBe(0);
  stop();
});

test("send posts via the api, appends the user message optimistically; stop posts abort", async () => {
  (globalThis as any).fetch = mockChatFetch({ get: { t1: stateWith(HISTORY) } });
  await chat.open("t1");
  const before = fetchCalls.length;

  await chat.send("do the thing");
  const post = fetchCalls.slice(before).find((c) => c.method === "POST");
  expect(post).toMatchObject({ path: "/chat/t1", body: { type: "prompt", message: "do the thing" } });
  expect(chat.messages.at(-1)).toEqual({ role: "user", content: "do the thing", entryId: expect.any(String) });

  const stopBefore = fetchCalls.length;
  await chat.stop();
  expect(fetchCalls[stopBefore]).toMatchObject({ path: "/chat/t1", body: { type: "abort" } });
});

test("send adds streamingBehavior steer while streaming; a 409 sets error and keeps history clean", async () => {
  (globalThis as any).fetch = mockChatFetch({ get: { t1: stateWith(HISTORY) } });
  await chat.open("t1");
  const source = FakeEventSource.instances[0];
  source.emit({ type: "connected", isStreaming: false });

  source.emit({ type: "message_start", message: { role: "assistant", content: [] } });
  const before = fetchCalls.length;
  await chat.send("interrupt");
  const post = fetchCalls.slice(before).find((c) => c.method === "POST");
  expect(post?.body).toEqual({ type: "prompt", message: "interrupt", streamingBehavior: "steer" });
  source.emit({ type: "agent_end", messages: [] });

  // 409: the refusal surfaces verbatim, the optimistic append is rolled back
  (globalThis as any).fetch = mockChatFetch({
    get: { t1: stateWith(HISTORY) },
    postStatus: 409,
    postBody: { error: "chat is streaming — send steer or followUp", code: "conflict" },
  });
  await chat.send("refused");
  expect(chat.error).toBe("chat is streaming — send steer or followUp");
  expect(chat.messages.some((m) => m.role === "user" && m.content === "refused")).toBe(false);
});

test("stream error triggers a resnapshot and reconnect", async () => {
  const getState = stateWith(HISTORY);
  (globalThis as any).fetch = mockChatFetch({ get: { t1: getState } });
  await chat.open("t1");
  expect(FakeEventSource.instances.length).toBe(1);
  const getsBefore = fetchCalls.filter((c) => c.method === "GET").length;

  FakeEventSource.instances[0].emit({ type: "connected", isStreaming: false });
  FakeEventSource.instances[0].fail(); // the backlog terminator or a dead socket
  await Bun.sleep(20); // reconnect is async: GET again + new EventSource
  expect(fetchCalls.filter((c) => c.method === "GET").length).toBe(getsBefore + 1);
  expect(FakeEventSource.instances.length).toBe(2);
  expect(chat.messages).toEqual(HISTORY); // rebuilt from the resnapshot
  expect(chat.status).toBe("connecting"); // new source not yet connected
});

test("close resets every field and detaches the source", async () => {
  (globalThis as any).fetch = mockChatFetch({ get: { t1: stateWith(HISTORY) } });
  await chat.open("t1");
  const source = FakeEventSource.instances[0];

  chat.close();
  expect(source.closed).toBe(true);
  expect(chat.openCardId).toBeNull();
  expect(chat.status).toBe("idle");
  expect(chat.messages).toEqual([]);
  expect(chat.streaming.isStreaming).toBe(false);
  expect(chat.tools.size).toBe(0);
  expect(chat.modelLabel).toBe("");
});

// ── source contracts (panel wiring) ─────────────────────────────────────────

import { readFileSync } from "node:fs";
import { join } from "node:path";

const taskDetailSource = readFileSync(join(import.meta.dir, "..", "web", "src", "lib", "TaskDetail.svelte"), "utf-8");
const chatPanelSource = readFileSync(join(import.meta.dir, "..", "web", "src", "lib", "ChatPanel.svelte"), "utf-8");

test("TaskDetail mounts ChatPanel between agent sessions and the thread; opens on first expand", () => {
  const sessionsIdx = taskDetailSource.indexOf('class="detail-plan agent-sessions"');
  const chatIdx = taskDetailSource.indexOf('class="detail-plan chat-section"');
  const panelIdx = taskDetailSource.indexOf("<ChatPanel />");
  const commentsIdx = taskDetailSource.indexOf('class="detail-comments"');
  expect(sessionsIdx).toBeGreaterThan(-1);
  expect(chatIdx).toBeGreaterThan(sessionsIdx);
  expect(panelIdx).toBeGreaterThan(chatIdx);
  expect(commentsIdx).toBeGreaterThan(panelIdx);
  expect(taskDetailSource).toContain("chat.open(me.id)");
});

test("ChatPanel wires send/stop and carries no gate verbs", () => {
  expect(chatPanelSource).toContain("chat.send(");
  expect(chatPanelSource).toContain("chat.stop(");
  expect(chatPanelSource).toContain('aria-label="chat message"');
  for (const banned of ["approve", "reject", "moveTask", "toLane"]) {
    expect(chatPanelSource).not.toContain(banned);
  }
});
