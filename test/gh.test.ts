import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KanbanDb, KanbanError, type GhStatus } from "../src/db";
import {
  GH_SYNC_AUTHOR,
  defaultGhRunner,
  fetchGhStatus,
  importIssues,
  parseGhRef,
  refreshGhUrl,
  startGhSync,
  syncGh,
  type GhJsonRunner,
} from "../src/gh";

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
    expect(db.ghLinkCards(PR_URL).map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
    expect(Object.keys(db.ghLinksMap()).sort()).toEqual([a.id, b.id].sort());

    expect(db.ghState(PR_URL)).toBeNull();
    const row: GhStatus = { url: PR_URL, kind: "pr", state: "MERGED", title: "Fix", mergedAt: 1700000000000, fetchedAt: 1700000001000, error: "" };
    db.setGhState(row);
    expect(db.ghState(PR_URL)).toEqual(row); // merged_at NULL roundtrip not exercised here
    db.setGhState({ ...row, mergedAt: null });
    expect(db.ghState(PR_URL)?.mergedAt).toBeNull();
    expect(db.ghStates()).toHaveLength(1);

    // unknown kind resolves on first sync
    db.attachGhLink(a.id, parseGhRef("gh:o/r#9")!);
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
    db.moveTask(card.id, "done", undefined, { cause: "gh", actor: GH_SYNC_AUTHOR });
    expect(db.resolveTask(card.id).laneId).toBe("done");
  });
});

describe("parseGhRef: url, shorthand, canonicalization, rejects", () => {
  test("pr url, with and without trailing slash", () => {
    expect(parseGhRef("https://github.com/owner/repo/pull/12")).toEqual({
      url: "https://github.com/owner/repo/pull/12",
      kind: "pr",
      repo: "owner/repo",
      number: 12,
    });
    expect(parseGhRef("https://github.com/o.r-1/R_2/pull/3/")?.url).toBe("https://github.com/o.r-1/R_2/pull/3");
  });

  test("issue url and gh shorthand canonicalize to /issues/n", () => {
    expect(parseGhRef("https://github.com/o/r/issues/12")).toEqual({
      url: "https://github.com/o/r/issues/12",
      kind: "issue",
      repo: "o/r",
      number: 12,
    });
    expect(parseGhRef("https://github.com/o/r/issues/12/")).toEqual({
      url: "https://github.com/o/r/issues/12",
      kind: "issue",
      repo: "o/r",
      number: 12,
    });
    expect(parseGhRef("gh:o/r#12")).toEqual({
      url: "https://github.com/o/r/issues/12",
      kind: "unknown",
      repo: "o/r",
      number: 12,
    });
  });

  test("rejects non-github hosts, url variants, bare refs, and plain text", () => {
    expect(parseGhRef("https://gitlab.com/o/r/pull/12")).toBeNull();
    expect(parseGhRef("https://github.com/o/r/pull/12/files")).toBeNull();
    expect(parseGhRef("https://github.com/o/r/pulls/12")).toBeNull();
    expect(parseGhRef("#12")).toBeNull();
    expect(parseGhRef("gh:o/r" )).toBeNull();
    expect(parseGhRef("plan.md")).toBeNull();
    expect(parseGhRef("")).toBeNull();
  });
});

describe("gh core with a fake runner", () => {
  const MERGED_AT = "2026-10-31T10:00:00Z";

  test("fetchGhStatus: pr first, issue fallback, gh failed on double miss", async () => {
    const calls: string[][] = [];
    const run: GhJsonRunner = async (args) => {
      calls.push(args);
      if (args[0] === "pr") throw new Error("GraphQL: Could not resolve to a PullRequest");
      return { state: "CLOSED", title: "an issue" };
    };
    const status = await fetchGhStatus({ repo: "o/r", number: 5 }, run);
    expect(status).toEqual({ kind: "issue", state: "CLOSED", title: "an issue", mergedAt: null });
    expect(calls[0][0]).toBe("pr");
    expect(calls[1][0]).toBe("issue");

    const dead: GhJsonRunner = async () => {
      throw new Error("gh: not authed");
    };
    await expect(fetchGhStatus({ repo: "o/r", number: 5 }, dead)).rejects.toThrow(/^gh failed: /);
  });

  test("refreshGhUrl caches success, resolves unknown kind, and rewrites errors onto a prior row", async () => {
    const card = db.createTask({ title: "cache me" });
    const t0 = 1_700_000_000_000;
    let clock = t0;
    const now = () => clock;
    let state = "OPEN";
    const run: GhJsonRunner = async (args) => {
      if (args[0] === "pr") return { state, mergedAt: state === "MERGED" ? MERGED_AT : null, title: "Fix" };
      throw new Error("nope");
    };

    const row = await refreshGhUrl(db, PR_URL, { run, now });
    expect(row).toMatchObject({ url: PR_URL, kind: "pr", state: "OPEN", error: "", fetchedAt: t0 });
    expect(db.ghState(PR_URL)).toEqual(row);

    // shorthand link's unknown kind resolves from the fetched kind
    db.attachGhLink(card.id, parseGhRef("gh:o/r#12")!);
    clock = t0 + 61_000;
    await refreshGhUrl(db, "https://github.com/o/r/issues/12", { run, now });
    expect(db.ghLinksOf(card.id)[0].kind).toBe("pr");

    // failure with a prior row: error recorded, fetchedAt bumped, state kept
    clock = t0 + 120_000;
    const dead: GhJsonRunner = async () => {
      throw new Error("gh: rate limited");
    };
    expect(await refreshGhUrl(db, PR_URL, { run: dead, now })).toBeNull();
    const errored = db.ghState(PR_URL)!;
    expect(errored.state).toBe("OPEN");
    expect(errored.error).toContain("rate limited");
    expect(errored.fetchedAt).toBe(t0 + 120_000);

    // failure with no prior row writes nothing
    expect(await refreshGhUrl(db, "https://github.com/o/r/pull/99", { run: dead, now })).toBeNull();
    expect(db.ghState("https://github.com/o/r/pull/99")).toBeNull();
  });

  test("syncGh caches: fresh rows are not refetched within ttl", async () => {
    const card = db.createTask({ title: "ttl card" });
    db.attachGhLink(card.id, { url: PR_URL, kind: "pr", repo: "o/r", number: 12 });
    let calls = 0;
    const run: GhJsonRunner = async () => {
      calls++;
      return prJson();
    };
    let clock = 1_000;
    const now = () => clock;

    await syncGh(db, { run, now });
    await syncGh(db, { run, now });
    expect(calls).toBe(1); // second pass inside the ttl skips the fetch
    expect(db.ghState(PR_URL)?.state).toBe("OPEN");

    clock += 60_000;
    await syncGh(db, { run, now });
    expect(calls).toBe(2); // ttl elapsed → refetch
  });

  test("syncGh advances merged pr cards to done once; waiting/done/archive untouched", async () => {
    const review = db.createTask({ title: "in review", lane: "review" });
    const parked = db.createTask({ title: "parked", lane: "waiting" });
    const finished = db.createTask({ title: "already done", lane: "done" });
    for (const card of [review, parked, finished]) {
      db.attachGhLink(card.id, { url: PR_URL, kind: "pr", repo: "o/r", number: 12 });
    }
    const run: GhJsonRunner = async () => ({ state: "MERGED", mergedAt: MERGED_AT, title: "Fix" });
    const now = () => 1_000;

    const stats = await syncGh(db, { run, now });
    expect(stats.advanced.map((a) => a.cardId)).toEqual([review.id]);
    expect(db.resolveTask(review.id).laneId).toBe("done");
    expect(db.resolveTask(parked.id).laneId).toBe("waiting");
    expect(db.resolveTask(finished.id).laneId).toBe("done");

    const comment = db.comments(review.id).find((c) => c.author === GH_SYNC_AUTHOR);
    expect(comment?.body).toBe("PR o/r#12 merged — moved to Done");
    const event = db
      .laneEventsAfter(0)
      .find((e) => e.taskId === review.id && e.cause === "gh");
    expect(event?.actor).toBe(GH_SYNC_AUTHOR);
    expect(event?.toLaneId).toBe("done");

    // second pass: no card re-advanced (done is exempt and the comment names the pr)
    const second = await syncGh(db, { run, now });
    expect(second.advanced).toEqual([]);
    expect(db.comments(review.id).filter((c) => c.author === GH_SYNC_AUTHOR)).toHaveLength(1);

    // a human pulling the card back out of done does not re-trigger the same pr
    db.moveTask(review.id, "review");
    const third = await syncGh(db, { run, now });
    expect(third.advanced).toEqual([]);
    expect(db.resolveTask(review.id).laneId).toBe("review");
  });

  test("startGhSync runs one immediate pass and stops cleanly", async () => {
    const card = db.createTask({ title: "loop card", lane: "review" });
    db.attachGhLink(card.id, { url: PR_URL, kind: "pr", repo: "o/r", number: 12 });
    const run: GhJsonRunner = async () => ({ state: "MERGED", mergedAt: MERGED_AT, title: "Fix" });
    const logs: string[] = [];

    const handle = startGhSync({ db, intervalMs: 5, run, log: (m) => logs.push(m) });
    // the immediate pass advances synchronously enough for a short poll
    for (let i = 0; i < 100 && db.resolveTask(card.id).laneId !== "done"; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(db.resolveTask(card.id).laneId).toBe("done");
    handle.stop();
  });

  test("importIssues seeds backlog cards with links and open state; re-import skips", async () => {
    const issueUrl = (n: number) => `https://github.com/o/r/issues/${n}`;
    const run: GhJsonRunner = async (args) => {
      expect(args[0]).toBe("issue");
      expect(args[1]).toBe("list");
      return [
        { number: 12, title: "First issue", body: "body twelve", url: issueUrl(12) },
        { number: 13, title: "Second", body: "", url: issueUrl(13) },
      ];
    };
    const now = () => 5_000;

    const first = await importIssues(db, "o/r", { run, now });
    expect(first.created).toBe(2);
    expect(first.skipped).toBe(0);
    const cards = db.laneTasks("backlog");
    expect(cards.map((c) => c.title)).toEqual(["#12 First issue", "#13 Second"]);
    expect(cards[0].note).toBe("body twelve");
    expect(db.ghLinksOf(cards[0].id)[0]).toMatchObject({ url: issueUrl(12), kind: "issue", repo: "o/r", number: 12 });
    expect(db.ghState(issueUrl(12))).toMatchObject({ kind: "issue", state: "OPEN", fetchedAt: 5_000, error: "" });

    const second = await importIssues(db, "o/r", { run, now });
    expect(second).toMatchObject({ created: 0, skipped: 2 });
    expect(db.laneTasks("backlog")).toHaveLength(2);
  });
});
