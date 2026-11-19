import { openTaskDetails } from "./task-details";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { createTempGitRepository } from "../fixtures/temp-repo";
import { GitCrestApiClient } from "../../src/api/client";

const execFileAsync = promisify(execFile);

describe("shelf workflow E2E", () => {
  let app: ElectronApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it.each(["Shelves", "Git Stash"])("opens the resolver when %s overlaps an unstaged edit", async (tab) => {
    const fixture = await createTempGitRepository();
    const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-saved-conflict-"));
    const file = resolve(fixture.path, "shared.txt");
    const untracked = resolve(fixture.path, "untracked.txt");
    const git = async (...args: string[]) => (await execFileAsync("git", ["-C", fixture.path, ...args])).stdout.trim();
    try {
      await writeFile(file, "base line\n");
      await git("add", "--", "shared.txt");
      await git("commit", "-qm", "base");
      await writeFile(file, "saved line\n");
      if (tab === "Git Stash") await writeFile(untracked, "saved untracked\n");
      await git("stash", "push", "-u", "-m", "Saved conflict fixture");
      const stashOid = await git("rev-parse", "stash@{0}");
      await writeFile(file, "pre-existing staged line\n");
      await git("add", "--", "shared.txt");
      await writeFile(file, "pre-existing working line\n");
      if (tab === "Git Stash") await writeFile(untracked, "local untracked\n");

      app = await electron.launch({
        args: [".", "--lang=en-US", "--disable-gpu"],
        env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
      });
      const main = await app.firstWindow();
      await main.getByText("Core connected").waitFor({ timeout: 40_000 });
      const connection = await main.evaluate(() => window.gitcrest!.getSidecarConnection());
      const api = new GitCrestApiClient(connection.baseUrl, connection.token);
      const { repoId } = await api.openRepository(fixture.path);
      if (tab === "Shelves") await api.importStash(repoId, stashOid, "Saved conflict fixture", false);

      await main.reload();
      await main.locator(".repositoryRowOpen").click();
      await main.getByRole("tab", { name: tab }).click();
      const panel = main.getByRole("tabpanel", { name: tab });
      const resolverWindow = app.waitForEvent("window", { timeout: 30_000 });
      if (tab === "Shelves") {
        await panel.getByRole("button", { name: /Saved conflict fixture.*file/ }).click();
        await panel.getByRole("button", { name: "Preview apply" }).click();
        await panel.getByRole("button", { name: "Apply reviewed shelf" }).click();
      } else {
        await panel.getByRole("button", { name: "Actions for stash Saved conflict fixture" }).click();
        await main.getByRole("menuitem", { name: "Pop (apply and drop)…" }).click();
        await main.getByRole("dialog").getByRole("button", { name: "Pop stash" }).click();
      }

      const resolver = await resolverWindow;
      await resolver.getByRole("main", { name: "Conflict resolution window" }).waitFor();
      expect(await git("show", ":2:shared.txt")).toBe("pre-existing working line");
      expect(await git("show", ":3:shared.txt")).toBe("saved line");
      if (tab === "Git Stash") {
        expect(await git("show", ":2:untracked.txt")).toBe("local untracked");
        expect(await git("show", ":3:untracked.txt")).toBe("saved untracked");
      }
      await resolver.getByRole("button", { name: "Use incoming", exact: true }).click();
      await resolver.getByRole("button", { name: "Save & mark resolved" }).click();
      if (tab === "Git Stash") {
        await resolver.getByRole("button", { name: "File actions" }).click();
        await resolver.getByRole("menuitem", { name: "Use entire ours" }).click();
        await resolver.getByRole("button", { name: /^(Save & mark resolved|Mark resolved)$/ }).click();
      }
      await resolver.getByRole("button", { name: "Finish resolution" }).click();
      const operation = tab === "Shelves" ? "shelfApply:" : "stashPop:";
      await expect.poll(async () => (await api.listTasks()).find((task) => task.operation.startsWith(operation))?.status, { timeout: 15_000 }).toBe("succeeded");
      expect(await git("show", ":0:shared.txt")).toBe("pre-existing staged line");
      expect((await readFile(file, "utf8")).replace(/\r\n/g, "\n")).toBe("saved line\n");
      expect(await git("stash", "list", "--format=%H")).toBe(stashOid);
      if (tab === "Git Stash") {
        expect(await git("ls-files", "--", "untracked.txt")).toBe("");
        expect((await readFile(untracked, "utf8")).replace(/\r\n/g, "\n")).toBe("local untracked\n");
      }
    } finally {
      await app?.close();
      app = undefined;
      await fixture.cleanup();
      await rm(appDataPath, { recursive: true, force: true });
    }
  }, 100_000);

  it("keeps shelves, CLI stashes, and merge backups in their respective tabs", async () => {
    const fixture = await createTempGitRepository();
    const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-shelf-e2e-app-data-"));
    const sourcePath = resolve(fixture.path, "src/shelved.ts");
    const original = "export const draft = 'base';\n";
    const changed = "export const draft = 'saved in shelf';\n";
    const git = async (...args: string[]) => (await execFileAsync("git", ["-C", fixture.path, ...args])).stdout.trim();

    try {
      await mkdir(resolve(fixture.path, "src"), { recursive: true });
      await writeFile(sourcePath, original);
      await execFileAsync("git", ["-C", fixture.path, "add", "src/shelved.ts"]);
      await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-m", "add shelf fixture"]);
      await writeFile(sourcePath, changed);

      app = await electron.launch({
        args: [".", "--lang=en-US", "--disable-gpu"],
        env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
      });
      const window = await app.firstWindow();
      await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
      await window.getByText("Core connected").waitFor({ timeout: 40_000 });

      const connection = await window.evaluate(() => globalThis.window.gitcrest!.getSidecarConnection());
      const api = new GitCrestApiClient(connection.baseUrl, connection.token);
      const { repoId } = await api.openRepository(fixture.path);

      await window.reload();
      await window.getByRole("heading", { name: "Recent repositories" }).waitFor();
      await window.locator(".repositoryRowOpen").click();
      await window.locator(".workspaceToolbar").waitFor();
      await window.getByRole("button", { name: "Refresh working tree status" }).click();

      const shelvesTab = window.getByRole("tab", { name: "Shelves" });
      const stashTab = window.getByRole("tab", { name: "Git Stash" });
      const shelvesPanel = window.getByRole("tabpanel", { name: "Shelves" });
      const stashPanel = window.getByRole("tabpanel", { name: "Git Stash" });
      await window.getByRole("button", { name: "Shelve changes", exact: true }).click();
      const composer = window.getByRole("dialog", { name: "Shelve selected changes" });
      await composer.getByRole("textbox", { name: "Name" }).fill("E2E working-tree shelf");
      const fileCheckbox = composer.getByRole("checkbox", { name: /src\/shelved\.ts/ });
      await fileCheckbox.click();
      await expect.poll(() => fileCheckbox.isChecked()).toBe(true);
      await composer.getByRole("button", { name: "Create shelf" }).click();

      const shelfButton = window.locator(".shelfSelectButton").filter({ hasText: "E2E working-tree shelf" });
      await shelfButton.waitFor({ state: "visible", timeout: 15_000 });
      await window.getByRole("button", { name: /Background tasks/ }).click();
      await openTaskDetails(window);
      const createTask = window.locator(".taskCard").filter({ has: window.locator('.taskCardHeading strong[data-operation="shelfCreate"]') });
      await createTask.waitFor({ state: "visible" });
      await window.waitForFunction(() => {
        const card = [...document.querySelectorAll(".taskCard")].find((entry) => entry.querySelector(".taskCardHeading strong")?.getAttribute("data-operation") === "shelfCreate");
        return Boolean(card && !["queued", "running"].includes(card.querySelector(".taskStatus")?.getAttribute("data-status") || ""));
      }, undefined, { timeout: 15_000 });
      const createTaskBody = await createTask.innerText();
      if (!createTaskBody.includes("Completed")) throw new Error(`Shelf creation task did not succeed: ${createTaskBody}`);
      expect((await readFile(sourcePath, "utf8")).replace(/\r\n/g, "\n")).toBe(original);
      expect((await execFileAsync("git", ["-C", fixture.path, "diff", "--", "src/shelved.ts"])).stdout).toBe("");
      await window.getByRole("dialog", { name: "Tasks" }).getByRole("button", { name: "Close tasks" }).click();

      await stashTab.click();
      await stashPanel.getByText("This repository has no Git stashes.").waitFor();
      expect(await stashPanel.getByText("E2E working-tree shelf").count()).toBe(0);
      const trackedContent = "export const draft = 'CLI stash content';\n";
      const untrackedContent = "Untracked note in the stash";
      await writeFile(sourcePath, trackedContent);
      await writeFile(resolve(fixture.path, "note.txt"), untrackedContent + "\n");
      await execFileAsync("git", ["-C", fixture.path, "stash", "push", "-u", "-m", "E2E command-line stash"]);

      // Refresh the active tab through the workspace's existing status shortcut.
      await window.keyboard.press("ControlOrMeta+r");
      const stashRow = stashPanel.getByRole("button", { name: "Show files of stash E2E command-line stash" });
      await stashRow.click();
      await stashPanel.getByRole("button", { name: "Open commit diff for src/shelved.ts" }).click();
      const diffPanel = window.locator(".diffPanel");
      await expect.poll(() => diffPanel.textContent({ timeout: 1000 }), { timeout: 15_000 }).toMatch(/CLI\s+stash\s+content/);
      await stashPanel.getByRole("button", { name: "Open commit diff for note.txt" }).click();
      await expect.poll(() => diffPanel.textContent({ timeout: 1000 }), { timeout: 15_000 }).toMatch(/Untracked\s+note\s+in\s+the\s+stash/);

      await stashPanel.getByRole("button", { name: "Actions for stash E2E command-line stash" }).click();
      await window.getByRole("menuitem", { name: "Import as shelf…" }).click();
      const importDialog = window.getByRole("dialog", { name: "Import stash E2E command-line stash as a shelf" });
      await importDialog.getByRole("textbox", { name: "Shelf name" }).fill("E2E imported shelf");
      await importDialog.getByRole("button", { name: "Save as shelf" }).click();
      await stashPanel.getByRole("status").filter({ hasText: "You can view it in Shelves." }).waitFor();
      await stashRow.waitFor();
      expect((await execFileAsync("git", ["-C", fixture.path, "stash", "list"])).stdout).toContain("E2E command-line stash");

      await shelvesTab.click();
      const importedShelf = shelvesPanel.locator(".shelfSelectButton").filter({ hasText: "E2E imported shelf" });
      await importedShelf.click();
      expect(await shelvesPanel.getByText("E2E command-line stash", { exact: true }).count()).toBe(0);
      await shelvesPanel.getByRole("button", { name: "Open shelf diff for note.txt" }).click();
      await expect.poll(() => diffPanel.textContent({ timeout: 1000 }), { timeout: 15_000 }).toMatch(/Untracked\s+note\s+in\s+the\s+stash/);
      await shelvesPanel.getByRole("button", { name: "Open shelf diff for src/shelved.ts" }).click();
      await expect.poll(() => diffPanel.textContent({ timeout: 1000 }), { timeout: 15_000 }).toMatch(/CLI\s+stash\s+content/);
      expect(await diffPanel.textContent()).not.toMatch(/Untracked\s+note/);
      await shelfButton.click();
      const detail = window.getByRole("region", { name: "Shelf preview: E2E working-tree shelf" });
      await detail.waitFor();
      await detail.getByRole("button", { name: "Open shelf diff for src/shelved.ts" }).click();
      await expect.poll(() => diffPanel.textContent({ timeout: 1000 }), { timeout: 15_000 }).toMatch(/saved\s+in\s+shelf/);
      await detail.getByRole("button", { name: "Preview apply" }).click();
      await detail.getByRole("status").filter({ hasText: "Patch applies cleanly" }).waitFor();
      await detail.getByRole("button", { name: "Apply reviewed shelf" }).click();

      await expect.poll(async () => (await readFile(sourcePath, "utf8")).replace(/\r\n/g, "\n"), { timeout: 15_000 }).toBe(changed);
      await expect.poll(() => shelfButton.count(), { timeout: 15_000 }).toBe(0);

      await execFileAsync("git", ["-C", fixture.path, "restore", "src/shelved.ts"]);
      await stashTab.click();
      await stashRow.waitFor();
      await stashPanel.getByRole("button", { name: "Actions for stash E2E command-line stash" }).click();
      await window.getByRole("menuitem", { name: "Pop (apply and drop)…" }).click();
      const popDialog = window.getByRole("dialog", { name: "Pop stash E2E command-line stash" });
      await popDialog.getByRole("button", { name: "Pop stash" }).click();
      await stashPanel.getByText("This repository has no Git stashes.").waitFor({ timeout: 20_000 });
      expect((await execFileAsync("git", ["-C", fixture.path, "stash", "list"])).stdout).toBe("");
      expect((await readFile(sourcePath, "utf8")).replace(/\r\n/g, "\n")).toBe(trackedContent);

      const sourceBranch = await git("branch", "--show-current");
      const expectedHeadOid = await git("rev-parse", "HEAD");
      await git("switch", "-c", "merge-target");
      await git("add", "note.txt");
      await git("commit", "-m", "add merge fixture");
      const targetOid = await git("rev-parse", "HEAD");
      await git("switch", sourceBranch);
      await git("config", "core.hooksPath", ".git/hooks");
      await writeFile(resolve(fixture.path, ".git", "hooks", "pre-merge-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

      const merge = await api.startRepositoryWorkflow(repoId, { action: "merge", expectedHeadOid, targetOid, noFastForward: true });
      await expect.poll(() => git("rev-parse", "--verify", "MERGE_HEAD").catch(() => ""), { timeout: 15_000 }).toBe(targetOid);
      const backupName = "GitCrest merge " + merge.taskId;
      expect(await git("stash", "list")).toContain(backupName);
      await stashPanel.getByRole("button", { name: "Show files of stash " + backupName }).waitFor({ timeout: 20_000 });
    } finally {
      await app?.close();
      app = undefined;
      await fixture.cleanup();
      await rm(appDataPath, { recursive: true, force: true });
    }
  }, 90_000);
});
