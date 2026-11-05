import { clockTimeSec, stampTime } from "./thread";

export interface SessionLogRow {
  at: number | null;
  stamp: string;
  text: string;
}

export interface SessionLogView {
  stamped: boolean;
  rows: SessionLogRow[];
}

/** Indent (9 spaces) for continuation lines of a stamped saved session-log entry. */
const INDENT = "         ";
const STAMP = /^\d{2}:\d{2}:\d{2} /;

/** Body of a saved session log (no header): entry i → `${clockTimeSec(logAt[i] ?? Date.now())} ${firstLine}`, its other `\n`-split lines indented 9 spaces; entries joined with "\n". */
export function stampSessionLog(log: readonly string[], logAt: readonly number[]): string {
  return log
    .map((entry, i) => {
      const lines = entry.split("\n");
      const head = `${clockTimeSec(logAt[i] ?? Date.now())} ${lines[0]}`;
      const rest = lines.slice(1).map((l) => INDENT + l);
      return [head, ...rest].join("\n");
    })
    .join("\n");
}

/** Live rows: stamped iff logAt matches log in length and is non-empty; row i = { at: logAt[i], stamp: stampTime(logAt[i], now), text: log[i] }. Unstamped rows = { at: null, stamp: "", text }. One row per entry (embedded \n stays in text). */
export function liveSessionRows(log: readonly string[], logAt: readonly number[] | undefined, now: number): SessionLogView {
  if (!Array.isArray(logAt) || logAt.length !== log.length || log.length === 0) {
    return { stamped: false, rows: log.map((text) => ({ at: null, stamp: "", text })) };
  }
  return {
    stamped: true,
    rows: log.map((text, i) => {
      const at = logAt[i];
      return { at, stamp: stampTime(at, now), text };
    }),
  };
}

/** Saved attachment content → header + rows. Unstamped (legacy) → every body line { at: null, stamp: "", text: line }. A body is stamped iff every body line matches `HH:MM:SS ` or starts with the 9-space indent. */
export function savedSessionRows(content: string): SessionLogView & { header: string } {
  const lines = content.split("\n");
  const header = lines[0] ?? "";
  const body = lines.slice(1);
  const stamped = body.length > 0 && body.every((l) => STAMP.test(l) || l.startsWith(INDENT));
  if (!stamped) {
    return { header, stamped: false, rows: body.map((text) => ({ at: null, stamp: "", text })) };
  }
  return {
    header,
    stamped: true,
    rows: body.map((line) => {
      if (STAMP.test(line)) return { at: null, stamp: line.slice(0, 8), text: line.slice(9) };
      return { at: null, stamp: "", text: line.slice(INDENT.length) };
    }),
  };
}
