import type { GhLink, GhStatus } from "../../../src/db";

export interface GhChip {
  /** Always `#{number}` — the card chip stays tiny. */
  label: string;
  className: string;
  /** Url alone while pending; `{url} — {state}` once synced. */
  title: string;
}

/**
 * Chip presentation for one GitHub link: pending until gh_state has a row,
 * then colored by state — GitHub's open-green / merged-purple / closed-red.
 * Any unrecognized state string renders as pending, never as a color.
 */
export function ghChip(link: GhLink, status: GhStatus | null): GhChip {
  if (!status) {
    return { label: `#${link.number}`, className: "chip gh gh-pending", title: link.url };
  }
  const cls =
    status.state === "OPEN"
      ? "gh-open"
      : status.state === "MERGED"
        ? "gh-merged"
        : status.state === "CLOSED"
          ? "gh-closed"
          : "gh-pending";
  return { label: `#${link.number}`, className: `chip gh ${cls}`, title: `${link.url} — ${status.state}` };
}
