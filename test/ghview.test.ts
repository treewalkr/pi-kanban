import { expect, test } from "bun:test";
import { ghChip } from "../web/src/lib/ghview";
import type { GhLink, GhStatus } from "../src/db";

const link: GhLink = {
  id: "link1",
  cardId: "card1",
  url: "https://github.com/o/r/pull/12",
  kind: "pr",
  repo: "o/r",
  number: 12,
  createdAt: 0,
};

const issue: GhLink = { ...link, url: "https://github.com/o/r/issues/12", kind: "issue" };

const status = (state: string): GhStatus => ({
  url: link.url,
  kind: "pr",
  state,
  title: "t",
  mergedAt: null,
  fetchedAt: 0,
  error: "",
});

test("ghChip maps pr states to label, class, and title", () => {
  expect(ghChip(link, status("MERGED"))).toEqual({
    label: "#12",
    className: "chip gh gh-merged",
    title: `${link.url} — MERGED`,
  });
  expect(ghChip(link, status("OPEN")).className).toBe("chip gh gh-open");
  expect(ghChip(link, status("CLOSED")).className).toBe("chip gh gh-closed");
  expect(ghChip(link, status("DRAFT")).className).toBe("chip gh gh-pending");
});

test("ghChip: issue states, pending without a cached row, unknown state", () => {
  expect(ghChip(issue, { ...status("OPEN"), url: issue.url, kind: "issue" }).className).toBe("chip gh gh-open");
  expect(ghChip(issue, { ...status("CLOSED"), url: issue.url, kind: "issue" }).className).toBe("chip gh gh-closed");

  const pending = ghChip(link, null);
  expect(pending).toEqual({ label: "#12", className: "chip gh gh-pending", title: link.url });

  // mapping keys on the state string (gh never sends MERGED for issues, but the
  // helper stays a pure state→class map per the plan contract)
  expect(ghChip(issue, { ...status("MERGED"), url: issue.url, kind: "issue" }).className).toBe("chip gh gh-merged");
});
