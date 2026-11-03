import type { Lane } from "../../../src/db";

/**
 * Dragging a kanban LANE to a new position — the board's lane headers
 * (axis "x") and the settings dialog's lane rows (axis "y"). Pointer events,
 * not HTML5 drag and drop, ported from pi-web's useKanbanLaneDrag hook. A
 * mouse picks the lane up once it has moved LANE_DRAG_START_PX; with
 * allowTouch, touch and pen hold it LANE_LONG_PRESS_MS first, so a swipe
 * still scrolls. The drop position comes from the lane elements' rects
 * (elementOf), never from the DOM hit-test, and fixed lanes are skipped —
 * a drop line can never land before the fixed Waiting on you.
 */

/** A mouse drag starts once the pointer has moved this far. */
export const LANE_DRAG_START_PX = 5;
/** A touch held this long picks the lane up. */
export const LANE_LONG_PRESS_MS = 350;
/** A touch that moves farther before the long press is a swipe: it is let go. */
export const LANE_LONG_PRESS_SLOP_PX = 8;
/** How near the scroll box's edge a drag scrolls it. */
export const LANE_EDGE_PX = 32;
/** Most pixels auto-scroll moves the box in one pointermove. */
export const LANE_MAX_SCROLL_STEP = 14;

const INTERACTIVE = "button, a, input, textarea, select";

interface LaneDragState {
  pointerId: number;
  pointerType: string;
  laneId: string;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  phase: "pending" | "dragging";
  timer: ReturnType<typeof setTimeout> | null;
}

export interface LaneDragOptions {
  /** The lanes in their current board order, fixed lanes included. */
  lanes: Lane[];
  /** "x": headers side by side (the board); "y": rows stacked (settings). */
  axis: "x" | "y";
  /** The lane's element (header or row) for the midpoint hit-test. */
  elementOf(id: string): HTMLElement | null;
  /** The scroll box the lanes sit in: it scrolls out of the way near the edges. */
  scrollElement?(): HTMLElement | null;
  /** Touch/pen long-press support (settings rows, which also scroll by touch). */
  allowTouch?: boolean;
  /** Called on a committed drop with the dragged lane and its anchor (null = literal last). */
  onCommit(laneId: string, anchor: string | null): void;
}

/**
 * The first non-fixed lane (the dragged one excepted) whose midpoint the
 * pointer has not passed, else null — the pointer sits past every movable
 * lane, i.e. the drop goes after the movable band.
 */
export function dropAnchorAt(
  point: number,
  axis: "x" | "y",
  lanes: Lane[],
  elementOf: (id: string) => HTMLElement | null,
  draggedId: string,
): string | null {
  for (const lane of lanes) {
    if (lane.fixed) continue;
    if (lane.id === draggedId) continue;
    const el = elementOf(lane.id);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    const mid = axis === "y" ? rect.top + rect.height / 2 : rect.left + rect.width / 2;
    if (point < mid) return lane.id;
  }
  return null;
}

/**
 * Where a null dropBefore lands: the first fixed lane after the last
 * non-fixed lane (moving before it parks the lane at the end of the movable
 * band), or null when no fixed lane follows (literal last).
 */
function firstFixedAfterLastMovable(lanes: Lane[]): string | null {
  let lastMovable = -1;
  for (let i = 0; i < lanes.length; i++) {
    if (!lanes[i].fixed) lastMovable = i;
  }
  for (let i = lastMovable + 1; i < lanes.length; i++) {
    if (lanes[i].fixed) return lanes[i].id;
  }
  return null;
}

class LaneDragStore {
  /** The lane under the pointer, while it is being dragged. */
  draggingLaneId = $state<string | null>(null);
  /** The anchor lane the drop line renders before; null = past the movable band. */
  dropBefore = $state<string | null>(null);

  #drag: LaneDragState | null = null;
  #opts: LaneDragOptions | null = null;
  #listeners: {
    move: (e: PointerEvent) => void;
    up: (e: PointerEvent) => void;
    cancel: () => void;
    key: (e: KeyboardEvent) => void;
  } | null = null;
  #ghost: HTMLDivElement | null = null;

  /** On the drag handle (a lane header, a row's grip). */
  press(e: PointerEvent, laneId: string, opts: LaneDragOptions): void {
    if (this.#drag) return;
    if (e.button !== 0) return;
    const lane = opts.lanes.find((l) => l.id === laneId);
    if (lane?.fixed) return;
    if (e.pointerType === "touch" && !opts.allowTouch) return;
    // Interactive targets keep their click — unless the handle IS that
    // interactive element (the settings grip is a button).
    const target = e.target as HTMLElement | null;
    const interactive = target?.closest(INTERACTIVE);
    if (interactive && interactive !== (e.currentTarget as HTMLElement | null)) return;
    // A pressed lane header must not start a text selection the drag then
    // carries across the board (mice and trackpads alike).
    e.preventDefault();

    const drag: LaneDragState = {
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      laneId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      phase: "pending",
      timer: null,
    };
    this.#drag = drag;
    this.#opts = opts;

    const arm = () => {
      const d = this.#drag;
      if (!d || d.phase !== "pending") return;
      d.phase = "dragging";
      // A picked-up lane must not drag a text selection along with it.
      document.body.style.userSelect = "none";
      this.draggingLaneId = d.laneId;
      this.#positionGhost(d.lastX, d.lastY);
    };

    const move = (e: PointerEvent) => {
      const d = this.#drag;
      const o = this.#opts;
      if (!d || !o || e.pointerId !== d.pointerId) return;
      if (d.phase === "pending") {
        const dist = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
        if (d.pointerType === "mouse") {
          if (dist >= LANE_DRAG_START_PX) arm();
        } else if (dist >= LANE_LONG_PRESS_SLOP_PX) {
          // A swipe, not a hold: let go.
          this.#finish(false);
          return;
        }
        if (this.#drag?.phase !== "dragging") return;
      }
      d.lastX = e.clientX;
      d.lastY = e.clientY;
      // The ghost follows the pointer through its style, not state.
      this.#positionGhost(e.clientX, e.clientY);
      // The scroll box moves out of the way near its edges, so a lane
      // beyond the visible ones still takes the drop.
      const scroll = o.scrollElement?.();
      if (scroll) {
        const box = scroll.getBoundingClientRect();
        if (o.axis === "x") {
          if (e.clientX > box.left && e.clientX < box.left + LANE_EDGE_PX) {
            scroll.scrollLeft = Math.max(0, scroll.scrollLeft - LANE_MAX_SCROLL_STEP);
          } else if (e.clientX < box.right && e.clientX > box.right - LANE_EDGE_PX) {
            scroll.scrollLeft = Math.min(scroll.scrollWidth - scroll.clientWidth, scroll.scrollLeft + LANE_MAX_SCROLL_STEP);
          }
        } else {
          if (e.clientY > box.top && e.clientY < box.top + LANE_EDGE_PX) {
            scroll.scrollTop = Math.max(0, scroll.scrollTop - LANE_MAX_SCROLL_STEP);
          } else if (e.clientY < box.bottom && e.clientY > box.bottom - LANE_EDGE_PX) {
            scroll.scrollTop = Math.min(scroll.scrollHeight - scroll.clientHeight, scroll.scrollTop + LANE_MAX_SCROLL_STEP);
          }
        }
      }
      const anchor = dropAnchorAt(o.axis === "y" ? e.clientY : e.clientX, o.axis, o.lanes, o.elementOf, d.laneId);
      this.dropBefore = anchor;
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== this.#drag?.pointerId) return;
      this.#finish(true);
    };
    const cancel = () => this.#finish(false);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.#finish(false);
    };
    this.#listeners = { move, up, cancel, key };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
    if (drag.pointerType !== "mouse") drag.timer = setTimeout(arm, LANE_LONG_PRESS_MS);
  }

  #positionGhost(x: number, y: number): void {
    if (!this.#drag || this.#drag.phase !== "dragging") return;
    const lane = this.#opts?.lanes.find((l) => l.id === this.#drag!.laneId);
    if (!lane) return;
    if (!this.#ghost) {
      const g = document.createElement("div");
      g.className = "lane-ghost";
      document.body.appendChild(g);
      this.#ghost = g;
    }
    this.#ghost.textContent = lane.name;
    // Donor gaps: mice hug the pointer tighter than touch.
    const gapX = this.#drag.pointerType === "mouse" ? 12 : 24;
    const gapY = this.#drag.pointerType === "mouse" ? 14 : 28;
    const left = Math.max(8, Math.min(x + gapX, window.innerWidth - this.#ghost.offsetWidth - 8));
    const top = Math.max(8, Math.min(y + gapY, window.innerHeight - this.#ghost.offsetHeight - 8));
    this.#ghost.style.transform = `translate(${left}px, ${top}px)`;
  }

  #reset(): void {
    const drag = this.#drag;
    if (drag && drag.timer !== null) clearTimeout(drag.timer);
    this.#drag = null;
    this.#opts = null;
    document.body.style.userSelect = "";
    this.#ghost?.remove();
    this.#ghost = null;
    const listeners = this.#listeners;
    if (listeners) {
      window.removeEventListener("pointermove", listeners.move);
      window.removeEventListener("pointerup", listeners.up);
      window.removeEventListener("pointercancel", listeners.cancel);
      window.removeEventListener("keydown", listeners.key);
      this.#listeners = null;
    }
    this.draggingLaneId = null;
    this.dropBefore = null;
  }

  #finish(commit: boolean): void {
    const drag = this.#drag;
    const opts = this.#opts;
    if (!drag || !opts) {
      this.#reset();
      return;
    }
    const wasDragging = drag.phase === "dragging";
    const anchor = this.dropBefore;
    const laneId = drag.laneId;
    this.#reset();
    if (!commit || !wasDragging) return;
    // Commit rule: the drop line's anchor, or where a null anchor lands —
    // the first fixed lane after the movable band (itself null = literal last).
    opts.onCommit(laneId, anchor ?? firstFixedAfterLastMovable(opts.lanes));
  }
}

export const laneDrag = new LaneDragStore();
