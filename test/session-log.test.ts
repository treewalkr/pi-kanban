import { describe, expect, test } from "bun:test";
import { liveSessionRows, savedSessionRows, stampSessionLog } from "../src/session-log";

describe("session-log stamping", () => {
  test("stampSessionLog prefixes HH:MM:SS and indents continuation lines 9 spaces", () => {
    const log = ["model: m", "stderr tail:\nboom\n12:00:01 x"];
    const logAt = [new Date(2026, 10, 5, 8, 15, 42).getTime(), new Date(2026, 10, 5, 8, 16, 3).getTime()];
    expect(stampSessionLog(log, logAt)).toBe(
      "08:15:42 model: m\n08:16:03 stderr tail:\n         boom\n         12:00:01 x",
    );
  });

  test("savedSessionRows parses a stamped log into gutter rows", () => {
    const content =
      "pi-reviewer · default · max · 11/5/2026 · 42s\n" +
      stampSessionLog(["model: m", "stderr tail:\nboom\n12:00:01 x"], [
        new Date(2026, 10, 5, 8, 15, 42).getTime(),
        new Date(2026, 10, 5, 8, 16, 3).getTime(),
      ]);
    const view = savedSessionRows(content);
    expect(view.stamped).toBe(true);
    expect(view.header).toBe("pi-reviewer · default · max · 11/5/2026 · 42s");
    expect(view.rows).toEqual([
      { at: null, stamp: "08:15:42", text: "model: m" },
      { at: null, stamp: "08:16:03", text: "stderr tail:" },
      { at: null, stamp: "", text: "boom" },
      { at: null, stamp: "", text: "12:00:01 x" }, // indented stderr time is not a stamp
    ]);
  });

  test("savedSessionRows leaves a legacy unstamped log as plain rows", () => {
    // (a) plain legacy body
    const a = savedSessionRows("pi-reviewer · now · 5s\nmodel: old\nline two");
    expect(a.stamped).toBe(false);
    expect(a.header).toBe("pi-reviewer · now · 5s");
    expect(a.rows).toEqual([
      { at: null, stamp: "", text: "model: old" },
      { at: null, stamp: "", text: "line two" },
    ]);
    // (b) header-only content
    const b = savedSessionRows("h · 5s");
    expect(b.stamped).toBe(false);
    expect(b.rows).toEqual([]);
    // (c) trimmed legacy body whose first line looks stamped
    const c = savedSessionRows("h · 5s\n12:00:01 started\n→ bash: ls");
    expect(c.stamped).toBe(false);
    expect(c.rows.map((r) => r.text)).toEqual(["12:00:01 started", "→ bash: ls"]);
    expect(c.rows.every((r) => r.stamp === "")).toBe(true);
  });

  test("liveSessionRows stamps each live entry with stampTime", () => {
    const now = new Date(2026, 10, 5, 9, 0, 0).getTime();
    const view = liveSessionRows(["a", "b\nc"], [now - 5 * 60_000, now - 2 * 3_600_000], now);
    expect(view.stamped).toBe(true);
    expect(view.rows).toEqual([
      { at: now - 300_000, stamp: "08:55:00", text: "a" },
      { at: now - 7_200_000, stamp: "07:00", text: "b\nc" },
    ]);
  });

  test("liveSessionRows renders unstamped when logAt is missing or mismatched", () => {
    const log = ["a", "b"];
    for (const logAt of [undefined, [], [1]] as (number[] | undefined)[]) {
      const view = liveSessionRows(log, logAt, 1_000);
      expect(view.stamped).toBe(false);
      expect(view.rows).toEqual([
        { at: null, stamp: "", text: "a" },
        { at: null, stamp: "", text: "b" },
      ]);
    }
  });
});
