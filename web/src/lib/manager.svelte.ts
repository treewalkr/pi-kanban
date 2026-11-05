/**
 * Board-chat drawer store (runes, pattern of agents.svelte.ts): the sidebar's
 * footer button toggles the ManagerChat drawer, which mounts the card-agnostic
 * ChatPanel against a board handle — plain "board" (whole board) or
 * "board:<project>" (one project's repo). The scope persists in board_state via
 * GET/PUT /chat-board.
 */
import { api } from "../api";
import { chat } from "./chat.svelte";
import { projects } from "./projects.svelte";

/** BOARD_CHAT_ID from src/chat — inlined so the browser bundle never imports the server module. */
const BOARD_CHAT_ID = "board";

class ManagerStore {
  open = $state(false);
  /** The active project scope; null = the whole board. */
  project = $state<string | null>(null);

  /** The chat handle the drawer drives: board, or board:<project>. */
  get handle(): string {
    return this.project ? `board:${this.project}` : BOARD_CHAT_ID;
  }

  async toggle(): Promise<void> {
    if (this.open) {
      this.close();
      return;
    }
    this.open = true;
    // The persisted scope drives every open; a stale/deleted project falls back to the whole board.
    try {
      await projects.load();
      const res = await api["chat-board"].get();
      const persisted = res.error ? null : (res.data?.project ?? null);
      this.project =
        !projects.loadFailed && persisted !== null && projects.projects.some((p) => p.name === persisted)
          ? persisted
          : null;
    } catch {
      this.project = null;
    }
    await chat.open(this.handle);
  }

  /** Switch the drawer to a project scope (null = whole board); persistence is best-effort. */
  async switchTo(project: string | null): Promise<void> {
    this.project = project;
    this.open = true;
    try {
      await api["chat-board"].put({ project });
    } catch {
      /* best-effort: a failed PUT still switches the session */
    }
    await chat.open(this.handle);
  }

  close(): void {
    this.open = false;
    this.project = null;
    chat.close();
  }
}

export const manager = new ManagerStore();
