import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { KanbanDb } from "../src/db";
import { startAutoReview } from "../src/autoreview";
import { VERSION } from "../src/version";

let dir = "";
let db: KanbanDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kanban-api-"));
  db = new KanbanDb(join(dir, "t.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("GET/PUT /agents/pause roundtrip; bad body 422", async () => {
  const app = createApp(db);
  const before = (await (await app.handle(new Request("http://localhost/agents/pause"))).json()) as { paused: boolean };
  expect(before.paused).toBe(false);

  const on = await app.handle(
    new Request("http://localhost/agents/pause", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paused: true }),
    }),
  );
  expect(on.status).toBe(200);
  expect(((await on.json()) as { paused: boolean }).paused).toBe(true);

  const bad = await app.handle(
    new Request("http://localhost/agents/pause", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paused: "yes" }),
    }),
  );
  expect(bad.status).toBe(422); // paused must be a boolean

  const off = await app.handle(
    new Request("http://localhost/agents/pause", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paused: false }),
    }),
  );
  expect(((await off.json()) as { paused: boolean }).paused).toBe(false);
});

test("/events streams an initial sync, then a change on API mutations", async () => {
  const app = createApp(db);
  const task = db.createTask({ title: "one" });

  const res = await app.handle(new Request("http://localhost/events"));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/event-stream");

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  // semantic `event: lane` frames interleave with `event: change` on the same stream
  const readChunk = async () => {
    for (;;) {
      const chunk = decoder.decode((await reader.read()).value);
      if (!chunk.startsWith("event: lane")) return chunk;
    }
  };

  expect(await readChunk()).toContain("event: change"); // fresh subscriber syncs immediately

  await app.handle(
    new Request(`http://localhost/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "renamed" }),
    }),
  );
  expect(await readChunk()).toContain("event: change");

  await reader.cancel(); // client disconnect unsubscribes without throwing
});

test("POST /tasks/:id/plan stores a version; GET returns the latest or 404", async () => {
  const app = createApp(db);
  const task = db.createTask({ title: "one" });

  const missing = await app.handle(new Request(`http://localhost/tasks/${task.id}/plan`));
  expect(missing.status).toBe(404);

  const post = await app.handle(
    new Request(`http://localhost/tasks/${task.id}/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "draft 1", source: "/tmp/p.md" }),
    }),
  );
  expect(post.status).toBe(201);
  expect(await post.json()).toMatchObject({ version: 1, content: "draft 1", source: "/tmp/p.md" });

  await app.handle(
    new Request(`http://localhost/tasks/${task.id}/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "draft 2" }),
    }),
  );
  const got = await app.handle(new Request(`http://localhost/tasks/${task.id}/plan`));
  expect(got.status).toBe(200);
  expect(await got.json()).toMatchObject({ version: 2, content: "draft 2", source: "" });

  const noTask = await app.handle(new Request("http://localhost/tasks/zzzzz/plan"));
  expect(noTask.status).toBe(404);
});

test("/files routes: attach named file, list latest, version history; reserved + bad names rejected", async () => {
  const app = createApp(db);
  const task = db.createTask({ title: "one" });
  const post = (body: unknown) =>
    app.handle(
      new Request(`http://localhost/tasks/${task.id}/files`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  const created = await post({ name: "design.md", content: "v1", source: "/tmp/design.md" });
  expect(created.status).toBe(201);
  expect(await created.json()).toMatchObject({ kind: "design.md", version: 1 });
  expect((await post({ name: "design.md", content: "v2" })).status).toBe(201);

  const planViaFiles = await post({ name: "plan", content: "# plan through the generic route" });
  expect(planViaFiles.status).toBe(201); // plan is the gate slot, writable like any file

  const reserved = await post({ name: "session", content: "spoof" });
  expect(reserved.status).toBe(400);
  expect(await reserved.json()).toMatchObject({ code: "invalid" });

  const badName = await post({ name: "Design Doc", content: "x" });
  expect(badName.status).toBe(400);
  expect(await badName.json()).toMatchObject({ code: "invalid" });

  const listed = await app.handle(new Request(`http://localhost/tasks/${task.id}/files`));
  expect(listed.status).toBe(200);
  const files = (await listed.json()) as Array<{ kind: string; version: number }>;
  expect(files.map((f) => [f.kind, f.version])).toEqual([
    ["design.md", 2],
    ["plan", 1],
  ]);

  const history = await app.handle(new Request(`http://localhost/tasks/${task.id}/files/design.md`));
  const versions = (await history.json()) as Array<{ version: number; content: string }>;
  expect(versions.map((v) => [v.version, v.content])).toEqual([
    [1, "v1"],
    [2, "v2"],
  ]);

  const unknown = await app.handle(new Request(`http://localhost/tasks/${task.id}/files/nope.md`));
  expect(unknown.status).toBe(200);
  expect(await unknown.json()).toEqual([]);
});

test("GET /tasks/:id/files/:name/diff returns a unified patch; errors mirror cat", async () => {
  const app = createApp(db);
  const task = db.createTask({ title: "one" });
  db.attach(task.id, "design", "content v1\n");
  db.attach(task.id, "design", "content v2\n");
  db.attach(task.id, "solo", "only version\n");

  const ok = await app.handle(new Request(`http://localhost/tasks/${task.id}/files/design/diff`));
  expect(ok.status).toBe(200);
  const body = (await ok.json()) as { name: string; from: { version: number }; to: { version: number }; patch: string };
  expect(body.name).toBe("design");
  expect(body.from.version).toBe(1);
  expect(body.to.version).toBe(2);
  expect(body.patch).toContain("-content v1");
  expect(body.patch).toContain("+content v2");

  const pair = await app.handle(
    new Request(`http://localhost/tasks/${task.id}/files/design/diff?from=1&to=2`),
  );
  expect(pair.status).toBe(200);
  expect(((await pair.json()) as { from: { version: number } }).from.version).toBe(1);

  const noName = await app.handle(new Request(`http://localhost/tasks/${task.id}/files/nope/diff`));
  expect(noName.status).toBe(404);
  expect(await noName.json()).toMatchObject({ error: "no file 'nope' on card — files: design, solo" });

  const single = await app.handle(new Request(`http://localhost/tasks/${task.id}/files/solo/diff`));
  expect(single.status).toBe(409);
  expect(await single.json()).toMatchObject({ error: "only v1 of 'solo' — nothing to diff" });

  const noV = await app.handle(new Request(`http://localhost/tasks/${task.id}/files/design/diff?from=3`));
  expect(noV.status).toBe(404);
  expect(await noV.json()).toMatchObject({ error: "no v3 of 'design' — versions v1–v2" });

  const badRange = await app.handle(
    new Request(`http://localhost/tasks/${task.id}/files/design/diff?from=2&to=1`),
  );
  expect(badRange.status).toBe(400);
  expect(await badRange.json()).toMatchObject({ error: "invalid range: v2 → v1 (from must be lower than to)" });
});

test("/board carries the latest plan per card", async () => {
  const app = createApp(db);
  const task = db.createTask({ title: "one" });
  db.attach(task.id, "plan", "v1");
  db.attach(task.id, "plan", "v2");

  const res = await app.handle(new Request("http://localhost/board"));
  const board = (await res.json()) as { plans: Record<string, { content: string; version: number }> };
  expect(board.plans[task.id]).toMatchObject({ content: "v2", version: 2 });
});

test("/board carries waiting; comment writes flip the state and notify /events", async () => {
  const app = createApp(db);
  const task = db.createTask({ title: "one", lane: "plan" });
  db.attach(task.id, "plan", "# p");
  db.planReview(task.id, { verdict: "pass", message: "checks out", author: "pi-plan-reviewer" });

  const res = await app.handle(new Request("http://localhost/board"));
  const board = (await res.json()) as { waiting: Record<string, string> };
  expect(board.waiting).toEqual({ [task.id]: "gate" });

  // the SSE change bus fires on comment writes, so live boards see the flip
  const events = await app.handle(new Request("http://localhost/events"));
  const reader = events.body!.getReader();
  // semantic `event: lane` frames interleave with `event: change` on the same stream
  const readChunk = async () => {
    for (;;) {
      const chunk = new TextDecoder().decode((await reader.read()).value);
      if (!chunk.startsWith("event: lane")) return chunk;
    }
  };
  expect(await readChunk()).toContain("event: change"); // fresh subscriber syncs immediately

  await app.handle(
    new Request(`http://localhost/tasks/${task.id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "looks good" }),
    }),
  );
  expect(await readChunk()).toContain("event: change");

  const after = await app.handle(new Request("http://localhost/board"));
  expect(((await after.json()) as { waiting: Record<string, string> }).waiting).toEqual({});
  await reader.cancel();
});

test("/board carries dead for review-lane cards after a session death", async () => {
  const app = createApp(db);
  const task = db.createTask({ title: "r", lane: "review" });
  db.createComment(task.id, {
    author: "pi-reviewer",
    kind: "comment",
    body: "session died: auto-review failed (exit 1) after 4s; comment on this card to re-trigger.",
  });
  const res = await app.handle(new Request("http://localhost/board"));
  const board = (await res.json()) as { waiting: Record<string, string> };
  expect(board.waiting).toEqual({ [task.id]: "dead" });
});

test("GET/POST /tasks/:id/comments thread a card; unknown task 404s, bad body 4xx", async () => {
  const app = createApp(db);
  const task = db.createTask({ title: "one" });

  const empty = await app.handle(new Request(`http://localhost/tasks/${task.id}/comments`));
  expect(empty.status).toBe(200);
  expect(await empty.json()).toEqual([]);

  const post = await app.handle(
    new Request(`http://localhost/tasks/${task.id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "picked this up", author: "pi-builder" }),
    }),
  );
  expect(post.status).toBe(201);
  expect(await post.json()).toMatchObject({ author: "pi-builder", kind: "comment", body: "picked this up" });

  const got = await app.handle(new Request(`http://localhost/tasks/${task.id}/comments`));
  expect(await got.json()).toHaveLength(1);

  const noTask = await app.handle(new Request("http://localhost/tasks/zzzzz/comments"));
  expect(noTask.status).toBe(404);

  const blank = await app.handle(
    new Request(`http://localhost/tasks/${task.id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "" }),
    }),
  );
  expect(blank.status).toBe(422);

  const badKind = await app.handle(
    new Request(`http://localhost/tasks/${task.id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "x", kind: "shout" }),
    }),
  );
  expect(badKind.status).toBe(422);
});

test("POST comment on a parked card returns it to its lane", async () => {
  const app = createApp(db);
  const task = db.createTask({ title: "hitl card", lane: "implement" });
  db.comment(task.id, { kind: "question", body: "which api?" });
  expect(db.resolveTask(task.id).laneId).toBe("waiting");
  expect(db.resolveTask(task.id).previousLane).toBe("implement");

  const reply = await app.handle(
    new Request(`http://localhost/tasks/${task.id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "use v2 api" }),
    }),
  );
  expect(reply.status).toBe(201);
  const comment = (await reply.json()) as any;
  expect(comment.body).toBe("use v2 api");
  expect(comment.author).toBe("user");

  const boardRes = await app.handle(new Request("http://localhost/board"));
  const board = (await boardRes.json()) as any;
  const returnedTask = board.tasks.find((t: any) => t.id === task.id);
  expect(returnedTask.laneId).toBe("implement");
  expect(returnedTask.previousLane).toBeNull();
});

test("POST /tasks/:id/approve and /reject: the plan gate over HTTP", async () => {
  const app = createApp(db);
  const task = db.createTask({ title: "gate me", lane: "plan" });
  db.attach(task.id, "plan", "# plan v1");

  const noFeedback = await app.handle(
    new Request(`http://localhost/tasks/${task.id}/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "" }),
    }),
  );
  expect(noFeedback.status).toBe(422); // validation: feedback required

  const rejected = await app.handle(
    new Request(`http://localhost/tasks/${task.id}/reject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "use SSE, not polling" }),
    }),
  );
  expect(rejected.status).toBe(201);
  expect(await rejected.json()).toMatchObject({ comment: { kind: "rejection", author: "user" }, returned: false });
  expect(db.resolveTask(task.id).laneId).toBe("plan"); // rejection stays in plan

  const approved = await app.handle(
    new Request(`http://localhost/tasks/${task.id}/approve`, { method: "POST" }),
  );
  expect(approved.status).toBe(201);
  const body = (await approved.json()) as { task: { laneId: string }; comment: { kind: string; body: string } };
  expect(body.task.laneId).toBe("implement");
  expect(body.comment.kind).toBe("approval");
  expect(body.comment.body).toContain("plan v1 approved");

  const again = await app.handle(
    new Request(`http://localhost/tasks/${task.id}/approve`, { method: "POST" }),
  );
  expect(again.status).toBe(409); // not in plan lane anymore
});

test("GET/PUT /agents roundtrip; bad role, unknown key, bad values 422", async () => {
  const app = createApp(db);

  const empty = await app.handle(new Request("http://localhost/agents"));
  expect(empty.status).toBe(200);
  expect(await empty.json()).toEqual({ planner: null, reviewer: null, builder: null, "plan-reviewer": null, elaborator: null, manager: null, worker: null });

  db.setEngine("opus", { name: "Opus", harness: "pi", provider: "anthropic", model: "claude-opus-4-5", thinking: "high" });
  db.setEngine("gpt", { name: "GPT", harness: "pi", provider: "openai", model: "gpt-5.2" });
  const put = await app.handle(
    new Request("http://localhost/agents/reviewer", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runsOn: ["opus", "gpt"],
        skills: ["~/.pi/agent/skills/scrutinize"],
        context: "we value perf",
        timeoutMs: 1_200_000,
      }),
    }),
  );
  expect(put.status).toBe(200);
  expect(await put.json()).toMatchObject({ runsOn: ["opus", "gpt"], context: "we value perf" });

  const got = await app.handle(new Request("http://localhost/agents"));
  expect(await got.json()).toMatchObject({ reviewer: { runsOn: ["opus", "gpt"] }, builder: null });

  const putPlanReviewer = await app.handle(
    new Request("http://localhost/agents/plan-reviewer", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runsOn: ["gpt"] }),
    }),
  );
  expect(putPlanReviewer.status).toBe(200);
  const gotAll = (await app.handle(new Request("http://localhost/agents"))).json() as Promise<{
    "plan-reviewer": { runsOn?: string[] } | null;
  }>;
  expect((await gotAll)["plan-reviewer"]).toEqual({ runsOn: ["gpt"] });

  const json = { headers: { "content-type": "application/json" } };
  const putBody = (body: unknown) => ({ ...json, body: JSON.stringify(body) });
  const badRole = await app.handle(new Request("http://localhost/agents/chief", { method: "PUT", ...putBody({}) }));
  expect(badRole.status).toBe(422);
  const unknownKey = await app.handle(
    new Request("http://localhost/agents/reviewer", { method: "PUT", ...putBody({ temperature: 0.2 }) }),
  );
  expect(unknownKey.status).toBe(200); // Elysia strips unknown fields rather than rejecting them
  expect(await unknownKey.json()).toEqual({});
  // a lineup naming no engine is a semantic error, not a schema one
  const ghost = await app.handle(
    new Request("http://localhost/agents/reviewer", { method: "PUT", ...putBody({ runsOn: ["ghost"] }) }),
  );
  expect(ghost.status).toBe(400);
  const shortTimeout = await app.handle(
    new Request("http://localhost/agents/reviewer", { method: "PUT", ...putBody({ timeoutMs: 5 }) }),
  );
  expect(shortTimeout.status).toBe(422);
  const longTimeout = await app.handle(
    new Request("http://localhost/agents/reviewer", { method: "PUT", ...putBody({ timeoutMs: 90_000_000 }) }),
  );
  expect(longTimeout.status).toBe(422);
  const twoHourTimeout = await app.handle(
    new Request("http://localhost/agents/reviewer", { method: "PUT", ...putBody({ timeoutMs: 7_200_000 }) }),
  );
  expect(twoHourTimeout.status).toBe(200);
  expect(await twoHourTimeout.json()).toMatchObject({ timeoutMs: 7_200_000 });

  // PUT is a full replace: an empty body clears the stored config
  const cleared = await app.handle(
    new Request("http://localhost/agents/reviewer", { method: "PUT", ...putBody({}) }),
  );
  expect(cleared.status).toBe(200);
  expect(await cleared.json()).toEqual({});
});

test("GET /workers lists runs without logs; PUT /agents/manager and /agents/worker store configs", async () => {
  const app = createApp(db);

  // seeded runs: newest first, log stripped
  const a = db.queueLaneWorker({ laneId: "backlog", focus: "first" });
  const b = db.queueLaneWorker({ laneId: "review", requestedBy: "pi-manager" });
  db.claimLaneWorker(a.id, "s-a", Date.now());
  db.finishLaneWorker(a.id, { status: "done", summary: "groomed", log: "text: groomed\n→ Bash" }, Date.now());

  const res = await app.handle(new Request("http://localhost/workers"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { workers: Array<Record<string, unknown>> };
  expect(body.workers).toHaveLength(2);
  expect(body.workers.map((w) => w.id)).toEqual([b.id, a.id]);
  expect(body.workers[0]).toMatchObject({ laneId: "review", status: "queued", requestedBy: "pi-manager" });
  expect(body.workers[1]).toMatchObject({ laneId: "backlog", status: "done", summary: "groomed" });
  for (const w of body.workers) expect("log" in w).toBe(false);

  // manager/worker configs persist through the same route as loop roles
  for (const role of ["manager", "worker"] as const) {
    const put = await app.handle(
      new Request(`http://localhost/agents/${role}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ context: role === "worker" ? "low" : "high", timeoutMs: 600_000 }),
      }),
    );
    expect(put.status).toBe(200);
    expect(db.agentConfig(role)).toMatchObject({ timeoutMs: 600_000 });
  }
  const got = await app.handle(new Request("http://localhost/agents"));
  expect(await got.json()).toMatchObject({
    manager: { context: "high" },
    worker: { context: "low" },
  });

  // empty PUT clears (full replace), same as loop roles
  const cleared = await app.handle(
    new Request("http://localhost/agents/worker", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  expect(cleared.status).toBe(200);
  expect(db.agentConfig("worker")).toEqual({});
});

test("GET /tasks/:id/sessions lists saved agent logs oldest-first", async () => {
  const app = createApp(db);
  const task = db.createTask({ title: "one" });

  const empty = await app.handle(new Request(`http://localhost/tasks/${task.id}/sessions`));
  expect(empty.status).toBe(200);
  expect(await empty.json()).toEqual([]);

  db.attach(task.id, "session", "pi-reviewer · now · 5s\nline one", "autoreview");
  db.attach(task.id, "session", "pi-builder · now · 3s\nline two", "autoreview");
  const got = await app.handle(new Request(`http://localhost/tasks/${task.id}/sessions`));
  const logs = (await got.json()) as Array<{ version: number; content: string }>;
  expect(logs.map((l) => l.version)).toEqual([1, 2]);
  expect(logs[0]!.content).toContain("pi-reviewer");

  const noTask = await app.handle(new Request("http://localhost/tasks/zzzzz/sessions"));
  expect(noTask.status).toBe(404);
});

test("GET /activity lists in-flight and queued agent jobs (none when idle)", async () => {
  const app = createApp(db);
  const res = await app.handle(new Request("http://localhost/activity"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ sessions: [], queued: [], incidents: [], engines: [] });
});

test("GET /health reports a boot stamp so clients can detect restarts", async () => {
  const app = createApp(db);
  const res = await app.handle(new Request("http://localhost/health"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    ok: boolean;
    booted: number;
    version: string;
    pid: number;
    git: { commit: string | null; head: string | null; dirty: boolean } | null;
  };
  expect(body.ok).toBe(true);
  expect(body.booted).toBeLessThanOrEqual(Date.now());
  // version + git let stale-serve detectors (header chip, kanban check) do their job
  expect(body.version).toBe(VERSION);
  expect(typeof body.pid).toBe("number");
  expect(body.git).not.toBeNull(); // tests run from the repo checkout
  expect(body.git?.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(body.git?.head).toMatch(/^[0-9a-f]{40}$/);
  expect(typeof body.git?.dirty).toBe("boolean");
});

test("POST /restart rejects cross-origin browser requests", async () => {
  const app = createApp(db);
  const res = await app.handle(
    new Request("http://localhost/restart", {
      method: "POST",
      headers: { origin: "https://evil.example" },
    }),
  );
  expect(res.status).toBe(403);
});

test("POST /restart accepts local origins and no-origin clients", async () => {
  const app = createApp(db, { onServeRestart: async () => {} });
  for (const origin of [undefined, "http://localhost:5174", "http://127.0.0.1:4600"]) {
    const res = await app.handle(
      new Request("http://localhost/restart", {
        method: "POST",
        headers: origin ? { origin } : {},
      }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ restarting: true });
  }
});

test("POST /restart fires the dev hook when KANBAN_DEV=1", async () => {
  const prev = process.env.KANBAN_DEV;
  process.env.KANBAN_DEV = "1";
  try {
    let fired = 0;
    const app = createApp(db, { onDevRestart: async () => void fired++ });
    const res = await app.handle(new Request("http://localhost/restart", { method: "POST" }));
    expect(res.status).toBe(202);
    expect(fired).toBe(0); // delayed so the response flushes before any reload
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(fired).toBe(1);
  } finally {
    if (prev === undefined) delete process.env.KANBAN_DEV;
    else process.env.KANBAN_DEV = prev;
  }
});

test("POST /restart fires the serve respawn hook in production", async () => {
  const prev = process.env.KANBAN_DEV;
  delete process.env.KANBAN_DEV;
  try {
    let fired = 0;
    const app = createApp(db, { onServeRestart: async () => void fired++ });
    const res = await app.handle(new Request("http://localhost/restart", { method: "POST" }));
    expect(res.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(fired).toBe(1);
  } finally {
    if (prev === undefined) delete process.env.KANBAN_DEV;
    else process.env.KANBAN_DEV = prev;
  }
});

test("POST /restart refuses while agent sessions run; force overrides", async () => {
  let inFlight = 1;
  const app = createApp(db, { onServeRestart: async () => {}, sessions: () => inFlight });
  const refused = await app.handle(new Request("http://localhost/restart", { method: "POST" }));
  expect(refused.status).toBe(409);
  const body = (await refused.json()) as { sessions: number; code: string };
  expect(body.code).toBe("sessions-in-flight");
  expect(body.sessions).toBe(1);
  const forced = await app.handle(
    new Request("http://localhost/restart?force=true", { method: "POST" }),
  );
  expect(forced.status).toBe(202);
  inFlight = 0;
  const plain = await app.handle(new Request("http://localhost/restart", { method: "POST" }));
  expect(plain.status).toBe(202);
});

test("GET /pi-skills serves the skill catalog", async () => {
  const app = createApp(db);
  const res = await app.handle(new Request("http://localhost/pi-skills"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { skills: Array<{ name: string; description: string; path: string }> };
  expect(Array.isArray(body.skills)).toBe(true);
  for (const s of body.skills) {
    expect(typeof s.name).toBe("string");
    expect(s.name.length).toBeGreaterThan(0);
    expect(typeof s.description).toBe("string");
    expect(typeof s.path).toBe("string");
    expect(s.path.length).toBeGreaterThan(0);
  }
  const localSkillsRoot = join(homedir(), ".pi", "agent", "skills");
  if (existsSync(localSkillsRoot)) {
    const names = body.skills.map((s) => s.name);
    expect(names).toContain("tdd");
    expect(names).toContain("caveman");
  }
});

test("POST /tasks/:id/resume: 202 with role+sessionId; 404/409s with exact errors", async () => {
  const app = createApp(db);

  // 1. Unknown card → 404 not-found
  const notFound = await app.handle(new Request("http://localhost/tasks/nonexistent/resume", { method: "POST" }));
  expect(notFound.status).toBe(404);
  expect(await notFound.json()).toEqual({ error: "no task matching 'nonexistent'", code: "not-found" });

  const task = db.createTask({ title: "resume-card", lane: "implement" });

  // 2. Agents paused → 409
  db.setAgentsPaused(true);
  const paused = await app.handle(new Request(`http://localhost/tasks/${task.id}/resume`, { method: "POST" }));
  expect(paused.status).toBe(409);
  expect(await paused.json()).toEqual({
    error: "agent sessions are paused — unpause the loop before resuming",
    code: "conflict",
  });
  db.setAgentsPaused(false);

  // 3. Card not waiting on dead session → 409
  const notDead = await app.handle(new Request(`http://localhost/tasks/${task.id}/resume`, { method: "POST" }));
  expect(notDead.status).toBe(409);
  expect(await notDead.json()).toEqual({
    error: `card '${task.id}' is not waiting on a dead session — comment on it to re-run instead`,
    code: "conflict",
  });

  // Post death comment to mark card dead
  db.createComment(task.id, { author: "pi-builder", kind: "comment", body: "session died: exit 1" });
  expect(db.waiting(task.id)).toBe("dead");

  // 4. Fresh lease row via tryTakeLease → 409
  db.tryTakeLease(task.id, "builder", { pid: 99999, bootId: 1 }, 60_000);
  const leaseHeld = await app.handle(new Request(`http://localhost/tasks/${task.id}/resume`, { method: "POST" }));
  expect(leaseHeld.status).toBe(409);
  expect(await leaseHeld.json()).toEqual({
    error: `card '${task.id}' already has an agent session in flight`,
    code: "conflict",
  });
  db.releaseLease(task.id, { pid: 99999, bootId: 1 });

  // 5. Dead card without pointer (cardSession is null) → 409
  const noPointer = await app.handle(new Request(`http://localhost/tasks/${task.id}/resume`, { method: "POST" }));
  expect(noPointer.status).toBe(409);
  expect(await noPointer.json()).toEqual({
    error: `card '${task.id}' has no recorded session to resume — comment on it to re-run instead`,
    code: "conflict",
  });

  // 6. Happy: death comment + setCardSession + POST → 202 { taskId, role: "builder", sessionId }
  db.setCardSession(task.id, "builder", "kanban-test-session-123");
  const happy = await app.handle(new Request(`http://localhost/tasks/${task.id}/resume`, { method: "POST" }));
  expect(happy.status).toBe(202);
  expect(await happy.json()).toEqual({
    taskId: task.id,
    role: "builder",
    sessionId: "kanban-test-session-123",
  });
  expect(db.resumeRequests()).toEqual([{ taskId: task.id, requestedAt: expect.any(Number) }]);
});

test("GET/PUT/DELETE /engines roundtrip; order; settings; schema 422, semantic 400, missing 404", async () => {
  const app = createApp(db);
  const json = { headers: { "content-type": "application/json" } };
  const putBody = (body: unknown) => ({ ...json, body: JSON.stringify(body) });

  const empty = await app.handle(new Request("http://localhost/engines"));
  expect(await empty.json()).toEqual({ engines: [], settings: { maxWorkers: 12, defaultEngine: null, harnesses: { pi: true, claude: true } } });

  const put = await app.handle(
    new Request("http://localhost/engines/glm", { method: "PUT", ...putBody({ name: "GLM", harness: "pi", provider: "zai", model: "glm-5.3", thinking: "max", seats: 3 }) }),
  );
  expect(put.status).toBe(200);
  expect(await put.json()).toMatchObject({ id: "glm", seats: 3, enabled: true, flags: [] });
  const claude = await app.handle(
    new Request("http://localhost/engines/sonnet", { method: "PUT", ...putBody({ name: "Sonnet", harness: "claude", model: "sonnet" }) }),
  );
  expect(claude.status).toBe(200);

  // schema 422: unknown harness, seats out of range
  for (const bad of [{ name: "x", harness: "codex" }, { name: "x", harness: "pi", seats: 0 }, { name: "x", harness: "pi", seats: 13 }]) {
    const res = await app.handle(new Request("http://localhost/engines/x", { method: "PUT", ...putBody(bad) }));
    expect(res.status).toBe(422);
  }
  // semantic 400: a claude engine with a provider is incoherent
  const incoherent = await app.handle(
    new Request("http://localhost/engines/x", { method: "PUT", ...putBody({ name: "x", harness: "claude", provider: "anthropic" }) }),
  );
  expect(incoherent.status).toBe(400);

  const order = await app.handle(new Request("http://localhost/engines/order", { method: "PUT", ...putBody({ ids: ["sonnet", "glm"] }) }));
  expect(((await order.json()) as { engines: Array<{ id: string }> }).engines.map((e) => e.id)).toEqual(["sonnet", "glm"]);
  const badOrder = await app.handle(new Request("http://localhost/engines/order", { method: "PUT", ...putBody({ ids: ["glm"] }) }));
  expect(badOrder.status).toBe(400);

  const settings = await app.handle(
    new Request("http://localhost/engines/settings", { method: "PUT", ...putBody({ maxWorkers: 5, defaultEngine: "glm" }) }),
  );
  expect(await settings.json()).toEqual({ maxWorkers: 5, defaultEngine: "glm" });
  for (const bad of [{ maxWorkers: 0 }, { maxWorkers: 21 }]) {
    const res = await app.handle(new Request("http://localhost/engines/settings", { method: "PUT", ...putBody(bad) }));
    expect(res.status).toBe(422);
  }
  const fraction = await app.handle(new Request("http://localhost/engines/settings", { method: "PUT", ...putBody({ maxWorkers: 2.5 }) }));
  expect(fraction.status).toBe(400);
  const ghostDefault = await app.handle(new Request("http://localhost/engines/settings", { method: "PUT", ...putBody({ defaultEngine: "ghost" }) }));
  expect(ghostDefault.status).toBe(400);
  const clearDefault = await app.handle(new Request("http://localhost/engines/settings", { method: "PUT", ...putBody({ defaultEngine: null }) }));
  expect(await clearDefault.json()).toEqual({ maxWorkers: 5, defaultEngine: null });

  const del = await app.handle(new Request("http://localhost/engines/sonnet", { method: "DELETE" }));
  expect(await del.json()).toEqual({ ok: true });
  const missing = await app.handle(new Request("http://localhost/engines/sonnet", { method: "DELETE" }));
  expect(missing.status).toBe(404);

  const models = await app.handle(new Request("http://localhost/claude-models"));
  expect(((await models.json()) as { models: Array<{ id: string }> }).models.map((m) => m.id)).toEqual(["sonnet", "opus", "haiku"]);
});

test("GET /explain/:actor walks the lineup: env pin → project → actor → default", async () => {
  const app = createApp(db);
  db.setEngine("glm", { name: "GLM", harness: "pi", provider: "zai", model: "glm-5.3", thinking: "max" });
  db.setEngine("sonnet", { name: "Sonnet", harness: "claude", model: "sonnet" });
  const get = async (url: string) => (await app.handle(new Request(url))).json() as Promise<{ source: string; next: { id: string } | null; text: string }>;

  expect(await get("http://localhost/explain/builder")).toMatchObject({ source: "default", next: { id: "default" } });
  db.setAgentConfig("builder", { runsOn: ["glm", "sonnet"] });
  const actor = await get("http://localhost/explain/builder");
  expect(actor).toMatchObject({ source: "actor", next: { id: "glm" } });
  expect(actor.text).toContain("next spawn → GLM");
  db.setProjectAgentConfig("jlox", "builder", { runsOn: ["sonnet"] });
  expect(await get("http://localhost/explain/builder?project=jlox")).toMatchObject({ source: "project", next: { id: "sonnet" } });
  expect(await get("http://localhost/explain/builder?project=kanban")).toMatchObject({ source: "actor" });
});

test("/activity carries the engine and resolved model per session", async () => {
  const app = createApp(db);
  db.setEngine("sonnet", { name: "sonnet engine", harness: "pi", provider: "anthropic", model: "claude-3-5-sonnet" });
  db.setEngine("gpt", { name: "gpt engine", harness: "pi", provider: "openai", model: "gpt-4o" });
  db.setAgentConfig("reviewer", { runsOn: ["sonnet", "gpt"] });

  const card1 = db.createTask({ title: "card 1", lane: "review" });
  db.createComment(card1.id, { author: "pi-builder", kind: "handoff", body: "done" });
  const card2 = db.createTask({ title: "card 2", lane: "review" });
  db.createComment(card2.id, { author: "pi-builder", kind: "handoff", body: "done" });

  const finishes: Array<() => void> = [];
  const handle = startAutoReview({
    db,
    cwd: dir,
    spawnFn: () => new Promise((resolve) => finishes.push(() => resolve({ code: 0 }))),
    watchIntervalMs: 50,
    gate: null,
  });

  for (let i = 0; i < 20 && finishes.length < 2; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(finishes.length).toBe(2);

  const res = await app.handle(new Request("http://localhost/activity"));
  expect(res.status).toBe(200);
  const data = (await res.json()) as { sessions: Array<{ taskId: string; model?: string; modelLabel?: string; engine?: string; lastActivityAt?: number; startedAt?: number }> };
  expect(data.sessions.length).toBe(2);
  // one seat each: the second review falls back to the lineup's second engine
  expect(data.sessions.map((s) => s.engine).sort()).toEqual(["gpt engine", "sonnet engine"]);
  expect(data.sessions.map((s) => s.modelLabel).sort()).toEqual(["anthropic · claude-3-5-sonnet · max", "openai · gpt-4o · max"]);
  // liveness rides along: activity starts at birth even for a silent stub session
  for (const s of data.sessions) expect(s.lastActivityAt).toBe(s.startedAt);

  handle.stop();
  for (const f of finishes) f();
});

test("DELETE /sessions/:taskId stops one session; unknown ids 404", async () => {
  const app = createApp(db);
  const card = db.createTask({ title: "stoppable", lane: "review" });
  db.createComment(card.id, { author: "pi-builder", kind: "handoff", body: "done" });

  let killed = false;
  let resolveSpawn!: (r: { code: number }) => void;
  const handle = startAutoReview({
    db,
    cwd: dir,
    spawnFn: (_job, ctx) => {
      ctx.track(() => {
        killed = true;
        resolveSpawn({ code: 143 });
      });
      return new Promise((resolve) => (resolveSpawn = resolve));
    },
    watchIntervalMs: 50,
    gate: null,
  });
  for (let i = 0; i < 20 && !killed && resolveSpawn === undefined; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 50)); // session is in flight

  const miss = await app.handle(new Request("http://localhost/sessions/nope", { method: "DELETE" }));
  expect(miss.status).toBe(404);

  const stop = await app.handle(new Request(`http://localhost/sessions/${card.id}`, { method: "DELETE" }));
  expect(stop.status).toBe(200);
  expect(((await stop.json()) as { ok: boolean }).ok).toBe(true);
  expect(killed).toBe(true);
  await new Promise((r) => setTimeout(r, 50));
  // the death flows through the loop's normal path: a re-trigger comment on the card
  const last = db.comments(card.id).at(-1)!;
  expect(last.body).toContain("session died");

  handle.stop();
  await new Promise((r) => setTimeout(r, 20));
});

test("PATCH /lanes/:id wipLimit roundtrip; shape violations 422, null clears", async () => {
  const app = createApp(db);

  const set = await app.handle(
    new Request("http://localhost/lanes/implement", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wipLimit: 3 }),
    }),
  );
  expect(set.status).toBe(200);
  expect(((await set.json()) as { wipLimit: number | null }).wipLimit).toBe(3);

  const boardRes = await app.handle(new Request("http://localhost/board"));
  const board = (await boardRes.json()) as { lanes: Array<{ id: string; wipLimit: number | null }> };
  expect(board.lanes.find((l) => l.id === "implement")?.wipLimit).toBe(3);

  for (const bad of [0, 1000, "3"]) {
    const badRes = await app.handle(
      new Request("http://localhost/lanes/implement", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wipLimit: bad }),
      }),
    );
    expect(badRes.status).toBe(422);
  }

  const clear = await app.handle(
    new Request("http://localhost/lanes/implement", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wipLimit: null }),
    }),
  );
  expect(clear.status).toBe(200);
  expect(((await clear.json()) as { wipLimit: number | null }).wipLimit).toBeNull();

  const boardRes2 = await app.handle(new Request("http://localhost/board"));
  const board2 = (await boardRes2.json()) as { lanes: Array<{ id: string; wipLimit: number | null }> };
  expect(board2.lanes.find((l) => l.id === "implement")?.wipLimit).toBeNull();

  const create = await app.handle(
    new Request("http://localhost/lanes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "QA" }),
    }),
  );
  expect(create.status).toBe(201);
  expect(((await create.json()) as { wipLimit: number | null }).wipLimit).toBeNull();
});

test("PATCH /lanes/:id before round-trip; null=last; fixed 409; both fields 400", async () => {
  const app = createApp(db);

  const patch = async (id: string, body: Record<string, unknown>) =>
    app.handle(
      new Request(`http://localhost/lanes/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  const order = async (): Promise<string[]> => {
    const board = (await (await app.handle(new Request("http://localhost/board"))).json()) as {
      lanes: Array<{ id: string }>;
    };
    return board.lanes.map((l) => l.id);
  };

  const first = await patch("review", { before: "waiting" }); // fixed anchor allowed
  expect(first.status).toBe(200);
  expect((await order())[0]).toBe("review");

  const last = await patch("review", { before: null });
  expect(last.status).toBe(200);
  expect((await order()).at(-1)).toBe("review");

  const fixed = await patch("waiting", { before: "review" });
  expect(fixed.status).toBe(409);
  expect(((await fixed.json()) as { code: string }).code).toBe("conflict");

  const both = await patch("review", { index: 1, before: "plan" });
  expect(both.status).toBe(400);
  expect(((await both.json()) as { code: string }).code).toBe("invalid");

  const missing = await patch("review", { before: "nope" });
  expect(missing.status).toBe(404);
});

test("PATCH /tasks/:id {lane:'plan'} moves a backlog card; /board reflects it", async () => {
  const app = createApp(db);
  const task = db.createTask({ title: "one", lane: "backlog" });

  const res = await app.handle(
    new Request(`http://localhost/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lane: "plan" }),
    }),
  );
  expect(res.status).toBe(200);
  const updated = (await res.json()) as { laneId: string };
  expect(updated.laneId).toBe("plan");

  const boardRes = await app.handle(new Request("http://localhost/board"));
  expect(boardRes.status).toBe(200);
  const board = (await boardRes.json()) as { tasks: Array<{ id: string; laneId: string }> };
  const boardTask = board.tasks.find((t) => t.id === task.id);
  expect(boardTask).toBeDefined();
  expect(boardTask?.laneId).toBe("plan");
});

test("GET /stats returns the board payload", async () => {
  const app = createApp(db);
  const res = await app.handle(new Request("http://localhost/stats"));
  expect(res.status).toBe(200);
  const data = (await res.json()) as any;
  expect(data.board).toBeDefined();
  expect(data.board.wip).toBe(0);
  expect(data.board.throughput).toHaveLength(8);
  expect(data.board.laneDwell).toEqual({});
  expect(data.board.projects).toEqual([]);
  expect(data.board.cycleAvgMs).toBeNull();
  expect(data.cards).toEqual({});
  expect(typeof data.generatedAt).toBe("number");
});

test("PATCH lane change (drag-drop path) records a lane event visible via /stats", async () => {
  const app = createApp(db);
  const task = db.createTask({ title: "card", lane: "backlog" });

  const eventsBefore = db.laneEvents(task.id);
  expect(eventsBefore).toHaveLength(1);

  // Index-only patch: adds no event
  const indexPatch = await app.handle(
    new Request(`http://localhost/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ index: 0 }),
    }),
  );
  expect(indexPatch.status).toBe(200);
  expect(db.laneEvents(task.id)).toHaveLength(1);

  // Lane patch (drag-drop path)
  const lanePatch = await app.handle(
    new Request(`http://localhost/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lane: "plan" }),
    }),
  );
  expect(lanePatch.status).toBe(200);
  expect(db.laneEvents(task.id)).toHaveLength(2);

  const statsRes = await app.handle(new Request("http://localhost/stats"));
  expect(statsRes.status).toBe(200);
  const payload = (await statsRes.json()) as any;
  const cardStats = payload.cards[task.id];
  expect(cardStats).toBeDefined();
  expect(cardStats.laneTimes.map((lt: any) => lt.laneId)).toEqual(["backlog", "plan"]);
});

test("GET /stats?project= scopes aggregates but keeps card stats global", async () => {
  const app = createApp(db);
  const alphaActive = db.createTask({ title: "alpha backlog", lane: "backlog", project: "alpha" });
  db.createTask({ title: "alpha plan", lane: "plan", project: "alpha" });
  const betaPlan = db.createTask({ title: "beta plan", lane: "plan", project: "beta" });
  db.moveTask(alphaActive.id, "done");

  const scoped = (await (await app.handle(new Request("http://localhost/stats?project=alpha"))).json()) as any;
  expect(scoped.board.wip).toBe(1); // alpha has one active card; beta's is out of scope
  expect(scoped.board.throughput.reduce((n: number, w: any) => n + w.done, 0)).toBe(1);
  expect(scoped.board.laneDwell.plan.cards).toBe(1);
  expect(scoped.board.laneDwell.backlog.cards).toBe(1);
  expect(scoped.board.projects).toEqual([{ project: "alpha", total: 2, active: 1, done: 1 }]);
  expect(scoped.board.cycleAvgMs).not.toBeNull();
  expect(scoped.cards[betaPlan.id]).toBeDefined(); // card stats stay global

  const beta = (await (await app.handle(new Request("http://localhost/stats?project=beta"))).json()) as any;
  expect(beta.board.wip).toBe(1);
  expect(beta.board.throughput.reduce((n: number, w: any) => n + w.done, 0)).toBe(0);
  expect(Object.keys(beta.board.laneDwell)).toEqual(["plan"]);
  expect(beta.board.cycleAvgMs).toBeNull();

  // the reported bug: a registered project with no cards must not inherit board totals
  const empty = (await (await app.handle(new Request("http://localhost/stats?project=baanthong.co"))).json()) as any;
  expect(empty.board).toMatchObject({ wip: 0, laneDwell: {}, projects: [], cycleAvgMs: null });
  expect(empty.board.throughput.every((w: any) => w.done === 0)).toBe(true);
  expect(empty.cards[betaPlan.id]).toBeDefined();

  // no query = whole board (unchanged)
  const all = (await (await app.handle(new Request("http://localhost/stats"))).json()) as any;
  expect(all.board.wip).toBe(2);
  expect(all.board.laneDwell.plan.cards).toBe(2);
  expect(all.board.projects.map((p: any) => p.project)).toEqual(["alpha", "beta"]);
});


test("GET /git reports the serving repo; checkout refuses unknown branches", async () => {
  const app = createApp(db);
  const res = await app.handle(new Request("http://localhost/git"));
  expect(res.status).toBe(200);
  const info = (await res.json()) as { repo: boolean; branch: string; branches: string[] };
  // the test cwd is the real kanban repo — assert shape only, never the branch name
  expect(info.repo).toBe(true);
  expect(info.branch.length).toBeGreaterThan(0);
  expect(info.branches).toContain(info.branch);

  // never a real checkout in api tests: a ref outside the local list must 400 before git runs
  const bad = await app.handle(
    new Request("http://localhost/git/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch: "kanban-test-no-such-branch" }),
    }),
  );
  expect(bad.status).toBe(400);
  const afterRes = await app.handle(new Request("http://localhost/git"));
  const after = (await afterRes.json()) as { branch: string };
  expect(after.branch).toBe(info.branch);
});

test("POST/DELETE /tasks/:id/links roundtrip; self-link 400; unknown target 404", async () => {
  const app = createApp(db);
  const a = db.createTask({ title: "Card A" });
  const b = db.createTask({ title: "Card B" });

  // self-link 400
  const selfRes = await app.handle(
    new Request(`http://localhost/tasks/${a.id}/links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: a.id }),
    }),
  );
  expect(selfRes.status).toBe(400);
  const selfBody = (await selfRes.json()) as any;
  expect(selfBody.code).toBe("invalid");

  // unknown target 404
  const unknownRes = await app.handle(
    new Request(`http://localhost/tasks/${a.id}/links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "nonexistent" }),
    }),
  );
  expect(unknownRes.status).toBe(404);
  const unknownBody = (await unknownRes.json()) as any;
  expect(unknownBody.code).toBe("not-found");

  // POST 201
  const linkRes = await app.handle(
    new Request(`http://localhost/tasks/${a.id}/links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: b.id }),
    }),
  );
  expect(linkRes.status).toBe(201);
  const linkBody = (await linkRes.json()) as { linked: Array<{ id: string }> };
  expect(linkBody.linked.some((t) => t.id === b.id)).toBe(true);

  // DELETE 200 { ok: true, removed: true }
  const delRes = await app.handle(
    new Request(`http://localhost/tasks/${a.id}/links/${b.id}`, {
      method: "DELETE",
    }),
  );
  expect(delRes.status).toBe(200);
  expect(await delRes.json()).toEqual({ ok: true, removed: true });

  // repeat DELETE { ok: true, removed: false }
  const repeatDel = await app.handle(
    new Request(`http://localhost/tasks/${a.id}/links/${b.id}`, {
      method: "DELETE",
    }),
  );
  expect(repeatDel.status).toBe(200);
  expect(await repeatDel.json()).toEqual({ ok: true, removed: false });
});

test("board payload lists a link from both connected cards", async () => {
  const app = createApp(db);
  const a = db.createTask({ title: "Card A" });
  const b = db.createTask({ title: "Card B" });

  await app.handle(
    new Request(`http://localhost/tasks/${a.id}/links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: b.id }),
    }),
  );

  const boardRes = await app.handle(new Request("http://localhost/board"));
  expect(boardRes.status).toBe(200);
  const board = (await boardRes.json()) as any;
  expect(board.links[a.id]).toContain(b.id);
  expect(board.links[b.id]).toContain(a.id);
});

test("POST /tasks accepts tags; PATCH /tasks/:id replaces or clears; bad shape 422", async () => {
  const app = createApp(db);

  const post = await app.handle(
    new Request("http://localhost/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "tagged", tags: [" ui ", "ui", "review-loop"] }),
    }),
  );
  expect(post.status).toBe(201);
  const created = (await post.json()) as { id: string; tags: string[] };
  expect(created.tags).toEqual(["ui", "review-loop"]);

  const patched = await app.handle(
    new Request(`http://localhost/tasks/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags: ["ui", "x"] }),
    }),
  );
  expect(patched.status).toBe(200);
  expect(((await patched.json()) as { tags: string[] }).tags).toEqual(["ui", "x"]);

  const cleared = await app.handle(
    new Request(`http://localhost/tasks/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tags: [] }),
    }),
  );
  expect(cleared.status).toBe(200);
  expect(((await cleared.json()) as { tags: string[] }).tags).toEqual([]);

  const badShape = await app.handle(
    new Request("http://localhost/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x", tags: "ui" }),
    }),
  );
  expect(badShape.status).toBe(422); // tags must be an array

  const tooMany = await app.handle(
    new Request("http://localhost/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x", tags: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"] }),
    }),
  );
  expect(tooMany.status).toBe(400);
  expect((await tooMany.json()) as { error: string; code: string }).toEqual({
    error: "a card carries at most 10 tags",
    code: "invalid",
  });
});

test("PATCH /tasks/:id owner roundtrip; /board carries it", async () => {
  const app = createApp(db);
  const task = db.createTask({ title: "api owner", lane: "implement" });

  const patch = async (body: Record<string, unknown>) =>
    app.handle(
      new Request(`http://localhost/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  const set = await patch({ owner: "ada" });
  expect(set.status).toBe(200);
  expect(((await set.json()) as { owner: string | null }).owner).toBe("ada");

  // empty string fails validation (minLength 1)
  expect((await patch({ owner: "" })).status).toBe(422);

  // moving out of implement via PATCH clears it
  const moved = await patch({ lane: "review", owner: "bob" });
  expect(moved.status).toBe(200);
  expect(((await moved.json()) as { owner: string | null }).owner).toBeNull();

  // null clears explicitly
  await patch({ owner: "ada" });
  const cleared = await patch({ owner: null });
  expect(cleared.status).toBe(200);
  expect(((await cleared.json()) as { owner: string | null }).owner).toBeNull();

  // /board carries owner
  db.updateTask(task.id, { owner: "ada" });
  const board = (await (await app.handle(new Request("http://localhost/board"))).json()) as {
    tasks: Array<{ id: string; owner: string | null }>;
  };
  expect(board.tasks.find((t) => t.id === task.id)?.owner).toBe("ada");
});

test("PATCH /tasks/:id before anchors the move; bad anchor 409s", async () => {
  const app = createApp(db);
  const a = db.createTask({ title: "alpha", lane: "backlog" });
  const b = db.createTask({ title: "beta", lane: "backlog" });
  const c = db.createTask({ title: "gamma", lane: "backlog" });
  const p = db.createTask({ title: "plan anchor", lane: "plan" });

  const patch = (id: string, body: Record<string, unknown>) =>
    app.handle(
      new Request(`http://localhost/tasks/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  // c before a within the lane
  const moved = await patch(c.id, { before: a.id });
  expect(moved.status).toBe(200);
  expect(db.laneTasks("backlog").map((t) => t.id)).toEqual([c.id, a.id, b.id]);

  // cross-lane anchor: b into plan before p
  const cross = await patch(b.id, { lane: "plan", before: p.id });
  expect(cross.status).toBe(200);
  expect(db.laneTasks("plan").map((t) => t.id)).toEqual([b.id, p.id]);

  // anchor in the wrong lane → 409 conflict
  const wrongLane = await patch(a.id, { lane: "plan", before: c.id });
  expect(wrongLane.status).toBe(409);
  expect(((await wrongLane.json()) as { error?: string }).error ?? "").toContain(
    `anchor card '${c.id}' is not in lane 'plan'`,
  );

  // unknown anchor → 404
  const unknown = await patch(a.id, { before: "zzzzz" });
  expect(unknown.status).toBe(404);

  // self anchor → 400 invalid
  const self = await patch(a.id, { before: a.id });
  expect(self.status).toBe(400);
});

test("GET/PUT /projects roundtrip; empty body 400; bad path 400; schema violation 422", async () => {
  const app = createApp(db);
  db.createTask({ title: "tagged card", project: "e2e-proj" });

  // GET surfaces the lazy union, un-routed tag included
  const get1 = await app.handle(new Request("http://localhost/projects"));
  expect(get1.status).toBe(200);
  const { projects } = (await get1.json()) as { projects: Array<{ name: string; repoPath: string | null; testGate: boolean; testCmd: string | null }> };
  expect(projects).toContainEqual({ name: "e2e-proj", repoPath: null, testGate: true, testCmd: null });

  // PUT routes the repo
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir);
  const put = await app.handle(
    new Request("http://localhost/projects/e2e-proj", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoPath: repoDir }),
    }),
  );
  expect(put.status).toBe(200);
  expect(((await put.json()) as { project: unknown }).project).toEqual({ name: "e2e-proj", repoPath: repoDir, testGate: true, testCmd: null });

  // relative path → 400 with the db contract's message
  const rel = await app.handle(
    new Request("http://localhost/projects/e2e-proj", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoPath: "rel/x" }),
    }),
  );
  expect(rel.status).toBe(400);
  expect(((await rel.json()) as { error?: string }).error).toContain("repo path must be an absolute path to an existing directory");

  // empty body → 400
  const empty = await app.handle(
    new Request("http://localhost/projects/e2e-proj", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  expect(empty.status).toBe(400);
  expect(((await empty.json()) as { error?: string }).error).toBe("provide repoPath, testGate, and/or testCmd");

  // wrong-typed repoPath → 422 (Elysia schema)
  const bad = await app.handle(
    new Request("http://localhost/projects/e2e-proj", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoPath: 5 }),
    }),
  );
  expect(bad.status).toBe(422);

  // null unrouts
  const unroute = await app.handle(
    new Request("http://localhost/projects/e2e-proj", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoPath: null }),
    }),
  );
  expect(unroute.status).toBe(200);
  expect(((await unroute.json()) as { project: unknown }).project).toEqual({ name: "e2e-proj", repoPath: null, testGate: true, testCmd: null });
});

test("PUT /projects stores and clears testCmd; the full route comes back", async () => {
  const app = createApp(db);
  const json = { headers: { "content-type": "application/json" } };
  const putBody = (body: unknown) => ({ ...json, body: JSON.stringify(body) });

  // testCmd-only body upserts with v1 defaults; the db trims the command
  const put = await app.handle(
    new Request("http://localhost/projects/cmd-proj", { method: "PUT", ...putBody({ testCmd: " cargo test " }) }),
  );
  expect(put.status).toBe(200);
  expect(((await put.json()) as { project: unknown }).project).toEqual({ name: "cmd-proj", repoPath: null, testGate: true, testCmd: "cargo test" });

  // repoPath-only body preserves the stored testCmd
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir);
  const putRepo = await app.handle(
    new Request("http://localhost/projects/cmd-proj", { method: "PUT", ...putBody({ repoPath: repoDir }) }),
  );
  expect(putRepo.status).toBe(200);
  expect(((await putRepo.json()) as { project: unknown }).project).toEqual({ name: "cmd-proj", repoPath: repoDir, testGate: true, testCmd: "cargo test" });

  // testCmd-only body preserves the stored repo/gate
  const putCmd2 = await app.handle(
    new Request("http://localhost/projects/cmd-proj", { method: "PUT", ...putBody({ testCmd: "cargo test --release" }) }),
  );
  expect(putCmd2.status).toBe(200);
  expect(((await putCmd2.json()) as { project: unknown }).project).toEqual({ name: "cmd-proj", repoPath: repoDir, testGate: true, testCmd: "cargo test --release" });

  // null clears the command, leaving the rest of the route intact
  const putNull = await app.handle(
    new Request("http://localhost/projects/cmd-proj", { method: "PUT", ...putBody({ testCmd: null }) }),
  );
  expect(putNull.status).toBe(200);
  expect(((await putNull.json()) as { project: unknown }).project).toEqual({ name: "cmd-proj", repoPath: repoDir, testGate: true, testCmd: null });

  // a testCmd on an un-registered name materializes the row with v1 defaults
  const fresh = await app.handle(
    new Request("http://localhost/projects/fresh-proj", { method: "PUT", ...putBody({ testCmd: "x" }) }),
  );
  expect(fresh.status).toBe(200);
  expect(((await fresh.json()) as { project: unknown }).project).toEqual({ name: "fresh-proj", repoPath: null, testGate: true, testCmd: "x" });

  // GET /projects lists the row with its testCmd
  const got = (await (await app.handle(new Request("http://localhost/projects"))).json()) as {
    projects: Array<{ name: string; repoPath: string | null; testGate: boolean; testCmd: string | null }>;
  };
  expect(got.projects).toContainEqual({ name: "fresh-proj", repoPath: null, testGate: true, testCmd: "x" });
});

test("PUT /projects applies repoPath then testGate then testCmd", async () => {
  const app = createApp(db);
  const json = { headers: { "content-type": "application/json" } };
  const putBody = (body: unknown) => ({ ...json, body: JSON.stringify(body) });
  const repoA = join(dir, "repo-a");
  const repoB = join(dir, "repo-b");
  mkdirSync(repoA);
  mkdirSync(repoB);
  const seed = await app.handle(
    new Request("http://localhost/projects/ord-proj", { method: "PUT", ...putBody({ repoPath: repoA }) }),
  );
  expect(seed.status).toBe(200);

  // the whitespace testCmd fails last, so the earlier fields stay applied
  const put = await app.handle(
    new Request("http://localhost/projects/ord-proj", { method: "PUT", ...putBody({ repoPath: repoB, testGate: false, testCmd: "   " }) }),
  );
  expect(put.status).toBe(400);
  expect(((await put.json()) as { error?: string }).error).toBe("test command must be 1 to 500 characters");
  expect(db.getProject("ord-proj")).toEqual({ name: "ord-proj", repoPath: repoB, testGate: false, testCmd: null });
});

test("PUT /projects testCmd validates: 422 schema, 400 whitespace", async () => {
  const app = createApp(db);
  const json = { headers: { "content-type": "application/json" } };
  const putBody = (body: unknown) => ({ ...json, body: JSON.stringify(body) });
  const url = "http://localhost/projects/val-proj";

  // materialize the row so the whitespace failure is observably a no-op
  const seed = await app.handle(new Request(url, { method: "PUT", ...putBody({ testGate: false }) }));
  expect(seed.status).toBe(200);

  const wrongType = await app.handle(new Request(url, { method: "PUT", ...putBody({ testCmd: 5 }) }));
  expect(wrongType.status).toBe(422);
  const emptyStr = await app.handle(new Request(url, { method: "PUT", ...putBody({ testCmd: "" }) }));
  expect(emptyStr.status).toBe(422);
  const tooLong = await app.handle(new Request(url, { method: "PUT", ...putBody({ testCmd: "x".repeat(501) }) }));
  expect(tooLong.status).toBe(422);

  // schema-clean whitespace reaches the db, whose 1–500 rule answers 400
  const whitespace = await app.handle(new Request(url, { method: "PUT", ...putBody({ testCmd: "   " }) }));
  expect(whitespace.status).toBe(400);
  expect(((await whitespace.json()) as { error?: string }).error).toBe("test command must be 1 to 500 characters");
  expect(db.getProject("val-proj")?.testCmd).toBeNull();

  // 49-char :name violates the params schema
  const longName = await app.handle(new Request(`http://localhost/projects/${"n".repeat(49)}`, { method: "PUT", ...putBody({ testCmd: "x" }) }));
  expect(longName.status).toBe(422);
});

test("PUT /projects keeps v1 bodies identical and updates the empty-body error", async () => {
  const app = createApp(db);
  const json = { headers: { "content-type": "application/json" } };
  const putBody = (body: unknown) => ({ ...json, body: JSON.stringify(body) });
  const url = "http://localhost/projects/v1-proj";

  const empty = await app.handle(new Request(url, { method: "PUT", ...putBody({}) }));
  expect(empty.status).toBe(400);
  expect(((await empty.json()) as { error?: string }).error).toBe("provide repoPath, testGate, and/or testCmd");

  const repoDir = join(dir, "repo");
  mkdirSync(repoDir);
  const put = await app.handle(new Request(url, { method: "PUT", ...putBody({ repoPath: repoDir }) }));
  expect(put.status).toBe(200);
  expect(((await put.json()) as { project: unknown }).project).toEqual({ name: "v1-proj", repoPath: repoDir, testGate: true, testCmd: null });

  // gate-only body preserves the stored repoPath
  const gate = await app.handle(new Request(url, { method: "PUT", ...putBody({ testGate: false }) }));
  expect(gate.status).toBe(200);
  expect(((await gate.json()) as { project: unknown }).project).toEqual({ name: "v1-proj", repoPath: repoDir, testGate: false, testCmd: null });

  const rel = await app.handle(new Request(url, { method: "PUT", ...putBody({ repoPath: "rel/x" }) }));
  expect(rel.status).toBe(400);
  expect(((await rel.json()) as { error?: string }).error).toContain("repo path must be an absolute path to an existing directory");

  const unroute = await app.handle(new Request(url, { method: "PUT", ...putBody({ repoPath: null }) }));
  expect(unroute.status).toBe(200);
  expect(((await unroute.json()) as { project: unknown }).project).toEqual({ name: "v1-proj", repoPath: null, testGate: false, testCmd: null });
});

test("GET /projects/:name/agents lists overrides sorted by actor", async () => {
  const app = createApp(db);
  const json = { headers: { "content-type": "application/json" } };
  const putBody = (body: unknown) => ({ ...json, body: JSON.stringify(body) });

  // a custom lane hosts actor designer, extending the valid key space
  const lane = db.createLane({ name: "Design" });
  db.setLaneContext(lane.id, {
    actors: [{ id: "designer", author: "pi-designer", instructions: "Design {id}" }],
    triggers: [{ kind: "on-enter" }],
  });
  for (const [actor, body] of [
    ["reviewer", { context: "r" }],
    ["builder", { context: "b" }],
    ["designer", { context: "d" }],
  ] as const) {
    const put = await app.handle(new Request(`http://localhost/projects/list-proj/agents/${actor}`, { method: "PUT", ...putBody(body) }));
    expect(put.status).toBe(200);
  }

  // rows come back sorted by actor ascending
  const got = await app.handle(new Request("http://localhost/projects/list-proj/agents"));
  expect(got.status).toBe(200);
  expect(await got.json()).toEqual({
    agents: [
      { actor: "builder", config: { context: "b" } },
      { actor: "designer", config: { context: "d" } },
      { actor: "reviewer", config: { context: "r" } },
    ],
  });

  // an un-registered name reads as empty, never 404
  const none = await app.handle(new Request("http://localhost/projects/nowhere/agents"));
  expect(none.status).toBe(200);
  expect(await none.json()).toEqual({ agents: [] });

  // deleting the lane does not hide the stored row — storage is the truth
  db.setLaneContext(lane.id, null);
  const stale = await app.handle(new Request("http://localhost/projects/list-proj/agents"));
  expect(await stale.json()).toEqual({
    agents: [
      { actor: "builder", config: { context: "b" } },
      { actor: "designer", config: { context: "d" } },
      { actor: "reviewer", config: { context: "r" } },
    ],
  });

  // 49-char :name violates the params schema
  const longName = await app.handle(new Request(`http://localhost/projects/${"n".repeat(49)}/agents`));
  expect(longName.status).toBe(422);
});

test("PUT /projects/:name/agents/:actor stores the present-key config", async () => {
  const app = createApp(db);
  const json = { headers: { "content-type": "application/json" } };
  const putBody = (body: unknown) => ({ ...json, body: JSON.stringify(body) });
  const url = "http://localhost/projects/ov-proj/agents/reviewer";

  const put = await app.handle(
    new Request(url, { method: "PUT", ...putBody({ context: "m", tools: "high", skills: ["~/.pi/agent/skills/rust"] }) }),
  );
  expect(put.status).toBe(200);
  expect(await put.json()).toEqual({ agent: { context: "m", tools: "high", skills: ["~/.pi/agent/skills/rust"] } });

  // an explicitly empty skills array is stored as present (present-key rule)
  const emptySkills = await app.handle(new Request(url, { method: "PUT", ...putBody({ skills: [] }) }));
  expect(emptySkills.status).toBe(200);
  expect(await emptySkills.json()).toEqual({ agent: { skills: [] } });

  // an empty body stores an empty override — it is listed, not treated as a delete
  const emptyOverride = await app.handle(new Request(url, { method: "PUT", ...putBody({}) }));
  expect(emptyOverride.status).toBe(200);
  expect(await emptyOverride.json()).toEqual({ agent: {} });
  const listed = await app.handle(new Request("http://localhost/projects/ov-proj/agents"));
  expect(await listed.json()).toEqual({ agents: [{ actor: "reviewer", config: {} }] });

  // a custom-lane actor is a valid key
  const lane = db.createLane({ name: "Design" });
  db.setLaneContext(lane.id, {
    actors: [{ id: "designer", author: "pi-designer", instructions: "Design {id}" }],
    triggers: [{ kind: "on-enter" }],
  });
  const designer = await app.handle(new Request("http://localhost/projects/ov-proj/agents/designer", { method: "PUT", ...putBody({ context: "design-v1" }) }));
  expect(designer.status).toBe(200);
  expect(await designer.json()).toEqual({ agent: { context: "design-v1" } });

  // the override's upsert registers the project tag with v1 defaults
  const projects = (await (await app.handle(new Request("http://localhost/projects"))).json()) as {
    projects: Array<{ name: string; repoPath: string | null; testGate: boolean; testCmd: string | null }>;
  };
  expect(projects.projects).toContainEqual({ name: "ov-proj", repoPath: null, testGate: true, testCmd: null });
});

test("PUT /projects/:name/agents/:actor validates actor, params and body", async () => {
  const app = createApp(db);
  const json = { headers: { "content-type": "application/json" } };
  const putBody = (body: unknown) => ({ ...json, body: JSON.stringify(body) });

  // unknown actor → db-side 400 with the exact role list
  const chief = await app.handle(new Request("http://localhost/projects/val-proj/agents/chief", { method: "PUT", ...putBody({}) }));
  expect(chief.status).toBe(400);
  expect(((await chief.json()) as { error?: string }).error).toBe(
    "unknown agent role 'chief' (reviewer | builder | planner | plan-reviewer | elaborator | manager | worker)",
  );

  // 49-char actor and name violate the params schema
  const longActor = await app.handle(new Request(`http://localhost/projects/val-proj/agents/${"a".repeat(49)}`, { method: "PUT", ...putBody({}) }));
  expect(longActor.status).toBe(422);
  const longName = await app.handle(new Request(`http://localhost/projects/${"n".repeat(49)}/agents/reviewer`, { method: "PUT", ...putBody({}) }));
  expect(longName.status).toBe(422);

  // body validation matches PUT /agents/:role verbatim
  const badThinking = await app.handle(new Request("http://localhost/projects/val-proj/agents/reviewer", { method: "PUT", ...putBody({ timeoutMs: 5 }) }));
  expect(badThinking.status).toBe(422);
  const shortTimeout = await app.handle(new Request("http://localhost/projects/val-proj/agents/reviewer", { method: "PUT", ...putBody({ timeoutMs: 5 }) }));
  expect(shortTimeout.status).toBe(422);
  const longTimeout = await app.handle(new Request("http://localhost/projects/val-proj/agents/reviewer", { method: "PUT", ...putBody({ timeoutMs: 90_000_000 }) }));
  expect(longTimeout.status).toBe(422);
  const twoHourTimeout = await app.handle(new Request("http://localhost/projects/val-proj/agents/reviewer", { method: "PUT", ...putBody({ timeoutMs: 7_200_000 }) }));
  expect(twoHourTimeout.status).toBe(200);
  expect(await twoHourTimeout.json()).toEqual({ agent: { timeoutMs: 7_200_000 } });
});

test("DELETE /projects/:name/agents/:actor clears, repeats and never registers", async () => {
  const app = createApp(db);
  const json = { headers: { "content-type": "application/json" } };
  const putBody = (body: unknown) => ({ ...json, body: JSON.stringify(body) });

  const put = await app.handle(new Request("http://localhost/projects/del-proj/agents/reviewer", { method: "PUT", ...putBody({ context: "m" }) }));
  expect(put.status).toBe(200);
  const del = await app.handle(new Request("http://localhost/projects/del-proj/agents/reviewer", { method: "DELETE" }));
  expect(del.status).toBe(200);
  expect(await del.json()).toEqual({ ok: true });
  const listed = await app.handle(new Request("http://localhost/projects/del-proj/agents"));
  expect(await listed.json()).toEqual({ agents: [] });

  // deleting again is idempotent
  const delAgain = await app.handle(new Request("http://localhost/projects/del-proj/agents/reviewer", { method: "DELETE" }));
  expect(delAgain.status).toBe(200);
  expect(await delAgain.json()).toEqual({ ok: true });

  // a delete on a name with no projects row succeeds without materializing it
  const ghost = await app.handle(new Request("http://localhost/projects/ghost-proj/agents/reviewer", { method: "DELETE" }));
  expect(ghost.status).toBe(200);
  expect(await ghost.json()).toEqual({ ok: true });
  expect(db.getProject("ghost-proj")).toBeNull();

  // unknown actor → 400 even with no row to delete
  const chief = await app.handle(new Request("http://localhost/projects/del-proj/agents/chief", { method: "DELETE" }));
  expect(chief.status).toBe(400);
  expect(((await chief.json()) as { error?: string }).error).toBe(
    "unknown agent role 'chief' (reviewer | builder | planner | plan-reviewer | elaborator | manager | worker)",
  );

  // 49-char actor violates the params schema
  const longActor = await app.handle(new Request(`http://localhost/projects/del-proj/agents/${"a".repeat(49)}`, { method: "DELETE" }));
  expect(longActor.status).toBe(422);
});


test("GET/PUT/DELETE /lanes/:id/context roundtrip and validation", async () => {
  const app = createApp(db);

  // the seeded plan context reads back
  const get = await app.handle(new Request("http://localhost/lanes/plan/context"));
  expect(get.status).toBe(200);
  const seeded = (await get.json()) as { laneId: string; context: { actors: Array<{ id: string }> } | null };
  expect(seeded.laneId).toBe("plan");
  expect(seeded.context?.actors.map((a) => a.id)).toEqual(["planner", "plan-reviewer"]);

  // PUT on a custom lane saves and surfaces in GET /board's laneContexts
  db.createLane({ name: "Design" });
  const body = {
    actors: [{ id: "designer", author: "pi-designer", instructions: "Design {id}" }],
    triggers: [{ kind: "on-enter" }],
    artifact: "design",
    gate: { approveTarget: "plan", requireArtifact: "design" },
  };
  const put = await app.handle(
    new Request("http://localhost/lanes/design/context", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  expect(put.status).toBe(200);
  const saved = (await put.json()) as { laneId: string; context: { artifact: string } };
  expect(saved.laneId).toBe("design");
  expect(saved.context.artifact).toBe("design");
  const board = (await (await app.handle(new Request("http://localhost/board"))).json()) as {
    laneContexts: Record<string, { actors: Array<{ id: string }> }>;
  };
  expect(board.laneContexts.design?.actors[0]?.id).toBe("designer");

  // empty actors fails the schema (422), a human author fails the rules (400), unknown lane 404s
  const badSchema = await app.handle(
    new Request("http://localhost/lanes/design/context", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actors: [] }),
    }),
  );
  expect(badSchema.status).toBe(422);
  const badAuthor = await app.handle(
    new Request("http://localhost/lanes/design/context", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actors: [{ id: "designer", author: "human", instructions: "x" }],
        triggers: [{ kind: "on-enter" }],
      }),
    }),
  );
  expect(badAuthor.status).toBe(400);
  const missing = await app.handle(new Request("http://localhost/lanes/nope/context"));
  expect(missing.status).toBe(404);

  // DELETE clears the lane back to a plain lane
  const del = await app.handle(new Request("http://localhost/lanes/design/context", { method: "DELETE" }));
  expect(del.status).toBe(200);
  expect(((await del.json()) as { laneId: string; context: null }).context).toBeNull();
  const reread = await app.handle(new Request("http://localhost/lanes/design/context"));
  expect(((await reread.json()) as { context: null }).context).toBeNull();
});

test("GET /fs/dirs lists subdirectories under homeDir, hides files and dotfiles, and refuses escapes", async () => {
  const homeDir = join(dir, "home");
  mkdirSync(homeDir, { recursive: true });

  // Subdirectories
  const plainSub = join(homeDir, "projects");
  const gitSub = join(homeDir, "git-project");
  const dotSub = join(homeDir, ".hidden-dir");
  mkdirSync(plainSub, { recursive: true });
  mkdirSync(gitSub, { recursive: true });
  mkdirSync(join(gitSub, ".git"), { recursive: true });
  mkdirSync(dotSub, { recursive: true });

  // Nested directory inside projects
  const nested = join(plainSub, "child-project");
  mkdirSync(nested, { recursive: true });

  // Files to be ignored
  writeFileSync(join(homeDir, "file.txt"), "hello");
  writeFileSync(join(homeDir, ".hidden-file"), "secret");

  const app = createApp(db, { homeDir });

  // 1. Default listing (omitted path)
  const rootRes = await app.handle(new Request("http://localhost/fs/dirs"));
  expect(rootRes.status).toBe(200);
  const rootData = (await rootRes.json()) as any;
  expect(rootData.path).toBe(homeDir);
  expect(rootData.parent).toBeNull();
  expect(rootData.isGitRepo).toBe(false);
  expect(rootData.dirs).toEqual([
    { name: "git-project", path: gitSub, isGitRepo: true },
    { name: "projects", path: plainSub, isGitRepo: false },
  ]);

  // 2. Subdirectory listing (path=projects)
  const subRes = await app.handle(new Request("http://localhost/fs/dirs?path=projects"));
  expect(subRes.status).toBe(200);
  const subData = (await subRes.json()) as any;
  expect(subData.path).toBe(plainSub);
  expect(subData.parent).toBe(homeDir);
  expect(subData.isGitRepo).toBe(false);
  expect(subData.dirs).toEqual([
    { name: "child-project", path: nested, isGitRepo: false },
  ]);

  // 3. Absolute path outside homeDir -> 400
  const outsideAbs = await app.handle(new Request("http://localhost/fs/dirs?path=/etc"));
  expect(outsideAbs.status).toBe(400);
  const outsideAbsBody = (await outsideAbs.json()) as any;
  expect(outsideAbsBody.error).toContain("path escapes home directory");

  // 4. Relative path outside homeDir -> 400
  const outsideRel = await app.handle(new Request("http://localhost/fs/dirs?path=../outside"));
  expect(outsideRel.status).toBe(400);
  const outsideRelBody = (await outsideRel.json()) as any;
  expect(outsideRelBody.error).toContain("path escapes home directory");

  // 5. Missing directory -> 404
  const missing = await app.handle(new Request("http://localhost/fs/dirs?path=does-not-exist"));
  expect(missing.status).toBe(404);
  const missingBody = (await missing.json()) as any;
  expect(missingBody.error).toContain("no such directory");

  // 6. ~ paths
  const tildeRes = await app.handle(new Request("http://localhost/fs/dirs?path=~"));
  expect(tildeRes.status).toBe(200);
  const tildeData = (await tildeRes.json()) as any;
  expect(tildeData.path).toBe(homeDir);

  const tildeSub = await app.handle(new Request("http://localhost/fs/dirs?path=~/projects"));
  expect(tildeSub.status).toBe(200);
  const tildeSubData = (await tildeSub.json()) as any;
  expect(tildeSubData.path).toBe(plainSub);

  const tildeEscape = await app.handle(new Request("http://localhost/fs/dirs?path=~/../outside"));
  expect(tildeEscape.status).toBe(400);
  const tildeEscapeBody = (await tildeEscape.json()) as any;
  expect(tildeEscapeBody.error).toContain("path escapes home directory: '~/../outside'");
});

test("POST /fs/mkdir creates 0755 directories under homeDir and refuses escapes, misses, duplicates, and bad names", async () => {
  const homeDir = join(dir, "home");
  mkdirSync(homeDir, { recursive: true });

  const app = createApp(db, { homeDir });

  // 1. Valid creation
  const res = await app.handle(
    new Request("http://localhost/fs/mkdir", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "new-dir" }),
    }),
  );
  expect(res.status).toBe(200);
  const data = (await res.json()) as any;
  expect(data.path).toBe(join(homeDir, "new-dir"));
  expect(statSync(data.path).mode & 0o777).toBe(0o755);

  // 2. Repeat -> 409
  const repeat = await app.handle(
    new Request("http://localhost/fs/mkdir", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "new-dir" }),
    }),
  );
  expect(repeat.status).toBe(409);
  const repeatBody = (await repeat.json()) as any;
  expect(repeatBody.error).toBe(`directory 'new-dir' already exists in ${homeDir}`);

  // 3. Escape -> 400
  const escape = await app.handle(
    new Request("http://localhost/fs/mkdir", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "../outside", name: "x" }),
    }),
  );
  expect(escape.status).toBe(400);
  const escapeBody = (await escape.json()) as any;
  expect(escapeBody.error).toContain("path escapes home directory");

  // 4. Bad names (slashes, dot) -> 400
  const slashes = await app.handle(
    new Request("http://localhost/fs/mkdir", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "a/b" }),
    }),
  );
  expect(slashes.status).toBe(400);
  const slashesBody = (await slashes.json()) as any;
  expect(slashesBody.error).toContain("invalid directory name");

  const dot = await app.handle(
    new Request("http://localhost/fs/mkdir", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: ".hidden" }),
    }),
  );
  expect(dot.status).toBe(400);
  const dotBody = (await dot.json()) as any;
  expect(dotBody.error).toContain("invalid directory name");

  // 5. Parent missing -> 404
  const miss = await app.handle(
    new Request("http://localhost/fs/mkdir", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "nope", name: "x" }),
    }),
  );
  expect(miss.status).toBe(404);
  const missBody = (await miss.json()) as any;
  expect(missBody.error).toContain("no such directory");

  // 6. Missing name -> 422
  const missingName = await app.handle(
    new Request("http://localhost/fs/mkdir", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  expect(missingName.status).toBe(422);

  // 7. GET /fs/dirs?path=~ cases
  const tilde = await app.handle(new Request("http://localhost/fs/dirs?path=~"));
  expect(tilde.status).toBe(200);
  expect(((await tilde.json()) as any).path).toBe(homeDir);

  const tildeProjects = await app.handle(
    new Request("http://localhost/fs/mkdir", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "projects" }),
    }),
  );
  expect(tildeProjects.status).toBe(200);

  const tildeSub = await app.handle(new Request("http://localhost/fs/dirs?path=~/projects"));
  expect(tildeSub.status).toBe(200);
  expect(((await tildeSub.json()) as any).path).toBe(join(homeDir, "projects"));

  const tildeEscape = await app.handle(new Request("http://localhost/fs/dirs?path=~/../outside"));
  expect(tildeEscape.status).toBe(400);
});

test("GET /board lists registered projects that carry no cards", async () => {
  const homeDir = join(dir, "home");
  mkdirSync(homeDir, { recursive: true });

  const app = createApp(db, { homeDir });

  // Pre-seed payload (projectNames: [])
  const initialRes = await app.handle(new Request("http://localhost/board"));
  expect(initialRes.status).toBe(200);
  const initial = (await initialRes.json()) as any;
  expect(initial.projectNames).toEqual([]);

  // After db.addProject("kanban-add", homeDir) and a card tagged tag-only
  db.addProject("kanban-add", homeDir);
  db.createTask({ title: "Card tagged tag-only", project: "tag-only" });

  const updatedRes = await app.handle(new Request("http://localhost/board"));
  expect(updatedRes.status).toBe(200);
  const updated = (await updatedRes.json()) as any;
  expect(updated.projectNames).toEqual(["kanban-add", "tag-only"]);
});

test("PUT /harnesses/:id/enabled flips the master switch without touching engine rows; 404 unknown", async () => {
  const app = createApp(db);
  const json = { headers: { "content-type": "application/json" } };

  await app.handle(
    new Request("http://localhost/engines/sonnet", { method: "PUT", ...json, body: JSON.stringify({ name: "Sonnet", harness: "claude", model: "sonnet" }) }),
  );

  const off = await app.handle(new Request("http://localhost/harnesses/claude/enabled", { method: "PUT", ...json, body: JSON.stringify({ enabled: false }) }));
  expect(await off.json()).toEqual({ enabled: false });

  // the flag rides both reads: /engines settings and the engine rows stay untouched
  const engines = (await (await app.handle(new Request("http://localhost/engines"))).json()) as {
    engines: Array<{ enabled: boolean }>;
    settings: { harnesses: Record<string, boolean> };
  };
  expect(engines.settings.harnesses).toEqual({ pi: true, claude: false });
  expect(engines.engines[0].enabled).toBe(true);

  const dbFlag = db.harnessEnabled("claude");
  expect(dbFlag).toBe(false);

  const backOn = await app.handle(new Request("http://localhost/harnesses/claude/enabled", { method: "PUT", ...json, body: JSON.stringify({ enabled: true }) }));
  expect(await backOn.json()).toEqual({ enabled: true });
  expect(db.harnessEnabled("claude")).toBe(true);

  const unknown = await app.handle(new Request("http://localhost/harnesses/codex/enabled", { method: "PUT", ...json, body: JSON.stringify({ enabled: true }) }));
  expect(unknown.status).toBe(404);
  const bad = await app.handle(new Request("http://localhost/harnesses/claude/enabled", { method: "PUT", ...json, body: JSON.stringify({ enabled: "yes" }) }));
  expect(bad.status).toBe(422);
});
