import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KanbanDb, type Comment } from "../src/db";
import { commentThread, listLanes, statsBoard, statsCard, taskDetail } from "../src/render";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function makeComment(partial: Partial<Comment> & { id: string; createdAt: number; body: string }): Comment {
  return {
    taskId: "t1",
    author: "user",
    kind: "comment",
    ...partial,
  };
}

describe("commentThread CLI renderer", () => {
  test("empty thread returns dimmed 'no comments'", () => {
    const out = stripAnsi(commentThread([]));
    expect(out).toBe("no comments");
  });

  test("commentThread groups comments by day and prints short times (AC1)", () => {
    const fixedNow = new Date(2026, 9, 25, 15, 0, 0).getTime();
    const d1 = new Date(2026, 9, 23, 10, 15, 0).getTime();
    const d2 = new Date(2026, 9, 24, 11, 20, 0).getTime();
    const d3 = new Date(2026, 9, 25, 12, 25, 0).getTime();

    const comments: Comment[] = [
      makeComment({ id: "c1", createdAt: d1, author: "user", kind: "comment", body: "day 1" }),
      makeComment({ id: "c2", createdAt: d2, author: "user", kind: "comment", body: "day 2" }),
      makeComment({ id: "c3", createdAt: d3, author: "user", kind: "comment", body: "day 3" }),
    ];

    const out = stripAnsi(commentThread(comments, 80, fixedNow));
    const lines = out.split("\n");

    expect(lines[0]).toBe("── Oct 23");
    expect(out).toContain("── Oct 24");
    expect(out).toContain("── today");

    // Order of day separators
    const idxD1 = out.indexOf("── Oct 23");
    const idxD2 = out.indexOf("── Oct 24");
    const idxD3 = out.indexOf("── today");
    expect(idxD1).toBeLessThan(idxD2);
    expect(idxD2).toBeLessThan(idxD3);

    // Meta times carry only HH:MM
    expect(out).toContain("10:15 · user");
    expect(out).toContain("11:20 · user");
    expect(out).toContain("12:25 · user");

    // No toLocaleString artifacts like /2026/ or AM/PM
    expect(out).not.toMatch(/\/2026/);
    expect(out).not.toMatch(/AM|PM/);
  });

  test("meta line: time, bold-author slot, kind tag (AC2)", () => {
    const fixedNow = new Date(2026, 9, 25, 15, 0, 0).getTime();
    const d1 = new Date(2026, 9, 25, 10, 0, 0).getTime();
    const d2 = new Date(2026, 9, 25, 12, 25, 0).getTime();
    const d3 = new Date(2026, 9, 25, 14, 0, 0).getTime();

    const comments: Comment[] = [
      makeComment({ id: "c1", createdAt: d1, author: "user", kind: "comment", body: "first" }),
      makeComment({ id: "c2", createdAt: d2, author: "pi-builder", kind: "review", body: "second" }),
      makeComment({ id: "c3", createdAt: d3, author: "pi-reviewer", kind: "review", body: "third" }),
    ];

    const out = stripAnsi(commentThread(comments, 80, fixedNow));
    const lines = out.split("\n");

    // Comment 1: plain comment kind omits the tag
    expect(lines).toContain("10:00 · user");
    expect(lines).not.toContain("10:00 · user · [comment]");

    // Comment 2: plain meta equals "12:25 · pi-builder · [review]"; author appears before kind tag
    expect(lines).toContain("12:25 · pi-builder · [review]");
  });

  test("bodies wrap to width with 2-space indent (AC3)", () => {
    const fixedNow = new Date(2026, 9, 25, 12, 0, 0).getTime();
    const word200 = "a".repeat(200);

    const comments: Comment[] = [
      makeComment({ id: "c1", createdAt: fixedNow, author: "user", kind: "comment", body: word200 }),
    ];

    // At width 80, body wraps to max 78 chars content, each line starting with 2 spaces
    const out80 = stripAnsi(commentThread(comments, 80, fixedNow));
    const bodyLines80 = out80.split("\n").slice(2); // after sep and meta
    expect(bodyLines80.length).toBeGreaterThan(1);
    for (const line of bodyLines80) {
      expect(line.startsWith("  ")).toBe(true);
      const content = line.slice(2);
      expect(content.length).toBeLessThanOrEqual(78);
      expect(line.length).toBeLessThanOrEqual(80);
    }

    // Narrow width clamps at 20 (content width = 20, total line = 22)
    const out10 = stripAnsi(commentThread(comments, 10, fixedNow));
    const bodyLines10 = out10.split("\n").slice(2);
    expect(bodyLines10[0]!.slice(2).length).toBe(20);
    expect(bodyLines10[0]!.length).toBe(22);
  });

  test("▶ marks only the latest state-changing comment (AC4)", () => {
    const fixedNow = new Date(2026, 9, 25, 15, 0, 0).getTime();

    const commentsWithState: Comment[] = [
      makeComment({ id: "c1", createdAt: 1000, author: "pi-reviewer", kind: "review", body: "first review" }),
      makeComment({ id: "c2", createdAt: 2000, author: "pi-builder", kind: "comment", body: "agent chatter" }),
      makeComment({ id: "c3", createdAt: 3000, author: "pi-reviewer", kind: "review", body: "second review" }),
      makeComment({ id: "c4", createdAt: 4000, author: "pi-builder", kind: "comment", body: "more chatter" }),
    ];

    const outState = stripAnsi(commentThread(commentsWithState, 80, fixedNow));
    const markerMatches = outState.match(/▶ /g);
    expect(markerMatches).toHaveLength(1);
    expect(outState).toContain("▶ 00:00 · pi-reviewer · [review]");
    expect(outState).not.toContain("▶ 00:00 · pi-builder");

    const commentsWithoutState: Comment[] = [
      makeComment({ id: "c1", createdAt: 1000, author: "user", kind: "comment", body: "a" }),
      makeComment({ id: "c2", createdAt: 2000, author: "pi-planner", kind: "question", body: "b" }),
    ];
    const outNoState = stripAnsi(commentThread(commentsWithoutState, 80, fixedNow));
    expect(outNoState).not.toContain("▶ ");
  });

  test("10-comment mixed-kind thread reads at a glance (AC6)", () => {
    const d1 = new Date(2026, 9, 24, 10, 0, 0).getTime();
    const d2 = new Date(2026, 9, 25, 12, 0, 0).getTime();
    const comments: Comment[] = [
      makeComment({ id: "c1", createdAt: d1, author: "user-alpha", kind: "comment", body: "initial note" }),
      makeComment({ id: "c2", createdAt: d1 + 1000, author: "pi-planner", kind: "comment", body: "planning step" }),
      makeComment({ id: "c3", createdAt: d1 + 2000, author: "pi-planner", kind: "question", body: "clarification needed" }),
      makeComment({ id: "c4", createdAt: d1 + 3000, author: "user-beta", kind: "comment", body: "here is clarification" }),
      makeComment({ id: "c5", createdAt: d1 + 4000, author: "pi-planner", kind: "handoff", body: "plan handed off" }),
      makeComment({ id: "c6", createdAt: d2, author: "pi-reviewer", kind: "rejection", body: "plan rejected" }),
      makeComment({ id: "c7", createdAt: d2 + 1000, author: "pi-planner", kind: "comment", body: "addressing findings" }),
      makeComment({ id: "c8", createdAt: d2 + 2000, author: "pi-reviewer", kind: "review", body: "second review pass" }),
      makeComment({ id: "c9", createdAt: d2 + 3000, author: "pi-builder", kind: "comment", body: "building the feature" }),
      makeComment({ id: "c10", createdAt: d2 + 4000, author: "user-lead", kind: "approval", body: "looks good approved" }),
    ];
    const fixedNow = comments[9]!.createdAt + 5 * 60 * 1000; // 5m after last comment

    const width = 80;
    const out = stripAnsi(commentThread(comments, width, fixedNow));

    // Both day separators present
    expect(out).toContain("── Oct 24");
    expect(out).toContain("── today");

    // Every author string present
    expect(out).toContain("user-alpha");
    expect(out).toContain("pi-planner");
    expect(out).toContain("user-beta");
    expect(out).toContain("pi-reviewer");
    expect(out).toContain("pi-builder");
    expect(out).toContain("user-lead");

    // Exactly one ▶ on the latest state comment (c10 approval)
    const markerMatches = out.match(/▶ /g);
    expect(markerMatches).toHaveLength(1);
    expect(out).toContain("▶ 12:00 · user-lead · [approval]");

    // Newest comment has relTime
    expect(out).toContain("5m ago");

    // Every line ≤ width
    const lines = out.split("\n");
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(width);
    }
  });

  test("ls glyph and show from: line for parked cards", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-render-test-"));
    const db = new KanbanDb(join(dir, "t.db"));
    try {
      const card = db.createTask({ title: "hitl card", lane: "implement" });
      db.comment(card.id, { kind: "question", body: "what db?" });

      const lanesOut = stripAnsi(listLanes(db));
      expect(lanesOut).toContain(`${card.id}  hitl card ☉`);

      const parkedDetail = stripAnsi(taskDetail(db, db.resolveTask(card.id)));
      expect(parkedDetail).toContain("from:    Test + Implement (implement)");

      const manual = db.createTask({ title: "manual", lane: "waiting" });
      const manualDetail = stripAnsi(taskDetail(db, db.resolveTask(manual.id)));
      expect(manualDetail).not.toContain("from:");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("taskDetail lists session headers with model config; absent when no sessions", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-render-test-"));
    const db = new KanbanDb(join(dir, "t.db"));
    try {
      const cardWith = db.createTask({ title: "with sessions", lane: "implement" });
      db.attach(
        cardWith.id,
        "session",
        "pi-reviewer · anthropic · claude-x · high · 10/30/2026, 10:46 AM · 42s\nmodel: anthropic · claude-x · high",
        "autoreview",
      );
      const detailWith = stripAnsi(taskDetail(db, db.resolveTask(cardWith.id)));
      expect(detailWith).toContain("sessions:");
      expect(detailWith).toContain("anthropic · claude-x · high");

      const cardWithout = db.createTask({ title: "without sessions", lane: "implement" });
      const detailWithout = stripAnsi(taskDetail(db, db.resolveTask(cardWithout.id)));
      expect(detailWithout).not.toContain("sessions:");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("model config stays off lane listings", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-render-test-"));
    const db = new KanbanDb(join(dir, "t.db"));
    try {
      const card = db.createTask({ title: "with sessions", lane: "implement" });
      db.attach(
        card.id,
        "session",
        "pi-reviewer · anthropic · claude-x · high · 10/30/2026, 10:46 AM · 42s\nmodel: anthropic · claude-x · high",
        "autoreview",
      );
      const lanesOut = stripAnsi(listLanes(db));
      expect(lanesOut).not.toContain("claude-x");
      expect(lanesOut).not.toContain("· high");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("statsCard and statsBoard human renderers format fields properly", () => {
    const dir = mkdtempSync(join(tmpdir(), "kanban-render-stats-"));
    const db = new KanbanDb(join(dir, "t.db"));
    try {
      const card = db.createTask({ title: "card stats test", lane: "plan" });
      const cardStats = db.cardStats(card.id, card.createdAt + 60_000);
      const cardOut = stripAnsi(statsCard(db, card, cardStats));
      expect(cardOut).toContain("card stats test");
      expect(cardOut).toContain(`id:           ${card.id}`);
      expect(cardOut).toContain("cycle:        1m (created → now, not done yet)");
      expect(cardOut).toContain("current lane: Plan 1m");
      expect(cardOut).toContain("gate wait:    1m");
      expect(cardOut).toContain("lane times:");
      expect(cardOut).toContain("Plan · 1m");
      expect(cardOut).toContain("loop health: 0 plan-review blocks · 0 review blocks · 0 cap hits · 0 plan versions · 0 sessions (1s)");

      const payload = db.boardStats(card.createdAt + 60_000);
      const boardOut = stripAnsi(statsBoard(db, payload));
      expect(boardOut).toContain("wip: 1");
      expect(boardOut).toContain("throughput (done/week):");
      expect(boardOut).toContain("lane dwell:");
      expect(boardOut).toContain("Plan · 1m avg · 1 cards");
      expect(boardOut).toContain("projects:");
      expect(boardOut).toContain("(none) · 1 total · 1 active · 0 done");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
