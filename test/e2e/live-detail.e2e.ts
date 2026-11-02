import { expect, test, type Page } from "@playwright/test";

// Card 8fp65: a read-only card detail live-derives board fields and refetches
// its thread on every board refresh, so external writes (CLI, agent, another
// tab) appear without reopening; only the TaskEditor pauses board refreshes,
// and closing it still lands the catch-up. Mutations go through the API via
// Playwright's `request` — the real external-writer path (change bus → SSE).

async function openBoard(page: Page): Promise<void> {
  // register before goto — the EventSource opens as soon as the board hydrates
  const eventsReady = page.waitForResponse((res) => res.url().endsWith("/events") && res.status() === 200);
  await page.goto("/");
  await page.waitForSelector("main.board");
  await eventsReady;
  await page.waitForTimeout(200); // initial `change` consumed; join cursor is set
}

const seedTask = async (
  request: import("@playwright/test").APIRequestContext,
  title: string,
  lane: string,
): Promise<string> => {
  const res = await request.post("/tasks", { data: { title, lane } });
  return ((await res.json()) as { id: string }).id;
};

const openDetail = async (page: Page, id: string): Promise<void> => {
  await page.click(`.card[data-card='${id}']`);
  await expect(page.locator("div.editor.detail")).toBeVisible();
};

test.describe("live card detail while an external writer edits", () => {
  test("AC1: external note and title edits appear in the open detail", async ({
    page,
    request,
  }) => {
    const id = await seedTask(request, "live-detail target", "backlog");
    await openBoard(page);
    await openDetail(page, id);

    await request.patch(`/tasks/${id}`, {
      data: { title: "externally retitled", note: "external note edit — live" },
    });

    const detail = page.locator("div.editor.detail");
    await expect(detail.locator(".detail-title")).toHaveText("externally retitled");
    await expect(detail.locator(".detail-note").first()).toContainText("external note edit — live");
    // the read-only detail must not have flipped into the editor
    await expect(page.locator("div.editor[aria-label='edit card']")).toHaveCount(0);

    await request.delete(`/tasks/${id}?force=true`);
  });

  test("AC2: external thread comments appear in the open detail", async ({
    page,
    request,
  }) => {
    const id = await seedTask(request, "live-detail thread target", "backlog");
    await openBoard(page);
    await openDetail(page, id);
    await expect(
      page.locator("div.editor.detail .children-head", { hasText: "thread ·" }),
    ).toHaveText(/thread · 0/);

    // thread writes bump no task field — only the board-refresh-triggered
    // reloadThread effect can surface them
    await request.post(`/tasks/${id}/comments`, {
      data: { body: "live from the cli writer", author: "cli-user" },
    });

    await expect(
      page.locator("div.editor.detail .children-head", { hasText: "thread ·" }),
    ).toHaveText(/thread · 1/);
    await expect(page.locator("div.editor.detail .comment-list .comment-body")).toContainText(
      "live from the cli writer",
    );

    await request.delete(`/tasks/${id}?force=true`);
  });

  test("AC3: an externally attached plan appears in the open detail", async ({
    page,
    request,
  }) => {
    const id = await seedTask(request, "live-detail plan target", "backlog");
    await openBoard(page);
    await openDetail(page, id);
    // the plan section shares its class with files/sessions/chat sections
    const planSection = page.locator(
      "div.editor.detail details.detail-plan:not(.card-files):not(.agent-sessions):not(.chat-section)",
    );
    await expect(planSection).toHaveCount(0);

    await request.post(`/tasks/${id}/plan`, { data: { content: "## plan body from cli" } });

    await expect(planSection).toBeVisible();
    await expect(planSection.locator("summary")).toContainText("v1");
    await planSection.locator("summary").click(); // open the collapsed <details>
    await expect(planSection.locator(".detail-note")).toContainText("plan body from cli");

    await request.delete(`/tasks/${id}?force=true`);
  });

  test("AC4: external lane and tag changes appear live in detail and on the board", async ({
    page,
    request,
  }) => {
    const id = await seedTask(request, "live-detail metadata target", "backlog");
    await openBoard(page);
    await openDetail(page, id);

    await request.patch(`/tasks/${id}`, { data: { lane: "done", tags: ["live-tag"] } });

    const detail = page.locator("div.editor.detail");
    await expect(detail.locator(".detail-lane")).toHaveText("Done");
    await expect(detail.locator(".detail-head .chip.tag", { hasText: "#live-tag" })).toBeVisible();

    await page.keyboard.press("Escape"); // close the modal; the board behind already moved
    const card = page.locator(`section.lane[data-lane='done'] .card[data-card='${id}']`);
    await expect(card).toBeVisible();
    await expect(card.locator(".chip.tag", { hasText: "#live-tag" })).toBeVisible();

    await request.delete(`/tasks/${id}?force=true`);
  });

  test("AC5: the editor pauses refreshes and the close catch-up still lands", async ({
    page,
    request,
  }) => {
    const id = await seedTask(request, "snapshot target", "backlog");
    await openBoard(page);
    await openDetail(page, id);
    await page.getByRole("button", { name: "edit", exact: true }).click();
    const editor = page.locator("div.editor[aria-label='edit card']");
    await expect(editor).toBeVisible();

    // (a) the form keeps its open-time snapshot while an external write lands
    await request.patch(`/tasks/${id}`, { data: { title: "externally renamed" } });
    await page.waitForTimeout(600); // well under the 10s interval that could false-refresh
    const titleInput = editor.locator("label", { hasText: "title" }).locator("input");
    await expect(titleInput).toHaveValue("snapshot target");

    // (b) option lists don't shift either: a new card is not a parent candidate
    const parentOptions = editor.locator("label:has-text('parent') select option");
    const before = await parentOptions.count();
    const probe = await seedTask(request, "catch-up probe card", "backlog");
    await page.waitForTimeout(600);
    expect(await parentOptions.count()).toBe(before);

    // (c) closing the editor runs the catch-up: both external writes land
    await page.keyboard.press("Escape");
    await expect(page.locator(`.card[data-card='${probe}'] .card-title`)).toHaveText(
      "catch-up probe card",
    );
    await expect(page.locator(`.card[data-card='${id}'] .card-title`)).toHaveText(
      "externally renamed",
    );

    await request.delete(`/tasks/${id}?force=true`);
    await request.delete(`/tasks/${probe}?force=true`);
  });
});
