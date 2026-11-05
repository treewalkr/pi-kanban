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
import { resolveLineup } from "./engines";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { skillActivationPrompt } from "./autoreview";
import { chatSkillPath } from "./skill-activation";
import { KanbanError, type BoardOverview, type KanbanDb, type Task } from "./db";
import { registerShutdown } from "./shutdown";

export const CHAT_SESSION_ID_PREFIX = "kanban-chat-";
export const DEFAULT_CHAT_IDLE_TIMEOUT_MS = 10 * 60_000;
export const HISTORY_MESSAGE_CAP = 100;
export const THINKING_BLOCK_CAP = 2_000;
export const SEED_NOTE_CAP = 4_000;
export const PROMPT_MAX_CHARS = 100_000;
export const CHAT_AUTHOR = "pi-chat";

/** Pseudo-card id of the resident board manager chat — no card id can ever collide (the id alphabet has no "o"). */
export const BOARD_CHAT_ID = "board";
export const MANAGER_SESSION_ID = "kanban-manager";
export const MANAGER_AUTHOR = "pi-manager";

/** True for the plain board handle and its project-scoped form `board:<project>`. Pure shape check, no db access. */
export function isBoardHandle(cardId: string): boolean {
  return cardId === BOARD_CHAT_ID || cardId.startsWith(BOARD_CHAT_ID + ":");
}

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
  | { type: "setModel"; provider: string; modelId: string }
  | { type: "setThinkingLevel"; level: ChatThinkingLevel }
  | { type: "abort" }
  | { type: "get_state" };

/** The pi-agent-core ThinkingLevel union (types.d.ts), for route validation + UI. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ChatThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ChatQueued { steering: string[]; followUp: string[] }

export type ChatBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; truncated?: boolean }
  | { type: "toolCall"; toolCallId: string; toolName: string; input: Record<string, unknown> };

export type ChatMessage =
  | { role: "user"; content: string; at?: number; entryId: string }
  | { role: "assistant"; blocks: ChatBlock[]; model?: string; provider?: string; stopReason?: string; errorMessage?: string; at?: number; entryId: string }
  | { role: "toolResult"; toolCallId: string; toolName?: string; isError?: boolean; at?: number; entryId: string };

export interface ChatState {
  running: boolean; // an alive manager-held session exists
  sessionId: string | null; // "kanban-chat-<taskId>" when a session/file exists
  isStreaming: boolean;
  isCompacting: boolean;
  queued: ChatQueued;
  model: { provider: string; id: string } | null;
  thinkingLevel: string;
  /** Levels the CURRENT model supports (clamped by the SDK); canonical list when no session is live. */
  thinkingLevels: string[];
  supportsThinking: boolean;
  messages: ChatMessage[]; // display projection, oldest first, last HISTORY_MESSAGE_CAP
  messagesTruncated: boolean; // true when older entries were cut
}

/** Test seam: creates (or fakes) the underlying SDK session. */
export type ChatSessionFactory = (opts: {
  cwd: string;
  sessionManager: import("@earendil-works/pi-coding-agent").SessionManager;
  appendSystemPrompt: string;
}) => Promise<AgentSession>;

export { chatSkillPath };

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

/** The board manager's system append: identity, the skill, its view/dispatch/autonomy rules, gate discipline. Scoped to one project when given. */
export function managerSystemAppend(project?: string | null): string {
  const skill = skillActivationPrompt([chatSkillPath], (message) => console.warn(`[chat] ${message}`));
  const identity = project
    ? `You are the board manager (\`${MANAGER_AUTHOR}\`) for this kanban board, scoped to project \`${project}\`. The human is talking to you in the kanban UI; this repo is project \`${project}\`'s repo.`
    : `You are the board manager (\`${MANAGER_AUTHOR}\`) for this kanban board. The human is talking to you in the kanban UI; this repo is the board's serving repo.`;
  const view = project
    ? `- Your first prompt carries a snapshot of project \`${project}\`'s cards — lane counts, oldest card age per lane, what's parked in Waiting on you, the next proposal. It is a snapshot from when this session started; refresh with \`kanban ls --project ${project}\`, \`kanban next --project ${project}\`, \`kanban stats\` before drawing conclusions.`
    : "- Your first prompt carries a board overview — lane counts, oldest card age per lane, what's parked in Waiting on you, the next proposal. It is a snapshot from when this session started; refresh with `kanban stats`, `kanban ls <lane>`, `kanban next`, `kanban check` before drawing conclusions.";
  return [
    identity,
    "",
    skill,
    "View:",
    view,
    "Dispatch:",
    '- Lane workers are short-lived headless agents with a charter over one lane: `kanban worker run <lane> --focus "<what to look at>"` — backlog grooms (the only writable charter); waiting, plan, implement, review are report-only sweeps. Check results with `kanban worker ls` and relay the summaries; don\'t paste raw logs.',
    "Autonomy:",
    "- Propose before you dispatch: say which lane you'd sweep and why, and run it once the human says go. Never dispatch on your own initiative.",
    "Rules:",
    `- Board writes go through the kanban CLI only, always \`--author ${MANAGER_AUTHOR}\`; the card thread is the durable record. Never run \`kanban approve\`, \`kanban reject\`, \`kanban review\`, or \`kanban plan-review\` — verdicts and gates belong to the human — and never instruct a worker to run them. Never comment on cards in the Plan, Test + Implement, or Review lanes — the auto-agent loop owns those threads; report concerns to the human instead.`,
  ].join("\n");
}

/** The board overview rendered for the manager's seed prompt (free-form; the numbers are the contract). */
export function formatBoardOverview(o: BoardOverview): string {
  const lines: string[] = [];
  lines.push(`lanes: ${o.lanes.map((l) => `${l.name} ${l.count}`).join(" · ")}`);
  const aging = o.lanes.filter((l) => l.count > 0 && l.oldestDays > 0);
  if (aging.length > 0) {
    lines.push(`oldest in lane: ${aging.map((l) => `${l.name.toLowerCase()} ${l.oldestDays}d`).join(", ")}`);
  }
  if (o.waiting.length > 0) {
    lines.push(`waiting on you: ${o.waiting.map((w) => `${w.id} ${w.title} (${w.ageDays}d)`).join(" · ")}`);
  }
  lines.push(o.next ? `next: ${o.next.id} ${o.next.title}` : "next: nothing — the board is clear");
  lines.push(`blocked: ${o.blocked}`);
  return lines.join("\n");
}

/** The manager's first prompt: identity plus the board snapshot taken as the session starts (project-scoped when given). */
export function managerSeed(overview: string, project?: string | null): string {
  return [
    project
      ? `You are the board manager (\`${MANAGER_AUTHOR}\`), scoped to project \`${project}\`. Snapshot of the project's cards as this session starts:`
      : `You are the board manager (\`${MANAGER_AUTHOR}\`). Snapshot of the board as this session starts:`,
    "",
    overview,
    "",
    project
      ? `Refresh with \`kanban ls --project ${project}\` / \`kanban next --project ${project}\`. Ask what needs attention, or propose a worker sweep (\`kanban worker run <lane>\`).`
      : "Refresh with `kanban stats` / `kanban ls` / `kanban next`. Ask what needs attention, or propose a worker sweep (`kanban worker run <lane>`).",
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

const numOrUndef = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Per-message time (epoch ms): the pi message's own `timestamp`, else the session entry's ISO `timestamp`, else undefined (key omitted). */
function messageAt(message: Record<string, unknown>, entryTimestamp?: string): number | undefined {
  return numOrUndef(message.timestamp) ?? (typeof entryTimestamp === "string" && Number.isFinite(Date.parse(entryTimestamp)) ? Date.parse(entryTimestamp) : undefined);
}

/** Session entries → bounded display projection (oldest first, tail-capped). */
export function projectEntries(entries: Iterable<{ type: string; id: string; timestamp?: string; message?: unknown }>): { messages: ChatMessage[]; truncated: boolean } {
  const messages: ChatMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!isObject(message)) continue;
    const at = messageAt(message, entry.timestamp);
    const role = message.role;
    if (role === "user") {
      messages.push({ role: "user", content: userText(message.content), ...(at !== undefined ? { at } : {}), entryId: entry.id });
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
        ...(at !== undefined ? { at } : {}),
        entryId: entry.id,
      });
    } else if (role === "toolResult") {
      messages.push({
        role: "toolResult",
        toolCallId: typeof message.toolCallId === "string" ? message.toolCallId : "",
        toolName: typeof message.toolName === "string" ? message.toolName : undefined,
        isError: message.isError === true,
        ...(at !== undefined ? { at } : {}),
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
  /** The appended system prompt this handle's session was created with. */
  appendSystemPrompt: string;
  /** The first prompt's context (card note or board overview), computed at send time. */
  firstSeed: () => string;
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
  private readonly appendSystemPrompt: string;
  private readonly firstSeed: () => string;
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
    this.appendSystemPrompt = opts.appendSystemPrompt;
    this.firstSeed = opts.firstSeed;
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
        const seed = hasUserMessage(this.sessionManager) ? "" : `${this.firstSeed()}\n\n`;
        // Decision 7 (the rpc-mode contract): the send resolves when the SDK's
        // preflight callback fires — synchronous validation, auth, and queueing all
        // happen before it — not when the whole LLM + tool loop finishes. Run output
        // streams over /chat/:cardId/events; a run that fails after acceptance
        // surfaces there, not in the POST.
        return new Promise((resolve, reject) => {
          let settled = false;
          const accept = (disposition: "started" | "queued" | "handled") => {
            if (settled) return;
            settled = true;
            resolve({ accepted: true, disposition });
          };
          void this.session
            .prompt(`${seed}${command.message}`, {
              streamingBehavior: command.streamingBehavior,
              preflightResult: (disposition) => accept(disposition as "started" | "queued" | "handled"),
            })
            .then(
              () => accept("started"), // compat fallback: SDK resolved without invoking the callback
              (e: unknown) => {
                if (settled) return;
                settled = true;
                reject(new KanbanError(e instanceof Error ? e.message : String(e), "conflict"));
              },
            );
        });
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
      case "setModel": {
        // The runtime catalog honors models.json + configured auth; getModel
        // resolves undefined (not throws) for unknown ids, setModel throws when
        // no auth is configured. Both land as 409 conflict.
        const model = this.session.modelRuntime.getModel(command.provider, command.modelId);
        if (!model) throw new KanbanError(`unknown model '${command.provider}/${command.modelId}'`, "conflict");
        try {
          await this.session.setModel(model); // session-scoped: persists to the transcript, not global defaults
        } catch (e) {
          throw new KanbanError(e instanceof Error ? e.message : String(e), "conflict");
        }
        return this.state();
      }
      case "setThinkingLevel": {
        this.session.setThinkingLevel(command.level); // clamps to model capabilities
        return this.state();
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
      thinkingLevels: this.session.getAvailableThinkingLevels().map(String),
      supportsThinking: this.session.supportsThinking(),
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

  /**
   * Where a card's chat session lives: the project route's repo if routed, else
   * the serve cwd. Board handles resolve their project scope the same way —
   * plain `board` on the fallback, `board:<project>` on that project's repo.
   */
  private cwdFor(cardId: string): string {
    if (isBoardHandle(cardId)) return this.resolveBoardHandle(cardId).cwd;
    const task = this.db.resolveTask(cardId);
    return this.db.projectCwd(task.project) ?? this.cwd;
  }

  /**
   * The one board-handle scope resolver: `board` → { project: null, cwd: serve cwd };
   * `board:<project>` → that project's cwd (fallback: serve cwd). A blank scope is
   * invalid, an unknown project is not-found, and a non-board handle is a
   * programmer error. `get`, `peek`, `historyFromDisk`, and both GET chat routes
   * share it so a typo'd project never masquerades as an empty cold session.
   */
  resolveBoardHandle(cardId: string): { project: string | null; cwd: string } {
    if (cardId === BOARD_CHAT_ID) return { project: null, cwd: this.cwd };
    if (!cardId.startsWith(BOARD_CHAT_ID + ":")) {
      throw new KanbanError(`not a board chat handle: '${cardId}'`, "invalid");
    }
    const project = cardId.slice(BOARD_CHAT_ID.length + 1).trim();
    if (project === "") {
      throw new KanbanError("scoped board handle needs a project after ':' — use 'board' for the whole board", "invalid");
    }
    if (!this.db.listProjects().some((p) => p.name === project)) {
      throw new KanbanError(`unknown project '${project}'`, "not-found");
    }
    return { project, cwd: this.db.projectCwd(project) ?? this.cwd };
  }

  private async buildHandle(key: string, label: string, sessionId: string, appendSystemPrompt: string, firstSeed: () => string, cwd: string): Promise<ChatHandleImpl> {
    const existingPath = SessionManager.findById(cwd, sessionId, this.sessionDir);
    const sessionManager = existingPath
      ? SessionManager.open(existingPath, this.sessionDir, cwd)
      : SessionManager.create(cwd, this.sessionDir, { id: sessionId });
    this.log(`${label} ${existingPath ? "resumed" : "created"}`);
    const session = await this.createSession({ cwd, sessionManager, appendSystemPrompt });
    if (!existingPath) await this.seedEngine(label, session);
    return new ChatHandleImpl({
      cwd,
      cardId: label, // the log/display label; live-map identity is `key` (cwd for board handles)
      sessionId,
      session,
      sessionManager,
      appendSystemPrompt,
      firstSeed,
      idleTimeoutMs: this.idleTimeoutMs,
      now: this.now,
      log: this.log,
      onDisposed: (handle) => {
        if (this.handles.get(key) === handle) this.handles.delete(key);
      },
    });
  }

  /**
   * A new chat (board manager or card) starts on the first engine in the
   * manager's lineup the chat runtime can resolve: pi engines only, and only
   * providers the in-process runtime has auth for (no extension providers).
   * A resumed session keeps its saved model; the chips still switch live.
   */
  private async seedEngine(cardId: string, session: AgentSession): Promise<void> {
    const lineup = resolveLineup(this.db, "manager").engines;
    for (const engine of lineup) {
      if (!engine.enabled || engine.harness !== "pi" || !engine.provider || !engine.model) continue;
      try {
        const model = session.modelRuntime?.getModel(engine.provider, engine.model);
        if (!model) continue;
        await session.setModel(model);
        if (engine.thinking) session.setThinkingLevel(engine.thinking as never);
        this.log(`${cardId} seeded on engine ${engine.name}`);
        return;
      } catch {
        /* no auth for this provider — try the next engine */
      }
    }
  }

  /** Resolve task → get-or-create one alive handle per card (concurrent gets share one creation). Board handles memoize by resolved cwd. */
  async get(cardId: string): Promise<ChatHandle> {
    if (isBoardHandle(cardId)) {
      const { project, cwd } = this.resolveBoardHandle(cardId);
      return this.getOrCreate(cwd, cardId, cwd, () => ({
        sessionId: MANAGER_SESSION_ID,
        appendSystemPrompt: managerSystemAppend(project),
        firstSeed: () =>
          managerSeed(
            formatBoardOverview(project ? this.db.projectOverview(project) : this.db.boardOverview()),
            project,
          ),
      }));
    }
    const task = this.db.resolveTask(cardId); // 404 for unknown/ambiguous ids, before any map lookup
    return this.getOrCreate(task.id, task.id, this.cwdFor(task.id), () => {
      const laneName = this.db.lanes().find((l) => l.id === task.laneId)?.name ?? task.laneId;
      return {
        sessionId: CHAT_SESSION_ID_PREFIX + task.id,
        appendSystemPrompt: chatSystemAppend(task),
        firstSeed: () => chatSeed(task, laneName),
      };
    });
  }

  /** Get-or-create one alive handle per `key` (concurrent gets share one creation); `label` is the log/handle display id. */
  private async getOrCreate(key: string, label: string, cwd: string, spec: () => { sessionId: string; appendSystemPrompt: string; firstSeed: () => string }): Promise<ChatHandle> {
    const alive = this.handles.get(key);
    if (alive) return alive;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const { sessionId, appendSystemPrompt, firstSeed } = spec();
    const creation = this.buildHandle(key, label, sessionId, appendSystemPrompt, firstSeed, cwd).then((handle) => {
      this.handles.set(key, handle);
      if (!this.shutdownRegistered) {
        this.shutdownRegistered = true;
        registerShutdown(() => this.disposeAll());
      }
      return handle;
    });
    creation.finally(() => this.inflight.delete(key)).catch(() => {});
    this.inflight.set(key, creation);
    return creation;
  }

  /**
   * Never creates. Board handles resolve their project scope first (same
   * invalid/not-found errors as `get`) because the live map is keyed by cwd;
   * card handles get a plain lookup and must already be the resolved id.
   */
  peek(cardId: string): ChatHandle | null {
    if (isBoardHandle(cardId)) return this.handles.get(this.resolveBoardHandle(cardId).cwd) ?? null;
    return this.handles.get(cardId) ?? null;
  }

  /** Alive handles, for /restart's in-flight guard. */
  sessionCount(): number {
    return this.handles.size;
  }

  /** Disk-backed history without touching the live map (the GET route's not-running path). */
  historyFromDisk(cardId: string): { sessionId: string | null; messages: ChatState["messages"]; messagesTruncated: boolean } {
    const cwd = this.cwdFor(cardId); // same key the live handle would use
    const sessionId = isBoardHandle(cardId) ? MANAGER_SESSION_ID : CHAT_SESSION_ID_PREFIX + this.db.resolveTask(cardId).id;
    const path = SessionManager.findById(cwd, sessionId, this.sessionDir);
    if (!path) return { sessionId: null, messages: [], messagesTruncated: false };
    const { messages, truncated } = projectSessionEntries(SessionManager.open(path, this.sessionDir, cwd));
    return { sessionId, messages, messagesTruncated: truncated };
  }

  async disposeAll(): Promise<void> {
    for (const handle of [...this.handles.values()]) {
      await handle.dispose("server");
    }
  }
}
