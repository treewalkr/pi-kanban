import { describe, expect, test } from "bun:test";
import type { Attachment, Lane, Task } from "../src/db";
import { laneCrumb, PALETTE_MAX, paletteItems, type PaletteInput } from "../web/src/lib/palette";

function task(partial: Partial<Task> & { id: string; title: string }): Task {
  return {
    note: "",
    laneId: "backlog",
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

function lane(partial: Partial<Lane> & { id: string; name: string }): Lane {
  return { description: "", position: 100, fixed: 0, wipLimit: null, ...partial };
}

const LANES = [
  lane({ id: "waiting", name: "Waiting on you", fixed: 1 }),
  lane({ id: "backlog", name: "Backlog", fixed: 1 }),
  lane({ id: "implement", name: "Test + Implement" }),
  lane({ id: "done", name: "Done", fixed: 1 }),
  lane({ id: "archive", name: "Archive", fixed: 1 }),
];

function input(partial: Partial<PaletteInput> = {}): PaletteInput {
  return {
    query: "",
    tasks: [],
    plans: {},
    projects: [],
    projectFilter: "",
    lanes: LANES,
    archiveOpen: false,
    ...partial,
  };
}

describe("palette model", () => {
  test("blank query lists all-projects, projects, then lane actions in board order", () => {
    const tasks = [
      task({ id: "aa1", title: "first", laneId: "waiting" }),
      task({ id: "aa2", title: "second", laneId: "waiting" }),
      task({ id: "aa3", title: "third", laneId: "implement" }),
    ];
    const items = paletteItems(input({ tasks, projects: ["beta", "kanban"], projectFilter: "kanban" }));

    expect(items.filter((i) => i.kind === "card")).toEqual([]); // no card items on blank query
    // all-projects first, then projects in given order
    expect(items.slice(0, 3).map((i) => i.label)).toEqual(["all projects", "~/beta", "~/kanban"]);
    expect(items.slice(0, 3).map((i) => i.action)).toEqual([
      { type: "project", name: "" },
      { type: "project", name: "beta" },
      { type: "project", name: "kanban" },
    ]);
    // then lane actions in board order: waiting (go only, index 0), backlog (go, left, right), …
    expect(items.slice(3).map((i) => i.label)).toEqual([
      "go to Waiting on you",
      "move Waiting on you right",
      "go to Backlog",
      "move Backlog left",
      "move Backlog right",
      "go to Test + Implement",
      "move Test + Implement left",
      "move Test + Implement right",
      "go to Done",
      "move Done left",
      "move Done right",
      "go to Archive",
      "move Archive left",
      "expand archive",
    ]);
    // detail column: current vs switch, card counts
    expect(items[0]!.detail).toBe("switch"); // "" !== projectFilter "kanban"
    expect(items[2]!.detail).toBe("current"); // ~/kanban is the active filter
    expect(items[1]!.detail).toBe("switch");
    expect(items[3]!.detail).toBe("2 cards");
    expect(items[8]!.detail).toBe("1 cards");
    expect(items[4]!.detail).toBe("lane");
  });

  test("project items: ~/{name} labels, current marker, all-projects item", () => {
    const items = paletteItems(
      input({ projects: ["kanban"], projectFilter: "kanban", query: "kan" }),
    );
    const project = items.find((i) => i.action.type === "project" && i.action.name === "kanban")!;
    expect(project.label).toBe("~/kanban");
    expect(project.detail).toBe("current");
    expect(project.score).toBe(75); // "~/kanban" does not start with "kan", but includes it
  });

  test("all-projects item is searchable by its label", () => {
    const items = paletteItems(input({ query: "all" }));
    expect(items.map((i) => i.label)).toEqual(["all projects"]);
    expect(items[0]!.action).toEqual({ type: "project", name: "" });
    expect(items[0]!.score).toBe(95); // "all projects".startsWith("all")
  });

  test("card items reuse searchBoard ranking; jump action carries the task id", () => {
    const tasks = [
      task({ id: "zz9", title: "fix login" }),
      task({ id: "lo3", title: "login page flows" }),
      task({ id: "log1", title: "unrelated", note: "the login service config" }),
    ];
    const plans: Record<string, Attachment> = {
      pl1: { id: "p1", taskId: "pl1", kind: "plan", version: 1, content: "rotate login tokens", source: "/tmp/p.md", createdAt: 1 },
    };
    tasks.push(task({ id: "pl1", title: "plan card" }));

    const items = paletteItems(input({ tasks, plans, query: "login" }));
    const cards = items.filter((i) => i.kind === "card");
    // searchBoard order: title prefix (100) > title includes (80) > note includes (40) > plan (35)
    expect(cards.map((i) => i.action)).toEqual([
      { type: "jump", taskId: "lo3" },
      { type: "jump", taskId: "zz9" },
      { type: "jump", taskId: "log1" },
      { type: "jump", taskId: "pl1" },
    ]);
    expect(cards[0]!.label).toBe("login page flows"); // label = matched text
    expect(cards[0]!.detail).toBe("Backlog"); // lane crumb
    expect(cards.map((i) => i.score)).toEqual([100, 80, 40, 35]);
  });

  test("ranking: card title prefix > project prefix > lane startsWith > card body includes", () => {
    const tasks = [
      task({ id: "ra1", title: "revamp search" }), // card title prefix "rev" → 100
      task({ id: "rb1", title: "other", note: "preview backup" }), // note includes "rev" → 40
    ];
    const items = paletteItems(
      input({ tasks, projects: ["review"], lanes: [lane({ id: "review", name: "Review" })], query: "rev" }),
    );
    expect(items.map((i) => `${i.kind}:${i.label}:${i.score}`)).toEqual([
      "card:revamp search:100",
      "project:~/review:75", // "~/review" includes "rev"
      "lane:go to Review:70", // "go to review" includes "rev"; single lane → no move items
      "card:preview backup:40",
    ]);
  });

  test("project startsWith outranks includes", () => {
    const items = paletteItems(input({ projects: ["review"], query: "~/rev" }));
    expect(items.map((i) => i.label)).toEqual(["~/review"]);
    expect(items[0]!.score).toBe(95);
  });

  test("non-matching project and lane items are dropped", () => {
    const items = paletteItems(
      input({ projects: ["kanban"], lanes: [lane({ id: "backlog", name: "Backlog" })], query: "zzz" }),
    );
    expect(items).toEqual([]);
  });

  test("sort tie-breaks: kind order then label codepoint asc", () => {
    // two cards both score 80 (title includes), two lanes both score 70 (includes)
    const tasks = [
      task({ id: "b1", title: "zz beta card" }),
      task({ id: "a1", title: "alpha card" }),
    ];
    const items = paletteItems(
      input({ tasks, lanes: [lane({ id: "l1", name: "card lane z" }), lane({ id: "l2", name: "card lane a" })], query: "card" }),
    );
    expect(items.map((i) => i.label)).toEqual([
      "alpha card", // 80, label asc
      "zz beta card", // 80
      "go to card lane a", // 70, label asc
      "go to card lane z", // 70
      "move card lane a left", // 70 — lane 1 of 2: left only
      "move card lane z right", // 70 — lane 0 of 2: right only
    ]);
  });

  test("lane move items exist only where the lane can move", () => {
    const items = paletteItems(input({ query: "" }));
    const moves = items.filter((i) => i.action.type === "lane-move");
    // first lane: move-right only; last lane: move-left only
    expect(moves.filter((m) => m.action.laneId === "waiting").map((m) => m.action.dir)).toEqual([1]);
    expect(moves.filter((m) => m.action.laneId === "archive").map((m) => m.action.dir)).toEqual([-1]);
    expect(moves.filter((m) => m.action.type === "lane-move" && m.action.laneId === "backlog").map((m) => m.action)).toEqual([
      { type: "lane-move", laneId: "backlog", dir: -1 },
      { type: "lane-move", laneId: "backlog", dir: 1 },
    ]);
  });

  test("archive toggle only on the archive lane, label flips with archiveOpen", () => {
    const closed = paletteItems(input({ archiveOpen: false }));
    const open = paletteItems(input({ archiveOpen: true }));
    const archiveItems = closed.filter((i) => i.action.type === "archive-toggle");
    expect(archiveItems.length).toBe(1);
    expect(archiveItems[0]!.label).toBe("expand archive");
    expect(archiveItems[0]!.action).toEqual({ type: "archive-toggle", open: true });
    expect(open.find((i) => i.action.type === "archive-toggle")!.label).toBe("collapse archive");
    // non-archive lanes never emit an archive item: count go items = lanes count
    expect(closed.filter((i) => i.action.type === "lane-go").length).toBe(LANES.length);
  });

  test("caps the blank-query list at PALETTE_MAX = 20", () => {
    const many = Array.from({ length: 12 }, (_, i) => lane({ id: `l${i}`, name: `Lane ${i}` }));
    const items = paletteItems(input({ lanes: many, projects: ["p1", "p2", "p3"] }));
    expect(PALETTE_MAX).toBe(20);
    expect(items.length).toBe(20);
  });
});

describe("laneCrumb", () => {
  const lanes = [lane({ id: "doing", name: "Doing" })];
  const epic = task({ id: "e1", title: "auth epic" });
  const story = task({ id: "s1", title: "token story", parentId: "e1", laneId: "doing" });
  const subtask = task({ id: "t1", title: "refresh subtask", parentId: "s1", laneId: "doing" });

  test("joins lane name and ancestor titles with ' · '", () => {
    expect(laneCrumb([epic, story, subtask], lanes, "t1")).toBe("Doing · auth epic · token story");
  });

  test("returns just the lane for a root task, lane-id fallback, '' for unknown task", () => {
    // epic sits in "backlog" (fixture default) which is not in `lanes` → falls back to the lane id
    expect(laneCrumb([epic], lanes, "e1")).toBe("backlog");
    const inDoing = task({ id: "r1", title: "root", laneId: "doing" });
    expect(laneCrumb([inDoing], lanes, "r1")).toBe("Doing");
    expect(laneCrumb([inDoing], lanes, "nope")).toBe("");
  });
});
