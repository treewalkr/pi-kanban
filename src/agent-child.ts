import type { SpawnResult } from "./autoreview";

/** "8s" / "59s" / "1 min" / "20 min" */
export function durationFor(secs: number): string {
  return secs < 60 ? `${secs}s` : `${Math.round(secs / 60)} min`;
}

/** What one headless agent child (any runtime) needs to run and stream. */
export interface AgentChildInput {
  /** Full child command line (prompt included as a positional, or omitted when stdin carries it). */
  cmd: string[];
  /** Prompt piped to the child's stdin instead of argv (claude's variadic flags would eat a trailing positional). */
  stdin?: string;
  cwd: string;
  timeoutMs: number;
  stallMs: number;
  log: (message: string) => void;
  /** Streams one formatted output line from the running session. */
  emit: (line: string) => void;
  /** Registers the child's kill handle so shutdown can terminate in-flight sessions; returns an untrack cleanup function. */
  track: (kill: () => void) => () => void;
  /** One raw stdout JSONL line → one formatted log line, or null for noise. */
  formatEvent: (line: string) => string | null;
}

/**
 * The runtime-neutral child-runner behind every headless runtime (pi's
 * `--mode json`, claude-code's `-p --output-format stream-json`): kill/timeout/
 * stall timers, JSONL streaming through the runtime's formatter, stderr tail.
 */
export function runAgentChild(input: AgentChildInput): Promise<SpawnResult> {
  const { cmd, stdin, cwd, timeoutMs, stallMs, log, emit, track, formatEvent } = input;
  const proc = Bun.spawn({
    cmd,
    cwd,
    env: process.env,
    stdin: stdin !== undefined ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined && proc.stdin) {
    // small prompts (charters) fit the pipe buffer; no need to await flow control
    proc.stdin.write(stdin);
    void proc.stdin.end();
  }
  const untrack = track(() => proc.kill());
  const stderr = new Response(proc.stderr).text();
  let timedOut = false;
  let stalled = false;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;

  const clearTimers = () => {
    clearTimeout(timer);
    if (stallTimer) clearTimeout(stallTimer);
  };

  const timer = setTimeout(() => {
    timedOut = true;
    if (stallTimer) clearTimeout(stallTimer);
    proc.kill();
  }, timeoutMs);
  timer.unref?.();

  const resetStallTimer = () => {
    if (timedOut || stalled) return;
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      clearTimeout(timer);
      proc.kill();
    }, stallMs);
    stallTimer.unref?.();
  };

  resetStallTimer();

  // stream events as they arrive: manual LF split (readline mis-splits unicode)
  void (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          resetStallTimer();
        }
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = formatEvent(buf.slice(0, nl));
          if (line) emit(line);
          buf = buf.slice(nl + 1);
        }
      }
    } catch {
      // stream torn down (timeout kill / early exit) — exit handling below covers it
    }
  })();

  return proc.exited.finally(untrack).then(async (code) => {
    clearTimers();
    const tail = (await stderr).trim();
    if (stalled) log(`stalled — no output for ${durationFor(stallMs / 1000)}, killed`);
    else if (timedOut) log(`timed out after ${Math.round(timeoutMs / 60_000)} min, killed`);
    else if (code !== 0) {
      if (tail) log(`exited ${code}, stderr tail:\n${tail.slice(-1500)}`);
    }
    return {
      code: (timedOut || stalled) ? 1 : (code ?? 1),
      stalled: stalled || undefined,
      stalledAfterMs: stalled ? stallMs : undefined,
      timedOut: timedOut || undefined,
      stderrTail: tail ? tail.slice(-1500) : undefined,
    };
  });
}
