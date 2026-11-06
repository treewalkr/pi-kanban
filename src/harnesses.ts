import { CLAUDE_MODELS } from "./claude";

/**
 * Harness registry + probes for Settings → Providers. A "provider" here is a
 * harness runtime the board spawns agents on (pi, Claude Code — more later),
 * not an LLM vendor: which vendor backs a pi engine is engine config, and the
 * per-vendor catalog lives nested under the pi harness in the panel.
 *
 * All probes are read-only, cached, and never block startup: the panel treats
 * a probe error as "unknown" rather than failing the tab.
 */

export interface HarnessProbe {
  id: string;
  label: string;
  status: "ready" | "missing";
  /** One line under the status headline: a version, or how to get the harness. */
  detail: string;
  /** Model aliases the engine editor may reference (`claude` resolves them at spawn). */
  models: { id: string; label: string; note: string }[];
}

/** The board's own runtime: agent children spawn as pi sessions by definition. */
export const PI_HARNESS: HarnessProbe = {
  id: "pi",
  label: "pi agent",
  status: "ready",
  detail: "the board's own agent runtime — spawned by serve",
  models: [],
};

const CLAUDE_INSTALL = "claude binary not on PATH — install with npm i -g @anthropic-ai/claude-code";

/** Test seam: the real probe shells out; the suite injects a fake. */
export type VersionRunner = (cmd: string, args: string[]) => Promise<string | null>;

/** Run `cmd args`, return trimmed stdout, or null when it fails or exceeds `timeoutMs`. */
async function runVersion(cmd: string, args: string[], timeoutMs = 4000): Promise<string | null> {
  try {
    const proc = Bun.spawn([cmd, ...args], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    try {
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      const trimmed = out.trim();
      return trimmed.length > 0 ? trimmed.split("\n")[0].slice(0, 120) : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

/**
 * Probe claude: on PATH and answering `--version` → ready. Auth is ambient (the
 * CLI's own login or ANTHROPIC_API_KEY) — there is no cheap honest auth probe,
 * so the panel says so instead of guessing.
 */
export async function probeClaude(which: (cmd: string) => string | null = Bun.which, run: VersionRunner = runVersion): Promise<HarnessProbe> {
  const path = which("claude");
  if (!path) return { id: "claude", label: "Claude Code", status: "missing", detail: CLAUDE_INSTALL, models: CLAUDE_MODELS };
  const version = await run("claude", ["--version"]);
  return {
    id: "claude",
    label: "Claude Code",
    status: "ready",
    detail: version ?? `claude at ${path} (version unknown)`,
    models: CLAUDE_MODELS,
  };
}

const PROBE_TTL_MS = 60_000;

let cache: { at: number; probes: HarnessProbe[] } | null = null;

/** All harnesses with a fresh-enough probe; `force` re-probes (the panel's refresh button). */
export async function listHarnesses(force = false): Promise<HarnessProbe[]> {
  if (!force && cache && Date.now() - cache.at < PROBE_TTL_MS) return cache.probes;
  const claude = await probeClaude();
  const probes = [PI_HARNESS, claude];
  cache = { at: Date.now(), probes };
  return probes;
}
