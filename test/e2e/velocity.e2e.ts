import { expect, test } from "@playwright/test";

// Seed via the request API (same idiom as wip.e2e.ts): five cards start in
// backlog, three travel backlog → implement → done (one current-week bucket of
// 3), two stay in backlog. The stay-cards must never enter implement: wip.e2e.ts
// (parallel worker, same suite) asserts the implement chip is exactly 3/2, and
// extra cards there break it deterministically. Gives every metric the velocity
// view renders: done-cards-per-week (3 in the current week) and dwell for
// backlog (5 cards) + implement (3 passed through).
test.beforeAll(async ({ request }) => {
  const throughIds: string[] = [];
  for (const title of ["velocity-e2e 1", "velocity-e2e 2", "velocity-e2e 3", "velocity-e2e stay 1", "velocity-e2e stay 2"]) {
    const res = await request.post("/tasks", { data: { title } });
    expect(res.ok()).toBe(true);
    const task = (await res.json()) as { id: string };
    throughIds.push(task.id);
  }
  for (const id of throughIds.slice(0, 3)) {
    await request.patch(`/tasks/${id}`, { data: { lane: "implement" } });
    await request.patch(`/tasks/${id}`, { data: { lane: "done" } });
  }
  // stay-cards 4 and 5 remain in backlog — no patch needed
});

async function openVelocity(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.waitForSelector("main.board");
  await page.getByRole("tab", { name: "velocity" }).click();
  await page.waitForSelector("section.velocity");
}

test("AC1: throughput bars show done counts per week, current week last", async ({ page }) => {
  await openVelocity(page);

  const bars = page.locator(".tp-chart .tp-bar");
  await expect(bars).toHaveCount(8);

  // only the seeded trio reached done — exactly one bar carries data-done="3"
  const done3 = page.locator('.tp-chart .tp-bar[data-done="3"]');
  await expect(done3).toHaveCount(1);

  // it is the last bar (payload is oldest first, current week last) …
  await expect(bars.last()).toHaveAttribute("data-done", "3");
  // … and carries the current-week class
  await expect(done3).toHaveClass(/current/);
});

test("AC2: lane cycle rows show average dwell in lane order", async ({ page }) => {
  await openVelocity(page);

  const backlog = page.locator('.lane-row[data-lane="backlog"]');
  const implement = page.locator('.lane-row[data-lane="implement"]');
  await expect(backlog).toBeVisible();
  await expect(implement).toBeVisible();

  // each row shows a formatted duration and has a bar
  for (const row of [backlog, implement]) {
    await expect(row).toContainText(/\d+[smhdw]/);
    await expect(row.locator(".lane-bar")).toBeVisible();
  }

  // board lane order: backlog row precedes implement row in the DOM
  const order = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".lane-row")).map(
      (r) => (r as HTMLElement).dataset.lane,
    ),
  );
  expect(order.indexOf("backlog")).toBeGreaterThanOrEqual(0);
  expect(order.indexOf("backlog")).toBeLessThan(order.indexOf("implement"));
});

test("velocity tab persists across reload", async ({ page }) => {
  await openVelocity(page);
  await expect(page.locator(".tp-chart")).toBeVisible();

  const stored = await page.evaluate(() => localStorage.getItem("kanban-view"));
  expect(stored).toBe("velocity");

  await page.reload();
  await expect(page.locator(".tp-chart")).toBeVisible();
});
