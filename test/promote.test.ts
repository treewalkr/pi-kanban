import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

const appCssPath = join(import.meta.dir, "..", "web", "src", "app.css");
const appCss = readFileSync(appCssPath, "utf-8");

const cardSveltePath = join(import.meta.dir, "..", "web", "src", "lib", "Card.svelte");
const cardSvelte = readFileSync(cardSveltePath, "utf-8");

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
