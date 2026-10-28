import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

// dompurify reads `window` at import time — install a DOM before importing markdown.ts
const dom = new JSDOM("");
(globalThis as Record<string, unknown>).window = dom.window;
(globalThis as Record<string, unknown>).document = dom.window.document;

const { renderMarkdown, toggleTaskLine } = await import("../web/src/lib/markdown");

describe("renderMarkdown", () => {
  test("highlights fenced code with hljs spans", () => {
    const html = renderMarkdown("```ts\nconst x: number = 1;\n```");
    expect(html).toContain('<code class="hljs language-ts">');
    expect(html).toContain('class="hljs-keyword"');
    expect(html).toContain('class="hljs-number"');
  });

  test("language aliases resolve to registered languages", () => {
    expect(renderMarkdown("```sh\necho hi\n```")).toContain("language-sh");
    expect(renderMarkdown("```html\n<p>hi</p>\n```")).toContain("language-html");
  });

  test("unknown or missing lang falls back to escaped plaintext", () => {
    const html = renderMarkdown("```nope\n<script>alert(1)</script>\n```");
    expect(html).toContain("language-plaintext");
    expect(html).not.toContain("<script>");
  });

  test("still sanitizes html and hardens links", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">\n\n[link](https://example.com)');
    expect(html).not.toContain("onerror");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test("task-list checkboxes still pass", () => {
    const html = renderMarkdown("- [x] done");
    expect(html).toContain("<input");
    expect(html).toContain('type="checkbox"');
  });

  test("renderMarkdown interactive mode emits enabled inputs with data-task indexes", () => {
    const html = renderMarkdown("- [ ] a\n- [x] b", { interactiveTasks: true });
    expect(html).toContain('data-task="0"');
    expect(html).toContain('data-task="1"');
    expect(html).not.toContain('disabled=""');
    // data-task="1" input carries checked=""
    const checkedMatch = html.match(/<input[^>]*data-task="1"[^>]*>/);
    expect(checkedMatch).not.toBeNull();
    expect(checkedMatch![0]).toContain('checked=""');
  });

  test("renderMarkdown default mode keeps inert checkboxes", () => {
    const src = "- [ ] a\n- [x] b";
    const html = renderMarkdown(src);
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("data-task");
  });

  test("interactive indexes align with toggleTaskLine counting", () => {
    const corpus = [
      "- [ ] plain list",
      "  - [x] nested list",
      "    - [ ] 3-level nested list",
      "- [ ] 4-space parent",
      "    - [ ] 4-space nested list",
      "- [ ]",
      "- [ ] after empty item",
      "1. [ ] ordered list",
      "> - [X] blockquoted list",
      "",
      "```",
      "- [ ] fenced code",
      "```",
      "",
      "    - [ ] 4 spaces indent",
    ].join("\n");

    const html = renderMarkdown(corpus, { interactiveTasks: true });
    const dataTaskMatches = html.match(/data-task="\d+"/g) ?? [];

    // Count how many lines toggleTaskLine recognizes by trying indices
    let countedByToggle = 0;
    while (toggleTaskLine(corpus, countedByToggle) !== corpus) {
      countedByToggle++;
    }

    expect(dataTaskMatches.length).toBe(countedByToggle);
    expect(dataTaskMatches.length).toBe(8);

    // Empty item renders as plain bullet, fenced and 4-space indented lines produce no checkbox
    expect(html).toContain("<li>[ ]</li>");
    expect(html).not.toContain('data-task="8"');
    expect(html).toContain('<pre><code class="hljs language-plaintext">- [ ] fenced code</code></pre>');
    expect(html).toContain('<pre><code class="hljs language-plaintext">- [ ] 4 spaces indent</code></pre>');
  });

  test("toggling each rendered index flips the line it rendered from", () => {
    const corpus = [
      "- [ ] plain list",
      "  - [x] nested list",
      "    - [ ] 3-level nested list",
      "- [ ] 4-space parent",
      "    - [ ] 4-space nested list",
      "- [ ]",
      "- [ ] after empty item",
      "1. [ ] ordered list",
      "> - [X] blockquoted list",
      "",
      "```",
      "- [ ] fenced code",
      "```",
      "",
      "    - [ ] 4 spaces indent",
    ].join("\n");

    const expectedLines = [0, 1, 2, 3, 4, 6, 7, 8];
    const origLines = corpus.split("\n");

    for (let i = 0; i < expectedLines.length; i++) {
      const targetLineIdx = expectedLines[i];
      const toggled = toggleTaskLine(corpus, i);
      const toggledLines = toggled.split("\n");

      expect(toggledLines.length).toBe(origLines.length);
      for (let l = 0; l < origLines.length; l++) {
        if (l === targetLineIdx) {
          expect(toggledLines[l]).not.toBe(origLines[l]);
          const origChar = origLines[l].includes("[x]") || origLines[l].includes("[X]") ? "x" : " ";
          const expectedChar = origChar === " " ? "x" : " ";
          expect(toggledLines[l]).toContain(`[${expectedChar}]`);
        } else {
          expect(toggledLines[l]).toBe(origLines[l]);
        }
      }
    }
  });

  test("differential check: toggling rendered index flips exactly that checkbox in re-render across various markdown shapes", () => {
    function parseRenderedCheckboxes(html: string) {
      const matches = [...html.matchAll(/<input([^>]*)type="checkbox"([^>]*)>/g)];
      return matches.map((m) => {
        const full = m[0];
        const checked = full.includes('checked=""');
        const taskMatch = full.match(/data-task="(\d+)"/);
        const taskIdx = taskMatch ? parseInt(taskMatch[1], 10) : null;
        return { checked, taskIdx };
      });
    }

    const shapes = [
      "- [ ] a\n- [x] b",
      [
        "- [ ] plain list",
        "  - [x] nested list",
        "    - [ ] 3-level nested list",
        "- [ ] 4-space parent",
        "    - [ ] 4-space nested list",
        "- [ ]",
        "- [ ] after empty item",
        "1. [ ] ordered list",
        "> - [X] blockquoted list",
        "",
        "```",
        "- [ ] fenced code",
        "```",
        "",
        "    - [ ] 4 spaces indent",
      ].join("\n"),
      // Finding 1: continuation paragraph inside list item before nested task
      "- [ ] a\n\n  para\n\n    - [ ] b\n- [ ] c",
      "1. [ ] a\n\n   details\n\n      - [ ] sub\n2. [ ] b",
      // Finding 2: over-indented lazy continuation line
      "- [ ] a\n      - [ ] deep6\n- [ ] c",
      // Finding 2: 8-space indented code block inside list item
      "- a\n\n        - [ ] x\n- [ ] c",
      // Finding 2: HTML block
      "<div>\n- [ ] h\n</div>\n- [ ] c",
      // Blockquotes and CRLF
      "> - [ ] a\n> > - [x] b\n> - [ ] c",
      "- [ ] CRLF\r\n- [x] line 2\r\n",
    ];

    for (const src of shapes) {
      const origHtml = renderMarkdown(src, { interactiveTasks: true });
      const origCheckboxes = parseRenderedCheckboxes(origHtml);

      for (let i = 0; i < origCheckboxes.length; i++) {
        const toggled = toggleTaskLine(src, i);
        expect(toggled).not.toBe(src);

        const toggledHtml = renderMarkdown(toggled, { interactiveTasks: true });
        const toggledCheckboxes = parseRenderedCheckboxes(toggledHtml);

        expect(toggledCheckboxes.length).toBe(origCheckboxes.length);

        for (let j = 0; j < origCheckboxes.length; j++) {
          if (j === i) {
            expect(toggledCheckboxes[j].checked).toBe(!origCheckboxes[j].checked);
          } else {
            expect(toggledCheckboxes[j].checked).toBe(origCheckboxes[j].checked);
          }
        }

        // Toggling again flips it back to the original state
        const roundTripped = toggleTaskLine(toggled, i);
        const roundTrippedHtml = renderMarkdown(roundTripped, { interactiveTasks: true });
        const roundTrippedCheckboxes = parseRenderedCheckboxes(roundTrippedHtml);
        for (let j = 0; j < origCheckboxes.length; j++) {
          expect(roundTrippedCheckboxes[j].checked).toBe(origCheckboxes[j].checked);
        }
      }

      // Out of bounds indices return src unchanged (safe fail-safe)
      expect(toggleTaskLine(src, origCheckboxes.length)).toBe(src);
      expect(toggleTaskLine(src, origCheckboxes.length + 5)).toBe(src);
      expect(toggleTaskLine(src, -1)).toBe(src);
    }
  });

  test("toggleTaskLine flips only the nth task marker", () => {
    const src = "- [ ] item 1\n- [ ] item 2\n- [ ] item 3";
    const toggled = toggleTaskLine(src, 1);
    expect(toggled).toBe("- [ ] item 1\n- [x] item 2\n- [ ] item 3");

    const untoggled = toggleTaskLine(toggled, 1);
    expect(untoggled).toBe("- [ ] item 1\n- [ ] item 2\n- [ ] item 3");

    const srcWithUpper = "- [ ] item 1\n- [X] item 2\n- [ ] item 3";
    const untoggledUpper = toggleTaskLine(srcWithUpper, 1);
    expect(untoggledUpper).toBe("- [ ] item 1\n- [ ] item 2\n- [ ] item 3");
  });

  test("toggleTaskLine skips fenced code and ignores bad indexes", () => {
    const src = [
      "- [ ] item before",
      "```ts",
      "- [ ] item inside fence",
      "```",
      "- [ ] item after",
    ].join("\n");

    // Index 0 is the item before
    expect(toggleTaskLine(src, 0)).toBe([
      "- [x] item before",
      "```ts",
      "- [ ] item inside fence",
      "```",
      "- [ ] item after",
    ].join("\n"));

    // Index 1 is the item after (skipping the line inside the fence)
    expect(toggleTaskLine(src, 1)).toBe([
      "- [ ] item before",
      "```ts",
      "- [ ] item inside fence",
      "```",
      "- [x] item after",
    ].join("\n"));

    // Bad indexes return src unchanged
    expect(toggleTaskLine(src, 99)).toBe(src);
    expect(toggleTaskLine(src, -1)).toBe(src);
    expect(toggleTaskLine(src, 1.5)).toBe(src);
    expect(toggleTaskLine(src, Number.NaN)).toBe(src);
  });
});

const appCssPath = join(import.meta.dir, "..", "web", "src", "app.css");
const appCss = readFileSync(appCssPath, "utf-8");

describe("markdown code blocks (app.css cascade)", () => {
  test("plan pane code blocks stay one-line", () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><head><style>${appCss}</style></head><body><div class="editor detail"><div class="detail-body"><details class="detail-plan" open><div class="detail-note md"><pre><code class="hljs language-ts">const x = 1;</code></pre></div></details></div></div></body></html>`,
    );
    const pre = dom.window.document.querySelector("pre")!;
    const preStyle = dom.window.getComputedStyle(pre);
    expect(preStyle.whiteSpace).toBe("pre");
    expect(preStyle.overflowX).toBe("auto");
    const code = dom.window.document.querySelector("code")!;
    const codeStyle = dom.window.getComputedStyle(code);
    expect(codeStyle.whiteSpace).not.toBe("pre-wrap");
    expect(codeStyle.overflowWrap).toBe("normal");
  });

  test("note and comment code blocks share the one-line contract", () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><head><style>${appCss}</style></head><body><div class="detail-note md"><pre><code>const a = 1;</code></pre></div><div class="comment-body md"><pre><code>const b = 2;</code></pre></div></body></html>`,
    );
    const pres = dom.window.document.querySelectorAll("pre");
    expect(pres.length).toBe(2);
    for (const pre of pres) {
      const style = dom.window.getComputedStyle(pre);
      expect(style.whiteSpace).toBe("pre");
      expect(style.overflowX).toBe("auto");
    }
    const codes = dom.window.document.querySelectorAll("code");
    expect(codes.length).toBe(2);
    for (const code of codes) {
      const style = dom.window.getComputedStyle(code);
      expect(style.whiteSpace).not.toBe("pre-wrap");
    }
  });

  test("pre keeps a horizontal scrollbar (auto, thin)", () => {
    const dom = new JSDOM(
      `<!DOCTYPE html><html><head><style>${appCss}</style></head><body><div class="editor detail"><div class="detail-body"><details class="detail-plan" open><div class="detail-note md"><pre><code class="hljs language-ts">const x = 1;</code></pre></div></details></div></div></body></html>`,
    );
    const pre = dom.window.document.querySelector("pre")!;
    const style = dom.window.getComputedStyle(pre);
    expect(style.overflowX).toBe("auto");
    expect(style.scrollbarWidth).toBe("thin");
  });
});

