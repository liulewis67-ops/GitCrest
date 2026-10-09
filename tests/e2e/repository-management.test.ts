import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication } from "playwright";
import { expect, it } from "vitest";
import { createTempGitRepository } from "../fixtures/temp-repo";

const execFileAsync = promisify(execFile);

it("initializes a repository in the selected project folder and keeps its files", async () => {
  const projectPath = await mkdtemp(resolve(tmpdir(), "gitcrest-init-e2e-project-"));
  const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-init-e2e-app-data-"));
  const projectFile = resolve(projectPath, "README.md");
  let app: ElectronApplication | undefined;

  try {
    await writeFile(projectFile, "# Existing project\n");
    app = await electron.launch({
      args: ["."],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
    await window.getByText("Core connected").waitFor({ timeout: 15_000 });
    await app.evaluate(({ dialog }, destination) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] });
    }, projectPath);

    await window.getByRole("button", { name: "Initialize a repository" }).click();
    await window.locator(".workspaceCrumb").filter({ hasText: projectPath }).waitFor({ timeout: 10_000 });
    expect((await execFileAsync("git", ["-C", projectPath, "rev-parse", "--show-toplevel"])).stdout.trim().replace(/\//g, "\\")).toBe(projectPath);
    expect(await readFile(projectFile, "utf8")).toBe("# Existing project\n");
  } finally {
    await app?.close();
    await rm(projectPath, { recursive: true, force: true });
    await rm(appDataPath, { recursive: true, force: true });
  }
}, 60_000);

it("leaves the project unchanged when repository initialization is cancelled in the folder picker", async () => {
  const projectPath = await mkdtemp(resolve(tmpdir(), "gitcrest-init-cancel-e2e-project-"));
  const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-init-cancel-e2e-app-data-"));
  const projectFile = resolve(projectPath, "README.md");
  let app: ElectronApplication | undefined;

  try {
    await writeFile(projectFile, "# Keep this project unchanged\n");
    app = await electron.launch({
      args: ["."],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
    await window.getByText("Core connected").waitFor({ timeout: 15_000 });
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    });

    await window.getByRole("button", { name: "Initialize a repository" }).click();
    await window.getByRole("button", { name: "Initialize a repository" }).waitFor({ state: "visible" });
    await expect(execFileAsync("git", ["-C", projectPath, "rev-parse", "--show-toplevel"])).rejects.toThrow();
    expect(await readFile(projectFile, "utf8")).toBe("# Keep this project unchanged\n");
    expect(await window.locator(".workspaceCrumb").count()).toBe(0);
  } finally {
    await app?.close();
    await rm(projectPath, { recursive: true, force: true });
    await rm(appDataPath, { recursive: true, force: true });
  }
}, 60_000);

it("clones a remote from the welcome page and opens the new repository", async () => {
  const source = await createTempGitRepository();
  const remoteRoot = await mkdtemp(resolve(tmpdir(), "gitcrest-clone-e2e-remotes-"));
  const cloneParent = await mkdtemp(resolve(tmpdir(), "gitcrest-clone-e2e-parent-"));
  const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-clone-e2e-app-data-"));
  const remotePath = resolve(remoteRoot, "source.git");
  const cloneRemoteUrl = "https://clone-e2e.invalid/source.git";
  const clonePath = resolve(cloneParent, "cloned-project");
  const gitConfigPath = resolve(appDataPath, "gitconfig");
  let app: ElectronApplication | undefined;

  try {
    await mkdir(resolve(source.path, "src"), { recursive: true });
    await writeFile(resolve(source.path, "src/clone-e2e.ts"), "export const cloned = true;\n");
    await execFileAsync("git", ["-C", source.path, "add", "src/clone-e2e.ts"]);
    await execFileAsync("git", ["-C", source.path, "commit", "--quiet", "-m", "clone fixture commit"]);
    await execFileAsync("git", ["init", "--bare", "--quiet", remotePath]);
    await execFileAsync("git", ["-C", source.path, "remote", "add", "origin", remotePath]);
    await execFileAsync("git", ["-C", source.path, "push", "--quiet", "--set-upstream", "origin", "HEAD"]);
    await writeFile(gitConfigPath, `[url "${remotePath.replace(/\\/g, "/")}"]\n\tinsteadOf = ${cloneRemoteUrl}\n`);
    const gitEnvironment = { ...process.env, GIT_CONFIG_GLOBAL: gitConfigPath, GIT_CONFIG_NOSYSTEM: "1" };
    const rewrittenHead = (await execFileAsync("git", ["ls-remote", cloneRemoteUrl, "HEAD"], { env: gitEnvironment })).stdout.trim().split(/\s+/)[0];
    expect(rewrittenHead).toBe((await execFileAsync("git", ["-C", source.path, "rev-parse", "HEAD"])).stdout.trim());

    app = await electron.launch({
      args: ["."],
      env: { ...gitEnvironment, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
    await window.getByText("Core connected").waitFor({ timeout: 15_000 });
    await app.evaluate(({ dialog }, destination) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] });
    }, cloneParent);

    await window.getByRole("button", { name: "Clone repository", exact: true }).click();
    const cloneDialog = window.getByRole("dialog", { name: "Clone repository" });
    await cloneDialog.getByRole("textbox", { name: "Remote URL" }).fill(cloneRemoteUrl);
    await cloneDialog.getByRole("button", { name: "Choose folder" }).click();
    await cloneDialog.getByText(cloneParent, { exact: true }).waitFor();
    await cloneDialog.getByRole("textbox", { name: "Folder name" }).fill("cloned-project");
    await cloneDialog.getByRole("button", { name: "Start clone" }).click();

    await window.locator(".workspaceCrumb").filter({ hasText: clonePath }).waitFor({ timeout: 10_000 });
    await expect.poll(async () => (await execFileAsync("git", ["-C", clonePath, "rev-parse", "HEAD"])).stdout.trim()).toBe(
      (await execFileAsync("git", ["-C", source.path, "rev-parse", "HEAD"])).stdout.trim(),
    );
    expect(await readFile(resolve(clonePath, "src/clone-e2e.ts"), "utf8")).toBe("export const cloned = true;\n");
  } finally {
    await app?.close();
    await source.cleanup();
    await rm(remoteRoot, { recursive: true, force: true });
    await rm(cloneParent, { recursive: true, force: true });
    await rm(appDataPath, { recursive: true, force: true });
  }
}, 60_000);

it("retries a failed clone from Task Center after the remote becomes available", async () => {
  const source = await createTempGitRepository();
  const remoteRoot = await mkdtemp(resolve(tmpdir(), "gitcrest-clone-retry-e2e-remotes-"));
  const cloneParent = await mkdtemp(resolve(tmpdir(), "gitcrest-clone-retry-e2e-parent-"));
  const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-clone-retry-e2e-app-data-"));
  const remotePath = resolve(remoteRoot, "source.git");
  const missingRemotePath = resolve(remoteRoot, "source-not-ready.git");
  const cloneRemoteUrl = "https://clone-retry-e2e.invalid/source.git";
  const clonePath = resolve(cloneParent, "retry-project");
  const gitConfigPath = resolve(appDataPath, "gitconfig");
  let app: ElectronApplication | undefined;

  try {
    await mkdir(resolve(source.path, "src"), { recursive: true });
    await writeFile(resolve(source.path, "src/clone-retry.ts"), "export const retried = true;\n");
    await execFileAsync("git", ["-C", source.path, "add", "src/clone-retry.ts"]);
    await execFileAsync("git", ["-C", source.path, "commit", "--quiet", "-m", "clone retry fixture commit"]);
    await execFileAsync("git", ["init", "--bare", "--quiet", remotePath]);
    await execFileAsync("git", ["-C", source.path, "remote", "add", "origin", remotePath]);
    await execFileAsync("git", ["-C", source.path, "push", "--quiet", "--set-upstream", "origin", "HEAD"]);
    const writeRewrite = (target: string) => writeFile(
      gitConfigPath,
      `[url "${target.replace(/\\/g, "/")}"]\n\tinsteadOf = ${cloneRemoteUrl}\n`,
    );
    await writeRewrite(missingRemotePath);

    app = await electron.launch({
      args: ["."],
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: gitConfigPath,
        GIT_CONFIG_NOSYSTEM: "1",
        ELECTRON_RENDERER_URL: "",
        GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite"),
      },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
    await window.getByText("Core connected").waitFor({ timeout: 15_000 });
    await app.evaluate(({ dialog }, destination) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] });
    }, cloneParent);

    await window.getByRole("button", { name: "Clone repository", exact: true }).click();
    let cloneDialog = window.getByRole("dialog", { name: "Clone repository" });
    await cloneDialog.getByRole("textbox", { name: "Remote URL" }).fill(cloneRemoteUrl);
    await cloneDialog.getByRole("button", { name: "Choose folder" }).click();
    await cloneDialog.getByText(cloneParent, { exact: true }).waitFor();
    await cloneDialog.getByRole("textbox", { name: "Folder name" }).fill("retry-project");
    await cloneDialog.getByRole("button", { name: "Start clone" }).click();

    const tasksDialog = window.getByRole("dialog", { name: "Tasks" });
    const cloneTask = tasksDialog.locator(".taskCard").filter({ has: window.locator(".taskCardHeading strong", { hasText: "clone" }) });
    await cloneTask.waitFor({ state: "visible" });
    await cloneTask.getByText("failed", { exact: true }).waitFor({ timeout: 20_000 });
    await writeRewrite(remotePath);
    await cloneTask.getByRole("button", { name: "Retry clone" }).click();

    cloneDialog = window.getByRole("dialog", { name: "Clone repository" });
    expect(await cloneDialog.getByRole("textbox", { name: "Remote URL" }).inputValue()).toBe(cloneRemoteUrl);
    expect(await cloneDialog.getByRole("textbox", { name: "Folder name" }).inputValue()).toBe("retry-project");
    await cloneDialog.getByRole("button", { name: "Start clone" }).click();
    await window.locator(".workspaceCrumb").filter({ hasText: clonePath }).waitFor({ timeout: 30_000 });
    await expect.poll(async () => (await execFileAsync("git", ["-C", clonePath, "rev-parse", "HEAD"])).stdout.trim()).toBe(
      (await execFileAsync("git", ["-C", source.path, "rev-parse", "HEAD"])).stdout.trim(),
    );
    expect(await readFile(resolve(clonePath, "src/clone-retry.ts"), "utf8")).toBe("export const retried = true;\n");
  } finally {
    await app?.close();
    await source.cleanup();
    await rm(remoteRoot, { recursive: true, force: true });
    await rm(cloneParent, { recursive: true, force: true });
    await rm(appDataPath, { recursive: true, force: true });
  }
}, 60_000);
