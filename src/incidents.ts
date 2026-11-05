import type { SpawnResult } from "./autoreview";
import type { Engine } from "./db";
import { accountKey } from "./engines";

export type IncidentCause =
  | "provider-quota"
  | "auth"
  | "rate-limit"
  | "timeout"
  | "stall"
  | "no-output"
  | "other";

export const PROVIDER_LEVEL_CAUSES: ReadonlySet<IncidentCause> = new Set([
  "provider-quota",
  "auth",
]);

export const RETRYABLE_CAUSES: ReadonlySet<IncidentCause> = new Set([
  "rate-limit",
  "timeout",
  "stall",
  "no-output",
]);

export const DEFAULT_COOLDOWN_MS = 15 * 60_000;
export const MAX_COOLDOWN_MS = 60 * 60_000; // cap for provider wait hints
export const MIN_HINT_COOLDOWN_MS = 60_000; // floor for provider wait hints

/**
 * One account's incident record — what /activity and `kanban ps` render.
 * Provider-level incidents (quota, auth) exhaust the account, not one engine,
 * so the record is keyed by harness + provider and every engine on it cools.
 */
export interface EngineIncident {
  /** harness:provider — the cooling scope. */
  account: string;
  /** The engine whose spawn hit it (the others on the account cool with it). */
  engineId: string;
  engineName: string;
  cause: IncidentCause; // latest cause
  count: number; // incidents this process has seen
  firstSeenAt: number;
  lastSeenAt: number;
  cooldownUntil: number; // cooling ⟺ now < cooldownUntil
}

/** Per-engine aggregate for /activity + `kanban check`. */
export interface EngineHealthSummary {
  engineId: string;
  engineName: string;
  account: string;
  seats: number;
  /** Set while the engine's account is cooling. */
  coolingUntil?: number;
  lastCause?: IncidentCause;
}

/** Classification result: the bucket plus the provider's own wait hint, if it carried one. */
export interface ClassifiedFailure {
  cause: IncidentCause;
  waitHintMs: number | null;
}

const WAIT_HINT_RE = /\b(?=\d)(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?\b/g;

/** Extract a Go-style provider wait hint ("4h55m33s", "30s", "5m") from diagnostic text. Pure. */
export function parseWaitHintMs(text: string): number | null {
  WAIT_HINT_RE.lastIndex = 0;
  for (const m of text.matchAll(WAIT_HINT_RE)) {
    const [, h, min, sec] = m;
    if (h || min || sec) {
      return (
        (Number(h || 0) * 3600 + Number(min || 0) * 60 + Number(sec || 0)) *
        1000
      );
    }
  }
  return null;
}

const QUOTA_RE =
  /no active model quota|insufficient[ _-]?quota|quota reached|\b402\b/i;
const AUTH_RE =
  /\b401\b|\b403\b|unauthorized|forbidden|invalid[ _-]?api[ _-]?key|authentication/i;
const RATE_RE = /\b429\b|rate[ _-]?limit/i;
const STALL_RE = /stream stalled|no data for \d+ms/i;

/** Bucket a terminal spawn failure. Pure. */
export function classifySpawnFailure(
  result: SpawnResult,
  sessionLog: readonly string[],
): ClassifiedFailure {
  const haystack = [
    result.stderrTail ?? "",
    ...sessionLog.filter((l) => l.startsWith("✗ model error: ")),
  ].join("\n");

  const waitHintMs = parseWaitHintMs(haystack);

  if (result.timedOut) {
    return { cause: "timeout", waitHintMs };
  }
  if (result.stalled) {
    return { cause: "stall", waitHintMs };
  }

  if (QUOTA_RE.test(haystack)) {
    return { cause: "provider-quota", waitHintMs };
  }
  if (AUTH_RE.test(haystack)) {
    return { cause: "auth", waitHintMs };
  }
  if (RATE_RE.test(haystack)) {
    return { cause: "rate-limit", waitHintMs };
  }
  if (STALL_RE.test(haystack)) {
    return { cause: "stall", waitHintMs };
  }

  if (result.code === 0 && !sessionLog.some((l) => l.startsWith("text: "))) {
    return { cause: "no-output", waitHintMs };
  }

  return { cause: "other", waitHintMs };
}

/** In-memory engine-health registry (the loop owns one instance), keyed by account. */
export class EngineHealth {
  private readonly cooldownMs: number;
  private readonly byAccount = new Map<string, EngineIncident>();
  private readonly knownEngines = new Map<string, number>();

  constructor(cooldownMs: number = DEFAULT_COOLDOWN_MS) {
    this.cooldownMs = cooldownMs;
  }

  /** An engine edit is the manual reset: changing an engine clears its account's cooldown. */
  syncEngines(engines: Engine[]): void {
    for (const e of engines) {
      const known = this.knownEngines.get(e.id);
      if (known !== undefined && known !== e.updatedAt) this.byAccount.delete(accountKey(e));
      this.knownEngines.set(e.id, e.updatedAt);
    }
  }

  record(engine: Engine, cause: IncidentCause, opts?: { waitHintMs?: number; now?: number }): EngineIncident {
    const now = opts?.now ?? Date.now();
    this.knownEngines.set(engine.id, engine.updatedAt);
    const cooldownUntil =
      opts?.waitHintMs != null
        ? now + Math.max(MIN_HINT_COOLDOWN_MS, Math.min(MAX_COOLDOWN_MS, opts.waitHintMs))
        : now + this.cooldownMs;
    const account = accountKey(engine);
    const existing = this.byAccount.get(account);
    const record: EngineIncident = {
      account,
      engineId: engine.id,
      engineName: engine.name,
      cause,
      count: existing ? existing.count + 1 : 1,
      firstSeenAt: existing ? existing.firstSeenAt : now,
      lastSeenAt: now,
      cooldownUntil,
    };
    this.byAccount.set(account, record);
    return record;
  }

  /** Cooldown end for the engine's account, or null when it is healthy. */
  coolingUntil(engine: Engine, now: number = Date.now()): number | null {
    const inc = this.byAccount.get(accountKey(engine));
    return inc && now < inc.cooldownUntil ? inc.cooldownUntil : null;
  }

  isCooling(engine: Engine, now: number = Date.now()): boolean {
    return this.coolingUntil(engine, now) !== null;
  }

  incident(engine: Engine): EngineIncident | null {
    return this.byAccount.get(accountKey(engine)) ?? null;
  }

  incidents(): EngineIncident[] {
    return Array.from(this.byAccount.values()).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  /** The earliest future cooldown end — the loop re-scans then (a cooled engine requalifies). */
  nextExpiry(now: number = Date.now()): number | null {
    let next: number | null = null;
    for (const inc of this.byAccount.values()) {
      if (inc.cooldownUntil > now && (next === null || inc.cooldownUntil < next)) next = inc.cooldownUntil;
    }
    return next;
  }

  summaries(engines: Engine[], now: number = Date.now()): EngineHealthSummary[] {
    return engines
      .filter((e) => e.enabled)
      .map((e) => {
        const inc = this.byAccount.get(accountKey(e));
        const until = this.coolingUntil(e, now);
        return {
          engineId: e.id,
          engineName: e.name,
          account: accountKey(e),
          seats: e.seats,
          ...(until !== null ? { coolingUntil: until } : {}),
          ...(inc ? { lastCause: inc.cause } : {}),
        };
      });
  }
}
