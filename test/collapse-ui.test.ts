import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const lanePath = join(import.meta.dir, "..", "web", "src", "lib", "Lane.svelte");
const dragPath = join(import.meta.dir, "..", "web", "src", "lib", "drag.svelte.ts");
const source = readFileSync(lanePath, "utf-8");
const dragSource = readFileSync(dragPath, "utf-8");

describe("Lane collapse UI wiring", () => {
  test("collapsed derives from collapsedLanes gated by laneSearchHit", () => {
    expect(source).toContain("collapsed = $derived(board.collapsedLanes.has(lane.id) && !board.laneSearchHit(lane.id))");
  });

  test("collapse button and collapsed-head are wired to setLaneCollapsed", () => {
    expect(source).toContain("setLaneCollapsed(lane.id, true)");
    expect(source).toContain("setLaneCollapsed(lane.id, false)");
    expect(source).toContain('title="collapse lane"');
  });

  test("collapsed-lane append commit lives in the drag module", () => {
    expect(dragSource).toContain("board.moveTask(id, laneId)");
  });
});
