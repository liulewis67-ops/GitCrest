import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright";
import { afterEach, expect, it } from "vitest";
import { createTempGitRepository } from "../fixtures/temp-repo";

const execFileAsync = promisify(execFile);
const git = async (repo: string, ...args: string[]) => (await execFileAsync("git", ["-C", repo, ...args])).stdout.trim();

it("keeps a pushed older branch first in branch lists after restarting the application", async () => {
  const fixture = await createTempGitRepository();
  const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-branch-activity-"));
  try {
    const datedCommit = (date: string) => execFileAsync("git", ["-C", fixture.path, "commit", "--allow-empty", "-qm", date], {
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
    await datedCommit("2001-01-01T00:00:00Z");
    const main = await git(fixture.path, "branch", "--show-current");
    await git(fixture.path, "branch", "z-older");
    await datedCommit("2002-01-01T00:00:00Z");
    const bare = resolve(appDataPath, "remote.git");
    await execFileAsync("git", ["init", "--bare", "--quiet", bare]);
    await git(fixture.path, "remote", "add", "origin", bare);
    await git(fixture.path, "push", "-qu", "origin", "z-older");
    await git(fixture.path, "reflog", "expire", "--expire=all", "--all");

    for (const restarting of [false, true]) {
      app = await electron.launch({
        args: [".", "--lang=en-US", "--disable-gpu", `--user-data-dir=${resolve(appDataPath, "profile")}`],
        env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
      });
      const window = await app.firstWindow();
      await window.getByText("Core connected").waitFor({ timeout: 40_000 });
      const request = <T,>(path: string, method = "GET", body?: unknown): Promise<T> => window.evaluate(async ({ path, method, body }) => {
        const connection = await (globalThis.window as unknown as Window & {
          gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
        }).gitcrest.getSidecarConnection();
        const response = await fetch(new URL(`/api/v1${path}`, connection.baseUrl), {
          method, headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1", "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
        return response.json();
      }, { path, method, body });
      const repository = await request<{ repoId: string }>("/repositories", "POST", { path: fixture.path });
      const base = `/repositories/${repository.repoId}`;
      type Branches = { branches: { name: string; kind: string; oid: string; lastActivityAtMs?: number }[] };
      if (!restarting) {
        // With reflogs expired, existing branches fall back to commit time.
        const initial = await request<Branches>(`${base}/branches`);
        expect(initial.branches.filter(branch => branch.kind === "local").map(branch => branch.name)).toEqual([main, "z-older"]);
        const old = initial.branches.find(branch => branch.name === "z-older")!;
        const task = await request<{ taskId: string }>(`${base}/branches/sync`, "POST", { name: "z-older", expectedOid: old.oid, operation: "push" });
        await expect.poll(async () => (await request<{ status: string }>(`/tasks/${task.taskId}`)).status, { timeout: 15_000 }).toBe("succeeded");
      }
      const snapshot = await request<Branches>(`${base}/branches`);
      expect(snapshot.branches.filter(branch => branch.kind === "local").map(branch => branch.name)).toEqual(["z-older", main]);
      expect(snapshot.branches.find(branch => branch.name === "z-older")!.lastActivityAtMs).toBeGreaterThan(Date.parse("2002-01-01"));
      // Favoriting a branch returns a complete snapshot without losing activity order.
      const favorited = await request<Branches>(`${base}/branches/favorite`, "PUT", { fullName: `refs/heads/${main}`, favorite: true });
      expect(favorited.branches.filter(branch => branch.kind === "local").map(branch => branch.name)).toEqual(["z-older", main]);
      if (restarting) {
        await window.locator(".workspaceToolbar").waitFor();
        await window.getByRole("tab", { name: "History" }).click();
      } else {
        await openRepository(window, fixture.path);
      }
      await expect.poll(() => window.getByRole("button", { name: /^Show history of / }).evaluateAll(elements => elements.map(element => element.getAttribute("aria-label")).filter(name => !name?.includes("origin/"))), { timeout: 15_000 })
        .toEqual(["Show history of z-older", `Show history of ${main}`]);
      await window.keyboard.press("Control+b");
      const picker = window.getByRole("dialog", { name: "Switch branch" });
      await expect.poll(() => picker.locator(".branchPickerRow .branchChoice span[title]").allTextContents())
        .toEqual(["z-older", main, "origin/z-older"]);
      await app.close();
      app = undefined;
    }
  } finally {
    await app?.close();
    app = undefined;
    await fixture.cleanup();
    const cleanupPath = resolve(appDataPath);
    if (!cleanupPath.startsWith(resolve(tmpdir(), "gitcrest-branch-activity-"))) throw new Error("Unexpected cleanup path");
    await rm(cleanupPath, { recursive: true, force: true });
  }
}, 180_000);

let app: ElectronApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Opens a local branch row's "More actions" menu and picks one item. */
async function chooseRowMenuItem(window: Page, row: Locator, branch: string, item: string) {
  const more = row.getByRole("button", { name: `More actions for ${branch}` });
  await expect.poll(async () => { await row.hover(); return more.isEnabled(); }, { timeout: 20_000 }).toBe(true);
  await more.click();
  // Items follow the branch list, which can still be catching up with a change made just before
  // (e.g. a removed worktree); wait for the app rather than clicking a disabled item.
  const menuItem = window.getByRole("menuitem", { name: item });
  await expect.poll(() => menuItem.isEnabled(), { timeout: 15_000 }).toBe(true);
  await menuItem.click();
}

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
  await window.locator(".workspaceToolbar").waitFor();
  // Branch rows, worktrees and the graph live in the History view.
  await window.getByRole("tab", { name: "History" }).click();
}

it("shows the new repository menu in front of History filters", async () => {
  const fixture = await createTempGitRepository();
  const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-new-repository-menu-"));
  try {
    await git(fixture.path, "commit", "--allow-empty", "-qm", "Initial commit");
    app = await electron.launch({
      args: [".", "--lang=en-US", "--disable-gpu", `--user-data-dir=${resolve(appDataPath, "profile")}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
    });
    const window = await app.firstWindow();
    await window.getByText("Core connected").waitFor({ timeout: 40_000 });
    await openRepository(window, fixture.path);
    const filters = window.locator(".historyFilters");
    await filters.waitFor();
    const trigger = window.getByRole("button", { name: "Open, clone, or initialize a repository" });
    await trigger.click();
    const menu = window.getByRole("menu", { name: "Open, clone, or initialize a repository" });
    await menu.waitFor();
    const bounds = (await filters.boundingBox())!;
    expect(await menu.evaluate((element, filters) => {
      const rect = element.getBoundingClientRect();
      const left = Math.max(rect.left, filters.x);
      const top = Math.max(rect.top, filters.y);
      const right = Math.min(rect.right, filters.x + filters.width);
      const bottom = Math.min(rect.bottom, filters.y + filters.height);
      return right > left && bottom > top && element.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2));
    }, bounds)).toBe(true);
    await menu.getByRole("menuitem", { name: /Clone a repository/ }).click();
    await window.getByRole("dialog", { name: "Clone repository" }).waitFor();
  } finally {
    await app?.close();
    app = undefined;
    await fixture.cleanup();
    await rm(appDataPath, { recursive: true, force: true });
  }
}, 120_000);

it("creates, switches, merges and adds worktrees for branches from the UI", async () => {
  const fixture = await createTempGitRepository();
  const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-branch-e2e-app-data-"));
  const worktreeParent = await mkdtemp(resolve(tmpdir(), "gitcrest-branch-e2e-wt-"));
  try {
    await writeFile(resolve(fixture.path, "base.txt"), "base\n");
    await git(fixture.path, "add", "base.txt");
    await git(fixture.path, "commit", "--quiet", "-m", "base");
    // A Git-ignored local file that the new-worktree dialog can copy on request.
    await writeFile(resolve(fixture.path, ".git", "info", "exclude"), "*.local\n");
    await writeFile(resolve(fixture.path, "app.local"), "SECRET=1\n");
    const main = await git(fixture.path, "rev-parse", "--abbrev-ref", "HEAD");
    await git(fixture.path, "switch", "--quiet", "--create", "side");
    await writeFile(resolve(fixture.path, "side.txt"), "side\n");
    await git(fixture.path, "add", "side.txt");
    await git(fixture.path, "commit", "--quiet", "-m", "side work");
    await git(fixture.path, "switch", "--quiet", main);

    app = await electron.launch({
      args: [".", "--lang=en-US", "--disable-gpu"],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
    await window.getByText("Core connected").waitFor({ timeout: 40_000 });
    await openRepository(window, fixture.path);

    // Create a branch and switch to it by typing a new name in the switcher and pressing Enter.
    await window.keyboard.press("Control+b");
    const switcher = window.getByRole("dialog", { name: "Switch branch" });
    const filter = switcher.getByRole("searchbox", { name: "Filter branches" });
    await filter.fill("feature/ux");
    await filter.press("Enter");
    await expect.poll(() => git(fixture.path, "rev-parse", "--abbrev-ref", "HEAD"), { timeout: 15_000 }).toBe("feature/ux");
    expect(await window.getByRole("dialog", { name: "Tasks" }).count()).toBe(0);

    // Create a branch in a new worktree folder.
    const worktreePath = resolve(worktreeParent, "wt-folder");
    await window.keyboard.press("Control+b");
    const second = window.getByRole("dialog", { name: "Switch branch" });
    await second.getByRole("searchbox", { name: "Filter branches" }).fill("feature/wt");
    await second.getByRole("textbox", { name: "Worktree folder" }).fill(fixture.path);
    await second.getByText(/already contains files/).waitFor({ timeout: 10_000 });
    expect(await second.getByRole("button", { name: /in a new worktree/ }).isDisabled()).toBe(true);
    await second.getByRole("textbox", { name: "Worktree folder" }).fill(worktreePath);
    // Shift+Enter from the filter box creates the typed name in the worktree folder.
    await second.getByRole("searchbox", { name: "Filter branches" }).press("Shift+Enter");
    await expect.poll(() => access(resolve(worktreePath, ".git")).then(() => true, () => false), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => git(worktreePath, "rev-parse", "--abbrev-ref", "HEAD").catch(() => ""), { timeout: 15_000 }).toBe("feature/wt");

    // The new worktree opens by itself as a repository tab once it is created.
    await expect.poll(() => window.locator(".repositoryTab.active > button[role=tab]").getAttribute("title"), { timeout: 15_000 }).toContain("wt-folder");
    await window.getByRole("tab", { name: new RegExp("gitcrest-e2e-") }).click();
    await expect.poll(() => window.locator(".repositoryTab.active > button[role=tab]").getAttribute("title"), { timeout: 15_000 }).not.toContain("wt-folder");

    // Remove the worktree again from its right-click menu in the Worktrees list; the branch is kept unless asked.
    const worktreeRow = window.getByRole("list", { name: "Repository worktrees" }).locator(".branchItem").filter({ hasText: "feature/wt" });
    await worktreeRow.click({ button: "right" });
    await window.getByRole("menuitem", { name: "Remove worktree…" }).click();
    const removeDialog = window.getByRole("dialog", { name: "Remove worktree" });
    await removeDialog.getByText(/no uncommitted changes/).waitFor({ timeout: 10_000 });
    await removeDialog.getByRole("button", { name: "Remove worktree" }).click();
    await expect.poll(() => access(resolve(worktreePath, ".git")).then(() => true, () => false), { timeout: 15_000 }).toBe(false);
    expect(await git(fixture.path, "branch", "--list", "feature/wt")).toContain("feature/wt");
    expect(await window.getByRole("dialog", { name: "Tasks" }).count()).toBe(0);

    // The surviving branch can be checked out into a new worktree straight from its sidebar row.
    const wtRow = window.getByRole("list", { name: "Repository branches" }).locator(".branchItem").filter({ has: window.getByText("feature/wt", { exact: true }) });
    await chooseRowMenuItem(window, wtRow, "feature/wt", "Open feature/wt in a new worktree");
    const worktreeDialog = window.getByRole("dialog", { name: "Open branch in a new worktree" });
    const secondFolder = resolve(worktreeParent, "wt-folder-again");
    // A folder that already has files is flagged before anything is submitted.
    await worktreeDialog.getByRole("textbox", { name: "Worktree folder" }).fill(fixture.path);
    await worktreeDialog.getByText(/already contains files/).waitFor({ timeout: 10_000 });
    expect(await worktreeDialog.getByRole("button", { name: "Create worktree" }).isDisabled()).toBe(true);
    await worktreeDialog.getByRole("textbox", { name: "Worktree folder" }).fill(secondFolder);
    // Nothing is copied unless ticked; tick the ignored file so it follows the new worktree.
    expect(await worktreeDialog.getByRole("checkbox", { name: /app.local/ }).isChecked()).toBe(false);
    await worktreeDialog.getByRole("checkbox", { name: /app.local/ }).check();
    await worktreeDialog.getByRole("button", { name: "Create worktree" }).click();
    await expect.poll(() => readFile(resolve(secondFolder, "app.local"), "utf8").catch(() => ""), { timeout: 15_000 }).toBe("SECRET=1\n");
    await expect.poll(() => git(secondFolder, "rev-parse", "--abbrev-ref", "HEAD").catch(() => ""), { timeout: 15_000 }).toBe("feature/wt");
    await expect.poll(() => window.locator(".repositoryTab.active > button[role=tab]").getAttribute("title"), { timeout: 15_000 }).toContain("wt-folder-again");
    await window.getByRole("tab", { name: new RegExp("gitcrest-e2e-") }).click();

    // The current branch seeds a worktree from its right-click menu, through a new branch at its tip.
    const fromCurrentFolder = resolve(worktreeParent, "ux-folder");
    const currentRow = window.getByRole("list", { name: "Repository branches" }).locator(".branchItem").filter({ has: window.getByText("feature/ux", { exact: true }) });
    await currentRow.click({ button: "right" });
    await window.getByRole("menuitem", { name: "New worktree from feature/ux…" }).click();
    const fromCurrent = window.getByRole("dialog", { name: "New worktree from feature/ux" });
    await fromCurrent.getByRole("textbox", { name: "Branch name" }).fill("feature/ux-2");
    await fromCurrent.getByRole("textbox", { name: "Worktree folder" }).fill(fromCurrentFolder);
    await fromCurrent.getByRole("button", { name: "Create worktree" }).click();
    await expect.poll(() => git(fromCurrentFolder, "rev-parse", "--abbrev-ref", "HEAD").catch(() => ""), { timeout: 15_000 }).toBe("feature/ux-2");
    await expect.poll(() => window.locator(".repositoryTab.active > button[role=tab]").getAttribute("title"), { timeout: 15_000 }).toContain("ux-folder");
    await window.getByRole("tab", { name: new RegExp("gitcrest-e2e-") }).click();

    // Its branch row's right-click menu removes that worktree and, when asked, the branch with it.
    const uxRow = window.getByRole("list", { name: "Repository branches" }).locator(".branchItem").filter({ has: window.getByText("feature/ux-2", { exact: true }) });
    await expect.poll(async () => { await uxRow.click({ button: "right" }); return window.getByRole("menuitem", { name: "Remove its worktree…" }).isEnabled(); }, { timeout: 20_000 }).toBe(true);
    await window.getByRole("menuitem", { name: "Remove its worktree…" }).click();
    const removeBoth = window.getByRole("dialog", { name: "Remove worktree" });
    await removeBoth.getByRole("checkbox", { name: "Also delete the branch feature/ux-2" }).check();
    await removeBoth.getByRole("button", { name: "Remove worktree and branch" }).click();
    await expect.poll(() => access(fromCurrentFolder).then(() => true, () => false), { timeout: 15_000 }).toBe(false);
    await expect.poll(() => git(fixture.path, "branch", "--list", "feature/ux-2"), { timeout: 15_000 }).toBe("");
    expect(await window.getByRole("dialog", { name: "Tasks" }).count()).toBe(0);

    // Merge `side` into the current branch from the sidebar row.
    const sideRow = window.locator(".branchItem", { hasText: "side" });
    const mergeSide = sideRow.getByRole("button", { name: /Merge refs\/heads\/side/ });
    await expect.poll(async () => { await sideRow.hover(); return mergeSide.isEnabled(); }, { timeout: 20_000 }).toBe(true);
    await mergeSide.click();
    await expect.poll(() => git(fixture.path, "log", "--format=%s", "-1"), { timeout: 15_000 }).toBe("side work");
    expect(await window.getByRole("dialog", { name: "Tasks" }).count()).toBe(0);

    // Switch back from the sidebar row.
    const mainRow = window.locator(".branchItem", { hasText: new RegExp(`^\s*⑂?\s*${main}`) });
    const switchMain = mainRow.getByRole("button", { name: `Switch to ${main}` });
    await expect.poll(async () => { await mainRow.hover(); return switchMain.isEnabled(); }, { timeout: 20_000 }).toBe(true);
    await switchMain.click();
    await expect.poll(() => git(fixture.path, "rev-parse", "--abbrev-ref", "HEAD"), { timeout: 15_000 }).toBe(main);
    expect(await window.getByRole("dialog", { name: "Tasks" }).count()).toBe(0);

    // Rename a branch, then delete it; it is unmerged into main so deletion needs confirmation.
    const sideRow2 = window.locator(".branchItem").filter({ has: window.getByText("side", { exact: true }) });
    await chooseRowMenuItem(window, sideRow2, "side", "Rename side");
    const renameDialog = window.getByRole("dialog", { name: "Rename branch" });
    await renameDialog.getByRole("textbox", { name: "New name" }).fill("side-renamed");
    await renameDialog.getByRole("button", { name: "Rename branch" }).click();
    await expect.poll(() => git(fixture.path, "branch", "--list", "side-renamed"), { timeout: 15_000 }).toContain("side-renamed");
    expect(await window.getByRole("dialog", { name: "Tasks" }).count()).toBe(0);

    const renamedRow = window.locator(".branchItem", { hasText: "side-renamed" });
    await chooseRowMenuItem(window, renamedRow, "side-renamed", "Delete side-renamed");
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
      args: [".", "--lang=en-US", "--disable-gpu"],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
    await window.getByText("Core connected").waitFor({ timeout: 40_000 });
    await openRepository(window, fixture.path);

    // A locked worktree offers no Remove button, and its menu says why.
    expect(await window.getByRole("button", { name: "Remove worktree locked-wt" }).count()).toBe(0);
    // Branches that a worktree has checked out cannot be switched to; the row offers to open that worktree.
    const dirtyBranchRow = window.getByRole("list", { name: "Repository branches" }).locator(".branchItem").filter({ has: window.getByText("wt-dirty", { exact: true }) });
    await dirtyBranchRow.hover();
    expect(await dirtyBranchRow.getByRole("button", { name: "Switch to wt-dirty" }).count()).toBe(0);
    await expect.poll(async () => { await dirtyBranchRow.hover(); return dirtyBranchRow.getByRole("button", { name: "Open the worktree of wt-dirty" }).isEnabled(); }, { timeout: 20_000 }).toBe(true);
    await window.getByRole("button", { name: "Remove worktree dirty-wt" }).click();
    const removeDialog = window.getByRole("dialog", { name: "Remove worktree" });
    await removeDialog.getByRole("checkbox", { name: /discard them/ }).waitFor({ timeout: 10_000 });
    expect(await removeDialog.getByRole("button", { name: "Remove worktree" }).isDisabled()).toBe(true);
    expect(await access(resolve(dirty, "scratch.txt")).then(() => true, () => false)).toBe(true);
    await removeDialog.getByRole("checkbox", { name: /discard them/ }).check();
    await removeDialog.getByRole("button", { name: "Remove worktree" }).click();
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
      args: [".", "--lang=en-US", "--disable-gpu"],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
    await window.getByText("Core connected").waitFor({ timeout: 40_000 });
    await openRepository(window, fixture.path);
    await window.getByRole("tab", { name: "History" }).click();

    await window.getByText("first commit", { exact: true }).first().click();
    // The command palette reaches the same dialog from the keyboard.
    await window.keyboard.press("Control+k");
    await window.getByRole("textbox", { name: "Search commands" }).fill("branch at selected");
    await window.getByRole("button", { name: /Create branch at selected commit/ }).click();
    const dialog = window.getByRole("dialog", { name: "Create branch here" });
    await dialog.getByRole("textbox", { name: "Branch name" }).fill("from-first");
    await dialog.getByRole("button", { name: "Create and switch" }).click();
    await expect.poll(() => git(fixture.path, "rev-parse", "--abbrev-ref", "HEAD"), { timeout: 15_000 }).toBe("from-first");
    expect(await git(fixture.path, "rev-parse", "HEAD")).toBe(firstOid);
    expect(await window.getByRole("dialog", { name: "Tasks" }).count()).toBe(0);

    // The same dialog can check the branch out in a new worktree instead.
    const worktreePath = resolve(worktreeParent, "from-second");
    await window.getByText("second commit", { exact: true }).first().click();
    // Commit operations sit behind the selected commit's actions menu.
    await window.getByRole("button", { name: `Actions for commit ${secondOid.slice(0, 7)}` }).click();
    await window.getByRole("menuitem", { name: "Create branch here…" }).click();
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
      args: [".", "--lang=en-US", "--disable-gpu"],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
    await window.getByText("Core connected").waitFor({ timeout: 40_000 });
    await openRepository(window, fixture.path);

    const row = window.locator(".branchItem").filter({ has: window.getByText("feature", { exact: true }) });
    await row.click({ button: "right" });
    await window.getByRole("menuitem", { name: "Merge feature with options…", exact: true }).click();
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

it("opens a remote branch in a new worktree with a local tracking branch", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gitcrest-remote-wt-e2e-"));
  const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-remote-wt-e2e-app-data-"));
  try {
    const remote = resolve(root, "remote.git");
    const repo = resolve(root, "repo");
    const seed = resolve(root, "seed");
    await execFileAsync("git", ["init", "--bare", "--quiet", "--initial-branch=main", remote]);
    await execFileAsync("git", ["clone", "--quiet", remote, seed]);
    await git(seed, "config", "user.name", "T");
    await git(seed, "config", "user.email", "t@e.test");
    await writeFile(resolve(seed, "a.txt"), "a\n");
    await git(seed, "add", "a.txt");
    await git(seed, "commit", "--quiet", "-m", "base");
    await git(seed, "push", "--quiet", "origin", "main");
    await git(seed, "switch", "--quiet", "--create", "feature/remote-work");
    await writeFile(resolve(seed, "b.txt"), "b\n");
    await git(seed, "add", "b.txt");
    await git(seed, "commit", "--quiet", "-m", "remote work");
    await git(seed, "push", "--quiet", "origin", "feature/remote-work");
    await execFileAsync("git", ["clone", "--quiet", remote, repo]);

    app = await electron.launch({
      args: [".", "--lang=en-US", "--disable-gpu"],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
    await window.getByText("Core connected").waitFor({ timeout: 40_000 });
    await openRepository(window, repo);

    const row = window.getByRole("list", { name: "Repository branches" }).locator(".branchItem").filter({ has: window.getByText("origin/feature/remote-work", { exact: true }) });
    const open = row.getByRole("button", { name: "Open origin/feature/remote-work in a new worktree" });
    await expect.poll(async () => { await row.hover(); return open.isEnabled(); }, { timeout: 20_000 }).toBe(true);
    await open.click();
    const dialog = window.getByRole("dialog", { name: "Open branch in a new worktree" });
    const folder = resolve(root, "remote-worktree");
    await dialog.getByRole("textbox", { name: "Worktree folder" }).fill(folder);
    await dialog.getByRole("button", { name: "Create worktree" }).click();

    await expect.poll(() => git(folder, "rev-parse", "--abbrev-ref", "HEAD").catch(() => ""), { timeout: 20_000 }).toBe("feature/remote-work");
    expect(await git(folder, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/feature/remote-work");
    await expect.poll(() => window.locator(".repositoryTab.active > button[role=tab]").getAttribute("title"), { timeout: 15_000 }).toContain("remote-worktree");
  } finally {
    await app?.close();
    app = undefined;
    await rm(root, { recursive: true, force: true });
    await rm(appDataPath, { recursive: true, force: true });
  }
}, 120_000);

it("cleans up worktrees whose folders were deleted outside GitCrest", async () => {
  const fixture = await createTempGitRepository();
  const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-prune-e2e-app-data-"));
  const worktreeParent = await mkdtemp(resolve(tmpdir(), "gitcrest-prune-e2e-wt-"));
  try {
    await writeFile(resolve(fixture.path, "base.txt"), "base\n");
    await git(fixture.path, "add", "base.txt");
    await git(fixture.path, "commit", "--quiet", "-m", "base");
    const folder = resolve(worktreeParent, "doomed");
    await git(fixture.path, "worktree", "add", "-b", "doomed-branch", folder);
    await rm(folder, { recursive: true, force: true });

    app = await electron.launch({
      args: [".", "--lang=en-US", "--disable-gpu"],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
    await window.getByText("Core connected").waitFor({ timeout: 40_000 });
    await openRepository(window, fixture.path);

    await window.getByRole("button", { name: "Missing" }).waitFor({ timeout: 15_000 });
    await window.getByRole("button", { name: "Clean up missing" }).click();
    await expect.poll(() => git(fixture.path, "worktree", "list", "--porcelain").then((text) => text.split("\n").filter((line) => line.startsWith("worktree ")).length), { timeout: 15_000 }).toBe(1);
  } finally {
    await app?.close();
    app = undefined;
    await fixture.cleanup();
    await rm(appDataPath, { recursive: true, force: true });
    await rm(worktreeParent, { recursive: true, force: true });
  }
}, 120_000);
