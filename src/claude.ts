import { runAgentChild } from "./agent-child";
import { skillActivationPrompt } from "./skill-activation";
import type { AgentConfig, AgentRole, Engine } from "./db";
import type { SpawnResult } from "./autoreview";

/**
 * The Claude Code harness: one headless `claude -p` child per spawn speaking
 * stream-json, mapped onto the SpawnResult + log-line vocabulary the loop
 * already consumes. The board contract is unchanged — charters still drive the
 * `kanban` CLI, so arming, gates and verdicts never learn which harness ran.
 *
 * Auth is ambient (the CLI's own login or ANTHROPIC_API_KEY); an engine never
 * carries a provider for claude. Its `thinking` is the `--effort` level.
 */

/** One alias the engine editor offers; claude resolves it to the current concrete model at spawn. */
export interface ClaudeModel {
  id: string;
  label: string;
  note: string;
}

export const CLAUDE_MODELS: ClaudeModel[] = [
  { id: "sonnet", label: "sonnet", note: "balanced" },
  { id: "opus", label: "opus", note: "strongest" },
  { id: "haiku", label: "haiku", note: "fastest — light work" },
];

export const CLAUDE_DEFAULT_MODEL = "sonnet";

/**
 * Tool allowlists, applied with `--permission-mode dontAsk` so an unapproved
 * tool is a denial and never hangs a headless spawn. Reading roles get
 * read-only git prefixes (`Bash(git:*)` would allow `git push`); everything
 * else builds, so it edits and runs commands — the same reach pi has.
 * Readers still revise the artifacts they write ({tmpFile} plans, reviews) —
 * the charters' self-check step — so Edit/MultiEdit ride with Write, which
 * already overwrites anything in the working dirs; shell writes stay denied.
 */
export const CLAUDE_READ_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "MultiEdit",
  "Bash(kanban:*)",
  "Bash(rg:*)",
  "Bash(git log:*)",
  "Bash(git diff:*)",
  "Bash(git show:*)",
  "Bash(git status:*)",
] as const;
export const CLAUDE_BUILD_TOOLS = ["Read", "Glob", "Grep", "Write", "Edit", "MultiEdit", "Bash"] as const;
const READING_ROLES: ReadonlySet<string> = new Set(["planner", "plan-reviewer", "reviewer", "elaborator"]);

/**
 * Claude Code flags for one spawn: model + effort from the engine, skills + context
 * injected into the appended system prompt (claude has no --skill flag), the
 * role's tool allowlist, then the engine's raw flags. The actor's pi-only
 * fields (`tools` filter syntax, `extraArgs`) are pi flags and never reach claude.
 */
export function claudeFlags(role: AgentRole, engine: Engine, cfg: AgentConfig | null, onWarn?: (message: string) => void): string[] {
  const args: string[] = ["--output-format", "stream-json", "--verbose", "--model", engine.model?.trim() || CLAUDE_DEFAULT_MODEL];
  // the charters write their artifacts to /tmp ({tmpFile}); claude fences writes
  // to the session's working directories, so /tmp joins them explicitly
  args.push("--add-dir", "/tmp");
  if (engine.thinking) args.push("--effort", engine.thinking);
  const activated = skillActivationPrompt(cfg?.skills ?? [], onWarn);
  const appended = [cfg?.context, activated].filter(Boolean).join("\n\n");
  if (appended) args.push("--append-system-prompt", appended);
  const tools = READING_ROLES.has(role) ? CLAUDE_READ_TOOLS : CLAUDE_BUILD_TOOLS;
  args.push("--permission-mode", "dontAsk", "--allowedTools", tools.join(","));
  args.push(...engine.flags);
  return args;
}

const compact = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b?.text === "string" ? b.text : "")).join(" ");
  return "";
}

/**
 * One stream-json event → the loop's log vocabulary, or null for noise.
 * Literal parity with formatPiEvent matters: deathReason and the lane-worker
 * summaries key off the `text: ` prefix.
 */
export function formatClaudeEvent(line: string): string | null {
  let ev: Record<string, any>;
  try {
    ev = JSON.parse(line);
  } catch {
    return null;
  }
  switch (ev.type) {
    case "system":
      if (ev.subtype !== "init") return null; // hook / status noise
      return typeof ev.model === "string" && ev.model ? `session started · model: ${ev.model}` : "session started";
    case "assistant": {
      const out: string[] = [];
      for (const block of Array.isArray(ev.message?.content) ? ev.message.content : []) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) out.push(`text: ${compact(block.text)}`);
        else if (block?.type === "tool_use") {
          const arg = block.input?.command ?? block.input?.file_path ?? block.input?.pattern ?? JSON.stringify(block.input ?? {});
          out.push(`→ ${block.name ?? "tool"}: ${compact(String(arg))}`);
        }
      }
      return out.length > 0 ? out.join("\n") : null;
    }
    case "user": {
      const errors = (Array.isArray(ev.message?.content) ? ev.message.content : []).filter(
        (b: any) => b?.type === "tool_result" && b?.is_error,
      );
      return errors.length > 0 ? `✗ tool error: ${compact(errors.map((b: any) => toolResultText(b.content)).join(" "))}` : null;
    }
    case "rate_limit_event": {
      const info = ev.rate_limit_info ?? {};
      // a rejected window is the account's quota: classifySpawnFailure reads
      // "✗ model error: " lines, so the cooldown covers every claude engine
      if (info.status === "rejected") return `✗ model error: quota reached — claude ${compact(String(info.rateLimitType ?? "usage"))} window exhausted`;
      if (info.status && info.status !== "allowed") return `⚠ rate limit ${compact(String(info.rateLimitType ?? ""))} (${info.status})`;
      return null;
    }
    case "result":
      if (ev.is_error) {
        const text = compact(String(typeof ev.result === "string" ? ev.result : ev.subtype ?? "error"));
        return /usage limit|limit reached/i.test(text) ? `✗ model error: quota reached — ${text}` : `✗ result: ${text}`;
      }
      return `settled${typeof ev.num_turns === "number" ? ` · ${ev.num_turns} turns` : ""}`;
    default:
      return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Claude's --session-id / --resume accept only UUIDs. */
export function isClaudeSessionId(id: string | undefined): boolean {
  return id !== undefined && UUID_RE.test(id);
}

export interface SpawnClaudeInput {
  cwd: string;
  sessionId: string;
  prompt: string;
  args: string[];
  /** Continue the session's transcript (`--resume`) instead of creating it. */
  resume?: boolean;
  timeoutMs: number;
  stallMs: number;
  log: (message: string) => void;
  emit: (line: string) => void;
  track: (kill: () => void) => () => void;
  /** Signals raw child output — bytes count even when the formatter drops them, proving a quiet session alive. */
  touch?: () => void;
}

/**
 * The claude spawn over the shared runner. The prompt travels on stdin —
 * `--allowedTools`'s variadic list would swallow a trailing positional. A
 * session that last ran on pi carries a pi-shaped id: a transcript can't cross
 * harnesses, so the resume starts a fresh session (the card thread is the
 * shared context) instead of failing the spawn.
 */
export function spawnClaude(input: SpawnClaudeInput): Promise<SpawnResult> {
  const { cwd, prompt, args, timeoutMs, stallMs, log, emit, track, touch } = input;
  let sid = input.sessionId;
  let resume = input.resume === true;
  if (!isClaudeSessionId(sid)) {
    if (resume) log("previous session ran on another harness — starting a fresh claude session");
    resume = false;
    sid = crypto.randomUUID();
  }
  return runAgentChild({
    cmd: ["claude", "-p", ...(resume ? ["--resume", sid] : ["--session-id", sid]), ...args],
    stdin: prompt,
    cwd,
    timeoutMs,
    stallMs,
    log,
    emit,
    track,
    touch,
    formatEvent: formatClaudeEvent,
  });
}
