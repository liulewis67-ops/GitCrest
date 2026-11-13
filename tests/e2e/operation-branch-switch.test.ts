import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { expect, it } from "vitest";
import { GitCrestApiClient } from "../../src/api/client";
import { createTempGitRepository } from "../fixtures/temp-repo";

const exec = promisify(execFile);

it("switches branches through a durable operation in the desktop app when the opt-in is on", async () => {
  const fixture = await createTempGitRepository();
  const appData = await mkdtemp(resolve(tmpdir(), "gitcrest-operation-switch-"));
  const git = async (...args: string[]) => (await exec("git", ["-C", fixture.path, ...args])).stdout;
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await git("config", "core.autocrlf", "false");
    await writeFile(resolve(fixture.path, "both.txt"), "one\ntwo\nthree\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    await git("branch", "-M", "main");
    await git("checkout", "-qb", "other");
    await writeFile(resolve(fixture.path, "both.txt"), "one\nother\nthree\n");
    await git("commit", "-qam", "other change");
    await git("checkout", "-q", "main");
    // A local edit to a file the target branch also changed, so the switch has to protect it.
    await writeFile(resolve(fixture.path, "both.txt"), "one\ntwo\nthree\nlocal tail\n");

    app = await electron.launch({
      args: [".", "--lang=en-US", "--disable-gpu", `--user-data-dir=${resolve(appData, "profile")}`],
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: "",
        GITCREST_DATABASE_PATH: resolve(appData, "test.sqlite"),
        GITCREST_OPERATION_CREATION: "1",
      },
    });
    const window = await app.firstWindow();
    await window.getByText("Core connected").waitFor({ timeout: 40_000 });
    const connection = await window.evaluate(() => globalThis.window.gitcrest!.getSidecarConnection());
    const api = new GitCrestApiClient(connection.baseUrl, connection.token);
    const { repoId } = await api.openRepository(fixture.path);
    await window.evaluate(() => {
      localStorage.setItem("gitcrest-operation-flow-v1", "on");
      localStorage.setItem("gitcrest-branch-change-policy-v1", "carry");
    });
    await window.reload();
    await window.locator(".repositoryRowOpen").click();
    await window.locator(".workspaceToolbar").waitFor();

    await window.keyboard.press("Control+b");
    const switcher = window.getByRole("dialog", { name: "Switch branch" });
    await switcher.getByText("other", { exact: true }).first().click();
    await switcher.getByRole("button", { name: "Continue", exact: true }).click();

    // The checkout ran as a durable operation task, finished, and kept the local edit.
    await expect.poll(async () => (await git("branch", "--show-current")).trim(), { timeout: 60_000 }).toBe("other");
    await expect.poll(async () => {
      const tasks = (await api.listTasks()).filter((task) => task.repoId === repoId);
      return tasks.length > 0 && tasks.every((task) => task.operation === "operationAction" && task.status === "succeeded");
    }, { timeout: 60_000 }).toBe(true);
    expect((await git("show", "HEAD:both.txt")).trim()).toBe("one\nother\nthree");
    expect(await git("status", "--porcelain")).toContain("both.txt");
    // The stored record already follows the new branch, so the header does not stay on the old one.
    expect((await api.getRepository(repoId)).branch).toBe("other");
    await expect.poll(async () => window.locator(".branchSelector:not(.worktreeSelector) .branchSelectorName").innerText(), { timeout: 20_000 }).toBe("other");
  } finally {
    await app?.close().catch(() => undefined);
    await rm(appData, { recursive: true, force: true });
    await fixture.cleanup();
  }
}, 180_000);
