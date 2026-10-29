import type { WaitingState } from "../../../src/db";

/** The rendered waiting badge for a card — fixed copy, no markup. */
export interface WaitingBadge {
  state: WaitingState;
  label: string;
  title: string;
}

const BADGES: Record<WaitingState, WaitingBadge> = {
  gate: { state: "gate", label: "✓ ready — approve/reject", title: "plan passed review — approve or reject it" },
  question: { state: "question", label: "? needs your answer", title: "open question — your comment re-arms the planner" },
  rerun: { state: "rerun", label: "↻ comment to re-run", title: "review session ended without a verdict — comment to re-run it" },
  capped: { state: "capped", label: "‖ needs a human", title: "review cap reached — reject to re-plan, or comment to re-run" },
  dead: {
    state: "dead",
    label: "✗ session died",
    title: "agent session died — open the thread for the reason; comment to re-run it",
  },
};

/** The badge for a card's waiting state; null when a live session owns the slot or there is nothing to show. */
export function waitingBadge(state: WaitingState | undefined, busy: boolean): WaitingBadge | null {
  if (busy) return null; // the ◌ working chip owns card-meta while an agent session is live
  if (!state) return null;
  return BADGES[state];
}

export function canResume(state: WaitingState | undefined, busy: boolean): boolean {
  return state === "dead" && !busy;
}
