import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

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

  let destX: number;
  let destY: number;

  if (place === "none") {
    const lastCard = page.locator(`${targetSel} [data-card]`).last();
    if ((await lastCard.count()) > 0) {
      await lastCard.scrollIntoViewIfNeeded();
      const lBox = await lastCard.boundingBox();
      if (lBox) {
        destX = lBox.x + lBox.width / 2;
        destY = lBox.y + lBox.height + 15;
      } else {
        destX = tBox.x + tBox.width / 2;
        destY = tBox.y + tBox.height - 8;
      }
    } else {
      destX = tBox.x + tBox.width / 2;
      destY = tBox.y + tBox.height / 2;
    }
  } else {
    destX = tBox.x + tBox.width / 2;
    destY = place === "top" ? tBox.y + 4 : tBox.y + tBox.height - 4;
  }

  // Move in steps to exceed the 4px lift threshold and trigger pointermove
  await page.mouse.move(destX, destY, { steps: 5 });
  await page.waitForTimeout(60);
  await page.mouse.up();
}

const backlog = (page: Page) => page.locator("section.lane[aria-label='Backlog']");

async function laneTitles(page: Page, laneLabel: string): Promise<string[]> {
  const read = () =>
    page.locator(`section.lane[aria-label='${laneLabel}']`).evaluate((lane) =>
      [...lane.querySelectorAll(".cards [data-card]")]
        .filter((c) => !c.closest(".card-children"))
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

test.beforeEach(async ({ page }) => {
  page.on("console", (m) => console.log(m.text()));
});

// Same-column jerk repro (r52wu): g1..g6 land at the lane bottom; each test
// seeds its own set and cleans it up so the original tests see an unchanged lane.
async function seedSameColumnCards(request: APIRequestContext): Promise<void> {
  for (const t of ["drag g1", "drag g2", "drag g3", "drag g4", "drag g5", "drag g6"]) {
    const res = await request.post("/tasks", { data: { title: t, lane: "backlog" } });
    ids[t] = (await res.json()).id;
  }
}

async function cleanupSameColumnCards(request: APIRequestContext): Promise<void> {
  for (const t of ["drag g1", "drag g2", "drag g3", "drag g4", "drag g5", "drag g6"]) {
    const id = ids[t];
    if (!id) continue;
    await request.delete(`/tasks/${id}`, { params: { force: "true" } });
    delete ids[t];
  }
}

async function attachOrderRecorder(page: Page, laneLabel: string) {
  await page.evaluate((label) => {
    const cards = document.querySelector(`section.lane[aria-label='${label}'] .cards`);
    if (!cards) throw new Error("no .cards container");
    const readSig = () =>
      [...cards.querySelectorAll(":scope > div > [data-card]")]
        .filter((c) => !c.closest(".card-children"))
        .map((c) => c.getAttribute("data-card"))
        .join(",");
    const seq: string[] = [readSig()];
    new MutationObserver(() => {
      const sig = readSig();
      if (seq[seq.length - 1] !== sig) seq.push(sig);
    }).observe(cards, { childList: true });
    (window as any).__orderSeq = seq;
  }, laneLabel);
}

async function readOrderSeq(page: Page): Promise<string[]> {
  return page.evaluate(() => [...((window as any).__orderSeq as string[])]);
}

// Map an order signature's last n ids to titles for readable assertions
function sigTail(sig: string, n: number): string[] {
  return sig
    .split(",")
    .slice(-n)
    .map((id) => {
      for (const [title, tid] of Object.entries(ids)) if (tid === id) return title;
      return id;
    });
}

async function markWrapperAnim(page: Page, cardId: string): Promise<number | null> {
  return page.evaluate((id) => {
    const w = document.querySelector(`[data-card="${id}"]`)?.parentElement;
    const a = w?.getAnimations().find((an) => an.playState === "running") ?? null;
    (window as any).__markedAnim = a;
    return a ? (a.currentTime as number) : null;
  }, cardId);
}

async function checkWrapperAnim(page: Page, cardId: string): Promise<{ same: boolean; nowTime: number | null }> {
  return page.evaluate((id) => {
    const w = document.querySelector(`[data-card="${id}"]`)?.parentElement;
    const a = w?.getAnimations().find((an) => an.playState === "running") ?? null;
    const marked = (window as any).__markedAnim as Animation | null;
    return { same: !!a && !!marked && a === marked, nowTime: a ? (a.currentTime as number) : null };
  }, cardId);
}

test("same-column drag commits exactly one reorder per settled midpoint crossing", async ({ page, request }) => {
  await seedSameColumnCards(request);
  await page.goto("/");
  await page.waitForSelector("section.lane[aria-label='Backlog'] [data-card]");
  await attachOrderRecorder(page, "Backlog");

  const g6 = page.locator(`[data-card="${ids["drag g6"]}"]`);
  const g4 = page.locator(`[data-card="${ids["drag g4"]}"]`);
  await g4.scrollIntoViewIfNeeded();

  const g6Box = await g6.boundingBox();
  const g4Box = await g4.boundingBox();
  expect(g6Box).not.toBeNull();
  expect(g4Box).not.toBeNull();

  const x = g4Box!.x + g4Box!.width / 2;
  // Drag g6 up across g5's and g4's settled midpoints, ending just above g4's
  // midpoint; 40ms pauses sit inside the 180ms flip window.
  await page.mouse.move(x, g6Box!.y + g6Box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, g4Box!.y + g4Box!.height + 10, { steps: 6 }); // past g5's midpoint
  await page.waitForTimeout(40);
  await page.mouse.move(x, g4Box!.y + 12, { steps: 6 }); // past g4's midpoint
  await page.waitForTimeout(40);
  await page.mouse.move(x + 2, g4Box!.y + 14); // ±2px nudge, same settled slot
  await page.mouse.move(x - 2, g4Box!.y + 12);

  const seq = await readOrderSeq(page);
  // exactly 3 entries: initial order + one commit per crossed midpoint
  expect(seq.length, `extra order changes: ${seq.slice(3).map((s) => sigTail(s, 4).join("|"))}`).toBe(3);
  expect(sigTail(seq[0], 4)).toEqual(["drag g3", "drag g4", "drag g5", "drag g6"]);
  expect(sigTail(seq[1], 4)).toEqual(["drag g3", "drag g4", "drag g6", "drag g5"]);
  expect(sigTail(seq[2], 4)).toEqual(["drag g3", "drag g6", "drag g4", "drag g5"]);

  await page.mouse.up();
  const titles = await backlogTitles(page);
  expect(titles.indexOf("drag g6")).toBe(titles.indexOf("drag g3") + 1);
  expect(titles.indexOf("drag g4")).toBe(titles.indexOf("drag g6") + 1);

  // final order persisted across reload
  await page.reload();
  await page.waitForSelector("section.lane[aria-label='Backlog'] [data-card]");
  const reloaded = await backlogTitles(page);
  expect(reloaded.indexOf("drag g6")).toBe(reloaded.indexOf("drag g3") + 1);
  expect(reloaded.indexOf("drag g4")).toBe(reloaded.indexOf("drag g6") + 1);

  await cleanupSameColumnCards(request);
});

test("jitter near a midpoint while flips are in flight never re-commits the hint", async ({ page, request }) => {
  await seedSameColumnCards(request);
  await page.goto("/");
  await page.waitForSelector("section.lane[aria-label='Backlog'] [data-card]");
  await attachOrderRecorder(page, "Backlog");

  const g6 = page.locator(`[data-card="${ids["drag g6"]}"]`);
  const g4 = page.locator(`[data-card="${ids["drag g4"]}"]`);
  await g4.scrollIntoViewIfNeeded();

  const g6Box = await g6.boundingBox();
  const g4Box = await g4.boundingBox();
  expect(g6Box).not.toBeNull();
  expect(g4Box).not.toBeNull();

  const x = g4Box!.x + g4Box!.width / 2;
  // Cross both midpoints fast and mark the fresh flip at once — the polluted
  // window is the first ~30ms of the displaced card's slide, so the park into
  // g4's trail and the jitter must land inside it.
  await page.mouse.move(x, g6Box!.y + g6Box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, g4Box!.y + 14, { steps: 8 });
  await page.waitForTimeout(35); // let the coalesced hint frame fire (rAF)
  const markedTime = await markWrapperAnim(page, ids["drag g4"]);
  expect(markedTime).not.toBeNull();

  await page.mouse.move(x, g4Box!.y + 30); // into the trail, below g4's settled midpoint
  const seqAtMark = (await readOrderSeq(page)).length;
  // ±2px jitter at ~10ms intervals, entirely inside the 180ms flip window
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(x + (i % 2 ? 2 : -2), g4Box!.y + 30 + (i % 2 ? 2 : -2));
    await page.waitForTimeout(10);
  }

  const seq = await readOrderSeq(page);
  // the park and the jitter re-committed nothing — flips ran undisturbed
  expect(seq.length, `extra order changes: ${seq.slice(seqAtMark).map((s) => sigTail(s, 4).join("|"))}`).toBe(seqAtMark);
  expect(seqAtMark).toBe(3);
  expect(sigTail(seq[2], 4)).toEqual(["drag g3", "drag g6", "drag g4", "drag g5"]);

  // the in-flight flip was never replaced: same Animation object, time advanced
  const anim = await checkWrapperAnim(page, ids["drag g4"]);
  expect(anim.same).toBe(true);
  expect(anim.nowTime!).toBeGreaterThan(markedTime!);

  await page.mouse.up();
  await cleanupSameColumnCards(request);
});

test("cards visibly slide apart while dragging and the slot opens at the target", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("section.lane[aria-label='Backlog'] [data-card]");

  // Hold mouse down on drag lone and move over top half of t4
  const lone = page.locator(`[data-card="${ids["drag lone"]}"]`);
  const t4 = page.locator(`[data-card="${ids["drag t4"]}"]`);

  const lBox = await lone.boundingBox();
  const tBox = await t4.boundingBox();
  expect(lBox).not.toBeNull();
  expect(tBox).not.toBeNull();

  await page.mouse.move(lBox!.x + lBox!.width / 2, lBox!.y + lBox!.height / 2);
  await page.mouse.down();

  // Move to top half of t4
  await page.mouse.move(tBox!.x + tBox!.width / 2, tBox!.y + 4, { steps: 5 });

  // .cards [data-card] shows the dragged card's element at the target index (slot opened before t4)
  const cards = page.locator("section.lane[aria-label='Backlog'] .cards [data-card]");
  const titles = await cards.evaluateAll((list) =>
    list
      .filter((el) => !el.closest(".card-children"))
      .map((el) => el.querySelector(".card-title")?.textContent?.trim() ?? "")
      .filter((t) => t.startsWith("drag ")),
  );
  expect(titles.indexOf("drag lone")).toBe(titles.indexOf("drag t4") - 1);

  // A displaced neighbor has running animations (FLIP running on .cards > div)
  const animCount = await page
    .locator("section.lane[aria-label='Backlog'] .cards > div")
    .evaluateAll((cards) => cards.reduce((acc, el) => acc + el.getAnimations().length, 0));
  expect(animCount).toBeGreaterThan(0);

  // No .drop-gap element exists
  expect(await page.locator(".drop-gap").count()).toBe(0);

  await page.mouse.up();
});

test("the drop settles smoothly — ghost releases, slot becomes the card", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("section.lane[aria-label='Backlog'] [data-card]");

  const lone = page.locator(`[data-card="${ids["drag lone"]}"]`);
  const t4 = page.locator(`[data-card="${ids["drag t4"]}"]`);

  const lBox = await lone.boundingBox();
  const tBox = await t4.boundingBox();

  await page.mouse.move(lBox!.x + lBox!.width / 2, lBox!.y + lBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(tBox!.x + tBox!.width / 2, tBox!.y + 4, { steps: 5 });

  const ghost = page.locator(".drag-layer > .drag-ghost");
  await expect(ghost).toBeVisible();

  // Release mouse
  await page.mouse.up();

  // Ghost has running animation and is removed within 500ms
  await expect(ghost).toHaveCount(0, { timeout: 500 });

  // Final lane order equals the hinted order without jump
  await expect.poll(() => backlogTitles(page)).toEqual([
    "drag t1",
    "drag t2",
    "drag epic",
    "drag t3",
    "drag lone",
    "drag t4",
  ]);

  // Committed order is persisted (reload -> same order)
  await page.reload();
  await page.waitForSelector("section.lane[aria-label='Backlog'] [data-card]");
  expect(await backlogTitles(page)).toEqual([
    "drag t1",
    "drag t2",
    "drag epic",
    "drag t3",
    "drag lone",
    "drag t4",
  ]);
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

  // Drag it back to Backlog. Settled hints land lone before t4: the path
  // crosses t4's top half, the slot opens there, and the pointer comes to
  // rest inside t4's new (pushed-down) upper half — pre-fix this read appended
  // only via mid-flip geometry (r52wu)
  await pointerDrag(page, ids["drag lone"], "section.lane[aria-label='Backlog'] .cards", "none");
  await expect.poll(() => backlogTitles(page)).toEqual([
    "drag t1",
    "drag t2",
    "drag epic",
    "drag t3",
    "drag lone",
    "drag t4",
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
      return children.findIndex(
        (el) => el.getAttribute("data-card") === slotId || el.querySelector(`[data-card="${slotId}"]`) !== null,
      );
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
      const children = [...el.querySelectorAll(".card-children [data-card]")];
      return children.map((c) => c.querySelector(".card-title")?.textContent?.trim() ?? "");
    });
  }).toEqual(["drag c2", "drag c3", "drag c1"]);
});

test("touch: long-press lifts, scrolling cancels", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("section.lane[aria-label='Backlog'] [data-card]");

  // 1. Long-press lifts and drops
  const initialTitles = await backlogTitles(page);
  const src = page.locator(`[data-card="${ids["drag lone"]}"]`);
  const tBox = await page.locator(`[data-card="${ids["drag t1"]}"]`).boundingBox();
  expect(tBox).not.toBeNull();

  // Synthetic touch down on drag lone
  await src.evaluate((el) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(
      new PointerEvent("pointerdown", {
        pointerType: "touch",
        pointerId: 1,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
        button: 0,
        bubbles: true,
      }),
    );
  });

  // Hold 300ms (> 250ms TOUCH_HOLD_MS)
  await page.waitForTimeout(300);
  await expect(page.locator(".drag-layer > .drag-ghost")).toBeVisible();

  // Move to top of t1 and up
  await page.evaluate(
    ([destX, destY]) => {
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          pointerType: "touch",
          pointerId: 1,
          clientX: destX,
          clientY: destY,
          bubbles: true,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointerup", {
          pointerType: "touch",
          pointerId: 1,
          clientX: destX,
          clientY: destY,
          bubbles: true,
        }),
      );
    },
    [tBox!.x + tBox!.width / 2, tBox!.y + 4],
  );

  // Moved before t1
  const expectedTitles = ["drag lone", ...initialTitles.filter((t) => t !== "drag lone")];
  await expect.poll(() => backlogTitles(page)).toEqual(expectedTitles);

  // 2. Fresh touch + immediate move past slack (>8px) before hold + pointercancel -> no lift, order unchanged
  const currentTitles = await backlogTitles(page);
  const loneCard = page.locator(`[data-card="${ids["drag lone"]}"]`);

  await loneCard.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const startX = r.left + r.width / 2;
    const startY = r.top + r.height / 2;

    el.dispatchEvent(
      new PointerEvent("pointerdown", {
        pointerType: "touch",
        pointerId: 2,
        clientX: startX,
        clientY: startY,
        button: 0,
        bubbles: true,
      }),
    );

    // Immediate move 20px (> TOUCH_SLACK_PX)
    window.dispatchEvent(
      new PointerEvent("pointermove", {
        pointerType: "touch",
        pointerId: 2,
        clientX: startX,
        clientY: startY + 20,
        bubbles: true,
      }),
    );

    // pointercancel (browser takes over scroll)
    window.dispatchEvent(
      new PointerEvent("pointercancel", {
        pointerType: "touch",
        pointerId: 2,
        bubbles: true,
      }),
    );
  });

  await page.waitForTimeout(300);
  expect(await page.locator(".drag-layer > .drag-ghost").count()).toBe(0);
  expect(await backlogTitles(page)).toEqual(currentTitles);
});
