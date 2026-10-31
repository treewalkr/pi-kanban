import { expect, test } from "bun:test";
import type { BoardStatsPayload, Lane, Task } from "../src/db";
import { cycleChip, laneCycleRows, laneDwellLabel, throughputBars } from "../web/src/lib/statsview";

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

function statsPayload(throughput: { weekStart: number; done: number }[], laneDwell: BoardStatsPayload["board"]["laneDwell"]): BoardStatsPayload {
  return {
    board: { wip: 0, throughput, laneDwell, projects: [], cycleAvgMs: null },
    cards: {},
    generatedAt: Date.now(),
  };
}

function lane(id: string, name = id): Lane {
  return { id, name, description: "", position: 0, fixed: 0, wipLimit: null };
}

test("throughputBars normalizes heights and empty-safes", () => {
  // null stats -> []
  expect(throughputBars(null)).toEqual([]);

  // [3,5,0,2,0,0,0,0] weeks -> 8 bars in payload order, heights normalized to max (5)
  const weeks = [3, 5, 0, 2, 0, 0, 0, 0].map((done, i) => ({ weekStart: i, done }));
  const bars = throughputBars(statsPayload(weeks, {}));
  expect(bars).toHaveLength(8);
  expect(bars.map((b) => b.done)).toEqual([3, 5, 0, 2, 0, 0, 0, 0]);
  expect(bars.map((b) => b.heightPct)).toEqual([60, 100, 0, 40, 0, 0, 0, 0]);

  // all-zero window -> 8 flat bars
  const zeroWeeks = Array.from({ length: 8 }, (_, i) => ({ weekStart: i, done: 0 }));
  const flat = throughputBars(statsPayload(zeroWeeks, {}));
  expect(flat).toHaveLength(8);
  expect(flat.every((b) => b.heightPct === 0 && b.done === 0)).toBe(true);
});

test("laneCycleRows orders by board lanes and normalizes widths", () => {
  expect(laneCycleRows(null, [])).toEqual([]);

  // laneDwell keyed out of lane order; `plan` and `done` never visited
  const payload = statsPayload(
    [],
    {
      implement: { avgMs: 300_000, cards: 4 },
      backlog: { avgMs: 150_000, cards: 6 },
    },
  );
  const lanes = [lane("backlog"), lane("plan"), lane("implement"), lane("done")];

  const rows = laneCycleRows(payload, lanes);
  // backlog first (board order, not key order), unvisited lanes dropped
  expect(rows.map((r) => r.laneId)).toEqual(["backlog", "implement"]);
  expect(rows[0]).toMatchObject({ name: "backlog", avgMs: 150_000, cards: 6, widthPct: 50 });
  expect(rows[1]).toMatchObject({ name: "implement", avgMs: 300_000, cards: 4, widthPct: 100 });

  // lane present in dwell but absent from `lanes` is dropped
  expect(laneCycleRows(payload, [lane("plan")])).toEqual([]);
});
