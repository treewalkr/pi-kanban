import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chat } from "../web/src/lib/chat.svelte";
import { manager } from "../web/src/lib/manager.svelte";
import { chatEventsUrl, chatPathParam } from "../web/src/api";

// ── store behavior against the real chat store (fakes per chatview.test.ts) ──

let fetchCalls: Array<{ method: string; path: string; body?: unknown }> = [];
let persistedProject: string | null = null;
let registeredProjects: Array<{ name: string; repoPath: string | null; testGate: boolean; testCmd: string | null }> = [];
let prefsGetFails = false;
let prefsPutFails = false;

const route = (name: string) => ({ name, repoPath: null, testGate: true, testCmd: null });

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
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    fetchCalls.push({ method, path: url.pathname, body });
    if (url.pathname === "/chat-board") {
      if (method === "PUT") {
        if (prefsPutFails) return jsonResponse(500, { error: "nope", code: "conflict" });
        persistedProject = body?.project ?? null;
        return jsonResponse(200, { project: persistedProject });
      }
      if (prefsGetFails) return jsonResponse(500, { error: "nope", code: "conflict" });
      return jsonResponse(200, { project: persistedProject });
    }
    if (url.pathname === "/projects") return jsonResponse(200, { projects: registeredProjects });
    if (method === "POST" && url.pathname.startsWith("/chat/")) {
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
  persistedProject = null;
  registeredProjects = [];
  prefsGetFails = false;
  prefsPutFails = false;
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

test("drawer opens the persisted project scope and falls back when it vanished", async () => {
  registeredProjects = [route("alpha"), route("beta")];
  persistedProject = "alpha";

  await manager.toggle();
  expect(manager.project).toBe("alpha");
  expect(manager.handle).toBe("board:alpha");
  expect(chat.openCardId).toBe("board:alpha");
  expect(fetchCalls.some((c) => c.method === "GET" && c.path === "/chat-board")).toBe(true);
  expect(fetchCalls.some((c) => c.path === "/projects")).toBe(true);
  expect(fetchCalls.some((c) => c.path === "/chat/board:alpha")).toBe(true);

  // persisted project no longer registered → whole board
  manager.close();
  persistedProject = "ghost";
  await manager.toggle();
  expect(manager.project).toBeNull();
  expect(chat.openCardId).toBe("board");

  // prefs fetch failure → whole board, never a broken handle
  manager.close();
  prefsGetFails = true;
  await manager.toggle();
  expect(manager.project).toBeNull();
  expect(chat.openCardId).toBe("board");
});

test("switchTo PUTs the scope and reopens the handle", async () => {
  await manager.toggle();
  fetchCalls = [];

  await manager.switchTo("beta");
  expect(manager.project).toBe("beta");
  expect(manager.handle).toBe("board:beta");
  expect(chat.openCardId).toBe("board:beta");
  expect(fetchCalls.find((c) => c.method === "PUT" && c.path === "/chat-board")?.body).toEqual({ project: "beta" });
  expect(fetchCalls.some((c) => c.method === "GET" && c.path === "/chat/board:beta")).toBe(true);

  fetchCalls = [];
  await manager.switchTo(null);
  expect(manager.project).toBeNull();
  expect(chat.openCardId).toBe("board");
  expect(fetchCalls.find((c) => c.method === "PUT")?.body).toEqual({ project: null });

  // a failed PUT still switches the session
  prefsPutFails = true;
  await manager.switchTo("alpha");
  expect(manager.project).toBe("alpha");
  expect(chat.openCardId).toBe("board:alpha");
});

test("chat path URLs encode free-form project handles but keep the scope colon", () => {
  expect(chatPathParam("board")).toBe("board");
  expect(chatPathParam("board:alpha")).toBe("board:alpha");
  expect(chatPathParam("board:a/b c?d#e%f")).toBe("board:a%2Fb%20c%3Fd%23e%25f");
  expect(chatEventsUrl("board:a/b")).toContain("/chat/board:a%2Fb/events");
});

// ── source wiring (source-assertion pattern of blockers-ui.test.ts) ──────────

const read = (p: string): string => readFileSync(join(import.meta.dir, "..", p), "utf-8");

test("header view-toggle row carries the chat button wired to manager.toggle", () => {
  // the sidebar footer no longer has it — the button lives beside the view tabs
  const sidebar = read("web/src/lib/Sidebar.svelte");
  expect(sidebar).not.toContain("Board chat");
  const app = read("web/src/App.svelte");
  const toggleIdx = app.indexOf('class="view-toggle"');
  expect(toggleIdx).toBeGreaterThan(-1);
  const chatBtnIdx = app.indexOf('class="view-chat"');
  expect(chatBtnIdx).toBeGreaterThan(toggleIdx);
  expect(app.indexOf("void manager.toggle()", chatBtnIdx)).toBeGreaterThan(chatBtnIdx);
  // stable accessible name for the drawer opener (manager-chat e2e targets it;
  // aria-label matches the drawer dialog's label, not the visible "chat" text)
  expect(app.slice(chatBtnIdx - 200, chatBtnIdx + 400)).toContain('aria-label="board chat"');
  const css = read("web/src/app.css");
  expect(css).toMatch(/\.view-chat\s*{/);
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
  // Escape: full view collapses first, the second Escape closes (chat.expanded flag)
  expect(drawer).toContain('if (chat.expanded) chat.expanded = false; else manager.close();');
  // the drawer widens for full view instead of the panel overlaying
  expect(drawer).toContain('class:expanded={chat.expanded}');
  // + new session picker: the scope chip, the checked rows, and the switch call
  expect(drawer).toContain('aria-label="new board chat session"');
  expect(drawer).toContain('role="menuitemradio"');
  expect(drawer).toContain("none (whole board)");
  expect(drawer).toContain("manager.switchTo(scope)");
  expect(drawer).toContain("class=\"manager-project\"");
  const css = read("web/src/app.css");
  expect(css).toMatch(/\.manager-backdrop\s*{[^}]*justify-content: flex-end;/s);
  expect(css).toMatch(/\.manager-drawer\.expanded\s*{[^}]*width:/s);
  expect(css).toMatch(/\.manager-project\s*{/);
  expect(css).toMatch(/\.manager-new\s*{/);
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
