import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

const appCssPath = join(import.meta.dir, "..", "web", "src", "app.css");
const appCss = readFileSync(appCssPath, "utf-8");

const cardSveltePath = join(import.meta.dir, "..", "web", "src", "lib", "Card.svelte");
const cardSvelte = readFileSync(cardSveltePath, "utf-8");

const taskDetailSveltePath = join(
  import.meta.dir,
  "..",
  "web",
  "src",
  "lib",
  "TaskDetail.svelte",
);
const taskDetailSvelte = readFileSync(taskDetailSveltePath, "utf-8");

describe("promote button styling (app.css)", () => {
  test("promote button is hidden by default and revealed on card hover and keyboard focus", () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><head><style>${appCss}</style></head><body></body></html>`,
    );
    const rules = Array.from(dom.window.document.styleSheets[0].cssRules) as CSSStyleRule[];

    const promoteRule = rules.find((r) => r.selectorText === ".promote");
    expect(promoteRule).toBeDefined();
    expect(promoteRule!.style.opacity).toBe("0");
    expect(promoteRule!.style.pointerEvents).toBe("none");

    const hoverRule = rules.find(
      (r) => r.selectorText && r.selectorText.includes(".card:hover .promote"),
    );
    expect(hoverRule).toBeDefined();
    expect(hoverRule!.style.opacity).toBe("1");
    expect(hoverRule!.style.pointerEvents).toBe("auto");

    const focusRule = rules.find(
      (r) => r.selectorText && r.selectorText.includes(".card:focus-within .promote"),
    );
    expect(focusRule).toBeDefined();
    expect(focusRule!.style.opacity).toBe("1");
    expect(focusRule!.style.pointerEvents).toBe("auto");
  });
});

describe("Card.svelte wiring", () => {
  test("Card.svelte promote button stops propagation and moves the card to plan", () => {
    expect(cardSvelte).toMatch(
      /class="promote"[\s\S]*?stopPropagation\(\);[\s\S]*?board\.moveTask\(task\.id, "plan"\)/,
    );
    expect(cardSvelte).toContain('onkeydown={(e) => e.stopPropagation()}');
    expect(cardSvelte).toContain('title="move to Plan"');
  });
});

describe("TaskDetail modal promote wiring (u9vc7)", () => {
  test("modal promote button renders in editor-actions with no hover gate", () => {
    const editorActionsIdx = taskDetailSvelte.indexOf('<div class="editor-actions">');
    expect(editorActionsIdx).toBeGreaterThan(-1);

    const spacerIdx = taskDetailSvelte.indexOf('<span class="spacer"></span>', editorActionsIdx);
    expect(spacerIdx).toBeGreaterThan(editorActionsIdx);

    const promoteIfIdx = taskDetailSvelte.indexOf('{#if canPromote}', spacerIdx);
    expect(promoteIfIdx).toBeGreaterThan(spacerIdx);

    const promoteButton = '<button class="ghost" onclick={() => toLane("plan")}>→ plan</button>';
    const promoteBtnIdx = taskDetailSvelte.indexOf(promoteButton, promoteIfIdx);
    expect(promoteBtnIdx).toBeGreaterThan(promoteIfIdx);

    const doneBtnIdx = taskDetailSvelte.indexOf('✓ done', promoteBtnIdx);
    expect(doneBtnIdx).toBeGreaterThan(promoteBtnIdx);

    const dom = new JSDOM(
      `<!DOCTYPE html><html><head><style>${appCss}</style></head><body></body></html>`,
    );
    const rules = Array.from(dom.window.document.styleSheets[0].cssRules) as CSSStyleRule[];

    const ghostRule = rules.find((r) => r.selectorText && r.selectorText.includes(".ghost"));
    expect(ghostRule).toBeDefined();
    expect(ghostRule!.style.opacity).toBeFalsy();
    expect(ghostRule!.style.pointerEvents).toBeFalsy();

    const promoteRule = rules.find((r) => r.selectorText === ".promote");
    expect(promoteRule).toBeDefined();
    expect(promoteRule!.style.opacity).toBe("0");
    expect(promoteRule!.style.pointerEvents).toBe("none");
  });

  test("toLane moves via board.moveTask and closes the modal — same seam as the board quick button", () => {
    expect(taskDetailSvelte).toMatch(
      /async function toLane\(laneId: string\) \{\s*await board\.moveTask\(task\.id, laneId\);\s*board\.closeCard\(\);\s*\}/,
    );
    expect(taskDetailSvelte).toContain('toLane("plan")');
    expect(cardSvelte).toContain('board.moveTask(task.id, "plan")');
  });

  test("eligibility reuses canPromoteToPlan over the live task and lanes", () => {
    expect(taskDetailSvelte).toContain(
      "let canPromote = $derived(canPromoteToPlan(me, board.lanes));",
    );
    expect(taskDetailSvelte).toMatch(
      /import\s*\{[^}]*canPromoteToPlan[^}]*\}\s*from\s*"\.\/util";/,
    );
  });
});
