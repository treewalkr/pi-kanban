import { expect, test } from "@playwright/test";

// GitHub linkage e2e: a pr chip renders on the board and links out. The
// webServer boots with KANBAN_GH_SYNC_MS=0 (hermetic — no gh spawns), so the
// chip asserts the pending state; live-state mapping is unit-tested in
// test/ghview.test.ts.

const seedTask = async (
  request: import("@playwright/test").APIRequestContext,
  title: string,
  lane: string,
): Promise<string> => {
  const res = await request.post("/tasks", { data: { title, lane } });
  return ((await res.json()) as { id: string }).id;
};

test.describe("github pr chip", () => {
  test("pr chip renders on the board and links out", async ({ page, request }) => {
    // backlog, own card, cleaned up below: wip.e2e asserts an exact implement
    // count and responsive.e2e measures board width — a new lane or an
    // implement card would break them under the shared repro server
    const id = await seedTask(request, "gh-e2e chip card", "backlog");
    const res = await request.post(`/tasks/${id}/gh`, {
      data: { ref: "https://github.com/o/r/pull/12" },
    });
    expect(res.status()).toBe(201);

    await page.goto("/");
    await page.waitForSelector("main.board");
    await page.waitForSelector("[data-card]");

    // one anchor chip per link: label #12, href out to github, pending styling
    const chip = page.locator(`.card[data-card='${id}'] a.chip.gh`);
    await expect(chip).toHaveText("#12");
    expect(await chip.getAttribute("href")).toBe("https://github.com/o/r/pull/12");
    expect(await chip.getAttribute("target")).toBe("_blank");
    expect(await chip.getAttribute("rel")).toBe("noreferrer");
    await expect(chip).toHaveClass(/gh-pending/); // loop disabled → no cached state
    expect(await chip.getAttribute("title")).toBe("https://github.com/o/r/pull/12");

    await request.delete(`/tasks/${id}?force=true`); // don't linger on the shared board
  });
});
