import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { expect, it } from "vitest";
import { createTempGitRepository } from "../fixtures/temp-repo";

const execFileAsync = promisify(execFile);

it("opens a repository, stages, commits, switches branches, and resolves a conflict with the keyboard", async () => {
  const fixture = await createTempGitRepository();
  const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-keyboard-app-data-"));
  let app: ElectronApplication | undefined;
  try {
    await writeFile(resolve(fixture.path, "seed.txt"), "seed\n");
    await execFileAsync("git", ["-C", fixture.path, "add", "seed.txt"]);
    await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-m", "seed"]);

    app = await electron.launch({
      args: ["."],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
    await window.getByText("Core connected").waitFor({ timeout: 15_000 });

    await app.evaluate(({ dialog }, repositoryPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repositoryPath] });
    }, fixture.path);
    await window.keyboard.press("Control+o");
    await window.locator(".workspaceCrumb").waitFor();
    expect(await window.locator(".workspaceCrumb").innerText()).toContain(fixture.path);

    const repoId = await window.evaluate(async (repositoryPath) => {
      const connection = await (globalThis.window as unknown as Window & {
        gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
      }).gitcrest.getSidecarConnection();
      const response = await fetch(new URL("/api/v1/repositories", connection.baseUrl), {
        headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1" },
      });
      const repositories = await response.json() as Array<{ repoId: string; path: string }>;
      return repositories.find((repository) => repository.path === repositoryPath)?.repoId;
    }, fixture.path);
    if (!repoId) throw new Error("The keyboard-opened repository was not registered.");
    await enterButtonByTab(window, "Workspace");

    await writeFile(resolve(fixture.path, "keyboard.ts"), "export const keyboardWorkflow = true;\n");
    await enterButtonByTab(window, "Refresh working tree status");
    await window.getByText("keyboard.ts", { exact: true }).waitFor();
    expect(await window.getByRole("button", { name: "Stage all", exact: true }).isDisabled()).toBe(false);
    await window.keyboard.press("Control+Shift+a");
    await window.getByRole("region", { name: "Staged changes", exact: true }).getByText("keyboard.ts").waitFor();

    const taskDialog = window.getByRole("dialog", { name: "Tasks" });
    if (await taskDialog.count()) await enterButtonByTab(window, "Close tasks");
    const message = window.getByRole("textbox", { name: "Commit message", exact: true });
    await message.focus();
    await window.keyboard.type("keyboard stage and commit");
    await message.press("Control+Enter");
    await expect.poll(async () => (await execFileAsync("git", ["-C", fixture.path, "log", "-1", "--format=%s"])).stdout.trim(), { timeout: 15_000 }).toBe("keyboard stage and commit");
    expect((await execFileAsync("git", ["-C", fixture.path, "status", "--porcelain"])).stdout.trim()).toBe("");

    const branchCreation = await window.evaluate(async ({ repoId, name }) => {
      const connection = await (globalThis.window as unknown as Window & {
        gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
      }).gitcrest.getSidecarConnection();
      const response = await fetch(new URL(`/api/v1/repositories/${encodeURIComponent(repoId)}/branches`, connection.baseUrl), {
        method: "POST",
        headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      return response.status;
    }, { repoId, name: "keyboard-target" });
    expect(branchCreation).toBe(202);
    await window.locator(".branchItemName").filter({ hasText: "keyboard-target" }).waitFor();
    const branchTasksDialog = window.getByRole("dialog", { name: "Tasks" });
    if (await branchTasksDialog.count()) await enterButtonByTab(window, "Close tasks");
    await window.keyboard.press("Control+b");
    const switchDialog = window.getByRole("dialog", { name: "Switch branch" });
    await switchDialog.waitFor();
    await enterButtonByTab(window, "keyboard-target");
    await switchDialog.getByText("The working tree is clean.").waitFor();
    await enterButtonByTab(window, "Switch to keyboard-target");
    await expect.poll(async () => await window.evaluate(async (repoId) => {
      const connection = await (globalThis.window as unknown as Window & {
        gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
      }).gitcrest.getSidecarConnection();
      const response = await fetch(new URL(`/api/v1/repositories/${encodeURIComponent(repoId)}`, connection.baseUrl), {
        headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1" },
      });
      return (await response.json() as { branch: string }).branch;
    }, repoId), { timeout: 15_000 }).toBe("keyboard-target");

    const resetBaseOid = (await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD"])).stdout.trim();
    await execFileAsync("git", ["-C", fixture.path, "branch", "keyboard-reset-base", resetBaseOid]);
    await writeFile(resolve(fixture.path, "reset-trigger.ts"), "export const reviewedReset = true;\n");
    await enterButtonByTab(window, "Refresh working tree status");
    await window.getByText("reset-trigger.ts", { exact: true }).waitFor();
    await window.keyboard.press("Control+Shift+a");
    await window.getByRole("region", { name: "Staged changes", exact: true }).getByText("reset-trigger.ts").waitFor();
    await window.getByRole("textbox", { name: "Commit message", exact: true }).focus();
    await window.keyboard.type("keyboard reset review");
    await window.keyboard.press("Control+Enter");
    await expect.poll(async () => (await execFileAsync("git", ["-C", fixture.path, "log", "-1", "--format=%s"])).stdout.trim(), { timeout: 15_000 }).toBe("keyboard reset review");
    await window.keyboard.press("Control+k");
    await window.keyboard.type("Reset current branch");
    await enterButtonByTab(window, "Reset current branch");
    const resetDialog = window.getByRole("dialog", { name: "Reset current branch" });
    await resetDialog.waitFor();
    const resetTarget = resetDialog.locator("#reset-target");
    await expect.poll(() => resetTarget.isDisabled(), { timeout: 15_000 }).toBe(false);
    await focusControlByTab(window, "reset-target");
    const resetTargetIndex = await resetTarget.locator("option").evaluateAll((options, targetOid) => options.findIndex((option) => option.textContent?.includes("keyboard-reset-base") && option.getAttribute("value") === targetOid), resetBaseOid);
    if (resetTargetIndex < 1) throw new Error("The keyboard reset target was not available in the branch commit list.");
    await window.keyboard.press("Home");
    for (let index = 0; index < resetTargetIndex; index += 1) await window.keyboard.press("ArrowDown");
    await window.keyboard.press("Enter");
    await enterButtonByTab(window, "Review impact");
    await resetDialog.getByText(/Affected paths/).waitFor();
    await focusControlByTab(window, "I reviewed the commit and path impact");
    await window.keyboard.press("Space");
    await enterButtonByTab(window, "Reset mixed");
    await expect.poll(async () => await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD"]).then(({ stdout }) => stdout.trim()), { timeout: 15_000 }).toBe(resetBaseOid);
    await execFileAsync("git", ["-C", fixture.path, "clean", "--quiet", "-f", "--", "reset-trigger.ts"]);

    const seedOid = (await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD~1"])).stdout.trim();
    await execFileAsync("git", ["-C", fixture.path, "branch", "keyboard-conflict-source", seedOid]);
    await execFileAsync("git", ["-C", fixture.path, "switch", "keyboard-conflict-source"]);
    await writeFile(resolve(fixture.path, "seed.txt"), "theirs conflict version\n");
    await execFileAsync("git", ["-C", fixture.path, "add", "seed.txt"]);
    await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-m", "source conflict change"]);
    const sourceOid = (await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD"])).stdout.trim();
    await execFileAsync("git", ["-C", fixture.path, "switch", "keyboard-target"]);
    await writeFile(resolve(fixture.path, "seed.txt"), "ours conflict version\n");
    await execFileAsync("git", ["-C", fixture.path, "add", "seed.txt"]);
    await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-m", "target conflict change"]);
    const expectedHeadOid = (await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD"])).stdout.trim();
    const cherryPick = await window.evaluate(async ({ repoId, targetOid, headOid }) => {
      const connection = await (globalThis.window as unknown as Window & {
        gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
      }).gitcrest.getSidecarConnection();
      const response = await fetch(new URL(`/api/v1/repositories/${encodeURIComponent(repoId)}/workflows`, connection.baseUrl), {
        method: "POST",
        headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cherryPick", targetOid, expectedHeadOid: headOid }),
      });
      return { status: response.status, task: await response.json() as { taskId: string; createdAtMs: number } };
    }, { repoId, targetOid: sourceOid, headOid: expectedHeadOid });
    expect(cherryPick.status).toBe(202);
    await enterButtonByTab(window, "Background tasks");
    const tasksDialog = window.getByRole("dialog", { name: "Tasks" });
    const cherryPickTask = tasksDialog.locator(".taskCard").filter({ has: window.locator(".taskCardHeading strong", { hasText: "cherryPick" }) });
    await cherryPickTask.getByRole("button", { name: "Open conflict resolver" }).waitFor();
    const conflictWindowPromise = app.waitForEvent("window");
    await enterButtonByTab(window, "Open conflict resolver");
    const conflictWindow = await conflictWindowPromise;
    await conflictWindow.getByRole("heading", { name: "Resolve conflicts" }).waitFor();
    await conflictWindow.bringToFront();
    await conflictWindow.getByRole("button", { name: "Use theirs for conflict 1" }).waitFor();
    await enterButtonByTab(conflictWindow, "Use theirs for conflict 1");
    await enterButtonByTab(conflictWindow, "Save result");
    await conflictWindow.getByText(/Saved to the working tree/).waitFor();
    await enterButtonByTab(conflictWindow, "Mark resolved");
    await conflictWindow.getByText("0 unresolved").waitFor();
    await conflictWindow.close();

    await enterButtonByTab(window, "Refresh preview");
    const continueWorkflow = cherryPickTask.getByRole("button", { name: "Continue" });
    await expect.poll(() => continueWorkflow.isDisabled(), { timeout: 15_000 }).toBe(false);
    await enterButtonByTab(window, "Continue");
    await expect.poll(async () => await window.evaluate(async ({ repoId, startTime }) => {
      const connection = await (globalThis.window as unknown as Window & {
        gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
      }).gitcrest.getSidecarConnection();
      const response = await fetch(new URL("/api/v1/tasks", connection.baseUrl), {
        headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1" },
      });
      const tasks = await response.json() as Array<{ taskId: string; repoId: string | null; operation: string; status: string; createdAtMs: number }>;
      return tasks.find((task) => task.repoId === repoId && task.operation === "workflowContinue" && task.createdAtMs >= startTime)?.status;
    }, { repoId, startTime: cherryPick.task.createdAtMs }), { timeout: 15_000 }).toBe("succeeded");
    await expect.poll(async () => await window.evaluate(async (taskId) => {
      const connection = await (globalThis.window as unknown as Window & {
        gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
      }).gitcrest.getSidecarConnection();
      const response = await fetch(new URL("/api/v1/tasks", connection.baseUrl), {
        headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1" },
      });
      const tasks = await response.json() as Array<{ taskId: string; status: string }>;
      return tasks.find((task) => task.taskId === taskId)?.status;
    }, cherryPick.task.taskId), { timeout: 15_000 }).toBe("succeeded");
    expect((await execFileAsync("git", ["-C", fixture.path, "show", "HEAD:seed.txt"])).stdout).toBe("theirs conflict version\n");
  } finally {
    await app?.close();
    await fixture.cleanup();
    await rm(appDataPath, { recursive: true, force: true });
  }
}, 75_000);

async function enterButtonByTab(page: Page, label: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const focusedButton = await page.evaluate(() => {
      const active = document.activeElement;
      return active instanceof HTMLButtonElement
        ? `${active.getAttribute("aria-label") || ""} ${active.innerText}`.trim()
        : "";
    });
    if (focusedButton.includes(label)) {
      await page.keyboard.press("Enter");
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error(`Could not reach the ${label} button by pressing Tab.`);
}

async function focusControlByTab(page: Page, label: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const isFocused = await page.evaluate((expected) => {
      const active = document.activeElement;
      const labels = active instanceof HTMLInputElement ? Array.from(active.labels || []).map((item) => item.innerText).join(" ") : "";
      return active instanceof HTMLElement && `${active.id} ${active.getAttribute("aria-label") || ""} ${labels}`.includes(expected);
    }, label);
    if (isFocused) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Could not reach the ${label} control by pressing Tab.`);
}
