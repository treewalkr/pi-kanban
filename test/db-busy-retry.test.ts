import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KanbanDb } from "../src/db";

// Regression: bun:sqlite transactions are deferred, so under WAL a read→write
// transaction whose snapshot another process advanced fails immediately with
// SQLITE_BUSY — busy_timeout cannot rescue it (the 10/31 heartbeatLease /
// tryTakeLease crashes). KanbanDb.tx retries the whole transaction instead.
// In-process ops are synchronous, so the racing writer must be a real process.
let dir = "";
let db: KanbanDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kanban-busy-"));
  db = new KanbanDb(join(dir, "t.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("lease transactions survive a concurrent writer process", async () => {
  const path = join(dir, "t.db");
  const task = db.createTask({ title: "busy target", lane: "backlog" });
  db.tryTakeLease(task.id, "builder", { pid: 1, bootId: 1 }, 60_000);

  const writer = Bun.spawn({
    cmd: [
      process.execPath,
      "-e",
      `import { Database } from "bun:sqlite";
       const d = new Database(${JSON.stringify(path)});
       const end = Date.now() + 400;
       let n = 0;
       while (Date.now() < end) { try { d.exec("UPDATE tasks SET priority = priority"); n++; } catch {} }
       d.close(); console.log(n);`,
    ],
    stdout: "pipe",
  });
  await new Promise((r) => setTimeout(r, 50)); // let the writer warm up

  let beats = 0;
  const end = Date.now() + 400;
  while (Date.now() < end) {
    db.heartbeatLease(task.id, { pid: 1, bootId: 1 }); // threw SQLITE_BUSY pre-fix
    db.tryTakeLease(task.id, "builder", { pid: 2, bootId: 2 }, 0); // staleAfterMs 0 → always (re)claims
    beats++;
  }

  expect((await new Response(writer.stdout).text()).trim()).not.toBe("0");
  await writer.exited;
  expect(writer.exitCode).toBe(0);
  expect(beats).toBeGreaterThan(0);
  expect(db.leaseFor(task.id)?.ownerPid).toBe(2);
});
