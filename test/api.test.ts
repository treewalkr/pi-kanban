import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { KanbanDb } from "../src/db";

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
  expect(await rejected.json()).toMatchObject({ kind: "rejection", author: "user" });
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
  expect(await empty.json()).toEqual({ planner: null, reviewer: null, builder: null, "plan-reviewer": null });

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

test("GET /activity lists in-flight agent sessions (none when idle)", async () => {
  const app = createApp(db);
  const res = await app.handle(new Request("http://localhost/activity"));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ sessions: [] });
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
