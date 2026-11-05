import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Source-assertion pins for card 2sm4x: bun cannot mount .svelte components,
// so the stamp wiring itself is the interface (live-detail.test.ts pattern);
// the rendered DOM is observed for real in test/e2e/stamps.e2e.ts.

const taskDetailPath = join(import.meta.dir, "..", "web", "src", "lib", "TaskDetail.svelte");
const taskDetailSource = readFileSync(taskDetailPath, "utf-8");

describe("session-log and chat stamps (card 2sm4x)", () => {
  test("card detail wires the session-log helpers", () => {
    expect(taskDetailSource).toContain('liveSessionRows(live.log, live.logAt, Date.now())');
    expect(taskDetailSource).toContain("savedSessionRows(log.content)");
    expect(taskDetailSource).toContain("class:stamped={liveLog?.stamped}");
    expect(taskDetailSource).toContain('class="line-time"');
    expect(taskDetailSource).toContain('class="line-text"');
  });
});
