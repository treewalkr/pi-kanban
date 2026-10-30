import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

const appCssPath = join(import.meta.dir, "..", "web", "src", "app.css");
const appCss = readFileSync(appCssPath, "utf-8");

describe("card detail dialog width (app.css)", () => {
  test("detail dialog is 720px on a wide viewport", () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><head><style>${appCss}</style></head><body><div class="editor detail"></div><div class="editor"></div></body></html>`,
    );
    const detailEl = dom.window.document.querySelector("div.editor.detail")!;
    const computed = dom.window.getComputedStyle(detailEl);
    expect(computed.width).toBe("720px");
  });

  test("edit form keeps its 500px width", () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><head><style>${appCss}</style></head><body><div class="editor detail"></div><div class="editor"></div></body></html>`,
    );
    const editorEl = dom.window.document.querySelector("div.editor:not(.detail)")!;
    const computed = dom.window.getComputedStyle(editorEl);
    expect(computed.width).toBe("500px");
  });

  test("detail width scales with viewport and cannot overflow", () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><head><style>${appCss}</style></head><body><div class="editor detail"></div></body></html>`,
    );
    const rules = Array.from(dom.window.document.styleSheets[0].cssRules);
    const detailRule = rules.find(
      (r) => "selectorText" in r && (r as CSSStyleRule).selectorText === ".editor.detail",
    ) as CSSStyleRule | undefined;
    expect(detailRule).toBeDefined();
    expect(detailRule!.style.width).toBe("min(720px, 90vw)");

    const detailEl = dom.window.document.querySelector("div.editor.detail")!;
    const computed = dom.window.getComputedStyle(detailEl);
    expect(computed.maxWidth).toBe("100%");
  });
});
