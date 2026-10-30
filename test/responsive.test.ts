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

function findMediaRules(dom: JSDOM, query: string): CSSMediaRule[] {
  const sheet = dom.window.document.styleSheets[0];
  const rules = Array.from(sheet.cssRules);
  return rules.filter(
    (r): r is CSSMediaRule =>
      "media" in r && (r as CSSMediaRule).media?.mediaText === query,
  );
}

function findMediaRule(dom: JSDOM, query: string): CSSMediaRule | undefined {
  return findMediaRules(dom, query)[0];
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

describe("sidebar drawer clamp (app.css)", () => {
  test("drawer width clamps below the viewport at 640px", () => {
    const dom = getDom();
    const mediaRules = findMediaRules(dom, "(max-width: 640px)");
    const allInnerRules = mediaRules.flatMap((m) =>
      Array.from(m.cssRules),
    ) as CSSStyleRule[];

    const clampRule = allInnerRules.find(
      (r) => r.selectorText === ".sidebar, .sidebar > *",
    );
    expect(clampRule).toBeDefined();
    expect(clampRule!.style.width).toBe(
      "min(var(--sidebar-width, 260px), calc(100vw - 48px))",
    );
    expect(clampRule!.style.minWidth).toBe("0px");
  });
});

describe("touch affordances (app.css)", () => {
  test("hover-gated controls are always visible without hover", () => {
    const dom = getDom();
    const media = findMediaRule(dom, "(hover: none)");
    expect(media).toBeDefined();

    const innerRules = Array.from(media!.cssRules) as CSSStyleRule[];
    const laneToolsRule = innerRules.find((r) => r.selectorText === ".lane-tools");
    expect(laneToolsRule).toBeDefined();
    expect(laneToolsRule!.style.opacity).toBe("1");

    const promoteRule = innerRules.find((r) => r.selectorText === ".promote");
    expect(promoteRule).toBeDefined();
    expect(promoteRule!.style.opacity).toBe("1");
    expect(promoteRule!.style.pointerEvents).toBe("auto");
  });

  test("small controls are bumped to 24px+ targets", () => {
    const dom = getDom();
    const media = findMediaRule(dom, "(hover: none)");
    expect(media).toBeDefined();

    const innerRules = Array.from(media!.cssRules) as CSSStyleRule[];

    const btnGroup = innerRules.find(
      (r) =>
        r.selectorText ===
        ".lane-tools button, .view-toggle button, .chips button",
    );
    expect(btnGroup).toBeDefined();
    expect(btnGroup!.style.height).toBe("28px");

    const themeToggle = innerRules.find((r) => r.selectorText === ".theme-toggle");
    expect(themeToggle).toBeDefined();
    expect(themeToggle!.style.width).toBe("32px");
    expect(themeToggle!.style.height).toBe("32px");

    const sidebarToggle = innerRules.find(
      (r) => r.selectorText === ".sidebar-toggle",
    );
    expect(sidebarToggle).toBeDefined();
    expect(sidebarToggle!.style.width).toBe("40px");
    expect(sidebarToggle!.style.height).toBe("40px");

    const idCopy = innerRules.find((r) => r.selectorText === ".id-copy");
    expect(idCopy).toBeDefined();
    expect(idCopy!.style.padding).toBe("6px");

    const disclosure = innerRules.find((r) => r.selectorText === ".disclosure");
    expect(disclosure).toBeDefined();
    expect(disclosure!.style.padding).toBe("7px 4px");
  });
});

describe("small-screen dialogs and inputs (app.css)", () => {
  test("form controls render 16px below 640px", () => {
    const dom = getDom();
    const mediaRules = findMediaRules(dom, "(max-width: 640px)");
    const allInnerRules = mediaRules.flatMap((m) =>
      Array.from(m.cssRules),
    ) as CSSStyleRule[];

    const formRule = allInnerRules.find(
      (r) => r.selectorText === ".app input, .app textarea, .app select",
    );
    expect(formRule).toBeDefined();
    expect(formRule!.style.fontSize).toBe("16px");

    const overlayRule = allInnerRules.find(
      (r) => r.selectorText === ".overlay",
    );
    expect(overlayRule).toBeDefined();
    expect(overlayRule!.style.padding).toBe("12px");

    const editorRule = allInnerRules.find((r) => r.selectorText === ".editor");
    expect(editorRule).toBeDefined();
    expect(editorRule!.style.maxHeight).toBe("calc(100dvh - 24px)");

    const actionsRule = allInnerRules.find(
      (r) => r.selectorText === ".editor-actions, .composer-actions",
    );
    expect(actionsRule).toBeDefined();
    expect(actionsRule!.style.flexWrap).toBe("wrap");

    const tabsRule = allInnerRules.find(
      (r) => r.selectorText === ".settings-tabs",
    );
    expect(tabsRule).toBeDefined();
    expect(tabsRule!.style.flexWrap).toBe("wrap");
    expect(tabsRule!.style.height).toBe("auto");

    const metaRule = allInnerRules.find(
      (r) =>
        r.selectorText ===
        ".id, .age, .chip, .cycle-chip, .count, .lane-dwell, .badge, .detail-meta",
    );
    expect(metaRule).toBeDefined();
    expect(metaRule!.style.fontSize).toBe("11px");
  });
});
