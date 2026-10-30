import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { KanbanDb } from "../src/db";
import { startAutoReview } from "../src/autoreview";

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
  const readChunk = async () => decoder.decode((await reader.read()).value);

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
  const readChunk = async () => new TextDecoder().decode((await reader.read()).value);
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
  expect(await empty.json()).toEqual({ planner: null, reviewer: null, builder: null, "plan-reviewer": null, elaborator: null });

  const put = await app.handle(
    new Request("http://localhost/agents/reviewer", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "anthropic",
        model: "claude-opus-4-5",
        thinking: "high",
        skills: ["~/.pi/agent/skills/scrutinize"],
        context: "we value perf",
        timeoutMs: 1_200_000,
      }),
    }),
  );
  expect(put.status).toBe(200);
  expect(await put.json()).toMatchObject({ model: "claude-opus-4-5", thinking: "high" });

  const got = await app.handle(new Request("http://localhost/agents"));
  expect(await got.json()).toMatchObject({ reviewer: { provider: "anthropic" }, builder: null });

  const putPlanReviewer = await app.handle(
    new Request("http://localhost/agents/plan-reviewer", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai/gpt-5.2", thinking: "medium" }),
    }),
  );
  expect(putPlanReviewer.status).toBe(200);
  const gotAll = (await app.handle(new Request("http://localhost/agents"))).json() as Promise<{
    "plan-reviewer": { model?: string; thinking?: string } | null;
  }>;
  expect((await gotAll)["plan-reviewer"]).toMatchObject({ model: "openai/gpt-5.2", thinking: "medium" });

  const json = { headers: { "content-type": "application/json" } };
  const putBody = (body: unknown) => ({ ...json, body: JSON.stringify(body) });
  const badRole = await app.handle(new Request("http://localhost/agents/worker", { method: "PUT", ...putBody({}) }));
  expect(badRole.status).toBe(422);
  const unknownKey = await app.handle(
    new Request("http://localhost/agents/reviewer", { method: "PUT", ...putBody({ temperature: 0.2 }) }),
  );
  expect(unknownKey.status).toBe(200); // Elysia strips unknown fields rather than rejecting them
  expect(await unknownKey.json()).toEqual({});
  const badThinking = await app.handle(
    new Request("http://localhost/agents/reviewer", { method: "PUT", ...putBody({ thinking: "ultra" }) }),
  );
  expect(badThinking.status).toBe(422);
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
  expect(await res.json()).toEqual({ sessions: [], queued: [] });
});

test("GET /health reports a boot stamp so clients can detect restarts", async () => {
  const app = createApp(db);
  const res = await app.handle(new Request("http://localhost/health"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; booted: number };
  expect(body.ok).toBe(true);
  expect(body.booted).toBeLessThanOrEqual(Date.now());
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

test("GET/PUT/DELETE /pools roundtrip; schema 422, semantic 400, missing 404", async () => {
  const app = createApp(db);

  // empty GET → { pools: [], settings: { maxWorkers: 12 } }
  const empty = await app.handle(new Request("http://localhost/pools"));
  expect(empty.status).toBe(200);
  expect(await empty.json()).toEqual({ pools: [], settings: { maxWorkers: 12 } });

  const json = { headers: { "content-type": "application/json" } };
  const putBody = (body: unknown) => ({ ...json, body: JSON.stringify(body) });

  // PUT valid body → 200 + saved pool reflected in GET
  const validPut = await app.handle(
    new Request("http://localhost/pools/heavy", {
      method: "PUT",
      ...putBody({
        name: "heavy pool",
        enabled: true,
        roles: ["builder"],
        slots: [{ provider: "anthropic", model: "claude-3-5-sonnet", thinking: "high" }],
      }),
    }),
  );
  expect(validPut.status).toBe(200);
  const saved = await validPut.json();
  expect(saved).toMatchObject({
    id: "heavy",
    name: "heavy pool",
    enabled: true,
    roles: ["builder"],
    slots: [{ provider: "anthropic", model: "claude-3-5-sonnet", thinking: "high" }],
  });

  const got = await app.handle(new Request("http://localhost/pools"));
  expect(got.status).toBe(200);
  expect(await got.json()).toEqual({ pools: [saved], settings: { maxWorkers: 12 } });

  // Schema 422: roles: []
  const emptyRoles = await app.handle(
    new Request("http://localhost/pools/p1", {
      method: "PUT",
      ...putBody({ name: "p1", roles: [], slots: [{ model: "m" }] }),
    }),
  );
  expect(emptyRoles.status).toBe(422);

  // Schema 422: 9 slots
  const nineSlots = Array.from({ length: 9 }, (_, i) => ({ model: `m-${i}` }));
  const tooManySlots = await app.handle(
    new Request("http://localhost/pools/p1", {
      method: "PUT",
      ...putBody({ name: "p1", roles: ["builder"], slots: nineSlots }),
    }),
  );
  expect(tooManySlots.status).toBe(422);

  // Schema 422: unknown role string
  const badRole = await app.handle(
    new Request("http://localhost/pools/p1", {
      method: "PUT",
      ...putBody({ name: "p1", roles: ["unknown-role"], slots: [{ model: "m" }] }),
    }),
  );
  expect(badRole.status).toBe(422);

  // Schema 422: empty name
  const emptyName = await app.handle(
    new Request("http://localhost/pools/p1", {
      method: "PUT",
      ...putBody({ name: "", roles: ["builder"], slots: [{ model: "m" }] }),
    }),
  );
  expect(emptyName.status).toBe(422);

  // Semantic 400 { code: "invalid" }: PUT making a 13th enabled slot
  // Current enabled slots: 1 (from heavy). Set up 8 slots on pool 1, then attempt 5 slots on pool 2:
  const eightSlots = Array.from({ length: 8 }, (_, i) => ({ model: `m-${i}` }));
  const put8 = await app.handle(
    new Request("http://localhost/pools/p1", {
      method: "PUT",
      ...putBody({ name: "p1", enabled: true, roles: ["builder"], slots: eightSlots }),
    }),
  );
  expect(put8.status).toBe(200);

  const fiveSlots = Array.from({ length: 5 }, (_, i) => ({ model: `m2-${i}` }));
  const putOver12 = await app.handle(
    new Request("http://localhost/pools/p2", {
      method: "PUT",
      ...putBody({ name: "p2", enabled: true, roles: ["reviewer"], slots: fiveSlots }),
    }),
  );
  expect(putOver12.status).toBe(400);
  expect(await putOver12.json()).toMatchObject({ code: "invalid" });

  // DELETE → 200 and gone from GET
  const del = await app.handle(new Request("http://localhost/pools/heavy", { method: "DELETE" }));
  expect(del.status).toBe(200);
  expect(await del.json()).toEqual({ ok: true });

  const afterDel = await app.handle(new Request("http://localhost/pools"));
  const afterDelList = ((await afterDel.json()) as { pools: Array<{ id: string }> }).pools;
  expect(afterDelList.map((p) => p.id)).not.toContain("heavy");

  // DELETE unknown id → 404 { code: "not-found" }
  const delMissing = await app.handle(new Request("http://localhost/pools/non-existent", { method: "DELETE" }));
  expect(delMissing.status).toBe(404);
  expect(await delMissing.json()).toMatchObject({ code: "not-found" });

  // PUT pool (3 slots) with maxWorkers: 2 → 200 with maxWorkers: 2 and persists in GET
  const threeSlots = [{ model: "m-0" }, { model: "m-1" }, { model: "m-2" }];
  const putCap = await app.handle(
    new Request("http://localhost/pools/capped", {
      method: "PUT",
      ...putBody({ name: "capped", roles: ["builder"], slots: threeSlots, maxWorkers: 2 }),
    }),
  );
  expect(putCap.status).toBe(200);
  const savedCap = await putCap.json();
  expect(savedCap).toMatchObject({ id: "capped", maxWorkers: 2 });

  const gotCapped = await app.handle(new Request("http://localhost/pools"));
  const cappedInGet = ((await gotCapped.json()) as { pools: Array<{ id: string; maxWorkers?: number }> }).pools.find(
    (p) => p.id === "capped",
  );
  expect(cappedInGet?.maxWorkers).toBe(2);

  // maxWorkers: 4 (3 slots) → 400 { code: "invalid" }
  const putCapTooHigh = await app.handle(
    new Request("http://localhost/pools/capped", {
      method: "PUT",
      ...putBody({ name: "capped", roles: ["builder"], slots: threeSlots, maxWorkers: 4 }),
    }),
  );
  expect(putCapTooHigh.status).toBe(400);
  expect(await putCapTooHigh.json()).toMatchObject({ code: "invalid" });

  // maxWorkers: 0 → 422
  const putCapZero = await app.handle(
    new Request("http://localhost/pools/capped", {
      method: "PUT",
      ...putBody({ name: "capped", roles: ["builder"], slots: threeSlots, maxWorkers: 0 }),
    }),
  );
  expect(putCapZero.status).toBe(422);
});

test("PUT /pools/settings round-trips; GET /pools carries settings", async () => {
  const app = createApp(db);
  const json = { headers: { "content-type": "application/json" } };
  const putBody = (body: unknown) => ({ ...json, body: JSON.stringify(body) });

  const put5 = await app.handle(
    new Request("http://localhost/pools/settings", {
      method: "PUT",
      ...putBody({ maxWorkers: 5 }),
    }),
  );
  expect(put5.status).toBe(200);
  expect(await put5.json()).toEqual({ maxWorkers: 5 });

  const got = await app.handle(new Request("http://localhost/pools"));
  expect(got.status).toBe(200);
  expect(((await got.json()) as any).settings).toEqual({ maxWorkers: 5 });

  const put0 = await app.handle(
    new Request("http://localhost/pools/settings", {
      method: "PUT",
      ...putBody({ maxWorkers: 0 }),
    }),
  );
  expect(put0.status).toBe(422);

  const put21 = await app.handle(
    new Request("http://localhost/pools/settings", {
      method: "PUT",
      ...putBody({ maxWorkers: 21 }),
    }),
  );
  expect(put21.status).toBe(422);

  const putFraction = await app.handle(
    new Request("http://localhost/pools/settings", {
      method: "PUT",
      ...putBody({ maxWorkers: 2.5 }),
    }),
  );
  expect(putFraction.status).toBe(400);
  expect(await putFraction.json()).toMatchObject({ code: "invalid" });
});

test("/activity carries the resolved model per session", async () => {
  const app = createApp(db);
  db.setPool("heavy", {
    name: "heavy pool",
    enabled: true,
    roles: ["reviewer"],
    slots: [
      { provider: "anthropic", model: "claude-3-5-sonnet" },
      { provider: "openai", model: "gpt-4o" },
    ],
  });

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
  const data = (await res.json()) as { sessions: Array<{ taskId: string; model?: string; modelLabel?: string; pool?: string }> };
  expect(data.sessions.length).toBe(2);

  const models = data.sessions.map((s) => s.model);
  expect(models).toContain("claude-3-5-sonnet");
  expect(models).toContain("gpt-4o");

  const labels = data.sessions.map((s) => s.modelLabel);
  expect(labels).toContain("anthropic · claude-3-5-sonnet · max");
  expect(labels).toContain("openai · gpt-4o · max");

  for (const s of data.sessions) {
    expect(s.pool).toBe("heavy pool");
    expect(s.modelLabel).toContain("· max");
  }

  handle.stop();
  for (const f of finishes) f();
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
