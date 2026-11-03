import { expect, test, devices, type APIRequestContext, type Page } from "@playwright/test";

const seedCard = async (request: APIRequestContext, title: string, note = ""): Promise<string> => {
  const res = await request.post("/tasks", { data: { title, note, lane: "backlog" } });
  return ((await res.json()) as { id: string }).id;
};

const openEditor = async (page: Page, id: string): Promise<void> => {
  await page.goto("/");
  await page.waitForSelector("main.board");
  await page.locator(`.card[data-card='${id}']`).click();
  await page.getByRole("button", { name: "edit", exact: true }).click();
  await expect(page.locator("div.editor[aria-label='edit card']")).toBeVisible();
};

const toggle = (page: Page) => page.locator(".editor button.editor-toggle-btn");
const editorDialog = (page: Page) => page.locator("div.editor[aria-label='edit card']");

test.describe("widened card editor and markdown preview toggle", () => {
  test("AC1: the editor is 720px wide on a desktop viewport and clamps to 90vw on a narrow one", async ({
    page,
    request,
  }) => {
    const id = await seedCard(request, "editor-ac1-geometry");
    try {
      await page.setViewportSize({ width: 1280, height: 800 });
      await openEditor(page, id);
      const box1280 = (await editorDialog(page).boundingBox())!;
      expect(box1280.width).toBeGreaterThanOrEqual(719);
      expect(box1280.width).toBeLessThanOrEqual(721);

      await page.setViewportSize({ width: 700, height: 800 });
      await page.waitForTimeout(100);
      const box700 = (await editorDialog(page).boundingBox())!;
      expect(box700.width).toBeGreaterThanOrEqual(629);
      expect(box700.width).toBeLessThanOrEqual(631);
    } finally {
      await request.delete(`/tasks/${id}?force=true`);
    }
  });

  test("AC2: the note toggle stacks its cues and names the action it offers", async ({
    page,
    request,
  }) => {
    const id = await seedCard(request, "editor-ac2-cues");
    try {
      await openEditor(page, id);
      const btn = toggle(page);
      await expect(page.locator(".editor-toggle-btn")).toHaveCount(1);
      await expect(btn).toHaveAttribute("aria-pressed", "false");
      await expect(btn).toHaveAccessibleName("preview markdown");
      await expect(btn).toContainText("preview");
      await expect(btn.locator("svg")).toHaveCount(1);

      await btn.click();
      await expect(btn).toHaveAttribute("aria-pressed", "true");
      await expect(btn).toHaveAccessibleName("edit note");
      await expect(btn).toContainText("edit");
      await expect(btn.locator("svg")).toHaveCount(1);
    } finally {
      await request.delete(`/tasks/${id}?force=true`);
    }
  });

  test("AC2: the toggle keeps the global focus-visible ring", async ({ page, request }) => {
    const id = await seedCard(request, "editor-ac2-focus");
    try {
      await openEditor(page, id);
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await expect(toggle(page)).toBeFocused();

      const outline = await toggle(page).evaluate((el) => {
        const s = window.getComputedStyle(el);
        return {
          style: s.outlineStyle,
          width: parseFloat(s.outlineWidth || "0"),
        };
      });
      expect(outline.style).toBe("solid");
      expect(outline.width).toBeGreaterThanOrEqual(2);
    } finally {
      await request.delete(`/tasks/${id}?force=true`);
    }
  });

  test("AC3: typed markdown renders as html in the preview", async ({ page, request }) => {
    const id = await seedCard(request, "editor-ac3-markdown");
    try {
      await openEditor(page, id);
      const textarea = page.locator("#task-note-input");
      await textarea.fill("# Heading\n\n```js\nconst x = 1;\n```\n\n> quote");
      await toggle(page).click();

      await expect(page.locator(".editor h1")).toHaveText("Heading");
      await expect(page.locator(".editor pre code.hljs")).toContainText("const x = 1");
      await expect(page.locator(".editor blockquote")).toContainText("quote");
      await expect(page.locator(".editor textarea")).toHaveCount(0);

      const typography = await page.locator(".editor .editor-note-preview").evaluate((el) => {
        const s = window.getComputedStyle(el);
        return {
          fontFamily: s.fontFamily,
          fontWeight: s.fontWeight,
        };
      });
      expect(typography.fontFamily.toLowerCase()).not.toContain("mono");
      expect(typography.fontWeight).toBe("400");
    } finally {
      await request.delete(`/tasks/${id}?force=true`);
    }
  });

  test("AC3: an empty note previews as a single-framed \"no note\" state", async ({
    page,
    request,
  }) => {
    const id = await seedCard(request, "editor-ac3-empty", "");
    try {
      await openEditor(page, id);
      await toggle(page).click();

      await expect(page.locator(".editor .detail-note.empty")).toHaveCount(1);
      await expect(page.locator(".editor .detail-note.empty")).toHaveText("no note");
      await expect(page.locator(".editor .detail-note .detail-note")).toHaveCount(0);
      await expect(page.locator(".editor .editor-note-preview.detail-note.md")).toHaveCount(0);

      const emptyTypography = await page.locator(".editor .detail-note.empty").evaluate((el) => {
        const s = window.getComputedStyle(el);
        return {
          fontWeight: s.fontWeight,
        };
      });
      expect(emptyTypography.fontWeight).toBe("400");
    } finally {
      await request.delete(`/tasks/${id}?force=true`);
    }
  });

  test("AC4: toggling preserves the draft and never writes the card", async ({ page, request }) => {
    const originalTitle = "editor-ac4-safety";
    const id = await seedCard(request, originalTitle, "");
    try {
      await openEditor(page, id);
      const titleInput = page.locator("label", { hasText: "title" }).locator("input");
      await titleInput.fill("editor-ac4-draft-title");
      const textarea = page.locator("#task-note-input");
      await textarea.fill("# drafted note text");

      await toggle(page).click();
      await expect(page.locator(".editor-note-preview")).toContainText("drafted note text");

      await toggle(page).click();
      await expect(page.locator("#task-note-input")).toHaveValue("# drafted note text");
      await expect(page.locator("label", { hasText: "title" }).locator("input")).toHaveValue(
        "editor-ac4-draft-title",
      );

      const boardRes = await request.get("/board");
      const boardData = (await boardRes.json()) as { tasks: Array<{ id: string; title: string; note: string }> };
      const task = boardData.tasks.find((t) => t.id === id);
      expect(task).toBeDefined();
      expect(task!.title).toBe(originalTitle);
      expect(task!.note).toBe("");
    } finally {
      await request.delete(`/tasks/${id}?force=true`);
    }
  });

  test("AC4: reopening the editor starts in edit mode", async ({ page, request }) => {
    const id = await seedCard(request, "editor-ac4-reopen");
    try {
      await openEditor(page, id);
      await toggle(page).click();
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "true");

      await page.keyboard.press("Escape");
      await expect(page.locator("div.editor[aria-label='edit card']")).toHaveCount(0);

      await page.locator(`.card[data-card='${id}']`).click();
      await page.getByRole("button", { name: "edit", exact: true }).click();
      await expect(page.locator("div.editor[aria-label='edit card']")).toBeVisible();
      await expect(toggle(page)).toHaveAttribute("aria-pressed", "false");
      await expect(toggle(page)).toHaveAccessibleName("preview markdown");
      await expect(page.locator("#task-note-input")).toBeVisible();
    } finally {
      await request.delete(`/tasks/${id}?force=true`);
    }
  });

  test("AC5: the widened editor does not overflow at 375px or 640px", async ({ page, request }) => {
    const id = await seedCard(request, "editor-ac5-overflow");
    try {
      for (const w of [375, 640]) {
        await page.setViewportSize({ width: w, height: 800 });
        await openEditor(page, id);
        const diff = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect(diff).toBeLessThanOrEqual(1);

        const box = (await editorDialog(page).boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(w);

        await page.keyboard.press("Escape");
        await expect(page.locator("div.editor[aria-label='edit card']")).toHaveCount(0);
      }
    } finally {
      await request.delete(`/tasks/${id}?force=true`);
    }
  });
});

test.describe("touch", () => {
  const { defaultBrowserType: _unused, ...iPhone13 } = devices["iPhone 13"];
  test.use({ ...iPhone13 });

  test("AC5: the toggle is a 44px touch target on a phone", async ({ page, request }) => {
    const id = await seedCard(request, "editor-ac5-touch");
    try {
      await openEditor(page, id);
      const box = (await toggle(page).boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    } finally {
      await request.delete(`/tasks/${id}?force=true`);
    }
  });
});
