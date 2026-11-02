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

class DragStore {
  taskId = $state<string | null>(null); // the lifted card, null when idle
  hint = $state<DropHint | null>(null);

  get lifted(): boolean {
    return this.taskId !== null || isReleasing;
  }

  press(task: Task, e: PointerEvent): void {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("button, a, input, textarea, select, [contenteditable]")) return;

    e.stopPropagation();

    if (typeof window === "undefined") return;

    const startX = e.clientX;
    const startY = e.clientY;
    const cardEl = target?.closest("[data-card]") as HTMLElement | null;
    if (!cardEl) return;

    const rect = cardEl.getBoundingClientRect();
    grabOffsetX = startX - rect.left;
    grabOffsetY = startY - rect.top;
    ghostWidth = rect.width;

    let isLifted = false;

    const onPointerMove = (ev: PointerEvent) => {
      if (!isLifted) {
        const dist = Math.hypot(ev.clientX - startX, ev.clientY - startY);
        if (dist < DRAG_THRESHOLD_PX) return;
        isLifted = true;
        this.lift(task, ev.clientX, ev.clientY, cardEl);
      }

      if (currentGhost) {
        currentGhost.style.transform = `translate(${ev.clientX - grabOffsetX}px, ${ev.clientY - grabOffsetY}px) rotate(2deg) scale(1.02)`;
      }
      this.computeHint(ev.clientX, ev.clientY);
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
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
      this.hint = null;
      return;
    }

    const laneId = laneEl.getAttribute("data-lane");
    if (!laneId) {
      this.hint = null;
      return;
    }

    // Collapsed lane: append hint
    if (laneEl.classList.contains("collapsed")) {
      this.hint = { kind: "top", laneId, index: 0, before: undefined };
      return;
    }

    // Gap-feedback guard: hovering the slot itself or within it holds current hint
    const hovered = hit?.closest("[data-card]") as HTMLElement | null;
    if (hovered) {
      const hoveredId = hovered.getAttribute("data-card");
      if (hoveredId === this.taskId) {
        return;
      }
      const slotEl = laneEl.querySelector(`[data-card="${this.taskId}"]`);
      if (slotEl && slotEl.contains(hovered)) {
        return;
      }
    }

    const dragged = board.taskById(this.taskId);

    // Child-kind hint: hovering inside .card-children of dragged card's own parent
    if (dragged && board.nestsUnder(dragged) && dragged.parentId) {
      const parentEl = laneEl.querySelector(`[data-card="${dragged.parentId}"]`);
      const parentChildrenEl = parentEl?.querySelector(".card-children");
      if (parentChildrenEl && parentChildrenEl.contains(hit)) {
        const siblingCards = ([...parentChildrenEl.querySelectorAll(":scope > [data-card]")] as HTMLElement[])
          .filter((el) => el.getAttribute("data-card") !== this.taskId);
        const hoveredSibling = siblingCards.find((s) => s.contains(hit));
        if (hoveredSibling) {
          const r = hoveredSibling.getBoundingClientRect();
          const midY = r.top + r.height / 2;
          const idx = siblingCards.indexOf(hoveredSibling);
          if (clientY < midY) {
            this.hint = { kind: "child", parentId: dragged.parentId, before: hoveredSibling.getAttribute("data-card")! };
          } else {
            const next = siblingCards[idx + 1];
            this.hint = { kind: "child", parentId: dragged.parentId, before: next ? next.getAttribute("data-card")! : undefined };
          }
        } else {
          this.hint = { kind: "child", parentId: dragged.parentId, before: undefined };
        }
        return;
      }
    }

    // Top-level hint
    const cardsContainer = laneEl.querySelector(".cards");
    const tops = ([...(cardsContainer?.querySelectorAll(":scope > [data-card]") ?? [])] as HTMLElement[])
      .filter((el) => el.getAttribute("data-card") !== this.taskId);

    if (tops.length === 0) {
      this.hint = { kind: "top", laneId, index: 0, before: undefined };
      return;
    }

    const lastBlock = tops[tops.length - 1];
    if (clientY > lastBlock.getBoundingClientRect().bottom) {
      this.hint = { kind: "top", laneId, index: tops.length, before: undefined };
      return;
    }

    for (let i = 0; i < tops.length; i++) {
      const block = tops[i];
      const r = block.getBoundingClientRect();
      const midY = r.top + r.height / 2;
      if (clientY < midY) {
        this.hint = { kind: "top", laneId, index: i, before: block.getAttribute("data-card")! };
        return;
      }
      if (clientY <= r.bottom) {
        const next = tops[i + 1];
        this.hint = { kind: "top", laneId, index: i + 1, before: next ? next.getAttribute("data-card")! : undefined };
        return;
      }
    }

    this.hint = { kind: "top", laneId, index: tops.length, before: undefined };
  }

  async commit(): Promise<void> {
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
