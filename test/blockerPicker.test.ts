import { expect, test } from "bun:test";
import type { Task } from "../src/db";
import { BLOCKER_PICKER_MAX, blockerCandidates } from "../web/src/lib/blockerPicker";

function makeTask(partial: Partial<Task> & { id: string; title: string; laneId: string }): Task {
  return {
    note: "",
    project: "",
    tags: [],
    parentId: null,
    previousLane: null,
    workspace: null,
    priority: "normal",
    position: 100,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

test("blockerCandidates: title and id matches, ranked, self and current blockers excluded", () => {
  const tasks = [
    makeTask({ id: "self1", title: "the card itself", laneId: "backlog" }),
    makeTask({ id: "b1", title: "auth layer refactor", laneId: "backlog" }), // title substring
    makeTask({ id: "c1", title: "everything refactor", laneId: "plan" }), // title substring
    makeTask({ id: "refac", title: "unrelated title", laneId: "backlog" }), // id prefix
    makeTask({ id: "pre1", title: "refactor now", laneId: "done" }), // title prefix — ranks first of the substring matches
    makeTask({ id: "cur1", title: "refactor the current blocker", laneId: "backlog" }), // already a blocker
    makeTask({ id: "note1", title: "nothing here", laneId: "backlog", note: "refactor mentioned only in the note" }), // note-only match
  ];

  const out = blockerCandidates(tasks, "refac", "self1", ["cur1"]);

  expect(out.map((t) => t.id)).toEqual(["pre1", "b1", "c1", "refac"]);
  expect(out.map((t) => t.id)).not.toContain("self1");
  expect(out.map((t) => t.id)).not.toContain("cur1");
  expect(out.map((t) => t.id)).not.toContain("note1"); // note/checklist/tag rows are not picker candidates
});

test("blockerCandidates: caps at BLOCKER_PICKER_MAX", () => {
  const tasks = Array.from({ length: BLOCKER_PICKER_MAX + 4 }, (_, i) =>
    makeTask({ id: `cap${i}`, title: `cap target ${i}`, laneId: "backlog" }),
  );
  expect(blockerCandidates(tasks, "cap", "me", [])).toHaveLength(BLOCKER_PICKER_MAX);
});

test("blockerCandidates: empty or whitespace query returns []", () => {
  const tasks = [makeTask({ id: "a1", title: "anything", laneId: "backlog" })];
  expect(blockerCandidates(tasks, "", "me", [])).toEqual([]);
  expect(blockerCandidates(tasks, "   ", "me", [])).toEqual([]);
});
