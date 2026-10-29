import { expect, test } from "bun:test";
import type { Attachment, Task } from "../src/db";
import { checklistLines, searchBoard } from "../src/search";

function task(partial: Partial<Task> & { id: string; title: string }): Task {
  return {
    note: "",
    laneId: "backlog",
    project: "",
    parentId: null,
    previousLane: null,
    priority: "normal",
    position: 100,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

function plan(taskId: string, content: string): Attachment {
  return { id: "p1", taskId, kind: "plan", version: 1, content, source: "/tmp/p.md", createdAt: 1 };
}

test("parses checked and unchecked checklist lines, ignoring plain bullets", () => {
  const items = checklistLines(
    ["intro line", "- [ ] first", "  * [x] second", "- plain bullet", "- [X] third", "- [ ]"].join("\n"),
  );
  expect(items).toEqual([
    { text: "first", checked: false, line: 1 },
    { text: "second", checked: true, line: 2 },
    { text: "third", checked: true, line: 4 },
  ]);
});

test("empty and whitespace queries return no results", () => {
  const tasks = [task({ id: "aa1", title: "write docs" })];
  expect(searchBoard(tasks, "")).toEqual([]);
  expect(searchBoard(tasks, "   ")).toEqual([]);
});

test("ranks title prefix over substring over id prefix", () => {
  const tasks = [
    task({ id: "zz9", title: "fix login" }),
    task({ id: "lo3", title: "login page flows" }),
    task({ id: "log1", title: "unrelated" }),
  ];
  const results = searchBoard(tasks, "lo");
  expect(results.map((r) => r.task.id)).toEqual(["lo3", "zz9", "log1"]);
  expect(results[0]!.kind).toBe("title");
  expect(results[0]!.score).toBe(100);
  expect(results.at(-1)!.score).toBe(70); // id prefix still shows the card by title
});

test("lists matching checklist items as their own results", () => {
  const parent = task({
    id: "ep1",
    title: "auth epic",
    note: "- [ ] refresh token rotation\n- [x] audit log export\nplain context line",
  });
  const results = searchBoard([parent], "token");
  expect(results).toHaveLength(1);
  expect(results[0]!.kind).toBe("checklist");
  expect(results[0]!.text).toBe("refresh token rotation");
  expect(results[0]!.checked).toBe(false);
  expect(results[0]!.task.id).toBe("ep1");
});

test("matches note body text as a snippet, deduped when the title matched", () => {
  const tasks = [
    task({ id: "n1", title: "research", note: "see the deep dive on caching strategies" }),
    task({ id: "n2", title: "caching", note: "caching is covered here" }),
  ];
  const results = searchBoard(tasks, "caching");
  expect(results).toHaveLength(2);
  // n2's title matched, so its note must not produce a second row
  expect(results.filter((r) => r.task.id === "n2")).toHaveLength(1);
  const note = results.find((r) => r.task.id === "n1")!;
  expect(note.kind).toBe("note");
  expect(note.text).toContain("caching");
});

test("truncates long note lines around the match with ellipses", () => {
  const long = "lorem ipsum ".repeat(20) + "needle" + " dolor sit amet".repeat(20);
  const results = searchBoard([task({ id: "l1", title: "t", note: long })], "needle");
  expect(results).toHaveLength(1);
  expect(results[0]!.text.length).toBeLessThanOrEqual(82); // window + ellipses
  expect(results[0]!.text).toContain("needle");
  expect(results[0]!.text.startsWith("…")).toBe(true);
});

test("skips checklist lines when matching note body", () => {
  const t = task({ id: "s1", title: "t", note: "- [ ] unique-marker item" });
  const results = searchBoard([t], "unique-marker");
  expect(results).toHaveLength(1);
  expect(results[0]!.kind).toBe("checklist");
});

test("caps results and orders by score, ties keeping board order", () => {
  const tasks = Array.from({ length: 30 }, (_, i) => task({ id: `t${i}`, title: `sweep ${i}` }));
  const results = searchBoard(tasks, "sweep");
  expect(results).toHaveLength(20);
  expect(results[0]!.task.id).toBe("t0"); // equal scores fall back to array order
});

test("matches plan text below note matches; title matches suppress the plan row", () => {
  const tasks = [
    task({ id: "p1", title: "migrate db", note: "see the runbook" }),
    task({ id: "p2", title: "ops doc", note: "" }),
    task({ id: "p3", title: "runbook", note: "" }),
  ];
  const plans = {
    p1: plan("p1", "# migration plan\n1. dump the runbook data"),
    p2: plan("p2", "runbook rewrite plan"),
    p3: plan("p3", "runbook v2 — title already matched"),
  };
  const results = searchBoard(tasks, "runbook", plans);
  // p1: note matches (40) and plan matches (35) → two rows, note first;
  // p2: plan only; p3: title matched, so no plan row — the card shows up once
  expect(results.filter((r) => r.task.id === "p1").map((r) => r.kind)).toEqual(["note", "plan"]);
  const p2Rows = results.filter((r) => r.task.id === "p2");
  expect(p2Rows).toHaveLength(1);
  expect(p2Rows[0]!.kind).toBe("plan");
  expect(results.filter((r) => r.task.id === "p3").map((r) => r.kind)).toEqual(["title"]);

  // without plans passed (legacy call sites) the note and title rows still surface
  expect(searchBoard(tasks, "runbook")).toHaveLength(2);
});
