import { test, expect } from "@playwright/test";

test.describe("files explorer and viewer", () => {
  test("explorer renders the pi-web tree, search, and icons", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".sidebar");

    // Click the Files tab in the sidebar
    const filesTab = page.locator("#sidebar-tab-files");
    await filesTab.click();

    // Verify .tree-row elements are visible
    const rows = page.locator(".tree-row");
    await expect(rows.first()).toBeVisible();

    // Verify rows contain .catppuccin-file-icon
    const icons = page.locator(".tree-row .catppuccin-file-icon");
    await expect(icons.first()).toBeVisible();

    // Dirs first: verify src directory exists with aria-expanded
    const srcRow = page.locator('.tree-row[title="src"]');
    await expect(srcRow).toBeVisible();
    await expect(srcRow).toHaveAttribute("aria-expanded", "false");

    // Expanding src lazily adds children
    await srcRow.click();
    await expect(srcRow).toHaveAttribute("aria-expanded", "true");
    const cliRow = page.locator('.tree-row[title="src/cli.ts"]');
    await expect(cliRow).toBeVisible();

    // Open search box
    const searchToggle = page.locator('button[aria-label="search files"]');
    await searchToggle.click();

    const searchInput = page.locator('input[aria-label="search files"]');
    await expect(searchInput).toBeVisible();
    await searchInput.fill("cli");

    // Wait for search debounce and verify it lists src/cli.ts
    const searchMatch = page.locator('.files-search-results .tree-row[title="src/cli.ts"]');
    await expect(searchMatch).toBeVisible();
  });

  test("viewer opens files in the right mode with toolbar and lines", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".sidebar");

    // Click Files tab
    const filesTab = page.locator("#sidebar-tab-files");
    await filesTab.click();

    // Click README.md
    const readmeRow = page.locator('.tree-row[title="README.md"]');
    await expect(readmeRow).toBeVisible();
    await readmeRow.click();

    // Dialog opens with aria-label="file preview"
    const dialog = page.locator('div.editor.preview[aria-label="file preview"]');
    await expect(dialog).toBeVisible();

    // Preview mode button is pressed by default for markdown
    const previewBtn = dialog.locator('button.viewer-mode-btn:has-text("Preview")');
    await expect(previewBtn).toHaveAttribute("aria-pressed", "true");
    const sourceBtnOnMd = dialog.locator('button.viewer-mode-btn:has-text("Source")');
    await expect(sourceBtnOnMd).toHaveAttribute("aria-pressed", "false");

    // Markdown body is rendered
    const markdownBody = dialog.locator(".viewer-markdown");
    await expect(markdownBody).toBeVisible();

    // Clicking Source mode switches to source view and presses Source
    await sourceBtnOnMd.click();
    await expect(sourceBtnOnMd).toHaveAttribute("aria-pressed", "true");
    await expect(previewBtn).toHaveAttribute("aria-pressed", "false");
    await expect(dialog.locator(".viewer-line").first()).toBeVisible();

    // Toolbar shows path and metadata
    const pathLabel = dialog.locator(".viewer-path");
    await expect(pathLabel).toHaveText("README.md");
    const metaLabel = dialog.locator(".viewer-meta");
    await expect(metaLabel).toContainText("markdown");

    // Press Escape to close
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();

    // Now open src/cli.ts
    const srcRow = page.locator('.tree-row[title="src"]');
    if ((await srcRow.getAttribute("aria-expanded")) !== "true") {
      await srcRow.click();
    }
    const cliRow = page.locator('.tree-row[title="src/cli.ts"]');
    await expect(cliRow).toBeVisible();
    await cliRow.click();

    await expect(dialog).toBeVisible();

    // If mode switch is rendered (>1 mode), Source button is pressed
    const sourceBtn = dialog.locator('button.viewer-mode-btn:has-text("Source")');
    if ((await sourceBtn.count()) > 0) {
      await expect(sourceBtn).toHaveAttribute("aria-pressed", "true");
    }

    // .viewer-line count > 10
    const lines = dialog.locator(".viewer-line");
    await expect(lines.nth(10)).toBeVisible();

    // First .viewer-line-num is 1
    const firstNum = dialog.locator(".viewer-line-num").first();
    await expect(firstNum).toHaveText("1");

    // Toolbar shows path
    await expect(dialog.locator(".viewer-path")).toHaveText("src/cli.ts");

    // Download anchor uses raw files endpoint with download=1
    const downloadLink = dialog.locator('a[aria-label="download file"]');
    await expect(downloadLink).toHaveAttribute("href", /.*\/files\/raw\?path=src%2Fcli\.ts&download=1/);

    // Backdrop click closes dialog (click at 5, 5 on overlay)
    const overlay = page.locator(".overlay");
    await overlay.click({ position: { x: 5, y: 5 } });
    await expect(dialog).not.toBeVisible();
  });
});
