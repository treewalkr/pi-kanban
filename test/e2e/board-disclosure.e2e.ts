import { expect, test } from "@playwright/test";

// Board disclosure state survives a reload (card bpdnc). Seeds a parent + two
// children in backlog only — never implement/done — so wip.e2e.ts's exact 3/2
// chip and velocity.e2e.ts's done-bar counts are untouched; the "disclosure "
// title prefix keeps drag-reorder.e2e.ts's "drag "-prefixed order assertions
// blind to these cards. The afterAll cleanup matters beyond counts: a lingering
// parent renders the repo's only .disclosure button during responsive.e2e.ts's
// 24px-minimum control scan and fails it. Each test gets a fresh browser
// context, so localStorage starts empty: the pre-click assertions cover the AC3
// default (nothing expanded), and the reload is the only seam that exercises the
// real constructor-time hydration of kanban-expanded-parents.
let ids: Record<string, string>;

test.beforeAll(async ({ request }) => {
  const mk = async (title: string, parent?: string) => {
    const res = await request.post("/tasks", { data: { title, lane: "backlog", parent } });
    expect(res.ok()).toBe(true);
    return (await res.json()).id as string;
  };
  ids = { parent: await mk("disclosure parent") };
  ids.c1 = await mk("disclosure child 1", ids.parent);
  ids.c2 = await mk("disclosure child 2", ids.parent);
});

test.afterAll(async ({ request }) => {
  // don't linger on the shared board (same convention as drag-reorder.e2e.ts)
  for (const id of [ids.c1, ids.c2, ids.parent]) {
    await request.delete(`/tasks/${id}`, { params: { force: "true" } });
  }
});

const parentCard = (page: import("@playwright/test").Page) => page.locator(`[data-card="${ids.parent}"]`);

test("expanded subtasks survive a reload", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(`[data-card="${ids.parent}"]`);

  // AC3: a fresh context (empty localStorage) renders the parent collapsed
  const disc = parentCard(page).locator("button.disclosure");
  await expect(disc).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(`[data-card="${ids.c1}"]`)).toHaveCount(0);

  await disc.click();
  await expect(disc).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(`[data-card="${ids.c1}"]`)).toBeVisible();
  await expect(page.locator(`[data-card="${ids.c2}"]`)).toBeVisible();

  // AC1: the toggle wrote the persisted key
  const stored = await page.evaluate(() => localStorage.getItem("kanban-expanded-parents"));
  expect(JSON.parse(stored ?? "[]")).toContain(ids.parent);

  await page.reload();
  await page.waitForSelector(`[data-card="${ids.parent}"]`);

  // AC2: hydration at construction re-expanded the parent
  const reloadedDisc = parentCard(page).locator("button.disclosure");
  await expect(reloadedDisc).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(`[data-card="${ids.c1}"]`)).toBeVisible();
  await expect(page.locator(`[data-card="${ids.c2}"]`)).toBeVisible();
  const reloaded = await page.evaluate(() => localStorage.getItem("kanban-expanded-parents"));
  expect(JSON.parse(reloaded ?? "[]")).toContain(ids.parent);
});

test("collapsing a parent survives a reload", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(`[data-card="${ids.parent}"]`);

  const disc = parentCard(page).locator("button.disclosure");
  await disc.click(); // expand
  await expect(page.locator(`[data-card="${ids.c1}"]`)).toBeVisible();
  await disc.click(); // collapse again
  await expect(disc).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(`[data-card="${ids.c1}"]`)).toHaveCount(0);

  await page.reload();
  await page.waitForSelector(`[data-card="${ids.parent}"]`);

  await expect(parentCard(page).locator("button.disclosure")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(`[data-card="${ids.c1}"]`)).toHaveCount(0);
  const stored = await page.evaluate(() => localStorage.getItem("kanban-expanded-parents"));
  expect(JSON.parse(stored ?? "[]")).not.toContain(ids.parent);
});
