import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication } from "playwright";
import { expect, it } from "vitest";
import { createTempGitRepository } from "../fixtures/temp-repo";

const execFileAsync = promisify(execFile);

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
