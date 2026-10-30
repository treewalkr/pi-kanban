import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

const appCssPath = join(import.meta.dir, "..", "web", "src", "app.css");
const appCss = readFileSync(appCssPath, "utf-8");

function getDom() {
  return new JSDOM(
    `<!DOCTYPE html><html><head><style>${appCss}</style></head><body></body></html>`,
  );
}

function findMediaRule(dom: JSDOM, query: string): CSSMediaRule | undefined {
  const sheet = dom.window.document.styleSheets[0];
  const rules = Array.from(sheet.cssRules);
  return rules.find(
    (r): r is CSSMediaRule =>
      "media" in r && (r as CSSMediaRule).media?.mediaText === query,
  );
}

describe("board lane grid (app.css)", () => {
  test("board becomes a wrapping grid below 1024px", () => {
    const dom = getDom();
    const media = findMediaRule(dom, "(max-width: 1024px)");
    expect(media).toBeDefined();

    const innerRules = Array.from(media!.cssRules) as CSSStyleRule[];
    const boardRule = innerRules.find((r) => r.selectorText === ".board");
    expect(boardRule).toBeDefined();
    expect(boardRule!.style.display).toBe("grid");
    expect(boardRule!.style.gridTemplateColumns).toBe(
      "repeat(auto-fill, minmax(min(292px, 100%), 1fr))",
    );
    expect(boardRule!.style.alignItems).toBe("start");

    const laneGroupRule = innerRules.find(
      (r) => r.selectorText === ".lane, .add-lane",
    );
    expect(laneGroupRule).toBeDefined();
    expect(laneGroupRule!.style.width).toBe("auto");
    expect(laneGroupRule!.style.maxHeight).toBe("none");
  });
});
