#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { KanbanDb, KanbanError, UNBLOCKED_LANES, defaultDbPath, type Priority, type Task, type TaskPatch } from "./db";
import { c, commentLine, commentThread, laneList, listLanes, searchResults, taskDetail, taskLine } from "./render";
import { searchBoard } from "./search";

const VERSION = "0.6.0";

const HELP = `kanban ${VERSION} — task board for the pi agent

usage:
  kanban add <title…> [--note <text>] [--lane <ref>] [--project <tag>] [--parent <id>]
                      [--priority <high|normal|low>] [--blocked-by <id>]… [--top] [--elaborate]
  kanban ls [lane] [--project <tag>] [--json]
  kanban next [--project <tag>] [--json]  (what's next: lane priority, then card priority, then oldest; skips blocked)
  kanban search <query…> [--project <tag>] [--json]
  kanban show <id>
  kanban elaborate <id>                     (queue AI note elaboration; runs on the auto-agent loop)
  kanban attach <id> <plan-file>            (re-attach versions; show prints the latest)
  kanban comment <id> <text…> [--author <name>] [--kind <comment|review|handoff|question>]
  kanban comments <id>
  kanban handoff <id> <lane> --message <text> [--author <name>]   (atomic move + thread record)
  kanban review <id> (--approve | --block --message <text> [--finding <text>]…)
  kanban approve <id>                       (plan gate: approve the attached plan → Implement)
  kanban reject <id> --message <feedback>   (plan gate: reject with feedback; planner re-plans)
  kanban plan-review <id> (--pass | --block --message <text> [--finding <text>]…)  (plan reviewer's verdict on the attached plan)
  kanban brief <id>                         (pickup context: note, plan, thread)
  kanban mv <id> <lane> [--pos <1-based>]     kanban mv <id> --next | --prev
  kanban edit <id> [--title <t>] [--note <text>] [--project <tag>] [--lane <ref>]
                          [--parent <id>] [--priority <high|normal|low>] [--blocked-by <id>…]
                          [--clear-note] [--clear-parent] [--clear-blocked-by]
  kanban done <id>
  kanban archive <id>                        (undo: mv <id> <lane>)
  kanban rm <id> [--force]                   (deleting a parent needs --force)
  kanban lane ls | add <name> | rename <ref> <name> | rm <ref> [--force]
  kanban serve [--port <n>] [--open] [--auto-review]
  kanban stop [--port <n>]                     (SIGTERM the kanban server; graceful — traces in-flight agents)
  kanban help | version

lane refs: slug (backlog), prefix (imp), name prefix (Rev), or ordinal (1..n)
task ids: any unique prefix works. add --json for machine-readable output.
search: ranks titles, checklist lines, note text, then plans — same results as the web dropdown.
hierarchy: --parent nests a card (epic → story → subtask, max depth 3).
threads: comment/handoff/review append to the card thread; brief prints full pickup context.
auto-review: serve --auto-review spawns a pi reviewer for cards in Review (thinking max; block → pi-builder works the findings, max 3 cycles; agents configurable in the web ui → ≡).
auto-plan: the same flag runs a pi planner for cards in Plan — it writes the plan from the shared
template, asks open questions (kind question) when an answer would change the plan, then hands off
to a pi plan-reviewer that checks the plan against the template checklist (max 2 block rounds per
human comment); the human gate is kanban approve (arms a plan-build pi-builder) or kanban reject
--message (re-plans with the feedback); the same loop elaborates newly added cards on request (add --elaborate / the ✨ composer toggle).`;

interface Parsed {
  flags: Record<string, string | true | string[]>;
  positional: string[];
}

const VALUE_FLAGS = new Set(["note", "lane", "project", "pos", "title", "port", "parent", "author", "kind", "message", "priority"]);
const BOOL_FLAGS = new Set(["json", "force", "next", "prev", "open", "top", "clear-note", "clear-parent", "approve", "block", "auto-review", "pass", "clear-blocked-by", "elaborate"]);
const MULTI_FLAGS = new Set(["finding", "blocked-by"]); // repeatable: each occurrence appends one value

function parse(argv: string[]): Parsed {
  const flags: Record<string, string | true | string[]> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (BOOL_FLAGS.has(key)) flags[key] = true;
      else if (MULTI_FLAGS.has(key)) {
        const v = flags[key];
        const next = argv[++i] ?? "";
        if (Array.isArray(v)) v.push(next);
        else flags[key] = [next];
      } else if (VALUE_FLAGS.has(key)) flags[key] = argv[++i] ?? "";
      else throw new KanbanError(`unknown flag '${a}' (see: kanban help)`, "invalid");
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

const str = (flags: Parsed["flags"], key: string): string | undefined => {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
};

const arr = (flags: Parsed["flags"], key: string): string[] => {
  const v = flags[key];
  return Array.isArray(v) ? v : [];
};

function jsonOut(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** Relative lane for --next / --prev. */
function stepLane(db: KanbanDb, task: Task, delta: number): string {
  const lanes = db.lanes();
  const i = lanes.findIndex((l) => l.id === task.laneId);
  const next = i + delta;
  if (next < 0 || next >= lanes.length) {
    throw new KanbanError(delta < 0 ? "already in the first lane" : "already in the last lane", "conflict");
  }
  return lanes[next].id;
}

/** Fixed target lane for done/archive — no silent fallback to another lane. */
function laneById(db: KanbanDb, id: string): string {
  const lane = db.lanes().find((l) => l.id === id);
  if (!lane) throw new KanbanError(`no '${id}' lane on this board`, "not-found");
  return lane.id;
}

/** Soft done-warning: children still in active lanes after their parent reached Done — advisory only. */
function warnActiveChildren(db: KanbanDb, task: Task): void {
  const active = db.activeChildren(task.id);
  if (active.length > 0) {
    console.log(
      c.hex(
        "#d29922",
        `warning: ${active.length} children still active (${active.map((t) => t.id).join(", ")}) — advance or archive them if the work is done`,
      ),
    );
  }
}

/** PIDs with a TCP listener on `port` (lsof — the same probe repro.sh uses). pid 0 must be
 * dropped: lsof's trailing empty line becomes Number("") === 0, and kill(0) signals the
 * caller's whole process group — suicide. */
function listenerPids(port: number): number[] {
  const out = Bun.spawnSync(["lsof", "-t", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]);
  return out.stdout
    .toString()
    .split("\n")
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

async function main(): Promise<number> {
  const argv = Bun.argv.slice(2);
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return 0;
  }
  if (cmd === "version" || cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return 0;
  }

  const { flags, positional } = parse(rest);
  if (flags.finding !== undefined && cmd !== "review" && cmd !== "plan-review") {
    throw new KanbanError("--finding is only valid with 'review --block' or 'plan-review --block'", "invalid");
  }

  if (cmd === "serve") {
    const port = Number(str(flags, "port") ?? process.env.PORT ?? 4600);
    if (flags.open) setTimeout(() => Bun.spawn(["open", `http://127.0.0.1:${port}`]), 800);
    // serve in-process: one process, one cmdline — killing `kanban serve` kills
    // the server and its agent loop, no orphaned wrapper children
    process.env.PORT = String(port);
    if (flags["auto-review"]) process.env.KANBAN_AUTO_REVIEW = "1";
    const { boot } = await import("./index");
    await boot(); // resolves after listen; the listener keeps the process alive
    return 0;
  }

  if (cmd === "stop") {
    const port = Number(str(flags, "port") ?? process.env.PORT ?? 4600);
    const pids = listenerPids(port);
    if (pids.length === 0) {
      console.log(`no server listening on port ${port}`);
      return 0;
    }
    // never signal something we cannot vouch for (same spirit as the boot guard)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
      const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      if (!body || body.ok !== true) throw new Error("not kanban");
    } catch {
      throw new KanbanError(
        `port ${port} is held by a non-kanban server — stop it yourself (lsof -nP -iTCP:${port} -sTCP:LISTEN)`,
        "conflict",
      );
    }
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    for (let i = 0; i < 50 && listenerPids(port).length > 0; i++) await new Promise((r) => setTimeout(r, 100));
    const stopped = listenerPids(port).length === 0;
    console.log(
      stopped
        ? `stopped the kanban server on port ${port}`
        : `signaled port ${port}; still listening — it may be draining, retry in a moment`,
    );
    return stopped ? 0 : 1;
  }

  const db = new KanbanDb(defaultDbPath());
  try {
    const json = !!flags.json;
    const project = str(flags, "project");

    switch (cmd) {
      case "add": {
        const title = positional.join(" ");
        if (!title) throw new KanbanError("usage: kanban add <title…>", "invalid");
        const blockedBy = Array.isArray(flags["blocked-by"]) ? flags["blocked-by"] : undefined;
        const task = db.createTask({
          title,
          note: str(flags, "note"),
          lane: str(flags, "lane"),
          project,
          parent: str(flags, "parent"),
          priority: str(flags, "priority"),
          blockedBy,
          index: flags.top ? 0 : (str(flags, "pos") ? Number(str(flags, "pos")) - 1 : undefined),
        });
        if (flags["elaborate"]) db.queueElaboration(task.id);
        if (json) jsonOut(task);
        else {
          console.log(taskLine(db, task));
          if (flags["elaborate"]) {
            console.log(c.dim("✨ elaboration queued — the auto-agent loop (kanban serve --auto-review) will expand the note"));
          }
        }
        return 0;
      }

      case "ls": {
        const laneRef = positional[0];
        if (laneRef) db.resolveLane(laneRef); // validate before filtering
        const tasks = db
          .tasks()
          .filter((t) => (laneRef ? t.laneId === db.resolveLane(laneRef).id : true))
          .filter((t) => (project ? t.project === project : true));
        if (json) {
          const map = db.blockedByMap();
          jsonOut(tasks.map((t) => ({ ...t, blockedBy: map[t.id] ?? [] })));
        } else {
          console.log(listLanes(db, laneRef, project));
        }
        return 0;
      }

      case "next": {
        const { task, blocked } = db.nextTask(project);
        if (json) {
          jsonOut(task ? { ...task, blocked } : (blocked > 0 ? { task: null, blocked } : null));
        } else {
          const warn = blocked > 0 ? `  ${c.hex("#d29922", `⚠ ${blocked} blocked card(s) skipped`)}` : "";
          if (task) {
            console.log(`${taskLine(db, task)}${warn}`);
          } else {
            console.log(`${c.dim("nothing to pull forward")}${warn}`);
          }
        }
        return 0;
      }

      case "search": {
        const query = positional.join(" ").trim();
        if (!query) throw new KanbanError("usage: kanban search <query…> [--project <tag>]", "invalid");
        const results = searchBoard(
          db.tasks().filter((t) => (project ? t.project === project : true)),
          query,
          db.latestPlans(),
        );
        if (json) jsonOut(results);
        else console.log(searchResults(db, query, results));
        return 0;
      }

      case "show": {
        const task = db.resolveTask(positional[0] ?? "");
        if (json) {
          const map = db.blockedByMap();
          jsonOut({
            ...task,
            blockedBy: map[task.id] ?? [],
            blocking: db.blocking(task.id).map((t) => t.id),
          });
        } else {
          console.log(taskDetail(db, task));
        }
        return 0;
      }

      case "brief": {
        const idRef = positional[0];
        if (!idRef) throw new KanbanError("usage: kanban brief <id>", "invalid");
        const task = db.resolveTask(idRef);
        if (json) jsonOut({ task, plan: db.attachment(task.id, "plan"), comments: db.comments(task.id) });
        else console.log(taskDetail(db, task)); // thread-aware: note, plan, and comments in one read
        return 0;
      }

      case "elaborate": {
        const idRef = positional[0];
        if (!idRef) throw new KanbanError("usage: kanban elaborate <id>", "invalid");
        const task = db.resolveTask(idRef);
        db.queueElaboration(task.id);
        if (json) jsonOut(task);
        else {
          console.log(`${c.green("✓")} elaboration queued for ${c.dim(task.id)} — runs on the auto-agent loop (kanban serve --auto-review)`);
        }
        return 0;
      }

      case "attach": {
        const [idRef, file] = positional;
        if (!idRef || !file) throw new KanbanError("usage: kanban attach <id> <plan-file>", "invalid");
        let content: string;
        try {
          content = readFileSync(file, "utf8");
        } catch (err) {
          throw new KanbanError(`cannot read plan file '${file}': ${(err as Error).message}`, "invalid");
        }
        const plan = db.attach(idRef, "plan", content, resolve(file));
        if (json) jsonOut(plan);
        else console.log(`${c.green("✓")} attached plan ${c.dim(`v${plan.version}`)} to ${c.dim(plan.taskId)}`);
        return 0;
      }

      case "comment": {
        const [idRef, ...text] = positional;
        const body = text.join(" ");
        if (!idRef || !body) {
          throw new KanbanError("usage: kanban comment <id> <text…> [--author <name>] [--kind <comment|review|handoff|question>]", "invalid");
        }
        const comment = db.createComment(idRef, { body, author: str(flags, "author"), kind: str(flags, "kind") });
        if (json) jsonOut(comment);
        else console.log(commentLine(comment));
        return 0;
      }

      case "comments": {
        const idRef = positional[0];
        if (!idRef) throw new KanbanError("usage: kanban comments <id>", "invalid");
        const comments = db.comments(idRef);
        if (json) jsonOut(comments);
        else console.log(commentThread(comments));
        return 0;
      }

      case "handoff": {
        const [idRef, laneRef] = positional;
        const message = str(flags, "message");
        if (!idRef || !laneRef || !message) {
          throw new KanbanError("usage: kanban handoff <id> <lane> --message <text> [--author <name>]", "invalid");
        }
        const result = db.handoff(idRef, laneRef, { message, author: str(flags, "author") });
        if (json) jsonOut(result);
        else {
          console.log(`${taskLine(db, result.task)}\n${commentLine(result.comment)}`);
          if (result.task.laneId === "done") warnActiveChildren(db, result.task);
        }
        return 0;
      }

      case "review": {
        const idRef = positional[0];
        const message = str(flags, "message");
        const approve = !!flags.approve;
        const block = !!flags.block;
        if (!idRef || approve === block) {
          throw new KanbanError(
            "usage: kanban review <id> (--approve | --block --message <text> [--finding <text>]…)",
            "invalid",
          );
        }
        if (block && !message) throw new KanbanError("--block needs --message <text>", "invalid");
        const findings = arr(flags, "finding");
        if (!block && findings.length > 0) throw new KanbanError("--finding is only valid with 'review --block'", "invalid");
        const result = approve
          ? db.handoff(idRef, laneById(db, "done"), { message: message ?? "approved", author: str(flags, "author"), kind: "review" })
          : db.handoff(idRef, laneById(db, "implement"), { message: message!, author: str(flags, "author"), kind: "review", findings });
        if (json) jsonOut(result);
        else {
          console.log(`${taskLine(db, result.task)}\n${commentLine(result.comment)}`);
          if (result.task.laneId === "done") warnActiveChildren(db, result.task);
        }
        return 0;
      }

      case "plan-review": {
        const idRef = positional[0];
        const message = str(flags, "message");
        const pass = !!flags.pass;
        const block = !!flags.block;
        if (!idRef || pass === block) {
          throw new KanbanError(
            "usage: kanban plan-review <id> (--pass | --block --message <text> [--finding <text>]…)",
            "invalid",
          );
        }
        const findings = arr(flags, "finding");
        if (!block && findings.length > 0) throw new KanbanError("--finding is only valid with 'plan-review --block'", "invalid");
        const comment = db.planReview(idRef, {
          verdict: pass ? "pass" : "block",
          message: message ?? (pass ? "plan meets the checklist" : undefined),
          findings,
          author: str(flags, "author"),
        });
        if (json) jsonOut(comment);
        else console.log(commentLine(comment));
        return 0;
      }

      case "approve": {
        const idRef = positional[0];
        if (!idRef) throw new KanbanError("usage: kanban approve <id> [--message <text>]", "invalid");
        const result = db.approveTask(idRef, { author: str(flags, "author"), message: str(flags, "message") });
        if (json) jsonOut(result);
        else console.log(`${taskLine(db, result.task)}\n${commentLine(result.comment)}`);
        return 0;
      }

      case "reject": {
        const [idRef, ...feedback] = positional;
        const message = str(flags, "message") ?? feedback.join(" ");
        if (!idRef || !message) {
          throw new KanbanError("usage: kanban reject <id> --message <feedback>", "invalid");
        }
        const comment = db.rejectTask(idRef, message, { author: str(flags, "author") });
        if (json) jsonOut(comment);
        else console.log(commentLine(comment));
        return 0;
      }

      case "mv": {
        const task = db.resolveTask(positional[0] ?? "");
        let laneRef = positional[1];
        if (flags.next) laneRef = stepLane(db, task, 1);
        else if (flags.prev) laneRef = stepLane(db, task, -1);
        if (!laneRef) throw new KanbanError("usage: kanban mv <id> <lane | --next | --prev>", "invalid");
        const pos = str(flags, "pos");
        const moved = db.moveTask(task.id, laneRef, pos ? Number(pos) - 1 : undefined);
        if (json) jsonOut(moved);
        else {
          console.log(taskLine(db, moved));
          if (moved.laneId === "done") warnActiveChildren(db, moved);
          if (moved.laneId === "plan" || moved.laneId === "implement") {
            const blockers = db.blockers(moved.id).filter((b) => !UNBLOCKED_LANES.includes(b.laneId as any));
            if (blockers.length > 0) {
              console.log(c.hex("#d29922", `⚠ blocked by: ${blockers.map((b) => b.id).join(", ")}`));
            }
          }
        }
        return 0;
      }

      case "edit": {
        const id = positional[0] ?? "";
        const patch: TaskPatch = {};
        if (str(flags, "title") !== undefined) patch.title = str(flags, "title");
        if (str(flags, "note") !== undefined) patch.note = str(flags, "note");
        if (flags["clear-note"]) patch.note = "";
        if (project !== undefined) patch.project = project;
        if (str(flags, "lane") !== undefined) patch.lane = str(flags, "lane");
        if (str(flags, "parent") !== undefined) patch.parent = str(flags, "parent");
        if (flags["clear-parent"]) patch.parent = null;
        if (str(flags, "priority") !== undefined) patch.priority = str(flags, "priority") as Priority;
        if (Array.isArray(flags["blocked-by"])) patch.blockedBy = flags["blocked-by"];
        if (flags["clear-blocked-by"]) patch.blockedBy = [];
        if (Object.keys(patch).length === 0) {
          throw new KanbanError(
            "nothing to edit — pass --title, --note, --project, --lane, --parent, --priority, --blocked-by or clear flags",
            "invalid",
          );
        }
        const updated = db.updateTask(id, patch);
        if (json) jsonOut(updated);
        else console.log(taskLine(db, updated));
        return 0;
      }

      case "done": {
        const task = db.resolveTask(positional[0] ?? "");
        const moved = db.moveTask(task.id, laneById(db, "done"));
        if (json) jsonOut(moved);
        else {
          console.log(taskLine(db, moved));
          warnActiveChildren(db, moved);
        }
        return 0;
      }

      case "archive": {
        const task = db.resolveTask(positional[0] ?? "");
        const moved = db.moveTask(task.id, laneById(db, "archive"));
        if (json) jsonOut(moved);
        else console.log(taskLine(db, moved));
        return 0;
      }

      case "rm": {
        const task = db.deleteTask(positional[0] ?? "", !!flags.force);
        if (json) jsonOut({ ok: true, removed: task });
        else console.log(`removed  ${task.id}  ${task.title}`);
        return 0;
      }

      case "lane": {
        const [sub, ...subRest] = positional;
        switch (sub) {
          case undefined:
          case "ls": {
            if (json) jsonOut(db.lanes());
            else console.log(laneList(db));
            return 0;
          }
          case "add": {
            const name = subRest.join(" ");
            if (!name) throw new KanbanError("usage: kanban lane add <name>", "invalid");
            const lane = db.createLane({ name });
            if (json) jsonOut(lane);
            else console.log(`${lane.id}  ${lane.name}  added`);
            return 0;
          }
          case "rename": {
            const ref = subRest[0] ?? "";
            const name = subRest.slice(1).join(" ");
            if (!ref || !name) throw new KanbanError("usage: kanban lane rename <ref> <name>", "invalid");
            const lane = db.updateLane(ref, { name });
            if (json) jsonOut(lane);
            else console.log(`${lane.id}  ${lane.name}  renamed`);
            return 0;
          }
          case "rm": {
            const lane = db.deleteLane(subRest[0] ?? "", !!flags.force);
            if (json) jsonOut({ ok: true, removed: lane });
            else console.log(`${lane.id}  removed`);
            return 0;
          }
          default:
            throw new KanbanError(`unknown lane subcommand '${sub}' (ls | add | rename | rm)`, "invalid");
        }
      }

      default:
        throw new KanbanError(`unknown command '${cmd}' (see: kanban help)`, "invalid");
    }
  } finally {
    db.close();
  }
}

try {
  process.exitCode = await main();
} catch (err) {
  const msg = err instanceof KanbanError ? err.message : (err as Error)?.message ?? String(err);
  console.error(`kanban: ${msg}`);
  process.exitCode = 1;
}
