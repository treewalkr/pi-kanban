import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdownLang from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { marked, type Tokens } from "marked";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("go", go);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdownLang);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("python", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    // fenced code → highlighted spans; unknown or missing lang → escaped plaintext
    code({ text, lang }: Tokens.Code) {
      const language = lang && hljs.getLanguage(lang) ? lang : "plaintext";
      const body = hljs.highlight(text, { language }).value;
      return `<pre><code class="hljs language-${language}">${body}</code></pre>\n`;
    },
  },
});

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.getAttribute("href")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^ {0,3}#{1,6}[ \t]/;
const HR_RE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/;
const LIST_ITEM_PREFIX_RE = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+/;
const TASK_MARKER_RE = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[( |x|X)\](?= +\S)/;

interface TaskLineMatch {
  charOffset: number;
  markerChar: string;
}

function findTaskLines(src: string): TaskLineMatch[] {
  const lines = src.split("\n");
  let inFence: string | null = null;
  let inList = false;
  let blankLineSeen = true;
  let currentQuoteDepth = 0;
  let lineStartOffset = 0;
  const tasks: TaskLineMatch[] = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

    if (inFence !== null) {
      const closeRegex = inFence === "`" ? /^ {0,3}`{3,}[ \t]*$/ : /^ {0,3}~{3,}[ \t]*$/;
      if (closeRegex.test(line)) {
        inFence = null;
        inList = false;
        blankLineSeen = false;
      }
    } else {
      const openMatch = line.match(FENCE_OPEN_RE);
      if (openMatch) {
        inFence = openMatch[1][0];
        inList = false;
        blankLineSeen = false;
      } else {
        const quoteMatch = line.match(/^(?: {0,3}>+[ \t]?)+/);
        const quotePrefix = quoteMatch ? quoteMatch[0] : "";
        const quoteDepth = quoteMatch ? (quotePrefix.match(/>/g)?.length ?? 0) : 0;
        if (quoteDepth !== currentQuoteDepth) {
          inList = false;
          currentQuoteDepth = quoteDepth;
          blankLineSeen = true;
        }

        const rest = line.slice(quotePrefix.length);
        if (rest.trim() === "") {
          blankLineSeen = true;
        } else if (HEADING_RE.test(rest) || HR_RE.test(rest)) {
          inList = false;
          blankLineSeen = false;
        } else {
          const listMatch = rest.match(LIST_ITEM_PREFIX_RE);
          if (listMatch) {
            const rawIndent = listMatch[1];
            const isCodeIndent = rawIndent.includes("\t") || rawIndent.length >= 4;
            if (inList || !isCodeIndent) {
              const taskMatch = rest.match(TASK_MARKER_RE);
              if (taskMatch) {
                const markerChar = taskMatch[1];
                const charOffset = lineStartOffset + quotePrefix.length + (taskMatch[0].length - 2);
                tasks.push({ charOffset, markerChar });
              }
              inList = true;
              blankLineSeen = false;
            } else {
              inList = false;
              blankLineSeen = false;
            }
          } else {
            const indentMatch = rest.match(/^[ \t]*/);
            const indent = indentMatch ? indentMatch[0] : "";
            const isCodeIndent = indent.includes("\t") || indent.length >= 4;
            if (!isCodeIndent && blankLineSeen) {
              inList = false;
            }
            blankLineSeen = false;
          }
        }
      }
    }

    lineStartOffset += rawLine.length + 1;
  }

  return tasks;
}

/**
 * Toggle the index-th (0-based) task checkbox in the markdown source.
 * Spliced by character offset so all other bytes remain unchanged.
 * Returns src unchanged if index is out of range or not an integer.
 */
export function toggleTaskLine(src: string, index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    return src;
  }

  const tasks = findTaskLines(src);
  if (index >= tasks.length) {
    return src;
  }

  const target = tasks[index];
  const newChar = target.markerChar === " " ? "x" : " ";
  return src.slice(0, target.charOffset) + newChar + src.slice(target.charOffset + 1);
}

/** Card note → sanitized markdown HTML (safe for {@html}). */
export function renderMarkdown(
  src: string,
  opts?: { interactiveTasks?: boolean }
): string {
  let html = marked.parse(src) as string;
  if (opts?.interactiveTasks) {
    let taskIndex = 0;
    html = html.replace(
      /<input (checked="" )?disabled="" type="checkbox">/g,
      (_match, checked) => `<input ${checked ?? ""}data-task="${taskIndex++}" type="checkbox">`
    );
  }
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ["input"], // gfm task-list checkboxes
  });
}

