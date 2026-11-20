import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication } from "playwright";
import { expect, it } from "vitest";

it("filters task history and persists retention in the desktop app", async () => {
  const appData = await mkdtemp(join(tmpdir(), "gitcrest-task-history-"));
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [".", "--lang=en-US", "--disable-gpu", `--user-data-dir=${join(appData, "profile")}`], env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: join(appData, "gitcrest.sqlite") } });
    const page = await app.firstWindow();
    await page.locator(".connectionBadge.connected").waitFor({ timeout: 40_000 });
    await page.evaluate(() => localStorage.setItem("gitcrest-locale", "en"));
    await page.reload();
    await page.locator(".connectionBadge.connected").waitFor();
    await page.locator(".taskCenterButton").click();
    expect(await page.getByRole("combobox", { name: "Date range" }).inputValue()).toBe("recent");
    await page.getByRole("searchbox", { name: "Search tasks" }).fill("diagnostic");
    await page.getByRole("combobox", { name: "Date range" }).selectOption("custom");
    await page.getByLabel("From", { exact: true }).fill("2026-11-01");
    await page.getByLabel("Through", { exact: true }).fill("2026-11-21");
    // Check the shipped layout at compact and standard desktop sizes.
    for (const width of [760, 1280]) {
      await page.setViewportSize({ width, height: 720 });
      expect(await page.locator(".taskHistoryFilters").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    }
    await page.screenshot({ path: join(tmpdir(), "gitcrest-task-history.png") });
    await page.getByRole("button", { name: "Close tasks", exact: true }).click();
    await page.locator(".settingsButton").click();
    await page.getByRole("menuitem", { name: /All settings/ }).click();
    const days = page.getByRole("spinbutton", { name: "Days to retain logs" });
    await days.waitFor();
    await page.waitForFunction(() => !document.querySelector<HTMLInputElement>(".taskRetentionField input")?.disabled);
    expect(await days.inputValue()).toBe("15");
    await days.fill("7");
    await page.getByRole("button", { name: "Save retention", exact: true }).click();
    await page.getByText("Saved. Expired task history has been cleared.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await page.locator(".settingsButton").click();
    await page.getByRole("menuitem", { name: /All settings/ }).click();
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>(".taskRetentionField input")?.value === "7");
  } finally {
    await app?.close();
    if (dirname(resolve(appData)) !== resolve(tmpdir()) || !basename(appData).startsWith("gitcrest-task-history-")) throw new Error("Unexpected task test directory");
    await rm(appData, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}, 90_000);
