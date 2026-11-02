import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Source-assertion pins for card 8fp65: bun tests cannot mount .svelte
// components and e2e cannot isolate the 10s guard while SSE is alive, so the
// guard expressions themselves are the interface (workspace-ui.test.ts pattern).

const appPath = join(import.meta.dir, "..", "web", "src", "App.svelte");
const appSource = readFileSync(appPath, "utf-8");

const taskDetailPath = join(import.meta.dir, "..", "web", "src", "lib", "TaskDetail.svelte");
const taskDetailSource = readFileSync(taskDetailPath, "utf-8");

describe("live detail refresh (card 8fp65)", () => {
  test("refresh guards pause for the editor only; thread refetches with the board", () => {
    // SSE change handler and 10s git-interval pause on editMode — the actual
    // editor — not editing (any open card), so the read-only detail stays live
    expect(appSource).toContain("if (!document.hidden && !board.editMode) board.refresh();");
    expect(appSource).toContain("if (!board.editMode) board.refresh();");

    // the modal-close catch-up and search-jump flash guard keep testing editing
    expect(appSource).toContain("if (!board.editing) board.refresh();");
    expect(appSource).toContain("if (!id || board.editing) return;");

    // TaskDetail refetches the thread on every board refresh (board.tasks is
    // replaced by refresh), so external comments/files/sessions appear live
    expect(taskDetailSource).toMatch(/\$effect\(\(\) => \{\s*void board\.tasks;\s*void reloadThread\(\);\s*\}\);/);
  });
});
