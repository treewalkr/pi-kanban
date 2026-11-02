import { expect, test } from "@playwright/test";

// Board manager chat (card d26pe): the sidebar's footer "Board chat" button
// opens the manager drawer (the resident "board" chat session), and the agents
// settings panel lists lane worker runs (empty on a fresh repro board).
test("board chat drawer opens from the sidebar", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("main.board");

  await page.getByRole("button", { name: "Board chat" }).click();
  const drawer = page.locator(".manager-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("board chat · the manager");
  await expect(drawer).toContainText("dispatches lane workers");
  // the ChatPanel shell is mounted (the chat GET fires against /chat/board)
  await expect(drawer.locator(".chat-panel")).toBeVisible();

  // Escape closes the drawer
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
});

test("agents settings shows the lane workers empty state", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("main.board");

  await page.getByRole("button", { name: "Agents" }).click();
  const surface = page.locator(".settings-surface");
  await expect(surface).toBeVisible();

  const section = page.locator(".settings-general-section").filter({ has: page.getByRole("heading", { name: "lane workers" }) });
  await expect(section).toBeVisible();
  await expect(section).toContainText("no runs — dispatch from board chat or `kanban worker run`");

  // the lane-grouped panel (3n96c) hosts the utility roles under the Board
  // scope — switch there; its seg still carries manager and worker
  await page
    .locator(".settings-general-section")
    .filter({ has: page.getByRole("heading", { name: "Lane", exact: true }) })
    .getByRole("button", { name: "Board", exact: true })
    .click();
  const roleSeg = page
    .locator(".settings-general-section")
    .filter({ has: page.getByRole("heading", { name: "Board agents" }) })
    .locator(".seg");
  await expect(roleSeg).toContainText("manager");
  await expect(roleSeg).toContainText("worker");
});
