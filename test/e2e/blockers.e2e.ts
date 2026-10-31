import { test, expect } from "@playwright/test";

test.describe("blocker management from card detail", () => {
  test("add and remove a blocker from card detail", async ({ page, request }) => {
    const alphaRes = await request.post("/tasks", { data: { title: "Blocker e2e alpha", lane: "backlog" } });
    const betaRes = await request.post("/tasks", { data: { title: "Blocker e2e beta", lane: "backlog" } });
    expect(alphaRes.ok()).toBe(true);
    expect(betaRes.ok()).toBe(true);
    const alpha = (await alphaRes.json()) as { id: string; title: string };
    const beta = (await betaRes.json()) as { id: string; title: string };

    await page.goto("/");
    await page.waitForSelector("[data-card]");

    // open alpha's detail — the blocked-by row is always there now, picker included
    await page.locator("[data-card]", { hasText: alpha.title }).first().click();
    const detail = page.locator(".editor.detail");
    await expect(detail).toBeVisible();
    const blockedRow = detail.locator(".dep-row", { has: page.locator(".dep-k", { hasText: "blocked by" }) });
    await expect(blockedRow.locator('input[aria-label="add blocker"]')).toBeVisible();

    // type, move with the keyboard, commit with Enter — beta becomes a blocker chip
    await blockedRow.locator('input[aria-label="add blocker"]').click();
    await blockedRow.locator('input[aria-label="add blocker"]').fill("beta");
    const option = blockedRow.locator(".dep-picker-results .dep-option", { hasText: beta.title });
    await expect(option).toBeVisible();
    await blockedRow.locator('input[aria-label="add blocker"]').press("ArrowDown");
    await blockedRow.locator('input[aria-label="add blocker"]').press("Enter");

    const chip = blockedRow.locator(".dep-chip", { hasText: beta.title });
    await expect(chip).toBeVisible();
    await expect(blockedRow.locator(".dep-k")).toHaveClass(/stuck/); // alpha is now blocked

    // Escape closes only the dropdown — the modal stays open
    await blockedRow.locator('input[aria-label="add blocker"]').click();
    await blockedRow.locator('input[aria-label="add blocker"]').fill("alpha");
    await page.keyboard.press("Escape");
    await expect(blockedRow.locator(".dep-picker-results")).toHaveCount(0);
    await expect(detail).toBeVisible();

    // ✕ removes the edge; the chip disappears and the card unblocks
    await blockedRow.locator('.dep-x[title="unblock Blocker e2e beta"]').click();
    await expect(blockedRow.locator(".dep-chip", { hasText: beta.title })).toHaveCount(0);
    await expect(blockedRow.locator(".dep-k")).not.toHaveClass(/stuck/);

    // cycle refusal lands inline: alpha blocked by beta again, then beta tries to block on alpha
    await request.patch(`/tasks/${alpha.id}`, { data: { blockedBy: [beta.id] } });
    await page.keyboard.press("Escape"); // dropdown already closed — this one closes the modal
    await expect(detail).toHaveCount(0);

    await page.locator("[data-card]", { hasText: beta.title }).first().click();
    const betaDetail = page.locator(".editor.detail");
    await expect(betaDetail).toBeVisible();
    const betaRow = betaDetail.locator(".dep-row", { has: page.locator(".dep-k", { hasText: "blocked by" }) });
    await betaRow.locator('input[aria-label="add blocker"]').click();
    await betaRow.locator('input[aria-label="add blocker"]').fill("alpha");
    await betaRow.locator(".dep-picker-results .dep-option", { hasText: alpha.title }).first().click();

    await expect(betaRow.locator(".dep-error")).toHaveText(
      `dependency cycle detected: card '${beta.id}' cannot be blocked by '${alpha.id}'`,
    );
  });
});
