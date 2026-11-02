import { expect, test, type Page } from "@playwright/test";

// Seed the production shape that breaks numeric-index drops: top-level cards
// t1 t2 epic lone t3 t4, with c1 c2 c3 hidden under epic. The server's flat
// position order is t1 t2 epic c1 c2 c3 lone t3 t4 — the three hidden children
// sit between "epic" and "t3", so a DOM-visible index points at the wrong slot
// of the server's list.

async function pointerDrag(
  page: Page,
  sourceId: string,
  targetSel: string,
  place: "top" | "bottom" | "none",
) {
  const src = page.locator(`[data-card="${sourceId}"]`);
  await src.scrollIntoViewIfNeeded();
  const sBox = await src.boundingBox();
  if (!sBox) throw new Error(`source card ${sourceId} not found`);

  await page.mouse.move(sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
  await page.mouse.down();

  const tgt = page.locator(targetSel);
  await tgt.scrollIntoViewIfNeeded();
  const tBox = await tgt.boundingBox();
  if (!tBox) throw new Error(`target ${targetSel} not found`);

  const destX = tBox.x + tBox.width / 2;
  const destY =
    place === "top"
      ? tBox.y + 4
      : place === "bottom"
        ? tBox.y + tBox.height - 4
        : tBox.y + tBox.height - 8;

  // Move in steps to exceed the 4px lift threshold and trigger pointermove
  await page.mouse.move(destX, destY, { steps: 5 });
  await page.waitForTimeout(60);
  await page.mouse.up();
}

const backlog = (page: Page) => page.locator("section.lane[aria-label='Backlog']");

async function laneTitles(page: Page, laneLabel: string): Promise<string[]> {
  const read = () =>
    page.locator(`section.lane[aria-label='${laneLabel}']`).evaluate((lane) =>
      [...lane.querySelectorAll(".cards > [data-card]")]
        .map(
          (c) =>
            [...c.querySelector(".card-title")!.childNodes].find((n) => n.nodeType === 3)?.textContent?.trim() ?? "",
        )
        .filter((t) => t.startsWith("drag ")),
    );
  for (let i = 0; i < 10; i++) {
    const a = await read();
    await page.waitForTimeout(150);
    const b = await read();
    if (JSON.stringify(a) === JSON.stringify(b)) return a;
  }
  return read();
}

const backlogTitles = (page: Page) => laneTitles(page, "Backlog");

let ids: Record<string, string>;

test.beforeAll(async ({ request }) => {
  const mk = async (title: string, parent?: string, lane = "backlog") => {
    const res = await request.post("/tasks", { data: { title, lane, parent } });
    return (await res.json()).id as string;
  };
  ids = {};
  ids["drag t1"] = await mk("drag t1");
  ids["drag t2"] = await mk("drag t2");
  const epic = await mk("drag epic");
  ids["drag epic"] = epic;
  ids["drag c1"] = await mk("drag c1", epic);
  ids["drag c2"] = await mk("drag c2", epic);
  ids["drag c3"] = await mk("drag c3", epic);
  ids["drag lone"] = await mk("drag lone");
  ids["drag t3"] = await mk("drag t3");
  ids["drag t4"] = await mk("drag t4");
  ids["drag p1"] = await mk("drag p1", undefined, "plan");
  ids["drag p2"] = await mk("drag p2", undefined, "plan");
});

test.afterAll(async ({ request }) => {
  for (const id of Object.values(ids)) {
    await request.delete(`/tasks/${id}`, { params: { force: "true" } });
  }
});

test("the lifted card follows the cursor; no native ghost or dimmed original", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("section.lane[aria-label='Backlog'] [data-card]");

  const card = page.locator(`[data-card="${ids["drag lone"]}"]`);
  const box = await card.boundingBox();
  expect(box).not.toBeNull();

  // Pointer down and drag past 4px threshold
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 10, box!.y + box!.height / 2 + 15, { steps: 3 });

  // Layer and ghost are present
  const ghost = page.locator(".drag-layer > .drag-ghost");
  await expect(ghost).toBeVisible();

  // Ghost tracks cursor
  const gBox = await ghost.boundingBox();
  expect(gBox).not.toBeNull();

  // Source element has class drag-slot
  await expect(card).toHaveClass(/drag-slot/);

  // No card has draggable="true"
  expect(await page.locator(".card[draggable='true']").count()).toBe(0);

  // Release
  await page.mouse.up();
  await expect(page.locator(".drag-layer > .drag-ghost")).toHaveCount(0);
});

test("same-lane drops land where the slot shows, not where hidden children shift them", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("section.lane[aria-label='Backlog'] [data-card]");

  // Bottom: drop over empty space below cards
  await pointerDrag(page, ids["drag lone"], "section.lane[aria-label='Backlog'] .cards", "none");
  await expect.poll(() => backlogTitles(page)).toEqual([
    "drag t1",
    "drag t2",
    "drag epic",
    "drag t3",
    "drag t4",
    "drag lone",
  ]);

  // Top half of t4 → lone just above t4
  await pointerDrag(page, ids["drag lone"], `[data-card="${ids["drag t4"]}"]`, "top");
  await expect.poll(() => backlogTitles(page)).toEqual([
    "drag t1",
    "drag t2",
    "drag epic",
    "drag t3",
    "drag lone",
    "drag t4",
  ]);

  // Bottom half of epic → lone just below epic
  await pointerDrag(page, ids["drag lone"], `[data-card="${ids["drag epic"]}"]`, "bottom");
  await expect.poll(() => backlogTitles(page)).toEqual([
    "drag t1",
    "drag t2",
    "drag epic",
    "drag lone",
    "drag t3",
    "drag t4",
  ]);
});

test("cross-lane drag lands between the hovered cards", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("section.lane[aria-label='Backlog'] [data-card]");
  await page.waitForSelector("section.lane[aria-label='Plan'] [data-card]");

  // Drag drag lone from Backlog over drag p1's bottom half in Plan lane
  await pointerDrag(page, ids["drag lone"], `[data-card="${ids["drag p1"]}"]`, "bottom");

  // Plan lane now has p1, lone, p2
  await expect.poll(() => laneTitles(page, "Plan")).toEqual([
    "drag p1",
    "drag lone",
    "drag p2",
  ]);

  // Backlog lane omits lone
  await expect.poll(() => backlogTitles(page)).toEqual([
    "drag t1",
    "drag t2",
    "drag epic",
    "drag t3",
    "drag t4",
  ]);

  // Drag it back to Backlog bottom
  await pointerDrag(page, ids["drag lone"], "section.lane[aria-label='Backlog'] .cards", "none");
  await expect.poll(() => backlogTitles(page)).toEqual([
    "drag t1",
    "drag t2",
    "drag epic",
    "drag t3",
    "drag t4",
    "drag lone",
  ]);
});

test("a held cursor near a card's top edge keeps the slot stable (no flicker loop)", async ({ page, request }) => {
  for (const t of ["drag f1", "drag f2", "drag f3", "drag f4", "drag f5"]) {
    const res = await request.post("/tasks", { data: { title: t, lane: "backlog" } });
    ids[t] = (await res.json()).id;
  }
  await page.goto("/");
  await page.waitForSelector("section.lane[aria-label='Backlog'] [data-card]");

  const f3 = page.locator(`[data-card="${ids["drag f3"]}"]`);
  const f4 = page.locator(`[data-card="${ids["drag f4"]}"]`);

  await f4.scrollIntoViewIfNeeded();
  const f3Box = await f3.boundingBox();
  expect(f3Box).not.toBeNull();

  await page.mouse.move(f3Box!.x + f3Box!.width / 2, f3Box!.y + f3Box!.height / 2);
  await page.mouse.down();

  const f4Box = await f4.boundingBox();
  expect(f4Box).not.toBeNull();

  const x = f4Box!.x + 10;
  const y = f4Box!.y + 1; // 1px into top edge

  await page.mouse.move(x, y, { steps: 5 });
  await page.waitForTimeout(60);

  // Read slot child index during 6 jitter moves
  const seq: number[] = [];
  const cardsLoc = page.locator("section.lane[aria-label='Backlog'] .cards");
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(x + (i % 2), y);
    await page.waitForTimeout(30);
    const slotIndex = await cardsLoc.evaluate((cards, slotId) => {
      const children = [...cards.children];
      return children.findIndex((el) => el.getAttribute("data-card") === slotId);
    }, ids["drag f3"]);
    seq.push(slotIndex);
  }

  // The slot stays at the same index on every read
  expect(new Set(seq).size).toBe(1);
  expect(seq[0]).toBeGreaterThan(-1);

  await page.mouse.up();

  const titles = await backlogTitles(page);
  expect(titles.indexOf("drag f3")).toBeLessThan(titles.indexOf("drag f4"));
  expect(titles.indexOf("drag f3")).toBeGreaterThan(-1);
});

test("mouse drags work without HTML5 DnD; escape cancels; collapsed lanes take appends", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("section.lane[aria-label='Backlog'] [data-card]");

  // 1. Escape mid-drag cancels
  const initialTitles = await backlogTitles(page);
  const card = page.locator(`[data-card="${ids["drag t1"]}"]`);
  const box = await card.boundingBox();
  expect(box).not.toBeNull();

  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(box!.x + 100, box!.y + 100, { steps: 5 });
  await expect(page.locator(".drag-layer > .drag-ghost")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator(".drag-layer > .drag-ghost")).toHaveCount(0);
  await page.mouse.up();

  expect(await backlogTitles(page)).toEqual(initialTitles);

  // 2. Collapsed lane takes appends
  const planLane = page.locator("section.lane[data-lane='plan']");
  await planLane.locator("button[title='collapse lane']").click();
  await expect(page.locator("section.lane.collapsed[data-lane='plan']")).toBeVisible();

  // Drag drag t2 over collapsed plan lane
  const collapsedPlan = page.locator("section.lane.collapsed[data-lane='plan']");
  const cpBox = await collapsedPlan.boundingBox();
  expect(cpBox).not.toBeNull();

  const t2 = page.locator(`[data-card="${ids["drag t2"]}"]`);
  const t2Box = await t2.boundingBox();
  expect(t2Box).not.toBeNull();

  await page.mouse.move(t2Box!.x + t2Box!.width / 2, t2Box!.y + t2Box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(cpBox!.x + cpBox!.width / 2, cpBox!.y + cpBox!.height / 2, { steps: 5 });
  await page.waitForTimeout(60);
  await page.mouse.up();

  // Uncollapse plan lane to check cards
  await page.locator("section.lane.collapsed[data-lane='plan'] button.collapsed-head").click();
  await expect.poll(() => laneTitles(page, "Plan")).toContain("drag t2");
});

test("epic blocks part as one unit and nested siblings reorder by anchor", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("section.lane[aria-label='Backlog'] [data-card]");

  // Expand epic to see nested children
  const epicCard = page.locator(`[data-card="${ids["drag epic"]}"]`);
  const disc = epicCard.locator("button.disclosure");
  if ((await disc.textContent())?.includes("▸")) {
    await disc.click();
  }
  await expect(page.locator(`[data-card="${ids["drag c1"]}"]`)).toBeVisible();
  await expect(page.locator(`[data-card="${ids["drag c2"]}"]`)).toBeVisible();
  await expect(page.locator(`[data-card="${ids["drag c3"]}"]`)).toBeVisible();

  // 1. Drag lone over epic's bottom half → lands after the whole epic block
  await pointerDrag(page, ids["drag lone"], `[data-card="${ids["drag epic"]}"]`, "bottom");
  const titles = await backlogTitles(page);
  expect(titles.indexOf("drag lone")).toBe(titles.indexOf("drag epic") + 1);

  // 2. Drag c1 over c3's bottom half inside the nest → children order c2, c3, c1
  await pointerDrag(page, ids["drag c1"], `[data-card="${ids["drag c3"]}"]`, "bottom");
  await expect.poll(async () => {
    return epicCard.evaluate((el) => {
      const children = [...el.querySelectorAll(".card-children > [data-card]")];
      return children.map((c) => c.querySelector(".card-title")?.textContent?.trim() ?? "");
    });
  }).toEqual(["drag c2", "drag c3", "drag c1"]);
});
