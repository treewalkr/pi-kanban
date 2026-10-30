import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const boardPath = join(import.meta.dir, "..", "web", "src", "lib", "board.svelte.ts");
const taskDetailPath = join(import.meta.dir, "..", "web", "src", "lib", "TaskDetail.svelte");

const boardSource = readFileSync(boardPath, "utf-8");
const taskDetailSource = readFileSync(taskDetailPath, "utf-8");

test("web UI wires link add/remove through the board store to the links API", () => {
  // board.svelte.ts Eden Treaty calls
  expect(boardSource).toContain("api.tasks({ id }).links.post({ target })");
  expect(boardSource).toContain("api.tasks({ id }).links({ targetId }).delete()");

  // TaskDetail.svelte wiring
  expect(taskDetailSource).toContain("board.addLink(me.id");
  expect(taskDetailSource).toContain("board.removeLink(me.id");
});

test("card detail linked chips open the linked card", () => {
  // linked each-block button opens card with title="open {l.title}" and board.openCard(l)
  expect(taskDetailSource).toContain('title="open {l.title}"');
  expect(taskDetailSource).toContain("board.openCard(l)");
});
