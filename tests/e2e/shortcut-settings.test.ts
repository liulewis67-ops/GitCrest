import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication } from "playwright";
import { describe, expect, it } from "vitest";
import { createTempGitRepository } from "../fixtures/temp-repo";

const execFileAsync = promisify(execFile);

describe("shortcut settings E2E", () => {
  it("records a custom Shelve shortcut and uses it in the workspace", async () => {
    const fixture = await createTempGitRepository();
    const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-shortcut-e2e-app-data-"));
    const sourcePath = resolve(fixture.path, "src/shortcut.ts");
    let app: ElectronApplication | undefined;

    try {
      await mkdir(resolve(fixture.path, "src"), { recursive: true });
      await writeFile(sourcePath, "export const shortcut = 'base';\n");
      await writeFile(resolve(fixture.path, "src/second.ts"), "export const second = 'base';\n");
      await execFileAsync("git", ["-C", fixture.path, "add", "src"]);
      await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-m", "add shortcut fixture"]);
      await writeFile(sourcePath, "export const shortcut = 'changed';\n");
      await writeFile(resolve(fixture.path, "src/second.ts"), "export const second = 'changed';\n");

      app = await electron.launch({
        args: [".", "--lang=en-US", "--user-data-dir", resolve(appDataPath, "profile")],
        env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
      });
      const window = await app.firstWindow();
      await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
      await window.getByText("Core connected").waitFor({ timeout: 40_000 });
      const opened = await window.evaluate(async (repositoryPath) => {
        const connection = await (globalThis.window as unknown as Window & {
          gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
        }).gitcrest.getSidecarConnection();
        const response = await fetch(new URL("/api/v1/repositories", connection.baseUrl), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${connection.token}`,
            "X-GitCrest-API-Version": "1",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ path: repositoryPath }),
        });
        return response.status;
      }, fixture.path);
      expect(opened).toBe(200);

      await window.reload();
      await window.getByRole("heading", { name: "Recent repositories" }).waitFor();
      await window.locator(".repositoryRowOpen").click();
      await window.locator(".workspaceToolbar").waitFor();
      const rows = window.locator(".changeTreeFile");
      await expect.poll(() => rows.count()).toBe(2);
      await rows.first().focus();
      await window.keyboard.press("ArrowDown");
      expect(await rows.nth(1).evaluate((node) => node === document.activeElement)).toBe(true);
      const stagedPath = await rows.nth(1).getAttribute("aria-label");
      const checkbox = window.getByRole("checkbox", { name: `Stage ${stagedPath!.replace(/^modified /, "")}`, exact: true });
      await window.keyboard.press("Space");
      await expect.poll(() => checkbox.isChecked(), { timeout: 10_000 }).toBe(true);
      await expect.poll(() => checkbox.isEnabled(), { timeout: 10_000 }).toBe(true);
      await window.keyboard.press("Space");
      await expect.poll(() => checkbox.isChecked(), { timeout: 10_000 }).toBe(false);
      expect(await rows.nth(1).evaluate((node) => node === document.activeElement)).toBe(true);
      await window.keyboard.press("Enter");
      await expect.poll(() => rows.nth(1).getAttribute("aria-pressed")).toBe("true");
      await window.locator(".diffPanel .splitDiff, .diffPanel .fileDiffViewer").first().waitFor();
      await window.getByRole("button", { name: "Settings" }).click();
      await window.getByRole("menuitem", { name: /All settings/ }).click();

      const settings = window.getByRole("dialog", { name: "Settings" });
      await settings.getByRole("searchbox", { name: "Search shortcuts" }).fill("Shelve");
      const shelveBinding = settings.getByRole("button", { name: "Record shortcut for Shelve changes" });
      await shelveBinding.click();
      await window.keyboard.press("Control+Shift+j");
      await expect.poll(() => shelveBinding.innerText()).toContain("Ctrl+Shift+J");
      await settings.getByRole("button", { name: "Close settings" }).click();

      await window.keyboard.press("Control+Shift+j");
      const composer = window.getByRole("dialog", { name: "Shelve selected changes" });
      await composer.waitFor();
      await composer.getByText("src/shortcut.ts", { exact: true }).waitFor();
      await composer.getByRole("button", { name: "Cancel" }).click();
      await composer.waitFor({ state: "hidden" });
    } finally {
      await app?.close();
      await fixture.cleanup();
      await rm(appDataPath, { recursive: true, force: true });
    }
  }, 60_000);
});
