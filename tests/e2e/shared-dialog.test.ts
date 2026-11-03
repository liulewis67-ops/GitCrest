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
    // Settings covers the workspace, while the visible application chrome stays usable.
    await window.locator(".titlebarHelp").click({ timeout: 2_000 });
    const help = window.locator(".quickGuide");
    // Filling an input does not check whether another layer covers it; clicking does.
    await help.getByRole("searchbox").click({ timeout: 2_000 });
    await help.getByRole("searchbox").fill("commit");
    await help.locator("[data-dialog-close]").click({ trial: true });
    await help.locator(".sharedDialogFooter button").click();
    await help.waitFor({ state: "hidden" });
    expect(await dialog.isVisible()).toBe(true);

    await window.locator(".titlebarHelp").click();
    await help.getByRole("searchbox").click();
    await window.keyboard.press("Escape");
    await help.waitFor({ state: "hidden" });
    expect(await dialog.isVisible()).toBe(true);

    await window.locator(".searchShortcut").click();
    const palette = window.locator(".commandPalette");
    await palette.locator("input").click();
    await palette.locator("input").fill("settings");
    await window.keyboard.press("Escape");
    await palette.waitFor({ state: "hidden" });
    expect(await dialog.isVisible()).toBe(true);

    await window.locator(".taskCenterButton").click();
    const tasks = window.locator(".taskCenter");
    await tasks.waitFor();
    await tasks.locator("[data-dialog-close]").click();
    await tasks.waitFor({ state: "hidden" });
    await window.getByRole("button", { name: "Minimize", exact: true }).click({ trial: true });
    await window.getByRole("button", { name: /^(Maximize|Restore)$/ }).click({ trial: true });
    await dialog.locator("[data-dialog-close]").focus();
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
