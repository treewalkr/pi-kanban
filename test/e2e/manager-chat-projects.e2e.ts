import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Board chat per project (czrcb): the drawer's `+ new session` picker scopes the
// manager session to a project's routed repo (`board:<project>`), shows the
// project chip, and persists the scope in board_state across reloads.
test.describe("board chat project scoping", () => {
  let suffix: string;
  let projName: string;
  let repoDir: string;

  test.beforeAll(async ({ request }) => {
    suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    projName = `kanban-scope-e2e-${suffix}`;
    repoDir = mkdtempSync(join(tmpdir(), `kanban-scope-e2e-${suffix}-`));
    const res = await request.put(`/projects/${encodeURIComponent(projName)}`, { data: { repoPath: repoDir } });
    expect(res.ok()).toBe(true);
  });

  test.afterAll(async ({ request }) => {
    rmSync(repoDir, { recursive: true, force: true });
    try {
      await request.put(`/projects/${encodeURIComponent(projName)}`, { data: { repoPath: null } });
      await request.put("/chat-board", { data: { project: null } });
    } catch {
      // best-effort cleanup (project-add.e2e.ts pattern)
    }
  });

  test("drawer picks a project, opens the scoped session, chip persists after reload", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("main.board");

    await page.getByRole("button", { name: "Board chat" }).click();
    const drawer = page.locator(".manager-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.locator(".manager-project")).toHaveCount(0); // unscoped by default

    await drawer.getByRole("button", { name: "new board chat session" }).click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    const wholeBoard = menu.getByRole("menuitemradio", { name: "none (whole board)" });
    const projectRow = menu.getByRole("menuitemradio", { name: projName, exact: true });
    await expect(wholeBoard).toHaveAttribute("aria-checked", "true");
    await expect(projectRow).toHaveCount(1);

    // picking the project opens /chat/board:<project> and shows the chip
    const scopedRequest = page.waitForRequest(`**/chat/board:${projName}**`);
    await projectRow.click();
    await scopedRequest;
    await expect(drawer.locator(".manager-project")).toHaveText(projName);
    await expect(menu).not.toBeVisible();

    // reload → reopen: the persisted scope drives the chip and the request again
    await page.reload();
    await page.waitForSelector("main.board");
    const reopened = page.waitForRequest(`**/chat/board:${projName}**`);
    await page.getByRole("button", { name: "Board chat" }).click();
    await reopened;
    await expect(page.locator(".manager-drawer .manager-project")).toHaveText(projName);

    // none (whole board) returns to the plain handle and drops the chip
    await page.locator(".manager-drawer").getByRole("button", { name: "new board chat session" }).click();
    const plain = page.waitForRequest((req) => new URL(req.url()).pathname === "/chat/board" && req.method() === "GET");
    await page.getByRole("menu").getByRole("menuitemradio", { name: "none (whole board)" }).click();
    await plain;
    await expect(page.locator(".manager-drawer .manager-project")).toHaveCount(0);
  });
});
