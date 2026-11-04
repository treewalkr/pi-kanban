import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { KanbanDb, type Task } from "../src/db";
import { scanServes, serveWarnings } from "../src/cli";
import { VERSION, headState } from "../src/version";
import { cli, dbFile, dir, fakeServe, healthyServe, root, useCliDb } from "./cli.helpers";

useCliDb();

test("stop: SIGTERMs a live kanban server and frees the port; quiet when none", async () => {
  const port = 4690 + (Date.now() % 200);
  const server = Bun.spawn(["bun", "src/index.ts"], {
    cwd: root,
    env: { ...process.env, KANBAN_DB: join(dir, "stop.db"), PORT: String(port) },
    stdout: "ignore",
    stderr: "ignore",
  });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      up = (await res.json()).ok === true;
    } catch {
      /* still booting */
    }
  }
  expect(up).toBe(true);

  const stopped = await cli("stop", "--port", String(port));
  expect(stopped.code).toBe(0);
  expect(stopped.stdout).toContain(`stopped the kanban server on port ${port}`);
  expect(await server.exited).toBe(0);

  const none = await cli("stop", "--port", String(port));
  expect(none.code).toBe(0);
  expect(none.stdout).toContain("no server listening");
}, 15_000);

test("triage: priority and blocked-by CLI flags, mv warning, ls glyphs, and show detail", async () => {
  const proj = "triage-cli-test";

  // Create blocker cards
  const b1Json = JSON.parse((await cli("add", "blocker one", "--project", proj, "--json")).stdout) as Task;
  const b2Json = JSON.parse((await cli("add", "blocker two", "--project", proj, "--json")).stdout) as Task;

  // Add card with --priority and multiple --blocked-by
  const depAdd = await cli(
    "add",
    "urgent dependent",
    "--project",
    proj,
    "--priority",
    "high",
    "--blocked-by",
    b1Json.id,
    "--blocked-by",
    b2Json.id,
    "--json",
  );
  expect(depAdd.code).toBe(0);
  const dep = JSON.parse(depAdd.stdout) as Task;
  expect(dep.priority).toBe("high");

  // show prints priority and blocked by lines
  const show1 = await cli("show", dep.id);
  expect(show1.code).toBe(0);
  expect(show1.stdout).toContain("priority: high");
  expect(show1.stdout).toContain(`blocked by: ${b1Json.id}  blocker one`);
  expect(show1.stdout).toContain(`blocked by: ${b2Json.id}  blocker two`);

  // blocker show prints blocking lines
  const showB1 = await cli("show", b1Json.id);
  expect(showB1.stdout).toContain(`blocking:   ${dep.id}  urgent dependent`);

  // show --json carries blockedBy and blocking
  const show1Json = JSON.parse((await cli("show", dep.id, "--json")).stdout) as Task & {
    blockedBy: string[];
    blocking: string[];
  };
  expect(show1Json.blockedBy).toEqual([b1Json.id, b2Json.id]);
  expect(show1Json.blocking).toEqual([]);

  // mv into plan warns about blockers and exits 0
  const mvPlan = await cli("mv", dep.id, "plan");
  expect(mvPlan.code).toBe(0);
  expect(mvPlan.stdout).toContain(`⚠ blocked by: ${b1Json.id}, ${b2Json.id}`);

  // ls glyphs: ▲ before title, ⊘ after title
  const lsOut = await cli("ls", "plan", "--project", proj);
  expect(lsOut.code).toBe(0);
  expect(lsOut.stdout).toContain("▲ urgent dependent ⊘");

  // ls --json carries priority and blockedBy
  const lsJson = JSON.parse((await cli("ls", "plan", "--project", proj, "--json")).stdout) as Array<
    Task & { blockedBy: string[] }
  >;
  const found = lsJson.find((t) => t.id === dep.id);
  expect(found?.priority).toBe("high");
  expect(found?.blockedBy).toEqual([b1Json.id, b2Json.id]);

  // edit --priority low --clear-blocked-by
  const edit1 = await cli("edit", dep.id, "--priority", "low", "--clear-blocked-by", "--json");
  expect(edit1.code).toBe(0);
  const edited = JSON.parse(edit1.stdout) as Task;
  expect(edited.priority).toBe("low");

  // show after clear has low priority and no blocked by
  const show2 = await cli("show", dep.id);
  expect(show2.stdout).toContain("priority: low");
  expect(show2.stdout).not.toContain("blocked by:");

  // edit --blocked-by replaces set
  const edit2 = await cli("edit", dep.id, "--blocked-by", b1Json.id);
  expect(edit2.code).toBe(0);

  // mv into implement warns with single blocker
  const mvImp = await cli("mv", dep.id, "implement");
  expect(mvImp.code).toBe(0);
  expect(mvImp.stdout).toContain(`⚠ blocked by: ${b1Json.id}`);

  // soft blocking: unblock by moving blocker to done
  await cli("mv", b1Json.id, "done");
  // now moving dep within implement does not warn
  const mvImpAgain = await cli("mv", dep.id, "implement");
  expect(mvImpAgain.stdout).not.toContain("⚠ blocked by:");
});

test("add --elaborate queues elaboration; elaborate re-queues; unknown id fails", async () => {
  // JSON add with --elaborate
  const addJson = await cli("add", "Fix login json", "--elaborate", "--json");
  expect(addJson.code).toBe(0);
  const taskJson = JSON.parse(addJson.stdout) as Task;
  expect(taskJson.title).toBe("Fix login json");

  // Plain add with --elaborate
  const addPlain = await cli("add", "Fix login plain", "--elaborate");
  expect(addPlain.code).toBe(0);
  expect(addPlain.stdout).toContain("Fix login plain");
  expect(addPlain.stdout).toContain("✨ elaboration queued — the auto-agent loop");

  const inspectDb = new KanbanDb(dbFile);
  try {
    const reqs = inspectDb.elaborationRequests();
    const reqIds = reqs.map((r) => r.taskId);
    expect(reqIds).toContain(taskJson.id);

    // clear elaboration for taskJson
    inspectDb.clearElaboration(taskJson.id);
    expect(inspectDb.elaborationRequests().map((r) => r.taskId)).not.toContain(taskJson.id);

    // re-queue via `kanban elaborate <id>`
    const elab = await cli("elaborate", taskJson.id);
    expect(elab.code).toBe(0);
    expect(elab.stdout).toContain(`elaboration queued for ${taskJson.id}`);
    expect(inspectDb.elaborationRequests().map((r) => r.taskId)).toContain(taskJson.id);

    // json elaborate
    const elabJson = await cli("elaborate", taskJson.id, "--json");
    expect(elabJson.code).toBe(0);
    expect(JSON.parse(elabJson.stdout)).toMatchObject({ id: taskJson.id });

    // unknown id fails
    const failElab = await cli("elaborate", "nope");
    expect(failElab.code).toBe(1);
    expect(failElab.stderr).toContain("no task matching 'nope'");
  } finally {
    inspectDb.close();
  }
});

test("moving a parent into done with active children warns, never blocks", async () => {
  const pRes = await cli("add", "parent card", "--json");
  const parent = JSON.parse(pRes.stdout) as Task;
  const cRes = await cli("add", "child card", "--parent", parent.id, "--json");
  const child = JSON.parse(cRes.stdout) as Task;

  const doneRes = await cli("done", parent.id);
  expect(doneRes.code).toBe(0);
  expect(doneRes.stdout).toContain(`warning: 1 children still active (${child.id}) — advance or archive them if the work is done`);

  const showRes = await cli("show", parent.id, "--json");
  expect(showRes.code).toBe(0);
  expect((JSON.parse(showRes.stdout) as Task).laneId).toBe("done");
});

test("done warning fires for mv, handoff and review --approve into done", async () => {
  // mv into done
  const p1 = JSON.parse((await cli("add", "p1", "--json")).stdout) as Task;
  const c1 = JSON.parse((await cli("add", "c1", "--parent", p1.id, "--json")).stdout) as Task;
  const mvRes = await cli("mv", p1.id, "done");
  expect(mvRes.code).toBe(0);
  expect(mvRes.stdout).toContain(`warning: 1 children still active (${c1.id}) — advance or archive them if the work is done`);

  // handoff into done
  const p2 = JSON.parse((await cli("add", "p2", "--json")).stdout) as Task;
  const c2 = JSON.parse((await cli("add", "c2", "--parent", p2.id, "--json")).stdout) as Task;
  const handoffRes = await cli("handoff", p2.id, "done", "--message", "done work");
  expect(handoffRes.code).toBe(0);
  expect(handoffRes.stdout).toContain(`warning: 1 children still active (${c2.id}) — advance or archive them if the work is done`);

  // review --approve into done
  const p3 = JSON.parse((await cli("add", "p3", "--lane", "review", "--json")).stdout) as Task;
  const c3 = JSON.parse((await cli("add", "c3", "--parent", p3.id, "--json")).stdout) as Task;
  const reviewRes = await cli("review", p3.id, "--approve");
  expect(reviewRes.code).toBe(0);
  expect(reviewRes.stdout).toContain(`warning: 1 children still active (${c3.id}) — advance or archive them if the work is done`);

  // verify children untouched
  const c1Show = JSON.parse((await cli("show", c1.id, "--json")).stdout) as Task;
  const c2Show = JSON.parse((await cli("show", c2.id, "--json")).stdout) as Task;
  const c3Show = JSON.parse((await cli("show", c3.id, "--json")).stdout) as Task;
  expect(c1Show.laneId).toBe(c1.laneId);
  expect(c2Show.laneId).toBe(c2.laneId);
  expect(c3Show.laneId).toBe(c3.laneId);
});

test("no done warning for childless cards or children in done/archive", async () => {
  // childless card
  const childless = JSON.parse((await cli("add", "childless", "--json")).stdout) as Task;
  const res1 = await cli("done", childless.id);
  expect(res1.code).toBe(0);
  expect(res1.stdout).not.toContain("warning:");

  // parent whose children are in Done and Archive
  const parent = JSON.parse((await cli("add", "parent-clean", "--json")).stdout) as Task;
  const cDone = JSON.parse((await cli("add", "cdone", "--parent", parent.id, "--lane", "done", "--json")).stdout) as Task;
  const cArchive = JSON.parse((await cli("add", "carchive", "--parent", parent.id, "--lane", "archive", "--json")).stdout) as Task;

  const res2 = await cli("done", parent.id);
  expect(res2.code).toBe(0);
  expect(res2.stdout).not.toContain("warning:");

  const pShow = JSON.parse((await cli("show", parent.id, "--json")).stdout) as Task;
  expect(pShow.laneId).toBe("done");
});

test("kanban check reports seeded violations and exits 0", async () => {
  const violDb = join(dir, "check-viol.db");
  const run = (...args: string[]) => {
    const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
      cwd: root,
      env: { ...process.env, KANBAN_DB: violDb, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).then(([stdout, stderr, code]) => ({ stdout, stderr, code }));
  };

  // 1. (a) done parent with active child
  const p1 = JSON.parse((await run("add", "parent-1", "--lane", "done", "--json")).stdout) as Task;
  const c1 = JSON.parse((await run("add", "child-1", "--parent", p1.id, "--lane", "plan", "--json")).stdout) as Task;

  // 2. (b) child behind parent (parent in implement with plan, child in backlog)
  const p2 = JSON.parse((await run("add", "parent-2", "--lane", "implement", "--json")).stdout) as Task;
  const planPath = join(dir, "p2-plan.md");
  writeFileSync(planPath, "# Plan for p2");
  await run("attach", p2.id, planPath);
  const c2 = JSON.parse((await run("add", "child-2", "--parent", p2.id, "--lane", "backlog", "--json")).stdout) as Task;

  // 3. (c) card in implement with no attached plan
  const card3 = JSON.parse((await run("add", "card-3", "--lane", "implement", "--json")).stdout) as Task;

  // pin --port at a fake healthy serve so check's serve checks stay quiet and deterministic
  const fake = healthyServe();
  try {
    const res = await run("check", "--port", String(fake.port));
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(`⚠ ${p1.id} done with active children: ${c1.id}`);
    expect(res.stdout).toContain(`⚠ ${c2.id} in backlog behind parent ${p2.id} (implement)`);
    expect(res.stdout).toContain(`⚠ ${p2.id} is an epic in implement — epics belong in Epics once approved`);
    expect(res.stdout).toContain(`⚠ ${card3.id} in implement with no attached plan`);

    const jsonRes = await run("check", "--json", "--port", String(fake.port));
    expect(jsonRes.code).toBe(0);
    expect(JSON.parse(jsonRes.stdout)).toEqual([
      {
        kind: "done-parent-active-children",
        cardId: p1.id,
        childIds: [c1.id],
      },
      {
        kind: "child-behind-parent",
        cardId: c2.id,
        parentId: p2.id,
        cardLaneId: "backlog",
        parentLaneId: "implement",
      },
      {
        kind: "missing-plan",
        cardId: card3.id,
        laneId: "implement",
      },
      {
        kind: "epic-in-workflow-lane",
        cardId: p2.id,
        laneId: "implement",
      },
    ]);
  } finally {
    fake.stop();
  }
});

test("kanban check on a clean board prints nothing and exits 0", async () => {
  const cleanDb = join(dir, "check-clean.db");
  const run = (...args: string[]) => {
    const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
      cwd: root,
      env: { ...process.env, KANBAN_DB: cleanDb, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).then(([stdout, stderr, code]) => ({ stdout, stderr, code }));
  };

  // healthy fake serve keeps the serve checks quiet — the clean-board promise holds
  const fake = healthyServe();
  try {
    const res = await run("check", "--port", String(fake.port));
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("");

    const jsonRes = await run("check", "--json", "--port", String(fake.port));
    expect(jsonRes.code).toBe(0);
    expect(JSON.parse(jsonRes.stdout)).toEqual([]);
  } finally {
    fake.stop();
  }
});

test("serveWarnings: down, stale, head-split, dirty, version-split, healthy", async () => {
  const local = headState()?.head;
  expect(local).toMatch(/^[0-9a-f]{40}$/); // tests run from the repo checkout
  const sha = "e".repeat(40);
  const kinds = async (port: number) => (await serveWarnings(port)).map((w) => w.kind);

  // healthy: boot commit === HEAD === this checkout → quiet
  const ok = healthyServe();
  expect(await kinds(ok.port)).toEqual([]);
  ok.stop();

  // stale: commits landed since boot (serve isn't this checkout's HEAD either → both fire)
  const stale = fakeServe({ version: VERSION, git: { commit: local, head: sha, dirty: false } });
  expect(await kinds(stale.port)).toEqual(["serve-stale", "serve-head-split"]);
  stale.stop();

  // dirty: uncommitted edits — running code may not match HEAD
  const dirty = fakeServe({ version: VERSION, git: { commit: local, head: local, dirty: true } });
  expect(await kinds(dirty.port)).toEqual(["serve-dirty"]);
  dirty.stop();

  // version split: symlinked cli newer than the running serve
  const split = fakeServe({ version: "0.0.1", git: { commit: local, head: local, dirty: false } });
  expect(await kinds(split.port)).toEqual(["serve-version-split"]);
  split.stop();

  // down: nothing listening
  const gone = healthyServe();
  const gonePort = gone.port;
  gone.stop();
  await new Promise((r) => setTimeout(r, 50));
  expect(await kinds(gonePort)).toEqual(["serve-down"]);
});

test("scanServes: vouched serves on any port; ok-only look-alikes rejected", async () => {
  // a real-shaped serve: /health with ok, pid, version
  const serve = fakeServe({ pid: 4242, version: VERSION, git: null });
  // a look-alike: answers ok:true but no pid/version (e.g. docker program-tracker on :4000)
  const lookalike = fakeServe({ service: "some-other-api" });
  try {
    const found = await scanServes();
    const hit = found.find((s) => s.port === serve.port);
    expect(hit?.pid).toBe(4242);
    expect(hit?.version).toBe(VERSION);
    expect(found.some((s) => s.port === lookalike.port)).toBe(false);
  } finally {
    serve.stop();
    lookalike.stop();
  }
});

test("ps lists serves with their live agent sessions; --json round-trips", async () => {
  const serve = fakeServe(
    { pid: 4242, version: VERSION, git: { commit: headState()?.head ?? "", head: headState()?.head ?? "", dirty: false } },
    {
      sessions: [{ taskId: "ab12cd", role: "builder", startedAt: Date.now() - 60_000, modelLabel: "glm-5.3" }],
      queued: [{ taskId: "ef34ab", role: "reviewer", enqueuedAt: Date.now() - 5_000 }],
    },
  );
  try {
    const res = await cli("ps");
    expect(res.code).toBe(0);
    expect(res.stdout).toContain(`:${serve.port}`);
    expect(res.stdout).toContain("pid 4242");
    expect(res.stdout).toContain("ab12cd");
    expect(res.stdout).toContain("builder");
    expect(res.stdout).toContain("queued  ef34ab");

    const jsonRes = await cli("ps", "--json");
    expect(jsonRes.code).toBe(0);
    const data = JSON.parse(jsonRes.stdout) as {
      serves: { port: number; pid: number; sessions: { taskId: string }[]; queued: { taskId: string }[] }[];
      abandonedLeases: unknown[];
    };
    const entry = data.serves.find((s) => s.port === serve.port);
    expect(entry?.pid).toBe(4242);
    expect(entry?.sessions.map((s) => s.taskId)).toEqual(["ab12cd"]);
    expect(entry?.queued.map((q) => q.taskId)).toEqual(["ef34ab"]);
    expect(data.abandonedLeases).toEqual([]);
  } finally {
    serve.stop();
  }
});

test("ps renders an incidents block per account; --json round-trips", async () => {
  const now = Date.now();
  const serve = fakeServe(
    { pid: 4243, version: VERSION, git: null },
    {
      incidents: [
        {
          account: "pi:zcode",
          engineId: "flash",
          engineName: "GLM Flash",
          cause: "provider-quota",
          count: 3,
          firstSeenAt: now - 12 * 60_000,
          lastSeenAt: now - 2 * 60_000,
          cooldownUntil: now + 5 * 60_000, // cooling
        },
        {
          account: "pi:zai",
          engineId: "glm",
          engineName: "GLM",
          cause: "auth",
          count: 1,
          firstSeenAt: now - 30 * 60_000,
          lastSeenAt: now - 30 * 60_000,
          cooldownUntil: now - 1000, // cooldown expired
        },
      ],
      engines: [{ engineId: "flash", engineName: "GLM Flash", account: "pi:zcode", seats: 8, coolingUntil: now + 5 * 60_000, lastCause: "provider-quota" }],
    },
  );
  try {
    const res = await cli("ps");
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("incident  pi:zcode (via GLM Flash)  provider-quota ×3  first 12m ago  cooldown");
    expect(res.stdout).toContain("left");
    expect(res.stdout).toContain("incident  pi:zai (via GLM)  auth ×1  first 30m ago  cooldown expired");

    const jsonRes = await cli("ps", "--json");
    expect(jsonRes.code).toBe(0);
    const data = JSON.parse(jsonRes.stdout) as {
      serves: Array<{ port: number; incidents: Array<{ cause: string }>; engines: Array<{ seats: number }> }>;
    };
    const entry = data.serves.find((s) => s.port === serve.port)!;
    expect(entry.incidents[0].cause).toBe("provider-quota");
    expect(entry.engines[0].seats).toBe(8);
  } finally {
    serve.stop();
  }
});

test("check flags a cooling engine; healthy engines stay quiet", async () => {
  const head = headState()?.head ?? "";
  const cooling = fakeServe(
    { version: VERSION, git: { commit: head, head, dirty: false } },
    { engines: [{ engineId: "flash", engineName: "GLM Flash", account: "pi:zcode", seats: 8, coolingUntil: Date.now() + 60_000, lastCause: "provider-quota" }] },
  );
  try {
    const warnings = await serveWarnings(cooling.port);
    const w = warnings.find((w) => w.kind === "engine-cooling")!;
    expect(w.message).toContain("engine 'GLM Flash' is cooling (pi:zcode, last provider-quota)");
    const checkRes = await cli("check", "--port", String(cooling.port));
    expect(checkRes.code).toBe(0);
    expect(checkRes.stdout).toContain("is cooling");
  } finally {
    cooling.stop();
  }
  const healthy = fakeServe(
    { version: VERSION, git: { commit: head, head, dirty: false } },
    { engines: [{ engineId: "flash", engineName: "GLM Flash", account: "pi:zcode", seats: 8 }] },
  );
  try {
    expect((await serveWarnings(healthy.port)).some((w) => w.kind === "engine-cooling")).toBe(false);
  } finally {
    healthy.stop();
  }
});

test("engine verbs: add → ls → set → lane context --runs-on → explain → rm", async () => {
  const add = await cli("engine", "add", "GLM", "--provider", "zai", "--model", "glm-5.3", "--thinking", "max", "--seats", "2");
  expect(add.code).toBe(0);
  expect(add.stdout).toContain("glm  GLM  zai · glm-5.3 · max  2 seats");
  expect((await cli("engine", "add", "Sonnet", "--harness", "claude", "--model", "sonnet")).code).toBe(0);
  const bad = await cli("engine", "add", "Bad", "--harness", "claude", "--provider", "anthropic");
  expect(bad.code).not.toBe(0);

  const ctx = await cli("lane", "context", "implement", "--actor", "builder", "--runs-on", "glm,Sonnet");
  expect(ctx.code).toBe(0);
  expect(ctx.stdout).toContain("runs on GLM → Sonnet");
  const ls = await cli("engine", "ls");
  expect(ls.stdout).toContain("used by builder");

  expect((await cli("engine", "set", "glm", "--disable")).code).toBe(0);
  const why = await cli("explain", "builder", "--port", "1");
  expect(why.code).toBe(0);
  expect(why.stdout).toContain("lineup from actor lineup");
  expect(why.stdout).toContain("disabled");
  expect(why.stdout).toContain("next spawn → Sonnet");

  const rm = await cli("engine", "rm", "Sonnet");
  expect(rm.stdout).toContain("dropped from builder");
  const unknown = await cli("lane", "context", "implement", "--actor", "builder", "--runs-on", "ghost");
  expect(unknown.code).not.toBe(0);
});

test("ps flags a lease whose serve died mid-build", async () => {
  const shortLived = Bun.spawn(["sleep", "0"]);
  await shortLived.exited;
  const deadPid = shortLived.pid as number;
  const db = new KanbanDb(dbFile);
  try {
    db.tryTakeLease("zzps1", "builder", { pid: deadPid, bootId: Date.now() }, 60_000);
  } finally {
    db.close();
  }
  const res = await cli("ps");
  expect(res.code).toBe(0);
  expect(res.stdout).toContain("abandoned lease  zzps1");
  expect(res.stdout).toContain("resume manually");

  const jsonRes = await cli("ps", "--json");
  const data = JSON.parse(jsonRes.stdout) as { abandonedLeases: { taskId: string; role: string }[] };
  expect(data.abandonedLeases.some((l) => l.taskId === "zzps1" && l.role === "builder")).toBe(true);
});

/** A free scratch port for serve tests — above the repro range, never 4600. */
function freePort(): number {
  for (let p = 4641; p <= 4660; p++) {
    const out = Bun.spawnSync(["lsof", "-nP", `-iTCP:${p}`, "-sTCP:LISTEN"]);
    if (out.stdout.toString().trim() === "") return p;
  }
  throw new Error("no free port in 4641-4660 for serve test");
}

test("serve backgrounds itself; second serve is idempotent; stop kills it", async () => {
  const port = freePort();
  const log = `/tmp/kanban-serve-${port}.log`;
  try {
    const res = await cli("serve", "--port", String(port));
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("serve running in background");
    expect(res.stdout).toContain(`:${port}`);
    expect(res.stdout).toContain(log);

    const health = (await (
      await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) })
    ).json()) as { ok: boolean; pid: number };
    expect(health.ok).toBe(true);
    expect(res.stdout).toContain(`pid ${health.pid}`);

    // idempotent: starting again reports the running serve, exits 0
    const again = await cli("serve", "--port", String(port));
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("already running");
    expect(again.stdout).toContain(`pid ${health.pid}`);
  } finally {
    const stopped = await cli("stop", "--port", String(port));
    expect(stopped.code).toBe(0);
  }
});

test("serve refuses a port held by a non-kanban server", async () => {
  const squatter = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("hi") });
  try {
    const res = await cli("serve", "--port", String(squatter.port));
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("non-kanban");
  } finally {
    squatter.stop(true);
  }
});

test("mv promotes a backlog card to plan; show and ls confirm", async () => {
  const added = await cli("add", "promote me", "--lane", "backlog", "--json");
  expect(added.code).toBe(0);
  const task = JSON.parse(added.stdout) as Task;
  expect(task.laneId).toBe("backlog");

  const moved = await cli("mv", task.id, "plan");
  expect(moved.code).toBe(0);
  expect(moved.stdout).toContain("→ Plan");

  const shown = await cli("show", task.id);
  expect(shown.stdout).toMatch(/Plan \(plan\)/);

  const listed = await cli("ls", "plan", "--json");
  const planTasks = JSON.parse(listed.stdout) as Task[];
  expect(planTasks).toHaveLength(1);
  expect(planTasks[0].id).toBe(task.id);
});

test("kanban stats: board + card modes, --json roundtrip", async () => {
  // Usage error on multiple arguments
  const bad = await cli("stats", "a", "b");
  expect(bad.code).toBe(1);
  expect(bad.stderr).toContain("usage: kanban stats [id]");

  // Board mode --json
  const boardJsonRes = await cli("stats", "--json");
  expect(boardJsonRes.code).toBe(0);
  const boardPayload = JSON.parse(boardJsonRes.stdout);
  expect(typeof boardPayload.board.wip).toBe("number");
  expect(boardPayload.board.throughput).toHaveLength(8);

  // Human board mode
  const boardHuman = await cli("stats");
  expect(boardHuman.code).toBe(0);
  expect(boardHuman.stdout).toContain("wip:");
  expect(boardHuman.stdout).toContain("throughput (done/week):");
  expect(boardHuman.stdout).toContain("lane dwell:");
  expect(boardHuman.stdout).toContain("projects:");

  // Create a card and test card mode
  const addRes = await cli("add", "stats test card", "--lane", "plan", "--json");
  const task = JSON.parse(addRes.stdout) as Task;

  // Card mode --json
  const cardJsonRes = await cli("stats", task.id, "--json");
  expect(cardJsonRes.code).toBe(0);
  const cardStats = JSON.parse(cardJsonRes.stdout);
  expect(cardStats.taskId).toBe(task.id);
  expect(Array.isArray(cardStats.laneTimes)).toBe(true);
  expect(typeof cardStats.cycleMs).toBe("number");

  // Human card mode
  const cardHuman = await cli("stats", task.id);
  expect(cardHuman.code).toBe(0);
  expect(cardHuman.stdout).toContain("cycle:");
  expect(cardHuman.stdout).toContain("gate wait:");
  expect(cardHuman.stdout).toContain("lane times:");
  expect(cardHuman.stdout).toContain("loop health:");
});

test("link/unlink roundtrip: ✓ output, show --json, unlink --json", async () => {
  const addA = await cli("add", "Card Alpha", "--json");
  const a = JSON.parse(addA.stdout) as Task;
  const addB = await cli("add", "Card Beta", "--json");
  const b = JSON.parse(addB.stdout) as Task;

  // missing positional usage error
  const missA = await cli("link", a.id);
  expect(missA.code).toBe(1);
  expect(missA.stderr).toContain("usage: kanban link <id> <other-id>");

  const missUnlink = await cli("unlink", a.id);
  expect(missUnlink.code).toBe(1);
  expect(missUnlink.stderr).toContain("usage: kanban unlink <id> <other-id>");

  // link a b plain output
  const linkRes = await cli("link", a.id, b.id);
  expect(linkRes.code).toBe(0);
  expect(linkRes.stdout).toContain("✓ linked");
  expect(linkRes.stdout).toContain(a.id);
  expect(linkRes.stdout).toContain(b.id);

  // show --json has links containing b.id
  const showAJson = await cli("show", a.id, "--json");
  expect(showAJson.code).toBe(0);
  const showAData = JSON.parse(showAJson.stdout);
  expect(showAData.links).toContain(b.id);

  // plain show lists b.id AND title
  const showAPlain = await cli("show", a.id);
  expect(showAPlain.code).toBe(0);
  expect(showAPlain.stdout).toContain(b.id);
  expect(showAPlain.stdout).toContain("Card Beta");

  // unlink a b --json prints {"removed":true}
  const unlinkRes = await cli("unlink", a.id, b.id, "--json");
  expect(unlinkRes.code).toBe(0);
  expect(JSON.parse(unlinkRes.stdout)).toEqual({ removed: true });

  // re-unlink prints {"removed":false}, exit 0
  const reUnlinkRes = await cli("unlink", a.id, b.id, "--json");
  expect(reUnlinkRes.code).toBe(0);
  expect(JSON.parse(reUnlinkRes.stdout)).toEqual({ removed: false });

  // plain re-unlink prints were not linked
  const reUnlinkPlain = await cli("unlink", a.id, b.id);
  expect(reUnlinkPlain.code).toBe(0);
  expect(reUnlinkPlain.stdout).toContain("were not linked");
});

test("ws set → show → clear roundtrip", async () => {
  const addRes = await cli("add", "Workspace card", "--json");
  expect(addRes.code).toBe(0);
  const task = JSON.parse(addRes.stdout) as Task;

  // bare ws <id> -> exit 1, usage message
  const bareRes = await cli("ws", task.id);
  expect(bareRes.code).toBe(1);
  expect(bareRes.stderr).toContain("usage: kanban ws <id> <branch> | kanban ws <id> --clear");

  // both branch and --clear -> exit 1, usage message
  const bothRes = await cli("ws", task.id, "acme", "--clear");
  expect(bothRes.code).toBe(1);
  expect(bothRes.stderr).toContain("usage: kanban ws <id> <branch> | kanban ws <id> --clear");

  // ws <id> acme exit 0, stdout ✓ workspace acme recorded on <id>
  const setRes = await cli("ws", task.id, "acme");
  expect(setRes.code).toBe(0);
  expect(setRes.stdout).toContain(`✓ workspace acme recorded on ${task.id}`);

  // show --json -> workspace: "acme"
  const showJson = await cli("show", task.id, "--json");
  expect(showJson.code).toBe(0);
  expect(JSON.parse(showJson.stdout).workspace).toBe("acme");

  // show (text) prints workspace: acme
  const showText = await cli("show", task.id);
  expect(showText.code).toBe(0);
  expect(showText.stdout).toContain("workspace: acme");

  // --clear -> ✓ workspace cleared on <id> and workspace: null
  const clearRes = await cli("ws", task.id, "--clear");
  expect(clearRes.code).toBe(0);
  expect(clearRes.stdout).toContain(`✓ workspace cleared on ${task.id}`);

  const showClearedJson = await cli("show", task.id, "--json");
  expect(showClearedJson.code).toBe(0);
  expect(JSON.parse(showClearedJson.stdout).workspace).toBeNull();

  const showClearedText = await cli("show", task.id);
  expect(showClearedText.code).toBe(0);
  expect(showClearedText.stdout).toContain("workspace: —");
});




test("ls --tag filters AND across repeats in text output and --json alike", async () => {
  const a = await cli("add", "ui polish card", "--tag", "ui", "--json");
  const b = await cli("add", "ui and review-loop card", "--tag", "ui", "--tag", "review-loop", "--json");
  const c = await cli("add", "untagged card", "--json");
  const ui = JSON.parse(a.stdout) as Task;
  const both = JSON.parse(b.stdout) as Task;
  const none = JSON.parse(c.stdout) as Task;

  const text = await cli("ls", "--tag", "ui", "--tag", "review-loop");
  expect(text.code).toBe(0);
  expect(text.stdout).toContain(both.title);
  expect(text.stdout).not.toContain(ui.title);
  expect(text.stdout).not.toContain(none.title);
  expect(text.stdout).toContain("● Backlog  1");

  // full-board --json is uncapped — the caps only trim the human render
  const all = await cli("ls", "--json");
  const allTitles = (JSON.parse(all.stdout) as Task[]).map((t) => t.title);
  expect(allTitles).toContain(ui.title);
  expect(allTitles).toContain(both.title);
  expect(allTitles).toContain(none.title);

  const json = await cli("ls", "--tag", "ui", "--tag", "review-loop", "--json");
  expect(json.code).toBe(0);
  const rows = JSON.parse(json.stdout) as Task[];
  expect(rows.map((t) => t.id)).toEqual([both.id]);

  const singleJson = await cli("ls", "--tag", "ui", "--json");
  const singleRows = JSON.parse(singleJson.stdout) as Task[];
  expect(singleRows.map((t) => t.id).sort()).toEqual([ui.id, both.id].sort());
});

test("add --tag sets tags and show prints the tags row", async () => {
  const added = await cli("add", "tagged via cli", "--tag", "ui", "--tag", "review-loop", "--json");
  const task = JSON.parse(added.stdout) as Task;
  expect(task.tags).toEqual(["ui", "review-loop"]);

  const shown = await cli("show", task.id);
  expect(shown.stdout).toContain("tags:    #ui #review-loop");

  const listed = await cli("ls", "--json");
  const row = (JSON.parse(listed.stdout) as Task[]).find((t) => t.id === task.id)!;
  expect(row.tags).toEqual(["ui", "review-loop"]);
});

test("edit --tag replaces tags; --clear-tags empties them; empty edit still errors with --tag in usage", async () => {
  const added = await cli("add", "edit tags card", "--json");
  const task = JSON.parse(added.stdout) as Task;

  const replaced = await cli("edit", task.id, "--tag", "a", "--tag", "b", "--json");
  expect(replaced.code).toBe(0);
  expect((JSON.parse(replaced.stdout) as Task).tags).toEqual(["a", "b"]);

  const cleared = await cli("edit", task.id, "--clear-tags", "--json");
  expect(cleared.code).toBe(0);
  expect((JSON.parse(cleared.stdout) as Task).tags).toEqual([]);

  const empty = await cli("edit", task.id);
  expect(empty.code).toBe(1);
  expect(empty.stderr).toContain("--tag");
});

test("search --tag scopes results to tagged cards", async () => {
  await cli("add", "widget polish", "--tag", "ui", "--json");
  await cli("add", "polish the footer", "--json");

  const scoped = await cli("search", "ui", "--tag", "ui");
  expect(scoped.code).toBe(0);
  expect(scoped.stdout).toContain("tag: ui");
  expect(scoped.stdout).not.toContain("polish the footer");

  const json = await cli("search", "ui", "--tag", "ui", "--json");
  const results = JSON.parse(json.stdout) as { results: Array<{ id: string }> };
  expect(results.results.length).toBeGreaterThan(0);
  const board = JSON.parse((await cli("ls", "--json")).stdout) as Task[];
  const byId = new Map(board.map((t) => [t.id, t]));
  expect(results.results.every((r) => byId.get(r.id)?.tags.includes("ui"))).toBe(true);
});
