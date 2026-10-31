import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app } from "../src/app";
import { boot, type IncumbentHealth } from "../src/index";
import { consumeShareToken, mintShareToken } from "../src/restart";
import type { Task } from "../src/db";

const root = join(import.meta.dir, "..");

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
  // auto-archive defaults ON, so scrubbing is not enough: boot tests must force
  // KANBAN_AUTO_ARCHIVE=0 or an ungated sweep would open defaultDbPath() — the
  // production board — from inside bun test. Same story for the gh sync loop,
  // which would open the worktree's data dir and spawn a real `gh` every pass.
  const FORCED_VARS = ["KANBAN_AUTO_ARCHIVE", "KANBAN_GH_SYNC_MS"] as const;
  let savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    savedEnv = Object.fromEntries([...SCRUB_VARS, ...FORCED_VARS].map((k) => [k, process.env[k]]));
    for (const k of SCRUB_VARS) delete process.env[k];
    for (const k of FORCED_VARS) process.env[k] = "0";
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
      await boot({ port: 0, probePort: probeFree, checkHealth: health(null), autoArchive: false, dist });
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
      await boot({ port: 0, sharePort: true, probePort: probeOccupied, checkHealth: health(null), autoArchive: false, dist });
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
        autoArchive: false,
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

describe("gh sync loop hosted by boot (plan AC3 wiring)", () => {
  // hermetic: temp db, stub gh that appends its args to a marker file and fails —
  // the sync never needs real gh, and a failure pass writes nothing
  let dir = "";
  let dbFile = "";
  let marker = "";
  let stub = "";
  let saved: Record<string, string | undefined> = {};
  /** Stop fns from the current boot — drained before afterEach rmSync'd the db. */
  let stops: Array<() => void> = [];

  const bootHermetic = (): Promise<{ stopAutoReview: () => void; stopAutoArchive: () => void; stopGhSync: () => void }> =>
    boot({ port: 0, probePort: probeFree, checkHealth: health(null), autoReview: false, autoArchive: false, dist: emptyDist() });

  const teardown = (): void => {
    app.stop();
    for (const stop of stops) stop();
    stops = [];
  };

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "kanban-boot-gh-")));
    dbFile = join(dir, "t.db");
    marker = join(dir, "gh-calls.log");
    stub = join(dir, "fake-gh");
    Bun.write(stub, `#!/bin/sh\necho "$*" >> "${marker}"\nexit 1\n`);
    chmodSync(stub, 0o755);
    saved = {
      KANBAN_DB: process.env.KANBAN_DB,
      KANBAN_GH_BIN: process.env.KANBAN_GH_BIN,
      KANBAN_GH_SYNC_MS: process.env.KANBAN_GH_SYNC_MS,
      // the 4600 server's ambient env must never leak in: an agent loop or a
      // share flag here would spawn pi sessions / bind-share from bun test
      KANBAN_AUTO_REVIEW: process.env.KANBAN_AUTO_REVIEW,
      KANBAN_SHARE_PORT: process.env.KANBAN_SHARE_PORT,
      KANBAN_SHARE_TOKEN: process.env.KANBAN_SHARE_TOKEN,
      KANBAN_SHARE_FORCE: process.env.KANBAN_SHARE_FORCE,
    };
    delete process.env.KANBAN_AUTO_REVIEW;
    delete process.env.KANBAN_SHARE_PORT;
    delete process.env.KANBAN_SHARE_TOKEN;
    delete process.env.KANBAN_SHARE_FORCE;
    process.env.KANBAN_DB = dbFile;
    process.env.KANBAN_GH_BIN = stub;
  });

  afterEach(() => {
    teardown();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("KANBAN_GH_SYNC_MS=0 skips the loop — the stub gh is never spawned", async () => {
    process.env.KANBAN_GH_SYNC_MS = "0";
    const handle = await bootHermetic();
    stops.push(handle.stopAutoReview, handle.stopAutoArchive, handle.stopGhSync);
    expect(typeof handle.stopGhSync).toBe("function");
    await new Promise((r) => setTimeout(r, 150));
    expect(existsSync(marker)).toBe(false); // zero gh spawns
  });

  test("default ms boots the loop, syncs once, and stops cleanly", async () => {
    delete process.env.KANBAN_GH_SYNC_MS;
    const add = Bun.spawnSync(["bun", join(root, "src/cli.ts"), "add", "boot gh card", "--json"], {
      cwd: root,
      env: { ...process.env, KANBAN_GH_SYNC_MS: "0", NO_COLOR: "1" },
      stdout: "pipe",
    });
    const id = (JSON.parse(new TextDecoder().decode(add.stdout)) as Task).id;
    const attach = Bun.spawnSync(["bun", join(root, "src/cli.ts"), "attach", id, "https://github.com/o/r/pull/12"], {
      cwd: root,
      env: { ...process.env, KANBAN_GH_SYNC_MS: "0", NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(attach.exitCode).toBe(0);
    expect(new TextDecoder().decode(attach.stderr)).toBe("");

    const dist = emptyDist();
    const handle = await bootHermetic();
    stops.push(handle.stopAutoReview, handle.stopAutoArchive, handle.stopGhSync);
    // the immediate pass hits the stub (which exits 1 — a failed fetch writes
    // nothing); the marker file is the proof the loop ran
    for (let i = 0; i < 100 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(marker)).toBe(true);
    expect(await readFileSync(marker, "utf8")).toContain("pr view");
    rmSync(dist, { recursive: true, force: true });
  });
});
