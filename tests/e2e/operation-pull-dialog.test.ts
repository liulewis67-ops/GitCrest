import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { expect, it } from "vitest";
import { GitCrestApiClient } from "../../src/api/client";
import { openTaskDetails } from "./task-details";

const exec = promisify(execFile);

it("starts a divergent pull from the Pull dialog as a durable operation when the opt-in is on", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gitcrest-operation-pull-dialog-"));
  const appData = await mkdtemp(resolve(tmpdir(), "gitcrest-operation-pull-dialog-app-"));
  const git = async (cwd: string, ...args: string[]) => (await exec("git", ["-C", cwd, ...args])).stdout;
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const remote = resolve(root, "remote.git");
    const upstream = resolve(root, "upstream");
    const local = resolve(root, "local");
    await exec("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
    await exec("git", ["clone", "--quiet", remote, upstream]);
    for (const dir of [upstream]) {
      await git(dir, "config", "user.name", "GitCrest Test");
      await git(dir, "config", "user.email", "gitcrest-test@example.invalid");
      await git(dir, "config", "core.autocrlf", "false");
    }
    await writeFile(resolve(upstream, "f.txt"), "one\ntwo\nthree\n");
    await git(upstream, "add", ".");
    await git(upstream, "commit", "-qm", "base");
    await git(upstream, "branch", "-M", "main");
    await git(upstream, "push", "-q", "origin", "main");
    await exec("git", ["clone", "--quiet", remote, local]);
    await git(local, "config", "user.name", "GitCrest Test");
    await git(local, "config", "user.email", "gitcrest-test@example.invalid");
    await git(local, "config", "core.autocrlf", "false");
    // Both sides add a different file, so the histories diverge and rebase cleanly: no conflict to resolve.
    await writeFile(resolve(upstream, "remote-only.txt"), "from the remote\n");
    await git(upstream, "add", ".");
    await git(upstream, "commit", "-qm", "remote change");
    await git(upstream, "push", "-q", "origin", "main");
    await writeFile(resolve(local, "local-only.txt"), "from this clone\n");
    await git(local, "add", ".");
    await git(local, "commit", "-qm", "local change");
    await git(local, "fetch", "-q");

    app = await electron.launch({
      args: [".", "--lang=en-US", "--disable-gpu", `--user-data-dir=${resolve(appData, "profile")}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appData, "test.sqlite"), GITCREST_OPERATION_CREATION: "1" },
    });
    const window = await app.firstWindow();
    await window.getByText("Core connected").waitFor({ timeout: 40_000 });
    const connection = await window.evaluate(() => globalThis.window.gitcrest!.getSidecarConnection());
    const api = new GitCrestApiClient(connection.baseUrl, connection.token);
    const { repoId } = await api.openRepository(local);
    await window.evaluate(() => localStorage.setItem("gitcrest-operation-flow-v1", "on"));
    await window.reload();
    await window.locator(".repositoryRowOpen").click();
    await window.locator(".workspaceToolbar").waitFor();

    await window.getByRole("button", { name: "Pull", exact: true }).click();
    const pullDialog = window.getByRole("dialog", { name: "Pull current branch" });
    // Merge is the default strategy; the primary button's label follows the chosen one.
    await pullDialog.getByRole("radio", { name: /^Rebase/ }).check();
    await pullDialog.getByRole("button", { name: "Pull with rebase", exact: true }).click();

    // It became a durable operation (not a plain pull task) and waits at its first explicit step.
    await expect.poll(async () => (await api.listActiveRepositoryOperations(repoId)).length, { timeout: 60_000 }).toBe(1);
    const tasks = await openTaskDetails(window);
    const panel = tasks.getByRole("region", { name: "Operations needing attention" });
    await panel.getByText("State: Waiting for your choice").waitFor({ timeout: 60_000 });
    await panel.getByRole("button", { name: "Review fetched changes" }).click();
    await panel.getByRole("button", { name: "Rebase onto upstream" }).click({ timeout: 60_000 });

    // A non-conflicting rebase finishes by itself: both commits end up on main, the clone is ahead by one.
    await panel.waitFor({ state: "detached", timeout: 90_000 });
    expect((await git(local, "log", "--format=%s", "-3")).trim().split("\n")).toEqual(["local change", "remote change", "base"]);
    expect((await git(local, "status", "--porcelain")).trim()).toBe("");
    expect(await api.listActiveRepositoryOperations(repoId)).toEqual([]);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(appData, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);
