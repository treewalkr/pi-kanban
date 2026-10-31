import { expect, test } from "@playwright/test";

// Seeds run against the repro server (playwright.config.ts) via the request API,
// same idiom as responsive.e2e.ts / wip.e2e.ts. Unique names keep the palette
// queries unambiguous even with the other suites' seeds in the same DB.
test.beforeAll(async ({ request }) => {
  // Seeds live in plan/review — never backlog/implement: responsive.e2e asserts on
  // backlog's first card and wip.e2e counts implement, and both run against this
  // same repro DB (alphabetical file order puts palette first).
  await request.post("/tasks", { data: { title: "Palette target card", lane: "review" } });
  await request.post("/tasks", { data: { title: "Palette card p2", lane: "review", project: "pal-two" } });
  await request.post("/tasks", { data: { title: "Palette card p1a", lane: "plan", project: "pal-one" } });
  await request.post("/tasks", { data: { title: "Palette card p1b", lane: "plan", project: "pal-one" } });
});

const DIALOG = '[role="dialog"][aria-label="command palette"]';

async function openPalette(page: import("@playwright/test").Page) {
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(DIALOG)).toBeVisible();
}

test("AC1: ⌘K opens the palette, Escape closes, ⌘K toggles closed and reopens", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("main.board");
  await page.waitForSelector("[data-card]");

  await openPalette(page);
  await expect(page.locator("input.palette-input")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page.locator(DIALOG)).toBeHidden();

  await openPalette(page); // ⌘K toggles it open again
  await expect(page.locator("input.palette-input")).toBeFocused();

  // ⌘K while the palette is open toggles it closed, even mid-query with the
  // autofocused input owning the event (SearchBox's window handler skips INPUTs)
  await page.keyboard.type("x");
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(DIALOG)).toBeHidden();

  await openPalette(page);
  await expect(page.locator("input.palette-input")).toBeFocused();
});

test("AC1: ⌘K is ignored while a card modal is open", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("[data-card]");
  await page.locator("[data-card]").first().click();
  await expect(page.locator('[role="dialog"][aria-label="card details"]')).toBeVisible();

  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator(DIALOG)).toHaveCount(0);
});

test("AC2: Enter on a card match jumps to its detail", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("[data-card]");
  await openPalette(page);

  await page.keyboard.type("palette target");
  await expect(page.locator(".palette-item").first()).toContainText("Palette target card");
  await page.keyboard.press("Enter");

  const detail = page.locator('[role="dialog"][aria-label="card details"]');
  await expect(detail).toBeVisible();
  await expect(detail.locator(".detail-title")).toHaveText("Palette target card");
  await expect(page.locator(DIALOG)).toBeHidden();
});

test("AC3: Enter on a project match switches the board's project", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("[data-card]");
  const meta = page.locator("header .meta");
  const allCount = await meta.textContent(); // no filter yet

  await openPalette(page);
  await page.keyboard.type("pal-one");
  await expect(page.locator(".palette-item").first()).toContainText("~/pal-one");
  await page.keyboard.press("Enter");

  await expect(meta).toHaveText("2 tasks"); // only pal-one's two cards
  await expect(page).toHaveURL(/#project=pal-one/);

  await openPalette(page);
  await page.keyboard.type("all");
  await expect(page.locator(".palette-item").first()).toContainText("all projects");
  await page.keyboard.press("Enter");

  await expect(meta).toHaveText(allCount!); // count restored
  await expect(page).not.toHaveURL(/#project=/);
});

test("AC4: move lane left reorders the board", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("main.board");
  await openPalette(page);

  await page.keyboard.type("move backlog left");
  await expect(page.locator(".palette-item").first()).toContainText("move Backlog left");
  await page.keyboard.press("Enter");

  await page.waitForFunction(() => {
    const order = Array.from(document.querySelectorAll("section.lane")).map(
      (el) => (el as HTMLElement).dataset.lane,
    );
    return order.indexOf("backlog") !== -1 && order.indexOf("backlog") < order.indexOf("waiting");
  });

  // restore the board order — later suites (responsive/wip) must not see the move
  await openPalette(page);
  await page.keyboard.type("move backlog right");
  await expect(page.locator(".palette-item").first()).toContainText("move Backlog right");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => {
    const order = Array.from(document.querySelectorAll("section.lane")).map(
      (el) => (el as HTMLElement).dataset.lane,
    );
    return order.indexOf("waiting") !== -1 && order.indexOf("waiting") < order.indexOf("backlog");
  });
});

test("AC4: go to archive expands and reveals the archive lane", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("main.board");
  // archive starts collapsed (a strip, not a full lane)
  await expect(page.locator('section.lane.collapsed[data-lane="archive"]')).toBeVisible();

  await openPalette(page);
  await page.keyboard.type("go to archive");
  await expect(page.locator(".palette-item").first()).toContainText("go to Archive");
  await page.keyboard.press("Enter");

  const archive = page.locator('section.lane[data-lane="archive"]');
  await expect(archive).toBeVisible();
  await expect(archive).toBeInViewport();
});
