import { expect, test } from "@playwright/test";

// Seed via the request API (same idiom as responsive.e2e.ts): limit 2 on
// implement, then three cards in it — one over the limit.
test.beforeAll(async ({ request }) => {
  await request.patch("/lanes/implement", { data: { wipLimit: 2 } });
  for (const title of ["wip-e2e 1", "wip-e2e 2", "wip-e2e 3"]) {
    await request.post("/tasks", { data: { title, lane: "implement" } });
  }
});

const implementChip = (page: import("@playwright/test").Page) =>
  page.locator("section.lane[aria-label='Test + Implement'] .lane-head .count").first();

test("AC6: lane chip shows count/limit and turns amber when over", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("main.board");
  await page.waitForSelector("[data-card]");

  const chip = implementChip(page);
  await expect(chip).toHaveText("3/2");
  await expect(chip).toHaveClass(/over/);
});

test("AC6: double-click, clear input, Enter → limit cleared; set 5 → 3/5; reload persists", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("main.board");
  await page.waitForSelector("[data-card]");
  const chip = implementChip(page);
  await expect(chip).toHaveText("3/2");

  // Clear: double-click opens the input, empty + Enter commits null.
  await chip.dblclick();
  const input = page.locator("section.lane[aria-label='Test + Implement'] .lane-head input.limit-input");
  await expect(input).toBeVisible();
  await input.fill("");
  await input.press("Enter");

  await expect(chip).toHaveText("3");
  await expect(chip).not.toHaveClass(/over/);

  // Set 5.
  await chip.dblclick();
  await expect(input).toBeVisible();
  await input.fill("5");
  await input.press("Enter");
  await expect(chip).toHaveText("3/5");
  await expect(chip).not.toHaveClass(/over/);

  // State survives reload via /board.
  await page.reload();
  await page.waitForSelector("main.board");
  await page.waitForSelector("[data-card]");
  await expect(implementChip(page)).toHaveText("3/5");
});
