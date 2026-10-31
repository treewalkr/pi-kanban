import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { board } from "../web/src/lib/board.svelte";
import type { Lane, Task } from "../src/db";

function mockStorage(): Map<string, string> {
  const map = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => map.set(k, String(v)),
    removeItem: (k: string) => map.delete(k),
    clear: () => map.clear(),
  };
  return map;
}

/** Minimal /board + /stats fetch stub so refresh() resolves with one task. */
function stubBoardFetch(task: Task) {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/stats") return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    if (pathname === "/board") {
      return new Response(
        JSON.stringify({
          lanes: [makeLane("backlog", "Backlog")],
          tasks: board.tasks,
          plans: {},
          waiting: {},
          blockedBy: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  };
}

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



test("board.addBlocker PATCHes the full new set, refreshes, and flips isBlocked", async () => {
  const originalFetch = globalThis.fetch;
  const subject = makeTask({ id: "t-sub", title: "subject card", laneId: "backlog" });
  const existing = makeTask({ id: "t-old", title: "existing blocker", laneId: "backlog" });
  const added = makeTask({ id: "t-new", title: "new blocker", laneId: "plan" });
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;

  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "PATCH") {
        capturedUrl = url;
        capturedInit = init;
        return new Response(JSON.stringify(subject), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (new URL(url).pathname === "/board") {
        return new Response(
          JSON.stringify({
            lanes: [makeLane("backlog", "Backlog"), makeLane("plan", "Plan")],
            tasks: [subject, existing, added],
            plans: {},
            waiting: {},
            blockedBy: { "t-sub": ["t-old", "t-new"] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }) as typeof fetch;

    board.lanes = [makeLane("backlog", "Backlog"), makeLane("plan", "Plan")];
    board.tasks = [subject, existing, added];
    board.blockedBy = { "t-sub": ["t-old"] };
    board.error = "";

    const err = await board.addBlocker("t-sub", "t-new");

    expect(err).toBeNull();
    expect(new URL(capturedUrl!).pathname).toBe("/tasks/t-sub");
    expect(capturedInit?.method).toBe("PATCH");
    expect(JSON.parse(capturedInit?.body as string)).toEqual({ blockedBy: ["t-old", "t-new"] });

    // the refreshed board payload lands: the edge exists and the card is blocked
    expect(board.blockedBy["t-sub"]).toEqual(["t-old", "t-new"]);
    expect(board.isBlocked("t-sub")).toBe(true);
    expect(board.error).toBe("");
  } finally {
    globalThis.fetch = originalFetch;
    board.lanes = [];
    board.tasks = [];
    board.blockedBy = {};
  }
});

test("board.removeBlocker PATCHes the remaining set and clears the blocked state", async () => {
  const originalFetch = globalThis.fetch;
  const subject = makeTask({ id: "t-sub", title: "subject card", laneId: "backlog" });
  const blocker = makeTask({ id: "t-blk", title: "the blocker", laneId: "backlog" });
  const other = makeTask({ id: "t-oth", title: "stays", laneId: "done" });
  let capturedInit: RequestInit | undefined;

  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "PATCH") {
        capturedInit = init;
        return new Response(JSON.stringify(subject), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (new URL(url).pathname === "/board") {
        return new Response(
          JSON.stringify({
            lanes: [makeLane("backlog", "Backlog"), makeLane("done", "Done")],
            tasks: [subject, blocker, other],
            plans: {},
            waiting: {},
            blockedBy: { "t-sub": ["t-oth"] },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }) as typeof fetch;

    board.lanes = [makeLane("backlog", "Backlog"), makeLane("done", "Done")];
    board.tasks = [subject, blocker, other];
    board.blockedBy = { "t-sub": ["t-blk", "t-oth"] };
    expect(board.isBlocked("t-sub")).toBe(true); // t-blk is outside done/archive

    const err = await board.removeBlocker("t-sub", "t-blk");

    expect(err).toBeNull();
    expect(JSON.parse(capturedInit?.body as string)).toEqual({ blockedBy: ["t-oth"] });

    // remaining edge points at a done card, so the card is no longer blocked
    expect(board.blockedBy["t-sub"]).toEqual(["t-oth"]);
    expect(board.isBlocked("t-sub")).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
    board.lanes = [];
    board.tasks = [];
    board.blockedBy = {};
  }
});

test("blocker mutations return the 409/404 message inline, never board.error", async () => {
  const originalFetch = globalThis.fetch;
  const subject = makeTask({ id: "t-sub", title: "subject card", laneId: "backlog" });
  const cycleMsg = "dependency cycle detected: card 't-sub' cannot be blocked by 't-dep'";
  let patchCalls = 0;
  let boardCalls = 0;

  try {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "PATCH") {
        patchCalls++;
        return new Response(JSON.stringify({ error: cycleMsg, code: "conflict" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      if (new URL(url).pathname === "/board") {
        boardCalls++;
        return new Response(JSON.stringify({ lanes: [], tasks: [subject], plans: {}, waiting: {}, blockedBy: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    }) as typeof fetch;

    board.tasks = [subject];
    board.blockedBy = {};
    board.error = "";

    // 409 cycle: message comes back for inline rendering; the global bar stays empty
    expect(await board.addBlocker("t-sub", "t-dep")).toBe(cycleMsg);
    expect(board.error).toBe("");
    expect(boardCalls).toBe(0); // a failed write refreshes nothing

    // 409 on remove too: the edge is present locally, so the PATCH goes out and fails
    board.blockedBy = { "t-sub": ["t-dep"] };
    expect(await board.removeBlocker("t-sub", "t-dep")).toBe(cycleMsg);

    // no-op add (already a blocker) and no-op remove (absent) never PATCH
    const callsAfterFirst = patchCalls;
    expect(await board.addBlocker("t-sub", "t-dep")).toBeNull();
    board.blockedBy = {};
    expect(await board.removeBlocker("t-sub", "t-dep")).toBeNull();
    expect(patchCalls).toBe(callsAfterFirst);
  } finally {
    globalThis.fetch = originalFetch;
    board.tasks = [];
    board.blockedBy = {};
    board.error = "";
  }
});

test("tags derived: distinct, sorted, from all cards", () => {
  board.tasks = [
    makeTask({ id: "t1", title: "a", laneId: "backlog", tags: ["ui", "review-loop"] }),
    makeTask({ id: "t2", title: "b", laneId: "plan", tags: ["ui", "quick-win"] }),
    makeTask({ id: "t3", title: "c", laneId: "archive", tags: ["old-stuff"] }),
  ];
  expect(board.tags).toEqual(["old-stuff", "quick-win", "review-loop", "ui"]);
});

test("matches(): tag filter is AND across active tags", () => {
  const tagged = makeTask({ id: "t1", title: "tagged", laneId: "backlog", tags: ["ui", "review-loop"] });
  const untagged = makeTask({ id: "t2", title: "untagged", laneId: "backlog" });
  board.tasks = [tagged, untagged];

  board.tagFilter = [];
  expect(board.matches(tagged)).toBe(true);
  expect(board.matches(untagged)).toBe(true);

  board.tagFilter = ["ui", "review-loop"];
  expect(board.matches(tagged)).toBe(true);
  expect(board.matches(untagged)).toBe(false);

  board.tagFilter = ["ui", "x"];
  expect(board.matches(tagged)).toBe(false);
});

test("tagFilter persists to kanban-tags; empty clears the key", () => {
  const storage = mockStorage();
  try {
    board.tagFilter = ["review-loop", "ui", "ui"];
    expect(board.tagFilter).toEqual(["review-loop", "ui"]); // sorted-unique
    expect(storage.get("kanban-tags")).toBe(JSON.stringify(["review-loop", "ui"]));

    board.tagFilter = [];
    expect(board.tagFilter).toEqual([]);
    expect(storage.has("kanban-tags")).toBe(false);
  } finally {
    board.tagFilter = [];
    delete (globalThis as any).localStorage;
  }
});

test("refresh() prunes stale stored tags and keeps live ones", async () => {
  const storage = mockStorage();
  const originalFetch = globalThis.fetch;
  const task = makeTask({ id: "t1", title: "card", laneId: "backlog", tags: ["ui"] });
  globalThis.fetch = stubBoardFetch(task) as typeof fetch;
  try {
    board.tasks = [task];
    storage.set("kanban-tags", JSON.stringify(["ui", "dead"]));
    board.tagFilter = ["ui", "dead"];
    await board.refresh();
    expect(board.tagFilter).toEqual(["ui"]);
    expect(storage.get("kanban-tags")).toBe(JSON.stringify(["ui"]));

    // all-stale → filter empties and the key is removed
    board.tasks = [makeTask({ id: "t2", title: "card 2", laneId: "backlog", tags: [] })];
    board.tagFilter = ["ui"];
    await board.refresh();
    expect(board.tagFilter).toEqual([]);
    expect(storage.has("kanban-tags")).toBe(false);
  } finally {
    board.tagFilter = [];
    board.tasks = [];
    globalThis.fetch = originalFetch;
    delete (globalThis as any).localStorage;
  }
});

test("tag filter hides empty lanes and scopes activeCount", () => {
  board.lanes = [
    makeLane("backlog", "Backlog"),
    makeLane("plan", "Plan"),
    makeLane("done", "Done"),
    makeLane("archive", "Archive"),
  ];
  board.tasks = [
    makeTask({ id: "t1", title: "ui backlog", laneId: "backlog", tags: ["ui"] }),
    makeTask({ id: "t2", title: "plain plan", laneId: "plan" }),
    makeTask({ id: "t3", title: "ui done", laneId: "done", tags: ["ui"] }),
    makeTask({ id: "t4", title: "ui archived", laneId: "archive", tags: ["ui"] }),
  ];

  board.tagFilter = ["ui"];
  expect(board.visibleLanes.map((v) => v.lane.id)).toEqual(["backlog", "done", "archive"]);
  expect(board.activeCount).toBe(2); // archive excluded

  board.tagFilter = [];
  expect(board.visibleLanes.map((v) => v.lane.id)).toEqual(["backlog", "plan", "done", "archive"]);
  expect(board.activeCount).toBe(3);
});

test("matches(): text filter string includes tags", () => {
  const tagged = makeTask({ id: "t1", title: "polish the header", laneId: "backlog", tags: ["review-loop"] });
  board.tasks = [tagged];
  board.search = "review-loop";
  expect(board.visibleTasks("backlog").map((t) => t.id)).toEqual(["t1"]);
  board.search = "review-loo";
  expect(board.visibleTasks("backlog").length).toBe(1); // substring still matches
  board.search = "zzz";
  expect(board.visibleTasks("backlog").length).toBe(0);
});
