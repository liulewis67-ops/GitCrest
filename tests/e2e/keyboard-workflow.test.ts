import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication } from "playwright";
import { expect, it } from "vitest";
import { createTempGitRepository } from "../fixtures/temp-repo";

const execFileAsync = promisify(execFile);

it("opens a repository, stages, commits, and switches branches through keyboard actions", async () => {
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
  } finally {
    await app?.close();
    await fixture.cleanup();
    await rm(appDataPath, { recursive: true, force: true });
  }
}, 45_000);
