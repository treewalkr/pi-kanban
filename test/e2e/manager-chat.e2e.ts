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

  const section = page.locator(".settings-general-section", { hasText: "lane workers" });
  await expect(section).toBeVisible();
  await expect(section).toContainText("no runs — dispatch from board chat or `kanban worker run`");

  // the role segmented control gained manager and worker
  const roleSeg = page.locator(".settings-general-section", { hasText: "Role" }).locator(".seg");
  await expect(roleSeg).toContainText("manager");
  await expect(roleSeg).toContainText("worker");
});
