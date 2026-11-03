import type { SpawnResult } from "./autoreview";
import type { WorkerPool } from "./db";

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

/** One pool slot's incident record — what /activity and `kanban ps` render. */
export interface SlotIncident {
  poolId: string;
  poolName: string;
  slotIndex: number;
  cause: IncidentCause; // latest cause
  count: number; // incidents this process has seen
  firstSeenAt: number;
  lastSeenAt: number;
  cooldownUntil: number; // cooling ⟺ now < cooldownUntil
}

/** Per-pool aggregate for /activity + `kanban check`. */
export interface PoolHealthSummary {
  poolId: string;
  poolName: string;
  totalSlots: number;
  coolingSlots: number;
  lastCause?: IncidentCause; // newest incident in the pool, if any
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

/** In-memory slot-health registry (the loop owns one instance). */
export class SlotHealth {
  private readonly cooldownMs: number;
  private readonly incidentsMap = new Map<string, SlotIncident>();
  private readonly knownPools = new Map<string, number>();

  constructor(cooldownMs: number = DEFAULT_COOLDOWN_MS) {
    this.cooldownMs = cooldownMs;
  }

  /** Drop unknown pool ids; reset pools whose updatedAt changed */
  syncPools(pools: WorkerPool[]): void {
    const currentPoolIds = new Set(pools.map((p) => p.id));
    for (const poolId of this.knownPools.keys()) {
      if (!currentPoolIds.has(poolId)) {
        this.knownPools.delete(poolId);
        for (const key of this.incidentsMap.keys()) {
          if (key.startsWith(`${poolId}:`)) {
            this.incidentsMap.delete(key);
          }
        }
      }
    }
    for (const pool of pools) {
      const knownUpdatedAt = this.knownPools.get(pool.id);
      if (knownUpdatedAt !== undefined && knownUpdatedAt !== pool.updatedAt) {
        for (const key of this.incidentsMap.keys()) {
          if (key.startsWith(`${pool.id}:`)) {
            this.incidentsMap.delete(key);
          }
        }
      }
      this.knownPools.set(pool.id, pool.updatedAt);
    }
  }

  record(
    pool: WorkerPool,
    slotIndex: number,
    cause: IncidentCause,
    opts?: { waitHintMs?: number; now?: number },
  ): SlotIncident {
    const now = opts?.now ?? Date.now();
    this.knownPools.set(pool.id, pool.updatedAt);

    let cooldownUntil: number;
    if (opts?.waitHintMs != null) {
      const clamped = Math.max(
        MIN_HINT_COOLDOWN_MS,
        Math.min(MAX_COOLDOWN_MS, opts.waitHintMs),
      );
      cooldownUntil = now + clamped;
    } else {
      cooldownUntil = now + this.cooldownMs;
    }

    const key = `${pool.id}:${slotIndex}`;
    const existing = this.incidentsMap.get(key);

    const record: SlotIncident = {
      poolId: pool.id,
      poolName: pool.name,
      slotIndex,
      cause,
      count: existing ? existing.count + 1 : 1,
      firstSeenAt: existing ? existing.firstSeenAt : now,
      lastSeenAt: now,
      cooldownUntil,
    };

    this.incidentsMap.set(key, record);
    return record;
  }

  isCooling(poolId: string, slotIndex: number, now: number = Date.now()): boolean {
    const inc = this.incident(poolId, slotIndex);
    return inc ? now < inc.cooldownUntil : false;
  }

  incident(poolId: string, slotIndex: number): SlotIncident | null {
    return this.incidentsMap.get(`${poolId}:${slotIndex}`) ?? null;
  }

  incidents(): SlotIncident[] {
    return Array.from(this.incidentsMap.values()).sort(
      (a, b) => b.lastSeenAt - a.lastSeenAt,
    );
  }

  poolSummaries(pools: WorkerPool[], now: number = Date.now()): PoolHealthSummary[] {
    return pools
      .filter((p) => p.enabled)
      .map((pool) => {
        const totalSlots = pool.maxWorkers ?? pool.slots.length;
        let coolingSlots = 0;
        let newestIncident: SlotIncident | undefined;
        for (let i = 0; i < totalSlots; i++) {
          const inc = this.incident(pool.id, i);
          if (inc && now < inc.cooldownUntil) {
            coolingSlots++;
          }
          if (
            inc &&
            (!newestIncident || inc.lastSeenAt > newestIncident.lastSeenAt)
          ) {
            newestIncident = inc;
          }
        }
        return {
          poolId: pool.id,
          poolName: pool.name,
          totalSlots,
          coolingSlots,
          ...(newestIncident ? { lastCause: newestIncident.cause } : {}),
        };
      });
  }
}
