import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "../src/app";
import { boot, type IncumbentHealth } from "../src/index";
import { consumeShareToken, mintShareToken } from "../src/restart";

// ---- seams ------------------------------------------------------------------

const probeFree = async () => false;
const probeOccupied = async () => true;
const health = (h: IncumbentHealth | null) => async () => h;

// refusal paths throw before any binding, so they never touch the app routes;
// accept paths bind an ephemeral port — run those LAST, then stop the app.

describe("one-shot share token (restart.ts)", () => {
  test("a mint vouches exactly once, then it is spent", () => {
    const token = mintShareToken();
    expect(consumeShareToken(token)).toBe(true);
    expect(consumeShareToken(token)).toBe(false); // spent — a leak cannot vouch twice
    expect(consumeShareToken("not-the-token")).toBe(false);
  });
});

describe("boot() occupied-port guard (seams per plan AC3)", () => {
  // guard tests must boot with the ambient env a user would have — not whatever
  // the test process inherited (an agent session spawned by the 4600 server
  // carries KANBAN_SHARE_PORT=1/TOKEN, which would flip E3's base guard into
  // the share path and silently bind; it also carries KANBAN_AUTO_REVIEW=1,
  // which would start a real agent loop against the production DB from inside
  // bun test — the 10/30 exit-143 session deaths)
  const SCRUB_VARS = ["KANBAN_SHARE_PORT", "KANBAN_SHARE_TOKEN", "KANBAN_SHARE_FORCE", "KANBAN_AUTO_REVIEW"] as const;
  let savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    savedEnv = Object.fromEntries(SCRUB_VARS.map((k) => [k, process.env[k]]));
    for (const k of SCRUB_VARS) delete process.env[k];
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("E1: share flag against a healthy foreign kanban is refused", async () => {
    const foreign = health({ ok: true, booted: Date.now() });
    await expect(
      boot({ port: 4600, sharePort: true, probePort: probeOccupied, checkHealth: foreign, dist: emptyDist() }),
    ).rejects.toThrow(/held by a healthy kanban server \(booted .*\) — refusing to share/);
  });

  test("E1 error names the repro playbook and the force escape hatch", async () => {
    const foreign = health({ ok: true, booted: Date.now() });
    try {
      await boot({ port: 4600, sharePort: true, probePort: probeOccupied, checkHealth: foreign, dist: emptyDist() });
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("scripts/repro.sh");
      expect(msg).toContain("KANBAN_SHARE_FORCE=1");
    }
  });

  test("E2: share flag against a non-kanban listener is refused", async () => {
    await expect(
      boot({ port: 4600, sharePort: true, probePort: probeOccupied, checkHealth: health({ ok: false }), dist: emptyDist() }),
    ).rejects.toThrow(/held by a non-kanban server — refusing to share/);
  });

  test("E3: no share flag + occupied port is refused (base guard)", async () => {
    await expect(
      boot({ port: 4600, probePort: probeOccupied, checkHealth: health(null), dist: emptyDist() }),
    ).rejects.toThrow(/already has a server — stop it first/);
  });

  test("free port binds (first accept test — app stopped after)", async () => {
    const dist = emptyDist();
    try {
      await boot({ port: 0, probePort: probeFree, checkHealth: health(null), dist });
      const port = app.server!.port;
      expect(port).toBeGreaterThan(0);
      // real request through the bound socket — same stack production uses
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(await res.json()).toMatchObject({ ok: true });
      const spa = await fetch(`http://127.0.0.1:${port}/some/spa/route`);
      expect(await spa.text()).toContain("<title>t</title>");
    } finally {
      app.stop();
      rmSync(dist, { recursive: true, force: true });
    }
  });

  test("respawn race: occupant dies between probe and health check → bind anyway", async () => {
    const dist = emptyDist();
    try {
      await boot({ port: 0, sharePort: true, probePort: probeOccupied, checkHealth: health(null), dist });
      expect(app.server!.port).toBeGreaterThan(0);
    } finally {
      app.stop();
      rmSync(dist, { recursive: true, force: true });
    }
  });

  test("vouched share: incumbent granted → bind (self-respawn child path)", async () => {
    const dist = emptyDist();
    try {
      await boot({
        port: 0,
        sharePort: true,
        probePort: probeOccupied,
        checkHealth: health({ ok: true, share: "granted" }),
        dist,
      });
      expect(app.server!.port).toBeGreaterThan(0);
    } finally {
      app.stop();
      rmSync(dist, { recursive: true, force: true });
    }
  });
});

/** A dist stand-in so route registration is exercised without web/dist. */
function emptyDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "kanban-bootdist-"));
  Bun.write(join(dir, "index.html"), "<!doctype html><title>t</title>");
  return dir;
}
