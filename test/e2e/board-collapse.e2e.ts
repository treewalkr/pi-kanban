import { expect, test } from "@playwright/test";

test.describe("Collapsible board columns (swk5g)", () => {
  test("AC1: every lane collapses to a header+count strip and expands back", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("main.board");

    // First load (fresh context) shows archive already collapsed (default seed)
    const archiveLane = page.locator("section.lane[data-lane='archive']");
    await expect(archiveLane).toHaveClass(/collapsed/);

    // Expand archive so every lane can be tested
    await archiveLane.locator(".collapsed-head").click();
    await expect(archiveLane).not.toHaveClass(/collapsed/);

    // For each visible section.lane
    const laneLocators = page.locator("section.lane");
    const count = await laneLocators.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const lane = laneLocators.nth(i);
      const laneId = await lane.getAttribute("data-lane");
      const laneName = await lane.locator(".lane-head h2").innerText();

      // Cards before collapse
      const cardsBefore = await lane.locator("[data-card]").count();

      // Clicking collapse button adds class collapsed
      const collapseBtn = lane.locator("button[title='collapse lane']");
      await collapseBtn.click();
      await expect(lane).toHaveClass(/collapsed/);

      // Hides all [data-card] inside it
      await expect(lane.locator("[data-card]")).toHaveCount(0);

      // Shows .collapsed-head with the lane name and .count chip
      const head = lane.locator(".collapsed-head");
      await expect(head).toBeVisible();
      await expect(head.locator(".collapsed-name")).toHaveText(laneName);
      await expect(head.locator(".count")).toBeVisible();

      // Clicking .collapsed-head removes collapsed and cards return
      await head.click();
      await expect(lane).not.toHaveClass(/collapsed/);
      if (cardsBefore > 0) {
        await expect(lane.locator("[data-card]").first()).toBeVisible();
      }
    }
  });

  test("AC2: collapsing intermediate lanes puts distant lanes on one phone screen", async ({ page, request }) => {
    // Viewport 375×667
    await page.setViewportSize({ width: 375, height: 667 });

    // Creates lane Cstart (index: 1) and Cend
    const resStart = await request.post("/lanes", { data: { name: "Cstart", index: 1 } });
    expect(resStart.status()).toBe(201);
    const cStart = (await resStart.json()) as { id: string; name: string };

    const resEnd = await request.post("/lanes", { data: { name: "Cend" } });
    expect(resEnd.status()).toBe(201);
    const cEnd = (await resEnd.json()) as { id: string; name: string };

    // Seeds one card in each
    const cardStartRes = await request.post("/tasks", { data: { title: "Card Cstart", lane: cStart.id } });
    expect(cardStartRes.status()).toBe(201);
    const cardEndRes = await request.post("/tasks", { data: { title: "Card Cend", lane: cEnd.id } });
    expect(cardEndRes.status()).toBe(201);

    await page.goto("/");
    await page.waitForSelector("main.board");
    await page.waitForSelector(`section.lane[data-lane="${cStart.id}"]`);
    await page.waitForSelector(`section.lane[data-lane="${cEnd.id}"]`);

    // Asserts ≥3 section.lane between them
    const laneElements = await page.locator("section.lane").all();
    const laneIds = await Promise.all(laneElements.map((el) => el.getAttribute("data-lane")));
    const startIdx = laneIds.indexOf(cStart.id);
    const endIdx = laneIds.indexOf(cEnd.id);

    expect(startIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(startIdx);
    const intermediateCount = endIdx - startIdx - 1;
    expect(intermediateCount).toBeGreaterThanOrEqual(3);

    // Collapses every other lane (all except Cstart and Cend)
    for (const lane of laneElements) {
      const id = await lane.getAttribute("data-lane");
      if (id !== cStart.id && id !== cEnd.id) {
        const isCollapsed = await lane.evaluate((el) => el.classList.contains("collapsed"));
        if (!isCollapsed) {
          await lane.locator("button[title='collapse lane']").click();
          await expect(lane).toHaveClass(/collapsed/);
        }
      }
    }

    // Both [data-lane="<cstart>"] .lane-head and [data-lane="<cend>"] .lane-head
    // satisfy top ≥ 0 && bottom ≤ innerHeight simultaneously
    try {
      const inView = await page.evaluate(
        ({ startId, endId }) => {
          const startHead = document.querySelector(`[data-lane="${startId}"] .lane-head`)?.getBoundingClientRect();
          const endHead = document.querySelector(`[data-lane="${endId}"] .lane-head`)?.getBoundingClientRect();
          if (!startHead || !endHead) return false;
          const innerHeight = window.innerHeight;
          return (
            startHead.top >= 0 &&
            startHead.bottom <= innerHeight &&
            endHead.top >= 0 &&
            endHead.bottom <= innerHeight
          );
        },
        { startId: cStart.id, endId: cEnd.id },
      );
      expect(inView).toBe(true);
    } finally {
      await request.delete(`/lanes/${cStart.id}?force=true`);
      await request.delete(`/lanes/${cEnd.id}?force=true`);
    }
  });

  test("AC3: collapse/expand round-trip leaves cards and board payload untouched", async ({ page, request }) => {
    // Seed a unique card in backlog
    const uniqueTitle = `ac3-card-${Date.now()}`;
    const taskRes = await request.post("/tasks", { data: { title: uniqueTitle, lane: "backlog" } });
    expect(taskRes.status()).toBe(201);

    await page.goto("/");
    await page.waitForSelector("main.board");
    const backlogLane = page.locator("section.lane[data-lane='backlog']");
    await expect(backlogLane).toBeVisible();

    // GET /board JSON (tasks for that lane, incl. positions) before
    const initialBoardRes = await request.get("/board");
    expect(initialBoardRes.status()).toBe(200);
    const initialBoard = (await initialBoardRes.json()) as { tasks: Array<{ id: string; laneId: string; position: number }> };
    const initialBacklogTasks = initialBoard.tasks.filter((t) => t.laneId === "backlog");

    // Ordered [data-card] ids before collapse
    const cardIdsBefore = await backlogLane.locator("[data-card]").evaluateAll(
      (cards) => cards.map((c) => c.getAttribute("data-card")),
    );
    expect(cardIdsBefore.length).toBeGreaterThan(0);

    // Collapse backlog
    await backlogLane.locator("button[title='collapse lane']").click();
    await expect(backlogLane).toHaveClass(/collapsed/);

    // Re-expand backlog
    await backlogLane.locator(".collapsed-head").click();
    await expect(backlogLane).not.toHaveClass(/collapsed/);

    // Ordered [data-card] ids after re-expand == ids before collapse
    const cardIdsAfter = await backlogLane.locator("[data-card]").evaluateAll(
      (cards) => cards.map((c) => c.getAttribute("data-card")),
    );
    expect(cardIdsAfter).toEqual(cardIdsBefore);

    // GET /board JSON is deep-equal before vs. after round-trip
    const afterBoardRes = await request.get("/board");
    expect(afterBoardRes.status()).toBe(200);
    const afterBoard = (await afterBoardRes.json()) as { tasks: Array<{ id: string; laneId: string; position: number }> };
    const afterBacklogTasks = afterBoard.tasks.filter((t) => t.laneId === "backlog");
    expect(afterBacklogTasks).toEqual(initialBacklogTasks);
  });
});
