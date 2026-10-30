import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ui, startViewportSync, type NarrowMedia } from "../web/src/lib/ui.svelte";

class FakeNarrowMedia implements NarrowMedia {
  matches: boolean;
  listeners = new Set<() => void>();

  constructor(matches: boolean) {
    this.matches = matches;
  }

  addEventListener(type: "change", cb: () => void): void {
    if (type === "change") this.listeners.add(cb);
  }

  removeEventListener(type: "change", cb: () => void): void {
    if (type === "change") this.listeners.delete(cb);
  }

  dispatch(): void {
    for (const cb of Array.from(this.listeners)) cb();
  }
}

describe("startViewportSync", () => {
  const originalLocalStorage = globalThis.localStorage;
  let storage = new Map<string, string>();

  beforeEach(() => {
    storage = new Map();
    globalThis.localStorage = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, String(v)),
      removeItem: (k: string) => storage.delete(k),
      clear: () => storage.clear(),
    } as any;
  });

  afterEach(() => {
    globalThis.localStorage = originalLocalStorage;
  });

  test("closes the sidebar when the viewport is or becomes narrow", () => {
    // 1. Initial wide viewport leaves sidebar open
    ui.sidebarOpen = true;
    const mq = new FakeNarrowMedia(false);
    const cleanup = startViewportSync(mq);

    expect(ui.sidebarOpen).toBe(true);
    expect(mq.listeners.size).toBe(1);

    // 2. Breakpoint change to narrow closes sidebar and persists
    mq.matches = true;
    mq.dispatch();

    expect(ui.sidebarOpen).toBe(false);
    expect(localStorage.getItem("kanban-sidebar")).toBe("collapsed");

    // 3. Cleanup removes the listener
    cleanup();
    expect(mq.listeners.size).toBe(0);

    // 4. Initial narrow viewport closes immediately
    ui.sidebarOpen = true;
    const mqNarrow = new FakeNarrowMedia(true);
    const cleanupNarrow = startViewportSync(mqNarrow);

    expect(ui.sidebarOpen).toBe(false);
    expect(localStorage.getItem("kanban-sidebar")).toBe("collapsed");
    cleanupNarrow();
  });
});
