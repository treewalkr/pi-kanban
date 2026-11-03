import { expect, test } from "bun:test";
import { dropAnchorAt, LANE_DRAG_START_PX, LANE_LONG_PRESS_MS, LANE_LONG_PRESS_SLOP_PX, LANE_EDGE_PX, LANE_MAX_SCROLL_STEP } from "../web/src/lib/laneDrag.svelte";
import type { Lane } from "../src/db";

function makeLane(id: string, fixed: 0 | 1): Lane {
  return { id, name: id, description: "", position: 0, fixed, wipLimit: null };
}

/** elementOf backed by explicit left/top rects (jsdom rects are all zero). */
function fakeElements(rects: Record<string, { left: number; width: number; top: number; height: number }>) {
  return (id: string): HTMLElement | null => {
    const r = rects[id];
    if (!r) return null;
    return {
      getBoundingClientRect: () => ({ left: r.left, width: r.width, top: r.top, height: r.height, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }),
    } as unknown as HTMLElement;
  };
}

const lanes = [
  makeLane("waiting", 1),
  makeLane("backlog", 1),
  makeLane("plan", 0),
  makeLane("implement", 0),
  makeLane("review", 0),
  makeLane("done", 1),
  makeLane("archive", 1),
];

test("dropAnchorAt skips fixed lanes and returns null past the end", () => {
  const elementOf = fakeElements({
    plan: { left: 100, width: 100, top: 0, height: 100 },
    implement: { left: 200, width: 100, top: 0, height: 100 },
    review: { left: 300, width: 100, top: 0, height: 100 },
  });

  // left of plan's midpoint (150) → drop before plan, even though the pointer
  // is inside the fixed backlog band
  expect(dropAnchorAt(120, "x", lanes, elementOf, "review")).toBe("plan");
  // exactly on a midpoint has been passed (p < mid, strict)
  expect(dropAnchorAt(150, "x", lanes, elementOf, "review")).toBe("implement");
  // inside implement's left half → still before implement
  expect(dropAnchorAt(210, "x", lanes, elementOf, "review")).toBe("implement");
  // past review's midpoint → null (past the movable band)
  expect(dropAnchorAt(360, "x", lanes, elementOf, "review")).toBeNull();
  // the dragged lane's own band is skipped: pointer over review → anchor plan? no —
  // dragging review, the pointer left of review's mid lands before plan/implement;
  // dragging implement over its own band lands before review
  expect(dropAnchorAt(250, "x", lanes, elementOf, "implement")).toBe("review");
  // vertical axis uses top/height midpoints the same way
  const rows = fakeElements({
    plan: { left: 0, width: 400, top: 100, height: 40 },
    implement: { left: 0, width: 400, top: 140, height: 40 },
    review: { left: 0, width: 400, top: 180, height: 40 },
  });
  expect(dropAnchorAt(150, "y", lanes, rows, "review")).toBe("implement");
  expect(dropAnchorAt(400, "y", lanes, rows, "review")).toBeNull();
  // missing element (e.g. collapsed) is skipped, not fatal
  expect(dropAnchorAt(0, "x", lanes, () => null, "review")).toBeNull();
});

test("lane drag constants match the pi-web donor", () => {
  expect(LANE_DRAG_START_PX).toBe(5);
  expect(LANE_LONG_PRESS_MS).toBe(350);
  expect(LANE_LONG_PRESS_SLOP_PX).toBe(8);
  expect(LANE_EDGE_PX).toBe(32);
  expect(LANE_MAX_SCROLL_STEP).toBe(14);
});
