import { expect, test } from "bun:test";
import type { BoardStatsPayload, Task } from "../src/db";
import { cycleChip, laneAgeChip, laneDwellLabel } from "../web/src/lib/statsview";

function task(partial: Partial<Task> & { id: string; title: string }): Task {
  return {
    note: "",
    laneId: "backlog",
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

test("laneDwellLabel + cycleChip derive labels and stay null-safe", () => {
  const tActive = task({ id: "t1", title: "Active Card", laneId: "implement" });
  const tDone = task({ id: "t2", title: "Done Card", laneId: "done" });

  // 1. null stats -> both null
  expect(laneDwellLabel(null, "implement")).toBeNull();
  expect(cycleChip(null, tActive)).toBeNull();

  // 2. Mock payload with visitors and card stats
  const payload: BoardStatsPayload = {
    board: {
      wip: 1,
      throughput: [],
      laneDwell: {
        implement: { avgMs: 2 * 86_400_000, cards: 3 }, // 2d avg
      },
      projects: [],
      cycleAvgMs: 100_000,
    },
    cards: {
      t1: {
        taskId: "t1",
        laneTimes: [{ laneId: "implement", ms: 50_000 }],
        cycleMs: 50_000,
        currentLaneMs: 50_000,
        gateWaitMs: 0,
        reachedDone: false,
        reviewToDoneMs: null,
        planReviewBlocks: 0,
        reviewBlocks: 0,
        cappedHits: 0,
        planVersions: 0,
        sessions: { count: 0, totalMs: 0 },
      },
      t2: {
        taskId: "t2",
        laneTimes: [{ laneId: "done", ms: 200_000 }],
        cycleMs: 200_000,
        currentLaneMs: 200_000,
        gateWaitMs: 0,
        reachedDone: true,
        reviewToDoneMs: 50_000,
        planReviewBlocks: 0,
        reviewBlocks: 0,
        cappedHits: 0,
        planVersions: 1,
        sessions: { count: 1, totalMs: 15_000 },
      },
    },
    generatedAt: Date.now(),
  };

  // Visited lane label
  expect(laneDwellLabel(payload, "implement")).toBe("2d avg");

  // Unvisited lane returns null
  expect(laneDwellLabel(payload, "backlog")).toBeNull();

  // Active card cycleChip
  const activeChip = cycleChip(payload, tActive);
  expect(activeChip).toEqual({
    label: "1m",
    title: "age — created → now",
  });

  // Done card cycleChip
  const doneChip = cycleChip(payload, tDone);
  expect(doneChip).toEqual({
    label: "3m",
    title: "cycle time — created → first done",
  });

  // Missing card in stats returns null
  const tUnknown = task({ id: "t3", title: "Unknown" });
  expect(cycleChip(payload, tUnknown)).toBeNull();
});

test("laneAgeChip formats lane age and stays null-safe", () => {
  const t = task({ id: "t1", title: "Implement Card", laneId: "implement" });
  const card = (currentLaneMs: number) => ({
    taskId: t.id,
    laneTimes: [{ laneId: "implement", ms: currentLaneMs }],
    cycleMs: currentLaneMs,
    currentLaneMs,
    gateWaitMs: 0,
    reachedDone: false,
    reviewToDoneMs: null,
    planReviewBlocks: 0,
    reviewBlocks: 0,
    cappedHits: 0,
    planVersions: 0,
    sessions: { count: 0, totalMs: 0 },
  });

  // null stats / missing card → null
  expect(laneAgeChip(null, t, "Test + Implement")).toBeNull();
  const tUnknown = task({ id: "t9", title: "Unknown" });
  const payload: BoardStatsPayload = { board: { wip: 0, throughput: [], laneDwell: {}, projects: [], cycleAvgMs: 0 }, cards: { t1: card(3 * 86_400_000) }, generatedAt: Date.now() };
  expect(laneAgeChip(payload, tUnknown, "Backlog")).toBeNull();

  // 3 days in the lane → "3d", tooltip carries the lane-entry timestamp
  const chip = laneAgeChip(payload, t, "Test + Implement")!;
  expect(chip.label).toBe("3d");
  expect(chip.title.startsWith("in Test + Implement since ")).toBe(true);
});
