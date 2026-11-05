import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treaty } from "@elysiajs/eden";
import { createApp } from "../src/app";
import { CHAT_SESSION_ID_PREFIX } from "../src/chat";
import { KanbanDb } from "../src/db";
import type { App } from "../src/app";

let dir = "";
let db: KanbanDb;
let sessionDir = "";
const savedEnv: Record<string, string | undefined> = {};

/** Repo pattern (cf. gateFail in TaskDetail): Eden wraps non-2xx bodies in `{ status, value }`. */
function errorValue(error: unknown): unknown {
  return (error as { value?: unknown } | undefined)?.value;
}

/** Fake SDK session — only the surface ChatHandleImpl touches. */
function fakeSession(overrides: Record<string, unknown> = {}) {
  const listeners = new Set<(event: unknown) => void>();
  return {
    subscribe: (listener: (event: unknown) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isStreaming: false,
    isCompacting: false,
    model: null,
    thinkingLevel: "off",
    getAvailableThinkingLevels: () => ["off", "low", "medium", "high"] as string[],
    supportsThinking: () => true,
    setModel: async function (this: { model: unknown }, model: unknown) {
      this.model = model;
    },
    setThinkingLevel: function (this: { thinkingLevel: string }, level: string) {
      this.thinkingLevel = level;
    },
    // catalog stand-in: resolves anything but provider "nope" (the unknown-model miss)
    modelRuntime: { getModel: (provider: string, id: string) => (provider === "nope" ? undefined : { provider, id }) },
    getSteeringMessages: () => [] as string[],
    getFollowUpMessages: () => [] as string[],
    agent: { state: {} },
    prompt: async () => {},
    steer: async () => "queued" as const,
    followUp: async () => "queued" as const,
    abort: async () => {},
    dispose: () => {},
    ...overrides,
  };
}

function appWithChat(sessions?: unknown[]): App {
  return createApp(db, {
    chat: {
      cwd: dir,
      sessionDir,
      createSession: async (opts) => {
        const session = fakeSession();
        sessions?.push({ ...opts, session });
        return session as never;
      },
    },
  }) as App;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kanban-chat-api-"));
  db = new KanbanDb(join(dir, "t.db"));
  sessionDir = join(dir, "sessions");
  for (const key of ["KANBAN_CHAT_SSE_BACKLOG_LIMIT_BYTES", "KANBAN_CHAT_SSE_HEARTBEAT_MS"]) {
    savedEnv[key] = process.env[key];
  }
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("GET /chat/:id: idle empty state, disk-backed history, 404 unknown card", async () => {
  const task = db.createTask({ title: "one", note: "note body" });
  const client = treaty(appWithChat());

  const idle = await client.chat({ cardId: task.id }).get();
  expect(idle.error).toBeNull();
  expect(idle.data).toMatchObject({
    running: false,
    sessionId: null,
    isStreaming: false,
    isCompacting: false,
    messages: [],
    messagesTruncated: false,
    thinkingLevel: "off",
  });

  // A session file on disk feeds the read-only state without running a session.
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const sm = SessionManager.create(dir, sessionDir, { id: CHAT_SESSION_ID_PREFIX + task.id });
  sm.appendMessage({ role: "user", content: "hello from disk", timestamp: 1 });

  const withHistory = await client.chat({ cardId: task.id }).get();
  expect(withHistory.error).toBeNull();
  expect(withHistory.data?.running).toBe(false);
  expect(withHistory.data?.sessionId).toBe(CHAT_SESSION_ID_PREFIX + task.id);
  expect(withHistory.data?.messages.some((m) => m.role === "user" && m.content === "hello from disk")).toBe(true);

  const missing = await client.chat({ cardId: "zzzzz" }).get();
  expect(missing.status).toBe(404);
  expect(errorValue(missing.error)).toMatchObject({ code: "not-found" });
});

test("POST prompt accepted; streaming refusal 409; abort stops; invalid body 422 (Eden round-trip)", async () => {
  const task = db.createTask({ title: "chaty" });
  const sessions: unknown[] = [];
  const client = treaty(appWithChat(sessions));

  const accepted = await client.chat({ cardId: task.id }).post({ type: "prompt", message: "hi" });
  expect(accepted.error).toBeNull();
  expect(accepted.data).toEqual({ accepted: true, disposition: "started" });

  // Second prompt: the fake session stays idle, still accepted (no re-seed check here).
  const again = await client.chat({ cardId: task.id }).post({ type: "prompt", message: "go on" });
  expect(again.data).toEqual({ accepted: true, disposition: "started" });

  const live = sessions[0] as { session: Record<string, unknown> };
  live.session.isStreaming = true;
  const refused = await client.chat({ cardId: task.id }).post({ type: "prompt", message: "interrupt me" });
  expect(refused.status).toBe(409);
  expect(errorValue(refused.error)).toEqual({ error: "chat is streaming — send steer or followUp", code: "conflict" });

  const steered = await client.chat({ cardId: task.id }).post({ type: "prompt", message: "quick", streamingBehavior: "steer" });
  expect(steered.data).toEqual({ accepted: true, disposition: "started" });

  const aborted = await client.chat({ cardId: task.id }).post({ type: "abort" });
  expect(aborted.error).toBeNull();
  expect(aborted.data).toEqual({ stopped: true });

  // @ts-expect-error probing the validation boundary with an unknown command
  const invalid = await client.chat({ cardId: task.id }).post({ type: "nope" });
  expect(invalid.status).toBe(422);

  const missing = await client.chat({ cardId: "zzzzz" }).post({ type: "prompt", message: "hi" });
  expect(missing.status).toBe(404);
  expect(errorValue(missing.error)).toMatchObject({ code: "not-found" });
});

test("POST setModel/setThinkingLevel: state round-trip, unknown model 409, invalid level 422", async () => {
  const task = db.createTask({ title: "picky" });
  const sessions: unknown[] = [];
  const client = treaty(appWithChat(sessions));

  // unknown model: the fake runtime catalog resolves nothing → 409 with the id echoed
  const unknown = await client.chat({ cardId: task.id }).post({ type: "setModel", provider: "nope", modelId: "nope" });
  expect(unknown.status).toBe(409);
  expect(errorValue(unknown.error)).toEqual({ error: "unknown model 'nope/nope'", code: "conflict" });

  // a setModel POST boots the session lazily (same as prompt) — happy path answers
  // with the fresh ChatState, incl. the thinking surface the picker needs
  const applied = await client.chat({ cardId: task.id }).post({ type: "setModel", provider: "zai", modelId: "glm-5.3" });
  expect(applied.error).toBeNull();
  expect(applied.data).toMatchObject({
    running: true,
    model: { provider: "zai", id: "glm-5.3" },
    thinkingLevel: "off",
    thinkingLevels: ["off", "low", "medium", "high"],
    supportsThinking: true,
  });

  const level = await client.chat({ cardId: task.id }).post({ type: "setThinkingLevel", level: "high" });
  expect(level.error).toBeNull();
  expect(level.data).toMatchObject({ thinkingLevel: "high" });

  // @ts-expect-error probing the validation boundary with a non-level string
  const bogus = await client.chat({ cardId: task.id }).post({ type: "setThinkingLevel", level: "ultra" });
  expect(bogus.status).toBe(422);
});

test("GET /chat/:id/events opens transport, sends connected, heartbeats as data events", async () => {
  const task = db.createTask({ title: "stream" });
  const app = appWithChat();
  const client = treaty(app);

  const res = await client.chat({ cardId: task.id }).events.get();
  expect(res instanceof Response || typeof res === "object").toBe(true);
  // treaty returns the raw Response for non-JSON; go through app.handle for the stream checks
  const raw = await app.handle(new Request(`http://localhost/chat/${task.id}/events`));
  expect(raw.status).toBe(200);
  expect(raw.headers.get("content-type")).toBe("text/event-stream");

  process.env.KANBAN_CHAT_SSE_HEARTBEAT_MS = "50";
  const streamRes = await app.handle(new Request(`http://localhost/chat/${task.id}/events`));
  const reader = streamRes.body!.getReader();
  const decoder = new TextDecoder();
  expect(decoder.decode((await reader.read()).value)).toBe(":\n\n");
  const connected = JSON.parse(decoder.decode((await reader.read()).value).replace(/^data: /, ""));
  expect(connected).toEqual({ type: "connected", isStreaming: false });
  const heartbeat = JSON.parse(decoder.decode((await reader.read()).value).replace(/^data: /, ""));
  expect(heartbeat).toEqual({ type: "heartbeat" });
  await reader.cancel();

  const unknown = await app.handle(new Request("http://localhost/chat/zzzzz/events"));
  expect(unknown.status).toBe(404);
});

test("/restart counts chat sessions in the in-flight guard", async () => {
  const task = db.createTask({ title: "guard" });
  const sessions: unknown[] = [];
  const app = appWithChat(sessions);
  const client = treaty(app);

  await client.chat({ cardId: task.id }).post({ type: "prompt", message: "hold the session" });
  const refused = await client.restart.post();
  expect(refused.status).toBe(409);
  expect(errorValue(refused.error)).toMatchObject({ code: "sessions-in-flight", sessions: 1 });
});

test("GET/PUT /chat-board round-trips the scope; unknown project 404s", async () => {
  const alphaDir = join(dir, "alpha-repo");
  mkdirSync(alphaDir);
  db.addProject("alpha", alphaDir);
  const client = treaty(appWithChat());

  const fresh = await client["chat-board"].get();
  expect(fresh.error).toBeNull();
  expect(fresh.data).toEqual({ project: null });

  const set = await client["chat-board"].put({ project: "alpha" });
  expect(set.error).toBeNull();
  expect(set.data).toEqual({ project: "alpha" });
  expect((await client["chat-board"].get()).data).toEqual({ project: "alpha" });

  const unknown = await client["chat-board"].put({ project: "nope" });
  expect(unknown.status).toBe(404);
  expect(errorValue(unknown.error)).toEqual({ error: "unknown project 'nope'", code: "not-found" });

  const cleared = await client["chat-board"].put({ project: null });
  expect(cleared.error).toBeNull();
  expect(cleared.data).toEqual({ project: null });
  expect(db.managerChatProject()).toBeNull();
});

test("scoped handle over HTTP: cold GET, prompt boots in the project repo, unknown 404s", async () => {
  const alphaDir = join(dir, "alpha-repo");
  mkdirSync(alphaDir);
  db.addProject("alpha", alphaDir);
  const sessions: unknown[] = [];
  const client = treaty(appWithChat(sessions));

  // cold: no alpha session yet, the scoped handle is not a card
  const cold = await client.chat({ cardId: "board:alpha" }).get();
  expect(cold.error).toBeNull();
  expect(cold.data).toMatchObject({ running: false, sessionId: null, messages: [], messagesTruncated: false });

  // the session boots in the project's repo — exactly what a 'pwd' probe observes
  const post = await client.chat({ cardId: "board:alpha" }).post({ type: "prompt", message: "pwd" });
  expect(post.error).toBeNull();
  expect(post.data).toMatchObject({ accepted: true });
  const capture = sessions[0] as { cwd: string; appendSystemPrompt: string };
  expect(capture.cwd).toBe(alphaDir);
  expect(capture.appendSystemPrompt).toContain("scoped to project `alpha`");

  const unknown = await client.chat({ cardId: "board:nope" }).get();
  expect(unknown.status).toBe(404);
  expect(errorValue(unknown.error)).toEqual({ error: "unknown project 'nope'", code: "not-found" });
});

test("scoped events route: unknown project 404s before the transport; scoped handle boots in the project repo", async () => {
  const alphaDir = join(dir, "alpha-repo");
  mkdirSync(alphaDir);
  db.addProject("alpha", alphaDir);
  const sessions: unknown[] = [];
  const app = appWithChat(sessions);

  // validation happens before the SSE transport opens: a JSON 404/400, never a stream
  const unknown = await app.handle(new Request("http://localhost/chat/board:nope/events"));
  expect(unknown.status).toBe(404);
  expect(unknown.headers.get("content-type")).not.toContain("text/event-stream");
  expect(await unknown.json()).toEqual({ error: "unknown project 'nope'", code: "not-found" });

  const blank = await app.handle(new Request("http://localhost/chat/board:/events"));
  expect(blank.status).toBe(400);
  expect(blank.headers.get("content-type")).not.toContain("text/event-stream");
  expect(await blank.json()).toEqual({
    error: "scoped board handle needs a project after ':' — use 'board' for the whole board",
    code: "invalid",
  });

  const ok = await app.handle(new Request("http://localhost/chat/board:alpha/events"));
  expect(ok.status).toBe(200);
  expect(ok.headers.get("content-type")).toBe("text/event-stream");
  const reader = ok.body!.getReader();
  const decoder = new TextDecoder();
  expect(decoder.decode((await reader.read()).value)).toBe(":\n\n");
  const connected = JSON.parse(decoder.decode((await reader.read()).value).replace(/^data: /, ""));
  expect(connected).toEqual({ type: "connected", isStreaming: false });
  expect((sessions[0] as { cwd: string }).cwd).toBe(alphaDir);
  await reader.cancel();

  // plain unknown card still 404s as before
  expect((await app.handle(new Request("http://localhost/chat/zzzzz/events"))).status).toBe(404);
});

test("scoped handle names with URL-special characters survive percent-encoding", async () => {
  const weird = join(dir, "repo a");
  mkdirSync(weird);
  db.addProject("a/b c", weird); // free-form tag: slash and space are legal
  const sessions: unknown[] = [];
  const app = appWithChat(sessions);
  const handle = "board:a/b c";

  // Eden joins path params verbatim, so clients percent-encode the handle; the route decodes it
  const cold = await app.handle(new Request(`http://localhost/chat/${encodeURIComponent(handle)}`));
  expect(cold.status).toBe(200);
  expect(await cold.json()).toMatchObject({ running: false, sessionId: null, messages: [] });

  const events = await app.handle(new Request(`http://localhost/chat/${encodeURIComponent(handle)}/events`));
  expect(events.status).toBe(200);
  expect(events.headers.get("content-type")).toBe("text/event-stream");
  expect((sessions[0] as { cwd: string }).cwd).toBe(weird);
  await events.body?.cancel();

  // an unencoded slash is a different path, not a different project
  expect((await app.handle(new Request(`http://localhost/chat/${handle}/events`))).status).toBe(404);
});

test("GET/POST /chat/board: cold history-from-disk then prompt round-trip", async () => {
  const sessions: unknown[] = [];
  const client = treaty(appWithChat(sessions));

  // cold: the manager is not running and has no disk history
  const cold = await client.chat({ cardId: "board" }).get();
  expect(cold.error).toBeNull();
  expect(cold.data).toMatchObject({ running: false, sessionId: null, messages: [], messagesTruncated: false });

  // a prompt accepts through the fake factory; the handle is live afterwards
  const post = await client.chat({ cardId: "board" }).post({
    type: "prompt",
    message: "what needs attention?",
  });
  expect(post.error).toBeNull();
  expect(post.data).toMatchObject({ accepted: true });

  const live = await client.chat({ cardId: "board" }).get();
  expect(live.data).toMatchObject({ running: true, sessionId: "kanban-manager" });

  // the append carried the manager charter; the seed carried the overview
  const capture = sessions[0] as { appendSystemPrompt: string; session: Record<string, unknown> };
  expect(capture.appendSystemPrompt).toContain("board manager");
  void capture;

  // a real card is unaffected by the board branch
  const task = db.createTask({ title: "plain card" });
  const cardState = await client.chat({ cardId: task.id }).get();
  expect(cardState.data).toMatchObject({ running: false, sessionId: null });
});
