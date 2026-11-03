import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

test.describe("add-project directory modal", () => {
  let rootDirName: string;
  let root: string;
  let projName: string;
  let suffix: string;

  test.beforeAll(() => {
    suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    rootDirName = `kanban-e2e-add-${suffix}`;
    root = join(homedir(), rootDirName);
    projName = `kanban-picker-e2e-${suffix}`;
    mkdirSync(join(root, "alpha-repo", ".git"), { recursive: true });
    mkdirSync(join(root, "beta-repo"), { recursive: true });
  });

  test.afterAll(async ({ request }) => {
    rmSync(root, { recursive: true, force: true });
    try {
      await request.put(`/projects/${projName}`, { data: { repoPath: null } });
    } catch {
      // best-effort cleanup
    }
  });

  async function openModal(page: Page) {
    await page.click("button[title='switch project']");
    await page.click("button[aria-label='add project from directory']");
    const dialog = page.getByRole("dialog", { name: "Select directory" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toBeFocused();
    await expect(dialog.locator("input[aria-label='directory path']")).toHaveValue(homedir());
    return dialog;
  }

  test("the add project row opens the directory modal at the home directory", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("main.board");
    await page.click("button[title='switch project']");
    await page.click("button[aria-label='add project from directory']");
    const dialog = page.getByRole("dialog", { name: "Select directory" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toBeFocused();
    await expect(dialog.locator("input[aria-label='directory path']")).toHaveValue(homedir());
    await expect(dialog.locator(`button[aria-label='open directory ${rootDirName}']`)).toBeVisible();
  });

  test("the modal shows the nav row, filter, folder rows, and footer actions", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("main.board");
    const dialog = await openModal(page);

    await expect(dialog.getByText("Select directory").first()).toBeVisible();
    const parentBtn = dialog.locator("button[aria-label='parent directory']");
    await expect(parentBtn).toBeVisible();
    await expect(parentBtn).toBeDisabled();

    await expect(dialog.locator("button[aria-label='go to path']")).toBeVisible();
    const pathInput = dialog.locator("input[aria-label='directory path']");
    await expect(pathInput).toBeVisible();
    await expect(dialog.locator("button[aria-label='new directory']")).toBeVisible();
    await expect(dialog.locator("button[aria-label='cancel']")).toBeVisible();

    const selectFolderBtn = dialog.locator("button[aria-label='select this folder']");
    await expect(selectFolderBtn).toBeVisible();
    await expect(selectFolderBtn).toBeEnabled();

    await pathInput.fill("/tmp");
    await expect(selectFolderBtn).toBeDisabled();

    await pathInput.fill(`~/${rootDirName}`);
    await dialog.locator("button[aria-label='go to path']").click();
    await expect(pathInput).toHaveValue(root);

    await expect(dialog.locator("input[aria-label='filter directories']")).toBeVisible();

    const alphaRow = dialog.locator("button[aria-label='open directory alpha-repo']");
    await expect(alphaRow).toBeVisible();
    await expect(alphaRow.locator(".pp-git")).toHaveText(".git");

    const betaRow = dialog.locator("button[aria-label='open directory beta-repo']");
    await expect(betaRow).toBeVisible();
    await expect(betaRow.locator(".pp-git")).toHaveCount(0);
  });

  test("click, parent back, typed ~/path Go, and the filter all navigate the listing", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("main.board");
    const dialog = await openModal(page);

    // Go on ~/<fixture>
    const pathInput = dialog.locator("input[aria-label='directory path']");
    await pathInput.fill(`~/${rootDirName}`);
    await dialog.locator("button[aria-label='go to path']").click();
    await expect(pathInput).toHaveValue(root);

    // Click open directory alpha-repo
    await dialog.locator("button[aria-label='open directory alpha-repo']").click();
    await expect(pathInput).toHaveValue(join(root, "alpha-repo"));

    // Parent directory back
    await dialog.locator("button[aria-label='parent directory']").click();
    await expect(pathInput).toHaveValue(root);

    // Type beta in filter directories
    const filterInput = dialog.locator("input[aria-label='filter directories']");
    await filterInput.fill("beta");
    await expect(dialog.locator("button[aria-label='open directory beta-repo']")).toBeVisible();
    await expect(dialog.locator("button[aria-label='open directory alpha-repo']")).toHaveCount(0);

    // Clearing restores both
    await filterInput.fill("");
    await expect(dialog.locator("button[aria-label='open directory alpha-repo']")).toBeVisible();
    await expect(dialog.locator("button[aria-label='open directory beta-repo']")).toBeVisible();

    // Go on /etc
    await pathInput.fill("/etc");
    await dialog.locator("button[aria-label='go to path']").click();
    const alert = dialog.locator("[role='alert']");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText("path escapes home directory");
    await expect(dialog.locator("button[aria-label='open directory alpha-repo']")).toBeVisible();
  });

  test("new directory creates and opens the folder, and a duplicate name is refused inline", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("main.board");
    const dialog = await openModal(page);

    // Navigate to fixture root
    const pathInput = dialog.locator("input[aria-label='directory path']");
    await pathInput.fill(`~/${rootDirName}`);
    await dialog.locator("button[aria-label='go to path']").click();
    await expect(pathInput).toHaveValue(root);

    // New directory
    await dialog.locator("button[aria-label='new directory']").click();
    const newDirInput = dialog.locator("input[aria-label='new directory name']");
    await expect(newDirInput).toBeVisible();
    const freshName = `fresh-${suffix}`;
    await newDirInput.fill(freshName);
    await dialog.locator("button[aria-label='create directory']").click();

    // Path input is now child, list shows No subdirectories, select folder enabled, register project not present
    await expect(pathInput).toHaveValue(join(root, freshName));
    await expect(dialog.locator(".pp-empty")).toHaveText("No subdirectories");
    await expect(dialog.locator("button[aria-label='select this folder']")).toBeEnabled();
    await expect(dialog.locator("button[aria-label='register project']")).toHaveCount(0);

    // Navigate back to root to test duplicate refusal
    await dialog.locator("button[aria-label='parent directory']").click();
    await expect(pathInput).toHaveValue(root);

    // Try creating with the same name again
    await dialog.locator("button[aria-label='new directory']").click();
    await dialog.locator("input[aria-label='new directory name']").fill(freshName);
    await dialog.locator("button[aria-label='create directory']").click();

    const alert = dialog.locator("[role='alert']");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(`directory '${freshName}' already exists in ${root}`);
    await expect(dialog.locator("input[aria-label='new directory name']")).toBeVisible();
  });

  test("selecting a folder registers a card-less project the picker switches to and keeps after reload", async ({ page, request }) => {
    await page.goto("/");
    await page.waitForSelector("main.board");
    const dialog = await openModal(page);

    // Navigate to fixture root
    const pathInput = dialog.locator("input[aria-label='directory path']");
    await pathInput.fill(`~/${rootDirName}`);
    await dialog.locator("button[aria-label='go to path']").click();
    await expect(pathInput).toHaveValue(root);

    // Select this folder
    await dialog.locator("button[aria-label='select this folder']").click();

    const projInput = dialog.locator("input[aria-label='project name']");
    await expect(projInput).toHaveValue(rootDirName);

    await projInput.fill(projName);
    await dialog.locator("button[aria-label='register project']").click();

    await expect(dialog).not.toBeVisible();

    const pickerVal = page.locator(".picker-value");
    await expect(pickerVal).toContainText(`~/${projName}`);
    expect(page.url()).toContain(`#project=${projName}`);

    // Reopen via switch project
    await page.click("button[title='switch project']");
    const row = page.locator(`.picker-row:has-text("${projName}")`);
    await expect(row).toBeVisible();
    await expect(row.locator(".badge")).toHaveCount(0);

    // Click all projects
    await page.locator(".picker-row.footer", { hasText: "all projects" }).click();
    await expect(pickerVal).toContainText("all projects");

    // Reopen and switch back to projName
    await page.click("button[title='switch project']");
    await page.locator(`.picker-row:has-text("${projName}")`).click();
    await expect(pickerVal).toContainText(`~/${projName}`);

    // Reload page
    await page.reload();
    await page.waitForSelector("main.board");
    await expect(page.locator(".picker-value")).toContainText(`~/${projName}`);

    // HTTP verification
    const res = await request.get("/projects");
    expect(res.status()).toBe(200);
    const { projects } = (await res.json()) as { projects: Array<{ name: string; repoPath: string | null; testGate: boolean }> };
    const saved = projects.find((p) => p.name === projName);
    expect(saved).toMatchObject({
      name: projName,
      repoPath: root,
      testGate: true,
    });
  });
});
