import { expect, test } from "@playwright/test";

// The Epics container lane end to end (card ceqfq): the board renders the lane,
// an epic parked there supervises, and it auto-dones when its last in-flight
// child lands — Backlog defers never block it. Seeds via the request API;
// afterAll force-deletes so nothing lingers on the shared board.
let ids: Record<string, string>;

test.beforeAll(async ({ request }) => {
  const mk = async (title: string, parent?: string, lane = "backlog") => {
    const res = await request.post("/tasks", { data: { title, lane, parent } });
    expect(res.ok()).toBe(true);
    return (await res.json()).id as string;
  };
  ids = { epic: await mk("epics e2e epic") };
  ids.worker = await mk("epics e2e worker", ids.epic);
  ids.defer = await mk("epics e2e defer", ids.epic);
});

test.afterAll(async ({ request }) => {
  // delete parent-first with force to drop the whole nest
  await request.delete(`/tasks/${ids.epic}`, { params: { force: "true" } });
  await request.delete(`/tasks/${ids.worker}`, { params: { force: "true" } });
  await request.delete(`/tasks/${ids.defer}`, { params: { force: "true" } });
});

const laneOf = (id: string) => `section.lane[data-lane="epics"] [data-card="${id}"]`;

test("the Epics lane renders and an epic auto-dones when its last child in flight lands", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.locator('section.lane[data-lane="epics"]')).toBeVisible();

  // park the epic in Epics (the approve gate's target) and put the worker in flight
  const parked = await request.patch(`/tasks/${ids.epic}`, { data: { lane: "epics" } });
  expect(parked.ok()).toBe(true);
  await request.patch(`/tasks/${ids.worker}`, { data: { lane: "implement" } });
  await page.reload();
  await page.locator(laneOf(ids.epic)).waitFor();
  await expect(page.locator(laneOf(ids.epic))).toBeVisible(); // supervising

  // land the worker → the epic completes itself; the Backlog defer stays parked
  await request.patch(`/tasks/${ids.worker}`, { data: { lane: "done" } });
  await page.reload();
  await page.waitForSelector('[data-card="' + ids.epic + '"]');
  await expect(page.locator(laneOf(ids.epic))).toHaveCount(0); // no longer in Epics
  const board = (await request.get("/board").then((r) => r.json())) as { tasks: Array<{ id: string; laneId: string }> };
  const lane = (id: string) => board.tasks.find((t) => t.id === id)!.laneId;
  expect(lane(ids.epic)).toBe("done");
  expect(lane(ids.defer)).toBe("backlog"); // the defer survives
});
