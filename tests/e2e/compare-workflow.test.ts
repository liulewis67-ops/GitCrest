import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { createTempGitRepository } from "../fixtures/temp-repo";

const execFileAsync = promisify(execFile);
const git = async (path: string, ...args: string[]) => (await execFileAsync("git", ["-C", path, ...args])).stdout.trim();

describe("compare workflow E2E", () => {
  let app: ElectronApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("compares two branches and opens a file of the comparison, with its siblings, in the Diff window", async () => {
    const fixture = await createTempGitRepository();
    const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-compare-e2e-app-data-"));
    try {
      await writeFile(resolve(fixture.path, "a.txt"), "one\n");
      await git(fixture.path, "add", "a.txt");
      await git(fixture.path, "commit", "--quiet", "-m", "first");
      const original = await git(fixture.path, "rev-parse", "--abbrev-ref", "HEAD");
      await git(fixture.path, "checkout", "--quiet", "-b", "feature/cmp");
      await writeFile(resolve(fixture.path, "a.txt"), "one\ntwo\n");
      await writeFile(resolve(fixture.path, "other.txt"), "other\n");
      await git(fixture.path, "add", ".");
      await git(fixture.path, "commit", "--quiet", "-m", "extend the feature");
      await git(fixture.path, "checkout", "--quiet", original);

      app = await electron.launch({
        args: [".", "--lang=en-US", "--disable-gpu"],
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
          headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1", "Content-Type": "application/json" },
          body: JSON.stringify({ path: repositoryPath }),
        });
        return response.status;
      }, fixture.path);
      expect(opened).toBe(200);
      await window.reload();
      await window.getByRole("heading", { name: "Recent repositories" }).waitFor();
      await window.locator(".repositoryRowOpen").click();
      await window.locator(".workspaceCrumb").waitFor();

      await window.keyboard.press("Control+k");
      await window.getByRole("textbox", { name: "Search commands" }).fill("compare two");
      await window.getByRole("button", { name: /^Compare two branches, tags or commits/ }).click();
      const dialog = window.getByRole("dialog", { name: "Compare branches, tags or commits" });
      await dialog.getByLabel("Base", { exact: true }).fill(original);
      await dialog.getByLabel("Compare with", { exact: true }).fill("feature/cmp");
      await dialog.getByRole("button", { name: "Compare", exact: true }).click();
      await dialog.getByText("extend the feature").waitFor({ timeout: 15_000 });

      const diffWindowPromise = app.waitForEvent("window");
      await dialog.getByRole("button", { name: "a.txt", exact: true }).click();
      const diffWindow = await diffWindowPromise;
      await diffWindow.locator(".diffWindow").waitFor({ state: "visible" });
      await diffWindow.locator(".diffWindowHeader .diffWindowScope").filter({ hasText: "Compare" }).waitFor({ state: "visible" });
      await diffWindow.locator(".unifiedDiff, .splitDiffRow, .monacoDiffHunk").first().waitFor({ state: "attached", timeout: 15_000 });
      await diffWindow.getByText("@@ -1,1 +1,2 @@").waitFor({ state: "visible" });
      // The comparison's other file is a tab of the same window.
      await expect.poll(() => diffWindow.locator(".diffWindowTabSelect").count()).toBe(2);
      await diffWindow.locator(".diffWindowTabSelect").filter({ hasText: "other.txt" }).click();
      await diffWindow.getByText("other", { exact: false }).first().waitFor({ state: "visible" });
      expect(await diffWindow.getByRole("button", { name: "Blame" }).isDisabled()).toBe(true);
    } finally {
      await app?.close();
      app = undefined;
      await fixture.cleanup();
      await rm(appDataPath, { recursive: true, force: true });
    }
  }, 120_000);
});
