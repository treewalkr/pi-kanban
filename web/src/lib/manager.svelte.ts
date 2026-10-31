/**
 * Board-chat drawer store (runes, pattern of agents.svelte.ts): the sidebar's
 * footer button toggles the ManagerChat drawer, which mounts the card-agnostic
 * ChatPanel against the pseudo-card "board" — the resident manager session.
 */
import { chat } from "./chat.svelte";
import { BOARD_CHAT_ID } from "../../../src/chat";

class ManagerStore {
  open = $state(false);

  async toggle(): Promise<void> {
    if (this.open) {
      this.close();
      return;
    }
    this.open = true;
    await chat.open(BOARD_CHAT_ID);
  }

  close(): void {
    this.open = false;
    chat.close();
  }
}

export const manager = new ManagerStore();
