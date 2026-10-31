import { test, expect, devices } from "@playwright/test";

test.use({ ...devices["iPhone 13"] });

test.beforeAll(async ({ request }) => {
  await request.post("/tasks", { data: { title: "Mobile task 1", lane: "backlog" } });
  await request.post("/tasks", { data: { title: "Mobile task 2", lane: "backlog" } });
  await request.post("/tasks", { data: { title: "Mobile task 3", lane: "backlog" } });
});

test("AC1: no horizontal overflow at 375px", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/");
  await page.waitForSelector("main.board");
  await page.waitForSelector("[data-card]");

  const overflow = await page.evaluate(() => {
    const board = document.querySelector("main.board") as HTMLElement;
    const docNoOverflow = document.documentElement.scrollWidth <= window.innerWidth + 1;
    const boardNoOverflow = board ? board.scrollWidth <= board.clientWidth + 1 : false;
    return { docNoOverflow, boardNoOverflow };
  });
  expect(overflow.docNoOverflow).toBe(true);
  expect(overflow.boardNoOverflow).toBe(true);

  const fits = await page.evaluate(() => {
    const lanes = Array.from(document.querySelectorAll("section.lane .lane-head"));
    const cards = Array.from(document.querySelectorAll("[data-card]"));
    const elements = [...lanes, ...cards];
    return elements.every((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return true;
      return rect.left >= -1 && rect.right <= window.innerWidth + 1;
    });
  });
  expect(fits).toBe(true);
});

test("AC1: no horizontal overflow at 768px", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/");
  await page.waitForSelector("main.board");
  await page.waitForSelector("[data-card]");

  // Tap sidebar toggle to close sidebar first so the board has the full 768px width
  const toggleBtn = page.locator("button.sidebar-toggle");
  await toggleBtn.tap();
  await page.waitForFunction(() => {
    const sidebar = document.querySelector(".sidebar");
    return sidebar && sidebar.getBoundingClientRect().width === 0;
  });

  const overflow = await page.evaluate(() => {
    const board = document.querySelector("main.board") as HTMLElement;
    const docNoOverflow = document.documentElement.scrollWidth <= window.innerWidth + 1;
    const boardNoOverflow = board ? board.scrollWidth <= board.clientWidth + 1 : false;
    return { docNoOverflow, boardNoOverflow };
  });
  expect(overflow.docNoOverflow).toBe(true);
  expect(overflow.boardNoOverflow).toBe(true);

  const [top1, top2] = await page.evaluate(() => {
    const lanes = Array.from(document.querySelectorAll("section.lane"));
    return [lanes[0].getBoundingClientRect().top, lanes[1].getBoundingClientRect().top];
  });
  const laneData = await page.evaluate(() => {
    const sidebar = document.querySelector(".sidebar") as HTMLElement;
    const board = document.querySelector("main.board") as HTMLElement;
    const lanes = Array.from(document.querySelectorAll("section.lane"));
    return {
      sidebarClasses: sidebar?.className,
      sidebarWidth: sidebar?.getBoundingClientRect().width,
      boardWidth: board?.getBoundingClientRect().width,
      boardDisplay: window.getComputedStyle(board).display,
      boardCols: window.getComputedStyle(board).gridTemplateColumns,
      lane0Rect: lanes[0]?.getBoundingClientRect(),
      lane1Rect: lanes[1]?.getBoundingClientRect(),
      lane0Class: lanes[0]?.className,
      lane1Class: lanes[1]?.className,
    };
  });
  expect(Math.abs(top1 - top2)).toBeLessThan(4);

  const fits = await page.evaluate(() => {
    const lanes = Array.from(document.querySelectorAll("section.lane .lane-head"));
    const cards = Array.from(document.querySelectorAll("[data-card]"));
    const elements = [...lanes, ...cards];
    return elements.every((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return true;
      return rect.left >= -1 && rect.right <= window.innerWidth + 1;
    });
  });
  expect(fits).toBe(true);
});

test("AC2: tap a card opens the detail dialog", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/");
  await page.waitForSelector("[data-card]");

  // lane headers are scroll-reachable vertically (scrollIntoViewIfNeeded then rect within viewport)
  const laneHeaders = page.locator("section.lane .lane-head");
  const count = await laneHeaders.count();
  for (let i = 0; i < count; i++) {
    const header = laneHeaders.nth(i);
    await header.scrollIntoViewIfNeeded();
    const box = await header.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(-1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(667 + 1);
  }

  // target by title: blockers.e2e seeds another backlog card and created_at decides .first()
  const card = page.locator("[data-card]", { hasText: "Mobile task 1" });
  await card.scrollIntoViewIfNeeded();
  await card.tap();

  await page.waitForSelector(".editor.detail");
  const detailTitle = page.locator(".editor.detail .detail-title");
  await expect(detailTitle).toHaveText("Mobile task 1");
});

test("AC3: visible controls meet the 24px minimum and text stays legible", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/");
  await page.waitForSelector("[data-card]");

  // Open detail dialog
  const card = page.locator("[data-card]", { hasText: "Mobile task 1" });
  await card.tap();
  await page.waitForSelector(".editor.detail");

  const fontSizes = await page.evaluate(() => {
    const bodySize = window.getComputedStyle(document.body).fontSize;
    const searchInput = document.querySelector("input.search");
    const searchSize = searchInput ? window.getComputedStyle(searchInput).fontSize : "";
    const cardTitle = document.querySelector(".card-title");
    const cardTitleSize = cardTitle ? parseFloat(window.getComputedStyle(cardTitle).fontSize) : 0;
    const idEl = document.querySelector(".id");
    const idSize = idEl ? parseFloat(window.getComputedStyle(idEl).fontSize) : 0;
    return { bodySize, searchSize, cardTitleSize, idSize };
  });

  expect(fontSizes.bodySize).toBe("14px");
  expect(fontSizes.searchSize).toBe("16px");
  expect(fontSizes.cardTitleSize).toBeGreaterThanOrEqual(13);
  expect(fontSizes.idSize).toBeGreaterThanOrEqual(11);

  const controlsValid = await page.evaluate(() => {
    const selector =
      ".main button, .main summary, .main input, .main select, .main textarea, " +
      ".editor.detail button, .editor.detail summary, .editor.detail input, .editor.detail select, .editor.detail textarea";
    const elements = Array.from(document.querySelectorAll(selector)) as HTMLElement[];
    const smallControls: Array<{ tag: string; cls: string; w: number; h: number }> = [];

    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      // Skip invisible elements
      if (rect.width === 0 || rect.height === 0) continue;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;

      const minDim = Math.min(rect.width, rect.height);
      if (minDim < 24) {
        smallControls.push({
          tag: el.tagName,
          cls: el.className,
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        });
      }
    }
    return { ok: smallControls.length === 0, smallControls };
  });

  expect(controlsValid.ok).toBe(true);
});

test("AC4: resizing between mobile and desktop widths reflows without reload", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/");
  await page.waitForSelector("section.lane");

  await page.evaluate(() => {
    (window as any).__noReload = 1;
  });

  // Verify stacked at 375
  const initialTops = await page.evaluate(() => {
    const lanes = Array.from(document.querySelectorAll("section.lane"));
    return [lanes[0].getBoundingClientRect().top, lanes[1].getBoundingClientRect().top];
  });
  expect(initialTops[1]).toBeGreaterThan(initialTops[0] + 50);

  // Resize to 1280x800
  await page.setViewportSize({ width: 1280, height: 800 });

  // First two lanes side-by-side (same top, distinct left)
  const desktopCoords = await page.evaluate(() => {
    const lanes = Array.from(document.querySelectorAll("section.lane"));
    const rect0 = lanes[0].getBoundingClientRect();
    const rect1 = lanes[1].getBoundingClientRect();
    const docNoOverflow = document.documentElement.scrollWidth <= window.innerWidth + 1;
    return {
      top0: rect0.top,
      top1: rect1.top,
      left0: rect0.left,
      left1: rect1.left,
      docNoOverflow,
      noReload: (window as any).__noReload,
    };
  });

  expect(Math.abs(desktopCoords.top0 - desktopCoords.top1)).toBeLessThan(4);
  expect(desktopCoords.left1).toBeGreaterThan(desktopCoords.left0 + 200);
  expect(desktopCoords.docNoOverflow).toBe(true);
  expect(desktopCoords.noReload).toBe(1);

  // Resize back to 375
  await page.setViewportSize({ width: 375, height: 667 });

  const finalCoords = await page.evaluate(() => {
    const lanes = Array.from(document.querySelectorAll("section.lane"));
    const rect0 = lanes[0].getBoundingClientRect();
    const rect1 = lanes[1].getBoundingClientRect();
    const docNoOverflow = document.documentElement.scrollWidth <= window.innerWidth + 1;
    const board = document.querySelector("main.board") as HTMLElement;
    const boardNoOverflow = board ? board.scrollWidth <= board.clientWidth + 1 : false;
    return {
      top0: rect0.top,
      top1: rect1.top,
      docNoOverflow,
      boardNoOverflow,
      noReload: (window as any).__noReload,
    };
  });

  expect(finalCoords.top1).toBeGreaterThan(finalCoords.top0 + 50);
  expect(finalCoords.docNoOverflow).toBe(true);
  expect(finalCoords.boardNoOverflow).toBe(true);
  expect(finalCoords.noReload).toBe(1);
});
