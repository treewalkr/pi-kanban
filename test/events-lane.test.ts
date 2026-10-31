import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { KanbanDb } from "../src/db";

let dir = "";
let db: KanbanDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kanban-events-lane-"));
  db = new KanbanDb(join(dir, "t.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A raw Response body has no client-side SSE parsing — split the stream into SSE messages ourselves. */
function sseParser() {
  return {
    async next(reader: ReadableStreamDefaultReader<Uint8Array>, decoder: TextDecoder, deadlineMs = 2000) {
      const deadline = Date.now() + deadlineMs;
      let buffer = "";
      while (Date.now() < deadline) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const message = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          return message;
        }
        const chunk = await Promise.race([
          reader.read().then(({ value, done }) => (done || !value ? "" : decoder.decode(value))),
          new Promise<"">((resolve) => setTimeout(() => resolve("" as ""), deadline - Date.now())),
        ]);
        if (chunk === "") return buffer.trim() === "" ? null : buffer; // stream ended or deadline hit
        buffer += chunk;
      }
      return buffer.trim() === "" ? null : buffer;
    },
  };
}

async function subscribe(app: ReturnType<typeof createApp>) {
  const res = await app.handle(new Request("http://localhost/events"));
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const parser = sseParser();
  return { reader, read: (deadlineMs?: number) => parser.next(reader, decoder, deadlineMs) };
}

function patch(app: ReturnType<typeof createApp>, id: string, body: Record<string, unknown>): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/tasks/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

test("moving a card to review streams `event: lane` with the card payload, then `event: change`", async () => {
  const task = db.createTask({ title: "one" }); // before boot: the cursor skips its history
  const app = createApp(db);
  const { reader, read } = await subscribe(app);

  expect(await read()).toBe("event: change\ndata: {}"); // fresh subscriber syncs immediately

  await patch(app, task.id, { lane: "review" });

  const lane = await read();
  expect(lane).toMatch(/^event: lane\ndata: /);
  const payload = JSON.parse(lane!.slice("event: lane\ndata: ".length)) as Record<string, unknown>;
  expect(payload.taskId).toBe(task.id);
  expect(payload.title).toBe("one");
  expect(payload.fromLaneId).toBe("backlog");
  expect(payload.toLaneId).toBe("review");
  expect(payload.cause).toBe("edit");
  expect(payload.actor).toBe("user");
  expect(typeof payload.createdAt).toBe("number");

  expect(await read()).toBe("event: change\ndata: {}");
  await reader.cancel();
});

test("a fresh subscriber gets no historical lane events", async () => {
  const task = db.createTask({ title: "one" });
  db.moveTask(task.id, "plan"); // history predates the subscription
  const app = createApp(db);
  const { reader, read } = await subscribe(app);

  const first = await read();
  expect(first).toBe("event: change\ndata: {}");
  expect(first).not.toContain("event: lane");

  await patch(app, task.id, { lane: "review" }); // only writes after the subscription stream
  const lane = await read();
  expect(lane).toContain("event: lane");
  expect(lane).toContain('"toLaneId":"review"');
  await reader.cancel();
});

test("CLI-side writes (separate connection) stream lane events", async () => {
  const task = db.createTask({ title: "one" });
  const app = createApp(db);
  const { reader, read } = await subscribe(app);
  expect(await read()).toBe("event: change\ndata: {}");

  // a second connection on the same file — what `kanban mv` does from a terminal
  const cli = new KanbanDb(join(dir, "t.db"));
  cli.moveTask(task.id, "review");
  cli.close();

  const lane = await read(1500); // 300 ms watch poll + 100 ms coalesce, with slack
  expect(lane).toContain("event: lane");
  const data = lane!.slice(lane!.indexOf("data: ") + 6).split("\n")[0];
  const payload = JSON.parse(data) as { taskId: string; toLaneId: string; cause: string };
  expect(payload.taskId).toBe(task.id);
  expect(payload.toLaneId).toBe("review");
  expect(payload.cause).toBe("mv");
  await reader.cancel();
});
