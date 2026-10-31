import * as path from "node:path";
import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import { KanbanDb, KanbanError, defaultDbPath, RESERVED_FILE_NAMES, type AgentConfig, type AgentRole, type Attachment, type Board, type BoardPayload, type BoardStatsPayload, type CardWorkspace, type Comment, type Lane, type LaneEventFeedEntry, type Task, type WorkerPool } from "./db";
import { cardFileDiff, type CardFileDiff } from "./diff";
import { activitySnapshot, killAgentSessions, LEASE_TTL_MS } from "./autoreview";
import { listPiModels } from "./models";
import { listPiSkills, type CatalogSkill } from "./skills";
import { consumeShareToken, devWatchRestart, serveRestart } from "./restart";
import { gitCheckout, gitFileDiff, gitInfo, gitLineStats, gitStatusMap, resolveWorkspaces, type GitFileCode, type GitFileDiff, type GitInfo } from "./git";
import { contentTypeFor, listFiles, rawFilePath, readFile, searchFiles, type FileEntry } from "./files";

const errorStatus = { "not-found": 404, conflict: 409, invalid: 400 } as const;

/**
 * Map KanbanError to a typed `status()` response (treaty moves it to `error.value`);
 * anything else is a real bug and rethrows. Generic so a handler can declare its
 * success type and Eden infers `data` on the client.
 */
function fail<T>(e: unknown, status: (code: number, value: unknown) => unknown): T {
  if (e instanceof KanbanError) {
    return status(errorStatus[e.code], { error: e.message, code: e.code }) as T;
  }
  throw e;
}

/**
 * Coalescing change bus feeding /events: bursts of writes become one notification.
 * Each flush also drains the semantic lane-event tail once (`takeLaneEvents`);
 * each subscriber only sees entries newer than its join cursor — history is not
 * replayed (state sync via the initial `change` already covers catch-up). The
 * drained list also goes to the flush hook (osascript path) regardless of subscribers.
 */
function createChangeBus(
  joinCursor: () => number,
  takeLaneEvents: () => LaneEventFeedEntry[],
  onFlush?: (laneEvents: LaneEventFeedEntry[], subscribers: number) => void,
) {
  const subs = new Set<{ since: number; cb: (laneEvents: LaneEventFeedEntry[]) => void }>();
  let scheduled: ReturnType<typeof setTimeout> | null = null;
  return {
    subscriberCount(): number {
      return subs.size;
    },
    subscribe(cb: (laneEvents: LaneEventFeedEntry[]) => void): () => void {
      const sub = { since: joinCursor(), cb };
      subs.add(sub);
      return () => {
        subs.delete(sub);
      };
    },
    emit(): void {
      if (scheduled) return;
      scheduled = setTimeout(() => {
        scheduled = null;
        try {
          const laneEvents = takeLaneEvents();
          for (const sub of subs) sub.cb(laneEvents.filter((e) => e.rowid > sub.since));
          onFlush?.(laneEvents, subs.size);
        } catch {
          // a flush scheduled just before teardown (db closed) has nothing to deliver
        }
      }, 100);
    },
  };
}

/** Card title for notification copy: 80 chars max, `…` marks truncation. */
function truncateForNotification(title: string): string {
  return title.length > 80 ? title.slice(0, 80) + "…" : title;
}

/**
 * macOS-only fallback for when no board tab is open. JSON.stringify escapes `"` and
 * `\\`, which AppleScript honors — card titles cannot break out of the string literal.
 */
function defaultNotify(title: string, body: string): void {
  if (process.platform !== "darwin") return;
  try {
    Bun.spawn(
      ["osascript", "-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`],
      { stdout: "ignore", stderr: "ignore" },
    );
  } catch (err) {
    console.warn("[notify] osascript failed:", err);
  }
}

export const createApp = (
  db: KanbanDb,
  opts: {
    onDevRestart?: () => Promise<void>;
    onServeRestart?: () => Promise<void>;
    sessions?: () => number;
    filesRoot?: string;
    notify?: (title: string, body: string) => void; // test seam for the osascript fallback
  } = {}, // test seams for /restart and /files
) => {
  const notify = opts.notify ?? defaultNotify;
  const osascriptNotify = process.env.KANBAN_OSASCRIPT_NOTIFY === "1"; // opt-in, read once
  const laneCursor = { rowid: db.maxLaneEventRowid() }; // boot at the tail — history never replays
  const bus = createChangeBus(
    () => db.maxLaneEventRowid(), // join mark: anything already in the table is history, even if not yet flushed
    () => {
      const entries = db.laneEventsAfter(laneCursor.rowid);
      if (entries.length > 0) laneCursor.rowid = entries[entries.length - 1].rowid;
      return entries.filter((e) => e.cardTitle !== null); // deleted cards carry no payload
    },
    // server-side fallback for when no board tab is open: announce review entries locally
    (laneEvents, subscribers) => {
      if (!osascriptNotify || subscribers > 0) return;
      for (const e of laneEvents) {
        if (e.toLaneId === "review" && e.cardTitle !== null) {
          notify("kanban", `${truncateForNotification(e.cardTitle)} · ${e.taskId} entered Review`);
        }
      }
    },
  );
  const booted = Date.now(); // lets clients tell an old server from a restarted one
  db.watch(() => bus.emit()); // CLI writes commit from another connection
  return new Elysia()
    .use(cors({ origin: /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/ }))
    .onAfterHandle(({ request }) => {
      // API writes share the watched connection, so data_version won't see them
      if (request.method !== "GET") bus.emit();
    })
    .get("/events", ({ request }) => {
      const encoder = new TextEncoder();
      let closed = false;
      let unsubscribe: (() => void) | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
        request.signal.removeEventListener("abort", close);
      };
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (data: string) => {
              try {
                controller.enqueue(encoder.encode(data));
              } catch {
                close(); // stream already gone (client disconnected)
              }
            };
            send("event: change\ndata: {}\n\n"); // a fresh subscriber syncs right away
            unsubscribe = bus.subscribe((laneEvents) => {
              // semantic events precede the change they ride in on
              for (const e of laneEvents) {
                send(
                  `event: lane\ndata: ${JSON.stringify({
                    taskId: e.taskId,
                    title: e.cardTitle,
                    fromLaneId: e.fromLaneId,
                    toLaneId: e.toLaneId,
                    cause: e.cause,
                    actor: e.actor,
                    createdAt: e.createdAt,
                  })}\n\n`,
                );
              }
              send("event: change\ndata: {}\n\n");
            });
            heartbeat = setInterval(() => send(": ping\n\n"), 30_000);
            heartbeat.unref();
            request.signal.addEventListener("abort", close);
          },
          cancel() {
            close();
          },
        }),
        { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
      );
    })
    .get("/health", ({ headers }) => {
      // a respawn child presents the one-shot token its parent minted; the
      // incumbent vouches exactly once. The token itself never crosses the wire.
      const presented = headers["x-kanban-share-token"];
      const vouched = typeof presented === "string" && consumeShareToken(presented);
      return { ok: true, booted, share: vouched ? ("granted" as const) : undefined };
    })
    .post(
      "/restart",
      ({ request, status, query }) => {
        // drive-by guard: browsers always send Origin on cross-origin posts — only
        // local pages may trigger a restart; curl and same-origin UIs send none/local
        const origin = request.headers.get("origin");
        if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(origin))
          return status(403, { error: "restart is local-only", code: "forbidden" });
        // in-flight guard: a restart kills running agent sessions — make it explicit
        const inFlight = opts.sessions ? opts.sessions() : activitySnapshot().sessions.length;
        if (inFlight > 0 && query.force !== "true")
          return status(409, {
            error: `${inFlight} agent session(s) in flight — restart kills them; retry with force to proceed`,
            code: "sessions-in-flight",
            sessions: inFlight,
          });
        // fire after the response flushes: dev rewrites the watch marker, serve respawns itself
        const restart =
          process.env.KANBAN_DEV === "1"
            ? (opts.onDevRestart ?? devWatchRestart)
            : (opts.onServeRestart ?? serveRestart);
        setTimeout(() => void restart(), 250);
        return status(202, { restarting: true });
      },
      {
        response: {
          202: t.Object({ restarting: t.Boolean() }),
          403: t.Object({ error: t.String(), code: t.String() }),
          409: t.Object({ error: t.String(), code: t.String(), sessions: t.Number() }),
        },
      },
    )
    .get("/board", async (): Promise<BoardPayload> => {
      const board = db.board();
      const root = opts.filesRoot ?? process.cwd();
      const recordedBranches = board.tasks
        .map((t) => t.workspace)
        .filter((w): w is string => typeof w === "string" && w.length > 0);
      const live = await resolveWorkspaces(root, recordedBranches);
      const workspaces: Record<string, CardWorkspace> = {};
      for (const task of board.tasks) {
        if (task.workspace && live[task.workspace]) {
          workspaces[task.id] = live[task.workspace];
        }
      }
      return { ...board, workspaces };
    })
    .get("/stats", (): BoardStatsPayload => db.boardStats())
    .get("/git", (): Promise<GitInfo | { repo: false }> => gitInfo(process.cwd()))
    .post(
      "/git/checkout",
      async ({ body, status }): Promise<{ branch: string } | unknown> => {
        try {
          return status(200, { branch: await gitCheckout(process.cwd(), body.branch) });
        } catch (e) {
          return fail(e, status);
        }
      },
      { body: t.Object({ branch: t.String({ minLength: 1 }) }) },
    )
    .get(
      "/files",
      async ({ query, status }): Promise<{ path: string; entries: FileEntry[] }> => {
        try {
          const root = opts.filesRoot ?? process.cwd();
          const dirPath = query.path ?? "";
          return { path: dirPath, entries: await listFiles(root, dirPath) };
        } catch (e) {
          return fail<{ path: string; entries: FileEntry[] }>(e, status);
        }
      },
      {
        query: t.Object({
          path: t.Optional(t.String({ default: "" })),
        }),
      },
    )
    .get(
      "/files/content",
      async ({
        query,
        status,
      }): Promise<{
        path: string;
        content: string;
        language: string;
        size: number;
        binary: boolean;
      }> => {
        try {
          const root = opts.filesRoot ?? process.cwd();
          const file = await readFile(root, query.path);
          return {
            path: query.path,
            content: file.content,
            language: file.language,
            size: file.size,
            binary: file.binary,
          };
        } catch (e) {
          return fail<{
            path: string;
            content: string;
            language: string;
            size: number;
            binary: boolean;
          }>(e, status);
        }
      },
      {
        query: t.Object({
          path: t.String({ minLength: 1 }),
        }),
      },
    )
    .get(
      "/files/search",
      async ({ query }): Promise<{ matches: string[] }> => {
        const root = opts.filesRoot ?? process.cwd();
        const q = (query.q ?? "").trim();
        if (!q) return { matches: [] };
        const matches = await searchFiles(root, q, 20);
        return { matches };
      },
      {
        query: t.Object({
          q: t.Optional(t.String()),
        }),
      },
    )
    .get(
      "/files/raw",
      async ({ query, status }): Promise<Response> => {
        try {
          const root = opts.filesRoot ?? process.cwd();
          const target = await rawFilePath(root, query.path);
          const headers: Record<string, string> = {
            "Content-Type": contentTypeFor(target),
            "Content-Security-Policy": "default-src 'none'",
            "X-Content-Type-Options": "nosniff",
          };
          if (query.download === "1") {
            headers["Content-Disposition"] = `attachment; filename="${path.basename(target)}"`;
          }
          return new Response(Bun.file(target), { headers });
        } catch (e) {
          return fail<Response>(e, status);
        }
      },
      {
        query: t.Object({
          path: t.String({ minLength: 1 }),
          download: t.Optional(t.String()),
        }),
      },
    )
    .get(
      "/git/status",
      async (): Promise<{ files: Record<string, GitFileCode>; additions: number; deletions: number }> => {
        const root = opts.filesRoot ?? process.cwd();
        const [files, stats] = await Promise.all([
          gitStatusMap(root),
          gitLineStats(root),
        ]);
        return { files, additions: stats.additions, deletions: stats.deletions };
      },
    )
    .get(
      "/git/diff",
      async ({ query }): Promise<GitFileDiff> => {
        const root = opts.filesRoot ?? process.cwd();
        return gitFileDiff(root, query.path);
      },
      {
        query: t.Object({
          path: t.String({ minLength: 1 }),
        }),
      },
    )
    .post(
      "/tasks/:id/plan",
      ({ params, body, status }): Attachment | unknown => {
        try {
          return status(201, db.attach(params.id, "plan", body.content, body.source));
        } catch (e) {
          return fail(e, status);
        }
      },
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({
          content: t.String({ minLength: 1 }),
          source: t.Optional(t.String()),
        }),
      },
    )
    .get(
      "/tasks/:id/plan",
      ({ params, status }): Attachment | unknown => {
        try {
          const plan = db.latestPlan(params.id);
          if (!plan) throw new KanbanError(`no plan on task '${params.id}'`, "not-found");
          return plan;
        } catch (e) {
          return fail(e, status);
        }
      },
      { params: t.Object({ id: t.String() }) },
    )
    .post(
      "/tasks/:id/files",
      ({ params, body, status }): Attachment | unknown => {
        try {
          if (RESERVED_FILE_NAMES.has(body.name))
            throw new KanbanError(`'${body.name}' is reserved for the agent loop`, "invalid");
          return status(201, db.attach(params.id, body.name, body.content, body.source));
        } catch (e) {
          return fail(e, status);
        }
      },
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({
          name: t.String({ minLength: 1, maxLength: 64 }),
          content: t.String({ minLength: 1, maxLength: 1_000_000 }),
          source: t.Optional(t.String()),
        }),
      },
    )
    .get(
      "/tasks/:id/files",
      ({ params, status }): Attachment[] => {
        try {
          return db.latestFiles(params.id);
        } catch (e) {
          return fail<Attachment[]>(e, status);
        }
      },
      { params: t.Object({ id: t.String() }) },
    )
    .get(
      "/tasks/:id/files/:name",
      ({ params, status }): Attachment[] => {
        try {
          return db.attachments(params.id, params.name);
        } catch (e) {
          return fail<Attachment[]>(e, status);
        }
      },
      { params: t.Object({ id: t.String(), name: t.String() }) },
    )
    .get(
      "/tasks/:id/files/:name/diff",
      ({ params, query, status }): CardFileDiff => {
        try {
          return cardFileDiff(db, params.id, params.name, query.from, query.to);
        } catch (e) {
          return fail<CardFileDiff>(e, status);
        }
      },
      {
        params: t.Object({ id: t.String(), name: t.String() }),
        query: t.Object({
          from: t.Optional(t.Numeric({ minimum: 1 })),
          to: t.Optional(t.Numeric({ minimum: 1 })),
        }),
      },
    )
    .get(
      "/tasks/:id/comments",
      ({ params, status }): Comment[] => {
        try {
          return db.comments(params.id);
        } catch (e) {
          return fail<Comment[]>(e, status);
        }
      },
      { params: t.Object({ id: t.String() }) },
    )
    .get(
      "/tasks/:id/sessions",
      ({ params, status }): Attachment[] => {
        try {
          return db.attachments(params.id, "session");
        } catch (e) {
          return fail<Attachment[]>(e, status);
        }
      },
      { params: t.Object({ id: t.String() }) },
    )
    .post(
      "/tasks/:id/resume",
      ({ params, status }): { taskId: string; role: AgentRole; sessionId: string } | unknown => {
        try {
          const task = db.resolveTask(params.id);
          if (db.agentsPaused()) {
            return status(409, { error: "agent sessions are paused — unpause the loop before resuming", code: "conflict" });
          }
          if (db.waiting(task.id) !== "dead") {
            return status(409, {
              error: `card '${task.id}' is not waiting on a dead session — comment on it to re-run instead`,
              code: "conflict",
            });
          }
          if (db.leaseFor(task.id, LEASE_TTL_MS)) {
            return status(409, { error: `card '${task.id}' already has an agent session in flight`, code: "conflict" });
          }
          const session = db.cardSession(task.id);
          if (!session) {
            return status(409, {
              error: `card '${task.id}' has no recorded session to resume — comment on it to re-run instead`,
              code: "conflict",
            });
          }
          db.queueResume(task.id);
          return status(202, { taskId: task.id, role: session.role, sessionId: session.sessionId });
        } catch (e) {
          return fail(e, status);
        }
      },
      { params: t.Object({ id: t.String() }) },
    )
    .post(
      "/tasks/:id/elaborate",
      ({ params, status }): { taskId: string } | unknown => {
        try {
          const task = db.resolveTask(params.id);
          db.queueElaboration(task.id);
          return status(202, { taskId: task.id });
        } catch (e) {
          return fail(e, status);
        }
      },
      { params: t.Object({ id: t.String() }) },
    )
    .post(
      "/tasks/:id/links",
      ({ params, body, status, set }): { linked: Task[] } => {
        try {
          const linked = db.linkCards(params.id, body.target);
          set.status = 201;
          return { linked };
        } catch (e) {
          return fail<{ linked: Task[] }>(e, status);
        }
      },
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({
          target: t.String({ minLength: 1 }),
        }),
      },
    )
    .delete(
      "/tasks/:id/links/:targetId",
      ({ params, status }): { ok: true; removed: boolean } => {
        try {
          return { ok: true, removed: db.unlinkCards(params.id, params.targetId) };
        } catch (e) {
          return fail<{ ok: true; removed: boolean }>(e, status);
        }
      },
      {
        params: t.Object({ id: t.String(), targetId: t.String() }),
      },
    )
    .post(
      "/tasks/:id/comments",
      ({ params, body, status, set }): Comment => {
        try {
          const { comment } = db.comment(params.id, body);
          set.status = 201;
          return comment;
        } catch (e) {
          return fail(e, status);
        }
      },
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({
          body: t.String({ minLength: 1 }),
          author: t.Optional(t.String()),
          kind: t.Optional(
            t.Union([t.Literal("comment"), t.Literal("review"), t.Literal("handoff")]),
          ),
        }),
      },
    )
    .post(
      "/tasks/:id/approve",
      ({ params, body, status }): { task: Task; comment: Comment } | unknown => {
        try {
          return status(201, db.approveTask(params.id, { author: body?.author, message: body?.message }));
        } catch (e) {
          return fail(e, status);
        }
      },
      {
        params: t.Object({ id: t.String() }),
        body: t.Optional(
          t.Object({
            author: t.Optional(t.String()),
            message: t.Optional(t.String()),
          }),
        ),
      },
    )
    .post(
      "/tasks/:id/reject",
      ({ params, body, status }): Comment | unknown => {
        try {
          return status(201, db.rejectTask(params.id, body.message, { author: body.author }));
        } catch (e) {
          return fail(e, status);
        }
      },
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({
          message: t.String({ minLength: 1 }),
          author: t.Optional(t.String()),
        }),
      },
    )
    .post(
      "/tasks",
      ({ body, status }): Task | unknown => {
        try {
          const task = db.createTask(body);
          if (body.elaborate === true) db.queueElaboration(task.id);
          return status(201, task);
        } catch (e) {
          return fail(e, status);
        }
      },
      {
        body: t.Object({
          title: t.String({ minLength: 1 }),
          note: t.Optional(t.String()),
          lane: t.Optional(t.String()),
          project: t.Optional(t.String()),
          tags: t.Optional(t.Array(t.String())),
          parent: t.Optional(t.Nullable(t.String())),
          priority: t.Optional(t.Enum({ high: "high", normal: "normal", low: "low" })),
          blockedBy: t.Optional(t.Array(t.String())),
          index: t.Optional(t.Number({ minimum: 0 })),
          elaborate: t.Optional(t.Boolean()),
        }),
      },
    )
    .patch(
      "/tasks/:id",
      ({ params, body, status }): Task | unknown => {
        try {
          return db.updateTask(params.id, body);
        } catch (e) {
          return fail(e, status);
        }
      },
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({
          title: t.Optional(t.String()),
          note: t.Optional(t.String()),
          project: t.Optional(t.String()),
          tags: t.Optional(t.Array(t.String())),
          lane: t.Optional(t.String()),
          parent: t.Optional(t.Nullable(t.String())),
          workspace: t.Optional(t.Nullable(t.String())),
          priority: t.Optional(t.Enum({ high: "high", normal: "normal", low: "low" })),
          blockedBy: t.Optional(t.Array(t.String())),
          index: t.Optional(t.Number({ minimum: 0 })),
        }),
      },
    )
    .delete(
      "/tasks/:id",
      ({ params, query, status }): unknown => {
        try {
          db.deleteTask(params.id, query.force === "true");
          return { ok: true };
        } catch (e) {
          return fail(e, status);
        }
      },
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({ force: t.Optional(t.String()) }),
      },
    )
    .post(
      "/lanes",
      ({ body, status }): Lane | unknown => {
        try {
          return status(201, db.createLane(body));
        } catch (e) {
          return fail(e, status);
        }
      },
      {
        body: t.Object({
          name: t.String({ minLength: 1 }),
          description: t.Optional(t.String()),
          index: t.Optional(t.Number({ minimum: 0 })),
        }),
      },
    )
    .patch(
      "/lanes/:id",
      ({ params, body, status }): Lane | unknown => {
        try {
          return db.updateLane(params.id, body);
        } catch (e) {
          return fail(e, status);
        }
      },
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({
          name: t.Optional(t.String()),
          description: t.Optional(t.String()),
          index: t.Optional(t.Number({ minimum: 0 })),
        }),
      },
    )
    .get(
      "/agents",
      (): { planner: AgentConfig | null; reviewer: AgentConfig | null; builder: AgentConfig | null; "plan-reviewer": AgentConfig | null; elaborator: AgentConfig | null } => ({
        planner: db.agentConfig("planner"),
        reviewer: db.agentConfig("reviewer"),
        builder: db.agentConfig("builder"),
        "plan-reviewer": db.agentConfig("plan-reviewer"),
        elaborator: db.agentConfig("elaborator"),
      }),
    )
    .get("/agents/pause", (): { paused: boolean } => ({ paused: db.agentsPaused() }))
    .put(
      "/agents/pause",
      ({ body }): { paused: boolean } => {
        const paused = db.setAgentsPaused(body.paused);
        if (paused) {
          const killed = killAgentSessions();
          if (killed > 0) console.log(`[autoreview] paused — killed ${killed} in-flight session${killed === 1 ? "" : "s"}`);
        }
        return { paused };
      },
      { body: t.Object({ paused: t.Boolean() }) },
    )
    .get("/pi-models", async (): Promise<{ models: Awaited<ReturnType<typeof listPiModels>> }> => ({
      models: await listPiModels(),
    }))
    .get("/pi-skills", (): { skills: CatalogSkill[] } => ({
      skills: listPiSkills(),
    }))
    .get("/activity", (): ReturnType<typeof activitySnapshot> => activitySnapshot())
    .put(
      "/agents/:role",
      ({ params, body, status }): AgentConfig | unknown => {
        try {
          return status(200, db.setAgentConfig(params.role, body));
        } catch (e) {
          return fail(e, status);
        }
      },
      {
        params: t.Object({ role: t.Union([t.Literal("planner"), t.Literal("reviewer"), t.Literal("builder"), t.Literal("plan-reviewer"), t.Literal("elaborator")]) }),
        body: t.Object({
          provider: t.Optional(t.String()),
          model: t.Optional(t.String()),
          thinking: t.Optional(
            t.Union([
              t.Literal(""),
              t.Literal("off"),
              t.Literal("minimal"),
              t.Literal("low"),
              t.Literal("medium"),
              t.Literal("high"),
              t.Literal("xhigh"),
              t.Literal("max"),
            ]),
          ),
          skills: t.Optional(t.Array(t.String({ minLength: 1 }))),
          context: t.Optional(t.String()),
          tools: t.Optional(t.String()),
          extraArgs: t.Optional(t.Array(t.String({ minLength: 1 }))),
          timeoutMs: t.Optional(t.Number({ minimum: 60_000, maximum: 86_400_000 })),
        }),
      },
    )
    .get("/pools", (): { pools: WorkerPool[]; settings: { maxWorkers: number } } => ({
      pools: db.pools(),
      settings: { maxWorkers: db.maxWorkers() },
    }))
    .put(
      "/pools/settings",
      ({ body, status }): { maxWorkers: number } | unknown => {
        try {
          return status(200, { maxWorkers: db.setMaxWorkers(body.maxWorkers) });
        } catch (e) {
          return fail(e, status);
        }
      },
      {
        body: t.Object({
          maxWorkers: t.Number({ minimum: 1, maximum: 20 }),
        }),
      },
    )
    .put(
      "/pools/:id",
      ({ params, body, status }): WorkerPool | unknown => {
        try {
          return status(200, db.setPool(params.id, body));
        } catch (e) {
          return fail(e, status);
        }
      },
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({
          name: t.String({ minLength: 1, maxLength: 60 }),
          enabled: t.Optional(t.Boolean()),
          roles: t.Array(t.Union([t.Literal("planner"), t.Literal("reviewer"), t.Literal("builder"), t.Literal("plan-reviewer"), t.Literal("elaborator")]), { minItems: 1 }),
          slots: t.Array(t.Object({ provider: t.Optional(t.String()), model: t.Optional(t.String()), thinking: t.Optional(t.Union([t.Literal(""), t.Literal("off"), t.Literal("minimal"), t.Literal("low"), t.Literal("medium"), t.Literal("high"), t.Literal("xhigh"), t.Literal("max")])) }), { minItems: 1, maxItems: 8 }),
          maxWorkers: t.Optional(t.Number({ minimum: 1 })),
        }),
      },
    )
    .delete(
      "/pools/:id",
      ({ params, status }): { ok: true } | unknown => {
        try {
          db.deletePool(params.id);
          return { ok: true as const };
        } catch (e) {
          return fail(e, status);
        }
      },
      {
        params: t.Object({ id: t.String() }),
      },
    )
    .delete(
      "/lanes/:id",
      ({ params, query, status }): unknown => {
        try {
          return db.deleteLane(params.id, query.force === "true");
        } catch (e) {
          return fail(e, status);
        }
      },
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({ force: t.Optional(t.String()) }),
      },
    );
};

export const app = createApp(new KanbanDb(defaultDbPath()));
export type App = typeof app;
