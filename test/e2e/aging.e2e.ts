import { expect, test } from "@playwright/test";

// Aging: the lane-age chip on both views (AC1) and the auto-archive setting
// surface (AC2). Positive sweep behavior is pinned by unit tests with
// injectable `now` (test/autoarchive.test.ts) — real time-travel is impossible
// from the browser, so the e2e keeps the negative control instead.

const seedTask = async (
  request: import("@playwright/test").APIRequestContext,
  title: string,
  lane: string,
): Promise<string> => {
  const res = await request.post("/tasks", { data: { title, lane } });
  return ((await res.json()) as { id: string }).id;
};

test.describe("aging indicators + auto-archive", () => {
  test("AC1: board and list cards show a lane-age chip", async ({
    page,
    request,
  }) => {
    // backlog, own card, cleaned up below: wip.e2e asserts an exact implement
    // count and responsive.e2e measures board width — a new lane or an
    // implement card would break them under the shared repro server
    const id = await seedTask(request, "aging-e2e chip card", "backlog");
    await page.goto("/");
    await page.waitForSelector("main.board");
    await page.waitForSelector("[data-card]");

    // board view: the chip reuses the .age span and tooltips the lane-entry timestamp
    const cardAge = page.locator(`.card[data-card='${id}'] .age`);
    await expect(cardAge).toHaveText(/^\d+[smhdw]$/);
    expect(await cardAge.getAttribute("title")).toMatch(/^in Backlog since /);

    // list view (persisted via kanban-view): same assertions on the row's chip
    await page.evaluate(() => localStorage.setItem("kanban-view", "list"));
    await page.reload();
    await page.waitForSelector("main.list");
    const rowAge = page.locator(`.row[data-card='${id}'] .age`);
    await expect(rowAge).toHaveText(/^\d+[smhdw]$/);
    expect(await rowAge.getAttribute("title")).toMatch(/^in Backlog since /);

    await request.delete(`/tasks/${id}?force=true`); // don't linger on the shared board
  });

  test("AC2: settings panel edits auto-archive days", async ({
    page,
    request,
  }) => {
    await request.put("/autoarchive", { data: { days: 14 } });
    await page.goto("/");
    await page.waitForSelector("main.board");

    await page.click("button[aria-label='settings']");
    const input = page.locator("input[aria-label='auto-archive days']");
    await expect(input).toHaveValue("14");

    // setting 1 lands on the server
    await input.fill("1");
    await input.blur();
    const get = await request.get("/autoarchive");
    expect(await get.json()).toEqual({ days: 1 });

    // disable sets 0 and shows the off copy (aria-label disambiguates from the
    // notifications disable button in the same panel)
    await page.getByRole("button", { name: "disable auto-archive" }).click();
    await expect(
      page.locator(".settings-dev-note", {
        hasText: "off — done cards stay put",
      }),
    ).toBeVisible();
    const afterOff = await request.get("/autoarchive");
    expect(await afterOff.json()).toEqual({ days: 0 });

    await request.put("/autoarchive", { data: { days: 7 } }); // restore the default window
  });

  test("AC2: a fresh done card is not swept early (negative control)", async ({
    page,
    request,
  }) => {
    const id = await seedTask(request, "aging-e2e negative control", "backlog");
    await request.patch(`/tasks/${id}`, { data: { lane: "done" } });

    await page.goto("/");
    await page.waitForSelector("main.board");
    await page.waitForSelector("[data-card]");
    await expect(page.locator(`.card[data-card='${id}']`)).toBeVisible();

    // the repro server's sweep runs hourly (its boot sweep just ran) — 2 s is
    // nowhere near the 7-day window, so the card must still sit in Done
    await page.waitForTimeout(2000);
    await page.reload();
    await page.waitForSelector("main.board");
    await expect(page.locator(`.card[data-card='${id}']`)).toBeVisible();

    await request.delete(`/tasks/${id}?force=true`);
  });
});
