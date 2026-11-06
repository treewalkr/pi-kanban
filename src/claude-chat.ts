/**
 * Claude Code as a chat backend. A chat session normally lives in-process on
 * the pi SDK; when the human picks a `claude-code` model, the card's chat
 * swaps to this handle instead: one headless `claude -p` child per turn,
 * resumed across turns by Claude's own session id, with its stream-json
 * translated into the pi `AgentSessionEvent` vocabulary the SSE wire and the
 * browser reducer already speak.
 *
 * The transcript stays the card's pi session file: every Claude turn is
 * appended as pi-shaped user / assistant / toolResult messages, so history,
 * the GET snapshot and a later switch back to a pi model all read one record.
 * The backend choice (harness, alias, effort, Claude session id) rides in a
 * custom session entry — resume still needs no schema.
 */
import { randomUUID } from "node:crypto";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { CLAUDE_BUILD_TOOLS, CLAUDE_MODELS } from "./claude";
import { projectEntries, type ChatCommand, type ChatHandle, type ChatShutdownReason, type ChatState, type SdkChatEvent } from "./chat";
import { KanbanError } from "./db";
import type { HarnessProbe } from "./harnesses";
import type { CatalogModel } from "./models";

/** The picker's provider id for Claude Code models (a harness, not a pi provider). */
export const CLAUDE_CHAT_PROVIDER = "claude-code";
/** `claude --effort` levels, offered as the thinking chip's options. */
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
/** Custom session entry type recording which backend a chat runs on. */
export const CHAT_BACKEND_ENTRY = "kanban-chat-backend";
export const TOOL_RESULT_CAP = 4_000;
export const RECAP_MESSAGE_CAP = 2_000;
export const RECAP_TOTAL_CAP = 12_000;

export type ChatBackend =
  | { harness: "pi" }
  | { harness: "claude"; model: string; effort?: string; claudeSessionId: string; started: boolean };
export type ClaudeBackend = Extract<ChatBackend, { harness: "claude" }>;

export function isClaudeAlias(id: string): boolean {
  return CLAUDE_MODELS.some((m) => m.id === id);
}

/** pi thinking levels → the nearest claude effort (claude has no off/minimal). */
export function toClaudeEffort(level: string): string {
  if ((CLAUDE_EFFORT_LEVELS as readonly string[]).includes(level)) return level;
  return "low";
}

/**
 * The Claude Code rows for the chat model menu: only while the harness is
 * installed and switched on, minus aliases switched off in Providers
 * (`claude:<alias>` keys, the same ones the engine editor honors).
 */
export function claudeChatModels(probe: HarnessProbe | undefined, enabled: boolean, disabled: ReadonlySet<string>): CatalogModel[] {
  if (!probe || probe.status !== "ready" || !enabled) return [];
  return probe.models
    .filter((m) => !disabled.has(`claude:${m.id}`))
    .map((m) => ({ provider: CLAUDE_CHAT_PROVIDER, id: m.id, context: "", maxOut: "", thinking: true, images: false, harness: "claude" as const }));
}

/** The latest backend choice recorded in a session, or null (a plain pi chat). */
export function readBackend(sessionManager: SessionManager): ChatBackend | null {
  const entries = sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type: string; customType?: string; data?: unknown };
    if (entry.type !== "custom" || entry.customType !== CHAT_BACKEND_ENTRY) continue;
    const data = entry.data as Partial<ClaudeBackend> | { harness?: string } | undefined;
    if (data?.harness === "pi") return { harness: "pi" };
    if (data?.harness === "claude") {
      const d = data as Partial<ClaudeBackend>;
      if (typeof d.model !== "string" || typeof d.claudeSessionId !== "string") return null;
      return {
        harness: "claude",
        model: d.model,
        ...(typeof d.effort === "string" ? { effort: d.effort } : {}),
        claudeSessionId: d.claudeSessionId,
        started: d.started === true,
      };
    }
    return null;
  }
  return null;
}

export function writeBackend(sessionManager: SessionManager, backend: ChatBackend): void {
  sessionManager.appendCustomEntry(CHAT_BACKEND_ENTRY, backend);
}

export function freshClaudeBackend(model: string, effort?: string): ClaudeBackend {
  return { harness: "claude", model, ...(effort ? { effort: toClaudeEffort(effort) } : {}), claudeSessionId: randomUUID(), started: false };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (isObject(b) && b.type === "text" && typeof b.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

const clip = (s: string, cap: number) => (s.length > cap ? `${s.slice(0, cap)}…` : s);

/**
 * A Claude session starts blind to whatever the chat said before it (on pi, or
 * in an earlier Claude session), so its first prompt carries a bounded recap
 * of the transcript's user/assistant text. Empty when there is nothing to recap.
 */
export function transcriptRecap(entries: Iterable<{ type: string; message?: unknown }>): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || !isObject(entry.message)) continue;
    const { role, content } = entry.message;
    const text = textOf(content).trim();
    if (!text) continue;
    if (role === "user") lines.push(`Human: ${clip(text, RECAP_MESSAGE_CAP)}`);
    else if (role === "assistant") lines.push(`Assistant: ${clip(text, RECAP_MESSAGE_CAP)}`);
  }
  if (lines.length === 0) return "";
  const kept: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    total += lines[i].length;
    if (total > RECAP_TOTAL_CAP && kept.length > 0) break;
    kept.unshift(lines[i]);
  }
  return [
    "This chat continues an earlier conversation held on another model. Recap of it, most recent last:",
    "",
    kept.join("\n\n"),
    "",
    "--- end of recap ---",
  ].join("\n");
}

// ── stream-json → pi events ─────────────────────────────────────────────────

type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export interface PiAssistantMessage {
  role: "assistant";
  content: Block[];
  api: string;
  provider: string;
  model: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } };
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}

export interface PiToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: { type: "text"; text: string }[];
  isError: boolean;
  timestamp: number;
}

const zeroUsage = (): PiAssistantMessage["usage"] => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function stopReasonOf(raw: unknown): PiAssistantMessage["stopReason"] {
  if (raw === "tool_use") return "toolUse";
  if (raw === "max_tokens") return "length";
  return "stop";
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Pure translator for one turn's stream-json lines. Built from
 * `--include-partial-messages` stream events (Anthropic's raw
 * message/content_block events), with the whole `assistant` message as a
 * fallback when partials never arrived. Subagent traffic (non-null
 * `parent_tool_use_id`) stays inside its Task tool call.
 */
export class ClaudeStreamMapper {
  /** The assistant message being streamed, in pi shape (the SSE snapshot). */
  current: PiAssistantMessage | null = null;
  /** The final `result` event's verdict, once seen. */
  result: { isError: boolean; text: string } | null = null;
  /** A quota/rate-limit rejection seen mid-turn. */
  rateLimited: string | null = null;
  sawInit = false;
  private currentId: string | null = null;
  private readonly raw = new Map<number, string>();
  private readonly finalized = new Set<string>();
  private readonly toolNames = new Map<string, string>();

  constructor(
    private readonly alias: string,
    private readonly out: { emit: (event: Record<string, unknown>) => void; message: (message: PiAssistantMessage | PiToolResultMessage) => void },
    private readonly now: () => number = () => Date.now(),
  ) {}

  feed(line: string): void {
    let ev: Record<string, any>;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (!isObject(ev)) return;
    if (ev.parent_tool_use_id) return; // subagent traffic
    switch (ev.type) {
      case "system":
        if (ev.subtype === "init") this.sawInit = true;
        return;
      case "stream_event":
        this.streamEvent(isObject(ev.event) ? ev.event : {});
        return;
      case "assistant":
        this.wholeAssistant(ev.message);
        return;
      case "user":
        this.toolResults(ev.message);
        return;
      case "rate_limit_event": {
        const info = isObject(ev.rate_limit_info) ? ev.rate_limit_info : {};
        if (info.status === "rejected") this.rateLimited = `claude ${String(info.rateLimitType ?? "usage")} limit reached`;
        return;
      }
      case "result":
        this.result = {
          isError: ev.is_error === true,
          text: typeof ev.result === "string" ? ev.result : String(ev.subtype ?? ""),
        };
        return;
    }
  }

  private newMessage(model: unknown): PiAssistantMessage {
    return {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: CLAUDE_CHAT_PROVIDER,
      model: typeof model === "string" && model ? model : this.alias,
      usage: zeroUsage(),
      stopReason: "stop",
      timestamp: this.now(),
    };
  }

  private update(assistantMessageEvent: Record<string, unknown>): void {
    this.out.emit({ type: "message_update", assistantMessageEvent });
  }

  private streamEvent(event: Record<string, any>): void {
    const index = typeof event.index === "number" ? event.index : -1;
    switch (event.type) {
      case "message_start": {
        if (this.current) this.finish(); // a missed message_stop never strands the previous one
        const message = isObject(event.message) ? event.message : {};
        this.current = this.newMessage(message.model);
        this.currentId = typeof message.id === "string" ? message.id : null;
        this.raw.clear();
        this.out.emit({ type: "message_start", message: this.current });
        return;
      }
      case "content_block_start": {
        const cur = this.current;
        const block = isObject(event.content_block) ? event.content_block : {};
        if (!cur || index < 0) return;
        if (block.type === "text") {
          cur.content[index] = { type: "text", text: "" };
          this.update({ type: "text_start", contentIndex: index });
        } else if (block.type === "thinking") {
          cur.content[index] = { type: "thinking", thinking: "" };
          this.update({ type: "thinking_start", contentIndex: index });
        } else if (block.type === "tool_use") {
          const id = String(block.id ?? "");
          const name = String(block.name ?? "tool");
          cur.content[index] = { type: "toolCall", id, name, arguments: {} };
          this.toolNames.set(id, name);
          this.raw.set(index, "");
          this.update({ type: "toolcall_start", contentIndex: index, id, toolName: name });
        }
        return;
      }
      case "content_block_delta": {
        const block = this.current?.content[index];
        const delta = isObject(event.delta) ? event.delta : {};
        if (!block) return;
        if (delta.type === "text_delta" && block.type === "text" && typeof delta.text === "string") {
          block.text += delta.text;
          this.update({ type: "text_delta", contentIndex: index, delta: delta.text });
        } else if (delta.type === "thinking_delta" && block.type === "thinking" && typeof delta.thinking === "string") {
          block.thinking += delta.thinking;
          this.update({ type: "thinking_delta", contentIndex: index, delta: delta.thinking });
        } else if (delta.type === "input_json_delta" && block.type === "toolCall" && typeof delta.partial_json === "string") {
          this.raw.set(index, (this.raw.get(index) ?? "") + delta.partial_json);
          this.update({ type: "toolcall_delta", contentIndex: index, delta: delta.partial_json, id: block.id, toolName: block.name });
        }
        return;
      }
      case "content_block_stop": {
        const block = this.current?.content[index];
        if (!block) return;
        if (block.type === "text") this.update({ type: "text_end", contentIndex: index, content: block.text });
        else if (block.type === "thinking") this.update({ type: "thinking_end", contentIndex: index, content: block.thinking });
        else {
          block.arguments = parseArgs(this.raw.get(index) ?? "");
          this.update({ type: "toolcall_end", contentIndex: index, toolCall: { ...block } });
          this.out.emit({ type: "tool_execution_start", toolCallId: block.id, toolName: block.name, args: block.arguments });
        }
        return;
      }
      case "message_delta": {
        const cur = this.current;
        if (!cur) return;
        if (isObject(event.delta) && event.delta.stop_reason) cur.stopReason = stopReasonOf(event.delta.stop_reason);
        const usage = isObject(event.usage) ? event.usage : {};
        const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
        cur.usage.input = n(usage.input_tokens);
        cur.usage.output = n(usage.output_tokens);
        cur.usage.cacheRead = n(usage.cache_read_input_tokens);
        cur.usage.cacheWrite = n(usage.cache_creation_input_tokens);
        cur.usage.totalTokens = cur.usage.input + cur.usage.output + cur.usage.cacheRead + cur.usage.cacheWrite;
        return;
      }
      case "message_stop":
        this.finish();
        return;
    }
  }

  /** Finalize the streamed message: dense content, message_end, transcript append. */
  finish(stopReason?: PiAssistantMessage["stopReason"], errorMessage?: string): void {
    const cur = this.current;
    if (!cur) return;
    cur.content = cur.content.filter(Boolean);
    if (stopReason) cur.stopReason = stopReason;
    if (errorMessage) cur.errorMessage = errorMessage;
    if (this.currentId) this.finalized.add(this.currentId);
    this.current = null;
    this.currentId = null;
    this.raw.clear();
    this.out.emit({ type: "message_end", message: cur });
    this.out.message(cur);
  }

  /** Whole `assistant` events: ignored when partials streamed the same message. */
  private wholeAssistant(message: unknown): void {
    if (!isObject(message)) return;
    const id = typeof message.id === "string" ? message.id : null;
    if (id && (this.finalized.has(id) || id === this.currentId)) return;
    const msg = this.newMessage(message.model);
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (!isObject(block)) continue;
      if (block.type === "text" && typeof block.text === "string") msg.content.push({ type: "text", text: block.text });
      else if (block.type === "thinking" && typeof block.thinking === "string") msg.content.push({ type: "thinking", thinking: block.thinking });
      else if (block.type === "tool_use") {
        const toolCall: Block = { type: "toolCall", id: String(block.id ?? ""), name: String(block.name ?? "tool"), arguments: isObject(block.input) ? block.input : {} };
        msg.content.push(toolCall);
        this.toolNames.set(toolCall.id, toolCall.name);
      }
    }
    if (msg.content.length === 0) return;
    msg.stopReason = stopReasonOf(message.stop_reason);
    if (id) this.finalized.add(id);
    this.out.emit({ type: "message_start", message: msg });
    this.out.emit({ type: "message_end", message: msg });
    this.out.message(msg);
    for (const block of msg.content) {
      if (block.type === "toolCall") this.out.emit({ type: "tool_execution_start", toolCallId: block.id, toolName: block.name, args: block.arguments });
    }
  }

  private toolResults(message: unknown): void {
    if (!isObject(message) || !Array.isArray(message.content)) return;
    for (const block of message.content) {
      if (!isObject(block) || block.type !== "tool_result") continue;
      const toolCallId = String(block.tool_use_id ?? "");
      const toolName = this.toolNames.get(toolCallId) ?? "tool";
      const isError = block.is_error === true;
      const result: PiToolResultMessage = {
        role: "toolResult",
        toolCallId,
        toolName,
        content: [{ type: "text", text: clip(textOf(block.content), TOOL_RESULT_CAP) }],
        isError,
        timestamp: this.now(),
      };
      this.out.emit({ type: "tool_execution_end", toolCallId, toolName, isError, result: { content: result.content } });
      this.out.emit({ type: "message_start", message: result });
      this.out.emit({ type: "message_end", message: result });
      this.out.message(result);
    }
  }
}

// ── the child ───────────────────────────────────────────────────────────────

export interface ClaudeChild {
  /** Raw stdout lines, in order. */
  lines: AsyncIterable<string>;
  exited: Promise<number>;
  stderr: Promise<string>;
  kill(): void;
}

/** Test seam: spawns `claude` with the given args, prompt on stdin. */
export type ClaudeRunner = (input: { args: string[]; stdin: string; cwd: string }) => ClaudeChild;

async function* stdoutLines(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        yield buf.slice(0, nl);
        buf = buf.slice(nl + 1);
      }
    }
  } catch {
    /* torn down by a kill — exit handling covers it */
  }
  if (buf.trim()) yield buf;
}

export const defaultClaudeRunner: ClaudeRunner = ({ args, stdin, cwd }) => {
  const proc = Bun.spawn({ cmd: ["claude", ...args], cwd, env: process.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  proc.stdin.write(stdin);
  void proc.stdin.end();
  return {
    lines: stdoutLines(proc.stdout),
    exited: proc.exited,
    stderr: new Response(proc.stderr).text(),
    kill: () => proc.kill(),
  };
};

/** Flags for one chat turn (the prompt travels on stdin). */
export function claudeChatArgs(backend: ClaudeBackend, appendSystemPrompt: string): string[] {
  return [
    "-p",
    ...(backend.started ? ["--resume", backend.claudeSessionId] : ["--session-id", backend.claudeSessionId]),
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    backend.model,
    ...(backend.effort ? ["--effort", backend.effort] : []),
    "--add-dir",
    "/tmp",
    ...(appendSystemPrompt ? ["--append-system-prompt", appendSystemPrompt] : []),
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    CLAUDE_BUILD_TOOLS.join(","),
  ];
}

// ── the handle ──────────────────────────────────────────────────────────────

export interface ClaudeHandleOpts {
  cwd: string;
  cardId: string;
  sessionId: string;
  sessionManager: SessionManager;
  appendSystemPrompt: string;
  firstSeed: () => string;
  backend: ClaudeBackend;
  idleTimeoutMs: number;
  now: () => number;
  log: (message: string) => void;
  onDisposed: (handle: ClaudeChatHandle) => void;
  runner?: ClaudeRunner;
}

const IDLE_TICK_MS = 250;

function hasUserMessage(sessionManager: SessionManager): boolean {
  return sessionManager.getEntries().some((e) => e.type === "message" && isObject(e.message) && (e.message as { role?: unknown }).role === "user");
}

export class ClaudeChatHandle implements ChatHandle {
  readonly harness = "claude" as const;
  readonly cardId: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly sessionManager: SessionManager;
  readonly appendSystemPrompt: string;
  readonly firstSeed: () => string;
  private backend: ClaudeBackend;
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly onDisposed: (handle: ClaudeChatHandle) => void;
  private readonly runner: ClaudeRunner;
  private readonly listeners = new Set<(event: SdkChatEvent) => void>();
  private readonly activeTools = new Map<string, SdkChatEvent>();
  private queue: string[] = [];
  private child: ClaudeChild | null = null;
  private mapper: ClaudeStreamMapper | null = null;
  private running = false;
  private aborted = false;
  private lastActivity: number;
  private idleTicker: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(opts: ClaudeHandleOpts) {
    this.cwd = opts.cwd;
    this.cardId = opts.cardId;
    this.sessionId = opts.sessionId;
    this.sessionManager = opts.sessionManager;
    this.appendSystemPrompt = opts.appendSystemPrompt;
    this.firstSeed = opts.firstSeed;
    this.backend = opts.backend;
    this.idleTimeoutMs = opts.idleTimeoutMs;
    this.now = opts.now;
    this.log = opts.log;
    this.onDisposed = opts.onDisposed;
    this.runner = opts.runner ?? defaultClaudeRunner;
    this.lastActivity = opts.now();
    if (this.idleTimeoutMs > 0) {
      this.idleTicker = setInterval(() => this.checkIdle(), Math.min(this.idleTimeoutMs, IDLE_TICK_MS));
      this.idleTicker.unref?.();
    }
  }

  private emit(event: Record<string, unknown>): void {
    const e = event as unknown as SdkChatEvent;
    const type = event.type;
    if (type === "tool_execution_start") this.activeTools.set(String(event.toolCallId), e);
    else if (type === "tool_execution_end") this.activeTools.delete(String(event.toolCallId));
    else if (type === "agent_end") this.activeTools.clear();
    for (const listener of [...this.listeners]) {
      try {
        listener(e);
      } catch {
        /* a dead SSE listener must not break the fan-out */
      }
    }
  }

  private checkIdle(): void {
    if (this.disposed || this.running) return;
    if (this.now() - this.lastActivity < this.idleTimeoutMs) return;
    this.log(`${this.cardId} idle-expired`);
    void this.dispose("idle");
  }

  private emitQueue(): void {
    this.emit({ type: "queue_update", steering: [], followUp: [...this.queue] });
  }

  private persistBackend(): void {
    writeBackend(this.sessionManager, this.backend);
  }

  /** Start one turn; the child runs in the background and drains the queue after. */
  private startTurn(message: string): void {
    const seed = hasUserMessage(this.sessionManager) ? "" : `${this.firstSeed()}\n\n`;
    const recap = this.backend.started ? "" : transcriptRecap(this.sessionManager.getEntries());
    const userText = `${seed}${message}`;
    const child = this.runner({
      args: claudeChatArgs(this.backend, this.appendSystemPrompt),
      stdin: recap ? `${recap}\n\n${userText}` : userText,
      cwd: this.cwd,
    });
    this.child = child;
    this.running = true;
    this.aborted = false;
    const user = { role: "user" as const, content: userText, timestamp: this.now() };
    this.sessionManager.appendMessage(user);
    this.emit({ type: "agent_start" });
    this.emit({ type: "message_start", message: user });
    this.emit({ type: "message_end", message: user });
    const mapper = new ClaudeStreamMapper(this.backend.model, {
      emit: (event) => this.emit(event),
      message: (m) => {
        this.sessionManager.appendMessage(m as never);
      },
    }, this.now);
    this.mapper = mapper;
    void this.drive(child, mapper);
  }

  private async drive(child: ClaudeChild, mapper: ClaudeStreamMapper): Promise<void> {
    for await (const line of child.lines) {
      this.lastActivity = this.now();
      mapper.feed(line);
      if (mapper.sawInit && !this.backend.started) {
        this.backend = { ...this.backend, started: true };
        this.persistBackend();
      }
    }
    const code = await child.exited.catch(() => -1);
    const stderr = (await child.stderr.catch(() => "")).trim();
    if (this.aborted) {
      mapper.finish("aborted");
    } else {
      const failure =
        mapper.rateLimited
        ?? (mapper.result?.isError ? mapper.result.text || "claude reported an error" : null)
        ?? (code !== 0 && !mapper.result ? `claude exited ${code}${stderr ? `: ${stderr.split("\n").slice(-3).join(" ").slice(0, 400)}` : ""}` : null);
      if (mapper.current) mapper.finish(failure ? "error" : undefined, failure ?? undefined);
      else if (failure) {
        const error = {
          role: "assistant" as const,
          content: [],
          api: "anthropic-messages",
          provider: CLAUDE_CHAT_PROVIDER,
          model: this.backend.model,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "error" as const,
          errorMessage: failure,
          timestamp: this.now(),
        };
        this.sessionManager.appendMessage(error as never);
        this.emit({ type: "message_start", message: error });
        this.emit({ type: "message_end", message: error });
      }
      if (failure) this.log(`${this.cardId} claude turn failed: ${failure}`);
    }
    this.child = null;
    this.mapper = null;
    this.lastActivity = this.now();
    if (this.disposed) return;
    const next = this.aborted ? [] : this.queue.splice(0);
    if (next.length > 0) {
      this.emitQueue();
      try {
        this.startTurn(next.join("\n\n"));
        return;
      } catch (e) {
        this.log(`${this.cardId} queued claude turn failed to start: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.running = false;
    this.emit({ type: "agent_end", messages: [] });
  }

  private enqueueOrStart(message: string): { accepted: true; disposition: "started" | "queued" } {
    if (this.running) {
      this.queue.push(message);
      this.emitQueue();
      return { accepted: true, disposition: "queued" };
    }
    try {
      this.startTurn(message);
    } catch (e) {
      this.running = false;
      throw new KanbanError(`claude failed to start: ${e instanceof Error ? e.message : String(e)}`, "conflict");
    }
    return { accepted: true, disposition: "started" };
  }

  async send(command: ChatCommand): Promise<unknown> {
    if (this.disposed) throw new KanbanError(`chat session for '${this.cardId}' is not running`, "conflict");
    this.lastActivity = this.now();
    switch (command.type) {
      case "prompt":
        if (this.running && !command.streamingBehavior) throw new KanbanError("chat is streaming — send steer or followUp", "conflict");
        return this.enqueueOrStart(command.message);
      // claude -p cannot take input mid-run: steering lands as the next turn
      case "steer":
      case "followUp":
        return this.enqueueOrStart(command.message);
      case "setModel":
        if (command.provider !== CLAUDE_CHAT_PROVIDER || !isClaudeAlias(command.modelId)) {
          throw new KanbanError(`unknown model '${command.provider}/${command.modelId}'`, "conflict");
        }
        this.backend = { ...this.backend, model: command.modelId };
        this.persistBackend();
        return this.state();
      case "setThinkingLevel":
        this.backend = { ...this.backend, effort: toClaudeEffort(command.level) };
        this.persistBackend();
        return this.state();
      case "abort":
        this.queue = [];
        if (this.child) {
          this.aborted = true;
          this.child.kill();
        }
        return { stopped: true };
      case "get_state":
        return this.state();
    }
  }

  state(): ChatState {
    const { messages, truncated } = projectEntries(this.sessionManager.getEntries());
    return {
      running: true,
      sessionId: this.sessionId,
      isStreaming: this.running,
      isCompacting: false,
      queued: { steering: [], followUp: [...this.queue] },
      model: { provider: CLAUDE_CHAT_PROVIDER, id: this.backend.model },
      thinkingLevel: this.backend.effort ?? "default",
      thinkingLevels: [...CLAUDE_EFFORT_LEVELS],
      supportsThinking: true,
      messages,
      messagesTruncated: truncated,
    };
  }

  historyFromDisk(): ChatState["messages"] {
    return projectEntries(this.sessionManager.getEntries()).messages;
  }

  onEvent(listener: (event: SdkChatEvent) => void): () => void {
    this.listeners.add(listener);
    for (const event of this.activeTools.values()) listener(event);
    return () => {
      this.listeners.delete(listener);
    };
  }

  activeToolEvents(): SdkChatEvent[] {
    return [...this.activeTools.values()];
  }

  streamingMessage(): unknown {
    return this.mapper?.current ?? undefined;
  }

  isAlive(): boolean {
    return !this.disposed;
  }

  async dispose(reason: ChatShutdownReason = "dispose"): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.idleTicker !== null) {
      clearInterval(this.idleTicker);
      this.idleTicker = null;
    }
    this.queue = [];
    if (this.child) {
      this.aborted = true;
      this.child.kill();
    }
    for (const listener of [...this.listeners]) {
      try {
        listener({ type: "shutdown", reason });
      } catch {
        /* listener already gone */
      }
    }
    this.listeners.clear();
    this.activeTools.clear();
    this.onDisposed(this);
    this.log(`${this.cardId} disposed`);
  }
}
