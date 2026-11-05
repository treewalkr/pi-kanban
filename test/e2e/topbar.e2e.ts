import { expect, test, type Page } from "@playwright/test";

// Card 48wdj: the filter chips stay on ONE line at every width — when the
// header row runs out of room, the chips + trailing actions (.top-rest) drop
// to a second row as a unit, and an overflowing chips line scrolls sideways.
// The tag/agents popovers open fixed below their chip and close on chips
// scroll or window resize. Phone (≤640px) geometry is unchanged when the
// chips fit.

let seeded = 0;

async function seedTopbarCards(
  request: import("@playwright/test").APIRequestContext,
): Promise<string[]> {
  const ids: string[] = [];
  for (let n = 1; n <= 3; n++) {
    const res = await request.post("/tasks", {
      data: { title: `topbar seed ${n} #${++seeded}`, lane: "backlog", tags: ["topbar-a", "topbar-b"] },
    });
    ids.push(((await res.json()) as { id: string }).id);
  }
  return ids;
}

/** Widest chip set: three live sessions render the "3 agents" chip. */
async function mockAgents(page: Page, ids: string[]): Promise<void> {
  const now = Date.now();
  await page.route("**/activity", (route) =>
    route.fulfill({
      json: {
        sessions: ids.map((taskId) => ({
          taskId,
          role: "builder",
          startedAt: now - 60_000,
          lastActivityAt: now,
          log: [],
          logAt: [],
        })),
        queued: [],
        incidents: [],
        engines: [],
      },
    }),
  );
}

async function setWidth(page: Page, w: number): Promise<void> {
  await page.setViewportSize({ width: w, height: 800 });
  await page.waitForFunction((width) => window.innerWidth === width, w);
  await page.evaluate(() =>
    Promise.all([
      new Promise((r) => requestAnimationFrame(r)),
      new Promise((r) => requestAnimationFrame(r)),
    ]),
  );
}

/** Row count by clustering the vertical centers of header.top's visible flex items. */
async function headerRows(page: Page): Promise<{ rows: number; height: number }> {
  return page.evaluate(() => {
    const header = document.querySelector("header.top") as HTMLElement;
    const visible = (el: Element): boolean => {
      const style = getComputedStyle(el);
      if (style.display === "none") return false;
      if (style.position === "fixed") return false;
      return el.getBoundingClientRect().width > 0;
    };
    const centers: number[] = [];
    const collect = (el: Element): void => {
      const style = getComputedStyle(el);
      if (style.display === "contents") {
        Array.from(el.children).forEach(collect);
        return;
      }
      if (!visible(el)) return;
      const rect = el.getBoundingClientRect();
      centers.push(rect.top + rect.height / 2);
    };
    Array.from(header.children).forEach(collect);
    centers.sort((a, b) => a - b);
    let rows = centers.length > 0 ? 1 : 0;
    for (let i = 1; i < centers.length; i++) {
      if (centers[i] - centers[i - 1] > 4) rows++;
    }
    return { rows, height: header.getBoundingClientRect().height };
  });
}

async function chipsLine(page: Page): Promise<{
  spread: number;
  clientHeight: number;
  scrollWidth: number;
  clientWidth: number;
}> {
  return page.evaluate(() => {
    const chips = document.querySelector("header.top .chips") as HTMLElement;
    const centers = Array.from(chips.children)
      .map((el) => el.getBoundingClientRect())
      .filter((rect) => rect.width > 0)
      .map((rect) => rect.top + rect.height / 2);
    return {
      spread: centers.length > 0 ? Math.max(...centers) - Math.min(...centers) : 0,
      clientHeight: chips.clientHeight,
      scrollWidth: chips.scrollWidth,
      clientWidth: chips.clientWidth,
    };
  });
}

/** Geometry of every header control + chip, in DOM order — the A/B baseline. */
async function headerGeometry(page: Page): Promise<string> {
  return page.evaluate(() => {
    const header = document.querySelector("header.top") as HTMLElement;
    const parts: Element[] = [];
    const collect = (el: Element): void => {
      const style = getComputedStyle(el);
      if (style.display === "contents") {
        Array.from(el.children).forEach(collect);
        return;
      }
      parts.push(el);
    };
    Array.from(header.querySelectorAll("button, input, .meta")).forEach(collect);
    const chips = header.querySelector(".chips");
    if (chips) Array.from(chips.children).forEach((el) => parts.push(el));
    const round = (n: number): number => Math.round(n * 2) / 2;
    return parts
      .map((el) => {
        const r = el.getBoundingClientRect();
        return [round(r.x), round(r.y), round(r.width), round(r.height)].join(",");
      })
      .join("|");
  });
}

const REVERT_DESKTOP = `
.top{flex-wrap:nowrap!important;row-gap:10px!important}
.top-rest{display:contents!important}
.search-box{flex:0 1 200px!important;max-width:none!important}
.chips{flex:1 1 0%!important;flex-wrap:wrap!important;overflow:visible!important;scrollbar-width:auto!important;padding:0!important;margin:0!important}
.chips>*{flex-shrink:1!important}
.top-rest>:not(.chips){flex:0 1 auto!important}
`;

const REVERT_PHONE = `
.chips{flex-wrap:wrap!important;overflow:visible!important;scrollbar-width:auto!important;padding:0!important;margin:0!important}
.chips>*{flex-shrink:1!important}
.top-rest>:not(.chips){flex:0 1 auto!important}
.top .chips{justify-content:flex-end!important}
`;

const twoFrames = (page: Page) =>
  page.evaluate(() =>
    Promise.all([
      new Promise((r) => requestAnimationFrame(r)),
      new Promise((r) => requestAnimationFrame(r)),
    ]),
  );

test.describe("Top bar chips row (48wdj)", () => {
  let ids: string[];

  test.beforeAll(async ({ request }) => {
    ids = await seedTopbarCards(request);
  });

  test("AC1: header stays at most two rows at mid widths with the sidebar open", async ({ page }) => {
    await mockAgents(page, ids);
    await page.goto("/");
    await page.waitForSelector("main.board");
    for (const w of [950, 842, 750]) {
      await setWidth(page, w);
      const { rows, height } = await headerRows(page);
      expect(rows, `rows at ${w}px`).toBeLessThanOrEqual(2);
      expect(height, `height at ${w}px`).toBeLessThan(100);
    }
    // at 750 the whole unit wrapped — .top-rest (chips + trailing) sits below the lead row
    await setWidth(page, 750);
    const drop = await page.evaluate(() => {
      const rest = document.querySelector(".top-rest") as HTMLElement;
      const search = document.querySelector(".search-box") as HTMLElement;
      return (
        rest.getBoundingClientRect().top + rest.getBoundingClientRect().height / 2 -
        (search.getBoundingClientRect().top + search.getBoundingClientRect().height / 2)
      );
    });
    expect(drop).toBeGreaterThan(10);
  });

  test("AC2: chips row stays one line across a resize sweep", async ({ page }) => {
    await mockAgents(page, ids);
    await page.goto("/");
    await page.waitForSelector("main.board");
    await page.waitForSelector(".agents-filter");
    for (const w of [1600, 1280, 1100, 950, 842, 750, 700, 641, 640, 600, 480, 420, 375, 320]) {
      await setWidth(page, w);
      const line = await chipsLine(page);
      expect(line.spread, `chip centers at ${w}px`).toBeLessThanOrEqual(1);
      expect(line.clientHeight, `chips height at ${w}px`).toBeLessThanOrEqual(32);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      );
      expect(overflow, `document overflow at ${w}px`).toBe(true);
    }
  });

  test("AC2: sidebar closed — chips one line, header at most two rows", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("kanban-sidebar", "collapsed"));
    await mockAgents(page, ids);
    await page.goto("/");
    await page.waitForSelector("main.board");
    await page.waitForSelector(".agents-filter");
    for (const w of [950, 842, 750, 700, 641]) {
      await setWidth(page, w);
      const line = await chipsLine(page);
      expect(line.spread, `chip centers at ${w}px`).toBeLessThanOrEqual(1);
      expect(line.clientHeight, `chips height at ${w}px`).toBeLessThanOrEqual(32);
      const { rows } = await headerRows(page);
      expect(rows, `header rows at ${w}px`).toBeLessThanOrEqual(2);
    }
  });

  test("AC3: phone header geometry unchanged at 640 and 600", async ({ page }) => {
    test.slow();
    for (const w of [640, 600]) {
      await page.goto("/");
      await page.waitForSelector("main.board");
      await setWidth(page, w);
      const line = await chipsLine(page);
      expect(line.scrollWidth, `chips fit at ${w}px`).toBeLessThanOrEqual(line.clientWidth);
      const before = await headerGeometry(page);
      await page.addStyleTag({ content: REVERT_PHONE });
      await twoFrames(page);
      const after = await headerGeometry(page);
      expect(after).toEqual(before);
    }
  });

  test("AC4: tag and agents popovers open fully visible from a scrolled chips row", async ({ page }) => {
    await mockAgents(page, ids);
    await page.goto("/");
    await page.waitForSelector("main.board");
    await page.waitForSelector(".agents-filter");
    await setWidth(page, 750);
    const line = await chipsLine(page);
    expect(line.scrollWidth, "chips row overflows at 750").toBeGreaterThan(line.clientWidth);

    // scroll to the end and open the tag menu from the scrolled row
    await page.evaluate(() => {
      const chips = document.querySelector("header.top .chips") as HTMLElement;
      chips.scrollLeft = chips.scrollWidth;
    });
    await twoFrames(page);
    await page.click(".tag-filter > button");
    const tagMenu = page.locator(".tag-menu");
    await expect(tagMenu).toHaveCount(1);
    const tagBox = await tagMenu.boundingBox();
    expect(tagBox).not.toBeNull();
    const tagChecks = await page.evaluate(() => {
      const menu = document.querySelector(".tag-menu") as HTMLElement;
      const btn = document.querySelector(".tag-filter > button") as HTMLElement;
      const m = menu.getBoundingClientRect();
      const b = btn.getBoundingClientRect();
      const mid = document.elementFromPoint(m.left + m.width / 2, m.top + m.height / 2);
      return {
        position: getComputedStyle(menu).position,
        topDelta: Math.abs(m.top - (b.bottom + 6)),
        leftDelta: Math.abs(m.left - b.left),
        inside: m.top >= 0 && m.left >= 0 && m.right <= window.innerWidth && m.bottom <= window.innerHeight,
        hitInMenu: mid instanceof Element && (mid.closest(".tag-menu") !== null),
      };
    });
    expect(tagChecks.position).toBe("fixed");
    expect(tagChecks.topDelta).toBeLessThanOrEqual(1);
    expect(tagChecks.leftDelta).toBeLessThanOrEqual(1);
    expect(tagChecks.inside).toBe(true);
    expect(tagChecks.hitInMenu).toBe(true);

    // chips scroll back: the menu closes
    await page.evaluate(() => {
      const chips = document.querySelector("header.top .chips") as HTMLElement;
      chips.scrollLeft = 0;
    });
    await expect(tagMenu).toHaveCount(0);

    // same for the agents menu
    await page.evaluate(() => {
      const chips = document.querySelector("header.top .chips") as HTMLElement;
      chips.scrollLeft = chips.scrollWidth;
    });
    await twoFrames(page);
    await page.click(".agents-filter > button");
    const agentsMenu = page.locator(".agents-menu");
    await expect(agentsMenu).toHaveCount(1);
    const agentsChecks = await page.evaluate(() => {
      const menu = document.querySelector(".agents-menu") as HTMLElement;
      const btn = document.querySelector(".agents-filter > button") as HTMLElement;
      const m = menu.getBoundingClientRect();
      const b = btn.getBoundingClientRect();
      const mid = document.elementFromPoint(m.left + m.width / 2, m.top + m.height / 2);
      return {
        position: getComputedStyle(menu).position,
        rightDelta: Math.abs(m.right - b.right),
        inside: m.top >= 0 && m.left >= 0 && m.right <= window.innerWidth && m.bottom <= window.innerHeight,
        hitInMenu: mid instanceof Element && (mid.closest(".agents-menu") !== null),
      };
    });
    expect(agentsChecks.position).toBe("fixed");
    expect(agentsChecks.rightDelta).toBeLessThanOrEqual(1);
    expect(agentsChecks.inside).toBe(true);
    expect(agentsChecks.hitInMenu).toBe(true);

    // window resize: the menu closes
    await setWidth(page, 760);
    await expect(agentsMenu).toHaveCount(0);
  });

  test("AC5: wide desktop header is one row with unchanged geometry", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("main.board");
    await setWidth(page, 1600);
    const { rows, height } = await headerRows(page);
    expect(rows).toBe(1);
    expect(height).toBeLessThanOrEqual(41);
    const before = await headerGeometry(page);
    await page.addStyleTag({ content: REVERT_DESKTOP });
    await twoFrames(page);
    const after = await headerGeometry(page);
    expect(after).toEqual(before);
  });
});
