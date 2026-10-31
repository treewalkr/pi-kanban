import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chat } from "../web/src/lib/chat.svelte";
import { manager } from "../web/src/lib/manager.svelte";

// ── store behavior against the real chat store (fakes per chatview.test.ts) ──

let fetchCalls: Array<{ method: string; path: string }> = [];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function emptyChatState() {
  return {
    running: false,
    sessionId: null,
    isStreaming: false,
    isCompacting: false,
    queued: { steering: [], followUp: [] },
    model: null,
    thinkingLevel: "off",
    messages: [],
    messagesTruncated: false,
  };
}

function mockFetch(): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const url = new URL(String(input));
    fetchCalls.push({ method: init?.method ?? "GET", path: url.pathname });
    if (init?.method === "POST" && url.pathname.startsWith("/chat/")) {
      return jsonResponse(200, { accepted: true, disposition: "started" });
    }
    return jsonResponse(200, emptyChatState());
  };
}

class FakeEventSource {
  url: string;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
  }
  close(): void {}
}

let originalFetch: typeof globalThis.fetch | undefined;
let originalEventSource: unknown;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalEventSource = (globalThis as any).EventSource;
  fetchCalls = [];
  (globalThis as any).fetch = mockFetch();
  (globalThis as any).EventSource = FakeEventSource;
  chat.close();
});

afterEach(() => {
  manager.close();
  chat.close();
  (globalThis as any).fetch = originalFetch;
  (globalThis as any).EventSource = originalEventSource;
  for (const key of ["fetch", "EventSource"]) {
    if ((globalThis as any)[key] === undefined) delete (globalThis as any)[key];
  }
});

test("toggling the drawer opens the chat store against the board pseudo-card", async () => {
  await manager.toggle();
  expect(manager.open).toBe(true);
  expect(chat.openCardId).toBe("board");
  expect(fetchCalls.some((c) => c.path === "/chat/board")).toBe(true);

  manager.close();
  expect(manager.open).toBe(false);
  expect(chat.openCardId).toBeNull();
});

test("toggle is a switch: open → close → open", async () => {
  await manager.toggle();
  expect(manager.open).toBe(true);
  manager.toggle();
  expect(manager.open).toBe(false);
  await manager.toggle();
  expect(manager.open).toBe(true);
});

// ── source wiring (source-assertion pattern of blockers-ui.test.ts) ──────────

const read = (p: string): string => readFileSync(join(import.meta.dir, "..", p), "utf-8");

test("sidebar footer carries the Board chat button wired to manager.toggle", () => {
  const sidebar = read("web/src/lib/Sidebar.svelte");
  expect(sidebar).toContain('import { manager } from "./manager.svelte"');
  expect(sidebar).toContain("MessagesSquare");
  expect(sidebar).toContain('aria-label="Board chat"');
  expect(sidebar.indexOf('onclick={() => void manager.toggle()}')).toBeGreaterThan(-1);
  // it lives in the same footer row as the settings sections
  const footIdx = sidebar.indexOf('class="sidebar-foot"');
  expect(footIdx).toBeGreaterThan(-1);
  expect(sidebar.indexOf("Board chat", footIdx)).toBeGreaterThan(footIdx);
});

test("App mounts ManagerChat beside SettingsPanel, gated on manager.open", () => {
  const app = read("web/src/App.svelte");
  expect(app).toContain('import ManagerChat from "./lib/ManagerChat.svelte"');
  expect(app).toContain('import { manager } from "./lib/manager.svelte"');
  const mount = app.indexOf("{#if manager.open}");
  expect(mount).toBeGreaterThan(-1);
  expect(app.indexOf("<ManagerChat />", mount)).toBeGreaterThan(mount);
  // the settings dialog mounts nearby, not nested inside the drawer
  expect(app.indexOf("<SettingsPanel />")).toBeGreaterThan(-1);
});

test("ManagerChat is a right-side drawer carrying the ChatPanel and both close paths", () => {
  const drawer = read("web/src/lib/ManagerChat.svelte");
  expect(drawer).toContain("board chat · the manager");
  expect(drawer).toContain("dispatches lane workers");
  expect(drawer).toContain("import ChatPanel from \"./ChatPanel.svelte\"");
  expect(drawer).toContain("<ChatPanel />");
  expect(drawer).toContain('manager.close()'); // ✕ button
  expect(drawer).toContain('if (e.target === e.currentTarget) manager.close()'); // backdrop click
  expect(drawer).toContain('if (e.key === "Escape") manager.close()'); // Escape
  const css = read("web/src/app.css");
  expect(css).toMatch(/\.manager-backdrop\s*{[^}]*justify-content: flex-end;/s);
});

test("agents settings: manager/worker roles plus the lane workers section with empty state", () => {
  const settings = read("web/src/lib/AgentsSettings.svelte");
  expect(settings).toContain('switchRole("manager")');
  expect(settings).toContain('switchRole("worker")');
  expect(settings).toContain("lane workers");
  expect(settings).toContain("no runs — dispatch from board chat or `kanban worker run`");
  expect(settings).toContain("void agents.loadWorkers()");
  expect(settings).toContain("firstLine(run.summary)");

  const store = read("web/src/lib/agents.svelte.ts");
  expect(store).toContain('export type SettingsRole = AgentRole | "manager" | "worker"');
  expect(store).toContain("manager: agents.data.manager ?? {}");
  expect(store).toContain("worker: agents.data.worker ?? {}");
  expect(store).toContain("api.workers.get()");
});
