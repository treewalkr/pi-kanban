import type { Attachment, Task } from "./db";

export type SearchResultKind = "title" | "checklist" | "tag" | "note" | "plan";

export interface SearchResult {
  kind: SearchResultKind;
  /** Task owning the match — the card a result jumps to. */
  task: Task;
  /** Matched text: the title, the checklist item, or a note snippet. */
  text: string;
  /** Checklist items only. */
  checked?: boolean;
  score: number;
}

export interface ChecklistItem {
  text: string;
  checked: boolean;
  line: number;
}

const CHECKLIST_RE = /^\s*[-*]\s+\[([ xX])]\s+(.*)$/;
const SNIPPET_MAX = 80;
const MAX_RESULTS = 20;

/** Parse `- [ ]` / `- [x]` GFM task-list lines out of a note. */
export function checklistLines(note: string): ChecklistItem[] {
  const out: ChecklistItem[] = [];
  const lines = note.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(CHECKLIST_RE);
    if (m) out.push({ text: m[2]!, checked: m[1]! !== " ", line: i });
  }
  return out;
}

/** Trim a matched note line to a window that keeps the match visible. */
function snippet(line: string, at: number): string {
  if (line.length <= SNIPPET_MAX) return line;
  const start = Math.max(0, Math.min(at - 24, line.length - SNIPPET_MAX));
  const body = line.slice(start, start + SNIPPET_MAX);
  return `${start > 0 ? "…" : ""}${body}${start + SNIPPET_MAX < line.length ? "…" : ""}`;
}

/** One result per match, best first: title/id > checklist line > note body > plan body. */
export function searchBoard(
  tasks: Task[],
  query: string,
  plans: Record<string, Attachment> = {},
): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const results: SearchResult[] = [];

  for (const task of tasks) {
    const title = task.title.toLowerCase();
    let titleMatched = false;

    if (title.startsWith(q)) {
      results.push({ kind: "title", task, text: task.title, score: 100 });
      titleMatched = true;
    } else if (title.includes(q)) {
      results.push({ kind: "title", task, text: task.title, score: 80 });
      titleMatched = true;
    } else if (task.id.toLowerCase().startsWith(q)) {
      results.push({ kind: "title", task, text: task.title, score: 70 });
      titleMatched = true;
    }

    for (const item of checklistLines(task.note)) {
      const text = item.text.toLowerCase();
      if (text.startsWith(q))
        results.push({ kind: "checklist", task, text: item.text, checked: item.checked, score: 60 });
      else if (text.includes(q))
        results.push({ kind: "checklist", task, text: item.text, checked: item.checked, score: 50 });
    }

    // a tag row would just duplicate the card when the title already matched
    if (!titleMatched) {
      for (const tag of task.tags) {
        if (tag.toLowerCase().includes(q)) {
          results.push({ kind: "tag", task, text: tag, score: 45 });
          break; // one tag row per card, the first matching tag in tag order
        }
      }
    }

    // a note-body row would just duplicate the card when the title already matched
    if (titleMatched) continue;
    for (const line of task.note.split("\n")) {
      const t = line.trim();
      if (!t || CHECKLIST_RE.test(line)) continue; // checklist lines are their own results
      const at = t.toLowerCase().indexOf(q);
      if (at >= 0) {
        results.push({ kind: "note", task, text: snippet(t, at), score: 40 });
        break; // one note row per card, the first matching line
      }
    }
    const plan = plans[task.id];
    if (plan) {
      for (const line of plan.content.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        const at = t.toLowerCase().indexOf(q);
        if (at >= 0) {
          results.push({ kind: "plan", task, text: snippet(t, at), score: 35 });
          break; // one plan row per card, the first matching line
        }
      }
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS);
}
