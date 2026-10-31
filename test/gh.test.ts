import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KanbanDb, KanbanError, type GhStatus } from "../src/db";

let dir = "";
let db: KanbanDb;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kanban-gh-"));
  db = new KanbanDb(join(dir, "t.db"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const PR_URL = "https://github.com/o/r/pull/12";
const prJson = (state = "OPEN", mergedAt: string | null = null): unknown => ({ state, mergedAt, title: "Fix the thing" });

describe("gh links in the db layer", () => {
  test("attachGhLink stores and board() ships ghLinks; duplicate (card,url) conflicts", () => {
    const card = db.createTask({ title: "linked card" });
    const link = db.attachGhLink(card.id, { url: PR_URL, kind: "pr", repo: "o/r", number: 12 });
    expect(link.cardId).toBe(card.id);
    expect(link.url).toBe(PR_URL);
    expect(link.kind).toBe("pr");
    expect(db.ghLinksOf(card.id)).toHaveLength(1);
    expect(db.board().ghLinks[card.id]).toHaveLength(1);

    expect(() => db.attachGhLink(card.id, { url: PR_URL, kind: "pr", repo: "o/r", number: 12 })).toThrow(
      new KanbanError(`card '${card.id}' already links ${PR_URL}`, "conflict"),
    );

    // same url on a second card is fine — pr state is shared via gh_state, not the link
    const other = db.createTask({ title: "also linked" });
    expect(db.attachGhLink(other.id, { url: PR_URL, kind: "pr", repo: "o/r", number: 12 }).cardId).toBe(other.id);
  });

  test("ghLinksOf resolves task prefixes; unknown card throws", () => {
    const card = db.createTask({ title: "prefix me" });
    db.attachGhLink(card.id, { url: PR_URL, kind: "pr", repo: "o/r", number: 12 });
    expect(db.ghLinksOf(card.id.slice(0, 3))).toHaveLength(1);
    expect(() => db.ghLinksOf("zzzzz")).toThrow(KanbanError);
  });

  test("unlinkGhLinkById removes one row and reports whether it did", () => {
    const card = db.createTask({ title: "unlink me" });
    const a = db.attachGhLink(card.id, { url: PR_URL, kind: "pr", repo: "o/r", number: 12 });
    const b = db.attachGhLink(card.id, { url: "https://github.com/o/r/issues/7", kind: "issue", repo: "o/r", number: 7 });
    expect(db.unlinkGhLinkById(card.id, a.id)).toBe(true);
    expect(db.unlinkGhLinkById(card.id, a.id)).toBe(false);
    expect(db.ghLinksOf(card.id).map((l) => l.id)).toEqual([b.id]);
  });

  test("ghLinkCards, ghLinksMap and ghState readback", () => {
    const a = db.createTask({ title: "a" });
    const b = db.createTask({ title: "b" });
    db.attachGhLink(a.id, { url: PR_URL, kind: "pr", repo: "o/r", number: 12 });
    db.attachGhLink(b.id, { url: PR_URL, kind: "pr", repo: "o/r", number: 12 });
    expect(db.ghLinkCards(PR_URL).map((t) => t.id)).toEqual([a.id, b.id]);
    expect(Object.keys(db.ghLinksMap()).sort()).toEqual([a.id, b.id].sort());

    expect(db.ghState(PR_URL)).toBeNull();
    const row: GhStatus = { url: PR_URL, kind: "pr", state: "MERGED", title: "Fix", mergedAt: 1700000000000, fetchedAt: 1700000001000, error: "" };
    db.setGhState(row);
    expect(db.ghState(PR_URL)).toEqual(row); // merged_at NULL roundtrip not exercised here
    db.setGhState({ ...row, mergedAt: null });
    expect(db.ghState(PR_URL)?.mergedAt).toBeNull();
    expect(db.ghStates()).toHaveLength(1);

    // unknown kind resolves on first sync
    db.attachGhLink(a.id, { url: "https://github.com/o/r/issues/9", kind: "unknown", repo: "o/r", number: 9 });
    db.setGhLinkKind("https://github.com/o/r/issues/9", "issue");
    expect(db.ghLinksOf(a.id).find((l) => l.number === 9)?.kind).toBe("issue");
  });

  test("deleting a card cascades its gh links (task delete and lane force-delete)", () => {
    const card = db.createTask({ title: "cascade" });
    db.attachGhLink(card.id, { url: PR_URL, kind: "pr", repo: "o/r", number: 12 });
    db.deleteTask(card.id);
    expect(db.ghLinkCards(PR_URL)).toEqual([]);

    const lane = db.createLane({ name: "ghcascade" });
    const inLane = db.createTask({ title: "lane card", lane: lane.id });
    db.attachGhLink(inLane.id, { url: "https://github.com/o/r/issues/7", kind: "issue", repo: "o/r", number: 7 });
    db.deleteLane(lane.id, true);
    expect(db.ghLinkCards("https://github.com/o/r/issues/7")).toEqual([]);
  });

  test("moveTask accepts cause gh for the lane-event trail", () => {
    const card = db.createTask({ title: "gh move" });
    db.moveTask(card.id, "done", undefined, { cause: "gh", actor: "gh-sync" /* GH_SYNC_AUTHOR (src/gh.ts) — lands with the gh-core commit */ });
    expect(db.resolveTask(card.id).laneId).toBe("done");
  });
});
