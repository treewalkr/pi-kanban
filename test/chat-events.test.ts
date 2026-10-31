import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CHAT_EVENT_HEARTBEAT_MS,
  TOOL_UPDATE_COALESCE_MS,
  createChatEventStream,
  toChatClientEvent,
  type ChatStreamSession,
} from "../src/chat-events";
import type { SdkChatEvent } from "../src/chat";

const decoder = new TextDecoder();

function deferred() {
  let resolve!: (value: ChatStreamSession) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<ChatStreamSession>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function readWithin(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 1_000) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out reading SSE chunk")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function decodeData(chunk: Awaited<ReturnType<typeof readWithin>>): Record<string, unknown> {
  if (chunk.done || chunk.value === undefined) throw new Error("stream closed early");
  const text = decoder.decode(chunk.value);
  expect(text.startsWith("data: ")).toBe(true);
  return JSON.parse(text.slice("data: ".length));
}

function fakeStreamSession(overrides: Partial<ChatStreamSession> & { onEvent: ChatStreamSession["onEvent"] }): ChatStreamSession {
  return { isStreaming: false, streamingMessage: undefined, ...overrides } as ChatStreamSession;
}

async function connectedStream(sessionId: string) {
  const abortController = new AbortController();
  let listener!: (event: SdkChatEvent) => void;
  const stream = createChatEventStream(
    new Request("http://localhost/chat", { signal: abortController.signal }),
    Promise.resolve(
      fakeStreamSession({
        isStreaming: true,
        onEvent(nextListener) {
          listener = nextListener as (event: SdkChatEvent) => void;
          return () => {};
        },
      }),
    ),
  );
  const reader = stream.getReader();
  expect(decoder.decode((await readWithin(reader)).value)).toBe(":\n\n");
  expect(decodeData(await readWithin(reader))).toEqual({ type: "connected", isStreaming: true });
  return { reader, listener, abortController };
}

function afterCoalesceWindow(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, TOOL_UPDATE_COALESCE_MS * 2));
}

const BIG_PAYLOAD = "x".repeat(30_000);

function toolUpdate(toolCallId = "call-1", partialResult: unknown = BIG_PAYLOAD): SdkChatEvent {
  return { type: "tool_execution_update", toolCallId, toolName: "bash", args: {}, partialResult } as SdkChatEvent;
}

/** Non-droppable, so it always survives and marks the end of the queued batch. */
function sentinelEvent(): SdkChatEvent {
  return { type: "agent_end", messages: [] } as unknown as SdkChatEvent;
}

describe("chat event stream (SSE backpressure port)", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ["KANBAN_CHAT_SSE_BACKLOG_LIMIT_BYTES", "KANBAN_CHAT_SSE_HEARTBEAT_MS"];

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  test("opens the transport before a slow session is ready and snapshots after subscribing", async () => {
    const startup = deferred();
    const abortController = new AbortController();
    const stream = createChatEventStream(new Request("http://localhost/chat", { signal: abortController.signal }), startup.promise);
    const reader = stream.getReader();

    expect(decoder.decode((await readWithin(reader)).value)).toBe(":\n\n");

    const snapshot = { role: "assistant", content: [{ type: "text", text: "Hello" }] };
    let subscribeCount = 0;
    let unsubscribeCount = 0;
    let listener!: (event: SdkChatEvent) => void;
    startup.resolve(
      fakeStreamSession({
        isStreaming: true,
        streamingMessage: snapshot,
        onEvent(nextListener) {
          subscribeCount += 1;
          listener = nextListener as (event: SdkChatEvent) => void;
          // Included in the snapshot: dropped after connect, not replayed twice.
          listener({ type: "message_update", message: snapshot, assistantMessageEvent: { type: "text_delta", delta: "ignored" } } as SdkChatEvent);
          listener({ type: "agent_start" } as SdkChatEvent);
          return () => {
            unsubscribeCount += 1;
          };
        },
      }),
    );

    expect(decodeData(await readWithin(reader))).toEqual({ type: "connected", isStreaming: true });
    const agentStart = decodeData(await readWithin(reader));
    const messageStart = decodeData(await readWithin(reader));
    expect(subscribeCount).toBe(1);
    expect(agentStart).toEqual({ type: "agent_start" });
    expect(messageStart).toEqual({ type: "message_start", message: snapshot });

    listener({ type: "message_update", message: { ...snapshot }, assistantMessageEvent: { type: "text_delta", delta: "!", partial: { ...snapshot } } } as SdkChatEvent);
    expect(decodeData(await readWithin(reader))).toEqual({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "!" },
    });

    abortController.abort();
    expect(unsubscribeCount).toBe(1);
    expect((await readWithin(reader)).done).toBe(true);
  });

  test("reports a startup failure in-band after opening the transport", async () => {
    const stream = createChatEventStream(new Request("http://localhost/chat"), Promise.reject(new Error("broken config")));
    const reader = stream.getReader();

    expect(decoder.decode((await readWithin(reader)).value)).toBe(":\n\n");
    expect(decodeData(await readWithin(reader))).toEqual({
      type: "startup_error",
      errorMessage: "Failed to start chat session: broken config",
    });
    expect((await readWithin(reader)).done).toBe(true);
  });

  test("does not subscribe when the client cancels during startup", async () => {
    const startup = deferred();
    let subscribeCount = 0;
    const stream = createChatEventStream(
      new Request("http://localhost/chat"),
      startup.promise,
    );
    const reader = stream.getReader();

    await readWithin(reader);
    await reader.cancel();
    startup.resolve(
      fakeStreamSession({
        onEvent() {
          subscribeCount += 1;
          return () => {};
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(subscribeCount).toBe(0);
  });

  test("a shutdown event from a live session closes the stream", async () => {
    const abortController = new AbortController();
    const { reader, listener } = await connectedStream("shutdown");
    void abortController;
    listener({ type: "shutdown", reason: "server" } as SdkChatEvent);
    expect((await readWithin(reader)).done).toBe(true);
  });

  test("does not subscribe when the session died before the snapshot", async () => {
    let subscribeCount = 0;
    const stream = createChatEventStream(
      new Request("http://localhost/chat"),
      Promise.resolve(
        fakeStreamSession({
          isAlive: () => false,
          onEvent() {
            subscribeCount += 1;
            return () => {};
          },
        }),
      ),
    );
    const reader = stream.getReader();
    expect(decoder.decode((await readWithin(reader)).value)).toBe(":\n\n"); // transport opened first
    expect((await readWithin(reader)).done).toBe(true);
    expect(subscribeCount).toBe(0);
  });

  test("closes an already-aborted request and survives a later startup rejection", async () => {
    const abortController = new AbortController();
    abortController.abort();
    const stream = createChatEventStream(
      new Request("http://localhost/chat", { signal: abortController.signal }),
      Promise.reject(new Error("startup failed after disconnect")),
    );
    expect((await readWithin(stream.getReader())).done).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  test("terminates the stream when an unread, non-rebuildable backlog exceeds the limit", async () => {
    process.env.KANBAN_CHAT_SSE_BACKLOG_LIMIT_BYTES = String(64 * 1024);
    const { reader, listener } = await connectedStream("backlog");

    // Stop reading: message snapshots cannot be rebuilt client-side, so they hit
    // the hard limit instead of being dropped.
    const message = { role: "assistant", content: [{ type: "text", text: BIG_PAYLOAD }] };
    for (let index = 0; index < 8; index += 1) {
      listener({ type: "message_start", message } as SdkChatEvent);
    }

    let queuedChunks = 0;
    const drain = async () => {
      for (;;) {
        const next = await readWithin(reader);
        if (next.done) return;
        queuedChunks += 1;
        expect(queuedChunks).toBeLessThan(8);
      }
    };
    await expect(drain()).rejects.toThrow(/client backlog exceeded/);
  });

  test("drops rebuildable deltas while the client is behind instead of disconnecting it", async () => {
    process.env.KANBAN_CHAT_SSE_BACKLOG_LIMIT_BYTES = String(8 * 1024 * 1024);
    const { reader, listener, abortController } = await connectedStream("behind");

    // Updates of different tool calls survive coalescing and are written in one flush.
    const emitted = 60;
    for (let index = 0; index < emitted; index += 1) listener(toolUpdate(`call-${index}`));
    await afterCoalesceWindow();
    listener(sentinelEvent());

    // Whatever was queued before the water mark is still delivered…
    let delivered = 0;
    let sawSentinel = false;
    while (!sawSentinel) {
      const next = await readWithin(reader);
      expect(next.done).toBe(false);
      const event = decodeData(next);
      if (event.type === "agent_end") sawSentinel = true;
      else delivered += 1;
    }
    expect(delivered > 0 && delivered < emitted).toBe(true);

    // …and the stream stays usable once the client catches up.
    listener(toolUpdate());
    const afterCatchUp = await readWithin(reader);
    expect(afterCatchUp.done).toBe(false);
    expect(decodeData(afterCatchUp).type).toBe("tool_execution_update");
    abortController.abort();
  });

  test("keeps the start and end of a streamed block while dropping its deltas", async () => {
    process.env.KANBAN_CHAT_SSE_BACKLOG_LIMIT_BYTES = String(8 * 1024 * 1024);
    const { reader, listener, abortController } = await connectedStream("block");

    const update = (assistantMessageEvent: Record<string, unknown>) =>
      ({ type: "message_update", message: { role: "assistant", content: [] }, assistantMessageEvent }) as unknown as SdkChatEvent;

    listener(update({ type: "text_start", contentIndex: 0 }));
    for (let index = 0; index < 60; index += 1) {
      listener(update({ type: "text_delta", contentIndex: 0, delta: BIG_PAYLOAD }));
    }
    // The client's reducer replaces the block with this content, repairing any dropped delta.
    listener(update({ type: "text_end", contentIndex: 0, content: "final text" }));
    listener(sentinelEvent());

    const kinds: string[] = [];
    for (;;) {
      const event = decodeData(await readWithin(reader));
      if (event.type === "agent_end") break;
      kinds.push((event.assistantMessageEvent as { type: string }).type);
    }
    expect(kinds[0]).toBe("text_start");
    expect(kinds.at(-1)).toBe("text_end");
    expect(kinds.length < 62).toBe(true);
    abortController.abort();
  });

  test("delivers every update to a client that reads promptly", async () => {
    const { reader, listener, abortController } = await connectedStream("prompt");
    for (let index = 0; index < 5; index += 1) {
      listener(toolUpdate("call-1", `${index}:${BIG_PAYLOAD}`));
      const next = await readWithin(reader);
      expect(next.done).toBe(false);
      const event = decodeData(next);
      expect(event.type).toBe("tool_execution_update");
      expect(event.partialResult).toBe(`${index}:${BIG_PAYLOAD}`);
    }
    abortController.abort();
  });

  test("coalesces a burst of tool updates into the latest one per tool call", async () => {
    const { reader, listener, abortController } = await connectedStream("coalesce");

    for (let index = 0; index < 50; index += 1) {
      if (index % 10 === 0) {
        listener({
          type: "tool_execution_start",
          toolCallId: `call-codemode/${index + 1}`,
          toolName: "read",
          args: { path: `file-${index}` },
          parentToolCallId: "call-codemode",
        } as SdkChatEvent);
        // The nested call's own progress never reaches the client.
        listener({ ...toolUpdate(`call-codemode/${index + 1}`, `nested ${index}`), toolName: "read", parentToolCallId: "call-codemode" } as unknown as SdkChatEvent);
      }
      listener({ ...toolUpdate("call-codemode", `snapshot ${index}`), toolName: "codemode" } as unknown as SdkChatEvent);
    }
    listener(toolUpdate("call-bash", "bash tail"));

    // Starts are never held back for the updates around them.
    const starts = [];
    for (let index = 0; index < 5; index += 1) starts.push(decodeData(await readWithin(reader)));
    expect(starts.map((event) => event.toolCallId)).toEqual([
      "call-codemode/1",
      "call-codemode/11",
      "call-codemode/21",
      "call-codemode/31",
      "call-codemode/41",
    ]);
    expect(starts[0]).toEqual({
      type: "tool_execution_start",
      toolCallId: "call-codemode/1",
      toolName: "read",
      parentToolCallId: "call-codemode",
    });

    const updates = [decodeData(await readWithin(reader)), decodeData(await readWithin(reader))];
    expect(updates.map((event) => [event.type, event.toolCallId, event.partialResult])).toEqual([
      ["tool_execution_update", "call-codemode", "snapshot 49"],
      ["tool_execution_update", "call-bash", "bash tail"],
    ]);

    await afterCoalesceWindow();
    listener(sentinelEvent());
    expect(decodeData(await readWithin(reader))).toEqual({ type: "agent_end" });
    abortController.abort();
  });

  test("never delivers a tool update after that tool call's end", async () => {
    const { reader, listener, abortController } = await connectedStream("end-before-update");

    listener(toolUpdate("call-1", "partial"));
    listener(toolUpdate("call-2", "still running"));
    listener({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: BIG_PAYLOAD }] },
      isError: false,
    } as SdkChatEvent);

    expect(decodeData(await readWithin(reader))).toEqual({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "bash",
      isError: false,
    });
    // Only the ended call's pending update is discarded.
    const other = decodeData(await readWithin(reader));
    expect(other.toolCallId).toBe("call-2");
    expect(other.partialResult).toBe("still running");

    await afterCoalesceWindow();
    listener(sentinelEvent());
    expect(decodeData(await readWithin(reader))).toEqual({ type: "agent_end" });
    abortController.abort();
  });

  test("discards pending tool updates when the run ends", async () => {
    const { reader, listener, abortController } = await connectedStream("run-end");

    listener(toolUpdate("call-1", "no end ever came"));
    listener(sentinelEvent());
    expect(decodeData(await readWithin(reader))).toEqual({ type: "agent_end" });

    await afterCoalesceWindow();
    listener({ type: "agent_settled", aborted: false } as SdkChatEvent);
    expect(decodeData(await readWithin(reader))).toEqual({ type: "agent_settled", aborted: false });
    abortController.abort();
  });

  test("replays a running tool's start and latest update after the snapshot", async () => {
    const abortController = new AbortController();
    const stream = createChatEventStream(
      new Request("http://localhost/chat", { signal: abortController.signal }),
      Promise.resolve(
        fakeStreamSession({
          isStreaming: true,
          onEvent(listener) {
            // The manager's onEvent replays active tool calls synchronously.
            listener({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "make" } } as SdkChatEvent);
            listener(toolUpdate("call-1", "latest output"));
            return () => {};
          },
        }),
      ),
    );
    const reader = stream.getReader();
    await readWithin(reader);

    expect(decodeData(await readWithin(reader)).type).toBe("connected");
    expect(decodeData(await readWithin(reader))).toEqual({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "make" },
    });
    expect(decodeData(await readWithin(reader))).toEqual({
      type: "tool_execution_update",
      toolCallId: "call-1",
      toolName: "bash",
      partialResult: "latest output",
    });
    abortController.abort();
  });

  test("replays activeToolEvents for sessions whose onEvent does not replay", async () => {
    const abortController = new AbortController();
    const active = { type: "tool_execution_start", toolCallId: "call-9", toolName: "read", args: {} } as SdkChatEvent;
    const stream = createChatEventStream(
      new Request("http://localhost/chat", { signal: abortController.signal }),
      Promise.resolve(
        fakeStreamSession({
          isStreaming: true,
          onEvent: () => () => {},
          activeToolEvents: () => [active],
        }),
      ),
    );
    const reader = stream.getReader();
    await readWithin(reader);
    expect(decodeData(await readWithin(reader)).type).toBe("connected");
    expect(decodeData(await readWithin(reader))).toEqual({
      type: "tool_execution_start",
      toolCallId: "call-9",
      toolName: "read",
      args: {},
    });
    abortController.abort();
  });

  test("reconnect snapshots and live completions omit signatures without changing the snapshot", async () => {
    const abortController = new AbortController();
    const snapshot = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "思考🙂", thinkingSignature: "opaque-provider-state" },
        { type: "text", text: "回答", textSignature: "message-id" },
      ],
    };
    const original = JSON.stringify(snapshot);
    let listener!: (event: SdkChatEvent) => void;
    let unsubscribed = false;
    const stream = createChatEventStream(
      new Request("http://localhost/chat", { signal: abortController.signal }),
      Promise.resolve(
        fakeStreamSession({
          isStreaming: true,
          streamingMessage: snapshot,
          onEvent(nextListener) {
            listener = nextListener as (event: SdkChatEvent) => void;
            listener({ type: "message_start", message: snapshot } as SdkChatEvent);
            return () => {
              unsubscribed = true;
            };
          },
        }),
      ),
    );
    const reader = stream.getReader();
    await readWithin(reader);
    expect(decodeData(await readWithin(reader)).type).toBe("connected");
    const displayMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "思考🙂" },
        { type: "text", text: "回答" },
      ],
    };
    expect(decodeData(await readWithin(reader))).toEqual({ type: "message_start", message: displayMessage });
    listener({ type: "message_end", message: snapshot } as SdkChatEvent);
    expect(decodeData(await readWithin(reader))).toEqual({ type: "message_end", message: displayMessage });
    expect(JSON.stringify(snapshot)).toBe(original);
    abortController.abort();
    expect(unsubscribed).toBe(true);
    expect((await readWithin(reader)).done).toBe(true);
  });

  test("sends a heartbeat data event the browser's EventSource can see", async () => {
    process.env.KANBAN_CHAT_SSE_HEARTBEAT_MS = "50";
    const { reader, abortController } = await connectedStream("heartbeat");
    await Bun.sleep(120);
    expect(decodeData(await readWithin(reader))).toEqual({ type: "heartbeat" });
    expect(CHAT_EVENT_HEARTBEAT_MS).toBe(30_000);
    abortController.abort();
  });

  test("reconnect snapshot replays activeToolEvents plus the streaming message exactly once", async () => {
    const abortController = new AbortController();
    const snapshot = { role: "assistant", content: [{ type: "text", text: "partial" }] };
    const active = { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: {} } as SdkChatEvent;
    const stream = createChatEventStream(
      new Request("http://localhost/chat", { signal: abortController.signal }),
      Promise.resolve(
        fakeStreamSession({
          isStreaming: true,
          streamingMessage: snapshot,
          onEvent(listener) {
            listener({ type: "message_start", message: snapshot } as SdkChatEvent); // replayed, but snapshot-included
            listener(active);
            return () => {};
          },
          activeToolEvents: () => [active],
        }),
      ),
    );
    const reader = stream.getReader();
    await readWithin(reader);
    expect(decodeData(await readWithin(reader)).type).toBe("connected");
    // The buffered message_start is snapshot-included and dropped; the active tool start is
    // forwarded once (the activeToolEvents copy is identity-deduped), then the snapshot.
    expect(decodeData(await readWithin(reader))).toEqual(active);
    expect(decodeData(await readWithin(reader))).toEqual({ type: "message_start", message: snapshot });
    abortController.abort();
  });
});

describe("chat event wire projection", () => {
  test("drops turns, entry payloads, and system messages", () => {
    expect(toChatClientEvent({ type: "turn_start" })).toBeNull();
    expect(toChatClientEvent({ type: "turn_end", message: {}, toolResults: [] })).toBeNull();
    expect(toChatClientEvent({ type: "entry_appended", entry: { big: true } })).toBeNull();
    expect(toChatClientEvent({ type: "message_start", message: { role: "system", content: "loadout" } })).toBeNull();
    expect(toChatClientEvent({ type: "message_end", message: { role: "system", content: "loadout" } })).toBeNull();
  });

  test("slims non-assistant message starts to the role; passes their ends through", () => {
    expect(toChatClientEvent({ type: "message_start", message: { role: "user", content: "secret body" } })).toEqual({
      type: "message_start",
      message: { role: "user" },
    });
    const resultEnd = { type: "message_end", message: { role: "toolResult", toolCallId: "c1", content: [] } };
    expect(toChatClientEvent(resultEnd)).toEqual(resultEnd); // the client renders tool results from this
  });

  test("strips signatures from assistant messages without mutating them", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm", thinkingSignature: "sig" },
        { type: "text", text: "hi", textSignature: "sig2" },
        { type: "toolCall", id: "c1", name: "bash", arguments: {}, thoughtSignature: "sig3" },
      ],
    };
    const projected = toChatClientEvent({ type: "message_end", message }) as unknown as { message: { content: Array<Record<string, unknown>> } };
    expect(projected.message.content[0]).toEqual({ type: "thinking", thinking: "hmm" });
    expect(projected.message.content[1]).toEqual({ type: "text", text: "hi" });
    expect(projected.message.content[2]).toEqual({ type: "toolCall", id: "c1", name: "bash", arguments: {} });
    expect((message.content[0] as { thinkingSignature?: string }).thinkingSignature).toBe("sig");
  });

  test("message_update drops partial and inlines toolcall metadata", () => {
    const projected = toChatClientEvent({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: "{\"command\":",
        partial: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }] },
      },
    }) as unknown as { assistantMessageEvent: Record<string, unknown> };
    expect(projected.assistantMessageEvent).toEqual({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: "{\"command\":",
      id: "c1",
      toolName: "bash",
    });

    const plainDelta = toChatClientEvent({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hi", partial: { role: "assistant", content: [] } },
    }) as unknown as { assistantMessageEvent: Record<string, unknown> };
    expect(plainDelta.assistantMessageEvent).toEqual({ type: "text_delta", contentIndex: 0, delta: "hi" });
  });

  test("slims tool execution events; agent_end goes bare", () => {
    expect(toChatClientEvent({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } })).toEqual({
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "bash",
      args: { command: "ls" },
    });
    expect(
      toChatClientEvent({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { big: true }, isError: true }),
    ).toEqual({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", isError: true });
    expect(toChatClientEvent({ type: "agent_end", messages: [{ role: "assistant" }] })).toEqual({ type: "agent_end" });
    // Everything else passes through (queue updates, compaction, retries…).
    const queueUpdate = { type: "queue_update", steering: ["a"], followUp: [] };
    expect(toChatClientEvent(queueUpdate)).toEqual(queueUpdate);
  });

  test("nested tool calls keep a slim start/end and drop their updates", () => {
    expect(
      toChatClientEvent({ type: "tool_execution_start", toolCallId: "c1/1", toolName: "read", args: { path: "f" }, parentToolCallId: "c1" }),
    ).toEqual({ type: "tool_execution_start", toolCallId: "c1/1", toolName: "read", parentToolCallId: "c1" });
    expect(
      toChatClientEvent({ type: "tool_execution_update", toolCallId: "c1/1", toolName: "read", args: {}, partialResult: "x", parentToolCallId: "c1" }),
    ).toBeNull();
    expect(
      toChatClientEvent({ type: "tool_execution_end", toolCallId: "c1/1", toolName: "read", result: {}, isError: false, parentToolCallId: "c1" }),
    ).toEqual({ type: "tool_execution_end", toolCallId: "c1/1", toolName: "read", isError: false, parentToolCallId: "c1" });
  });
});
