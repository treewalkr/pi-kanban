import { board } from "./board.svelte";
import type { Task } from "../../../src/db";

export type DropHint =
  | { kind: "top"; laneId: string; index: number; before?: string } // index counts the lane's visible top-level cards; before = anchor card id, undefined = append
  | { kind: "child"; parentId: string; before?: string }; // inside the dragged card's own nest; before = sibling anchor, undefined = append to nest end

export const DRAG_THRESHOLD_PX = 4; // mouse: movement before lift
export const TOUCH_HOLD_MS = 250; // touch: hold before lift
export const TOUCH_SLACK_PX = 8; // touch: movement that cancels the hold (scroll won)
export const FLIP_DURATION_MS = 180; // animate:flip duration, parting and settle

let currentGhost: HTMLElement | null = null;
let currentContainer: HTMLElement | null = null;
let grabOffsetX = 0;
let grabOffsetY = 0;
let ghostWidth = 0;
let isReleasing = $state(false);

function releaseGhost(ghost: HTMLElement | null, onDone?: () => void): void {
  if (!ghost) {
    onDone?.();
    return;
  }
  if (typeof ghost.animate === "function") {
    const curTransform = ghost.style.transform || "none";
    const anim = ghost.animate(
      [
        { opacity: 0.96, transform: curTransform },
        {
          opacity: 0,
          transform: curTransform
            .replace(/rotate\([^)]+\)/, "rotate(0deg)")
            .replace(/scale\([^)]+\)/, "scale(1)"),
        },
      ],
      { duration: 120, easing: "ease-out" },
    );
    anim.onfinish = () => {
      ghost.remove();
      onDone?.();
    };
  } else {
    ghost.remove();
    onDone?.();
  }
}

function swallowNextClick(): void {
  if (typeof window === "undefined") return;
  const swallow = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    window.removeEventListener("click", swallow, true);
  };
  window.addEventListener("click", swallow, true);
  setTimeout(() => {
    window.removeEventListener("click", swallow, true);
  }, 0);
}

// Settled-layout geometry: the transform-immune viewport rect of an element
// inside a lane. animate:flip reorders translate the wrapper divs, so any
// getBoundingClientRect() on a card mid-flip includes the in-flight transform
// and hint decisions end up chasing moving geometry. The offsetTop/
// offsetParent chain is computed from layout, not transforms, so it stays
// still while flips run. Nothing at or above section.lane is transform-animated
// during a drag, so the element outside the lane (the offset anchor) is the
// trusted viewport origin.
function settledRect(
  el: HTMLElement,
  laneEl: HTMLElement,
): { top: number; left: number; height: number; width: number } {
  let accTop = 0;
  let accLeft = 0;
  let curr: HTMLElement = el;
  // walk offsetParent links while they stay inside the lane; the first offset
  // parent at or above the lane (or null) is the anchor
  while (curr.offsetParent && curr.offsetParent !== laneEl && laneEl.contains(curr.offsetParent)) {
    accTop += curr.offsetTop + (curr.offsetParent as HTMLElement).clientTop;
    accLeft += curr.offsetLeft + (curr.offsetParent as HTMLElement).clientLeft;
    curr = curr.offsetParent as HTMLElement;
  }
  accTop += curr.offsetTop;
  accLeft += curr.offsetLeft;
  const anchor = (curr.offsetParent as HTMLElement | null) ?? laneEl;
  accTop += anchor.clientTop;
  accLeft += anchor.clientLeft;

  // scroll correction: subtract scrolled offsets of scroll containers between
  // el and the anchor (today exactly one: .cards)
  let scrollTop = 0;
  let scrollLeft = 0;
  for (let p = el.parentElement; p && p !== anchor; p = p.parentElement) {
    const cs = window.getComputedStyle(p);
    if (cs.overflowY === "auto" || cs.overflowY === "scroll") scrollTop += p.scrollTop;
    if (cs.overflowX === "auto" || cs.overflowX === "scroll") scrollLeft += p.scrollLeft;
  }

  const anchorRect = anchor.getBoundingClientRect();
  return {
    top: anchorRect.top + accTop - scrollTop,
    left: anchorRect.left + accLeft - scrollLeft,
    height: el.offsetHeight,
    width: el.offsetWidth,
  };
}

class DragStore {
  taskId = $state<string | null>(null); // the lifted card, null when idle
  hint = $state<DropHint | null>(null);
  private pendingFrame: number | null = null; // scheduled computeHint frame
  private lastHintX = 0; // last pointer position seen by the hint pipeline
  private lastHintY = 0;

  get lifted(): boolean {
    return this.taskId !== null || isReleasing;
  }

  // Coalesce hint computation to one per animation frame: pointermove fires at
  // device frequency and each run walks the lane's layout (settledRect), which
  // is wasted work when several events land inside the same frame. Ghost
  // tracking stays per-move (composited style write, keeps tracking crisp).
  private scheduleHint(x: number, y: number): void {
    if (typeof window === "undefined") return;
    this.lastHintX = x;
    this.lastHintY = y;
    if (this.pendingFrame !== null) return;
    this.pendingFrame = window.requestAnimationFrame(() => {
      this.pendingFrame = null;
      if (!this.taskId) return;
      this.computeHint(this.lastHintX, this.lastHintY);
    });
  }

  // Drop any pending frame; commit() flushes synchronously first so the drop
  // lands where the pointer last was even if no frame fired.
  private flushHint(): void {
    if (this.pendingFrame !== null) {
      window.cancelAnimationFrame(this.pendingFrame);
      this.pendingFrame = null;
    }
    if (this.taskId) {
      this.computeHint(this.lastHintX, this.lastHintY);
    }
  }

  // Write the hint only when its meaning changed. Svelte re-runs the animated
  // each block (measure/apply, which aborts in-flight flips) whenever the hint
  // $state changes — a fresh object with the same slot would murder and restart
  // every displaced card's flip on each pointermove. Same values → same
  // reference → no reconcile → flips run to completion.
  private setHint(next: DropHint | null): void {
    const cur = this.hint;
    if (cur === next) return;
    if (cur && next && cur.kind === next.kind && cur.before === next.before) {
      if (cur.kind === "top" && next.kind === "top" && cur.index === next.index && cur.laneId === next.laneId) return;
      if (cur.kind === "child" && next.kind === "child" && cur.parentId === next.parentId) return;
    }
    this.hint = next;
  }

  press(task: Task, e: PointerEvent): void {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("button, a, input, textarea, select, [contenteditable]")) return;

    e.stopPropagation();

    if (typeof window === "undefined") return;

    const startX = e.clientX;
    const startY = e.clientY;
    let lastX = startX;
    let lastY = startY;

    const cardEl = target?.closest("[data-card]") as HTMLElement | null;
    if (!cardEl) return;

    const rect = cardEl.getBoundingClientRect();
    grabOffsetX = startX - rect.left;
    grabOffsetY = startY - rect.top;
    ghostWidth = rect.width;

    let isLifted = false;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;

    const onTouchMovePrevent = (ev: TouchEvent) => {
      if (isLifted) {
        ev.preventDefault();
      }
    };

    const cleanup = () => {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("touchmove", onTouchMovePrevent);
    };

    const doLift = (clientX: number, clientY: number) => {
      isLifted = true;
      this.lift(task, clientX, clientY, cardEl);
      window.addEventListener("touchmove", onTouchMovePrevent, { passive: false });
      this.lastHintX = clientX;
      this.lastHintY = clientY;
      this.computeHint(clientX, clientY);
    };

    if (e.pointerType === "touch") {
      holdTimer = setTimeout(() => {
        holdTimer = null;
        doLift(lastX, lastY);
      }, TOUCH_HOLD_MS);
    }

    const onPointerMove = (ev: PointerEvent) => {
      lastX = ev.clientX;
      lastY = ev.clientY;

      if (!isLifted) {
        const dist = Math.hypot(ev.clientX - startX, ev.clientY - startY);
        if (ev.pointerType === "touch") {
          if (dist > TOUCH_SLACK_PX) {
            cleanup();
            return;
          }
          return;
        } else {
          if (dist < DRAG_THRESHOLD_PX) return;
          doLift(ev.clientX, ev.clientY);
        }
      }

      if (currentGhost) {
        currentGhost.style.transform = `translate(${ev.clientX - grabOffsetX}px, ${ev.clientY - grabOffsetY}px) rotate(2deg) scale(1.02)`;
      }
      this.scheduleHint(ev.clientX, ev.clientY);
    };

    const onPointerUp = async () => {
      cleanup();
      if (isLifted) {
        swallowNextClick();
        await this.commit();
      }
    };

    const onPointerCancel = () => {
      cleanup();
      if (isLifted) {
        this.cancel();
      }
    };

    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        cleanup();
        this.cancel();
      }
    };

    const onBlur = () => {
      cleanup();
      if (isLifted) {
        this.cancel();
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);
  }

  private lift(task: Task, clientX: number, clientY: number, cardEl: HTMLElement): void {
    this.taskId = task.id;
    if (typeof document !== "undefined") {
      document.body.classList.add("drag-live");

      const clone = cardEl.cloneNode(true) as HTMLElement;
      clone.classList.add("drag-ghost");
      clone.classList.remove("drag-slot");
      clone.removeAttribute("data-card");
      clone.setAttribute("data-ghost", task.id);
      clone.style.width = `${ghostWidth}px`;
      clone.style.boxSizing = "border-box";
      clone.style.position = "absolute";
      clone.style.top = "0";
      clone.style.left = "0";
      clone.style.margin = "0";
      clone.style.pointerEvents = "none";
      clone.style.transform = `translate(${clientX - grabOffsetX}px, ${clientY - grabOffsetY}px) rotate(2deg) scale(1.02)`;

      currentGhost = clone;
      if (currentContainer) {
        currentContainer.appendChild(clone);
      }
    }
  }

  computeHint(clientX: number, clientY: number): void {
    if (!this.taskId || typeof document === "undefined") return;

    const hit = document.elementFromPoint(clientX, clientY);
    const laneEl = hit?.closest("section.lane") as HTMLElement | null;
    if (!laneEl) {
      this.setHint(null);
      return;
    }

    const laneId = laneEl.getAttribute("data-lane");
    if (!laneId) {
      this.setHint(null);
      return;
    }

    // Collapsed lane: append hint
    if (laneEl.classList.contains("collapsed")) {
      this.setHint({ kind: "top", laneId, index: 0, before: undefined });
      return;
    }

    // Gap-feedback guard: hovering the settled slot (the dragged card's own
    // element, nested footprint included) holds the current hint — measured
    // without flip transforms so the moving slot never lies about where it is
    const slotEl = laneEl.querySelector(`[data-card="${this.taskId}"]`) as HTMLElement | null;
    if (slotEl) {
      const sr = settledRect(slotEl, laneEl);
      if (
        clientX >= sr.left &&
        clientX <= sr.left + sr.width &&
        clientY >= sr.top &&
        clientY <= sr.top + sr.height
      ) {
        return;
      }
    }

    const dragged = board.taskById(this.taskId);

    // Child-kind hint: hovering inside .card-children of dragged card's own parent.
    // Routed by the children container's settled rect so both the Y band and the
    // X span match (a pointer left of the container is a top-level hint, not a
    // child reorder) even while sibling cards are mid-flip.
    if (dragged && board.nestsUnder(dragged) && dragged.parentId) {
      const parentEl = laneEl.querySelector(`[data-card="${dragged.parentId}"]`);
      const parentChildrenEl = parentEl?.querySelector(".card-children") as HTMLElement | null;
      if (parentChildrenEl) {
        const cr = settledRect(parentChildrenEl, laneEl);
        const inChildren =
          clientX >= cr.left &&
          clientX <= cr.left + cr.width &&
          clientY >= cr.top &&
          clientY <= cr.top + cr.height;
        if (inChildren) {
          const siblingCards = ([...parentChildrenEl.querySelectorAll(":scope > div > [data-card], :scope > [data-card]")] as HTMLElement[])
            .filter((el) => el.getAttribute("data-card") !== this.taskId);
          const hoveredSibling = siblingCards.find((s) => s.contains(hit));
          if (hoveredSibling) {
            const r = settledRect(hoveredSibling, laneEl);
            const midY = r.top + r.height / 2;
            const idx = siblingCards.indexOf(hoveredSibling);
            if (clientY < midY) {
              this.setHint({ kind: "child", parentId: dragged.parentId, before: hoveredSibling.getAttribute("data-card")! });
            } else {
              const next = siblingCards[idx + 1];
              this.setHint({ kind: "child", parentId: dragged.parentId, before: next ? next.getAttribute("data-card")! : undefined });
            }
          } else {
            this.setHint({ kind: "child", parentId: dragged.parentId, before: undefined });
          }
          return;
        }
      }
    }

    // Top-level hint
    const cardsContainer = laneEl.querySelector(".cards");
    const tops = ([...(cardsContainer?.querySelectorAll(":scope > div > [data-card], :scope > [data-card]") ?? [])] as HTMLElement[])
      .filter((el) => el.getAttribute("data-card") !== this.taskId);

    if (tops.length === 0) {
      this.setHint({ kind: "top", laneId, index: 0, before: undefined });
      return;
    }

    const lastBlock = tops[tops.length - 1];
    const lastR = settledRect(lastBlock, laneEl);
    if (clientY > lastR.top + lastR.height) {
      this.setHint({ kind: "top", laneId, index: tops.length, before: undefined });
      return;
    }

    for (let i = 0; i < tops.length; i++) {
      const block = tops[i];
      const r = settledRect(block, laneEl);
      const midY = r.top + r.height / 2;
      if (clientY < midY) {
        this.setHint({ kind: "top", laneId, index: i, before: block.getAttribute("data-card")! });
        return;
      }
      if (clientY <= r.top + r.height) {
        const next = tops[i + 1];
        this.setHint({ kind: "top", laneId, index: i + 1, before: next ? next.getAttribute("data-card")! : undefined });
        return;
      }
    }

    this.setHint({ kind: "top", laneId, index: tops.length, before: undefined });
  }

  async commit(): Promise<void> {
    this.flushHint();
    const id = this.taskId;
    const hint = this.hint;

    const ghost = currentGhost;
    currentGhost = null;

    if (ghost) {
      isReleasing = true;
      releaseGhost(ghost, () => {
        isReleasing = false;
      });
    }

    if (!id || !hint) {
      this.cancel();
      return;
    }

    try {
      if (hint.kind === "top") {
        const laneId = hint.laneId;
        const before = hint.before && hint.before !== id ? hint.before : undefined;
        if (before) {
          await board.moveTask(id, laneId, { before });
        } else {
          await board.moveTask(id, laneId);
        }
      } else if (hint.kind === "child") {
        const parentTask = board.taskById(hint.parentId);
        const laneId = parentTask ? parentTask.laneId : "backlog";
        const before = hint.before && hint.before !== id ? hint.before : undefined;
        if (before) {
          await board.moveTask(id, laneId, { before });
        } else {
          await board.moveTask(id, laneId);
        }
      }
    } finally {
      this.taskId = null;
      this.hint = null;
      if (typeof document !== "undefined") {
        document.body.classList.remove("drag-live");
      }
    }
  }

  cancel(): void {
    if (this.pendingFrame !== null) {
      window.cancelAnimationFrame(this.pendingFrame);
      this.pendingFrame = null;
    }
    if (currentGhost) {
      currentGhost.remove();
      currentGhost = null;
    }
    isReleasing = false;
    this.taskId = null;
    this.hint = null;
    if (typeof document !== "undefined") {
      document.body.classList.remove("drag-live");
    }
  }

  displayTasks(laneId: string): Task[] {
    const visible = board.visibleTasks(laneId);
    if (!this.taskId) return visible;
    const dragged = board.taskById(this.taskId);
    if (!dragged) {
      this.cancel();
      return visible;
    }

    const hint = this.hint;
    if (hint?.kind === "top") {
      if (hint.laneId === laneId) {
        const others = visible.filter((t) => t.id !== dragged.id);
        const at = Math.max(0, Math.min(hint.index, others.length));
        return [...others.slice(0, at), dragged, ...others.slice(at)];
      }
      return visible.filter((t) => t.id !== dragged.id);
    }

    if (hint?.kind === "child") {
      return visible.filter((t) => t.id !== dragged.id);
    }

    return visible;
  }

  displayNest(task: Task): Task[] {
    const children = board.nestedChildren(task);
    if (!this.taskId) return children;
    const dragged = board.taskById(this.taskId);
    if (!dragged) {
      this.cancel();
      return children;
    }

    const isChild = children.some((c) => c.id === dragged.id);
    const hint = this.hint;

    if (hint?.kind === "child") {
      if (hint.parentId === task.id) {
        const siblings = children.filter((c) => c.id !== dragged.id);
        if (hint.before) {
          const at = siblings.findIndex((c) => c.id === hint.before);
          if (at !== -1) {
            return [...siblings.slice(0, at), dragged, ...siblings.slice(at)];
          }
        }
        return [...siblings, dragged];
      }
      return isChild ? children.filter((c) => c.id !== dragged.id) : children;
    }

    if (hint?.kind === "top") {
      return isChild ? children.filter((c) => c.id !== dragged.id) : children;
    }

    return children;
  }
}

export const drag = new DragStore();

export function dragGhost(container: HTMLElement): { destroy(): void } {
  currentContainer = container;

  if (drag.taskId && !currentGhost && typeof document !== "undefined") {
    const el = document.querySelector(`[data-card="${drag.taskId}"]`) as HTMLElement | null;
    if (el) {
      const rect = el.getBoundingClientRect();
      const clone = el.cloneNode(true) as HTMLElement;
      clone.classList.add("drag-ghost");
      clone.classList.remove("drag-slot");
      clone.removeAttribute("data-card");
      clone.setAttribute("data-ghost", drag.taskId);
      clone.style.width = `${rect.width}px`;
      clone.style.boxSizing = "border-box";
      clone.style.position = "absolute";
      clone.style.top = "0";
      clone.style.left = "0";
      clone.style.margin = "0";
      clone.style.pointerEvents = "none";
      clone.style.transform = `translate(${rect.left}px, ${rect.top}px) rotate(2deg) scale(1.02)`;
      currentGhost = clone;
      container.appendChild(clone);
    }
  } else if (currentGhost && !container.contains(currentGhost)) {
    container.appendChild(currentGhost);
  }

  return {
    destroy() {
      if (currentGhost && currentGhost.parentNode === container) {
        currentGhost.remove();
      }
      currentContainer = null;
    },
  };
}
