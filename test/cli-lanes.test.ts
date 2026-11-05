import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KanbanDb, type Task } from "../src/db";
import { applyServeEnv, parse } from "../src/cli";
import { cli, cliIn, dbFile, dir, root, useCliDb } from "./cli.helpers";

useCliDb();

test("lane mv reorders before a ref or last; usage error; fixed lane refused", async () => {
  const mvDb = join(dir, "lane-mv.db");
  const run = (...args: string[]) => {
    const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
      cwd: root,
      env: { ...process.env, KANBAN_DB: mvDb, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).then(([stdout, stderr, code]) => ({ stdout, stderr, code }));
  };
  const order = async (): Promise<string[]> =>
    ((JSON.parse((await run("lane", "ls", "--json")).stdout) as Array<{ id: string }>)).map((l) => l.id);

  const before = await run("lane", "mv", "review", "before:implement");
  expect(before.code).toBe(0);
  expect(before.stdout).toContain("review  moved before implement");
  expect(await order()).toEqual(["waiting", "backlog", "epics", "plan", "review", "implement", "done", "archive"]);

  const last = await run("lane", "mv", "review", "last");
  expect(last.code).toBe(0);
  expect(last.stdout).toContain("review  moved last");
  expect((await order()).at(-1)).toBe("review");

  const usage = await run("lane", "mv", "review");
  expect(usage.code).not.toBe(0);
  expect(usage.stderr).toContain("usage: kanban lane mv <ref> <before:<ref>|last>");

  const badFlag = await run("lane", "mv", "review", "plan");
  expect(badFlag.code).not.toBe(0);
  expect(badFlag.stderr).toContain("usage: kanban lane mv");

  const fixed = await run("lane", "mv", "waiting", "last");
  expect(fixed.code).not.toBe(0);
  expect(fixed.stderr).toContain("is fixed and cannot be reordered");
});

test("lane limit sets, shows in lane ls, clears with off", async () => {
  const wipDb = join(dir, "lane-limit.db");
  const run = (...args: string[]) => {
    const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
      cwd: root,
      env: { ...process.env, KANBAN_DB: wipDb, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).then(([stdout, stderr, code]) => ({ stdout, stderr, code }));
  };

  const set = await run("lane", "limit", "impl", "2");
  expect(set.code).toBe(0);
  expect(set.stdout).toContain("implement  wip limit 2");

  await run("add", "limit-a", "--lane", "implement");
  await run("add", "limit-b", "--lane", "implement");
  const ls = await run("lane", "ls");
  expect(ls.stdout).toMatch(/implement.*2\/2/);

  const off = await run("lane", "limit", "impl", "off");
  expect(off.code).toBe(0);
  expect(off.stdout).toContain("implement  wip limit cleared");
  const lsAfter = await run("lane", "ls");
  expect(lsAfter.stdout).toMatch(/Test \+ Implement \(implement\)\s+2\b/);
  expect(lsAfter.stdout).not.toContain("2/2");

  for (const bad of [["0"], ["abc"], []] as const) {
    const res = await run("lane", "limit", "impl", ...bad);
    expect(res.code).toBe(1);
  }
  expect((await run("lane", "limit", "impl", "0")).stderr).toContain("wip limit must be an integer from 1 to 999 (or 'off' to clear)");
  expect((await run("lane", "limit", "impl")).stderr).toContain("usage: kanban lane limit <ref> <n|off>");

  const badSub = await run("lane", "badsub");
  expect(badSub.code).toBe(1);
  expect(badSub.stderr).toContain("limit");
});

test("approve into an over-limit Implement warns but still succeeds", async () => {
  const gateDb = join(dir, "wip-approve.db");
  const run = (...args: string[]) => {
    const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
      cwd: root,
      env: { ...process.env, KANBAN_DB: gateDb, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).then(([stdout, stderr, code]) => ({ stdout, stderr, code }));
  };

  await run("lane", "limit", "impl", "1");
  // card B already in implement (occupies the 1 slot)
  await run("add", "already-building", "--lane", "implement");
  // card A: plan-gate ready (mv to plan + attach plan)
  const a = JSON.parse((await run("add", "gate-card", "--lane", "plan", "--json")).stdout) as Task;
  const planPath = join(dir, "gate-plan.md");
  writeFileSync(planPath, "# Gate plan");
  const attached = await run("attach", a.id, planPath);
  expect(attached.code).toBe(0);

  const res = await run("approve", a.id);
  expect(res.code).toBe(0);
  expect(res.stdout).toContain("→ Test + Implement");
  expect(res.stdout).toContain("⚠ implement over WIP limit: 2/1");

  const shown = JSON.parse((await run("show", a.id, "--json")).stdout) as Task;
  expect(shown.laneId).toBe("implement");
});

test("check prints wip-over-limit, JSON carries it, exit stays 0", async () => {
  const checkDb = join(dir, "wip-check.db");
  const run = (...args: string[]) => {
    const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
      cwd: root,
      env: { ...process.env, KANBAN_DB: checkDb, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).then(([stdout, stderr, code]) => ({ stdout, stderr, code }));
  };

  await run("lane", "limit", "impl", "1");
  const a = JSON.parse((await run("add", "over-a", "--lane", "implement", "--json")).stdout) as Task;
  const b = JSON.parse((await run("add", "over-b", "--lane", "implement", "--json")).stdout) as Task;
  writeFileSync(join(dir, "a.md"), "p");
  writeFileSync(join(dir, "b.md"), "p");
  await run("attach", a.id, join(dir, "a.md"));
  await run("attach", b.id, join(dir, "b.md"));

  const res = await run("check");
  expect(res.code).toBe(0);
  expect(res.stdout).toContain("⚠ implement over WIP limit: 2/1");

  const jsonRes = await run("check", "--json");
  expect(jsonRes.code).toBe(0);
  const violations = JSON.parse(jsonRes.stdout) as Array<{ kind: string; laneId?: string; limit?: number; count?: number }>;
  expect(violations).toContainEqual({ kind: "wip-over-limit", laneId: "implement", limit: 1, count: 2 });
});

test("serve: --agents and --auto-review both set KANBAN_AGENTS=1", () => {
  const orig = process.env.KANBAN_AGENTS;
  const errs: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => errs.push(args.join(" "));
  try {
    for (const flag of ["--agents", "--auto-review"]) {
      delete process.env.KANBAN_AGENTS;
      const parsed = parse([flag]);
      applyServeEnv(parsed.flags);
      const set = process.env.KANBAN_AGENTS as string | undefined; // bun-types types unknown env reads as undefined-only
      expect(set).toBe("1");
    }
    expect(errs).toEqual([
      "kanban: --auto-review is deprecated — use --agents (identical behavior)",
    ]);

    delete process.env.KANBAN_AGENTS;
    const parsedNone = parse([]);
    applyServeEnv(parsedNone.flags);
    expect(process.env.KANBAN_AGENTS).toBeUndefined();
    expect(errs).toHaveLength(1);
  } finally {
    console.error = origError;
    if (orig !== undefined) process.env.KANBAN_AGENTS = orig;
    else delete process.env.KANBAN_AGENTS;
  }
});

test("help: serve line shows --agents with --auto-review as deprecated alias", async () => {
  const res = await cli("help");
  expect(res.code).toBe(0);
  expect(res.stdout).toContain("kanban serve [--port <n>] [--open] [--agents]");
  expect(res.stdout).toContain("agents: serve --agents (deprecated alias: --auto-review)");
  expect(res.stdout).not.toContain("auto-review: serve --auto-review");
});

test("help: ps line lists serves, sessions, abandoned leases", async () => {
  const res = await cli("help");
  expect(res.code).toBe(0);
  expect(res.stdout).toContain("kanban ps [--json]");
});

test("docs: AGENTS.md and SKILL.md reference --agents", () => {
  const agentsMd = readFileSync(join(root, "AGENTS.md"), "utf8");
  const skillMd = readFileSync(join(root, "skills/pi-kanban/SKILL.md"), "utf8");
  expect(agentsMd).toContain("--agents");
  expect(skillMd).toContain("--agents");
  expect(skillMd).not.toContain("--auto-review");
});

test("kanban undo: board-wide, card-scoped, --json, WIP warning, and error exits", async () => {
  const undoDb = join(dir, "undo.db");
  const run = (...args: string[]) => {
    const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
      cwd: root,
      env: { ...process.env, KANBAN_DB: undoDb, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).then(([stdout, stderr, code]) => ({ stdout, stderr, code }));
  };

  const a = JSON.parse((await run("add", "card a", "--json")).stdout) as Task;
  const b = JSON.parse((await run("add", "card b", "--json")).stdout) as Task;

  // kanban undo before any move exits 1 with nothing to undo on stderr
  const beforeMove = await run("undo");
  expect(beforeMove.code).toBe(1);
  expect(beforeMove.stderr).toContain("nothing to undo");

  // kanban mv <a.id> plan then kanban done <a.id>
  const mvRes = await run("mv", a.id, "plan");
  expect(mvRes.code).toBe(0);
  const doneRes = await run("done", a.id);
  expect(doneRes.code).toBe(0);

  // kanban undo --json exits 0 and parses to { task: { id: a.id, laneId: "plan" }, event: { fromLaneId: "plan", toLaneId: "done", cause: "done" } }
  const undoJson = await run("undo", "--json");
  expect(undoJson.code).toBe(0);
  const parsed = JSON.parse(undoJson.stdout) as {
    task: { id: string; laneId: string };
    event: { fromLaneId: string; toLaneId: string; cause: string };
  };
  expect(parsed.task.id).toBe(a.id);
  expect(parsed.task.laneId).toBe("plan");
  expect(parsed.event.fromLaneId).toBe("plan");
  expect(parsed.event.toLaneId).toBe("done");
  expect(parsed.event.cause).toBe("done");

  // set backlog WIP limit to 1 so undoing a into backlog (which already has b) triggers WIP warning
  await run("lane", "limit", "backlog", "1");

  // human kanban undo <a.id> exits 0, prints ✓ <a.id> … → Backlog, and puts a back in backlog
  const undoHuman = await run("undo", a.id);
  expect(undoHuman.code).toBe(0);
  expect(undoHuman.stdout).toContain(`✓ ${a.id}`);
  expect(undoHuman.stdout).toContain("→ Backlog");
  expect(undoHuman.stdout).toContain("⚠ backlog over WIP limit: 2/1");

  // verify a is back in backlog
  const aShow = JSON.parse((await run("show", a.id, "--json")).stdout) as Task;
  expect(aShow.laneId).toBe("backlog");

  // kanban undo a b exits 1 with usage: kanban undo [id] [--json]
  const badArity = await run("undo", "a", "b");
  expect(badArity.code).toBe(1);
  expect(badArity.stderr).toContain("usage: kanban undo [id] [--json]");

  // kanban help includes kanban undo [id]
  const helpRes = await run("help");
  expect(helpRes.code).toBe(0);
  expect(helpRes.stdout).toContain("kanban undo [id]");
});

test("claim: set, idempotent re-claim, --force takeover, foreign conflict", async () => {
  const added = await cli("add", "claim me", "--lane", "implement", "--json");
  const card = JSON.parse(added.stdout) as Task;

  // claim sets the owner; show prints the owner row
  const claimed = await cli("claim", card.id, "--author", "ada");
  expect(claimed.code).toBe(0);
  expect(claimed.stdout).toContain("claimed by ada");
  const shown = await cli("show", card.id);
  expect(shown.stdout).toContain("owner:");
  expect(shown.stdout).toContain("ada");
  expect(JSON.parse((await cli("show", card.id, "--json")).stdout).owner).toBe("ada");

  // ls --json carries owner
  const lsRows = JSON.parse((await cli("ls", "--json")).stdout) as Array<{ id: string; owner: string | null }>;
  expect(lsRows.find((t) => t.id === card.id)?.owner).toBe("ada");

  // same-author re-claim exits 0
  expect((await cli("claim", card.id, "--author", "ada")).code).toBe(0);

  // foreign claim exits 1 with the exact conflict message
  const foreign = await cli("claim", card.id, "--author", "bob");
  expect(foreign.code).toBe(1);
  expect(foreign.stderr).toContain(`card '${card.id}' is already owned by 'ada' — pass --force to take it over`);

  // --force takes over
  const forced = await cli("claim", card.id, "--author", "bob", "--force");
  expect(forced.code).toBe(0);
  expect(forced.stdout).toContain("claimed by bob");

  // usage error
  const noArgs = await cli("claim");
  expect(noArgs.code).toBe(1);
  expect(noArgs.stderr).toContain("usage: kanban claim <id> [--author <name>] [--force]");
});

test("handoff into implement sets owner; exits clear it (CLI)", async () => {
  const added = await cli("add", "owner flow", "--json");
  const card = JSON.parse(added.stdout) as Task;

  await cli("handoff", card.id, "implement", "--message", "starting", "--author", "pi");
  expect(JSON.parse((await cli("show", card.id, "--json")).stdout).owner).toBe("pi");

  await cli("mv", card.id, "review");
  expect(JSON.parse((await cli("show", card.id, "--json")).stdout).owner).toBeNull();

  // approve arms the builder: owner becomes pi-builder
  const gate = await cli("add", "gate card", "--lane", "plan", "--json");
  const gateCard = JSON.parse(gate.stdout) as Task;
  await cli("attach", gateCard.id, "README.md");
  const approved = await cli("approve", gateCard.id, "--json");
  expect(approved.code).toBe(0);
  expect(JSON.parse((await cli("show", gateCard.id, "--json")).stdout).owner).toBe("pi-builder");
});

test("review --block hands the card to the lane builder, not the reviewer (CLI)", async () => {
  const added = await cli("add", "block owner flow", "--lane", "review", "--json");
  const task = JSON.parse(added.stdout) as Task;

  const blocked = await cli(
    "review",
    task.id,
    "--block",
    "--message",
    "leaks",
    "--author",
    "pi-reviewer",
    "--json",
  );
  expect(blocked.code).toBe(0);
  const blockResult = JSON.parse(blocked.stdout) as { task: Task; comment: { kind: string; author: string } };
  expect(blockResult.task.laneId).toBe("implement");
  expect(blockResult.task.owner).toBe("pi-builder");

  const show = await cli("show", task.id, "--json");
  expect(show.code).toBe(0);
  const showTask = JSON.parse(show.stdout) as Task;
  expect(showTask.owner).toBe("pi-builder");
  expect(showTask.owner).not.toBe("pi-reviewer");

  const claim = await cli("claim", task.id, "--author", "pi-builder");
  expect(claim.code).toBe(0);
  expect(claim.stdout).toContain("claimed by pi-builder");
  expect(claim.stderr).not.toContain("pass --force");
});

test("overview: lane counts, wip limits, owned cards, and a 2 KB pin on a 300-card board", async () => {
  const oDb = join(dir, "overview.db");
  const run = async (...args: string[]) => {
    const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
      cwd: root,
      env: { ...process.env, KANBAN_DB: oDb, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  };

  // seed: 300 backlog cards with 4000-char notes, a WIP limit, one owned card
  {
    const seed = new KanbanDb(oDb);
    const note = "secret note text that must never leak into the overview. ".repeat(80);
    for (let i = 0; i < 300; i++) seed.createTask({ title: `bulk card ${i}`, note });
    seed.updateLane("implement", { wipLimit: 3 });
    const owned = seed.createTask({ title: "the owned one", lane: "implement" });
    seed.claimTask(owned.id, { author: "pi-builder" });
    seed.close();
  }

  const human = await run("overview");
  expect(human.code).toBe(0);
  expect(Buffer.byteLength(human.stdout)).toBeLessThanOrEqual(2048);
  expect(human.stdout).toContain("waiting 0 · backlog 300 · epics 0 · plan 0 · implement 1/3 · review 0 · done 0 · archive 0");
  expect(human.stdout).toContain("owned ");
  expect(human.stdout).toContain("the owned one → implement · pi-builder");
  expect(human.stdout).not.toContain("secret note text"); // no note text ever

  const parsed = JSON.parse((await run("overview", "--json")).stdout) as {
    lanes: Array<{ id: string; name: string; count: number; wipLimit: number | null }>;
    owned: Array<{ id: string; title: string; laneId: string; owner: string | null; note?: string }>;
  };
  expect(parsed.lanes.map((l) => l.id)).toEqual([
    "waiting",
    "backlog",
    "epics",
    "plan",
    "implement",
    "review",
    "done",
    "archive",
  ]);
  expect(parsed.lanes.find((l) => l.id === "implement")).toMatchObject({ count: 1, wipLimit: 3 });
  expect(parsed.owned).toHaveLength(1);
  expect(parsed.owned[0]).toMatchObject({ title: "the owned one", laneId: "implement", owner: "pi-builder" });
  expect(parsed.owned[0].note).toBeUndefined(); // compact rows, never Task bodies
});

test("reads never write: overview/ls/search leave data_version unchanged", async () => {
  const rDb = join(dir, "reads.db");
  {
    const seed = new KanbanDb(rDb);
    seed.createTask({ title: "read only card", note: "needle for search" });
    seed.close();
  }
  // Both snapshots are fresh short-lived connections (the plan's "reopen"): a
  // long-lived witness bumps data_version when another connection merely joins and
  // leaves the WAL — the file change counter it reads stays put when nothing wrote.
  const { Database } = await import("bun:sqlite");
  const dataVersion = () => {
    const d = new Database(rDb);
    const v = (d.query("PRAGMA data_version").get() as { data_version: number }).data_version;
    d.close();
    return v;
  };
  const before = dataVersion();

  const run = async (...args: string[]) => {
    const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
      cwd: root,
      env: { ...process.env, KANBAN_DB: rDb, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
  };
  await run("overview");
  await run("overview", "--json");
  await run("ls");
  await run("ls", "--json");
  await run("search", "needle");
  await run("search", "needle", "--json");

  expect(dataVersion()).toBe(before);
});

test("ls: per-lane caps with overflow; single-lane cap; --owner flat filter", async () => {
  const lDb = join(dir, "ls-caps.db");
  const run = async (...args: string[]) => {
    const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
      cwd: root,
      env: { ...process.env, KANBAN_DB: lDb, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { stdout, code };
  };

  // 12 top-level backlog cards: full-board ls caps at 10 with an overflow line
  {
    const seed = new KanbanDb(lDb);
    for (let i = 0; i < 12; i++) seed.createTask({ title: `cap card ${i}`, lane: "backlog" });
    seed.close();
  }
  const boardLs = await run("ls");
  expect(boardLs.code).toBe(0);
  const backlogSection = boardLs.stdout.split(/\n● /).find((s) => s.includes("Backlog"))!;
  const rows = backlogSection.split("\n").filter((l) => l.startsWith("  ") && !l.includes("… +"));
  expect(rows).toHaveLength(10);
  expect(boardLs.stdout).toContain("… +2 more — kanban ls backlog --json");

  // single-lane view caps at 50: 55 cards → 50 rows + overflow of 5
  {
    const seed = new KanbanDb(lDb);
    for (let i = 0; i < 55; i++) seed.createTask({ title: `detail card ${i}`, lane: "plan" });
    seed.close();
  }
  const laneLs = await run("ls", "plan");
  expect(laneLs.code).toBe(0);
  const laneRows = laneLs.stdout.split("\n").filter((l) => l.startsWith("  ") && !l.includes("… +") && l.trim().length > 0 && !l.includes("●"));
  expect(laneRows).toHaveLength(50);
  expect(laneLs.stdout).toContain("… +5 more — kanban ls plan --json");

  // --json is uncapped: 67 total
  const jsonRows = JSON.parse((await run("ls", "--json")).stdout) as unknown[];
  expect(jsonRows).toHaveLength(12 + 55);

  // children of shown parents always render (cap counts top-level only)
  {
    const seed = new KanbanDb(lDb);
    const parent = seed.createTask({ title: "capped parent", lane: "review" });
    seed.createTask({ title: "child a", parent: parent.id });
    seed.createTask({ title: "child b", parent: parent.id });
    seed.close();
  }
  const nested = await run("ls", "review");
  expect(nested.stdout).toContain("capped parent");
  expect(nested.stdout).toContain("child a");
  expect(nested.stdout).toContain("child b");

  // --owner filter: flat taskLines, no lane groups
  {
    const seed = new KanbanDb(lDb);
    const mine = seed.createTask({ title: "ada's card", lane: "implement" });
    seed.claimTask(mine.id, { author: "ada" });
    const other = seed.createTask({ title: "bob's card", lane: "implement" });
    seed.claimTask(other.id, { author: "bob" });
    seed.close();
  }
  const owned = await run("ls", "--owner", "ada");
  expect(owned.code).toBe(0);
  expect(owned.stdout).toContain("ada's card");
  expect(owned.stdout).not.toContain("bob's card");
  expect(owned.stdout).not.toContain("●"); // no lane group headers
  const ownedJson = JSON.parse((await run("ls", "--owner", "ada", "--json")).stdout) as Array<{ title: string }>;
  expect(ownedJson).toHaveLength(1);
  expect(ownedJson[0]!.title).toBe("ada's card");
});

test("search: --limit default and 50 cap, compact rows, matched/hasMore/hint", async () => {
  const sDb = join(dir, "search-limit.db");
  const run = async (...args: string[]) => {
    const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
      cwd: root,
      env: { ...process.env, KANBAN_DB: sDb, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  };

  {
    const seed = new KanbanDb(sDb);
    for (let i = 0; i < 30; i++) {
      seed.createTask({ title: `bulk searchable ${i}`, note: `filler ${i} `.repeat(40) });
    }
    const check = seed.createTask({ title: "checklist source", note: "- [x] bulk searchable checkbox" });
    void check;
    seed.close();
  }

  // default 20 rows; matched 31; hasMore + hint on both surfaces
  const def = JSON.parse((await run("search", "bulk", "--json")).stdout) as {
    results: Array<{ id: string; title: string; laneId: string; kind: string; text: string; note?: string; checked?: boolean }>;
    matched: number;
    hasMore: boolean;
    hint?: string;
  };
  expect(def.results).toHaveLength(20);
  expect(def.matched).toBe(31);
  expect(def.hasMore).toBe(true);
  expect(def.hint).toBe("…+11 more matches — narrow the query, or pass --limit up to 50");
  const row = def.results[0]!;
  expect(Object.keys(row).sort()).toEqual(["id", "kind", "laneId", "text", "title"]);
  expect(row.note).toBeUndefined(); // compact rows, never Task bodies
  // checklist rows keep their checked flag (rank below titles, so raise the limit)
  const deep = JSON.parse((await run("search", "bulk", "--limit", "50", "--json")).stdout) as {
    results: Array<{ kind: string; checked?: boolean }>;
  };
  const checkRow = deep.results.find((r) => r.kind === "checklist");
  expect(checkRow?.checked).toBe(true);

  // human: rows + dim tail with the same string
  const human = await run("search", "bulk");
  expect(human.code).toBe(0);
  expect(human.stdout).toContain("…+11 more matches — narrow the query, or pass --limit up to 50");

  // --limit raises the transport budget up to the hard cap
  const raised = JSON.parse((await run("search", "bulk", "--limit", "31", "--json")).stdout) as {
    results: unknown[];
    matched: number;
    hasMore: boolean;
    hint?: string;
  };
  expect(raised.results).toHaveLength(31);
  expect(raised.hasMore).toBe(false);
  expect(raised.hint).toBeUndefined();

  const capped = JSON.parse((await run("search", "bulk", "--limit", "50", "--json")).stdout) as { results: unknown[] };
  expect(capped.results).toHaveLength(31);

  // out-of-range and non-numeric limits exit 1 with the exact message
  for (const bad of ["0", "51", "abc", "-3"]) {
    const badRes = await run("search", "bulk", "--limit", bad);
    expect(badRes.code).toBe(1);
    expect(badRes.stderr).toContain("--limit must be between 1 and 50");
  }

  // usage error mentions --limit
  const empty = await run("search");
  expect(empty.code).toBe(1);
  expect(empty.stderr).toContain("usage: kanban search <query…> [--project <tag>] [--tag <tag>]… [--limit <n>] [--json]");
});

test("mv --before: cross-lane anchor, same-lane reorder, --pos conflict", async () => {
  const mDb = join(dir, "mv-before.db");
  const run = async (...args: string[]) => {
    const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
      cwd: root,
      env: { ...process.env, KANBAN_DB: mDb, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code };
  };
  // human ls renders lane position order (ls --json is creation order)
  const order = async (lane: string) => {
    const out = await run("ls", lane);
    return out.stdout
      .split("\n")
      .filter((l) => /^  \S/.test(l))
      .map((l) => l.trim().split(/\s+/).slice(1).join(" "));
  };

  let ids: Record<string, string> = {};
  {
    const seed = new KanbanDb(mDb);
    for (const title of ["alpha", "beta", "gamma"]) {
      ids[title] = seed.createTask({ title, lane: "backlog" }).id;
    }
    ids.delta = seed.createTask({ title: "delta", lane: "plan" }).id;
    seed.close();
  }

  // cross-lane anchor: mv gamma plan --before delta → plan: gamma, delta
  const cross = await run("mv", ids.gamma!, "plan", "--before", ids.delta!);
  expect(cross.code).toBe(0);
  expect(await order("plan")).toEqual(["gamma", "delta"]);

  // same-lane reorder: mv gamma backlog --before alpha → backlog: gamma, alpha, beta
  const same = await run("mv", ids.gamma!, "backlog", "--before", ids.alpha!);
  expect(same.code).toBe(0);
  expect(await order("backlog")).toEqual(["gamma", "alpha", "beta"]);

  // bare form: mv gamma --before beta (no lane) reorders within the current lane
  const bare = await run("mv", ids.gamma!, "--before", ids.beta!);
  expect(bare.code).toBe(0);
  expect(await order("backlog")).toEqual(["alpha", "gamma", "beta"]);

  // --pos and --before together exit 1
  const combined = await run("mv", ids.alpha!, "backlog", "--pos", "2", "--before", ids.beta!);
  expect(combined.code).toBe(1);
  expect(combined.stderr).toContain("cannot combine --pos and --before");

  // --next/--prev with --before exits 1
  const rel = await run("mv", ids.alpha!, "--next", "--before", ids.beta!);
  expect(rel.code).toBe(1);
  expect(rel.stderr).toContain("cannot combine --next/--prev with --before");

  // self anchor exits 1 with the exact message
  const self = await run("mv", ids.alpha!, "--before", ids.alpha!);
  expect(self.code).toBe(1);
  expect(self.stderr).toContain("cannot move a card before itself");

  // anchor outside the target lane exits 1
  const wrong = await run("mv", ids.alpha!, "review", "--before", ids.beta!);
  expect(wrong.code).toBe(1);
  expect(wrong.stderr).toContain(`anchor card '${ids.beta}' is not in lane 'review'`);

  // help carries the flag
  expect((await run("help")).stdout).toContain("--before <id>");
});

test("docs: HELP, SKILL.md, AGENTS.md, GLOSSARY.md carry overview/claim/--before/--limit/notice", async () => {
  const help = (await cli("help")).stdout;
  for (const needle of ["overview", "claim", "--before", "--limit"]) {
    expect(help).toContain(needle);
  }

  const skillMd = readFileSync(join(root, "skills/pi-kanban/SKILL.md"), "utf8");
  for (const needle of ["overview", "claim", "--before", "--limit", "notice"]) {
    expect(skillMd).toContain(needle);
  }

  const agentsMd = readFileSync(join(root, "AGENTS.md"), "utf8");
  expect(agentsMd).toContain("src/notice.ts");

  const glossary = readFileSync(join(root, "GLOSSARY.md"), "utf8");
  for (const term of ["**Owner**", "**Overview**", "**Notice**"]) {
    expect(glossary).toContain(term);
  }
});

test("worker run queues a run; unknown lane prints the charter error; worker ls renders the row", async () => {
  const run = await cli("worker", "run", "backlog", "--focus", "groom stale cards", "--author", "pi-manager", "--json");
  expect(run.code).toBe(0);
  const row = JSON.parse(run.stdout) as { id: string; laneId: string; status: string; focus: string; requestedBy: string; log?: string };
  expect(row).toMatchObject({ laneId: "backlog", status: "queued", focus: "groom stale cards", requestedBy: "pi-manager" });
  expect("log" in row).toBe(false);

  const db = new KanbanDb(dbFile);
  expect(db.laneWorker(row.id)).toMatchObject({ laneId: "backlog", status: "queued" });
  db.close();

  const noCharter = await cli("worker", "run", "done");
  expect(noCharter.code).toBe(1);
  expect(noCharter.stderr).toContain(
    "no worker charter for lane 'done' — charter lanes: waiting, backlog, plan, implement, review",
  );

  const queued = await cli("worker", "run", "backlog");
  expect(queued.code).toBe(0);
  expect(queued.stdout).toContain(`queued lane worker `);
  expect(queued.stdout).toContain("for backlog — drained by serve --agents (watch with kanban worker ls)");

  const listed = await cli("worker", "ls");
  expect(listed.code).toBe(0);
  expect(listed.stdout).toContain("backlog");
  expect(listed.stdout).toContain("queued");
  expect(listed.stdout).toContain("groom stale cards");

  const listedJson = await cli("worker", "ls", "--json");
  const rows = JSON.parse(listedJson.stdout) as Array<{ id: string; log?: string }>;
  expect(rows).toHaveLength(2);
  expect(rows[0]!.log).toBeUndefined();

  const filtered = await cli("worker", "ls", "--lane", "review");
  expect(filtered.stdout).not.toContain("groom stale cards");
});

test("project ls / show / set round-trip: route, flip gate, clear", async () => {
  const repoDir = join(dir, "some-repo");
  mkdirSync(repoDir);
  await cli("add", "project routing card", "--project", "kanban", "--json");
  await cli("add", "unrouted project card", "--project", "sometag", "--json");

  const set = await cli("project", "set", "kanban", "--repo", repoDir);
  expect(set.code).toBe(0);
  expect(set.stdout.trim()).toBe(`saved  kanban  ${repoDir}  test gate on  cmd bun test`);

  const ls = await cli("project", "ls");
  expect(ls.stdout).toContain(`kanban  ${repoDir}  test gate on  cmd bun test`);
  expect(ls.stdout).toContain("sometag  — (fallback)  test gate on  cmd bun test"); // un-routed tag listed lazily

  const off = await cli("project", "set", "kanban", "--no-test-gate");
  expect(off.code).toBe(0);
  expect(off.stdout.trim()).toBe(`saved  kanban  ${repoDir}  test gate off  cmd bun test`);

  const show = await cli("project", "show", "kanban");
  expect(show.code).toBe(0);
  expect(show.stdout.trim()).toBe(`kanban  ${repoDir}  test gate off  cmd bun test`);

  const cleared = await cli("project", "set", "kanban", "--clear-repo");
  expect(cleared.code).toBe(0);
  expect(cleared.stdout.trim()).toBe("saved  kanban  — (fallback)  test gate off  cmd bun test");

  const nope = await cli("project", "show", "nope");
  expect(nope.code).toBe(1);
  expect(nope.stderr).toContain("unknown project 'nope'");
});

test("project set validation: relative/missing paths and conflicting flags", async () => {
  const rel = await cli("project", "set", "kanban", "--repo", "relative/x");
  expect(rel.code).toBe(1);
  expect(rel.stderr).toContain("repo path must be an absolute path to an existing directory: relative/x");

  const missing = await cli("project", "set", "kanban", "--repo", join(dir, "nope"));
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("repo path must be an absolute path to an existing directory");

  const bothRepo = await cli("project", "set", "kanban", "--repo", dir, "--clear-repo");
  expect(bothRepo.code).toBe(1);
  expect(bothRepo.stderr).toContain("--repo and --clear-repo are mutually exclusive");

  const bothGate = await cli("project", "set", "kanban", "--test-gate", "--no-test-gate");
  expect(bothGate.code).toBe(1);
  expect(bothGate.stderr).toContain("--test-gate and --no-test-gate are mutually exclusive");

  const bare = await cli("project", "set", "x");
  expect(bare.code).toBe(1);
  expect(bare.stderr).toContain("usage: kanban project set <name> (--repo <path> | --clear-repo) [--test-gate | --no-test-gate] [--test-cmd <cmd> | --clear-test-cmd]");
});

test("project add: explicit path, dot pwd, --name override, duplicate refusal, and non-git warning", async () => {
  const gitDir = join(dir, "my-repo");
  mkdirSync(gitDir, { recursive: true });
  mkdirSync(join(gitDir, ".git"), { recursive: true });

  const added = await cli("project", "add", gitDir);
  expect(added.code).toBe(0);
  expect(added.stdout.trim()).toBe(`added  my-repo  ${gitDir}  test gate on  cmd bun test`);
  expect(added.stdout).not.toContain("⚠");

  const dotRepoDir = join(dir, "dot-repo");
  mkdirSync(dotRepoDir, { recursive: true });
  mkdirSync(join(dotRepoDir, ".git"), { recursive: true });
  const dotAdded = await cliIn(dotRepoDir, "project", "add", ".");
  expect(dotAdded.code).toBe(0);
  expect(dotAdded.stdout.trim()).toBe(`added  dot-repo  ${dotRepoDir}  test gate on  cmd bun test`);

  const plainDir = join(dir, "plain-dir");
  mkdirSync(plainDir, { recursive: true });
  const custom = await cli("project", "add", plainDir, "--name", "custom");
  expect(custom.code).toBe(0);
  expect(custom.stdout).toContain(`added  custom  ${plainDir}  test gate on  cmd bun test`);
  expect(custom.stdout).toContain(`⚠ ${plainDir} is not a git repo root (no .git)`);

  const dup = await cli("project", "add", plainDir, "--name", "custom");
  expect(dup.code).toBe(1);
  expect(dup.stderr).toContain("project 'custom' already exists — use: kanban project set custom --repo <path>");

  const bare = await cli("project", "add");
  expect(bare.code).toBe(1);
  expect(bare.stderr).toContain("usage: kanban project add <path> [--name <n>]");
});

test("project set --test-cmd round-trip: trim, json, clear, unregistered upsert", async () => {
  const set = await cli("project", "set", "tc-set", "--test-cmd", "  cargo test  ");
  expect(set.code).toBe(0);
  expect(set.stdout.trim()).toBe("saved  tc-set  — (fallback)  test gate on  cmd cargo test");

  const shown = await cli("project", "show", "tc-set", "--json");
  expect(shown.code).toBe(0);
  const shownRoute = JSON.parse(shown.stdout) as { testCmd: string | null };
  expect(shownRoute.testCmd).toBe("cargo test");

  const cleared = await cli("project", "set", "tc-set", "--clear-test-cmd");
  expect(cleared.code).toBe(0);
  expect(cleared.stdout.trim()).toBe("saved  tc-set  — (fallback)  test gate on  cmd bun test");

  await cli("project", "set", "tc-set", "--test-cmd", "make test");
  const clearedByEmpty = await cli("project", "set", "tc-set", "--test-cmd", "");
  expect(clearedByEmpty.code).toBe(0);
  expect(clearedByEmpty.stdout.trim()).toBe("saved  tc-set  — (fallback)  test gate on  cmd bun test");

  const json = await cli("project", "set", "tc-json", "--test-cmd", "pytest", "--json");
  expect(json.code).toBe(0);
  const route = JSON.parse(json.stdout) as { name: string; repoPath: string | null; testGate: boolean; testCmd: string | null };
  expect(route).toEqual({ name: "tc-json", repoPath: null, testGate: true, testCmd: "pytest" });

  const ls = await cli("project", "ls");
  expect(ls.stdout).toContain("tc-json  — (fallback)  test gate on  cmd pytest");
});

test("project rows carry the cmd segment: add, ls, show, saved line", async () => {
  const repoDir = join(dir, "tc-add-repo");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(join(repoDir, ".git"), { recursive: true });

  const added = await cli("project", "add", repoDir, "--name", "tc-add");
  expect(added.code).toBe(0);
  expect(added.stdout.trim()).toBe(`added  tc-add  ${repoDir}  test gate on  cmd bun test`);

  const set = await cli("project", "set", "tc-add", "--test-cmd", "make check");
  expect(set.code).toBe(0);
  expect(set.stdout.trim()).toBe(`saved  tc-add  ${repoDir}  test gate on  cmd make check`);

  const ls = await cli("project", "ls");
  expect(ls.stdout).toContain(`tc-add  ${repoDir}  test gate on  cmd make check`);

  const show = await cli("project", "show", "tc-add");
  expect(show.code).toBe(0);
  expect(show.stdout.trim()).toBe(`tc-add  ${repoDir}  test gate on  cmd make check`);
});

test("project set --test-cmd errors: usage, mutual exclusion, db bounds", async () => {
  const bare = await cli("project", "set", "tc-err");
  expect(bare.code).toBe(1);
  expect(bare.stderr).toContain("usage: kanban project set <name> (--repo <path> | --clear-repo) [--test-gate | --no-test-gate] [--test-cmd <cmd> | --clear-test-cmd]");

  const both = await cli("project", "set", "tc-err", "--test-cmd", "x", "--clear-test-cmd");
  expect(both.code).toBe(1);
  expect(both.stderr).toContain("--test-cmd and --clear-test-cmd are mutually exclusive");

  const tooLong = await cli("project", "set", "tc-err", "--test-cmd", "x".repeat(501));
  expect(tooLong.code).toBe(1);
  expect(tooLong.stderr).toContain("test command must be 1 to 500 characters");

  const blank = await cli("project", "set", "tc-err", "--test-cmd", "   ");
  expect(blank.code).toBe(1);
  expect(blank.stderr).toContain("test command must be 1 to 500 characters");

  const nope = await cli("project", "show", "tc-err");
  expect(nope.code).toBe(1);
  expect(nope.stderr).toContain("unknown project 'tc-err'"); // a rejected value created no row
});

test("project set applies repo, gate, and test-cmd in order", async () => {
  const repoDir = join(dir, "tc-order-repo");
  mkdirSync(repoDir, { recursive: true });

  const all = await cli("project", "set", "tc-order", "--test-cmd", "cargo test", "--no-test-gate", "--repo", repoDir);
  expect(all.code).toBe(0);
  expect(all.stdout.trim()).toBe(`saved  tc-order  ${repoDir}  test gate off  cmd cargo test`);

  const clearRepo = await cli("project", "set", "tc-order", "--clear-repo", "--test-gate");
  expect(clearRepo.code).toBe(0);
  expect(clearRepo.stdout.trim()).toBe("saved  tc-order  — (fallback)  test gate on  cmd cargo test");

  const both = await cli("project", "set", "tc-order", "--repo", repoDir, "--test-cmd", "yarn test");
  expect(both.code).toBe(0);
  expect(both.stdout.trim()).toBe(`saved  tc-order  ${repoDir}  test gate on  cmd yarn test`);

  const help = await cli("help");
  expect(help.stdout).toContain(
    "kanban project ls | show <name> | add <path> [--name <n>] | set <name> [--repo <path> | --clear-repo] [--test-gate | --no-test-gate]",
  ); // help line unchanged — no new verb
});


test("lane context subcommand views, updates via flags and --from, and clears", async () => {
  // the seeded plan context is viewable
  const view = await cli("lane", "context", "plan", "--json");
  expect(view.code).toBe(0);
  const parsed = JSON.parse(view.stdout) as { laneId: string; context: { actors: Array<{ id: string }>; gate: { approveTarget: string } } };
  expect(parsed.laneId).toBe("plan");
  expect(parsed.context.actors.map((a) => a.id)).toEqual(["planner", "plan-reviewer"]);

  const human = await cli("lane", "context", "plan");
  expect(human.code).toBe(0);
  expect(human.stdout).toContain("planner (pi-planner)");
  expect(human.stdout).toContain("gate: approve → implement");

  // build a custom lane's context from flags
  await cli("lane", "add", "Design");
  const built = await cli(
    "lane", "context", "design",
    "--actor", "designer", "--author", "pi-designer", "--instructions", "Design {id}",
    "--template", "# Spec", "--artifact", "design", "--approve-to", "plan", "--json",
  );
  expect(built.code).toBe(0);
  const ctx = (JSON.parse(built.stdout) as { context: { actors: Array<{ id: string; author: string; instructions: string }>; template: string; artifact: string; gate: { approveTarget: string } } }).context;
  expect(ctx.actors[0]).toMatchObject({ id: "designer", author: "pi-designer", instructions: "Design {id}" });
  expect(ctx.template).toBe("# Spec");
  expect(ctx.artifact).toBe("design");
  expect(ctx.gate).toMatchObject({ approveTarget: "plan" });

  // --from replaces the whole context from a JSON file
  const file = join(dir, "ctx.json");
  writeFileSync(
    file,
    JSON.stringify({ actors: [{ id: "designer", author: "pi-designer", instructions: "v2" }], triggers: [{ kind: "human-comment" }] }),
  );
  const loaded = JSON.parse((await cli("lane", "context", "design", "--from", file, "--json")).stdout) as {
    context: { actors: Array<{ instructions: string }>; triggers: Array<{ kind: string }>; artifact?: string };
  };
  expect(loaded.context.actors[0].instructions).toBe("v2");
  expect(loaded.context.triggers).toEqual([{ kind: "human-comment" }]);
  expect(loaded.context.artifact).toBeUndefined();

  // --clear resets to null
  const cleared = JSON.parse((await cli("lane", "context", "design", "--clear", "--json")).stdout);
  expect(cleared).toEqual({ laneId: "design", context: null });

  // fixed non-workflow lanes refuse a context
  const denied = await cli("lane", "context", "waiting", "--actor", "x");
  expect(denied.code).toBe(1);
  expect(denied.stderr).toContain("cannot host a workflow context");

  // unknown lane subcommand names the full set
  expect((await cli("lane", "frobnicate")).stderr).toContain("context");
});
