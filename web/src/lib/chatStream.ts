/**
 * Pure streaming reducer for the card chat: a port of pi-web's
 * `lib/streaming-message.ts` semantics onto the pinned `ChatBlock` shape.
 * Deltas extend blocks their `*_end` replaces with authoritative content —
 * that is what makes the server's drop policy repairable.
 */
import type { ChatBlock } from "../../../src/chat";
import type { ClientAssistantMessageEvent } from "../../../src/chat-events";

/** A streaming toolCall block accumulates `rawInput` until `toolcall_end` finalizes it. */
export type StreamingBlock = ChatBlock & { rawInput?: string };

export interface StreamingState {
  isStreaming: boolean;
  streamingMessage: { role: "assistant"; content: StreamingBlock[] } | null;
}

export type StreamAction =
  | { type: "start" }
  | { type: "snapshot"; message: unknown }
  | { type: "delta"; event: ClientAssistantMessageEvent }
  | { type: "end" };

export const INITIAL_STREAMING_STATE: StreamingState = {
  isStreaming: false,
  streamingMessage: null,
};

/** Display bound for live thinking blocks — mirror of THINKING_BLOCK_CAP in src/chat.ts
 * (a value import would drag the SDK module graph into the web bundle, so it is mirrored). */
export const THINKING_DISPLAY_CAP = 2_000;

/** Cap finalized thinking blocks to the same display bound as the server's history projection. */
export function capThinkingBlocks(blocks: ChatBlock[]): ChatBlock[] {
  return blocks.map((block) =>
    block.type === "thinking" && block.thinking.length > THINKING_DISPLAY_CAP
      ? { ...block, thinking: block.thinking.slice(0, THINKING_DISPLAY_CAP), truncated: true }
      : block,
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Minimal port of pi-web's `normalizeStreamingToolCalls`: legacy field names in, rawInput kept. */
export function normalizeStreamingBlocks(content: unknown): StreamingBlock[] {
  if (!Array.isArray(content)) return [];
  return content.map((block) => {
    if (!isObject(block) || block.type !== "toolCall") return block as StreamingBlock;
    const rawInput =
      typeof block.rawInput === "string"
        ? block.rawInput
        : typeof block.partialJson === "string"
          ? block.partialJson
          : typeof block.partialArgs === "string"
            ? block.partialArgs
            : undefined;
    const normalized: StreamingBlock = {
      type: "toolCall",
      toolCallId: typeof block.toolCallId === "string" ? block.toolCallId : (typeof block.id === "string" ? block.id : ""),
      toolName: typeof block.toolName === "string" ? block.toolName : (typeof block.name === "string" ? block.name : ""),
      input: isObject(block.input) ? block.input : isObject(block.arguments) ? block.arguments : {},
    };
    return rawInput === undefined ? normalized : { ...normalized, rawInput };
  });
}

function updateBlock(
  state: StreamingState,
  contentIndex: number,
  update: (current: StreamingBlock | undefined) => StreamingBlock | null,
): StreamingState {
  const message = state.streamingMessage;
  if (!message || !Number.isInteger(contentIndex) || contentIndex < 0) return state;

  const content = [...message.content];
  const nextBlock = update(content[contentIndex]);
  if (!nextBlock) return state;
  content[contentIndex] = nextBlock;
  return { isStreaming: true, streamingMessage: { ...message, content } };
}

function applyDelta(state: StreamingState, event: ClientAssistantMessageEvent): StreamingState {
  switch (event.type) {
    case "text_start":
      // A start resets the block: pi-ai's `partial` is a live helper, not a snapshot, and
      // keeping its text would render the first chunk twice until `text_end` replaces it.
      return updateBlock(state, event.contentIndex, () => ({ type: "text", text: "" }));
    case "text_delta":
      return updateBlock(state, event.contentIndex, (current) => (
        current?.type === "text" ? { ...current, text: current.text + event.delta } : null
      ));
    case "text_end":
      return updateBlock(state, event.contentIndex, (current) => ({
        ...(current?.type === "text" ? current : {}),
        type: "text",
        text: event.content,
      }));
    case "thinking_start":
      return updateBlock(state, event.contentIndex, () => ({ type: "thinking", thinking: "" }));
    case "thinking_delta":
      return updateBlock(state, event.contentIndex, (current) => (
        current?.type === "thinking" ? { ...current, thinking: current.thinking + event.delta } : null
      ));
    case "thinking_end":
      return updateBlock(state, event.contentIndex, (current) => ({
        ...(current?.type === "thinking" ? current : {}),
        type: "thinking",
        thinking: event.content,
      }));
    case "toolcall_start":
      return updateBlock(state, event.contentIndex, (current) => {
        if (current?.type === "toolCall") {
          return {
            ...current,
            toolCallId: event.id ?? current.toolCallId,
            toolName: event.toolName ?? current.toolName,
            // The deltas rebuild rawInput — same snapshot leak as text_start.
            rawInput: "",
          };
        }
        if (typeof event.toolName !== "string") return null;
        return {
          type: "toolCall",
          toolCallId: event.id ?? "",
          toolName: event.toolName,
          input: {},
          rawInput: "",
        };
      });
    case "toolcall_delta":
      return updateBlock(state, event.contentIndex, (current) => (
        current?.type === "toolCall"
          ? {
            ...current,
            toolCallId: event.id || current.toolCallId,
            toolName: event.toolName || current.toolName,
            rawInput: (current.rawInput ?? "") + event.delta,
          }
          : null
      ));
    case "toolcall_end": {
      const toolCall = event.toolCall as { id?: string; name?: string; arguments?: Record<string, unknown> } | undefined;
      return updateBlock(state, event.contentIndex, () => ({
        type: "toolCall",
        toolCallId: toolCall?.id ?? "",
        toolName: toolCall?.name ?? "",
        input: toolCall?.arguments ?? {},
      }));
    }
    default:
      return state;
  }
}

export function streamReducer(state: StreamingState, action: StreamAction): StreamingState {
  switch (action.type) {
    case "start":
      return { isStreaming: true, streamingMessage: null };
    case "snapshot": {
      const message = action.message as { role?: string; content?: unknown } | null | undefined;
      return isObject(message) && message.role === "assistant"
        ? { isStreaming: true, streamingMessage: { role: "assistant", content: normalizeStreamingBlocks(message.content) } }
        : state;
    }
    case "delta":
      return applyDelta(state, action.event);
    case "end":
      return INITIAL_STREAMING_STATE;
    default:
      return state;
  }
}
