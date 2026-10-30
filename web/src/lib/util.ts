import type { QueuedJobInfo } from "../../../src/autoreview";
import type { AgentRole, Lane, Task } from "../../../src/db";

// Lane accents follow pi-web's theme accents: pastels on dark (a4c2f4 blue,
// e8b27a ember, cdb4f0 dusk, acccb7 pine…), deeper hues on light. Defined as
// --lane-N custom properties in app.css.
const LANE_COUNT = 8;

export function laneColor(index: number): string {
  return `var(--lane-${index % LANE_COUNT}, var(--text-dim))`;
}

export function timeAgo(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });

/** Long-form relative time ("15 minutes ago"), pi-web's sidebar row format. */
export function formatRelativeTime(ts: number, now = Date.now()): string {
  const s = (ts - now) / 1000;
  const abs = Math.abs(s);
  if (abs < 60) return relativeTime.format(Math.round(s), "second");
  if (abs < 3600) return relativeTime.format(Math.round(s / 60), "minute");
  if (abs < 86400) return relativeTime.format(Math.round(s / 3600), "hour");
  return relativeTime.format(Math.round(s / 86400), "day");
}

export function roleVerb(role: AgentRole): "reviewing" | "checking plan" | "planning" | "building" | "elaborating" {
  if (role === "reviewer") return "reviewing";
  if (role === "plan-reviewer") return "checking plan";
  if (role === "planner") return "planning";
  if (role === "elaborator") return "elaborating";
  return "building";
}

export function roleAuthor(role: AgentRole): string {
  if (role === "reviewer") return "pi-reviewer";
  if (role === "plan-reviewer") return "pi-plan-reviewer";
  if (role === "planner") return "pi-planner";
  if (role === "elaborator") return "pi-elaborator";
  return "pi-builder";
}

export function queuedChip(job: QueuedJobInfo): { label: string; title: string } {
  return {
    label: `⧗ queued · ${roleVerb(job.role)}`,
    title: "waiting for the running agent session — the loop is serial",
  };
}

export function canPromoteToPlan(task: Pick<Task, "laneId">, lanes: Array<Pick<Lane, "id">>): boolean {
  return task.laneId === "backlog" && lanes.some((l) => l.id === "plan");
}
