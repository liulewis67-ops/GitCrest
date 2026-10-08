import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { createTempGitRepository } from "../fixtures/temp-repo";

const execFileAsync = promisify(execFile);

describe("desktop startup E2E", () => {
  let app: ElectronApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("starts Electron and the authenticated sidecar with a disposable Git fixture", async () => {
    const fixture = await createTempGitRepository();
    const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-e2e-app-data-"));
    try {
      expect(fixture.path).toContain("gitcrest-e2e-");

      app = await electron.launch({
        args: ["."],
        env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
      });
      const window = await app.firstWindow();
      await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
      await window.waitForFunction(
        () => document.body.innerText.includes("Core connected") || document.body.innerText.includes("Connecting to engine"),
        undefined,
        { timeout: 15_000 },
      );
      const body = await window.locator("body").innerText();
      expect(body).toContain("Core connected");
      expect(body).toContain("gitcrest-core 0.1.0 (API v1)");
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);

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
        return { status: response.status, body: await response.json() };
      }, fixture.path);
      expect(opened.status).toBe(200);
      expect(opened.body).toMatchObject({
        path: fixture.path,
        head: null,
        detached: false,
        state: "normal",
        isFavorite: false,
        availability: "available",
      });
      expect(opened.body.repoId).toMatch(/^repo_[0-9a-f]{64}$/);

      await window.reload();
      await window.getByRole("heading", { name: "Recent repositories" }).waitFor();
      expect(await window.locator(".repositoryList").innerText()).toContain(fixture.path);
      await window.locator(".repositoryRowOpen").click();
      await window.locator(".workspaceCrumb").waitFor();
      expect(await window.locator(".workspaceCrumb").innerText()).toContain(fixture.path);

      await window.getByRole("button", { name: "Workspace", exact: true }).click();
      await mkdir(resolve(fixture.path, "src"), { recursive: true });
      await writeFile(resolve(fixture.path, "src/example.ts"), "export const greeting = 'hello';\n");
      await writeFile(resolve(fixture.path, "src/other.ts"), "export const sibling = 'base';\n");
      await execFileAsync("git", ["-C", fixture.path, "add", "src/example.ts", "src/other.ts"]);
      await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-m", "add source fixture"]);
      const originalBranch = (await execFileAsync("git", ["-C", fixture.path, "branch", "--show-current"])).stdout.trim();
      await execFileAsync("git", ["-C", fixture.path, "checkout", "--quiet", "-b", "feature/e2e"]);
      await writeFile(resolve(fixture.path, "src/example.ts"), "export const greeting = 'feature branch';\n");
      await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-am", "change feature branch"]);
      await execFileAsync("git", ["-C", fixture.path, "checkout", "--quiet", originalBranch]);
      await writeFile(resolve(fixture.path, "src/example.ts"), "export const greeting = 'welcome';\n");
      await writeFile(resolve(fixture.path, "src/other.ts"), "export const sibling = 'changed';\n");
      await window.getByRole("button", { name: "Refresh working tree status" }).click();
      await window.keyboard.press("Control+b");
      const dirtySwitchDialog = window.getByRole("dialog", { name: "Switch branch" });
      await dirtySwitchDialog.waitFor();
      await dirtySwitchDialog.getByRole("button", { name: /feature\/e2e/ }).click();
      await dirtySwitchDialog.getByText("src/example.ts").waitFor();
      expect(await dirtySwitchDialog.getByText("May be overwritten").count()).toBe(1);
      expect(await dirtySwitchDialog.getByRole("button", { name: "Shelve changes" }).isDisabled()).toBe(false);
      await dirtySwitchDialog.getByRole("button", { name: "Cancel" }).click();
      await dirtySwitchDialog.waitFor({ state: "detached" });
      expect(await window.getByTitle("Switch branches (Ctrl/Cmd+B)").innerText()).toContain(originalBranch);
      await window.getByRole("button", { name: "modified src/example.ts" }).click();
      const rendererErrors: string[] = [];
      window.on("console", (message) => { if (message.type() === "error") rendererErrors.push(message.text()); });
      await window.getByRole("button", { name: "Monaco view" }).click();
      const monacoLines = window.locator(".monacoDiffHunk .view-lines");
      await monacoLines.first().waitFor({ state: "visible", timeout: 15_000 });
      expect(await monacoLines.last().innerText()).toContain("welcome");
      const parsedHunk = window.locator(".monacoDiffHunk").first();
      await parsedHunk.waitFor({ state: "visible" });
      expect(["parsed", "recovered"], rendererErrors.join("\n")).toContain(await parsedHunk.getAttribute("data-tree-sitter-state"));

      const diffWindowPromise = app.waitForEvent("window");
      await window.getByRole("button", { name: "Open in Diff window" }).click();
      const diffWindow = await diffWindowPromise;
      await diffWindow.locator(".diffWindow").waitFor({ state: "visible" });
      await diffWindow.locator(".diffWindowHeader .sectionEyebrow").waitFor({ state: "visible" });
      await diffWindow.locator(".splitDiffRow").first().waitFor({ state: "visible" });
      expect(await diffWindow.locator(".diffWindowTabSelect").count()).toBe(2);
      await diffWindow.locator(".diffWindowTabSelect").filter({ hasText: "src/other.ts" }).click();
      await diffWindow.getByText("changed", { exact: false }).waitFor({ state: "visible" });
      await diffWindow.getByRole("button", { name: "Blame" }).click();
      await diffWindow.locator(".blameView").waitFor({ state: "visible" });
      expect(await diffWindow.locator(".blameView").innerText()).toContain("sibling = 'changed'");
      expect(await diffWindow.locator(".blameView").innerText()).toContain("Not Committed Yet");
      await diffWindow.locator(".diffWindowTabSelect").filter({ hasText: "src/example.ts" }).click();
      await diffWindow.locator(".splitDiffRow").first().waitFor({ state: "visible" });
      await diffWindow.getByRole("button", { name: "Close src/other.ts tab" }).click();
      expect(await diffWindow.locator(".diffWindowTabSelect").count()).toBe(1);
      await diffWindow.getByRole("button", { name: "Unified" }).click();
      expect(await diffWindow.locator(".unifiedDiff").count()).toBe(1);
      const readonlyResult = await diffWindow.evaluate(async (repoId) => {
        const connection = await (globalThis.window as unknown as Window & {
          gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string; windowAccess: string }> };
        }).gitcrest.getSidecarConnection();
        const response = await fetch(new URL(`/api/v1/repositories/${encodeURIComponent(repoId)}/commits`, connection.baseUrl), {
          method: "POST",
          headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1", "Content-Type": "application/json" },
          body: JSON.stringify({ message: "must not commit from diff window" }),
        });
        return { access: connection.windowAccess, status: response.status };
      }, opened.body.repoId as string);
      expect(readonlyResult).toEqual({ access: "readOnly", status: 403 });
      await diffWindow.close();
      expect(await window.locator(".monacoDiffHunk").count()).toBeGreaterThan(0);

      await execFileAsync("git", ["-C", fixture.path, "checkout", "--", "src/example.ts", "src/other.ts"]);
      await window.getByRole("button", { name: "Refresh working tree status" }).click();
      await window.keyboard.press("Control+b");
      const cleanSwitchDialog = window.getByRole("dialog", { name: "Switch branch" });
      await cleanSwitchDialog.waitFor();
      await cleanSwitchDialog.getByRole("button", { name: /feature\/e2e/ }).click();
      await cleanSwitchDialog.getByText("The working tree is clean.").waitFor();
      await cleanSwitchDialog.getByRole("button", { name: "Switch to feature/e2e" }).click();
      await window.waitForFunction(() => document.querySelector('[title="Switch branches (Ctrl/Cmd+B)"]')?.textContent?.includes("feature/e2e") === true, undefined, { timeout: 15_000 });

      await window.setViewportSize({ width: 900, height: 820 });
      expect(await window.locator(".navigationPanel").isVisible()).toBe(false);
      expect(await window.locator(".mainPanel").isVisible()).toBe(true);
      expect(await window.locator(".commitSection").isVisible()).toBe(false);
      await window.setViewportSize({ width: 1280, height: 820 });

      const mainOid = (await execFileAsync("git", ["-C", fixture.path, "rev-parse", originalBranch])).stdout.trim();
      const rebaseApiPreview = await window.evaluate(async ({ repoId, ontoOid }) => {
        const connection = await (globalThis.window as unknown as Window & {
          gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
        }).gitcrest.getSidecarConnection();
        const url = new URL(`/api/v1/repositories/${encodeURIComponent(repoId)}/workflows/rebase-preview`, connection.baseUrl);
        url.searchParams.set("ontoOid", ontoOid);
        const response = await fetch(url, { headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1" } });
        return { status: response.status, body: await response.json() };
      }, { repoId: opened.body.repoId as string, ontoOid: mainOid });
      expect(rebaseApiPreview.status).toBe(200);
      expect(rebaseApiPreview.body.commits.map((commit: { subject: string }) => commit.subject)).toContain("change feature branch");
      await window.keyboard.press("Control+i");
      const rebaseDialog = window.getByRole("dialog", { name: "Interactive rebase" });
      await rebaseDialog.waitFor();
      await rebaseDialog.getByLabel("Rebase current branch onto").selectOption(mainOid);
      await rebaseDialog.getByRole("button", { name: "Refresh preview" }).click();
      try {
        await rebaseDialog.getByText("change feature branch").waitFor({ timeout: 10_000 });
      } catch {
        throw new Error(`Rebase preview did not load the expected commit: ${await rebaseDialog.innerText()}`);
      }
      const rebaseAction = rebaseDialog.locator("select[aria-label^='Action for']").first();
      await rebaseAction.selectOption("reword");
      await rebaseDialog.getByLabel(/Replacement message/).fill("Interactive rebase E2E message");
      await rebaseDialog.getByRole("button", { name: "Start rebase" }).click();
      const rebaseTaskCard = window.locator(".taskCard").filter({ has: window.locator(".taskCardHeading strong", { hasText: "rebase" }) });
      await rebaseTaskCard.waitFor({ state: "visible" });
      await window.waitForFunction(() => Array.from(document.querySelectorAll(".taskCard")).some((card) => card.querySelector(".taskCardHeading strong")?.textContent === "rebase" && card.querySelector(".taskStatus")?.textContent === "succeeded"), undefined, { timeout: 20_000 });
      await rebaseTaskCard.locator(".taskLogs summary").click();
      expect(await rebaseTaskCard.innerText()).toContain("refs/gitcrest/rebase-backups/");
      expect((await execFileAsync("git", ["-C", fixture.path, "log", "-1", "--format=%s"])).stdout.trim()).toBe("Interactive rebase E2E message");

      await window.keyboard.press("Control+i");
      const rollbackDialog = window.getByRole("dialog", { name: "Interactive rebase" });
      await rollbackDialog.waitFor();
      await rollbackDialog.getByLabel(/moves the current branch/).check();
      await rollbackDialog.getByRole("button", { name: "Restore selected backup" }).click();
      const rollbackTaskCard = window.locator(".taskCard").filter({ has: window.locator(".taskCardHeading strong", { hasText: "rebaseRollback" }) });
      await rollbackTaskCard.waitFor({ state: "visible" });
      await window.waitForFunction(() => Array.from(document.querySelectorAll(".taskCard")).some((card) => card.querySelector(".taskCardHeading strong")?.textContent === "rebaseRollback" && card.querySelector(".taskStatus")?.textContent === "succeeded"), undefined, { timeout: 20_000 });
      expect((await execFileAsync("git", ["-C", fixture.path, "log", "-1", "--format=%s"])).stdout.trim()).toBe("change feature branch");

      await window.getByRole("dialog", { name: "Tasks" }).getByRole("button", { name: "Close tasks" }).click();
      await window.keyboard.press("Control+k");
      const commandPalette = window.getByRole("dialog", { name: "Command palette" });
      await commandPalette.getByRole("button", { name: /Reset current branch/ }).click();
      const resetDialog = window.getByRole("dialog", { name: "Reset current branch" });
      await resetDialog.waitFor();
      await resetDialog.locator("#reset-target").selectOption(mainOid);
      await resetDialog.getByRole("button", { name: "Review impact" }).click();
      await resetDialog.getByText(/Affected paths/).waitFor();
      await resetDialog.getByLabel(/I reviewed the commit and path impact/).check();
      await resetDialog.getByRole("button", { name: "Reset mixed" }).click();
      const resetTaskCard = window.locator(".taskCard").filter({ has: window.locator(".taskCardHeading strong", { hasText: "reset" }) });
      await resetTaskCard.waitFor({ state: "visible" });
      await window.waitForFunction(() => Array.from(document.querySelectorAll(".taskCard")).some((card) => card.querySelector(".taskCardHeading strong")?.textContent === "reset" && card.querySelector(".taskStatus")?.textContent === "succeeded"), undefined, { timeout: 20_000 });
      expect((await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD"])).stdout.trim()).toBe(mainOid);

      const forgotten = await window.evaluate(async (repoId) => {
        const connection = await (globalThis.window as unknown as Window & {
          gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
        }).gitcrest.getSidecarConnection();
        const response = await fetch(new URL(`/api/v1/repositories/${encodeURIComponent(repoId)}`, connection.baseUrl), {
          method: "DELETE",
          headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1" },
        });
        return response.status;
      }, opened.body.repoId as string);
      expect(forgotten).toBe(204);

      if (process.env.GITCREST_CAPTURE_E2E === "1") {
        const evidencePath = resolve("doc/evidence/S0.4");
        await mkdir(evidencePath, { recursive: true });
        await window.getByRole("button", { name: "Welcome", exact: true }).click();
        await window.screenshot({ path: resolve(evidencePath, "welcome.png") });
        const themeButton = window.getByRole("button", { name: /Color theme:/ });
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if ((await themeButton.getAttribute("aria-label"))?.includes("dark")) break;
          await themeButton.click();
        }
        await window.screenshot({ path: resolve(evidencePath, "welcome-dark.png") });
        await window.getByRole("button", { name: "Workspace", exact: true }).click();
        await window.screenshot({ path: resolve(evidencePath, "workspace-dark.png") });
        await themeButton.click();
        await window.screenshot({ path: resolve(evidencePath, "workspace-light.png") });
      }
    } finally {
      await app?.close();
      app = undefined;
      await fixture.cleanup();
      await rm(appDataPath, { recursive: true, force: true });
    }
  }, 60_000);
});
