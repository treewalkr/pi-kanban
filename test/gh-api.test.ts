import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { KanbanDb, type GhStatus, type Task } from "../src/db";

let dir = "";
let db: KanbanDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kanban-gh-api-"));
  db = new KanbanDb(join(dir, "t.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function seedCard(): Promise<string> {
  const app = createApp(db);
  const res = await app.handle(new Request("http://localhost/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "gh api card" }),
  }));
  return ((await res.json()) as Task).id;
}

const post = (app: ReturnType<typeof createApp>, id: string, ref: string) =>
  app.handle(new Request(`http://localhost/tasks/${id}/gh`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref }),
  }));

test("POST /tasks/:id/gh: 201, duplicate 409, bad ref 400", async () => {
  const app = createApp(db);
  const id = await seedCard();
  const url = "https://github.com/o/r/pull/12";

  const first = await post(app, id, url);
  expect(first.status).toBe(201);
  const body = (await first.json()) as { link: { url: string; kind: string; repo: string; number: number; cardId: string } };
  expect(body.link).toMatchObject({ url, kind: "pr", repo: "o/r", number: 12, cardId: id });

  const dup = await post(app, id, url);
  expect(dup.status).toBe(409);
  expect(((await dup.json()) as { error: string }).error).toBe(`card '${id}' already links ${url}`);

  const bad = await post(app, id, "https://gitlab.com/x");
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { error: string }).error).toBe(
    "not a GitHub pr/issue ref: 'https://gitlab.com/x' (expected https://github.com/{owner}/{repo}/pull/{n} or /issues/{n}, or gh:{owner}/{repo}#{n})",
  );

  // shorthand attaches offline as kind unknown with the canonical issues url
  const short = await post(app, id, "gh:o/r#7");
  expect(short.status).toBe(201);
  expect(((await short.json()) as { link: { kind: string; url: string } }).link).toMatchObject({
    kind: "unknown",
    url: "https://github.com/o/r/issues/7",
  });
});

test("DELETE /tasks/:id/gh/:linkId removes the link; unknown linkId is a 404-free false", async () => {
  const app = createApp(db);
  const id = await seedCard();
  const link = ((await (await post(app, id, "https://github.com/o/r/issues/3")).json()) as { link: { id: string } }).link;

  const del = await app.handle(new Request(`http://localhost/tasks/${id}/gh/${link.id}`, { method: "DELETE" }));
  expect(del.status).toBe(200);
  expect(((await del.json()) as { ok: boolean; removed: boolean })).toEqual({ ok: true, removed: true });

  const again = await app.handle(new Request(`http://localhost/tasks/${id}/gh/${link.id}`, { method: "DELETE" }));
  expect(((await again.json()) as { removed: boolean }).removed).toBe(false);
});

test("GET /gh/statuses serves cached rows; attach with stub gh fills the row", async () => {
  const app = createApp(db);

  // pure read: empty board → empty list, never spawns gh
  const empty = await app.handle(new Request("http://localhost/gh/statuses"));
  expect(((await empty.json()) as { statuses: unknown[] }).statuses).toEqual([]);

  const row: GhStatus = {
    url: "https://github.com/o/r/pull/1",
    kind: "pr",
    state: "MERGED",
    title: "cached",
    mergedAt: 1_700_000_000_000,
    fetchedAt: Date.now(),
    error: "",
  };
  db.setGhState(row);
  const cached = (await (await app.handle(new Request("http://localhost/gh/statuses"))).json()) as { statuses: GhStatus[] };
  expect(cached.statuses).toEqual([row]);

  // attach fires the guarded fire-and-forget refresh against a stub gh binary
  const id = await seedCard();
  const stub = join(dir, "fake-gh.sh");
  await Bun.write(
    stub,
    "#!/bin/sh\necho '{\"state\":\"OPEN\",\"mergedAt\":null,\"title\":\"stubbed pr\"}'\n",
  );
  await Bun.$`chmod +x ${stub}`.quiet();
  const savedBin = process.env.KANBAN_GH_BIN;
  const savedMs = process.env.KANBAN_GH_SYNC_MS;
  process.env.KANBAN_GH_BIN = stub;
  delete process.env.KANBAN_GH_SYNC_MS;
  try {
    const res = await post(app, id, "https://github.com/o/r/pull/12");
    expect(res.status).toBe(201);
    // the refresh runs in the background — poll for the cache row it writes
    for (let i = 0; i < 100; i++) {
      const statuses = (await (await app.handle(new Request("http://localhost/gh/statuses"))).json()) as {
        statuses: GhStatus[];
      };
      const found = statuses.statuses.find((s) => s.url === "https://github.com/o/r/pull/12");
      if (found?.state === "OPEN") {
        expect(found).toMatchObject({ kind: "pr", title: "stubbed pr", error: "" });
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("stub gh refresh never landed a gh_state row");
  } finally {
    if (savedBin === undefined) delete process.env.KANBAN_GH_BIN;
    else process.env.KANBAN_GH_BIN = savedBin;
    if (savedMs === undefined) delete process.env.KANBAN_GH_SYNC_MS;
    else process.env.KANBAN_GH_SYNC_MS = savedMs;
  }
});

test("board payload carries ghLinks per card", async () => {
  const app = createApp(db);
  const id = await seedCard();
  await post(app, id, "gh:o/r#21");
  const board = (await (await app.handle(new Request("http://localhost/board"))).json()) as {
    ghLinks: Record<string, Array<{ number: number; url: string }>>;
  };
  expect(board.ghLinks[id]).toHaveLength(1);
  expect(board.ghLinks[id][0]).toMatchObject({ number: 21, url: "https://github.com/o/r/issues/21" });
});
