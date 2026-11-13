import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { expect, it } from "vitest";
import { GitCrestApiClient } from "../../src/api/client";

const exec = promisify(execFile);

it("walks a divergent pull through the recovery panel in the desktop app and aborts at the conflict", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "gitcrest-operation-panel-"));
  const appData = await mkdtemp(resolve(tmpdir(), "gitcrest-operation-panel-app-"));
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
    await writeFile(resolve(upstream, "f.txt"), "one\nREMOTE\nthree\n");
    await git(upstream, "commit", "-qam", "remote change");
    await git(upstream, "push", "-q", "origin", "main");
    await writeFile(resolve(local, "f.txt"), "one\nLOCAL\nthree\n");
    await git(local, "commit", "-qam", "local change");
    await git(local, "fetch", "-q");
    const localHead = (await git(local, "rev-parse", "HEAD")).trim();

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
    const { repoId } = await api.openRepository(local);
    // The typed client calls: review the request, then register it under an idempotency id.
    const request = await api.previewRepositoryOperation(repoId, { command: { kind: "pullRebase" }, preservation: "restore" });
    const created = await api.createRepositoryOperation(repoId, { requestId: "e2e-panel", request });
    expect(created.dispatched).toBe(true);

    await window.reload();
    await window.locator(".repositoryRowOpen").click();
    await window.locator(".workspaceToolbar").waitFor();
    await window.getByRole("button", { name: /tasks/i }).first().click();
    const tasks = window.getByRole("dialog", { name: "Tasks", exact: true });
    const panel = tasks.getByRole("region", { name: "Operations needing attention" });

    await panel.getByText("State: Waiting for your choice").waitFor({ timeout: 60_000 });
    await panel.getByRole("button", { name: "Review fetched changes" }).click();
    await panel.getByRole("button", { name: "Rebase onto upstream" }).click({ timeout: 60_000 });
    await panel.getByText(/Waiting for your input \(history conflict\)/).waitFor({ timeout: 90_000 });
    await panel.getByText(/Resolve the conflicts in the working tree/).waitFor();
    expect(await panel.getByRole("button", { name: "Continue rebase" }).count()).toBe(1);
    await panel.getByRole("button", { name: "Abort rebase" }).click();

    // The operation ends, the panel goes away, and the repository is exactly where it started.
    await panel.waitFor({ state: "detached", timeout: 90_000 });
    await expect.poll(async () => (await git(local, "rev-parse", "HEAD")).trim(), { timeout: 30_000 }).toBe(localHead);
    expect((await git(local, "branch", "--show-current")).trim()).toBe("main");
    expect((await git(local, "status", "--porcelain")).trim()).toBe("");
    expect(await api.listActiveRepositoryOperations(repoId)).toEqual([]);
    // No step task is left asking for attention after the operation ended.
    await expect.poll(async () => (await api.listTasks()).some((task) => task.status === "waitingForInput"), { timeout: 30_000 }).toBe(false);
  } finally {
    await app?.close().catch(() => undefined);
    await rm(appData, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
