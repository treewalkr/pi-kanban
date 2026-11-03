import { expect, test, type Page } from "@playwright/test";

// Lane management e2e (card azqat): settings add → toggle shows an empty lane
// on a filtered board → rename → drag-reorder (board + settings) →
// delete-empty OK → delete-with-cards refused.

const laneOrder = async (request: any): Promise<string[]> => {
  const res = await request.get("/board");
  const board = (await res.json()) as { lanes: Array<{ id: string }> };
  return board.lanes.map((l) => l.id);
};

async function openLanesSettings(page: Page) {
  await page.goto("/");
  await page.waitForSelector("main.board");
  await page.getByRole("button", { name: "settings", exact: true }).click();
  await page.getByRole("button", { name: "Lanes", exact: true }).click();
  await page.waitForSelector(".lane-row[data-lane='backlog']");
}

test("settings: add lane, rename, set WIP, delete empty; delete with cards refused", async ({ page, request }) => {
  await openLanesSettings(page);

  // add "staging"
  await page.fill("[aria-label='new lane name']", "staging");
  await page.click("[aria-label='add lane']");
  await expect(page.locator(".lane-row[data-lane='staging']")).toBeVisible();
  expect((await laneOrder(request)).at(-1)).toBe("staging");

  // rename → "canary" (id remains "staging")
  await page.locator(".lane-row[data-lane='staging'] .lane-row-name-text").dblclick();
  const renameInput = page.locator("[aria-label='rename staging']");
  await expect(renameInput).toBeVisible();
  await renameInput.fill("canary");
  await renameInput.press("Enter");
  await expect(page.locator(".lane-row[data-lane='staging'] .lane-row-name-text")).toHaveText("canary");

  // WIP 2 → the board count chip shows 0/2
  await page.locator(".lane-row[data-lane='staging'] .lane-row-wip").dblclick();
  const wipInput = page.locator("[aria-label='wip limit canary']");
  await expect(wipInput).toBeVisible();
  await wipInput.fill("2");
  await wipInput.press("Enter");
  await expect(page.locator("section.lane[aria-label='canary'] .lane-head .count")).toHaveText("0/2");

  // delete with cards refused: seed a card into canary via the API, then ✕
  const cardRes = await request.post("/tasks", { data: { title: "canary card", lane: "staging" } });
  const card = (await cardRes.json()) as { id: string };
  await page.click("[aria-label='delete canary']");
  await expect(page.locator(".error-bar")).toContainText("still holds 1 task(s)");
  expect(await laneOrder(request)).toContain("staging");

  // empty the lane, delete-empty OK, gone after reload
  await request.patch(`/tasks/${card.id}`, { data: { lane: "archive" } });
  await page.click("[aria-label='delete canary']");
  await expect(page.locator(".lane-row[data-lane='staging']")).toHaveCount(0);
  await page.reload();
  await page.waitForSelector("main.board");
  expect(await laneOrder(request)).not.toContain("staging");
});

test("settings: drag lane row reorders vertically", async ({ page, request }) => {
  await openLanesSettings(page);

  const grip = page.locator("[aria-label='reorder Review']");
  const target = page.locator(".lane-row[data-lane='plan']");
  await grip.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const g = await grip.boundingBox();
  const t = await target.boundingBox();
  if (!g || !t) throw new Error("settings rows not laid out");

  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(t.x + t.width / 2, t.y + 6, { steps: 8 });
  await page.waitForTimeout(80);
  await page.mouse.up();

  const order = await laneOrder(request);
  const review = order.indexOf("review");
  const plan = order.indexOf("plan");
  expect(review).toBe(plan - 1);

  // survives reload
  await page.reload();
  await page.waitForSelector("main.board");
  expect(await laneOrder(request)).toEqual(order);
});

test("board: drag lane header reorders; fixed lanes stay pinned", async ({ page, request }) => {
  await page.goto("/");
  await page.waitForSelector("main.board");

  // ‹ › buttons are gone from fixed lanes
  await expect(page.locator("section.lane[aria-label='Waiting on you'] button[title='move lane right']")).toHaveCount(0);
  await expect(page.locator("section.lane[aria-label='Archive'] button[title='move lane left']")).toHaveCount(0);

  // collapse waiting and backlog so Plan and Test + Implement fit comfortably on screen
  await page.locator("section.lane[aria-label='Waiting on you'] button[title='collapse lane']").click();
  await page.locator("section.lane[aria-label='Backlog'] button[title='collapse lane']").click();

  // drag Test + Implement left of Plan, drop line visible mid-drag
  const head = page.locator("section.lane[aria-label='Test + Implement'] .lane-head");
  const plan = page.locator("section.lane[aria-label='Plan']");
  const h = await head.boundingBox();
  const p = await plan.boundingBox();
  if (!h || !p) throw new Error("board lanes not laid out");

  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(p.x + p.width / 4, p.y + 10, { steps: 8 });
  await expect(page.locator("section.lane[aria-label='Plan'] .lane-drop-line")).toBeVisible();
  await page.mouse.up();

  const order = await laneOrder(request);
  expect(order.indexOf("implement")).toBe(order.indexOf("plan") - 1);

  // fixed Waiting on you refuses the lift: press, drag, release — still first
  await page.locator("button[title='expand Waiting on you']").click();
  const waiting = page.locator("section.lane[aria-label='Waiting on you'] .lane-head");
  await waiting.scrollIntoViewIfNeeded();
  const w = await waiting.boundingBox();
  if (!w) throw new Error("waiting lane not laid out");
  await page.mouse.move(w.x + w.width / 2, w.y + w.height / 2);
  await page.mouse.down();
  await page.mouse.move(w.x + w.width / 2 + 120, w.y + w.height / 2, { steps: 6 });
  await page.mouse.up();
  expect((await laneOrder(request))[0]).toBe("waiting");
});

test("board: eye toggle reveals an empty lane under a project filter and persists", async ({ page, request }) => {
  await request.post("/tasks", { data: { title: "proj card", project: "e2e-proj" } });
  await request.post("/lanes", { data: { name: "emptylane" } });

  await page.goto("/#project=e2e-proj");
  await page.waitForSelector("main.board");
  await expect(page.locator("section.lane[data-lane='emptylane']")).toHaveCount(0); // hidden by the filter

  await page.click("[aria-label='show empty lanes']");
  await expect(page.locator("section.lane[data-lane='emptylane']")).toBeVisible();

  // persists across reload
  await page.reload();
  await page.waitForSelector("main.board");
  await expect(page.locator("section.lane[data-lane='emptylane']")).toBeVisible();

  // toggle off → hidden again
  await page.click("[aria-label='show empty lanes']");
  await expect(page.locator("section.lane[data-lane='emptylane']")).toHaveCount(0);
});
