import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { expect, it } from "vitest";
import { GitCrestApiClient, type TaskSnapshotResponse } from "../../src/api/client";
import { createTempGitRepository } from "../fixtures/temp-repo";

const exec = promisify(execFile);

it("keeps or carries local edits, remembers Always, and lets Settings restore asking", async () => {
  const fixture = await createTempGitRepository();
  const appData = await mkdtemp(resolve(tmpdir(), "gitcrest-branch-policy-"));
  const git = async (...args: string[]) => (await exec("git", ["-C", fixture.path, ...args])).stdout;
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await git("config", "core.autocrlf", "false");
    await writeFile(resolve(fixture.path, "both.txt"), "l1\nl2\nl3\nl4\nl5\n");
    await writeFile(resolve(fixture.path, "third.txt"), "t1\nt2\nt3\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    await git("branch", "-M", "main");
    // The target changes the same files on different lines, so a switch has to protect overlapping local edits.
    await git("checkout", "-qb", "other");
    await writeFile(resolve(fixture.path, "both.txt"), "l1\nl2\nl3\nl4\nother l5\n");
    await writeFile(resolve(fixture.path, "third.txt"), "t1\nt2\nt3 on other\n");
    await git("commit", "-qam", "other change");
    await git("checkout", "-q", "main");
    await writeFile(resolve(fixture.path, "both.txt"), "staged l1\nl2\nl3\nl4\nl5\n");
    await git("add", "both.txt");
    await writeFile(resolve(fixture.path, "both.txt"), "staged l1\nunstaged l2\nl3\nl4\nl5\n");
    await writeFile(resolve(fixture.path, "new.txt"), "untracked\n");
    const originalIndex = await git("diff", "--cached", "--binary");
    const originalWorking = await git("diff", "--binary");
    app = await electron.launch({
      args: [".", "--lang=en-US", "--disable-gpu", `--user-data-dir=${resolve(appData, "profile")}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appData, "test.sqlite") },
    });
    const window = await app.firstWindow();
    await window.getByText("Core connected").waitFor({ timeout: 40_000 });
    const connection = await window.evaluate(() => globalThis.window.gitcrest!.getSidecarConnection());
    const api = new GitCrestApiClient(connection.baseUrl, connection.token);
    const { repoId } = await api.openRepository(fixture.path);
    await window.reload();
    await window.locator(".repositoryRowOpen").click();
    await window.locator(".workspaceToolbar").waitFor();
    const switcher = window.getByRole("dialog", { name: "Switch branch" });
    const openSwitch = async (target: string) => {
      // The shortcut toggles the dialog and a cancelled question leaves it on its choice step, so always start fresh.
      // Right after another dialog closed the shortcut can be swallowed and the dialog can close on its own, so
      // retry the whole open-and-select sequence rather than assume a single pass.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (await switcher.isVisible()) {
          await window.keyboard.press("Escape");
          await switcher.waitFor({ state: "hidden" });
        }
        await window.keyboard.press("Control+b");
        if (!(await switcher.waitFor({ state: "visible", timeout: 3_000 }).then(() => true, () => false))) continue;
        if (!(await switcher.getByRole("button", { name: target, exact: true }).click({ timeout: 5_000 }).then(() => true, () => false))) continue;
        // Selection either executes directly or exposes the preservation choice immediately.
        await expect.poll(async () => !(await switcher.isVisible()) || await switcher.locator(".branchChangesPrompt").isVisible(), { timeout: 15_000 }).toBe(true);
        return;
      }
      throw new Error(`Could not start a switch to ${target}.`);
    };
    const waitForBranch = async (target: string, restoring = false) => {
      await expect.poll(async () => (await git("branch", "--show-current")).trim(), { timeout: 20_000 }).toBe(target);
      // A switch task can finish before the renderer submits its restore task.
      if (restoring) await expect.poll(async () => (await api.listRepositoryShelves(repoId)).every((shelf) => shelf.name.startsWith("GitCrest [")), { timeout: 20_000 }).toBe(true);
      await expect.poll(async () => (await api.listTasks()).some((task) => task.repoId === repoId && ["queued", "running", "waitingForInput"].includes(task.status)), { timeout: 20_000 }).toBe(false);
    };
    await openSwitch("other");
    await switcher.getByRole("radio", { name: /Keep changes on the current branch/ }).check();
    await switcher.getByRole("radio", { name: "Always", exact: true }).check();
    await mkdir(resolve(".review"), { recursive: true });
    await window.screenshot({ path: resolve(".review/branch-changes-choice.png") });
    await switcher.getByRole("button", { name: "Switch branch", exact: true }).click();
    await waitForBranch("other");
    expect(await git("status", "--porcelain")).toBe("");
    const mainShelves = await api.listRepositoryShelves(repoId);
    expect(mainShelves).toHaveLength(2);
    expect(mainShelves.every((shelf) => shelf.name.includes("[main]"))).toBe(true);

    // Reload while dirty: the remembered keep policy must still skip the question.
    await writeFile(resolve(fixture.path, "other-local.txt"), "belongs to other\n");
    await window.reload();
    await window.locator(".workspaceToolbar").waitFor();
    await openSwitch("main");
    await waitForBranch("main");
    expect(await git("status", "--porcelain")).toBe("");
    expect((await api.listRepositoryShelves(repoId)).some((shelf) => shelf.name.includes("[other]"))).toBe(true);

    const openSettings = async () => {
      await window.getByRole("button", { name: "Settings", exact: true }).click();
      await window.getByRole("menuitem", { name: /All settings/ }).click();
      return window.getByRole("dialog", { name: "Settings" });
    };
    let settings = await openSettings();
    const policy = settings.getByRole("combobox", { name: "Local changes when switching branches" });
    expect(await policy.inputValue()).toBe("keep");
    await policy.selectOption("carry");
    await window.screenshot({ path: resolve(".review/branch-changes-settings.png") });
    await settings.getByRole("button", { name: "Close settings" }).click();
    await writeFile(resolve(fixture.path, "carried.txt"), "take this with me\n");
    await openSwitch("other");
    await waitForBranch("other", true);
    expect(await readFile(resolve(fixture.path, "carried.txt"), "utf8")).toBe("take this with me\n");

    settings = await openSettings();
    await settings.getByRole("combobox", { name: "Local changes when switching branches" }).selectOption("ask");
    await settings.getByRole("button", { name: "Close settings" }).click();
    // The question is only asked when a local edit touches a file the target changes.
    await writeFile(resolve(fixture.path, "third.txt"), "local t1\nt2\nt3 on other\n");
    // Open the dialog only once the core itself reports the overlap, so the question cannot be skipped by a stale read.
    await expect.poll(async () => (await api.preflightRepositoryBranchSwitch(repoId, "main")).potentiallyOverwrittenPaths, { timeout: 20_000 }).toContain("third.txt");
    await openSwitch("main");
    await switcher.getByRole("radio", { name: /Just this time/ }).waitFor();
    await switcher.getByRole("button", { name: "Cancel", exact: true }).click();
    expect((await git("branch", "--show-current")).trim()).toBe("other");
    expect(await readFile(resolve(fixture.path, "carried.txt"), "utf8")).toBe("take this with me\n");
    await openSwitch("main");
    await switcher.getByRole("button", { name: "Switch branch", exact: true }).click();
    await waitForBranch("main", true);

    // Source-branch backups can recover the exact staged/unstaged split later.
    const finish = async (task: TaskSnapshotResponse) => {
      await expect.poll(async () => (await api.listTasks()).find((entry) => entry.taskId === task.taskId)?.status, { timeout: 20_000 }).toBe("succeeded");
    };
    for (const shelf of [...mainShelves].sort((a, b) => Number(b.scope === "index") - Number(a.scope === "index"))) {
      const preview = await api.preflightRepositoryShelfApply(repoId, shelf.shelfId);
      await finish(await api.applyRepositoryShelf(repoId, shelf.shelfId, {
        expectedHeadOid: preview.expectedHeadOid, previewRevision: preview.previewRevision,
      }));
    }
    // The last switch carried the extra edit that made the question appear; the recovery check is about the original split.
    await git("checkout", "--", "third.txt");
    expect(await git("diff", "--cached", "--binary")).toBe(originalIndex);
    expect(await git("diff", "--binary")).toBe(originalWorking);
    expect(await readFile(resolve(fixture.path, "new.txt"), "utf8")).toBe("untracked\n");
  } finally {
    await app?.close();
    await fixture.cleanup();
    await rm(appData, { recursive: true, force: true });
  }
}, 180_000);
