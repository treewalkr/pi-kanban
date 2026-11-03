import { expect, test } from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// AC6: the settings dialog's Projects section — per-row repo path + test-gate
// edits land via PUT /projects and survive a reload. The sidebar project picker
// stays read-only (v1); route editing happens here only.

test.describe("settings: projects section", () => {
  test("edits a route and persists", async ({ page, request }) => {
    // seed a card tagged with the project so it surfaces in the lazy union
    const res = await request.post("/tasks", { data: { title: "projects-e2e card", project: "e2e-proj" } });
    const { id } = (await res.json()) as { id: string };

    await page.goto("/");
    await page.waitForSelector("main.board");
    await page.click("button[aria-label='settings']");
    await page.locator("nav.settings-tabs button", { hasText: "Projects" }).click();

    // un-routed tag: empty repo input with the fallback hint
    const input = page.locator("input[aria-label='repo path e2e-proj']");
    await expect(input).toHaveValue("");
    // row-scoped: earlier specs (palette AC3's pal-one, …) seed other unrouted
    // projects on the shared board, each rendering its own hint
    await expect(page.locator(".project-row", { hasText: "e2e-proj" }).locator(".fallback-hint")).toBeVisible();

    await input.fill("/tmp");
    await page.locator("input[aria-label='test gate e2e-proj']").uncheck();
    await page.locator("button[aria-label='save project e2e-proj']").click();

    // the route landed on the server
    const get = await request.get("/projects");
    const { projects } = (await get.json()) as { projects: Array<{ name: string; repoPath: string | null; testGate: boolean }> };
    const row = projects.find((p) => p.name === "e2e-proj");
    expect(row).toMatchObject({ name: "e2e-proj", repoPath: "/tmp", testGate: false });

    // values persist across a reload (store refetches from the server)
    await page.reload();
    await page.waitForSelector("main.board");
    await page.click("button[aria-label='settings']");
    await page.locator("nav.settings-tabs button", { hasText: "Projects" }).click();
    await expect(page.locator("input[aria-label='repo path e2e-proj']")).toHaveValue("/tmp");
    await expect(page.locator("input[aria-label='test gate e2e-proj']")).not.toBeChecked();

    // cleanup: unroute and remove the seeded card
    await request.put("/projects/e2e-proj", { data: { repoPath: null } });
    await request.delete(`/tasks/${id}?force=true`);
  });

  test("adds a project via the directory picker and persists across reload", async ({ page, request }) => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const rootDirName = `kanban-e2e-picker-${suffix}`;
    const rootDir = join(homedir(), rootDirName);
    const repoDir = join(rootDir, "picked-repo");
    mkdirSync(join(repoDir, ".git"), { recursive: true });

    try {
      await page.goto("/");
      await page.waitForSelector("main.board");
      await page.click("button[aria-label='settings']");
      await page.locator("nav.settings-tabs button", { hasText: "Projects" }).click();

      await page.click("button[aria-label='add project']");

      // navigate into rootDir
      await page.click(`button[aria-label='open directory ${rootDirName}']`);
      // navigate into picked-repo
      await page.click("button[aria-label='open directory picked-repo']");

      // verifies input[aria-label='new project name'] defaults to picked-repo
      const nameInput = page.locator("input[aria-label='new project name']");
      await expect(nameInput).toHaveValue("picked-repo");

      // click create project
      await page.click("button[aria-label='create project']");

      // verifies .project-row for picked-repo appears with repo path equal to absolute path
      const repoInput = page.locator("input[aria-label='repo path picked-repo']");
      await expect(repoInput).toHaveValue(repoDir);

      // reloads page, reopens Settings -> Projects, and asserts repo path still holds the absolute path
      await page.reload();
      await page.waitForSelector("main.board");
      await page.click("button[aria-label='settings']");
      await page.locator("nav.settings-tabs button", { hasText: "Projects" }).click();
      await expect(page.locator("input[aria-label='repo path picked-repo']")).toHaveValue(repoDir);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
      await request.put("/projects/picked-repo", { data: { repoPath: null } });
    }
  });
});
