import { describe, expect, test } from "bun:test";
import type { Engine } from "../src/db";
import {
  classifySpawnFailure,
  DEFAULT_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
  MIN_HINT_COOLDOWN_MS,
  parseWaitHintMs,
  EngineHealth,
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

  test("EngineHealth cools an account, expires, accumulates, resets on engine edit, clamps wait hints", () => {
    const health = new EngineHealth(DEFAULT_COOLDOWN_MS);
    const mk = (id: string, provider: string, extra: Partial<Engine> = {}): Engine => ({
      id, name: id.toUpperCase(), harness: "pi", provider, model: id, flags: [], seats: 1, enabled: true, updatedAt: 1000, ...extra,
    });
    const flash = mk("flash", "zcode");
    const turbo = mk("turbo", "zcode");
    const glm = mk("glm", "zai");
    const sonnet: Engine = { ...mk("sonnet", ""), harness: "claude", provider: undefined };

    const now = 5000;
    // 1. a quota on one engine cools every engine on the account — and only that account
    const inc1 = health.record(flash, "provider-quota", { now });
    expect(inc1).toMatchObject({ account: "pi:zcode", engineId: "flash", engineName: "FLASH", count: 1, firstSeenAt: now, lastSeenAt: now });
    expect(inc1.cooldownUntil).toBe(now + DEFAULT_COOLDOWN_MS);
    expect(health.isCooling(flash, now)).toBe(true);
    expect(health.isCooling(turbo, now)).toBe(true);
    expect(health.isCooling(glm, now)).toBe(false);
    expect(health.isCooling(sonnet, now)).toBe(false);
    expect(health.isCooling(turbo, now + DEFAULT_COOLDOWN_MS - 1)).toBe(true);
    expect(health.isCooling(turbo, now + DEFAULT_COOLDOWN_MS)).toBe(false);
    expect(health.nextExpiry(now)).toBe(now + DEFAULT_COOLDOWN_MS);
    expect(health.nextExpiry(now + DEFAULT_COOLDOWN_MS)).toBeNull();

    // 2. a second record accumulates on the account, firstSeenAt kept
    const inc2 = health.record(turbo, "provider-quota", { now: now + 1000 });
    expect(inc2).toMatchObject({ count: 2, firstSeenAt: now, lastSeenAt: now + 1000, engineId: "turbo" });

    // 3. editing an engine on the account is the manual reset
    health.syncEngines([flash, turbo, glm]); // unchanged: nothing resets
    expect(health.isCooling(flash, now + 1000)).toBe(true);
    health.syncEngines([{ ...turbo, updatedAt: 2000 }]);
    expect(health.incident(flash)).toBeNull();
    expect(health.isCooling(flash, now + 1000)).toBe(false);

    // 4. wait hints clamp to [1 min, 60 min]
    expect(health.record(glm, "provider-quota", { waitHintMs: 17_733_000, now }).cooldownUntil).toBe(now + MAX_COOLDOWN_MS);
    expect(health.record(sonnet, "auth", { waitHintMs: 5_000, now }).cooldownUntil).toBe(now + MIN_HINT_COOLDOWN_MS);
    expect(health.incidents().map((i) => i.account).sort()).toEqual(["claude:", "pi:zai"]);

    // 5. summaries: enabled engines only, cooling stamp while the account cools
    const summaries = health.summaries([glm, { ...flash, enabled: false }], now);
    expect(summaries).toEqual([
      { engineId: "glm", engineName: "GLM", account: "pi:zai", seats: 1, coolingUntil: now + MAX_COOLDOWN_MS, lastCause: "provider-quota" },
    ]);
  });
});
