import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { expect, it } from "vitest";
import { GitCrestApiClient } from "../../src/api/client";

const exec = promisify(execFile);

it("tells the user once, and still pulls the usual way, when the opt-in is on but the core cannot create operations", async () => {
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
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appData, "test.sqlite") },
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

    // The warning lives for a few seconds only, so look for it before waiting on the pull itself.
    await window.getByText(/cannot run them, so the usual flow was used/).waitFor({ timeout: 30_000 });
    // The usual pull ran: both commits are on main, and no operation exists.
    await expect.poll(async () => (await git(local, "log", "--format=%s", "-3")).trim().split("\n"), { timeout: 90_000 }).toEqual(["local change", "remote change", "base"]);
    expect(await api.listActiveRepositoryOperations(repoId)).toEqual([]);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(appData, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);
