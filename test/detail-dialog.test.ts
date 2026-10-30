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

const taskDetailPath = join(import.meta.dir, "..", "web", "src", "lib", "TaskDetail.svelte");
const taskDetailSource = readFileSync(taskDetailPath, "utf-8");

describe("elaborate button: rendered in the footer, hidden while queued or live, wired only to board.elaborate", () => {
  test("rendered in footer, hidden while queued or live, wired only to board.elaborate", () => {
    expect(taskDetailSource).toContain("{#if !queuedJob && !live}");
    expect(taskDetailSource).toContain('title="queue a pi-elaborator session to expand the note (intent + acceptance criteria)"');
    expect(taskDetailSource).toContain(">✨ elaborate</button>");

    const editorActionsIdx = taskDetailSource.indexOf('<div class="editor-actions">');
    expect(editorActionsIdx).toBeGreaterThan(-1);

    const atPlanGateIdx = taskDetailSource.indexOf("{#if atPlanGate}", editorActionsIdx);
    expect(atPlanGateIdx).toBeGreaterThan(editorActionsIdx);

    const btnIdx = taskDetailSource.indexOf("board.elaborate(me.id)", atPlanGateIdx);
    expect(btnIdx).toBeGreaterThan(atPlanGateIdx);

    const spacerIdx = taskDetailSource.indexOf('<span class="spacer"></span>', btnIdx);
    expect(spacerIdx).toBeGreaterThan(btnIdx);

    const match = taskDetailSource.match(/onclick=\{([^}]+)\}>✨ elaborate<\/button>/);
    expect(match).not.toBeNull();
    const onclickContent = match![1];
    expect(onclickContent.trim()).toBe("() => board.elaborate(me.id)");
    expect(onclickContent).not.toContain("approve");
    expect(onclickContent).not.toContain("reject");
    expect(onclickContent).not.toContain("toLane");
    expect(onclickContent).not.toContain("updateTask");
  });
});

describe("open card reloads board and thread when its live session ends", () => {
  test("defines reloadThread, falling-edge effect, and retains queued/live panels", () => {
    expect(taskDetailSource).toMatch(/async function reloadThread\(\): Promise<void>/);
    expect(taskDetailSource).toMatch(/\$effect\(\(\) => \{\s*void reloadThread\(\);\s*\}\);/);
    expect(taskDetailSource).toContain("let hadLive = false;");
    expect(taskDetailSource).toMatch(/if \(hadLive && !running\) \{\s*void board\.refresh\(\);\s*void reloadThread\(\);\s*\}/);
    expect(taskDetailSource).toContain("detail-activity queued");
    expect(taskDetailSource).toContain("roleAuthor(live.role)");
  });
});
