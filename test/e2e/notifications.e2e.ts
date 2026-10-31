import { test, expect, type BrowserContext, type Page } from "@playwright/test";

/**
 * Notification spies ride an init script so they exist before any app code runs:
 * `window.Notification` becomes a recorder. Headless Chromium always reports
 * `Notification.permission === "denied"` (even with granted context permissions),
 * so the fake also supplies the granted permission — the settings UI and the
 * notify gate read exactly that surface.
 */
async function installNotificationSpy(context: BrowserContext, presetEnabled: boolean): Promise<void> {
  await context.addInitScript((presetEnabled: boolean) => {
    const w = window as typeof window & { __notifications: Array<{ title: string; body?: string; tag?: string }> };
    w.__notifications = [];
    if (presetEnabled) localStorage.setItem("kanban-notify", "on");
    class FakeNotification {
      static permission: NotificationPermission = "granted";
      static requestPermission = async (): Promise<NotificationPermission> => "granted";
      onclick: unknown = null;
      constructor(
        public title: string,
        public options?: NotificationOptions,
      ) {
        w.__notifications.push({ title, body: options?.body, tag: options?.tag });
      }
      close(): void {}
    }
    (window as unknown as { Notification: unknown }).Notification = FakeNotification;
  }, presetEnabled);
}

/**
 * Headless Chromium reports `document.hidden === false` for every tab (no focus
 * manager), so the two-pages technique cannot make a tab hidden. Plan-sanctioned
 * fallback: control the gate signal directly — the product still reads
 * `document.hidden`, the test just decides what it says.
 */
async function installHiddenControl(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as typeof window & { __setPageHidden: (v: boolean) => void };
    const real = Object.getOwnPropertyDescriptor(Document.prototype, "hidden")!.get!;
    let forced: boolean | null = null;
    Object.defineProperty(document, "hidden", {
      get: () => (forced !== null ? forced : real.call(document)),
      configurable: true,
    });
    w.__setPageHidden = (v: boolean) => {
      forced = v;
      document.dispatchEvent(new Event("visibilitychange"));
    };
  });
}

async function openBoard(page: Page): Promise<void> {
  // register before goto — the EventSource opens as soon as the board hydrates
  const eventsReady = page.waitForResponse((res) => res.url().endsWith("/events") && res.status() === 200);
  await page.goto("/");
  await page.waitForSelector("main.board");
  await eventsReady;
  await page.waitForTimeout(200); // initial `change` consumed; join cursor is set
}

const recorded = (page: Page) => page.evaluate(() => (window as unknown as { __notifications: unknown[] }).__notifications);

test.describe("review-entry notifications", () => {
  test("settings shows the Notifications section with permission state", async ({ page }) => {
    await installNotificationSpy(page.context(), false); // permission granted, store off
    await page.goto("/");
    await page.waitForSelector("main.board");

    await page.click("button[aria-label='settings']");
    await expect(page.locator(".settings-general-heading", { hasText: "Notifications" })).toBeVisible();
    await expect(page.locator(".settings-general-description", { hasText: "Desktop notification when a card enters Review" })).toBeVisible();

    // granted permission + disabled store → the enable affordance
    await expect(page.getByRole("button", { name: "enable notifications" })).toBeVisible();

    // enabling flips the store (permission already granted) and shows the on copy
    await page.getByRole("button", { name: "enable notifications" }).click();
    await expect(page.locator(".settings-dev-note", { hasText: "on — you'll be notified while this tab is in the background" })).toBeVisible();
    await expect(page.getByRole("button", { name: "disable" })).toBeVisible();
    await page.getByRole("button", { name: "disable" }).click();
    await expect(page.getByRole("button", { name: "enable notifications" })).toBeVisible();
  });

  test("a hidden tab notifies when a card enters review; a visible tab stays silent", async ({ browser }) => {
    const context = await browser.newContext();
    await installNotificationSpy(context, true);
    const page = await context.newPage();
    await installHiddenControl(page);
    await openBoard(page);

    // create both cards up front via the API (review entry #1, silence check #2)
    const first = await context.request.post("/tasks", { data: { title: "notify me", lane: "backlog" } });
    const firstCard = (await first.json()) as { id: string };
    const second = await context.request.post("/tasks", { data: { title: "stay quiet", lane: "backlog" } });
    const secondCard = (await second.json()) as { id: string };

    // loud precondition: the tab must report hidden before the gate can pass
    await page.evaluate(() => (window as unknown as { __setPageHidden: (v: boolean) => void }).__setPageHidden(true));
    expect(await page.evaluate(() => document.hidden)).toBe(true);

    await context.request.patch(`/tasks/${firstCard.id}`, { data: { lane: "review" } });
    await expect
      .poll(() => recorded(page), { timeout: 5000 })
      .toEqual([{ title: "kanban", body: `notify me · ${firstCard.id} entered Review`, tag: `kanban-${firstCard.id}` }]);
    await page.waitForTimeout(400); // exactly one entry, no duplicates from the same flush
    expect(await recorded(page)).toHaveLength(1);

    // a visible tab stays silent — the board itself is the signal
    await page.evaluate(() => (window as unknown as { __setPageHidden: (v: boolean) => void }).__setPageHidden(false));
    expect(await page.evaluate(() => document.hidden)).toBe(false);
    await context.request.patch(`/tasks/${secondCard.id}`, { data: { lane: "review" } });
    await page.waitForTimeout(800); // flush (100 ms) + SSE + notification would all have landed
    expect(await recorded(page)).toHaveLength(1);

    await context.close();
  });
});
