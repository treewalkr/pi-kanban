import { api } from "../api";
import type { GitInfo } from "../../../src/git";

function loadSidebarOpen(): boolean {
  try {
    return localStorage.getItem("kanban-sidebar") !== "collapsed";
  } catch {
    return true;
  }
}

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 400;

function loadSidebarWidth(): number {
  try {
    const raw = localStorage.getItem("kanban-sidebar-width");
    // absent key is Number(null) === 0 — must not clamp into the minimum
    const n = raw === null ? Number.NaN : Number(raw);
    if (Number.isFinite(n)) return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(n)));
  } catch {
    /* storage unavailable */
  }
  return 260;
}

/** Shell state shared by App (toggle, resize) and Sidebar. */
class UiStore {
  #open = $state(loadSidebarOpen());

  get sidebarOpen(): boolean {
    return this.#open;
  }

  set sidebarOpen(v: boolean) {
    this.#open = v;
    try {
      localStorage.setItem("kanban-sidebar", v ? "open" : "collapsed");
    } catch {
      /* storage unavailable — the toggle still works for this session */
    }
  }

  #width = $state(loadSidebarWidth());

  get sidebarWidth(): number {
    return this.#width;
  }

  set sidebarWidth(v: number) {
    this.#width = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(v)));
    try {
      localStorage.setItem("kanban-sidebar-width", String(this.#width));
    } catch {
      /* storage unavailable */
    }
  }

  /** Repo the board serves; null before the first fetch, { repo: false } hides the branch row. */
  git = $state<GitInfo | { repo: false } | null>(null);

  async loadGit(): Promise<void> {
    const { data, error } = await api.git.get();
    // a pre-/git server 404s — degrade to "no repo" until the next serve restart
    this.git = error ? { repo: false } : data;
  }

  /** Returns an error message for the error bar, or null on success. */
  async checkoutGit(branch: string): Promise<string | null> {
    const { error } = await api.git.checkout.post({ branch });
    if (error) {
      const value = error.value as { error?: string } | undefined;
      return value?.error ?? "git checkout failed";
    }
    await this.loadGit();
    return null;
  }
}

export const ui = new UiStore();
