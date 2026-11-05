import { describe, expect, test } from "bun:test";
import { popoverBelow } from "../web/src/lib/popover";

describe("popoverBelow", () => {
  test("anchors left/right and clamps to 8px", () => {
    expect(popoverBelow({ left: 100, right: 180, bottom: 40 }, 800, "left")).toEqual({ top: 46, left: 100 });
    expect(popoverBelow({ left: -30, right: 50, bottom: 40 }, 800, "left")).toEqual({ top: 46, left: 8 });
    expect(popoverBelow({ left: 620, right: 700, bottom: 40 }, 800, "right")).toEqual({ top: 46, right: 100 });
    expect(popoverBelow({ left: 820, right: 900, bottom: 40 }, 800, "right")).toEqual({ top: 46, right: 8 });
  });
});
