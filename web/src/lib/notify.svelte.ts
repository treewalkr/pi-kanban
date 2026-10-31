/**
 * Notification gating for review-entry lane events. The pure functions are the
 * unit-tested contract; the `notify` store is the browser-side consumer wired to
 * the `event: lane` SSE stream (App.svelte) and the settings UI (GeneralSettings).
 */

export interface LaneEventPayload {
  taskId: string;
  title: string;
  fromLaneId: string | null;
  toLaneId: string;
  cause: string;
  actor: string;
  createdAt: number;
}

type PermissionLike = NotificationPermission | "unsupported";

/** Card title for notification copy: 80 chars max, `…` marks truncation. */
function truncateTitle(title: string): string {
  return title.length > 80 ? title.slice(0, 80) + "…" : title;
}

/**
 * Shape-check the raw `event: lane` payload (a JSON string, or pre-parsed object).
 * Returns null on any mismatch or JSON failure — never throws.
 */
export function parseLaneEvent(raw: unknown): LaneEventPayload | null {
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.taskId !== "string") return null;
  if (typeof v.title !== "string") return null;
  if (v.fromLaneId !== null && typeof v.fromLaneId !== "string") return null;
  if (typeof v.toLaneId !== "string") return null;
  if (typeof v.cause !== "string") return null;
  if (typeof v.actor !== "string") return null;
  if (typeof v.createdAt !== "number") return null;
  return { taskId: v.taskId, title: v.title, fromLaneId: v.fromLaneId, toLaneId: v.toLaneId, cause: v.cause, actor: v.actor, createdAt: v.createdAt };
}

/** A visible board is its own signal: only a hidden, enabled, granted tab notifies. */
export function shouldNotify(
  p: LaneEventPayload,
  o: { enabled: boolean; permission: PermissionLike; hidden: boolean },
): boolean {
  return p.toLaneId === "review" && o.enabled && o.permission === "granted" && o.hidden;
}

/** Same copy as the server's osascript body. */
export function notificationBody(p: LaneEventPayload): string {
  return `${truncateTitle(p.title)} · ${p.taskId} entered Review`;
}

export function loadNotifyEnabled(read: () => string | null): boolean {
  return read() === "on";
}

function storedPermission(): PermissionLike {
  return typeof globalThis.Notification === "undefined" ? "unsupported" : Notification.permission;
}

function requestStoredEnabled(): boolean {
  try {
    return loadNotifyEnabled(() => localStorage.getItem("kanban-notify"));
  } catch {
    return false;
  }
}

function persistEnabled(value: "on" | "off"): void {
  try {
    localStorage.setItem("kanban-notify", value);
  } catch {
    /* storage unavailable */
  }
}

/** Browser-notification store: one instance, shared by settings UI and the SSE wiring. */
class NotifyStore {
  enabled = $state(requestStoredEnabled());

  permission(): PermissionLike {
    return storedPermission();
  }

  /** Ask the browser for permission; "on" is only persisted once granted. */
  async enable(): Promise<PermissionLike> {
    if (typeof globalThis.Notification === "undefined") return "unsupported";
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      this.enabled = true;
      persistEnabled("on");
    }
    return permission;
  }

  disable(): void {
    this.enabled = false;
    persistEnabled("off");
  }

  /** Entry point for each `event: lane` SSE payload. */
  onLaneData(raw: unknown): void {
    const p = parseLaneEvent(raw);
    if (!p) return;
    let hidden = false;
    try {
      hidden = document.hidden;
    } catch {
      return; // no DOM — nowhere to notify
    }
    if (!shouldNotify(p, { enabled: this.enabled, permission: storedPermission(), hidden })) return;
    const notification = new Notification("kanban", { body: notificationBody(p), tag: `kanban-${p.taskId}` });
    notification.onclick = () => window.focus();
  }
}

export const notify = new NotifyStore();
