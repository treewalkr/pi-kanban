import { describe, expect, test } from "bun:test";
import type { WorkerPool } from "../src/db";
import {
  classifySpawnFailure,
  DEFAULT_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
  MIN_HINT_COOLDOWN_MS,
  parseWaitHintMs,
  SlotHealth,
} from "../src/incidents";

describe("incidents", () => {
  test("classifies the observed provider-death strings (92f6g + case study #3)", () => {
    // 92f6g incident strings
    const r92f6g = classifySpawnFailure(
      {
        code: 1,
        stderrTail:
          "Start Plan has no active model quota (expired, pending or exhausted)\nNo fallback to another plan was made",
      },
      [],
    );
    expect(r92f6g.cause).toBe("provider-quota");
    expect(r92f6g.waitHintMs).toBeNull();

    // case study #3 string
    const rCase3 = classifySpawnFailure(
      {
        code: 1,
        stderrTail:
          "Quota reached. Please wait 4h55m33s. Next: switch models or try again after reset.",
      },
      [],
    );
    expect(rCase3.cause).toBe("provider-quota");
    expect(rCase3.waitHintMs).toBe(17_733_000);

    // insufficient_quota
    const rInsufficient = classifySpawnFailure(
      { code: 1, stderrTail: "Error: insufficient_quota for this project" },
      [],
    );
    expect(rInsufficient.cause).toBe("provider-quota");

    // HTTP 402
    const r402 = classifySpawnFailure(
      { code: 1, stderrTail: "Request failed with status HTTP 402 Payment Required" },
      [],
    );
    expect(r402.cause).toBe("provider-quota");
  });

  test("throttle strings classify as stall; auth, rate-limit, timeout, no-output, other bucket correctly", () => {
    // stream stalled in stderrTail
    const rStallStderr = classifySpawnFailure(
      { code: 1, stderrTail: "stream stalled: no data for 120000ms" },
      [],
    );
    expect(rStallStderr.cause).toBe("stall");
    expect(rStallStderr.waitHintMs).toBeNull();

    // stream stalled as a model error log line with empty stderr
    const rStallLog = classifySpawnFailure(
      { code: 1, stderrTail: "" },
      ["✗ model error: stream stalled: no data for 120000ms"],
    );
    expect(rStallLog.cause).toBe("stall");

    // auth: 401 / 403 / invalid api key
    expect(
      classifySpawnFailure({ code: 1, stderrTail: "Error: 401 Unauthorized" }, []).cause,
    ).toBe("auth");
    expect(
      classifySpawnFailure({ code: 1, stderrTail: "403 Forbidden" }, []).cause,
    ).toBe("auth");
    expect(
      classifySpawnFailure({ code: 1, stderrTail: "Invalid API key provided" }, []).cause,
    ).toBe("auth");

    // rate-limit: 429 / rate limit
    expect(
      classifySpawnFailure({ code: 1, stderrTail: "429 Too Many Requests" }, []).cause,
    ).toBe("rate-limit");
    expect(
      classifySpawnFailure({ code: 1, stderrTail: "Rate limit exceeded" }, []).cause,
    ).toBe("rate-limit");

    // timedOut / stalled flags beat stderr
    expect(
      classifySpawnFailure(
        { code: 1, timedOut: true, stderrTail: "401 Unauthorized" },
        [],
      ).cause,
    ).toBe("timeout");
    expect(
      classifySpawnFailure(
        { code: 1, stalled: true, stderrTail: "401 Unauthorized" },
        [],
      ).cause,
    ).toBe("stall");

    // exit 0 with no text: log line -> no-output
    expect(
      classifySpawnFailure({ code: 0 }, ["info: started"]).cause,
    ).toBe("no-output");
    // exit 0 WITH text: log line -> other
    expect(
      classifySpawnFailure({ code: 0 }, ["text: done"]).cause,
    ).toBe("other");

    // other
    const rOther = classifySpawnFailure(
      { code: 1, stderrTail: "Error: ECONNREFUSED" },
      [],
    );
    expect(rOther.cause).toBe("other");
    expect(rOther.waitHintMs).toBeNull();
  });

  test("parseWaitHintMs extracts Go-style durations and rejects look-alikes", () => {
    expect(
      parseWaitHintMs("… Please wait 4h55m33s …"),
    ).toBe(17_733_000);
    expect(parseWaitHintMs("wait 30s")).toBe(30_000);
    expect(parseWaitHintMs("5m")).toBe(300_000);
    expect(parseWaitHintMs("no data for 120000ms")).toBeNull();
    expect(parseWaitHintMs("HTTP 402")).toBeNull();
    expect(parseWaitHintMs("no hint here")).toBeNull();
  });

  test("SlotHealth cools a slot, expires, accumulates, resets on pool save, and clamps wait hints", () => {
    const health = new SlotHealth(DEFAULT_COOLDOWN_MS);
    const pool: WorkerPool = {
      id: "pool-1",
      name: "Builder",
      enabled: true,
      roles: ["builder"],
      slots: [{ model: "m1" }, { model: "m2" }],
      updatedAt: 1000,
    };

    const now = 5000;
    // 1. isCooling true until now + cooldownMs
    const inc1 = health.record(pool, 0, "provider-quota", { now });
    expect(inc1.count).toBe(1);
    expect(inc1.firstSeenAt).toBe(now);
    expect(inc1.lastSeenAt).toBe(now);
    expect(inc1.cooldownUntil).toBe(now + DEFAULT_COOLDOWN_MS);
    expect(health.isCooling(pool.id, 0, now)).toBe(true);
    expect(health.isCooling(pool.id, 0, now + DEFAULT_COOLDOWN_MS - 1)).toBe(true);
    expect(health.isCooling(pool.id, 0, now + DEFAULT_COOLDOWN_MS)).toBe(false);

    // 2. second record -> count: 2, firstSeenAt kept
    const now2 = now + 1000;
    const inc2 = health.record(pool, 0, "provider-quota", { now: now2 });
    expect(inc2.count).toBe(2);
    expect(inc2.firstSeenAt).toBe(now);
    expect(inc2.lastSeenAt).toBe(now2);
    expect(inc2.cooldownUntil).toBe(now2 + DEFAULT_COOLDOWN_MS);

    // 3. syncPools with bumped updatedAt clears
    health.syncPools([{ ...pool, updatedAt: 2000 }]);
    expect(health.incident(pool.id, 0)).toBeNull();
    expect(health.isCooling(pool.id, 0, now2)).toBe(false);

    // Re-record incident
    health.record(pool, 0, "provider-quota", { now: now2 });
    expect(health.incident(pool.id, 0)).not.toBeNull();

    // with a missing pool id drops
    health.syncPools([]);
    expect(health.incident(pool.id, 0)).toBeNull();

    // 4. record with waitHintMs: 17_733_000 -> cooldownUntil === now + 60 min (capped)
    const incCapped = health.record(pool, 0, "provider-quota", {
      waitHintMs: 17_733_000,
      now,
    });
    expect(incCapped.cooldownUntil).toBe(now + MAX_COOLDOWN_MS);

    // with waitHintMs: 5_000 -> now + 60_000 (floored)
    const incFloored = health.record(pool, 1, "provider-quota", {
      waitHintMs: 5_000,
      now,
    });
    expect(incFloored.cooldownUntil).toBe(now + MIN_HINT_COOLDOWN_MS);

    // 5. poolSummaries -> {totalSlots, coolingSlots, lastCause} for enabled pools only
    const disabledPool: WorkerPool = {
      id: "pool-disabled",
      name: "Disabled",
      enabled: false,
      roles: ["builder"],
      slots: [{ model: "m" }],
      updatedAt: 1000,
    };
    health.record(disabledPool, 0, "auth", { now });

    const summaries = health.poolSummaries([pool, disabledPool], now);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual({
      poolId: pool.id,
      poolName: pool.name,
      totalSlots: 2,
      coolingSlots: 2,
      lastCause: "provider-quota",
    });
  });
});
