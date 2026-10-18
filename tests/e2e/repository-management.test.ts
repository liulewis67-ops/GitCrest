import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication } from "playwright";
import { expect, it } from "vitest";
import { createAuthenticationFailureServer, type AuthenticationFailureServer } from "../fixtures/authentication-server";
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
      args: [".", "--disable-gpu"],
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
      args: [".", "--disable-gpu"],
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

it("explains that the selected folder is not a Git repository", async () => {
  const projectPath = await mkdtemp(resolve(tmpdir(), "gitcrest-open-invalid-e2e-project-"));
  const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-open-invalid-e2e-app-data-"));
  let app: ElectronApplication | undefined;

  try {
    await writeFile(resolve(projectPath, "notes.txt"), "This folder is not a repository.\n");
    app = await electron.launch({
      args: [".", "--disable-gpu"],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
    await window.getByText("Core connected").waitFor({ timeout: 15_000 });
    await app.evaluate(({ dialog }, destination) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] });
    }, projectPath);

    await window.getByRole("button", { name: "Open local repository" }).click();
    const errorAlert = window.getByRole("alert");
    await errorAlert.waitFor({ state: "visible" });
    expect(await errorAlert.innerText()).toBe("The selected folder is not a Git working tree.");
    expect(await window.locator(".workspaceCrumb").count()).toBe(0);
  } finally {
    await app?.close();
    await rm(projectPath, { recursive: true, force: true });
    await rm(appDataPath, { recursive: true, force: true });
  }
}, 60_000);

it("reports when the selected repository path disappears before it can be opened", async () => {
  const selectionRoot = await mkdtemp(resolve(tmpdir(), "gitcrest-open-missing-e2e-root-"));
  const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-open-missing-e2e-app-data-"));
  const missingPath = resolve(selectionRoot, "deleted-project");
  let app: ElectronApplication | undefined;

  try {
    app = await electron.launch({
      args: [".", "--disable-gpu"],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
    await window.getByText("Core connected").waitFor({ timeout: 15_000 });
    await app.evaluate(({ dialog }, destination) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] });
    }, missingPath);

    await window.getByRole("button", { name: "Open local repository" }).click();
    const errorAlert = window.getByRole("alert");
    await errorAlert.waitFor({ state: "visible" });
    expect(await errorAlert.innerText()).toBe("The selected repository path no longer exists.");
    expect(await window.locator(".workspaceCrumb").count()).toBe(0);
  } finally {
    await app?.close();
    await rm(selectionRoot, { recursive: true, force: true });
    await rm(appDataPath, { recursive: true, force: true });
  }
}, 60_000);

it.skipIf(process.platform !== "win32")("reports an access error for a folder denied to the current Windows user", async () => {
  const projectPath = await mkdtemp(resolve(tmpdir(), "gitcrest-open-denied-e2e-project-"));
  const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-open-denied-e2e-app-data-"));
  const identity = await execFileAsync("whoami", ["/user", "/fo", "csv", "/nh"]);
  const userSid = identity.stdout.match(/S-1-5-[\d-]+/)?.[0];
  if (!userSid) throw new Error("Could not determine the current Windows user SID for the ACL fixture.");
  let app: ElectronApplication | undefined;
  let denyApplied = false;

  try {
    await execFileAsync("icacls", [projectPath, "/deny", `*${userSid}:(RX)`]);
    denyApplied = true;
    app = await electron.launch({
      args: [".", "--disable-gpu"],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
    await window.getByText("Core connected").waitFor({ timeout: 15_000 });
    await app.evaluate(({ dialog }, destination) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] });
    }, projectPath);

    await window.getByRole("button", { name: "Open local repository" }).click();
    const errorAlert = window.getByRole("alert");
    await errorAlert.waitFor({ state: "visible" });
    expect(await errorAlert.innerText()).toBe("GitCrest does not have permission to read the selected repository.");
    expect(await window.locator(".workspaceCrumb").count()).toBe(0);
  } finally {
    await app?.close();
    if (denyApplied) await execFileAsync("icacls", [projectPath, "/remove:d", `*${userSid}`]);
    await rm(projectPath, { recursive: true, force: true });
    await rm(appDataPath, { recursive: true, force: true });
  }
}, 60_000);

it("keeps a failed Git template initialization out of the selected project folder", async () => {
  const projectPath = await mkdtemp(resolve(tmpdir(), "gitcrest-init-template-e2e-project-"));
  const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-init-template-e2e-app-data-"));
  const templatePath = resolve(appDataPath, "invalid-template");
  const gitConfigPath = resolve(appDataPath, "gitconfig");
  const projectFile = resolve(projectPath, "README.md");
  let app: ElectronApplication | undefined;

  try {
    await writeFile(projectFile, "# Keep this project unchanged\n");
    await mkdir(templatePath);
    await writeFile(resolve(templatePath, "config"), "not a valid git config line\n");
    await writeFile(gitConfigPath, `[init]\n\ttemplateDir = ${templatePath.replace(/\\/g, "/")}\n`);
    app = await electron.launch({
      args: [".", "--disable-gpu"],
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
    }, projectPath);

    await window.getByRole("button", { name: "Initialize a repository" }).click();
    const errorAlert = window.getByRole("alert");
    await errorAlert.waitFor({ state: "visible" });
    expect(await errorAlert.innerText()).toBe("Git could not initialize this folder.");
    expect(await readFile(projectFile, "utf8")).toBe("# Keep this project unchanged\n");
    expect(await window.locator(".workspaceCrumb").count()).toBe(0);
    expect(await readdir(projectPath)).toEqual(["README.md"]);
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
      args: [".", "--disable-gpu"],
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
      args: [".", "--disable-gpu"],
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

it("opens HTTPS credentials when retrying a clone that failed authentication", async () => {
  const cloneParent = await mkdtemp(resolve(tmpdir(), "gitcrest-clone-auth-parent-"));
  const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-clone-auth-app-data-"));
  const gitConfigPath = resolve(appDataPath, "gitconfig");
  let authenticationServer: AuthenticationFailureServer | undefined;
  let app: ElectronApplication | undefined;

  try {
    authenticationServer = await createAuthenticationFailureServer(appDataPath);
    await writeFile(gitConfigPath, "[credential]\n\thelper =\n");
    app = await electron.launch({
      args: [".", "--disable-gpu"],
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: gitConfigPath,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_SSL_CAINFO: authenticationServer.certificatePath,
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
    const cloneDialog = window.getByRole("dialog", { name: "Clone repository" });
    await cloneDialog.getByRole("textbox", { name: "Remote URL" }).fill(authenticationServer.remoteUrl);
    await cloneDialog.getByRole("button", { name: "Choose folder" }).click();
    await cloneDialog.getByText(cloneParent, { exact: true }).waitFor();
    await cloneDialog.getByRole("textbox", { name: "Folder name" }).fill("private-project");
    await cloneDialog.getByRole("button", { name: "Start clone" }).click();

    const tasksDialog = window.getByRole("dialog", { name: "Tasks" });
    const cloneTask = tasksDialog.locator(".taskCard").filter({ has: window.locator(".taskCardHeading strong", { hasText: "clone" }) }).last();
    await cloneTask.waitFor({ state: "visible" });
    await cloneTask.getByText("failed", { exact: true }).waitFor({ timeout: 20_000 });
    await cloneTask.getByText("authentication:", { exact: false }).waitFor();
    await cloneTask.getByRole("button", { name: "Retry clone" }).click();

    const retryDialog = window.getByRole("dialog", { name: "Clone repository" });
    expect(await retryDialog.getByRole("textbox", { name: "Remote URL" }).inputValue()).toBe(authenticationServer.remoteUrl);
    expect(await retryDialog.getByRole("textbox", { name: "Folder name" }).inputValue()).toBe("private-project");
    expect(await retryDialog.getByRole("button", { name: "Start clone" }).isEnabled()).toBe(true);
    await retryDialog.getByRole("article", { name: `HTTPS credential for ${authenticationServer.host}` }).waitFor();
  } finally {
    await app?.close();
    await authenticationServer?.close();
    await rm(cloneParent, { recursive: true, force: true });
    await rm(appDataPath, { recursive: true, force: true });
  }
}, 60_000);

it("clones successfully after saving credentials for an authentication-failed remote", async () => {
  const source = await createTempGitRepository();
  const remoteRoot = await mkdtemp(resolve(tmpdir(), "gitcrest-clone-auth-success-remote-"));
  const bareRemotePath = resolve(remoteRoot, "repository.git");
  const cloneParent = await mkdtemp(resolve(tmpdir(), "gitcrest-clone-auth-success-parent-"));
  const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-clone-auth-success-app-data-"));
  const gitConfigPath = resolve(appDataPath, "gitconfig");
  const username = "gitcrest-clone-e2e-user";
  const token = `clone-test-token-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const clonePath = resolve(cloneParent, "authenticated-project");
  let authenticationServer: AuthenticationFailureServer | undefined;
  let app: ElectronApplication | undefined;
  let credentialSaved = false;

  const removeSavedCredential = async () => {
    if (!credentialSaved || !app || !authenticationServer) return;
    const removed = await (await app.firstWindow()).evaluate(async (host: string) => {
      const connection = await (globalThis.window as unknown as Window & {
        gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
      }).gitcrest.getSidecarConnection();
      const headers = { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1" };
      const query = new URLSearchParams({ host });
      const result = await fetch(new URL(`/api/v1/credentials?${query}`, connection.baseUrl), { method: "DELETE", headers });
      const verify = await fetch(new URL(`/api/v1/credentials?${query}`, connection.baseUrl), { headers });
      const status = await verify.json() as { isConfigured: boolean };
      return result.status === 204 && !status.isConfigured;
    }, authenticationServer.host);
    if (!removed) throw new Error(`Could not remove temporary credential for ${authenticationServer.host}`);
    credentialSaved = false;
  };

  try {
    await mkdir(resolve(source.path, "src"), { recursive: true });
    await writeFile(resolve(source.path, "src/clone-auth-success.ts"), "export const cloned = true;\n");
    await execFileAsync("git", ["-C", source.path, "add", "src/clone-auth-success.ts"]);
    await execFileAsync("git", ["-C", source.path, "commit", "--quiet", "-m", "authenticated clone fixture"]);
    await execFileAsync("git", ["init", "--bare", "--quiet", "--initial-branch=main", bareRemotePath]);
    await execFileAsync("git", ["-C", source.path, "push", "--quiet", bareRemotePath, "HEAD:refs/heads/main"]);
    const remoteHead = (await execFileAsync("git", ["-C", bareRemotePath, "rev-parse", "refs/heads/main"])).stdout.trim();
    authenticationServer = await createAuthenticationFailureServer(appDataPath, { projectRoot: remoteRoot, username, token });
    await writeFile(gitConfigPath, "[credential]\n\thelper =\n");

    app = await electron.launch({
      args: [".", "--disable-gpu"],
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: gitConfigPath,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_SSL_CAINFO: authenticationServer.certificatePath,
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
    const cloneDialog = window.getByRole("dialog", { name: "Clone repository" });
    await cloneDialog.getByRole("textbox", { name: "Remote URL" }).fill(authenticationServer.remoteUrl);
    await cloneDialog.getByRole("button", { name: "Choose folder" }).click();
    await cloneDialog.getByText(cloneParent, { exact: true }).waitFor();
    await cloneDialog.getByRole("textbox", { name: "Folder name" }).fill("authenticated-project");
    await cloneDialog.getByRole("button", { name: "Start clone" }).click();

    const tasksDialog = window.getByRole("dialog", { name: "Tasks" });
    const failedClone = tasksDialog.locator(".taskCard").filter({ has: window.locator(".taskCardHeading strong", { hasText: "clone" }) }).last();
    await failedClone.waitFor({ state: "visible" });
    await failedClone.getByText("failed", { exact: true }).waitFor({ timeout: 20_000 });
    await failedClone.getByText("authentication:", { exact: false }).waitFor();
    expect(authenticationServer.authenticatedRequestCount()).toBe(0);
    await failedClone.getByRole("button", { name: "Retry clone" }).click();

    const retryDialog = window.getByRole("dialog", { name: "Clone repository" });
    expect(await retryDialog.getByRole("textbox", { name: "Remote URL" }).inputValue()).toBe(authenticationServer.remoteUrl);
    expect(await retryDialog.getByRole("textbox", { name: "Folder name" }).inputValue()).toBe("authenticated-project");
    const credentialCard = retryDialog.getByRole("article", { name: `HTTPS credential for ${authenticationServer.host}` });
    await credentialCard.getByLabel("Username").fill(username);
    await credentialCard.getByLabel("Token or password").fill(token);
    await credentialCard.getByRole("button", { name: "Save credential" }).click();
    await credentialCard.getByText("Credential saved to the system credential store.").waitFor();
    credentialSaved = true;
    await retryDialog.getByRole("button", { name: "Start clone" }).click();

    await window.locator(".workspaceCrumb").filter({ hasText: clonePath }).waitFor({ timeout: 30_000 });
    expect(authenticationServer.authenticatedRequestCount()).toBeGreaterThan(0);
    expect((await execFileAsync("git", ["-C", clonePath, "rev-parse", "HEAD"])).stdout.trim()).toBe(remoteHead);
    expect(await readFile(resolve(clonePath, "src/clone-auth-success.ts"), "utf8")).toBe("export const cloned = true;\n");
    const taskLogs = await window.evaluate(async () => {
      const connection = await (globalThis.window as unknown as Window & {
        gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
      }).gitcrest.getSidecarConnection();
      const response = await fetch(new URL("/api/v1/tasks", connection.baseUrl), {
        headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1" },
      });
      const tasks = await response.json() as Array<{ operation: string; logs: string[] }>;
      return tasks.filter((task) => task.operation === "clone").flatMap((task) => task.logs).join("\n");
    });
    expect(taskLogs).not.toContain(token);
    await removeSavedCredential();
  } finally {
    await removeSavedCredential();
    await app?.close();
    await authenticationServer?.close();
    await source.cleanup();
    await rm(remoteRoot, { recursive: true, force: true });
    await rm(cloneParent, { recursive: true, force: true });
    await rm(appDataPath, { recursive: true, force: true });
  }
}, 90_000);

it("removes the partial destination when an active clone is cancelled", async () => {
  const source = await createTempGitRepository();
  const remoteRoot = await mkdtemp(resolve(tmpdir(), "gitcrest-clone-cancel-remote-"));
  const bareRemotePath = resolve(remoteRoot, "repository.git");
  const cloneParent = await mkdtemp(resolve(tmpdir(), "gitcrest-clone-cancel-parent-"));
  const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-clone-cancel-app-data-"));
  const gitConfigPath = resolve(appDataPath, "gitconfig");
  const username = "gitcrest-clone-cancel-user";
  const token = `clone-cancel-token-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const folderName = "cancelled-project";
  let authenticationServer: AuthenticationFailureServer | undefined;
  let app: ElectronApplication | undefined;
  let credentialSaved = false;

  const removeSavedCredential = async () => {
    if (!credentialSaved || !app || !authenticationServer) return;
    const removed = await (await app.firstWindow()).evaluate(async (host: string) => {
      const connection = await (globalThis.window as unknown as Window & {
        gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
      }).gitcrest.getSidecarConnection();
      const headers = { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1" };
      const query = new URLSearchParams({ host });
      const result = await fetch(new URL(`/api/v1/credentials?${query}`, connection.baseUrl), { method: "DELETE", headers });
      const verify = await fetch(new URL(`/api/v1/credentials?${query}`, connection.baseUrl), { headers });
      const status = await verify.json() as { isConfigured: boolean };
      return result.status === 204 && !status.isConfigured;
    }, authenticationServer.host);
    if (!removed) throw new Error(`Could not remove temporary credential for ${authenticationServer.host}`);
    credentialSaved = false;
  };

  try {
    await mkdir(resolve(source.path, "src"), { recursive: true });
    await writeFile(resolve(source.path, "src/clone-cancel.ts"), "export const cloneCancel = true;\n");
    await execFileAsync("git", ["-C", source.path, "add", "src/clone-cancel.ts"]);
    await execFileAsync("git", ["-C", source.path, "commit", "--quiet", "-m", "clone cancellation fixture"]);
    await execFileAsync("git", ["init", "--bare", "--quiet", "--initial-branch=main", bareRemotePath]);
    await execFileAsync("git", ["-C", source.path, "push", "--quiet", bareRemotePath, "HEAD:refs/heads/main"]);
    authenticationServer = await createAuthenticationFailureServer(appDataPath, {
      projectRoot: remoteRoot,
      username,
      token,
      holdAuthenticatedRequests: true,
    });
    await writeFile(gitConfigPath, "[credential]\n\thelper =\n");

    app = await electron.launch({
      args: [".", "--disable-gpu"],
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: gitConfigPath,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_SSL_CAINFO: authenticationServer.certificatePath,
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
    const cloneDialog = window.getByRole("dialog", { name: "Clone repository" });
    await cloneDialog.getByRole("textbox", { name: "Remote URL" }).fill(authenticationServer.remoteUrl);
    await cloneDialog.getByRole("button", { name: "Choose folder" }).click();
    await cloneDialog.getByText(cloneParent, { exact: true }).waitFor();
    await cloneDialog.getByRole("textbox", { name: "Folder name" }).fill(folderName);
    await cloneDialog.getByRole("button", { name: "Start clone" }).click();

    const tasksDialog = window.getByRole("dialog", { name: "Tasks" });
    const failedClone = tasksDialog.locator(".taskCard").filter({ has: window.locator(".taskCardHeading strong", { hasText: "clone" }) }).last();
    await failedClone.getByText("failed", { exact: true }).waitFor({ timeout: 20_000 });
    await failedClone.getByRole("button", { name: "Retry clone" }).click();
    const retryDialog = window.getByRole("dialog", { name: "Clone repository" });
    const credentialCard = retryDialog.getByRole("article", { name: `HTTPS credential for ${authenticationServer.host}` });
    await credentialCard.getByLabel("Username").fill(username);
    await credentialCard.getByLabel("Token or password").fill(token);
    await credentialCard.getByRole("button", { name: "Save credential" }).click();
    await credentialCard.getByText("Credential saved to the system credential store.").waitFor();
    credentialSaved = true;
    await retryDialog.getByRole("button", { name: "Start clone" }).click();

    await authenticationServer.waitForAuthenticatedRequest();
    expect(authenticationServer.authenticatedRequestCount()).toBeGreaterThan(0);
    const cloneTaskId = await window.evaluate(async () => {
      const connection = await (globalThis.window as unknown as Window & {
        gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
      }).gitcrest.getSidecarConnection();
      const response = await fetch(new URL("/api/v1/tasks", connection.baseUrl), {
        headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1" },
      });
      const tasks = await response.json() as Array<{ taskId: string; operation: string }>;
      const cloneTasks = tasks.filter((task) => task.operation === "clone");
      const cloneTask = cloneTasks[cloneTasks.length - 1];
      if (!cloneTask) throw new Error("The active clone task was not returned by the API.");
      return cloneTask.taskId;
    });
    const cloneTaskStatus = await window.evaluate(async (taskId) => {
      const connection = await (globalThis.window as unknown as Window & {
        gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
      }).gitcrest.getSidecarConnection();
      const response = await fetch(new URL("/api/v1/tasks", connection.baseUrl), {
        headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1" },
      });
      const tasks = await response.json() as Array<{ taskId: string; status: string; logs: string[]; message: string | null }>;
      return tasks.find((task) => task.taskId === taskId);
    }, cloneTaskId);
    expect(cloneTaskStatus, `clone task snapshot: ${JSON.stringify(cloneTaskStatus)}`).toBeDefined();
    expect(cloneTaskStatus?.status, `clone task snapshot: ${JSON.stringify(cloneTaskStatus)}`).toBe("running");
    await tasksDialog.getByRole("button", { name: "Refresh" }).click();
    const activeClone = tasksDialog.locator(".taskCard").filter({ has: window.locator(".taskCardHeading strong", { hasText: "clone" }) }).first();
    await activeClone.getByText("running", { exact: true }).waitFor({ timeout: 10_000 });
    await activeClone.getByRole("button", { name: "Cancel task" }).click();
    await activeClone.getByText("cancelled", { exact: true }).waitFor({ timeout: 20_000 });
    authenticationServer.releaseAuthenticatedRequests();

    expect(await readdir(cloneParent)).not.toContain(folderName);
    expect(await readdir(cloneParent)).not.toContain(`.gitcrest-clone-${cloneTaskId}.partial`);
    expect(authenticationServer.authenticatedRequestCount()).toBe(1);
    await removeSavedCredential();
  } finally {
    authenticationServer?.releaseAuthenticatedRequests();
    await removeSavedCredential();
    await app?.close();
    await authenticationServer?.close();
    await source.cleanup();
    await rm(remoteRoot, { recursive: true, force: true });
    await rm(cloneParent, { recursive: true, force: true });
    await rm(appDataPath, { recursive: true, force: true });
  }
}, 90_000);
