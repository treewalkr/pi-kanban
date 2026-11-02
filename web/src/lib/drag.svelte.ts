import { board } from "./board.svelte";
import type { Task } from "../../../src/db";

export type DropHint =
  | { kind: "top"; laneId: string; index: number; before?: string } // index counts the lane's visible top-level cards; before = anchor card id, undefined = append
  | { kind: "child"; parentId: string; before?: string }; // inside the dragged card's own nest; before = sibling anchor, undefined = append to nest end

export const DRAG_THRESHOLD_PX = 4; // mouse: movement before lift
export const TOUCH_HOLD_MS = 250; // touch: hold before lift
export const TOUCH_SLACK_PX = 8; // touch: movement that cancels the hold (scroll won)
export const FLIP_DURATION_MS = 180; // animate:flip duration, parting and settle

class DragStore {
  taskId = $state<string | null>(null); // the lifted card, null when idle
  hint = $state<DropHint | null>(null);

  get lifted(): boolean {
    return this.taskId !== null;
  }

  press(task: Task, e: PointerEvent): void {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest("button, a, input, textarea, select, [contenteditable]")) return;
    // listener plumbing wired in step 2
  }

  displayTasks(laneId: string): Task[] {
    const visible = board.visibleTasks(laneId);
    if (!this.taskId) return visible;
    const dragged = board.taskById(this.taskId);
    if (!dragged) return visible;

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
    if (!dragged) return children;

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
  return {
    destroy() {},
  };
}
