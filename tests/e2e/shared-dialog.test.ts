import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron as electron, type ElectronApplication } from "playwright";
import { expect, it } from "vitest";

it("isolates the Settings background while keeping the titlebar and its dialogs usable", async () => {
  const appData = await mkdtemp(join(tmpdir(), "gitcrest-dialog-app-"));
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [".", "--lang=en-US", "--disable-gpu", `--user-data-dir=${join(appData, "profile")}`], env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: join(appData, "gitcrest.sqlite") } });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.evaluate(() => localStorage.setItem("gitcrest-locale", "en"));
    await window.reload();
    await window.locator(".connectionBadge.connected").waitFor({ timeout: 40_000 });
    await window.getByRole("button", { name: "Settings", exact: true }).click();
    await window.getByRole("menuitem", { name: /All settings/ }).click();
    const dialog = window.getByRole("dialog", { name: "Settings", exact: true });
    await dialog.waitFor();
    // The titlebar stays clickable while the covered page is isolated.
    for (const selector of [".titlebarHelp", ".searchShortcut", ".taskCenterButton", ".settingsButton"]) {
      await window.locator(selector).click({ trial: true, timeout: 2_000 });
    }
    const isolated = await window.locator("[data-settings-background]").evaluate((node) => (node as HTMLElement).inert);
    expect(isolated).toBe(true);
    for (let index = 0; index < 6; index++) await window.keyboard.press("Tab");
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    await dialog.getByRole("button", { name: "Close settings", exact: true }).click();
    await expect.poll(() => window.locator(".settingsPage").count()).toBe(0);
    expect(await window.locator(".appShell").evaluate((node) => [...node.children].every((child) => !(child as HTMLElement).inert))).toBe(true);
    expect(await window.locator(".settingsButton").evaluate((node) => node === document.activeElement)).toBe(true);

    await window.getByRole("button", { name: "Settings", exact: true }).click();
    await window.getByRole("menuitem", { name: /All settings/ }).click();
    await dialog.waitFor();
    await window.locator(".brandButton").click();
    await dialog.waitFor({ state: "hidden" });
    expect(await window.locator("[data-settings-background]").evaluate((node) => (node as HTMLElement).inert)).toBe(false);
  } finally {
    await app?.close();
    await rm(appData, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}, 90_000);
