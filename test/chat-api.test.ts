import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
