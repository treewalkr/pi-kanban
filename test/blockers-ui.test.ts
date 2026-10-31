import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const taskDetailPath = join(import.meta.dir, "..", "web", "src", "lib", "TaskDetail.svelte");
const source = readFileSync(taskDetailPath, "utf-8");

const appCss = readFileSync(join(import.meta.dir, "..", "web", "src", "app.css"), "utf-8");

describe("TaskDetail wires ✕ to removeBlocker, picker commit to addBlocker, inline dep-error", () => {
  test("blocked by row renders unconditionally (not gated on blockers.length)", () => {
    const rowIdx = source.indexOf('>blocked by<');
    expect(rowIdx).toBeGreaterThan(-1);

    // the old gate must not wrap the row: no {#if blockers.length > 0} anywhere
    expect(source).not.toContain("{#if blockers.length > 0}");

    // the row is the first .dep-row in .detail-deps, followed by the picker affordance
    const depsIdx = source.indexOf('<div class="detail-deps">');
    const rowStart = source.indexOf('<div class="dep-row">', depsIdx);
    expect(rowStart).toBeGreaterThan(depsIdx);
    expect(source.indexOf('class="dep-add blocker-add"', rowStart)).toBeGreaterThan(rowStart);
  });

  test("each blocker chip has a dep-x wired to board.removeBlocker(me.id, …)", () => {
    const rowIdx = source.indexOf('>blocked by<');
    const blockingIdx = source.indexOf('>blocking<');

    const xIdx = source.indexOf('class="dep-x" title="unblock', rowIdx);
    expect(xIdx).toBeGreaterThan(rowIdx);
    expect(blockingIdx).toBeGreaterThan(xIdx); // the ✕ lives in the blocked-by row, before the dependents row

    const clickIdx = source.indexOf("() => unblock(b.id)", xIdx);
    expect(clickIdx).toBeGreaterThan(xIdx);
    expect(source).toMatch(/async function unblock\(blockerId: string\): Promise<void>/);
    expect(source).toContain("await board.removeBlocker(me.id, blockerId)");
  });

  test("picker commit path calls board.addBlocker(me.id, picked.id)", () => {
    expect(source).toMatch(/async function commitBlocker\(picked: Task\): Promise<void>/);
    expect(source).toContain("const err = await board.addBlocker(me.id, picked.id);");
    expect(source).toContain("if (err) blockerError = err;");

    // Enter commits the highlighted candidate
    expect(source).toContain("void commitBlocker(blockerCandidatesList[blockerHighlighted]!)");
    // option rows commit on click too
    expect(source).toContain("onclick={() => void commitBlocker(t)}");
  });

  test("inline dep-error span renders the API message", () => {
    expect(source).toContain('class="dep-error" role="alert"');
    expect(source).toContain("{blockerError}");
  });

  test("picker Escape stops propagation so the modal survives closing the dropdown", () => {
    const escIdx = source.indexOf('e.key === "Escape" && blockerOpen');
    expect(escIdx).toBeGreaterThan(-1);
    const stopIdx = source.indexOf("e.stopPropagation();", escIdx);
    expect(stopIdx).toBeGreaterThan(escIdx);
    expect(stopIdx).toBeLessThan(escIdx + 200); // right there in the Escape branch, not far away
  });

  test("picker candidates come from blockerCandidates with self and current blockers excluded", () => {
    expect(source).toContain('from "./blockerPicker"');
    expect(source).toContain(
      "blockerCandidates(board.tasks, blockerQuery, me.id, board.blockedBy[me.id] ?? [])",
    );
  });
});

describe("blocker picker CSS (app.css)", () => {
  test("dropdown is absolute below the input, capped and scrollable", () => {
    expect(appCss).toContain(".blocker-add {");
    expect(appCss).toContain(".dep-picker-results {");
    expect(appCss).toMatch(/\.dep-picker-results\s*{[^}]*position: absolute;/s);
    expect(appCss).toMatch(/\.dep-picker-results\s*{[^}]*top: calc\(100% \+ 6px\);/s);
    expect(appCss).toMatch(/\.dep-picker-results\s*{[^}]*max-height: 40vh;/s);
    expect(appCss).toMatch(/\.dep-picker-results\s*{[^}]*overflow-y: auto;/s);
  });

  test("option highlight and inline error styles exist", () => {
    expect(appCss).toContain(".dep-option {");
    expect(appCss).toContain('.dep-option[aria-selected="true"]');
    expect(appCss).toContain(".dep-error {");
    expect(appCss).toMatch(/\.dep-error\s*{[^}]*color: var\(--error\);/s);
  });

  test("stale read-only comment is gone", () => {
    expect(appCss).not.toContain("read-only; edges are edited via the CLI");
    expect(appCss).toContain("blocker edges managed here; links too");
  });
});
