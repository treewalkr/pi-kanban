import { expect, test } from "bun:test";
import type { BoardStatsPayload, Task } from "../src/db";
import { cycleChip, laneDwellLabel } from "../web/src/lib/statsview";

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
