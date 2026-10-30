export const KIND_TAG_COLORS: Record<string, string> = {
  review: "#d29922",
  handoff: "#bc8cff",
  approval: "#3fb950",
  rejection: "#f85149",
  question: "#d29922",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function shortDate(ts: number, now: number = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
    return "today";
  }
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

export function clockTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export function formatDuration(ms: number): string {
  if (ms < 10_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  if (ms < 14 * 86_400_000) return `${Math.round(ms / 86_400_000)}d`;
  return `${Math.round(ms / 604_800_000)}w`;
}

export function relTime(ts: number, now: number = Date.now()): string {
  const diffMs = Math.max(0, now - ts);
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

export function isStateKind(kind: string): boolean {
  return kind === "review" || kind === "handoff" || kind === "approval" || kind === "rejection";
}

export function latestStateIndex<T extends { kind: string }>(comments: T[]): number {
  for (let i = comments.length - 1; i >= 0; i--) {
    if (isStateKind(comments[i].kind)) return i;
  }
  return -1;
}

export function isAgentChatter(comment: { author: string; kind: string }): boolean {
  return comment.kind === "comment" && comment.author.startsWith("pi-");
}

function wrapLine(line: string, width: number): string[] {
  if (!line.trim()) return [""];
  const rawTokens = line.trim().split(/\s+/);
  const tokens: string[] = [];
  for (const t of rawTokens) {
    if (t.length <= width) {
      tokens.push(t);
    } else {
      for (let i = 0; i < t.length; i += width) {
        tokens.push(t.slice(i, i + width));
      }
    }
  }
  const lines: string[] = [];
  let cur = "";
  for (const t of tokens) {
    if (!cur) {
      cur = t;
    } else if (cur.length + 1 + t.length <= width) {
      cur += " " + t;
    } else {
      lines.push(cur);
      cur = t;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

export function wrapText(text: string, width: number): string[] {
  if (width < 1) return text.split("\n");
  const rawLines = text.split("\n");
  const result: string[] = [];
  for (const line of rawLines) {
    result.push(...wrapLine(line, width));
  }
  return result;
}
