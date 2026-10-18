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

    // The new worktree is listed in the sidebar and opens as its own repository tab.
    const openWorktree = window.getByRole("button", { name: "Open worktree wt-folder" });
    await openWorktree.waitFor({ timeout: 15_000 });
    await openWorktree.click();
    await expect.poll(() => window.locator(".workspaceCrumb").innerText(), { timeout: 15_000 }).toContain("wt-folder");
    await window.getByRole("tab", { name: new RegExp("gitcrest-e2e-") }).click();
    await expect.poll(() => window.locator(".workspaceCrumb").innerText(), { timeout: 15_000 }).not.toContain("wt-folder");

    // Remove the worktree again from the sidebar (two-step confirmation); the branch is kept.
    await window.getByRole("button", { name: "Remove worktree wt-folder" }).click();
    await window.getByRole("button", { name: "Confirm remove worktree wt-folder" }).click();
    await expect.poll(() => access(resolve(worktreePath, ".git")).then(() => true, () => false), { timeout: 15_000 }).toBe(false);
    expect(await git(fixture.path, "branch", "--list", "feature/wt")).toContain("feature/wt");
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

it("refuses to remove a dirty worktree until changes are explicitly discarded, and blocks locked ones", async () => {
  const fixture = await createTempGitRepository();
  const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-worktree-e2e-app-data-"));
  const worktreeParent = await mkdtemp(resolve(tmpdir(), "gitcrest-worktree-e2e-wt-"));
  try {
    await writeFile(resolve(fixture.path, "base.txt"), "base\n");
    await git(fixture.path, "add", "base.txt");
    await git(fixture.path, "commit", "--quiet", "-m", "base");
    const dirty = resolve(worktreeParent, "dirty-wt");
    const locked = resolve(worktreeParent, "locked-wt");
    await git(fixture.path, "worktree", "add", "-b", "wt-dirty", dirty);
    await git(fixture.path, "worktree", "add", "-b", "wt-locked", locked);
    await git(fixture.path, "worktree", "lock", locked);
    await writeFile(resolve(dirty, "scratch.txt"), "uncommitted\n");

    app = await electron.launch({
      args: [".", "--disable-gpu"],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
    await window.getByText("Core connected").waitFor({ timeout: 15_000 });
    await openRepository(window, fixture.path);

    expect(await window.getByRole("button", { name: "Remove worktree locked-wt" }).isDisabled()).toBe(true);
    await window.getByRole("button", { name: "Remove worktree dirty-wt" }).click();
    expect(await window.getByRole("button", { name: "Confirm remove worktree dirty-wt" }).isDisabled()).toBe(true);
    expect(await access(resolve(dirty, "scratch.txt")).then(() => true, () => false)).toBe(true);
    await window.getByRole("checkbox", { name: "Discard changes" }).check();
    await window.getByRole("button", { name: "Confirm remove worktree dirty-wt" }).click();
    await expect.poll(() => access(dirty).then(() => true, () => false), { timeout: 15_000 }).toBe(false);
  } finally {
    await app?.close();
    app = undefined;
    await git(fixture.path, "worktree", "unlock", resolve(worktreeParent, "locked-wt")).catch(() => undefined);
    await fixture.cleanup();
    await rm(appDataPath, { recursive: true, force: true });
    await rm(worktreeParent, { recursive: true, force: true });
  }
}, 120_000);

it("creates a branch at an older commit from the commit details", async () => {
  const fixture = await createTempGitRepository();
  const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-branch-here-e2e-app-data-"));
  const worktreeParent = await mkdtemp(resolve(tmpdir(), "gitcrest-branch-here-e2e-wt-"));
  try {
    await writeFile(resolve(fixture.path, "one.txt"), "one\n");
    await git(fixture.path, "add", "one.txt");
    await git(fixture.path, "commit", "--quiet", "-m", "first commit");
    const firstOid = await git(fixture.path, "rev-parse", "HEAD");
    await writeFile(resolve(fixture.path, "two.txt"), "two\n");
    await git(fixture.path, "add", "two.txt");
    await git(fixture.path, "commit", "--quiet", "-m", "second commit");
    const secondOid = await git(fixture.path, "rev-parse", "HEAD");

    app = await electron.launch({
      args: [".", "--disable-gpu"],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
    await window.getByText("Core connected").waitFor({ timeout: 15_000 });
    await openRepository(window, fixture.path);

    await window.getByText("first commit", { exact: true }).first().click();
    await window.getByRole("button", { name: "Branch here" }).click();
    const dialog = window.getByRole("dialog", { name: "Create branch here" });
    await dialog.getByRole("textbox", { name: "Branch name" }).fill("from-first");
    await dialog.getByRole("button", { name: "Create and switch" }).click();
    await expect.poll(() => git(fixture.path, "rev-parse", "--abbrev-ref", "HEAD"), { timeout: 15_000 }).toBe("from-first");
    expect(await git(fixture.path, "rev-parse", "HEAD")).toBe(firstOid);
    await window.getByRole("dialog", { name: "Tasks" }).getByRole("button", { name: "Close" }).click();

    // The same dialog can check the branch out in a new worktree instead.
    const worktreePath = resolve(worktreeParent, "from-second");
    await window.getByText("second commit", { exact: true }).first().click();
    await window.getByRole("button", { name: "Branch here" }).click();
    const second = window.getByRole("dialog", { name: "Create branch here" });
    await second.getByRole("textbox", { name: "Branch name" }).fill("wt-from-second");
    await second.getByRole("radio", { name: "Check it out in a new worktree" }).check();
    await second.getByRole("textbox", { name: "Worktree folder" }).fill(worktreePath);
    await second.getByRole("button", { name: "Create worktree" }).click();
    await expect.poll(() => git(worktreePath, "rev-parse", "HEAD").catch(() => ""), { timeout: 15_000 }).toBe(secondOid);
    expect(await git(worktreePath, "rev-parse", "--abbrev-ref", "HEAD")).toBe("wt-from-second");
  } finally {
    await app?.close();
    app = undefined;
    await fixture.cleanup();
    await rm(appDataPath, { recursive: true, force: true });
    await rm(worktreeParent, { recursive: true, force: true });
  }
}, 120_000);

it("can force a merge commit instead of a fast-forward from the merge review", async () => {
  const fixture = await createTempGitRepository();
  const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-noff-e2e-app-data-"));
  try {
    await writeFile(resolve(fixture.path, "base.txt"), "base\n");
    await git(fixture.path, "add", "base.txt");
    await git(fixture.path, "commit", "--quiet", "-m", "base");
    const main = await git(fixture.path, "rev-parse", "--abbrev-ref", "HEAD");
    await git(fixture.path, "switch", "--quiet", "--create", "feature");
    await writeFile(resolve(fixture.path, "feature.txt"), "feature\n");
    await git(fixture.path, "add", "feature.txt");
    await git(fixture.path, "commit", "--quiet", "-m", "feature work");
    await git(fixture.path, "switch", "--quiet", main);

    app = await electron.launch({
      args: [".", "--disable-gpu"],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
    await window.getByText("Core connected").waitFor({ timeout: 15_000 });
    await openRepository(window, fixture.path);

    const row = window.locator(".branchItem").filter({ has: window.getByText("feature", { exact: true }) });
    const merge = row.getByRole("button", { name: /Merge refs\/heads\/feature/ });
    await expect.poll(async () => { await row.hover(); return merge.isEnabled(); }, { timeout: 20_000 }).toBe(true);
    await merge.click();
    await window.getByText(/Fast-forward: the current branch moves ahead by 1/).waitFor();
    await window.getByRole("checkbox", { name: "Always create a merge commit" }).check();
    await window.getByRole("button", { name: "Start merge" }).click();
    await expect.poll(() => git(fixture.path, "rev-list", "--parents", "-n", "1", "HEAD").then((line) => line.split(" ").length), { timeout: 15_000 }).toBe(3);
  } finally {
    await app?.close();
    app = undefined;
    await fixture.cleanup();
    await rm(appDataPath, { recursive: true, force: true });
  }
}, 120_000);
