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
import { marked, type Token, type Tokens } from "marked";

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

export { hljs };

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

const TASK_LINE_PREFIX_RE = /^(?:[ \t]*>+[ \t]?)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\](?= +\S)/;

interface TaskLineMatch {
  charOffset: number;
  markerChar: string;
}

function countLexerTasks(tokens: Token[]): number {
  let count = 0;
  for (const t of tokens) {
    if (t.type === "list_item" && (t as Tokens.ListItem).task) {
      count++;
    }
    if ("tokens" in t && t.tokens) {
      count += countLexerTasks(t.tokens);
    }
    if ("items" in t && t.items) {
      count += countLexerTasks(t.items);
    }
  }
  return count;
}

function findTaskLines(src: string, tokens?: Token[]): TaskLineMatch[] {
  const norm = src.replace(/\r\n|\r/g, "\n");
  const rawLines = src.split("\n");
  const lineStartOffsets: number[] = [];
  let offset = 0;
  for (let i = 0; i < rawLines.length; i++) {
    lineStartOffsets.push(offset);
    offset += rawLines[i].length + 1;
  }

  const lexerTokens = tokens ?? marked.lexer(norm);
  const tasks: TaskLineMatch[] = [];

  function walk(toks: Token[], baseLine: number) {
    let curLine = baseLine;
    for (const t of toks) {
      if (t.type === "list") {
        let itLine = curLine;
        for (const it of (t as Tokens.List).items) {
          if (it.task) {
            const rawLine = rawLines[itLine] ?? "";
            const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
            const match = line.match(TASK_LINE_PREFIX_RE);
            if (match) {
              const markerChar = match[1];
              const charOffset = lineStartOffsets[itLine] + (match[0].length - 2);
              tasks.push({ charOffset, markerChar });
            }
          }
          if (it.tokens) {
            walk(it.tokens, itLine);
          }
          itLine += (it.raw.match(/\n/g) || []).length;
        }
      } else if (t.type === "blockquote") {
        if ("tokens" in t && t.tokens) {
          walk(t.tokens, curLine);
        }
      }
      curLine += (t.raw.match(/\n/g) || []).length;
    }
  }

  walk(lexerTokens, 0);
  return tasks;
}

/**
 * Toggle the index-th (0-based) task checkbox in the markdown source.
 * Spliced by character offset so all other bytes remain unchanged.
 * Returns src unchanged if index is out of range, not an integer,
 * or if task line counting drifts from marked's lexer.
 */
export function toggleTaskLine(src: string, index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    return src;
  }

  const norm = src.replace(/\r\n|\r/g, "\n");
  const tokens = marked.lexer(norm);
  const lexerTaskCount = countLexerTasks(tokens);

  const tasks = findTaskLines(src, tokens);
  if (tasks.length !== lexerTaskCount || index >= tasks.length) {
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

