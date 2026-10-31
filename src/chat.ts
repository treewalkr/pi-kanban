/**
 * Resident chat sessions: one live pi SDK session per card, held in the serve
 * process (the auto-agent loop stays one-shot subprocess spawns — chat is a
 * deliberately parallel path). Sessions are deterministic
 * (`kanban-chat-<taskId>` in pi's default session dir for the serve cwd), so
 * resume needs no schema: `SessionManager.findById` on the next prompt, and
 * idle expiry disposes only the in-memory copy, never the file.
 *
 * Board discipline (AC5): the chat agent writes through the kanban CLI with
 * `--author pi-chat` only; verdict verbs are prompt-forbidden. Nothing here
 * mutates the board directly.
 */
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { skillActivationPrompt } from "./autoreview";
import { KanbanError, type KanbanDb, type Task } from "./db";
import { registerShutdown } from "./shutdown";

export const CHAT_SESSION_ID_PREFIX = "kanban-chat-";
export const DEFAULT_CHAT_IDLE_TIMEOUT_MS = 10 * 60_000;
export const HISTORY_MESSAGE_CAP = 100;
export const THINKING_BLOCK_CAP = 2_000;
export const SEED_NOTE_CAP = 4_000;
export const PROMPT_MAX_CHARS = 100_000;
export const CHAT_AUTHOR = "pi-chat";

/** Env knob: 0 disables idle expiry, invalid → default + console.warn. */
export function resolveChatIdleTimeoutMs(env: string | undefined = process.env.KANBAN_CHAT_IDLE_TIMEOUT_MS): number {
  if (env === undefined || env === "") return DEFAULT_CHAT_IDLE_TIMEOUT_MS;
  const raw = Number(env);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  console.warn(`[chat] invalid KANBAN_CHAT_IDLE_TIMEOUT_MS '${env}' — using default ${DEFAULT_CHAT_IDLE_TIMEOUT_MS}ms`);
  return DEFAULT_CHAT_IDLE_TIMEOUT_MS;
}

export type ChatShutdownReason = "idle" | "server" | "dispose";
export type ChatShutdownEvent = { type: "shutdown"; reason: ChatShutdownReason };
/** What handle listeners see: SDK session events, plus our in-band shutdown. */
export type SdkChatEvent = AgentSessionEvent | ChatShutdownEvent;

export type ChatCommand =
  | { type: "prompt"; message: string; streamingBehavior?: "steer" | "followUp" }
  | { type: "steer"; message: string }
  | { type: "followUp"; message: string }
  | { type: "abort" }
  | { type: "get_state" };

export interface ChatQueued { steering: string[]; followUp: string[] }

export type ChatBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; truncated?: boolean }
  | { type: "toolCall"; toolCallId: string; toolName: string; input: Record<string, unknown> };

export type ChatMessage =
  | { role: "user"; content: string; entryId: string }
  | { role: "assistant"; blocks: ChatBlock[]; model?: string; provider?: string; stopReason?: string; errorMessage?: string; entryId: string }
  | { role: "toolResult"; toolCallId: string; toolName?: string; isError?: boolean; entryId: string };

export interface ChatState {
  running: boolean; // an alive manager-held session exists
  sessionId: string | null; // "kanban-chat-<taskId>" when a session/file exists
  isStreaming: boolean;
  isCompacting: boolean;
  queued: ChatQueued;
  model: { provider: string; id: string } | null;
  thinkingLevel: string;
  messages: ChatMessage[]; // display projection, oldest first, last HISTORY_MESSAGE_CAP
  messagesTruncated: boolean; // true when older entries were cut
}

/** Test seam: creates (or fakes) the underlying SDK session. */
export type ChatSessionFactory = (opts: {
  cwd: string;
  sessionManager: import("@earendil-works/pi-coding-agent").SessionManager;
  appendSystemPrompt: string;
}) => Promise<AgentSession>;

/** The repo-local pi-kanban skill, wrapped in pi's own <skill> block. */
export const chatSkillPath = join(import.meta.dir, "..", "skills", "pi-kanban");

export function chatSystemAppend(task: Task): string {
  const title = task.title.length > 200 ? task.title.slice(0, 200) : task.title;
  const skill = skillActivationPrompt([chatSkillPath], (message) => console.warn(`[chat] ${message}`));
  return [
    `You are the chat agent for kanban card ${task.id} "${title}". The human is talking to you in the kanban UI; this repo is the board's serving repo.`,
    "",
    skill,
    "Rules:",
    `- Board writes go through the kanban CLI only (comment / handoff / mv / edit / attach / ws), always with --author ${CHAT_AUTHOR}. The card thread is the durable record.`,
    "- Never run kanban approve, kanban reject, kanban review, or kanban plan-review — verdicts and gates belong to the auto-agent loop and the human.",
    "- Never answer a question the human owes; if the card is parked waiting on them, say so.",
  ].join("\n");
}

/** Card context embedded in the first prompt of a fresh session (the seed). */
export function chatSeed(task: Task, laneName: string): string {
  const note = task.note.length > SEED_NOTE_CAP ? task.note.slice(0, SEED_NOTE_CAP) : task.note;
  return [
    `You are picking up kanban card ${task.id} "${task.title}" (lane: ${laneName}).`,
    "",
    note || "(no note)",
    "",
    `Full pickup context: run \`kanban brief ${task.id}\`.`,
  ].join("\n");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Minimal port of pi-web's `normalizeToolCalls`: legacy `id`/`name`/`arguments` → pinned names. */
function normalizeToolCallBlock(block: unknown): ChatBlock | null {
  if (!isObject(block) || block.type !== "toolCall") return null;
  const input = isObject(block.input)
    ? block.input
    : isObject(block.arguments)
      ? block.arguments
      : {};
  return {
    type: "toolCall",
    toolCallId: typeof block.toolCallId === "string" ? block.toolCallId : (typeof block.id === "string" ? block.id : ""),
    toolName: typeof block.toolName === "string" ? block.toolName : (typeof block.name === "string" ? block.name : ""),
    input,
  };
}

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!isObject(part)) return "";
        if (part.type === "text" && typeof part.text === "string") return part.text;
        if (part.type === "image") return "[image]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Session entries → bounded display projection (oldest first, tail-capped). */
export function projectEntries(entries: Iterable<{ type: string; id: string; message?: unknown }>): { messages: ChatMessage[]; truncated: boolean } {
  const messages: ChatMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!isObject(message)) continue;
    const role = message.role;
    if (role === "user") {
      messages.push({ role: "user", content: userText(message.content), entryId: entry.id });
    } else if (role === "assistant") {
      const blocks: ChatBlock[] = [];
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (!isObject(block)) continue;
          if (block.type === "text" && typeof block.text === "string") {
            blocks.push({ type: "text", text: block.text });
          } else if (block.type === "thinking" && typeof block.thinking === "string") {
            blocks.push(
              block.thinking.length > THINKING_BLOCK_CAP
                ? { type: "thinking", thinking: block.thinking.slice(0, THINKING_BLOCK_CAP), truncated: true }
                : { type: "thinking", thinking: block.thinking },
            );
          } else {
            const toolCall = normalizeToolCallBlock(block);
            if (toolCall) blocks.push(toolCall);
          }
        }
      }
      messages.push({
        role: "assistant",
        blocks,
        model: typeof message.model === "string" ? message.model : undefined,
        provider: typeof message.provider === "string" ? message.provider : undefined,
        stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
        errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
        entryId: entry.id,
      });
    } else if (role === "toolResult") {
      messages.push({
        role: "toolResult",
        toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : "",
        toolName: typeof message.toolName === "string" ? message.toolName : undefined,
        isError: message.isError === true,
        entryId: entry.id,
      });
    }
    // system / custom / bashExecution entries never render
  }
  const truncated = messages.length > HISTORY_MESSAGE_CAP;
  return { messages: truncated ? messages.slice(-HISTORY_MESSAGE_CAP) : messages, truncated };
}

function projectSessionEntries(sessionManager: import("@earendil-works/pi-coding-agent").SessionManager): { messages: ChatMessage[]; truncated: boolean } {
  return projectEntries(sessionManager.getEntries());
}

function hasUserMessage(sessionManager: import("@earendil-works/pi-coding-agent").SessionManager): boolean {
  return sessionManager.getEntries().some(
    (e) => e.type === "message" && isObject(e.message) && (e.message as { role?: unknown }).role === "user",
  );
}

/** The default factory: a real SDK session with no extension runtime (Decision 5). */
export const defaultChatSessionFactory: ChatSessionFactory = async ({ cwd, sessionManager, appendSystemPrompt }) => {
  const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), noExtensions: true, appendSystemPrompt: [appendSystemPrompt] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd, resourceLoader: loader, sessionManager });
  return session;
};

export interface ChatHandle {
  readonly cardId: string;
  readonly sessionId: string;
  send(command: ChatCommand): Promise<unknown>;
  state(): ChatState;
  historyFromDisk(): ChatState["messages"];
  onEvent(listener: (event: SdkChatEvent) => void): () => void;
  activeToolEvents(): SdkChatEvent[];
  streamingMessage(): unknown;
  isAlive(): boolean;
  dispose(): Promise<void>;
}

interface HandleOpts {
  cwd: string;
  cardId: string;
  sessionId: string;
  session: AgentSession;
  sessionManager: import("@earendil-works/pi-coding-agent").SessionManager;
  task: Task;
  laneName: string;
  idleTimeoutMs: number;
  now: () => number;
  log: (message: string) => void;
  onDisposed: (handle: ChatHandleImpl) => void;
}

const IDLE_TICK_MS = 250;

class ChatHandleImpl implements ChatHandle {
  readonly cardId: string;
  readonly sessionId: string;
  private readonly session: AgentSession;
  private readonly sessionManager: import("@earendil-works/pi-coding-agent").SessionManager;
  private readonly task: Task;
  private readonly laneName: string;
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly onDisposed: (handle: ChatHandleImpl) => void;
  private readonly listeners = new Set<(event: SdkChatEvent) => void>();
  private readonly activeTools = new Map<string, SdkChatEvent>();
  private readonly unsubscribeSession: () => void;
  private lastActivity: number;
  private idleTicker: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(opts: HandleOpts) {
    this.cardId = opts.cardId;
    this.sessionId = opts.sessionId;
    this.session = opts.session;
    this.sessionManager = opts.sessionManager;
    this.task = opts.task;
    this.laneName = opts.laneName;
    this.idleTimeoutMs = opts.idleTimeoutMs;
    this.now = opts.now;
    this.log = opts.log;
    this.onDisposed = opts.onDisposed;
    this.lastActivity = opts.now();
    this.unsubscribeSession = this.session.subscribe((event) => this.handleEvent(event));
    if (this.idleTimeoutMs > 0) {
      this.idleTicker = setInterval(() => this.checkIdle(), Math.min(this.idleTimeoutMs, IDLE_TICK_MS));
      this.idleTicker.unref?.();
    }
  }

  /** Active-tool replay rule (pi-web): latest start/update per call; end deletes; agent_end clears. */
  private handleEvent(event: AgentSessionEvent): void {
    if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
      this.activeTools.set(event.toolCallId, event);
    } else if (event.type === "tool_execution_end") {
      this.activeTools.delete(event.toolCallId);
      for (const id of [...this.activeTools.keys()]) {
        if (id.startsWith(`${event.toolCallId}/`)) this.activeTools.delete(id);
      }
    } else if (event.type === "agent_end" || event.type === "agent_settled" || event.type === "compaction_end") {
      if (event.type === "agent_end") this.activeTools.clear();
      this.touch();
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        /* a dead SSE listener must not break the session fan-out */
      }
    }
  }

  private touch(): void {
    this.lastActivity = this.now();
  }

  private checkIdle(): void {
    if (this.disposed) return;
    if (this.session.isStreaming || this.session.isCompacting) return; // never idle out mid-run
    if (this.now() - this.lastActivity < this.idleTimeoutMs) return;
    this.log(`${this.cardId} idle-expired`);
    void this.dispose("idle");
  }

  async send(command: ChatCommand): Promise<unknown> {
    if (this.disposed) throw new KanbanError(`chat session for '${this.cardId}' is not running`, "conflict");
    this.touch();
    switch (command.type) {
      case "prompt": {
        if (this.session.isStreaming && !command.streamingBehavior) {
          throw new KanbanError("chat is streaming — send steer or followUp", "conflict");
        }
        const seed = hasUserMessage(this.sessionManager) ? "" : `${chatSeed(this.task, this.laneName)}\n\n`;
        let disposition: "started" | "queued" | "handled" = "started";
        try {
          await this.session.prompt(`${seed}${command.message}`, {
            streamingBehavior: command.streamingBehavior,
            preflightResult: (d) => {
              disposition = d;
            },
          });
        } catch (e) {
          throw new KanbanError(e instanceof Error ? e.message : String(e), "conflict");
        }
        return { accepted: true, disposition };
      }
      case "steer": {
        try {
          const disposition = await this.session.steer(command.message);
          return { accepted: true, disposition };
        } catch (e) {
          throw new KanbanError(e instanceof Error ? e.message : String(e), "conflict");
        }
      }
      case "followUp": {
        try {
          const disposition = await this.session.followUp(command.message);
          return { accepted: true, disposition };
        } catch (e) {
          throw new KanbanError(e instanceof Error ? e.message : String(e), "conflict");
        }
      }
      case "abort":
        await this.session.abort();
        return { stopped: true };
      case "get_state":
        return this.state();
    }
  }

  state(): ChatState {
    const { messages, truncated } = projectSessionEntries(this.sessionManager);
    const model = this.session.model;
    return {
      running: true,
      sessionId: this.sessionId,
      isStreaming: this.session.isStreaming,
      isCompacting: this.session.isCompacting,
      queued: { steering: [...this.session.getSteeringMessages()], followUp: [...this.session.getFollowUpMessages()] },
      model: model ? { provider: String(model.provider), id: String(model.id) } : null,
      thinkingLevel: String(this.session.thinkingLevel ?? "off"),
      messages,
      messagesTruncated: truncated,
    };
  }

  historyFromDisk(): ChatState["messages"] {
    return projectSessionEntries(this.sessionManager).messages;
  }

  onEvent(listener: (event: SdkChatEvent) => void): () => void {
    this.listeners.add(listener);
    // Replay the running tools so a fresh subscriber sees what is in flight.
    for (const event of this.activeTools.values()) listener(event);
    return () => {
      this.listeners.delete(listener);
    };
  }

  activeToolEvents(): SdkChatEvent[] {
    return [...this.activeTools.values()];
  }

  streamingMessage(): unknown {
    return this.session.agent.state?.streamingMessage;
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
    this.unsubscribeSession();
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
    try {
      this.session.dispose();
    } catch {
      /* double dispose of the SDK session is harmless */
    }
  }
}

export class ChatManager {
  private readonly cwd: string;
  private readonly db: KanbanDb;
  private readonly sessionDir: string | undefined;
  private readonly log: (message: string) => void;
  private readonly createSession: ChatSessionFactory;
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;
  private readonly handles = new Map<string, ChatHandleImpl>();
  private readonly inflight = new Map<string, Promise<ChatHandleImpl>>();
  private shutdownRegistered = false;

  constructor(opts: {
    cwd: string;
    db: KanbanDb;
    sessionDir?: string; // pi session dir override (tests use a temp dir)
    log?: (message: string) => void;
    createSession?: ChatSessionFactory; // test seam; default builds the real SDK session
    idleTimeoutMs?: number; // default from KANBAN_CHAT_IDLE_TIMEOUT_MS; 0 disables
    now?: () => number; // test seam for idle expiry
  }) {
    this.cwd = opts.cwd;
    this.db = opts.db;
    this.sessionDir = opts.sessionDir;
    this.log = opts.log ?? ((message) => console.log(`[chat] ${message}`));
    this.createSession = opts.createSession ?? defaultChatSessionFactory;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? resolveChatIdleTimeoutMs();
    this.now = opts.now ?? (() => Date.now());
  }

  private async buildHandle(task: Task): Promise<ChatHandleImpl> {
    const sessionId = CHAT_SESSION_ID_PREFIX + task.id;
    const append = chatSystemAppend(task);
    const laneName = this.db.lanes().find((l) => l.id === task.laneId)?.name ?? task.laneId;
    const existingPath = SessionManager.findById(this.cwd, sessionId, this.sessionDir);
    const sessionManager = existingPath
      ? SessionManager.open(existingPath, this.sessionDir, this.cwd)
      : SessionManager.create(this.cwd, this.sessionDir, { id: sessionId });
    this.log(`${task.id} ${existingPath ? "resumed" : "created"}`);
    const session = await this.createSession({ cwd: this.cwd, sessionManager, appendSystemPrompt: append });
    return new ChatHandleImpl({
      cwd: this.cwd,
      cardId: task.id,
      sessionId,
      session,
      sessionManager,
      task,
      laneName,
      idleTimeoutMs: this.idleTimeoutMs,
      now: this.now,
      log: this.log,
      onDisposed: (handle) => {
        if (this.handles.get(task.id) === handle) this.handles.delete(task.id);
      },
    });
  }

  /** Resolve task → get-or-create one alive handle per card (concurrent gets share one creation). */
  async get(cardId: string): Promise<ChatHandle> {
    const alive = this.handles.get(cardId);
    if (alive) return alive;
    const pending = this.inflight.get(cardId);
    if (pending) return pending;
    const task = this.db.resolveTask(cardId); // 404 for unknown/ambiguous ids
    const creation = this.buildHandle(task).then((handle) => {
      this.handles.set(task.id, handle);
      if (!this.shutdownRegistered) {
        this.shutdownRegistered = true;
        registerShutdown(() => this.disposeAll());
      }
      return handle;
    });
    creation.finally(() => this.inflight.delete(cardId)).catch(() => {});
    this.inflight.set(cardId, creation);
    return creation;
  }

  /** Never creates. `cardId` must be the resolved id (peek does not resolve prefixes). */
  peek(cardId: string): ChatHandle | null {
    return this.handles.get(cardId) ?? null;
  }

  /** Alive handles, for /restart's in-flight guard. */
  sessionCount(): number {
    return this.handles.size;
  }

  /** Disk-backed history without touching the live map (the GET route's not-running path). */
  historyFromDisk(cardId: string): { sessionId: string | null; messages: ChatState["messages"]; messagesTruncated: boolean } {
    const sessionId = CHAT_SESSION_ID_PREFIX + this.db.resolveTask(cardId).id;
    const path = SessionManager.findById(this.cwd, sessionId, this.sessionDir);
    if (!path) return { sessionId: null, messages: [], messagesTruncated: false };
    const { messages, truncated } = projectSessionEntries(SessionManager.open(path, this.sessionDir, this.cwd));
    return { sessionId, messages, messagesTruncated: truncated };
  }

  async disposeAll(): Promise<void> {
    for (const handle of [...this.handles.values()]) {
      await handle.dispose("server");
    }
  }
}
