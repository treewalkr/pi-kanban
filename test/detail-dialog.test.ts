import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

const appCssPath = join(import.meta.dir, "..", "web", "src", "app.css");
const appCss = readFileSync(appCssPath, "utf-8");

describe("card editor and detail dialog widths (app.css)", () => {
  test("editor dialog is min(720px, 90vw) and cannot overflow", () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><head><style>${appCss}</style></head><body><div class="editor"></div></body></html>`,
    );
    const editorEl = dom.window.document.querySelector("div.editor")!;
    const computed = dom.window.getComputedStyle(editorEl);
    expect(computed.width).toBe("720px");
    expect(computed.maxWidth).toBe("100%");

    const rules = Array.from(dom.window.document.styleSheets[0].cssRules);
    const editorRule = rules.find(
      (r) => "selectorText" in r && (r as CSSStyleRule).selectorText === ".editor",
    ) as CSSStyleRule | undefined;
    expect(editorRule).toBeDefined();
    expect(editorRule!.style.width).toBe("min(720px, 90vw)");
  });

  test("the detail dialog inherits the editor width (no .editor.detail override)", () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><head><style>${appCss}</style></head><body><div class="editor detail"></div></body></html>`,
    );
    const detailEl = dom.window.document.querySelector("div.editor.detail")!;
    const computed = dom.window.getComputedStyle(detailEl);
    expect(computed.width).toBe("720px");

    const rules = Array.from(dom.window.document.styleSheets[0].cssRules);
    const detailRule = rules.find(
      (r) =>
        "selectorText" in r &&
        (r as CSSStyleRule).selectorText === ".editor.detail" &&
        (r as CSSStyleRule).style.width !== "",
    );
    expect(detailRule).toBeUndefined();
  });

  test("the file preview dialog keeps its wider override", () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><head><style>${appCss}</style></head><body><div class="editor preview"></div></body></html>`,
    );
    const previewEl = dom.window.document.querySelector("div.editor.preview")!;
    const computed = dom.window.getComputedStyle(previewEl);
    expect(computed.width).toBe("960px");
  });
});

const taskDetailPath = join(import.meta.dir, "..", "web", "src", "lib", "TaskDetail.svelte");
const taskDetailSource = readFileSync(taskDetailPath, "utf-8");

describe("elaborate button: rendered in the footer, hidden while queued or live, wired only to board.elaborate", () => {
  test("rendered in footer, hidden while queued or live, wired only to board.elaborate", () => {
    expect(taskDetailSource).toContain("{#if !queuedJob && !live}");
    expect(taskDetailSource).toContain('title="queue a pi-elaborator session to expand the note (intent + acceptance criteria) and fix an obviously broken title"');
    expect(taskDetailSource).toContain("<Sparkles");

    const editorActionsIdx = taskDetailSource.indexOf('<div class="editor-actions">');
    expect(editorActionsIdx).toBeGreaterThan(-1);

    const atPlanGateIdx = taskDetailSource.indexOf("{#if atPlanGate}", editorActionsIdx);
    expect(atPlanGateIdx).toBeGreaterThan(editorActionsIdx);

    const btnIdx = taskDetailSource.indexOf("board.elaborate(me.id)", atPlanGateIdx);
    expect(btnIdx).toBeGreaterThan(atPlanGateIdx);

    const spacerIdx = taskDetailSource.indexOf('<span class="spacer"></span>', btnIdx);
    expect(spacerIdx).toBeGreaterThan(btnIdx);

    const match = taskDetailSource.match(/onclick=\{([^}]+)\}>\s*<Sparkles/);
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
    expect(taskDetailSource).toMatch(/\$effect\(\(\) => \{\s*void board\.tasks;\s*void reloadThread\(\);\s*\}\);/);
    expect(taskDetailSource).toContain("let hadLive = false;");
    expect(taskDetailSource).toMatch(/if \(hadLive && !running\) \{\s*void board\.refresh\(\);\s*void reloadThread\(\);\s*\}/);
    expect(taskDetailSource).toContain("detail-activity queued");
    expect(taskDetailSource).toContain("roleAuthor(live.role)");
  });
});

describe("card files section (plan pinned + named files, per-file version picker)", () => {
  test("files ride reloadThread; section and pickers wired as expected", () => {
    expect(taskDetailSource).toContain("api.tasks({ id: task.id }).files.get()");
    expect(taskDetailSource).toContain('api.tasks({ id: task.id }).files({ name: kind }).get()');
    expect(taskDetailSource).toContain('let otherFiles = $derived(cardFiles.filter((f) => f.kind !== "plan"));');
    expect(taskDetailSource).toContain('<details class="detail-plan card-files">');

    // every version picker stops the summary toggle, both plan and per-file
    const pickers = taskDetailSource.match(/class="version-pick"/g) ?? [];
    expect(pickers.length).toBe(2);
    const stopped = taskDetailSource.match(/onclick=\{\(e\) => e\.stopPropagation\(\)\}/g) ?? [];
    expect(stopped.length).toBeGreaterThanOrEqual(2);

    // markdown renders inline; anything else is raw pre
    expect(taskDetailSource).toContain('const isMarkdown = (kind: string): boolean => kind === "plan" || kind.endsWith(".md");');
    expect(taskDetailSource).toContain('<pre class="file-raw">');
  });

  test("raw file content scrolls, never wraps (app.css)", () => {
    const dom = new JSDOM(`<!DOCTYPE html><html><head><style>${appCss}</style></head><body></body></html>`);
    const rules = Array.from(dom.window.document.styleSheets[0].cssRules);
    const rule = rules.find(
      (r) => "selectorText" in r && (r as CSSStyleRule).selectorText === ".card-file .file-raw",
    ) as CSSStyleRule | undefined;
    expect(rule).toBeDefined();
    expect(rule!.style.whiteSpace).toBe("pre");
    expect(rule!.style.overflowX).toBe("auto");
  });
});

describe("card file diff view (toggle + patch render)", () => {
  test("diff toggle and patch rendering wired", () => {
    expect(taskDetailSource).toContain("api.tasks({ id: task.id }).files({ name: kind }).diff.get(");
    expect(taskDetailSource).toContain("parseUnifiedDiff(");
    expect(taskDetailSource).toContain("collapseDiff(");
    expect(taskDetailSource).toContain('class="card-diff"');
    expect(taskDetailSource).toContain('class="diff-empty"');

    // a toggle per surface: plan section + every named card file, each keeping its section open
    const toggles = taskDetailSource.match(/class="diff-toggle"/g) ?? [];
    expect(toggles.length).toBeGreaterThanOrEqual(2);
    const toggleStops = taskDetailSource.match(
      /class="diff-toggle"[\s\S]*?onclick=\{\(e\) => \{\s*e\.stopPropagation\(\);/g,
    ) ?? [];
    expect(toggleStops.length).toBe(toggles.length);
  });

  test("diff toggle styled; diff lines reuse viewer-diff-line (app.css)", () => {
    const dom = new JSDOM(`<!DOCTYPE html><html><head><style>${appCss}</style></head><body></body></html>`);
    const rules = Array.from(dom.window.document.styleSheets[0].cssRules);
    const toggle = rules.find(
      (r) => "selectorText" in r && (r as CSSStyleRule).selectorText === ".diff-toggle",
    ) as CSSStyleRule | undefined;
    expect(toggle).toBeDefined();

    const diffLine = rules.find(
      (r) => "selectorText" in r && (r as CSSStyleRule).selectorText === ".viewer-diff-line",
    ) as CSSStyleRule | undefined;
    expect(diffLine).toBeDefined(); // global reuse sanity: card-diff rides the viewer classes
  });
});
