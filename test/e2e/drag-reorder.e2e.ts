import { expect, test, type Page } from "@playwright/test";

// Seed the production shape that breaks numeric-index drops: top-level cards
// t1 t2 epic lone t3 t4, with c1 c2 c3 hidden under epic. The server's flat
// position order is t1 t2 epic c1 c2 c3 lone t3 t4 — the three hidden children
// sit between "epic" and "t3", so a DOM-visible index points at the wrong slot
// of the server's list.

// Synthetic HTML5 DnD: mouse.* doesn't drive dataTransfer in Chromium, so
// dispatch dragstart → dragover → drop with one in-page DataTransfer. `place`
// picks the half of the target card the cursor drops over (hintIndex splits at
// the midpoint); "none" drops over a non-card element (the .cards container).
async function dragDrop(page: Page, sourceId: string, targetSel: string, place: "top" | "bottom" | "none") {
  await page.evaluate(
    ([srcId, tgtSel, place]) => {
      const dt = new DataTransfer();
      const src = document.querySelector(`[data-card="${srcId}"]`)!;
      src.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
      const tgt = document.querySelector(tgtSel)!;
      const r = tgt.getBoundingClientRect();
      const y = place === "top" ? r.top + 2 : place === "bottom" ? r.bottom - 2 : r.top + r.height / 2;
      tgt.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientY: y, dataTransfer: dt }));
      tgt.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientY: y, dataTransfer: dt }));
      src.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true }));
    },
    [sourceId, targetSel, place],
  );
}

const backlog = (page: Page) => page.locator("section.lane[aria-label='Backlog']");

/** Top-level card titles in DOM order (nested children render inside parents).
 * Only this file's "drag *" cards — other e2e files seed the shared repro DB.
 * Reads only once the DOM is quiescent — the SSE re-render after a drop can
 * briefly leave stale and fresh card nodes side by side. */
async function backlogTitles(page: Page): Promise<string[]> {
  const read = () =>
    backlog(page).evaluate((lane) =>
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

let ids: Record<string, string>;

test.beforeAll(async ({ request }) => {
  const mk = async (title: string, parent?: string) => {
    const res = await request.post("/tasks", { data: { title, lane: "backlog", parent } });
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
});

// The repro DB is shared by the whole suite — leave no cards behind (later
// files' layout assertions, e.g. responsive AC3's 24px control minimum, are
// sensitive to foreign backlog content).
test.afterAll(async ({ request }) => {
  for (const id of Object.values(ids)) {
    await request.delete(`/tasks/${id}`, { params: { force: "true" } });
  }
});

test("same-lane drops land where the gap shows, not where hidden children shift them", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("section.lane[aria-label='Backlog'] [data-card]");

  // Bottom: drop over the empty space below the cards. The visible list has 6
  // cards but the server's flat list has 9; a numeric DOM index lands short.
  await dragDrop(page, ids["drag lone"], "section.lane[aria-label='Backlog'] .cards", "none");
  await expect.poll(() => backlogTitles(page)).toEqual([
    "drag t1",
    "drag t2",
    "drag epic",
    "drag t3",
    "drag t4",
    "drag lone",
  ]);

  // Top half of t4 → lone just above t4 (bottom half of the list, past the
  // hidden children).
  await dragDrop(page, ids["drag lone"], `[data-card="${ids["drag t4"]}"]`, "top");
  await expect.poll(() => backlogTitles(page)).toEqual([
    "drag t1",
    "drag t2",
    "drag epic",
    "drag t3",
    "drag lone",
    "drag t4",
  ]);

  // Bottom half of epic → lone just below epic, the slot right before the
  // hidden children begin.
  await dragDrop(page, ids["drag lone"], `[data-card="${ids["drag epic"]}"]`, "bottom");
  await expect.poll(() => backlogTitles(page)).toEqual([
    "drag t1",
    "drag t2",
    "drag epic",
    "drag lone",
    "drag t3",
    "drag t4",
  ]);
});

test("a held cursor near a card's top edge keeps the gap stable (no flicker loop)", async ({ page, request }) => {
  // The 2px drop-gap shifts the cards below it; a cursor parked just under a
  // card's top edge lands on the gap it caused. Recomputing from that dragover
  // flips the hint to "append" and back every event — a flickering line and
  // 50/50 wrong drops. Such feedback dragovers must keep the previous hint.
  for (const t of ["drag f1", "drag f2", "drag f3", "drag f4", "drag f5"]) {
    const res = await request.post("/tasks", { data: { title: t, lane: "backlog" } });
    ids[t] = (await res.json()).id;
  }
  await page.goto("/");
  await page.waitForSelector("section.lane[aria-label='Backlog'] [data-card]");

  const trace = await page.evaluate(
    async ([srcId, tgtId]) => {
      const dt = new DataTransfer();
      const lane = document.querySelector("section.lane[aria-label='Backlog']")!;
      const byId = (id: string) => lane.querySelector(`[data-card="${id}"]`) as HTMLElement;
      byId(srcId).dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: dt }));
      // scroll f4 fully into view first — a card clipped by the lane's scroller
      // has elementFromPoint hit the container, not the card (append hint)
      byId(tgtId).scrollIntoView({ block: "center" });
      await new Promise((res2) => setTimeout(res2, 30));
      const r = byId(tgtId).getBoundingClientRect();
      const x = r.left + 10;
      const y = r.top + 1; // 1px into f4's top edge: upper half → insert before f4
      const cards = lane.querySelector(".cards")!;
      // where "insert before f4" renders: f4's own child index (earlier tests'
      // cards sit above — this file shares the lane)
      const before4 = [...cards.children].indexOf(byId(tgtId));
      const gapAt = () => [...cards.children].findIndex((k) => k.classList.contains("drop-gap"));
      const seq: number[] = [];
      for (let i = 0; i < 6; i++) {
        // real dragovers target the element under the cursor, like elementFromPoint
        document
          .elementFromPoint(x, y)!
          .dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientY: y, dataTransfer: dt }));
        await new Promise((res2) => setTimeout(res2, 30)); // let Svelte flush
        seq.push(gapAt());
      }
      document
        .elementFromPoint(x, y)!
        .dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientY: y, dataTransfer: dt }));
      await new Promise((res2) => setTimeout(res2, 30));
      return { seq, before4 };
    },
    [ids["drag f3"], ids["drag f4"]],
  );

  // the gap renders before f4 on EVERY read — no flipping to lane bottom
  expect(trace.seq).toEqual(Array(6).fill(trace.before4));
  // and the drop commits the stable hint: f3 stays ahead of f4 instead of
  // flickering into an append-to-bottom
  const titles = await backlogTitles(page);
  expect(titles.indexOf("drag f3")).toBeLessThan(titles.indexOf("drag f4"));
  expect(titles.indexOf("drag f3")).toBeGreaterThan(-1);
});
