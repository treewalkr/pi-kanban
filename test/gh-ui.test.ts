import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const boardPath = join(import.meta.dir, "..", "web", "src", "lib", "board.svelte.ts");
const cardPath = join(import.meta.dir, "..", "web", "src", "lib", "Card.svelte");
const taskDetailPath = join(import.meta.dir, "..", "web", "src", "lib", "TaskDetail.svelte");
const cssPath = join(import.meta.dir, "..", "web", "src", "app.css");

const boardSource = readFileSync(boardPath, "utf-8");
const cardSource = readFileSync(cardPath, "utf-8");
const taskDetailSource = readFileSync(taskDetailPath, "utf-8");
const cssSource = readFileSync(cssPath, "utf-8");

test("web UI wires gh link add/remove through the board store to the gh api", () => {
  // board.svelte.ts Eden Treaty calls (same pattern as the links routes)
  expect(boardSource).toContain("api.tasks({ id }).gh.post({ ref })");
  expect(boardSource).toContain("api.tasks({ id }).gh({ linkId }).delete()");
  expect(boardSource).toContain("api.gh.statuses.get()");

  // TaskDetail.svelte wiring
  expect(taskDetailSource).toContain("board.addGhLink(me.id");
  expect(taskDetailSource).toContain("board.removeGhLink(me.id");
  expect(taskDetailSource).toContain('placeholder="github pr/issue url…"');
});

test("card chip renders a gh anchor with the ghview helper, linking out safely", () => {
  expect(cardSource).toContain("ghChip(link, board.ghStatuses[link.url] ?? null)");
  expect(cardSource).toContain('target="_blank"');
  expect(cardSource).toContain('rel="noreferrer"');
  expect(cardSource).toContain("board.ghLinks[task.id]");
});

test("gh chip colors exist in app.css (pending/open/merged/closed)", () => {
  expect(cssSource).toContain(".chip.gh-pending");
  expect(cssSource).toContain(".chip.gh-open");
  expect(cssSource).toContain(".chip.gh-merged");
  expect(cssSource).toContain(".chip.gh-closed");
});
