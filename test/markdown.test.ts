import { describe, expect, test } from "bun:test";
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
    expect(dataTaskMatches.length).toBe(4);

    // Fenced and 4-space-indented lines produce no checkbox and are not counted
    expect(html).not.toContain('data-task="4"');
    expect(html).toContain('<pre><code class="hljs language-plaintext">- [ ] fenced code</code></pre>');
    expect(html).toContain('<pre><code class="hljs language-plaintext">- [ ] 4 spaces indent</code></pre>');
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
