/**
 * Card-chat store (Svelte 5 runes, pattern of board.svelte.ts): GET state for
 * history, one EventSource for live events, optimistic send, and the
 * resnapshot-on-disconnect recovery path (the SSE backlog terminator's other
 * half). All JSON via JSON.parse on server-projected events.
 */
import { api, chatEventsUrl } from "../api";
import type { ChatMessage, ChatQueued, ChatState } from "../../../src/chat";
import { capThinkingBlocks, INITIAL_STREAMING_STATE, normalizeStreamingBlocks, streamReducer, type StreamingState } from "./chatStream";

type ClientEvent = Record<string, any>;

/** Eden wraps non-2xx bodies in `{ status, value }` (cf. gateFail in TaskDetail). */
function errorText(error: unknown): string {
  const value = (error as { value?: unknown } | undefined)?.value as { error?: string } | undefined;
  return value?.error ?? "request failed";
}

const RECONNECT_GAP_MS = 1_000;

class ChatStore {
  openCardId = $state<string | null>(null); // the card whose panel is mounted
  status = $state<"idle" | "connecting" | "ready" | "error">("idle");
  error = $state("");
  /** Status-line note: compaction / retry chatter. */
  note = $state("");
  messages = $state<ChatMessage[]>([]); // history + finalized turns
  streaming = $state<StreamingState>(INITIAL_STREAMING_STATE);
  tools = $state<Map<string, { toolName: string; partial?: unknown; startedAt: number }>>(new Map()); // running tool calls
  queued = $state<ChatQueued>({ steering: [], followUp: [] });
  model = $state<{ provider: string; id: string } | null>(null);
  thinkingLevel = $state("off");
  /** Levels the current model supports (canonical list when no session is live). */
  thinkingLevels = $state<string[]>([]);
  supportsThinking = $state(false);
  /** True while a setModel/setThinkingLevel POST is in flight — locks the picker chips. */
  switching = $state(false);
  /** Full-view flag: widens the board drawer / overlays the card modal for focus. */
  expanded = $state(false);

  toggleExpanded(): void {
    this.expanded = !this.expanded;
  }

  /** `provider/id` for display; empty when the session has no model yet. */
  get modelLabel(): string {
    return this.model ? `${this.model.provider}/${this.model.id}` : "";
  }

  #source: EventSource | null = null;
  #lastConnectAt = 0;
  #everConnected = false; // a source that never reached `connected` backs off instead of hot-looping

  async open(cardId: string): Promise<void> {
    this.close();
    this.openCardId = cardId;
    await this.#snapshotAndConnect(cardId);
  }

  /** Apply a server ChatState (GET snapshot or a setModel/setThinkingLevel response). */
  #applyState(data: ChatState): void {
    this.messages = data.messages;
    this.queued = data.queued;
    this.model = data.model;
    this.thinkingLevel = data.thinkingLevel;
    this.thinkingLevels = data.thinkingLevels;
    this.supportsThinking = data.supportsThinking;
    this.streaming = data.isStreaming ? { isStreaming: true, streamingMessage: null } : INITIAL_STREAMING_STATE;
  }

  /** GET state for the history, then (re)connect the SSE stream. Also the recovery path. */
  async #snapshotAndConnect(cardId: string): Promise<void> {
    if (this.openCardId !== cardId) return;
    this.status = "connecting";
    const state = await api.chat({ cardId }).get();
    if (this.openCardId !== cardId) return;
    if (!state.error) this.#applyState(state.data);
    this.#connect(cardId);
  }

  #connect(cardId: string): void {
    if (this.openCardId !== cardId) return;
    this.#source?.close();
    this.#lastConnectAt = Date.now();
    this.#everConnected = false;
    const source = new EventSource(chatEventsUrl(cardId));
    this.#source = source;
    source.onmessage = (e: MessageEvent) => {
      try {
        this.#handleEvent(cardId, JSON.parse(e.data) as ClientEvent);
      } catch {
        /* a malformed frame never kills the panel */
      }
    };
    source.onerror = () => {
      // Backlog termination or a dead socket: close and re-snapshot via GET.
      if (this.openCardId !== cardId) return;
      source.close();
      if (this.#source === source) this.#source = null;
      if (!this.#everConnected && Date.now() - this.#lastConnectAt < RECONNECT_GAP_MS) return;
      void this.#snapshotAndConnect(cardId);
    };
  }

  #handleEvent(cardId: string, event: ClientEvent): void {
    if (this.openCardId !== cardId) return;
    switch (event.type) {
      case "connected":
        this.status = "ready";
        this.#everConnected = true;
        if (event.isStreaming && !this.streaming.isStreaming) this.streaming = { isStreaming: true, streamingMessage: null };
        break;
      case "message_start": {
        const message = event.message as { role?: string; content?: unknown } | undefined;
        if (message?.role !== "assistant") return; // non-assistant starts are role-only
        this.streaming = streamReducer(this.streaming, { type: "snapshot", message });
        break;
      }
      case "message_update":
        this.streaming = streamReducer(this.streaming, { type: "delta", event: event.assistantMessageEvent });
        break;
      case "message_end": {
        // The wire forwards SDK blocks verbatim (signatures stripped): legacy toolCall
        // spellings normalize here exactly like the history projection, thinking gets
        // the same display cap, and toolResult ends append their ✓/✗ row.
        const message = event.message as { role?: string; content?: unknown; timestamp?: unknown; toolCallId?: unknown; toolName?: unknown; isError?: unknown; model?: string; provider?: string; stopReason?: string; errorMessage?: string } | undefined;
        const entryId = `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        if (message?.role === "assistant") {
          this.messages.push({
            role: "assistant",
            blocks: capThinkingBlocks(normalizeStreamingBlocks(message.content)),
            model: typeof message.model === "string" ? message.model : undefined,
            provider: typeof message.provider === "string" ? message.provider : undefined,
            stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
            errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
            at: typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : Date.now(),
            entryId,
          });
          this.streaming = INITIAL_STREAMING_STATE;
          this.note = "";
          break;
        }
        if (message?.role === "toolResult") {
          this.messages.push({
            role: "toolResult",
            toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : "",
            toolName: typeof message.toolName === "string" ? message.toolName : undefined,
            isError: message.isError === true,
            at: typeof message.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : Date.now(),
            entryId,
          });
        }
        break;
      }
      case "tool_execution_start":
        // Copy-on-write: $state proxies do not observe in-place Map mutations.
        this.tools = new Map(this.tools).set(event.toolCallId, { toolName: event.toolName, startedAt: Date.now() });
        break;
      case "tool_execution_update": {
        const entry = this.tools.get(event.toolCallId);
        if (!entry) break;
        this.tools = new Map(this.tools).set(event.toolCallId, { ...entry, partial: event.partialResult });
        break;
      }
      case "tool_execution_end": {
        // Keep the finished row visible for a beat, then drop it.
        const toolCallId = event.toolCallId;
        setTimeout(() => {
          if (this.openCardId !== cardId || !this.tools.has(toolCallId)) return;
          const next = new Map(this.tools);
          next.delete(toolCallId);
          this.tools = next;
        }, 1_000);
        break;
      }
      case "agent_end":
      case "agent_settled":
        this.streaming = INITIAL_STREAMING_STATE;
        this.tools = new Map();
        this.note = "";
        break;
      case "queue_update":
        this.queued = { steering: [...(event.steering ?? [])], followUp: [...(event.followUp ?? [])] };
        break;
      case "compaction_start":
        this.note = "compacting context…";
        break;
      case "compaction_end":
        this.note = "";
        break;
      case "auto_retry_start":
        this.note = `retrying (${event.attempt}/${event.maxAttempts})…`;
        break;
      case "auto_retry_end":
        this.note = event.success ? "" : `failed after ${event.attempt} retries`;
        break;
      case "startup_error":
        this.status = "error";
        this.error = event.errorMessage ?? "chat session failed to start";
        break;
      case "heartbeat":
      default:
        break;
    }
  }

  close(): void {
    this.#source?.close();
    this.#source = null;
    this.openCardId = null;
    this.status = "idle";
    this.error = "";
    this.note = "";
    this.messages = [];
    this.streaming = INITIAL_STREAMING_STATE;
    this.tools = new Map();
    this.queued = { steering: [], followUp: [] };
    this.model = null;
    this.thinkingLevel = "off";
    this.thinkingLevels = [];
    this.supportsThinking = false;
    this.switching = false;
    this.expanded = false;
  }

  async send(message: string): Promise<void> {
    const cardId = this.openCardId;
    const text = message.trim();
    if (!cardId || !text) return;
    this.error = "";
    const entryId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.messages.push({ role: "user", content: text, at: Date.now(), entryId }); // optimistic
    const streamingNow = this.status === "ready" && this.streaming.isStreaming;
    const res = await api.chat({ cardId }).post(
      streamingNow ? { type: "prompt", message: text, streamingBehavior: "steer" } : { type: "prompt", message: text },
    );
    if (this.openCardId !== cardId) return;
    if (res.error) {
      // Surface the refusal verbatim; the panel keeps the draft so it can be retried.
      this.messages = this.messages.filter((m) => m.entryId !== entryId);
      this.error = errorText(res.error);
    }
  }

  async stop(): Promise<void> {
    const cardId = this.openCardId;
    if (!cardId) return;
    await api.chat({ cardId }).post({ type: "abort" });
  }

  /** Switch the session's model. Boots the session lazily (like prompt); the
   *  response carries the fresh ChatState — the SDK's model_select event is
   *  extension-only and never reaches the SSE stream. */
  async setModel(provider: string, modelId: string): Promise<void> {
    const cardId = this.openCardId;
    if (!cardId || this.switching) return;
    this.switching = true;
    this.error = "";
    const res = await api.chat({ cardId }).post({ type: "setModel", provider, modelId });
    this.switching = false;
    if (this.openCardId !== cardId) return;
    if (res.error) this.error = errorText(res.error);
    // Eden can't narrow the POST union per body type — the command answers with ChatState
    else this.#applyState(res.data as ChatState);
  }

  async setThinkingLevel(level: string): Promise<void> {
    const cardId = this.openCardId;
    if (!cardId || this.switching) return;
    this.switching = true;
    this.error = "";
    const res = await api.chat({ cardId }).post({ type: "setThinkingLevel", level: level as "off" });
    this.switching = false;
    if (this.openCardId !== cardId) return;
    if (res.error) this.error = errorText(res.error);
    else this.#applyState(res.data as ChatState);
  }
}

export const chat = new ChatStore();
