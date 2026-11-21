import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication } from "playwright";
import { expect, it } from "vitest";

const run = promisify(execFile);

it("switches, merges, pushes and fast-forwards without confirmation, and asks only for overlapping edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "gitcrest-smooth-actions-"));
  const repository = join(root, "repository"); const remote = join(root, "origin.git"); const peer = join(root, "peer");
  const git = async (cwd: string, ...args: string[]) => (await run("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args])).stdout.trim();
  let app: ElectronApplication | undefined;
  try {
    await mkdir(repository);
    await git(repository, "init", "--quiet", "--initial-branch=main");
    await writeFile(join(repository, "shared.txt"), "base\n");
    await git(repository, "add", "."); await git(repository, "commit", "--quiet", "-m", "base");
    await git(root, "init", "--quiet", "--bare", "--initial-branch=main", remote);
    await git(repository, "remote", "add", "origin", remote); await git(repository, "push", "--quiet", "-u", "origin", "main");
    await git(root, "clone", "--quiet", remote, peer);
    await git(repository, "switch", "--quiet", "-c", "feature");
    await writeFile(join(repository, "shared.txt"), "feature\n");
    await git(repository, "commit", "--quiet", "-am", "feature work");
    const featureOid = await git(repository, "rev-parse", "HEAD");
    await git(repository, "switch", "--quiet", "main");
    app = await electron.launch({ args: [".", "--lang=en-US", "--disable-gpu", `--user-data-dir=${join(root, "profile")}`], env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: join(root, "gitcrest.sqlite") } });
    const page = await app.firstWindow();
    await page.locator(".connectionBadge.connected").waitFor({ timeout: 40_000 });
    await page.evaluate(() => localStorage.setItem("gitcrest-locale", "en")); await page.reload();
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, repository);
    await page.getByRole("button", { name: "Open local repository", exact: true }).click();
    await page.locator(".workspaceToolbar").waitFor();
    await page.evaluate(() => {
      const state = window as unknown as { reviewFlashes: number }; state.reviewFlashes = 0;
      new MutationObserver(() => { if (document.querySelector(".branchSwitchDetails, .pushDialog, .workflowDialog")) state.reviewFlashes += 1; }).observe(document.body, { subtree: true, childList: true });
    });
    const switchBranch = async (name: string) => {
      await page.keyboard.press("Control+b");
      await page.getByRole("dialog", { name: "Switch branch" }).getByRole("button", { name, exact: true }).click();
      await expect.poll(() => git(repository, "branch", "--show-current"), { timeout: 15_000 }).toBe(name);
      await page.locator(".branchSwitcherDialog").waitFor({ state: "hidden" });
    };
    await switchBranch("feature"); await switchBranch("main");
    await page.getByRole("tab", { name: "History", exact: true }).click();
    const row = page.locator(".branchItem").filter({ has: page.getByRole("button", { name: "Show history of feature", exact: true }) });
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Merge feature into current branch…", exact: true }).click();
    await expect.poll(() => git(repository, "rev-parse", "HEAD"), { timeout: 15_000 }).toBe(featureOid);
    await page.getByRole("button", { name: "Push", exact: true }).click();
    await expect.poll(() => git(remote, "rev-parse", "refs/heads/main"), { timeout: 15_000 }).toBe(featureOid);
    await git(peer, "pull", "--quiet", "--ff-only");
    await writeFile(join(peer, "incoming.txt"), "incoming\n"); await git(peer, "add", "."); await git(peer, "commit", "--quiet", "-m", "incoming"); await git(peer, "push", "--quiet");
    const incomingOid = await git(peer, "rev-parse", "HEAD");
    await page.getByRole("button", { name: "Fetch", exact: true }).click();
    await expect.poll(() => git(repository, "rev-parse", "origin/main"), { timeout: 15_000 }).toBe(incomingOid);
    await expect.poll(() => page.getByRole("button", { name: "Pull", exact: true }).isEnabled()).toBe(true);
    await page.getByRole("button", { name: "Pull", exact: true }).click();
    await expect.poll(() => git(repository, "rev-parse", "HEAD"), { timeout: 15_000 }).toBe(incomingOid);
    expect(await page.evaluate(() => (window as unknown as { reviewFlashes: number }).reviewFlashes)).toBe(0);
    // A conflicting local edit is the exception: show the decision immediately and preserve it on Cancel.
    await writeFile(join(repository, "shared.txt"), "local draft\n");
    await page.keyboard.press("Control+b");
    const picker = page.getByRole("dialog", { name: "Switch branch" });
    // feature and main now share shared.txt; choose a branch with the original base to create overlap.
    await git(repository, "branch", "base", "HEAD~2");
    await page.keyboard.press("Escape"); await page.keyboard.press("Control+b");
    await picker.getByRole("button", { name: "base", exact: true }).click();
    await picker.getByRole("radio", { name: /Carry changes to the target branch/ }).waitFor();
    expect(await git(repository, "branch", "--show-current")).toBe("main");
    await page.screenshot({ path: join(tmpdir(), "gitcrest-switch-exception.png") });
    await picker.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await readFile(join(repository, "shared.txt"), "utf8")).toBe("local draft\n");
  } catch (error) {
    await app?.firstWindow().then(page => page.screenshot({ path: join(tmpdir(), "gitcrest-smooth-actions-failure.png") })).catch(() => undefined);
    throw error;
  } finally {
    await app?.close();
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("gitcrest-smooth-actions-")) throw new Error("Unexpected operation test directory");
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}, 90_000);
