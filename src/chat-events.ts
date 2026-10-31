/**
 * The card-chat SSE transport: a design port of pi-web's `agent-event-stream`
 * + `agent-event-wire` (read-only reference), pinned to the subset a card
 * panel needs. No SDK imports at runtime — the session arrives behind the
 * `ChatStreamSession` interface, so tests never touch the pi package.
 *
 * Backpressure policy (AC3): the client is often a hidden tab. Above the high
 * water mark we drop events a later event repairs (streaming `*_delta`s,
 * partial tool output); past the backlog limit we hard-terminate the stream so
 * the client reconnects and re-snapshots via `GET /chat/:cardId`.
 */
import type { SdkChatEvent } from "./chat";

export interface ChatStreamSession {
  readonly isStreaming: boolean;
  readonly streamingMessage: unknown;
  isAlive?(): boolean;
  onEvent(listener: (event: SdkChatEvent) => void): () => void;
  activeToolEvents?(): SdkChatEvent[];
}

export const STREAM_HIGH_WATER_MARK_BYTES = 512 * 1024;
export const DEFAULT_BACKLOG_LIMIT_BYTES = 16 * 1024 * 1024;
export const TOOL_UPDATE_COALESCE_MS = 150;
export const CHAT_EVENT_HEARTBEAT_MS = 30_000;

function resolveBacklogLimitBytes(): number {
  const raw = Number(process.env.KANBAN_CHAT_SSE_BACKLOG_LIMIT_BYTES);
  return Number.isFinite(raw) && raw >= 64 * 1024 ? raw : DEFAULT_BACKLOG_LIMIT_BYTES;
}

/** Tests/dev knob: bun has no fake timers, so the 30 s default can be shortened. */
function resolveHeartbeatMs(): number {
  const raw = Number(process.env.KANBAN_CHAT_SSE_HEARTBEAT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : CHAT_EVENT_HEARTBEAT_MS;
}

const BACKPRESSURE_LOG_INTERVAL_MS = 60_000;
let lastBackpressureLogAt = 0;

function logBackpressure(queuedBytes: number, limitBytes: number, droppedEvents: number, closing: boolean): void {
  const now = Date.now();
  if (now - lastBackpressureLogAt < BACKPRESSURE_LOG_INTERVAL_MS) return;
  lastBackpressureLogAt = now;
  const queued = `${Math.round(queuedBytes / 1024)} KB`;
  console.warn(closing
    ? `[chat] event stream closed: client backlog ${queued} exceeds ${Math.round(limitBytes / 1024)} KB; it reconnects and re-snapshots.`
    : `[chat] event stream is behind (${queued} queued): dropping rebuildable deltas (${droppedEvents} so far).`);
}

// ── Event wire: the pinned projection subset (port of pi-web's agent-event-wire) ──────────

export interface ChatEventLike {
  type: string;
  [key: string]: unknown;
}

type MessageUpdateEvent = Extract<SdkChatEvent, { type: "message_update" }>;
type AssistantMessageEvent = MessageUpdateEvent["assistantMessageEvent"];
type ToolCallStartEvent = Extract<AssistantMessageEvent, { type: "toolcall_start" }>;
type ToolCallDeltaEvent = Extract<AssistantMessageEvent, { type: "toolcall_delta" }>;

/** What the browser reducer consumes: SDK assistant-message events, minus `partial`, with toolcall metadata inlined. */
export type ClientAssistantMessageEvent =
  | Exclude<AssistantMessageEvent, { type: "toolcall_start" | "toolcall_delta" }>
  | (ToolCallStartEvent & { id?: string; toolName?: string })
  | (ToolCallDeltaEvent & { id?: string; toolName?: string });

const SIGNATURE_FIELDS = ["thinkingSignature", "textSignature", "thoughtSignature"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Provider signatures belong to model context, not browser display copies. */
function withoutContentSignatures<T>(block: T): T {
  if (!isObject(block) || !SIGNATURE_FIELDS.some((field) => Object.hasOwn(block, field))) return block;
  const content = { ...block };
  for (const field of SIGNATURE_FIELDS) delete content[field];
  return content as T;
}

function withoutMessageSignatures<T>(message: T): T {
  if (!isObject(message) || message.role !== "assistant" || !Array.isArray(message.content)) return message;
  let changed = false;
  const content = (message.content as unknown[]).map((block) => {
    const projected = withoutContentSignatures(block);
    changed ||= projected !== block;
    return projected;
  });
  return changed ? { ...message, content } as T : message;
}

/**
 * A `tool_execution_*` event for a call another tool made while it ran. The SDK gives those
 * `parentToolCallId` and ids of the form `<parent>/<n>`; the parent's own updates report them.
 */
function isNestedToolExecutionEvent(event: ChatEventLike): boolean {
  return (
    event.type === "tool_execution_start"
    || event.type === "tool_execution_update"
    || event.type === "tool_execution_end"
  ) && typeof event.parentToolCallId === "string" && event.parentToolCallId !== "";
}

/** Nested calls travel as a slim start and end; `tool_execution_end` never carries `result`. */
function toClientToolExecutionEvent(event: ChatEventLike): ChatEventLike | null {
  const nested = isNestedToolExecutionEvent(event);
  if (event.type === "tool_execution_start") {
    if (!nested) return event;
    return {
      type: "tool_execution_start",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      parentToolCallId: event.parentToolCallId,
    };
  }
  if (event.type === "tool_execution_update") {
    if (nested) return null;
    return {
      type: "tool_execution_update",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      partialResult: event.partialResult,
    };
  }
  return {
    type: "tool_execution_end",
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    isError: event.isError,
    ...(nested ? { parentToolCallId: event.parentToolCallId } : {}),
  };
}

function toolCallMetadata(event: Record<string, unknown>): { id: string; toolName: string } | null {
  if (
    (event.type !== "toolcall_start" && event.type !== "toolcall_delta")
    || !isObject(event.partial)
  ) return null;
  const content = event.partial.content;
  const contentIndex = event.contentIndex;
  if (!Array.isArray(content) || typeof contentIndex !== "number") return null;

  const block = content[contentIndex];
  if (!isObject(block) || block.type !== "toolCall") return null;
  const id = typeof block.id === "string" ? block.id : (typeof block.toolCallId === "string" ? block.toolCallId : null);
  const toolName = typeof block.name === "string" ? block.name : (typeof block.toolName === "string" ? block.toolName : null);
  return id !== null && toolName !== null ? { id, toolName } : null;
}

/** Transcript system messages (prompt and tool loadout) are never rendered. */
function isSystemMessageEvent(event: ChatEventLike): boolean {
  return (event.type === "message_start" || event.type === "message_end")
    && isObject(event.message)
    && event.message.role === "system";
}

const OMITTED_EVENT_TYPES = new Set(["turn_start", "turn_end", "entry_appended"]);

/** Apply the pinned filters: bulk drops, signature stripping, tool-event slimming. */
export function toChatClientEvent(event: ChatEventLike): ChatEventLike | null {
  if (OMITTED_EVENT_TYPES.has(event.type)) return null;
  if (isSystemMessageEvent(event)) return null;
  if (event.type === "message_start" || event.type === "message_end") {
    const message = withoutMessageSignatures(event.message);
    if (message !== event.message) return { ...event, message };
  }
  // The agent loop announces a finished message (a tool result, a delivered user
  // message) with `message_start`/`message_end` back to back; the client builds
  // only assistant replies, so non-assistant bodies go out as the role alone.
  if (event.type === "message_start" && isObject(event.message) && event.message.role !== "assistant") {
    return { type: "message_start", message: { role: event.message.role } };
  }

  if (event.type === "message_update") {
    const raw = event.assistantMessageEvent;
    if (!isObject(raw)) return null;
    let assistantMessageEvent = raw;

    if ("toolCall" in assistantMessageEvent) {
      const toolCall = withoutContentSignatures(assistantMessageEvent.toolCall);
      if (toolCall !== assistantMessageEvent.toolCall) {
        assistantMessageEvent = { ...assistantMessageEvent, toolCall };
      }
    }

    if (!("partial" in assistantMessageEvent)) {
      return { type: "message_update", assistantMessageEvent };
    }
    const metadata = toolCallMetadata(assistantMessageEvent);
    const { partial: _partial, ...deltaEvent } = assistantMessageEvent;
    void _partial;
    return { type: "message_update", assistantMessageEvent: metadata ? { ...deltaEvent, ...metadata } : deltaEvent };
  }

  if (
    event.type === "tool_execution_start"
    || event.type === "tool_execution_update"
    || event.type === "tool_execution_end"
  ) return toClientToolExecutionEvent(event);

  if (event.type === "agent_end") return { type: "agent_end" };
  return event;
}

/** A `message_start`/`message_update` carrying the exact object we snapshotted is already on the wire. */
function isEventIncludedInSnapshot(event: ChatEventLike, snapshot: unknown): boolean {
  return snapshot !== undefined
    && (event.type === "message_start" || event.type === "message_update")
    && event.message === snapshot;
}

/**
 * Whether a later event repairs this one if dropped: `*_delta` only extends a block its
 * `*_end` replaces with authoritative content, and a tool update is superseded by the next
 * update or the end. Starts and ends are never dropped.
 */
function isDroppableEvent(event: ChatEventLike): boolean {
  if (event.type === "tool_execution_update") return true;
  if (event.type !== "message_update") return false;
  const update = event.assistantMessageEvent;
  return typeof update === "object"
    && update !== null
    && typeof (update as { type?: unknown }).type === "string"
    && (update as { type: string }).type.endsWith("_delta");
}

/**
 * Open the SSE transport immediately, then publish the session snapshot only
 * after the session resolved and its event listener has been installed.
 */
export function createChatEventStream(req: Request, sessionPromise: Promise<ChatStreamSession>): ReadableStream<Uint8Array> {
  let cancelStream: () => void = () => {};

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let unsubscribe: (() => void) | null = null;
      let abortHandler: (() => void) | null = null;
      // Latest `tool_execution_update` per tool call id, waiting for the flush.
      const pendingToolUpdates = new Map<string, ChatEventLike>();
      let toolUpdateTimer: ReturnType<typeof setTimeout> | null = null;

      // "error": hard-terminate (a broken stream makes the client reconnect and
      // re-snapshot). "true": graceful close after the final event flushed.
      const cleanup = (closeController: boolean | "error", reason?: Error) => {
        if (closed) return;
        closed = true;
        if (heartbeat !== null) clearInterval(heartbeat);
        if (toolUpdateTimer !== null) clearTimeout(toolUpdateTimer);
        pendingToolUpdates.clear();
        unsubscribe?.();
        unsubscribe = null;
        if (abortHandler) req.signal.removeEventListener("abort", abortHandler);
        if (closeController === "error") {
          try { controller.error(reason ?? new Error("chat server shutting down")); } catch { /* already closed */ }
        } else if (closeController) {
          try { controller.close(); } catch { /* stream already closed */ }
        }
      };
      cancelStream = () => cleanup(true);

      const backlogLimitBytes = resolveBacklogLimitBytes();
      let droppedEvents = 0;
      const enqueueText = (text: string, options?: { droppable?: boolean }) => {
        if (closed) return;
        const desiredSize = controller.desiredSize;
        if (desiredSize === null) {
          cleanup(true);
          return;
        }
        const queuedBytes = STREAM_HIGH_WATER_MARK_BYTES - desiredSize;
        if (options?.droppable && queuedBytes > STREAM_HIGH_WATER_MARK_BYTES) {
          droppedEvents += 1;
          logBackpressure(queuedBytes, backlogLimitBytes, droppedEvents, false);
          return;
        }
        if (queuedBytes > backlogLimitBytes) {
          logBackpressure(queuedBytes, backlogLimitBytes, droppedEvents, true);
          cleanup("error", new Error(`chat event stream closed: client backlog exceeded ${Math.round(backlogLimitBytes / 1024)} KB`));
          return;
        }
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup(true);
        }
      };
      const encode = (data: unknown, options?: { droppable?: boolean }) => {
        enqueueText(`data: ${JSON.stringify(data)}\n\n`, options);
      };
      const flushToolUpdates = () => {
        toolUpdateTimer = null;
        const updates = [...pendingToolUpdates.values()];
        pendingToolUpdates.clear();
        for (const update of updates) encode(update, { droppable: true });
      };
      const sendClientEvent = (clientEvent: ChatEventLike) => {
        if (clientEvent.type === "tool_execution_update") {
          pendingToolUpdates.set(String(clientEvent.toolCallId), clientEvent);
          toolUpdateTimer ??= setTimeout(flushToolUpdates, TOOL_UPDATE_COALESCE_MS);
          return;
        }
        // The end supersedes a partial result still waiting here; agent_end does
        // the same for any call whose end never came.
        if (clientEvent.type === "tool_execution_end") {
          pendingToolUpdates.delete(String(clientEvent.toolCallId));
        } else if (clientEvent.type === "agent_end") {
          pendingToolUpdates.clear();
        }
        encode(clientEvent, { droppable: isDroppableEvent(clientEvent) });
      };
      const forwardEvent = (event: ChatEventLike, snapshot: unknown) => {
        if (isEventIncludedInSnapshot(event, snapshot)) return;
        const clientEvent = toChatClientEvent(event);
        if (clientEvent) sendClientEvent(clientEvent);
      };

      const publishSession = async () => {
        try {
          const session = await sessionPromise;
          if (closed) return;
          if (session.isAlive && !session.isAlive()) {
            cleanup(true);
            return;
          }

          const bufferedEvents: ChatEventLike[] = [];
          let snapshotPublished = false;
          const handleEvent = (event: SdkChatEvent) => {
            if (event.type === "shutdown") {
              cleanup(true);
              return;
            }
            if (!snapshotPublished) {
              bufferedEvents.push(event as ChatEventLike);
              return;
            }
            forwardEvent(event as ChatEventLike, snapshot);
          };

          const stopListening = session.onEvent(handleEvent);
          if (closed) {
            stopListening();
            return;
          }
          if (session.isAlive && !session.isAlive()) {
            stopListening();
            cleanup(true);
            return;
          }
          unsubscribe = stopListening;

          const snapshot = session.streamingMessage;
          encode({ type: "connected", isStreaming: session.isStreaming });
          for (const event of bufferedEvents) forwardEvent(event, snapshot);
          // Active tools replayed by the session itself are already in bufferedEvents;
          // this covers sessions whose onEvent does not replay (identity dedupe).
          for (const event of session.activeToolEvents?.() ?? []) {
            if (!bufferedEvents.includes(event as ChatEventLike)) forwardEvent(event as ChatEventLike, snapshot);
          }
          if (snapshot !== undefined && snapshot !== null) {
            forwardEvent({ type: "message_start", message: snapshot }, undefined);
          }
          snapshotPublished = true;
        } catch (error) {
          if (closed) return;
          encode({
            type: "startup_error",
            errorMessage: `Failed to start chat session: ${error instanceof Error ? error.message : String(error)}`,
          });
          cleanup(true);
        }
      };

      // Attach the rejection handler before checking the request signal.
      void publishSession();

      abortHandler = () => cleanup(true);
      if (req.signal.aborted) {
        cleanup(true);
        return;
      }
      req.signal.addEventListener("abort", abortHandler, { once: true });

      heartbeat = setInterval(() => encode({ type: "heartbeat" }, { droppable: true }), resolveHeartbeatMs());
      heartbeat.unref?.();

      // Force the response headers through without claiming the session is ready.
      // The client waits for the later `connected` data event.
      enqueueText(":\n\n");
    },
    cancel() {
      cancelStream();
    },
  }, {
    highWaterMark: STREAM_HIGH_WATER_MARK_BYTES,
    size: (chunk: Uint8Array | undefined) => chunk?.byteLength ?? 0,
  });
}
