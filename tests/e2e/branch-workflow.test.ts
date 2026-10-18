import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { afterEach, expect, it } from "vitest";
import { createTempGitRepository } from "../fixtures/temp-repo";

const execFileAsync = promisify(execFile);
const git = async (repo: string, ...args: string[]) => (await execFileAsync("git", ["-C", repo, ...args])).stdout.trim();

let app: ElectronApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function openRepository(window: Page, path: string) {
  await window.evaluate(async (repositoryPath) => {
    const connection = await (globalThis.window as unknown as Window & {
      gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
    }).gitcrest.getSidecarConnection();
    await fetch(new URL("/api/v1/repositories", connection.baseUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ path: repositoryPath }),
    });
  }, path);
  await window.reload();
  await window.getByRole("heading", { name: "Recent repositories" }).waitFor();
  await window.locator(".repositoryRowOpen").click();
  await window.locator(".workspaceCrumb").waitFor();
}

it("creates, switches, merges and adds worktrees for branches from the UI", async () => {
  const fixture = await createTempGitRepository();
  const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-branch-e2e-app-data-"));
  const worktreeParent = await mkdtemp(resolve(tmpdir(), "gitcrest-branch-e2e-wt-"));
  try {
    await writeFile(resolve(fixture.path, "base.txt"), "base\n");
    await git(fixture.path, "add", "base.txt");
    await git(fixture.path, "commit", "--quiet", "-m", "base");
    const main = await git(fixture.path, "rev-parse", "--abbrev-ref", "HEAD");
    await git(fixture.path, "switch", "--quiet", "--create", "side");
    await writeFile(resolve(fixture.path, "side.txt"), "side\n");
    await git(fixture.path, "add", "side.txt");
    await git(fixture.path, "commit", "--quiet", "-m", "side work");
    await git(fixture.path, "switch", "--quiet", main);

    app = await electron.launch({
      args: [".", "--disable-gpu"],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
    await window.getByText("Core connected").waitFor({ timeout: 15_000 });
    await openRepository(window, fixture.path);

    // Create a branch and switch to it by typing a new name in the switcher and pressing Enter.
    await window.keyboard.press("Control+b");
    const switcher = window.getByRole("dialog", { name: "Switch branch" });
    const filter = switcher.getByRole("searchbox", { name: "Filter local branches" });
    await filter.fill("feature/ux");
    await filter.press("Enter");
    await expect.poll(() => git(fixture.path, "rev-parse", "--abbrev-ref", "HEAD"), { timeout: 15_000 }).toBe("feature/ux");
    await window.getByRole("dialog", { name: "Tasks" }).getByRole("button", { name: "Close" }).click();

    // Create a branch in a new worktree folder.
    const worktreePath = resolve(worktreeParent, "wt-folder");
    await window.keyboard.press("Control+b");
    const second = window.getByRole("dialog", { name: "Switch branch" });
    await second.getByRole("searchbox", { name: "Filter local branches" }).fill("feature/wt");
    await second.getByRole("textbox", { name: "Worktree folder" }).fill(worktreePath);
    await second.getByRole("button", { name: /in a new worktree/ }).click();
    await expect.poll(() => access(resolve(worktreePath, ".git")).then(() => true, () => false), { timeout: 15_000 }).toBe(true);
    expect(await git(worktreePath, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/wt");
    await window.getByRole("dialog", { name: "Tasks" }).getByRole("button", { name: "Close" }).click();

    // Merge `side` into the current branch from the sidebar row.
    const sideRow = window.locator(".branchItem", { hasText: "side" });
    await sideRow.hover();
    await sideRow.getByRole("button", { name: /Merge refs\/heads\/side/ }).click();
    await window.getByRole("button", { name: "Start merge" }).click();
    await expect.poll(() => git(fixture.path, "log", "--format=%s", "-1"), { timeout: 15_000 }).toBe("side work");
    await window.getByRole("dialog", { name: "Tasks" }).getByRole("button", { name: "Close" }).click();

    // Switch back from the sidebar row.
    const mainRow = window.locator(".branchItem", { hasText: new RegExp(`^\s*⑂?\s*${main}`) });
    const switchMain = mainRow.getByRole("button", { name: `Switch to ${main}` });
    await expect.poll(async () => { await mainRow.hover(); return switchMain.isEnabled(); }, { timeout: 20_000 }).toBe(true);
    await switchMain.click();
    await window.getByRole("dialog", { name: "Switch branch" }).getByRole("button", { name: `Switch to ${main}` }).click();
    await expect.poll(() => git(fixture.path, "rev-parse", "--abbrev-ref", "HEAD"), { timeout: 15_000 }).toBe(main);
    await window.getByRole("dialog", { name: "Tasks" }).getByRole("button", { name: "Close" }).click();

    // Rename a branch, then delete it; it is unmerged into main so deletion needs confirmation.
    const sideRow2 = window.locator(".branchItem").filter({ has: window.getByText("side", { exact: true }) });
    const renameSide = sideRow2.getByRole("button", { name: "Rename side" });
    await expect.poll(async () => { await sideRow2.hover(); return renameSide.isEnabled(); }, { timeout: 20_000 }).toBe(true);
    await renameSide.click();
    const renameDialog = window.getByRole("dialog", { name: "Rename branch" });
    await renameDialog.getByRole("textbox", { name: "New name" }).fill("side-renamed");
    await renameDialog.getByRole("button", { name: "Rename branch" }).click();
    await expect.poll(() => git(fixture.path, "branch", "--list", "side-renamed"), { timeout: 15_000 }).toContain("side-renamed");
    await window.getByRole("dialog", { name: "Tasks" }).getByRole("button", { name: "Close" }).click();

    const renamedRow = window.locator(".branchItem", { hasText: "side-renamed" });
    const deleteRenamed = renamedRow.getByRole("button", { name: "Delete side-renamed" });
    await expect.poll(async () => { await renamedRow.hover(); return deleteRenamed.isEnabled(); }, { timeout: 20_000 }).toBe(true);
    await deleteRenamed.click();
    const deleteDialog = window.getByRole("dialog", { name: "Delete branch" });
    await deleteDialog.getByRole("checkbox").check();
    await deleteDialog.getByRole("button", { name: "Delete branch" }).click();
    await expect.poll(() => git(fixture.path, "branch", "--list", "side-renamed"), { timeout: 15_000 }).toBe("");
  } finally {
    await app?.close();
    app = undefined;
    await fixture.cleanup();
    await rm(appDataPath, { recursive: true, force: true });
    await rm(worktreeParent, { recursive: true, force: true });
  }
}, 120_000);
