import { expect, test, type Request as PWRequest } from "@playwright/test";
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
    await page.getByRole("tab", { name: "Projects" }).click();

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
    await page.getByRole("tab", { name: "Projects" }).click();
    await expect(page.locator("input[aria-label='repo path e2e-proj']")).toHaveValue("/tmp");
    await expect(page.locator("input[aria-label='test gate e2e-proj']")).not.toBeChecked();

    // cleanup: unroute and remove the seeded card
    await request.put("/projects/e2e-proj", { data: { repoPath: null } });
    await request.delete(`/tasks/${id}?force=true`);
  });

  test("v4: per-project test command input round-trips", async ({ page, request }) => {
    const res = await request.post("/tasks", { data: { title: "projects-e2e testcmd card", project: "e2e-tc" } });
    const { id } = (await res.json()) as { id: string };
    try {
      await page.goto("/");
      await page.waitForSelector("main.board");
      await page.click("button[aria-label='settings']");
      await page.getByRole("tab", { name: "Projects" }).click();

      // unrouted, commandless tag: empty input with the board-default placeholder
      const cmd = page.locator("input[aria-label='test command e2e-tc']");
      await expect(cmd).toHaveValue("");
      await expect(cmd).toHaveAttribute("placeholder", "bun test --timeout 30000");

      // one save per row: the PUT body is exactly repoPath + testGate + testCmd
      const put = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/projects/e2e-tc"));
      await cmd.fill("  cargo test  ");
      await page.locator("button[aria-label='save project e2e-tc']").click();
      const putRes = await put;
      const body = putRes.request().postDataJSON() as { repoPath: unknown; testGate: unknown; testCmd: unknown };
      expect(Object.keys(body).sort()).toEqual(["repoPath", "testCmd", "testGate"]);
      expect(body.testCmd).toBe("cargo test"); // trimmed
      const get = await request.get("/projects");
      const row = ((await get.json()) as { projects: Array<{ name: string; testCmd: string | null }> }).projects.find((p) => p.name === "e2e-tc");
      expect(row?.testCmd).toBe("cargo test");

      // the value repopulates from GET /projects across a reload
      await page.reload();
      await page.waitForSelector("main.board");
      await page.click("button[aria-label='settings']");
      await page.getByRole("tab", { name: "Projects" }).click();
      await expect(page.locator("input[aria-label='test command e2e-tc']")).toHaveValue("cargo test");

      // clearing the input sends testCmd: null (board default again)
      const putNull = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/projects/e2e-tc"));
      await page.locator("input[aria-label='test command e2e-tc']").fill("");
      await page.locator("button[aria-label='save project e2e-tc']").click();
      const nullBody = (await putNull).request().postDataJSON() as { testCmd: unknown };
      expect(nullBody.testCmd).toBeNull();
      const getCleared = await request.get("/projects");
      const cleared = ((await getCleared.json()) as { projects: Array<{ name: string; testCmd: string | null }> }).projects.find((p) => p.name === "e2e-tc");
      expect(cleared?.testCmd).toBeNull();

      // a CLI/API-set command survives a gate-only web save, untouched
      await request.put("/projects/e2e-tc", { data: { testCmd: "make check" } });
      await page.reload();
      await page.waitForSelector("main.board");
      await page.click("button[aria-label='settings']");
      await page.getByRole("tab", { name: "Projects" }).click();
      const putGate = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/projects/e2e-tc"));
      await page.locator("input[aria-label='test gate e2e-tc']").uncheck();
      await page.locator("button[aria-label='save project e2e-tc']").click();
      await putGate;
      const getGate = await request.get("/projects");
      const gateRow = ((await getGate.json()) as { projects: Array<{ name: string; testGate: boolean; testCmd: string | null }> }).projects.find((p) => p.name === "e2e-tc");
      expect(gateRow).toMatchObject({ testGate: false, testCmd: "make check" });
    } finally {
      await request.put("/projects/e2e-tc", { data: { testCmd: null, repoPath: null } });
      await request.delete(`/tasks/${id}?force=true`);
    }
  });

  test("v4: override editor lists lane and board actors", async ({ page, request }) => {
    const res = await request.post("/tasks", { data: { title: "projects-e2e ovlist card", project: "ov-list" } });
    const { id } = (await res.json()) as { id: string };
    try {
      await page.goto("/");
      await page.waitForSelector("main.board");
      await page.click("button[aria-label='settings']");
      await page.getByRole("tab", { name: "Projects" }).click();

      await page.click("button[aria-label='agent overrides ov-list']");
      const toggle = page.locator("button[aria-label='agent overrides ov-list']");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      const group = page.locator("div[role='group'][aria-label='override editor ov-list']");
      await expect(group).toBeVisible();

      // one optgroup per workflow lane with actors (SSE-fresh board.laneContexts), board group last.
      // Subset match, no order pin: earlier specs on the shared e2e board may add lanes or leave a
      // failed lane-drag spec's reorder unrestored, so relative lane order is not stable here.
      const select = page.locator("select[aria-label='override actor ov-list']");
      const labels = await select
        .locator("optgroup")
        .evaluateAll((els) => els.map((e) => (e as HTMLOptGroupElement).label));
      for (const lane of ["Plan", "Test + Implement", "Review"]) expect(labels).toContain(lane);
      expect(labels).not.toContain("Backlog"); // no context → no group
      expect(labels).not.toContain("Epics");
      expect(labels).not.toContain("Waiting on you");
      expect(labels).not.toContain("Done");
      expect(labels).not.toContain("Archive");
      expect(labels[labels.length - 1]).toBe("board");

      const planActors = await select
        .locator("optgroup[label='Plan'] option")
        .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
      expect(planActors).toEqual(["planner", "plan-reviewer"]);
      const boardActors = await select
        .locator("optgroup[label='board'] option")
        .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
      expect(boardActors).toEqual(["elaborator", "manager", "worker"]);

      await page.click("button[aria-label='agent overrides ov-list']");
      await expect(page.locator("div[role='group'][aria-label='override editor ov-list']")).toHaveCount(0);
    } finally {
      await request.delete(`/tasks/${id}?force=true`);
    }
  });

  test("v4: per-actor override editor round-trips present-key skills", async ({ page, request }) => {
    expect((await request.put("/engines/e2e-ov-eng", { data: { name: "e2e ov engine", harness: "pi" } })).ok()).toBe(true);
    const seeded = await request.post("/tasks", { data: { title: "projects-e2e ovproj card", project: "ov-proj" } });
    const { id } = (await seeded.json()) as { id: string };
    let agentPuts = 0;
    const countPut = (r: PWRequest) => {
      if (r.method() === "PUT" && r.url().includes("/projects/ov-proj/agents")) agentPuts++;
    };
    try {
      await page.goto("/");
      await page.waitForSelector("main.board");
      await page.click("button[aria-label='settings']");
      await page.getByRole("tab", { name: "Projects" }).click();
      await page.click("button[aria-label='agent overrides ov-proj']");
      const group = page.locator("div[role='group'][aria-label='override editor ov-proj']");
      await expect(group).toBeVisible();

      const select = page.locator("select[aria-label='override actor ov-proj']");
      await select.selectOption("reviewer");
      await page.locator("select[aria-label='override add engine ov-proj']").selectOption("e2e-ov-eng");

      // lineup-only save on a fresh override: PUT body sends runsOn, no skills key (inherits)
      page.on("request", countPut);
      const saveRes = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/projects/ov-proj/agents/reviewer"));
      await page.locator("button[aria-label='save override ov-proj']").click();
      const body = (await saveRes).request().postDataJSON() as { runsOn?: string[]; skills?: string[] };
      expect(body.runsOn).toEqual(["e2e-ov-eng"]);
      expect("skills" in body).toBe(false);

      const agentsRes = await request.get("/projects/ov-proj/agents");
      const agents = (await agentsRes.json()) as { agents: Array<{ actor: string; config: { runsOn?: string[]; skills?: string[]; timeoutMs?: number } }> };
      expect(agents.agents).toEqual([{ actor: "reviewer", config: { runsOn: ["e2e-ov-eng"] } }]);
      await expect(page.locator("select[aria-label='override actor ov-proj'] optgroup[label='Review'] option[value='reviewer']")).toHaveText("reviewer · override");

      // timeout minutes → timeoutMs
      await page.locator("input[aria-label='override timeout ov-proj']").fill("30");
      const timeoutRes = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/projects/ov-proj/agents/reviewer"));
      await page.locator("button[aria-label='save override ov-proj']").click();
      await timeoutRes;
      const timed = (await (await request.get("/projects/ov-proj/agents")).json()) as typeof agents;
      expect(timed.agents[0]?.config.timeoutMs).toBe(1_800_000);

      // invalid timeout: the client refuses before any request
      const putsBefore = agentPuts;
      await page.locator("input[aria-label='override timeout ov-proj']").fill("0");
      await page.locator("button[aria-label='save override ov-proj']").click();
      await expect(page.locator(".error-bar")).toContainText("timeout must be 1 to 1440 minutes");
      await page.waitForTimeout(400);
      expect(agentPuts).toBe(putsBefore);

      // a stored skills list survives a timeout-only edit (present key resent)
      expect((await request.put("/projects/ov-proj/agents/reviewer", { data: { runsOn: ["e2e-ov-eng"], skills: ["/tmp/e2e-skill"] } })).ok()).toBe(true);
      await page.reload();
      await page.waitForSelector("main.board");
      await page.click("button[aria-label='settings']");
      await page.getByRole("tab", { name: "Projects" }).click();
      await page.click("button[aria-label='agent overrides ov-proj']");
      await page.locator("select[aria-label='override actor ov-proj']").selectOption("reviewer");
      const removeSkill = group.locator("button[aria-label='remove /tmp/e2e-skill']");
      await expect(removeSkill).toBeVisible();

      const skillsRes = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/projects/ov-proj/agents/reviewer"));
      await page.locator("input[aria-label='override timeout ov-proj']").fill("45");
      await page.locator("button[aria-label='save override ov-proj']").click();
      const skillsBody = (await skillsRes).request().postDataJSON() as { runsOn?: string[]; skills?: string[]; timeoutMs?: number };
      expect(skillsBody.skills).toEqual(["/tmp/e2e-skill"]); // stored list survives an edit to another field
      expect(skillsBody.runsOn).toEqual(["e2e-ov-eng"]);
      expect(skillsBody.timeoutMs).toBe(2_700_000);

      // deliberate clear-all sends skills: []
      await removeSkill.click();
      await expect(group.locator("button[aria-label='remove /tmp/e2e-skill']")).toHaveCount(0);
      const clearRes = page.waitForResponse((r) => r.request().method() === "PUT" && r.url().includes("/projects/ov-proj/agents/reviewer"));
      await page.locator("button[aria-label='save override ov-proj']").click();
      const clearBody = (await clearRes).request().postDataJSON() as { skills?: string[] };
      expect(clearBody.skills).toEqual([]);
      const emptied = (await (await request.get("/projects/ov-proj/agents")).json()) as typeof agents;
      expect(emptied.agents[0]?.config.skills).toEqual([]);

      // clear: DELETE lands, the group returns to inheriting
      const delRes = page.waitForResponse((r) => r.request().method() === "DELETE" && r.url().includes("/projects/ov-proj/agents/reviewer"));
      await page.locator("button[aria-label='clear override ov-proj']").click();
      await delRes;
      const gone = (await (await request.get("/projects/ov-proj/agents")).json()) as { agents: unknown[] };
      expect(gone.agents).toEqual([]);
      await expect(group).toContainText("inherits the actor's lineup");
      await expect(page.locator("select[aria-label='override actor ov-proj'] optgroup[label='Review'] option[value='reviewer']")).toHaveText("reviewer");
    } finally {
      page.off("request", countPut);
      await request.delete("/engines/e2e-ov-eng");
      await request.put("/projects/ov-proj", { data: { repoPath: null } });
      await request.delete(`/tasks/${id}?force=true`);
    }
  });

  test("v4: manager and worker overrides show the inert note", async ({ page, request }) => {
    const res = await request.post("/tasks", { data: { title: "projects-e2e ovinert card", project: "ov-inert" } });
    const { id } = (await res.json()) as { id: string };
    try {
      await page.goto("/");
      await page.waitForSelector("main.board");
      await page.click("button[aria-label='settings']");
      await page.getByRole("tab", { name: "Projects" }).click();
      await page.click("button[aria-label='agent overrides ov-inert']");
      const group = page.locator("div[role='group'][aria-label='override editor ov-inert']");
      await expect(group).toBeVisible();

      const select = page.locator("select[aria-label='override actor ov-inert']");
      await select.selectOption("reviewer");
      await expect(group.locator("p.override-inert")).toHaveCount(0);
      await select.selectOption("manager");
      await expect(group.locator("p.override-inert")).toHaveText(
        "manager and worker overrides are stored but not applied yet — board chat and lane workers run on board-level settings.",
      );
      await select.selectOption("worker");
      await expect(group.locator("p.override-inert")).toHaveText(
        "manager and worker overrides are stored but not applied yet — board chat and lane workers run on board-level settings.",
      );
      await select.selectOption("elaborator");
      await expect(group.locator("p.override-inert")).toHaveCount(0);
    } finally {
      await request.delete(`/tasks/${id}?force=true`);
    }
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
      await page.getByRole("tab", { name: "Projects" }).click();

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
      await page.getByRole("tab", { name: "Projects" }).click();
      await expect(page.locator("input[aria-label='repo path picked-repo']")).toHaveValue(repoDir);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
      await request.put("/projects/picked-repo", { data: { repoPath: null } });
    }
  });
});
