import { expect, test, type Page } from "@playwright/test";

// Card 2sm4x: session-log lines and chat messages carry their times. Both the
// live /activity log and the saved session logs render a left-gutter stamp;
// chat rows (card panel + manager drawer) show the time next to the model
// label / above the user bubble. /activity and /tasks/:id/sessions and
// /chat/board are fulfilled via page.route — register before goto so the 2s
// poll and the drawer's GET hit the mocks.

test.use({ timezoneId: "UTC" });

async function openBoard(page: Page): Promise<void> {
  await page.goto("/");
  await page.waitForSelector("main.board");
}

const seedTask = async (
  request: import("@playwright/test").APIRequestContext,
  title: string,
  lane: string,
): Promise<string> => {
  const res = await request.post("/tasks", { data: { title, lane } });
  return ((await res.json()) as { id: string }).id;
};

test.describe("session log and chat stamps", () => {
  test("card detail shows stamped live and saved session logs; legacy logs stay plain", async ({
    page,
    request,
  }) => {
    const id = await seedTask(request, "stamps live+saved", "backlog");
    const now = Date.now();
    const at0 = now - 60_000;
    const at1 = now - 5 * 60_000;
    const attachment = (version: number, content: string) => ({
      id: `stamps-${version}`,
      taskId: id,
      kind: "session",
      version,
      content,
      source: "",
      createdAt: now,
    });
    await page.route("**/activity", (route) =>
      route.fulfill({
        json: {
          sessions: [
            {
              taskId: id,
              role: "builder",
              startedAt: at0 - 1000,
              lastActivityAt: at1,
              modelLabel: "m",
              log: ["model: m", "→ bash: bun test"],
              logAt: [at0, at1],
            },
          ],
          queued: [],
          incidents: [],
          engines: [],
        },
      }),
    );
    await page.route(`**/tasks/${id}/sessions`, (route) =>
      route.fulfill({
        json: [
          attachment(1, "pi-reviewer · x · 5s\nmodel: old"),
          attachment(2, "pi-builder · m · d · 42s\n08:15:42 model: m\n08:16:03 stderr tail:\n         boom"),
        ],
      }),
    );

    await openBoard(page);
    await page.click(`.card[data-card='${id}']`);
    const detail = page.locator("div.editor.detail");

    // live: second row carries HH:MM:SS (UTC test tz) and its text
    const liveSecond = detail.locator(".detail-activity .activity-log.stamped .line").nth(1);
    await expect(liveSecond.locator(".line-time")).toHaveText(new Date(at1).toISOString().slice(11, 19));
    await expect(liveSecond.locator(".line-text")).toHaveText("→ bash: bun test");

    // saved: the newest session log is stamped; continuation lines get an empty gutter
    await detail.locator(".agent-sessions > summary").click();
    const openLogs = page.locator(".agent-sessions .session-log");
    await openLogs.last().locator("> summary").click();
    const saved = openLogs.last().locator(".activity-log.stamped");
    await expect(saved.locator(".line-time")).toHaveText(["08:15:42", "08:16:03", ""]);
    await expect(saved.locator(".line-text").nth(2)).toHaveText("boom");

    // legacy: no stamp column at all
    await openLogs.first().locator("> summary").click();
    const legacy = openLogs.first().locator("> .activity-log");
    await expect(legacy).not.toHaveClass(/stamped/);
    await expect(legacy.locator(".line-time")).toHaveCount(0);

    await request.delete(`/tasks/${id}?force=true`);
  });

  test("chat rows show message times next to the model label; untimed messages show none", async ({
    page,
  }) => {
    const now = Date.now();
    const tA = now - 10 * 60_000;
    await page.route("**/chat/board", (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      return route.fulfill({
        json: {
          running: true,
          sessionId: "kanban-chat-board",
          isStreaming: false,
          isCompacting: false,
          queued: { steering: [], followUp: [] },
          model: { provider: "zai", id: "glm-5.3" },
          thinkingLevel: "off",
          thinkingLevels: ["off", "low", "medium", "high"],
          supportsThinking: true,
          messages: [
            { role: "user", content: "old", at: Date.UTC(2026, 0, 2, 3, 4, 5), entryId: "u1" },
            {
              role: "assistant",
              blocks: [{ type: "text", text: "hi" }],
              model: "glm-5.3",
              provider: "zai",
              at: tA,
              entryId: "a1",
            },
            { role: "user", content: "legacy", entryId: "u2" },
          ],
          messagesTruncated: false,
        },
      });
    });

    await openBoard(page);
    await page.getByRole("button", { name: "Board chat" }).click();
    const drawer = page.locator(".manager-drawer");

    await expect(drawer.locator(".chat-msg-time")).toHaveCount(2);
    const userStamp = drawer.locator(".chat-msg-time.user");
    await expect(userStamp).toHaveText("Jan 2 03:04");
    await expect(userStamp).toHaveAttribute("datetime", "2026-01-02T03:04:05.000Z");
    const head = drawer.locator(".chat-msg-head");
    await expect(head.locator(".chat-msg-time")).toHaveText(new Date(tA).toISOString().slice(11, 19));
    await expect(head.locator(".chat-msg-model")).toHaveText("zai/glm-5.3");
    // the legacy user row renders its bubble but no stamp
    await expect(drawer.locator(".chat-msg.user").last()).toHaveText("legacy");
  });
});
