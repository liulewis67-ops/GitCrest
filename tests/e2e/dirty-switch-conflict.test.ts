import { openTaskDetails } from "./task-details";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { expect, it } from "vitest";
import { createTempGitRepository } from "../fixtures/temp-repo";

const exec = promisify(execFile);
it.each(["switch", "pull"])("%s with overlapping local edits opens the conflict window automatically", async (operation) => {
  const fixture = await createTempGitRepository();
  const appData = await mkdtemp(resolve(tmpdir(), "gitcrest-dirty-switch-"));
  // A plain `git status` quietly takes .git/index.lock to refresh the index. Polling it while the app runs its own
  // `git reset` made that step fail with "Unable to create index.lock", so the test never takes optional locks.
  const git = async (...args: string[]) => (await exec("git", ["-C", fixture.path, ...args], { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } })).stdout.trim();
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const path = resolve(fixture.path, "shared.txt");
    await writeFile(path, "base\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    const main = await git("branch", "--show-current");
    await git("switch", "-qc", "other");
    await writeFile(path, "target branch\n");
    await git("commit", "-qam", "target change");
    await git("switch", main);
    if (operation === "pull") {
      const remote = resolve(appData, "origin.git");
      await exec("git", ["init", "--bare", "--quiet", remote]);
      await git("remote", "add", "origin", remote);
      await git("push", "--quiet", "origin", `other:refs/heads/${main}`);
      await git("branch", `--set-upstream-to=origin/${main}`, main);
    }
    await writeFile(path, "local uncommitted edit\n");
    app = await electron.launch({
      args: [".", "--lang=en-US", "--disable-gpu", `--user-data-dir=${resolve(appData, "profile")}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appData, "test.sqlite") },
    });
    const window = await app.firstWindow();
    await window.getByText("Core connected").waitFor({ timeout: 40_000 });
    await window.evaluate(async (repositoryPath) => {
      const connection = await globalThis.window.gitcrest!.getSidecarConnection();
      const response = await fetch(new URL("/api/v1/repositories", connection.baseUrl), {
        method: "POST",
        headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ path: repositoryPath }),
      });
      if (!response.ok) throw new Error(await response.text());
    }, fixture.path);
    await window.reload();
    await window.locator(".repositoryRowOpen").click();
    await window.locator(".workspaceToolbar").waitFor();
    const opened = app.waitForEvent("window", { timeout: 30_000 });
    if (operation === "switch") {
      await window.keyboard.press("Control+b");
      const switcher = window.getByRole("dialog", { name: "Switch branch" });
      await switcher.getByRole("button", { name: "other", exact: true }).click();
      await switcher.getByText("There are uncommitted local changes. They stay in place when safe; otherwise they will be saved before switching.").waitFor();
      await switcher.getByRole("button", { name: "Continue", exact: true }).click();
      await switcher.getByRole("radio", { name: /Carry changes to the target branch/ }).check();
      await switcher.getByRole("button", { name: "Switch branch", exact: true }).click();
    } else {
      await window.getByRole("button", { name: "Pull", exact: true }).click();
      await window.getByRole("dialog", { name: "Pull current branch" }).getByRole("button", { name: "Pull with merge", exact: true }).click();
    }
    const resolver = await opened;
    await resolver.getByRole("main", { name: "Conflict resolution window" }).waitFor();
    expect(await git("branch", "--show-current")).toBe(operation === "switch" ? "other" : main);
    const content = await readFile(path, "utf8");
    expect(content).toContain("target branch");
    expect(content).toContain("local uncommitted edit");
    await resolver.getByRole("button", { name: "Use incoming #1", exact: true }).click();
    await resolver.getByRole("button", { name: "Save & mark resolved" }).click();
    await resolver.getByText("0 unresolved").waitFor({ timeout: 30_000 });
    expect(await git("ls-files", "--unmerged")).toBe("");
    expect((await readFile(path, "utf8")).replace(/\r\n/g, "\n")).toBe("local uncommitted edit\n");
    expect(await window.getByRole("dialog", { name: "Tasks" }).count()).toBe(0);
    await resolver.close();
    const tasks = await openTaskDetails(window);
    const restore = tasks.locator(".taskCard").filter({ has: window.locator('.taskCardHeading strong[data-operation^="shelfApply:"]') });
    const continueButton = restore.getByRole("button", { name: "Continue", exact: true });
    await restore.getByRole("button", { name: "Refresh preview", exact: true }).click();
    await expect.poll(() => continueButton.isEnabled(), { timeout: 15_000 }).toBe(true);
    await continueButton.click();
    try {
      await expect.poll(() => git("status", "--porcelain"), { timeout: 15_000 }).toBe("M shared.txt");
    } catch (error) {
      // This check fails rarely and has not been reproduced on demand; keep what the failure looked like.
      const card = (await restore.innerText().catch(() => "no restore card")).split("\n").join(" | ").slice(0, 900);
      // One failure was captured with no error banner at all, so the click was neither refused nor reported. Keep every
      // task in the dialog, to see whether a recovery task was queued, is still running, or failed on its own card.
      const banners = await tasks.locator(".taskCenterError").allInnerTexts().catch(() => []);
      const dialog = (await tasks.innerText().catch(() => "no dialog")).split("\n").join(" | ").slice(0, 2500);
      // A captured failure showed a failed "Continue Git operation" task, whose log is collapsed in the dialog. The text is
      // still in the page, so read it to see why Git could not complete the continuation.
      const failedLogs = (await tasks.locator(".taskCard").filter({ hasText: "Failed" }).locator(".taskLogs pre").allTextContents().catch(() => []))
        .map((log) => log.split("\n").join(" | ").slice(0, 3000));
      console.log("RESTORE-STATE>>>", JSON.stringify(await git("status", "--porcelain")), "continue visible:", await continueButton.isVisible().catch(() => false), "banners:", JSON.stringify(banners), "card:", card, "dialog:", dialog, "failed task logs:", JSON.stringify(failedLogs));
      throw error;
    }
  } finally {
    await app?.close();
    await fixture.cleanup();
    await rm(appData, { recursive: true, force: true });
  }
}, 90_000);
