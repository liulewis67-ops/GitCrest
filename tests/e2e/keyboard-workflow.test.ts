import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication } from "playwright";
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
    await window.getByRole("button", { name: "Workspace", exact: true }).click();

    await writeFile(resolve(fixture.path, "keyboard.ts"), "export const keyboardWorkflow = true;\n");
    await window.getByRole("button", { name: "Refresh working tree status" }).click();
    await window.getByText("keyboard.ts", { exact: true }).waitFor();
    expect(await window.getByRole("button", { name: "Stage all", exact: true }).isDisabled()).toBe(false);
    await window.keyboard.press("Control+Shift+a");
    await window.getByRole("region", { name: "Staged changes", exact: true }).getByText("keyboard.ts").waitFor();

    const taskDialog = window.getByRole("dialog", { name: "Tasks" });
    if (await taskDialog.count()) await taskDialog.getByRole("button", { name: "Close tasks" }).click();
    const message = window.getByRole("textbox", { name: "Commit message", exact: true });
    await message.fill("keyboard stage and commit");
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
    if (await branchTasksDialog.count()) await branchTasksDialog.getByRole("button", { name: "Close tasks" }).click();
    await window.keyboard.press("Control+b");
    const switchDialog = window.getByRole("dialog", { name: "Switch branch" });
    await switchDialog.waitFor();
    const targetChoice = switchDialog.getByRole("button", { name: /keyboard-target/ });
    await targetChoice.focus();
    await targetChoice.press("Enter");
    await switchDialog.getByText("The working tree is clean.").waitFor();
    const switchButton = switchDialog.getByRole("button", { name: "Switch to keyboard-target" });
    await switchButton.focus();
    await switchButton.press("Enter");
    await expect.poll(async () => await window.evaluate(async (repoId) => {
      const connection = await (globalThis.window as unknown as Window & {
        gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
      }).gitcrest.getSidecarConnection();
      const response = await fetch(new URL(`/api/v1/repositories/${encodeURIComponent(repoId)}`, connection.baseUrl), {
        headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1" },
      });
      return (await response.json() as { branch: string }).branch;
    }, repoId), { timeout: 15_000 }).toBe("keyboard-target");

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
    const tasksButton = window.getByRole("button", { name: /^Background tasks/ });
    await tasksButton.focus();
    await tasksButton.press("Enter");
    const tasksDialog = window.getByRole("dialog", { name: "Tasks" });
    const cherryPickTask = tasksDialog.locator(".taskCard").filter({ has: window.locator(".taskCardHeading strong", { hasText: "cherryPick" }) });
    await cherryPickTask.getByRole("button", { name: "Open conflict resolver" }).waitFor();
    const conflictWindowPromise = app.waitForEvent("window");
    const openResolver = cherryPickTask.getByRole("button", { name: "Open conflict resolver" });
    await openResolver.focus();
    await openResolver.press("Enter");
    const conflictWindow = await conflictWindowPromise;
    await conflictWindow.getByRole("heading", { name: "Resolve conflicts" }).waitFor();
    await conflictWindow.getByRole("button", { name: "Use theirs for conflict 1" }).focus();
    await conflictWindow.keyboard.press("Enter");
    const saveResult = conflictWindow.getByRole("button", { name: "Save result" });
    await saveResult.focus();
    await saveResult.press("Enter");
    await conflictWindow.getByText(/Saved to the working tree/).waitFor();
    const markResolved = conflictWindow.getByRole("button", { name: "Mark resolved" });
    await markResolved.focus();
    await markResolved.press("Enter");
    await conflictWindow.getByText("0 unresolved").waitFor();
    await conflictWindow.close();

    const refreshRecovery = cherryPickTask.getByRole("button", { name: "Refresh preview" });
    await refreshRecovery.focus();
    await refreshRecovery.press("Enter");
    const continueWorkflow = cherryPickTask.getByRole("button", { name: "Continue" });
    await expect.poll(() => continueWorkflow.isDisabled(), { timeout: 15_000 }).toBe(false);
    await continueWorkflow.focus();
    await continueWorkflow.press("Enter");
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
}, 45_000);
