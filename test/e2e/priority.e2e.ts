import { expect, test } from "@playwright/test";

// The priority chip cycles high → normal → low per click and persists (card
// hquwn). Seeds in backlog only — never implement/done — so wip.e2e.ts's exact
// lane counts and velocity.e2e.ts's done-bar stay untouched; the "priority "
// title prefix keeps drag-reorder.e2e.ts's "drag "-prefixed order assertions
// blind to these cards. afterAll force-deletes so the cards don't linger on
// the shared board.
let ids: Record<string, string>;

test.beforeAll(async ({ request }) => {
  const mk = async (title: string) => {
    const res = await request.post("/tasks", { data: { title, lane: "backlog" } });
    expect(res.ok()).toBe(true);
    return (await res.json()).id as string;
  };
  ids = { click: await mk("priority cycle by click"), keys: await mk("priority cycle by keyboard") };
});

test.afterAll(async ({ request }) => {
  for (const id of [ids.click, ids.keys]) {
    await request.delete(`/tasks/${id}`, { params: { force: "true" } });
  }
});

const chip = (page: import("@playwright/test").Page, id: string) =>
  page.locator(`[data-card="${id}"]`).locator("button.prio-chip");

test("clicking the chip cycles high → normal → low and persists after reload", async ({ page }) => {
  await page.goto("/");
  const c = chip(page, ids.click);
  await c.waitFor();

  // default state: normal, accessible name carries the card id
  await expect(c).toHaveAccessibleName(new RegExp(`priority ${ids.click}: normal`));
  await expect(c).toHaveClass(/prio-normal/);

  await c.click(); // normal → low
  await expect(c).toHaveText("▼");
  await expect(c).toHaveClass(/prio-low/);
  await c.click(); // low → high (the cycle wraps)
  await expect(c).toHaveAccessibleName(new RegExp(`priority ${ids.click}: high`));
  await expect(c).toHaveText("▲");
  await expect(c).toHaveClass(/prio-high/);
  await c.click(); // high → normal
  await expect(c).toHaveText("·");

  await page.reload();
  await chip(page, ids.click).waitFor();
  // the PATCH persisted: still normal after the reload
  await expect(chip(page, ids.click)).toHaveText("·");
  await expect(chip(page, ids.click)).toHaveClass(/prio-normal/);
});

test("the chip is keyboard-activated and the detail head shows the same state", async ({ page }) => {
  await page.goto("/");
  const c = chip(page, ids.keys);
  await c.waitFor();

  // keyboard: Enter on the focused button cycles (button default activation)
  await c.focus();
  await page.keyboard.press("Enter");
  await expect(c).toHaveText("▼"); // normal → low

  // the detail head carries the same control with the text label
  await page.locator(`[data-card="${ids.keys}"]`).click();
  const head = page.locator(".detail-head button.prio-chip");
  await head.waitFor();
  await expect(head).toHaveAccessibleName(new RegExp(`priority ${ids.keys}: low`));
  await expect(head).toHaveText("▼ low");
  await head.click(); // low → high, from the detail surface
  await expect(head).toHaveText("▲ high");
});
