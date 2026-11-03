import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { readFileSync } from "node:fs";
import { agents, DEBOUNCE_MS } from "../web/src/lib/agents.svelte";
import { board } from "../web/src/lib/board.svelte";
import type { AgentConfig } from "../src/db";

type FetchCall = { url: string; method: string; body?: unknown };

describe("agents auto-save store", () => {
  let calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  let putHandler: ((url: string, body: unknown) => Response | Promise<Response>) | null = null;

  beforeEach(() => {
    calls = [];
    putHandler = null;
    agents.open = false;
    agents.saveState = "idle";
    agents.loaded = false;
    agents.configs = {
      planner: {},
      reviewer: {},
      builder: {},
      "plan-reviewer": {},
      elaborator: {},
      manager: {},
      worker: {},
    };
    (agents as any).pending = null;
    (agents as any).inFlight = null;
    (agents as any).timer = null;
    (agents as any).wasFailed = false;
    (agents as any).editVersion = 0;
    (agents as any).inFlightVersion = 0;
    board.error = "";

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      let body: unknown;
      if (init?.body && typeof init.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      calls.push({ url, method, body });

      if (method === "PUT" && putHandler) {
        return await putHandler(url, body);
      }
      if (method === "PUT" && url.includes("/agents/")) {
        return new Response(JSON.stringify(body ?? {}), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    jest.useRealTimers();
    globalThis.fetch = originalFetch;
    if ((agents as any).timer) {
      clearTimeout((agents as any).timer);
      (agents as any).timer = null;
    }
  });

  test("schedule PUTs /agents/:role once after DEBOUNCE_MS with the edited config", async () => {
    jest.useFakeTimers();
    const config: AgentConfig = { model: "claude-3-7-sonnet", provider: "anthropic" };
    agents.schedule("reviewer", () => config);

    expect(calls.length).toBe(0);
    expect(agents.saveState).toBe("saving");

    jest.advanceTimersByTime(DEBOUNCE_MS);
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.length).toBe(1);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toContain("/agents/reviewer");
    expect(calls[0].body).toEqual(config);
    expect(agents.saveState).toBe("saved");
    expect(agents.configs.reviewer).toEqual(config);
  });

  test("rapid schedules coalesce into a single PUT with the latest config", async () => {
    jest.useFakeTimers();
    agents.schedule("reviewer", () => ({ model: "v1" }));
    jest.advanceTimersByTime(200);
    agents.schedule("reviewer", () => ({ model: "v2" }));
    jest.advanceTimersByTime(200);
    agents.schedule("reviewer", () => ({ model: "v3" }));

    expect(calls.length).toBe(0);

    jest.advanceTimersByTime(DEBOUNCE_MS);
    await Promise.resolve();
    await Promise.resolve();

    expect(calls.length).toBe(1);
    expect(calls[0].body).toEqual({ model: "v3" });
  });

  test("flush() PUTs immediately without waiting for the debounce", async () => {
    jest.useFakeTimers();
    agents.schedule("reviewer", () => ({ model: "immediate" }));
    expect(calls.length).toBe(0);

    const ok = await agents.flush();
    expect(ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].body).toEqual({ model: "immediate" });

    jest.advanceTimersByTime(DEBOUNCE_MS * 2);
    await Promise.resolve();
    expect(calls.length).toBe(1);
  });

  test("close() with nothing pending closes instantly and PUTs nothing", async () => {
    agents.open = true;
    agents.saveState = "idle";

    await agents.close();

    expect(calls.length).toBe(0);
    expect(agents.open).toBe(false);
    expect(agents.saveState).toBe("idle");
  });

  test("save failure: board.error toast set, state failed, pending re-armed", async () => {
    putHandler = () =>
      new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });

    agents.schedule("reviewer", () => ({ model: "fail-then-succeed" }));
    const ok1 = await agents.flush();

    expect(ok1).toBe(false);
    expect(board.error).toBe("boom");
    expect(agents.saveState).toBe("failed");

    // Clear failure handler for retry
    putHandler = null;
    const ok2 = await agents.flush();

    expect(ok2).toBe(true);
    expect(calls.length).toBe(2);
    expect(calls[1].body).toEqual({ model: "fail-then-succeed" });
    expect(board.error).toBe("");
    expect(agents.saveState).toBe("saved");
  });

  test("close() flushes pending edits and only closes on success", async () => {
    // Success case
    agents.open = true;
    agents.schedule("reviewer", () => ({ model: "close-success" }));
    const closePromise = agents.close();
    expect(agents.open).toBe(true);
    await closePromise;
    expect(calls.length).toBe(1);
    expect(calls[0].body).toEqual({ model: "close-success" });
    expect(agents.open).toBe(false);
    expect(agents.saveState).toBe("idle");

    // Failure case
    agents.open = true;
    putHandler = () =>
      new Response(JSON.stringify({ error: "close-boom" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    agents.schedule("reviewer", () => ({ model: "close-fail" }));
    await agents.close();
    expect(agents.open).toBe(true);
    expect(agents.saveState).toBe("failed");
    expect(board.error).toBe("close-boom");
  });

  test("close() awaits an in-flight save; failure keeps the modal open", async () => {
    // Failing variant: real timers, PUT delayed 20 ms, close called during flight
    agents.open = true;
    putHandler = async () => {
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    };

    agents.schedule("reviewer", () => ({ model: "fail" }));
    const flushPromise = agents.flush();

    await new Promise((r) => setTimeout(r, 10));
    expect(agents.open).toBe(true);

    const closePromise = agents.close();
    expect(agents.open).toBe(true);

    await closePromise;
    await flushPromise;

    expect(agents.open).toBe(true);
    expect(agents.saveState).toBe("failed");
    expect(board.error).toBe("boom");

    // Success variant closes
    board.error = "";
    putHandler = async () => {
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ model: "retry-ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const retryFlush = agents.flush();
    await new Promise((r) => setTimeout(r, 10));
    expect(agents.open).toBe(true);

    const retryClose = agents.close();
    await retryClose;
    await retryFlush;

    expect(agents.open).toBe(false);
    expect(agents.saveState).toBe("idle");
  });

  test("in-flight save then new edit: both persist, none lost", async () => {
    let resolveFirstPut!: () => void;
    let firstPutStarted = false;

    putHandler = async (_url, body) => {
      const b = body as { model?: string };
      if (b.model === "A") {
        firstPutStarted = true;
        await new Promise<void>((r) => {
          resolveFirstPut = r;
        });
        return new Response(JSON.stringify(b), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(b), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    agents.schedule("reviewer", () => ({ model: "A" }));
    const flightA = agents.flush();

    while (!firstPutStarted) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // Schedule B while A is in flight
    agents.schedule("reviewer", () => ({ model: "B" }));

    // Call flush()
    const flushB = agents.flush();

    // Release A
    resolveFirstPut();
    await flightA;
    await flushB;

    expect(calls.length).toBe(2);
    expect(calls[0].body).toEqual({ model: "A" });
    expect(calls[1].body).toEqual({ model: "B" });
    expect(agents.saveState).toBe("saved");
    expect(agents.configs.reviewer).toEqual({ model: "B" });
  });

  test("AgentsSettings markup: no save button; status and close live in the panel header", () => {
    const src = readFileSync(new URL("../web/src/lib/AgentsSettings.svelte", import.meta.url), "utf-8");
    const panel = readFileSync(new URL("../web/src/lib/SettingsPanel.svelte", import.meta.url), "utf-8");
    expect(src).not.toContain(">save</button>");
    expect(src).not.toContain("onclick={save}");
    // the 2,000px form's status line moved to the modal header (q8x8g)
    expect(src).not.toContain("save-status");
    expect(panel).toContain("settings-status");
    expect(panel).toContain("agents.close()");
    expect(src).toMatch(/await\s+agents\.flush\(\)[\s\S]*role\s*=\s*next/);
  });

  test("openLane opens the settings on the lane's workflow", () => {
    agents.openLane("design");
    expect(agents.open).toBe(true);
    expect(agents.section).toBe("agents");
    expect(agents.selectedLane).toBe("design");
    agents.open = false;
  });

  test("scheduleContext debounces PUT /lanes/:id/context and flush() carries it", async () => {
    jest.useFakeTimers();
    agents.openLane("design");
    const context = {
      actors: [{ id: "designer", author: "pi-designer", instructions: "Design {id}" }],
      triggers: [{ kind: "on-enter" as const }],
    };
    putHandler = (url, body) =>
      new Response(JSON.stringify({ laneId: "design", context: body }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    agents.scheduleContext("design", () => context);

    expect(calls.length).toBe(0);
    expect(agents.saveState).toBe("saving");

    jest.advanceTimersByTime(DEBOUNCE_MS);
    for (let i = 0; i < 10; i++) await Promise.resolve();

    const put = calls.find((c) => c.method === "PUT" && c.url.includes("/lanes/design/context"));
    expect(put).toBeDefined();
    expect(put!.body).toEqual(context);
    expect(agents.saveState).toBe("saved");
    expect(agents.laneContexts.design).toEqual(context);
    agents.open = false;
  });

  test("close() flushes a pending lane context before closing", async () => {
    agents.open = true;
    agents.laneContexts = {};
    const context = {
      actors: [{ id: "designer", author: "pi-designer", instructions: "v2" }],
      triggers: [{ kind: "on-enter" as const }],
    };
    agents.scheduleContext("design", () => context);
    await agents.close();
    expect(calls.some((c) => c.method === "PUT" && c.url.includes("/lanes/design/context"))).toBe(true);
    expect(agents.open).toBe(false);
  });

  test("AgentsSettings markup: lane selector, actor chain, and the lane context editor", () => {
    const src = readFileSync(new URL("../web/src/lib/AgentsSettings.svelte", import.meta.url), "utf-8");
    // the Lane bar lists the board's workflow lanes plus Board for the utility roles
    expect(src).toContain("workflowLanes");
    expect(src).toContain('selectLane("board")');
    // the actor chain selector switches between the lane's actors
    expect(src).toContain("switchRole(a.id)");
    // the context editor binds the plan-pinned fields
    expect(src).toContain("laneForm.author");
    expect(src).toContain("laneForm.instructions");
    expect(src).toContain("laneForm.artifact");
    expect(src).toContain("laneForm.template");
    expect(src).toContain("laneForm.onEnter");
    expect(src).toContain("laneForm.humanComment");
    expect(src).toContain("laneForm.approveTarget");
    expect(src).toContain("laneForm.cap");
    expect(src).toContain("laneForm.testGate");
    // custom lanes enable/clear their workflow
    expect(src).toContain("enableWorkflow");
    expect(src).toContain("disableWorkflow");
  });

  test("Lane.svelte wires the gear button to the lane's workflow settings", () => {
    const src = readFileSync(new URL("../web/src/lib/Lane.svelte", import.meta.url), "utf-8");
    expect(src).toContain('agents.openLane(lane.id)');
    expect(src).toContain('title="lane workflow settings"');
  });

  test("GeneralSettings theme wiring unchanged", () => {
    const src = readFileSync(new URL("../web/src/lib/GeneralSettings.svelte", import.meta.url), "utf-8");
    expect(src).toContain('setTheme("dark")');
    expect(src).toContain('setTheme("light")');
    expect(src).not.toContain("agents.save");
    expect(src).not.toContain("agents.flush");
    expect(src).not.toContain("agents.schedule");
  });
});
