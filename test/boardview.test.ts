import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { board } from "../web/src/lib/board.svelte";
import type { Lane, Task } from "../src/db";

function makeLane(id: string, name: string): Lane {
  return {
    id,
    name,
    description: "",
    position: 0,
    fixed: 0,
  };
}

function makeTask(partial: Partial<Task> & { id: string; title: string; laneId: string }): Task {
  return {
    note: "",
    project: "",
    tags: [],
    parentId: null,
    previousLane: null,
    workspace: null,
    priority: "normal",
    position: 100,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

describe("boardview store focus mode", () => {
  let replaceStateCalls: Array<[any, string, string]> = [];
  let storageMap: Map<string, string>;
  const originalHistory = (globalThis as any).history;
  const originalStorage = (globalThis as any).localStorage;

  beforeEach(() => {
    replaceStateCalls = [];
    storageMap = new Map();

    (globalThis as any).localStorage = {
      getItem: (k: string) => storageMap.get(k) ?? null,
      setItem: (k: string, v: string) => storageMap.set(k, String(v)),
      removeItem: (k: string) => storageMap.delete(k),
      clear: () => storageMap.clear(),
    };

    (globalThis as any).history = {
      replaceState: (state: any, unused: string, url: string) => {
        replaceStateCalls.push([state, unused, url]);
      },
    };

    if (typeof window !== "undefined" && window.location) {
      (window.location as any).hash = "";
    }

    board.tasks = [];
    board.lanes = [];
    board.projectFilter = "";
    board.search = "";
    board.expanded = new Set();
    replaceStateCalls = [];
  });

  afterEach(() => {
    board.tasks = [];
    board.lanes = [];
    board.projectFilter = "";
    board.search = "";
    board.expanded = new Set();

    if (typeof window !== "undefined" && window.location) {
      (window.location as any).hash = "";
    }
    if (originalHistory !== undefined) {
      (globalThis as any).history = originalHistory;
    } else {
      delete (globalThis as any).history;
    }
    if (originalStorage !== undefined) {
      (globalThis as any).localStorage = originalStorage;
    } else {
      delete (globalThis as any).localStorage;
    }
  });

  test("projectFilter setter syncs the hash via replaceState and clears it", () => {
    board.projectFilter = "web";
    expect(replaceStateCalls.length).toBe(1);
    expect(replaceStateCalls[0][2].endsWith("#project=web")).toBe(true);
    expect(localStorage.getItem("kanban-project")).toBe("web");

    board.projectFilter = "";
    expect(replaceStateCalls.length).toBe(2);
    expect(replaceStateCalls[1][2].includes("#")).toBe(false);
    expect(localStorage.getItem("kanban-project")).toBeNull();
  });

  test("applyProjectHash follows pasted hashes and clears on non-project hash", () => {
    (window.location as any).hash = "#project=web";
    board.applyProjectHash();
    expect(board.projectFilter).toBe("web");

    (window.location as any).hash = "#foo";
    board.applyProjectHash();
    expect(board.projectFilter).toBe("");

    replaceStateCalls = [];
    (window.location as any).hash = "";
    board.applyProjectHash();
    expect(replaceStateCalls.length).toBe(0);

    // hash equal to current filter → no replaceState call
    board.projectFilter = "web";
    replaceStateCalls = [];
    (window.location as any).hash = "#project=web";
    board.applyProjectHash();
    expect(replaceStateCalls.length).toBe(0);
  });

  test("focus hides lanes with no visible cards, keeps true ordinals", () => {
    board.lanes = [
      makeLane("backlog", "Backlog"),
      makeLane("plan", "Plan"),
      makeLane("implement", "Implement"),
      makeLane("done", "Done"),
    ];
    board.tasks = [
      makeTask({ id: "t1", title: "card 1", laneId: "backlog", project: "web" }),
      makeTask({ id: "t2", title: "card 2", laneId: "plan", project: "api" }),
      makeTask({ id: "t3", title: "card 3", laneId: "done", project: "web" }),
    ];

    board.projectFilter = "web";
    expect(board.visibleLanes.map((v) => v.lane.id)).toEqual(["backlog", "done"]);
    expect(board.visibleLanes.map((v) => v.index)).toEqual([0, 3]);

    board.projectFilter = "";
    expect(board.visibleLanes.map((v) => v.lane.id)).toEqual(["backlog", "plan", "implement", "done"]);
    expect(board.visibleLanes.map((v) => v.index)).toEqual([0, 1, 2, 3]);
  });

  test("archive strip hides while focused unless the project has archived cards", () => {
    board.lanes = [
      makeLane("backlog", "Backlog"),
      makeLane("done", "Done"),
      makeLane("archive", "Archive"),
    ];
    board.tasks = [
      makeTask({ id: "t1", title: "card 1", laneId: "backlog", project: "web" }),
      makeTask({ id: "t2", title: "archived api card", laneId: "archive", project: "api" }),
    ];

    board.projectFilter = "web";
    expect(board.visibleLanes.map((v) => v.lane.id)).toEqual(["backlog"]);

    board.tasks = [
      ...board.tasks,
      makeTask({ id: "t3", title: "archived web card", laneId: "archive", project: "web" }),
    ];
    expect(board.visibleLanes.map((v) => v.lane.id)).toEqual(["backlog", "archive"]);
    expect(board.visibleLanes[1].index).toBe(2);
  });

  test("unfocusing restores the full board; header count scopes to the project", () => {
    board.lanes = [
      makeLane("backlog", "Backlog"),
      makeLane("plan", "Plan"),
      makeLane("done", "Done"),
      makeLane("archive", "Archive"),
    ];
    board.tasks = [
      makeTask({ id: "t1", title: "web 1", laneId: "backlog", project: "web" }),
      makeTask({ id: "t2", title: "web 2", laneId: "done", project: "web" }),
      makeTask({ id: "t3", title: "api 1", laneId: "plan", project: "api" }),
      makeTask({ id: "t4", title: "archived web", laneId: "archive", project: "web" }),
    ];

    board.projectFilter = "web";
    expect(board.visibleLanes.map((v) => v.lane.id)).toEqual(["backlog", "done", "archive"]);
    expect(board.activeCount).toBe(2);

    board.projectFilter = "";
    expect(board.visibleLanes.map((v) => v.lane.id)).toEqual(["backlog", "plan", "done", "archive"]);
    expect(board.activeCount).toBe(3);
  });
});

test("board.moveTask PATCHes the lane change and refreshes from /board", async () => {
  const originalFetch = globalThis.fetch;
  const task = makeTask({ id: "t-backlog", title: "card in backlog", laneId: "backlog" });
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;

  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (method === "PATCH") {
        capturedUrl = url;
        capturedInit = init;
        return new Response(JSON.stringify({ ...task, laneId: "plan" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (new URL(url).pathname === "/board") {
        return new Response(
          JSON.stringify({
            lanes: [makeLane("backlog", "Backlog"), makeLane("plan", "Plan")],
            tasks: [{ ...task, laneId: "plan" }],
            plans: {},
            waiting: {},
            blockedBy: {},
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }) as typeof fetch;

    board.lanes = [makeLane("backlog", "Backlog"), makeLane("plan", "Plan")];
    board.tasks = [task];
    board.projectFilter = "";
    board.search = "";

    await board.moveTask(task.id, "plan");

    expect(capturedUrl).toBeDefined();
    expect(new URL(capturedUrl!).pathname).toBe("/tasks/" + task.id);
    expect(capturedInit?.method).toBe("PATCH");
    expect(JSON.parse(capturedInit?.body as string)).toEqual({ lane: "plan" });

    expect(board.visibleTasks("plan").map((t) => t.id)).toContain(task.id);
  } finally {
    globalThis.fetch = originalFetch;
    board.lanes = [];
    board.tasks = [];
  }
});

test("board.elaborate POSTs to /tasks/:id/elaborate then polls activity and refreshes", async () => {
  const originalFetch = globalThis.fetch;
  const task = makeTask({ id: "t-1", title: "card 1", laneId: "backlog" });
  const capturedUrls: string[] = [];

  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const pathname = new URL(url).pathname;
      const method = init?.method ?? "GET";
      capturedUrls.push(`${method} ${pathname}`);

      if (method === "POST" && pathname === `/tasks/${task.id}/elaborate`) {
        return new Response(JSON.stringify({ taskId: task.id }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }

      if (pathname === "/activity") {
        return new Response(JSON.stringify({ sessions: [], queued: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (pathname === "/board") {
        return new Response(
          JSON.stringify({
            lanes: [makeLane("backlog", "Backlog")],
            tasks: [task],
            plans: {},
            waiting: {},
            blockedBy: {},
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    board.lanes = [makeLane("backlog", "Backlog")];
    board.tasks = [];
    board.error = "previous error";

    await board.elaborate(task.id);

    expect(capturedUrls).toContain(`POST /tasks/${task.id}/elaborate`);
    expect(capturedUrls).toContain("GET /activity");
    expect(capturedUrls).toContain("GET /board");
    expect(board.error).toBe("");
    expect(board.tasks).toEqual([task]);

    // a 404 response sets board.error to the payload's error
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const pathname = new URL(url).pathname;
      const method = init?.method ?? "GET";
      if (method === "POST" && pathname === "/tasks/nonexistent/elaborate") {
        return new Response(JSON.stringify({ error: "no task matching 'nonexistent'", code: "not-found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    await board.elaborate("nonexistent");
    expect(board.error).toBe("no task matching 'nonexistent'");
  } finally {
    globalThis.fetch = originalFetch;
    board.lanes = [];
    board.tasks = [];
    board.error = "";
  }
});


