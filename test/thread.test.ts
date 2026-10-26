import { describe, expect, test } from "bun:test";
import {
  clockTime,
  isAgentChatter,
  isStateKind,
  KIND_TAG_COLORS,
  latestStateIndex,
  relTime,
  shortDate,
  wrapText,
} from "../src/thread";

describe("thread presentation helpers", () => {
  test("KIND_TAG_COLORS matches the expected color palette", () => {
    expect(KIND_TAG_COLORS).toEqual({
      review: "#d29922",
      handoff: "#bc8cff",
      approval: "#3fb950",
      rejection: "#f85149",
      question: "#d29922",
    });
  });

  test("shortDate/relTime boundaries", () => {
    const fixedNow = new Date(2026, 9, 25, 12, 0, 0).getTime(); // Oct 25 2026 12:00:00

    // shortDate boundaries (local calendar midnight edges)
    const todayMidnight = new Date(2026, 9, 25, 0, 0, 0).getTime();
    const todayEnd = new Date(2026, 9, 25, 23, 59, 59, 999).getTime();
    const yesterdayEnd = new Date(2026, 9, 24, 23, 59, 59, 999).getTime();
    const tomorrowStart = new Date(2026, 9, 26, 0, 0, 0).getTime();

    expect(shortDate(todayMidnight, fixedNow)).toBe("today");
    expect(shortDate(todayEnd, fixedNow)).toBe("today");
    expect(shortDate(yesterdayEnd, fixedNow)).toBe("Oct 24");
    expect(shortDate(tomorrowStart, fixedNow)).toBe("Oct 26");

    // relTime boundaries with fixed now
    expect(relTime(fixedNow - 30 * 1000, fixedNow)).toBe("just now");
    expect(relTime(fixedNow - 59 * 1000, fixedNow)).toBe("just now");
    expect(relTime(fixedNow - 60 * 1000, fixedNow)).toBe("1m ago");
    expect(relTime(fixedNow - 59 * 60 * 1000, fixedNow)).toBe("59m ago");
    expect(relTime(fixedNow - 60 * 60 * 1000, fixedNow)).toBe("1h ago");
    expect(relTime(fixedNow - 23 * 60 * 60 * 1000, fixedNow)).toBe("23h ago");
    expect(relTime(fixedNow - 24 * 60 * 60 * 1000, fixedNow)).toBe("1d ago");
    expect(relTime(fixedNow - 48 * 60 * 60 * 1000, fixedNow)).toBe("2d ago");
  });

  test("clockTime formats 24-hour zero-padded time", () => {
    const t1 = new Date(2026, 9, 25, 9, 5, 0).getTime();
    const t2 = new Date(2026, 9, 25, 14, 30, 0).getTime();
    expect(clockTime(t1)).toBe("09:05");
    expect(clockTime(t2)).toBe("14:30");
  });

  test("wrapText greedy wrap, hard split, blank lines", () => {
    expect(wrapText("aaa bbb", 5)).toEqual(["aaa", "bbb"]);
    expect(wrapText("aaaaaa", 4)).toEqual(["aaaa", "aa"]);

    const withBlank = "first line\n\nsecond line\n   \nthird line";
    expect(wrapText(withBlank, 20)).toEqual(["first line", "", "second line", "", "third line"]);

    const longWord = "12345678901234567890";
    const wrappedLong = wrapText(longWord, 6);
    expect(wrappedLong).toEqual(["123456", "789012", "345678", "90"]);
    for (const line of wrappedLong) {
      expect(line.length).toBeLessThanOrEqual(6);
    }

    // fallback when width < 1
    expect(wrapText("a\nb", 0)).toEqual(["a", "b"]);
  });

  test("latestStateIndex and isStateKind", () => {
    expect(isStateKind("review")).toBe(true);
    expect(isStateKind("handoff")).toBe(true);
    expect(isStateKind("approval")).toBe(true);
    expect(isStateKind("rejection")).toBe(true);
    expect(isStateKind("question")).toBe(false);
    expect(isStateKind("comment")).toBe(false);

    const mixed = [
      { kind: "comment" },
      { kind: "review" },
      { kind: "question" },
      { kind: "handoff" },
      { kind: "comment" },
    ];
    expect(latestStateIndex(mixed)).toBe(3);

    const allPlain = [{ kind: "comment" }, { kind: "question" }, { kind: "comment" }];
    expect(latestStateIndex(allPlain)).toBe(-1);
  });

  test("isAgentChatter picks only agent plain comments", () => {
    expect(isAgentChatter({ author: "pi-builder", kind: "comment" })).toBe(true);
    expect(isAgentChatter({ author: "pi-planner", kind: "comment" })).toBe(true);
    expect(isAgentChatter({ author: "pi-reviewer", kind: "review" })).toBe(false);
    expect(isAgentChatter({ author: "user", kind: "comment" })).toBe(false);
    expect(isAgentChatter({ author: "pi-builder", kind: "handoff" })).toBe(false);
  });

  test("10-comment fixture classifies correctly for web", () => {
    const fixture = [
      { id: "c1", author: "user", kind: "comment", createdAt: 1 },
      { id: "c2", author: "pi-planner", kind: "comment", createdAt: 2 }, // chatter
      { id: "c3", author: "pi-planner", kind: "question", createdAt: 3 },
      { id: "c4", author: "user", kind: "comment", createdAt: 4 },
      { id: "c5", author: "pi-planner", kind: "handoff", createdAt: 5 }, // state
      { id: "c6", author: "pi-reviewer", kind: "rejection", createdAt: 6 }, // state
      { id: "c7", author: "pi-planner", kind: "comment", createdAt: 7 }, // chatter
      { id: "c8", author: "pi-reviewer", kind: "review", createdAt: 8 }, // state
      { id: "c9", author: "pi-builder", kind: "comment", createdAt: 9 }, // chatter
      { id: "c10", author: "user", kind: "approval", createdAt: 10 }, // latest state (index 9)
    ];

    expect(latestStateIndex(fixture)).toBe(9);

    const chatterIndices = fixture
      .map((c, i) => (isAgentChatter(c) ? i : -1))
      .filter((i) => i !== -1);
    expect(chatterIndices).toEqual([1, 6, 8]);
  });
});
