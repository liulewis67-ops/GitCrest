import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { expect, it } from "vitest";
import { createTempGitRepository } from "../fixtures/temp-repo";

const exec = promisify(execFile);
it.each(["switch", "pull"])("safe %s keeps local edits in place without creating a shelf", async (operation) => {
  const fixture = await createTempGitRepository();
  const appData = await mkdtemp(resolve(tmpdir(), "gitcrest-safe-operation-"));
  const git = async (...args: string[]) => (await exec("git", ["-C", fixture.path, ...args])).stdout.trim();
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const file = resolve(fixture.path, "local.txt");
    const binary = resolve(fixture.path, "draft.bin");
    await writeFile(file, "base\n");
    await writeFile(resolve(fixture.path, "shared.txt"), "base\n");
    await git("add", "."); await git("commit", "-qm", "base");
    const branch = await git("branch", "--show-current");
    await git("switch", "-qc", "other");
    await writeFile(resolve(fixture.path, "shared.txt"), "upstream\n");
    await git("commit", "-qam", "target edit");
    const target = await git("rev-parse", "HEAD");
    await git("switch", branch);
    if (operation === "pull") {
      const remote = resolve(appData, "origin.git");
      await exec("git", ["init", "--bare", "--quiet", remote]);
      await git("remote", "add", "origin", remote);
      await git("push", "--quiet", "origin", `other:refs/heads/${branch}`);
      await git("branch", `--set-upstream-to=origin/${branch}`, branch);
      await git("config", "merge.autoStash", "true");
    }
    if (operation === "switch") {
      await writeFile(file, "staged\n"); await git("add", "local.txt");
    }
    await writeFile(file, "local worktree edit\n");
    const data = Buffer.from([0, 1, 255, 0, 2]);
    await writeFile(binary, data);
    const indexBefore = await git("diff", "--cached");
    app = await electron.launch({ args: [".", "--lang=en-US", "--disable-gpu", `--user-data-dir=${resolve(appData, "profile")}`], env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appData, "test.sqlite") } });
    const main = await app.firstWindow();
    await main.getByText("Core connected").waitFor({ timeout: 40_000 });
    const repoId = await main.evaluate(async (path) => {
      const c = await window.gitcrest!.getSidecarConnection();
      const r = await fetch(new URL("/api/v1/repositories", c.baseUrl), { method: "POST", headers: { Authorization: `Bearer ${c.token}`, "X-GitCrest-API-Version": "1", "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
      if (!r.ok) throw new Error(await r.text());
      return (await r.json()).repoId as string;
    }, fixture.path);
    await main.reload(); await main.locator(".repositoryRowOpen").click();
    await main.locator(".workspaceToolbar").waitFor();
    if (operation === "switch") {
      await main.keyboard.press("Control+b");
      const dialog = main.getByRole("dialog", { name: "Switch branch" });
      await dialog.getByRole("button", { name: "other", exact: true }).click();
    } else {
      await main.getByRole("button", { name: "Pull", exact: true }).click();
    }
    await expect.poll(() => git("rev-parse", "HEAD"), { timeout: 30_000 }).toBe(target);
    expect((await readFile(file, "utf8")).replace(/\r\n/g, "\n")).toBe("local worktree edit\n");
    expect(await readFile(binary)).toEqual(data);
    expect(await git("diff", "--cached")).toBe(indexBefore);
    const operations = await main.evaluate(async (repoId) => {
      const c = await window.gitcrest!.getSidecarConnection();
      const headers = { Authorization: `Bearer ${c.token}`, "X-GitCrest-API-Version": "1" };
      const tasks = await (await fetch(new URL("/api/v1/tasks", c.baseUrl), { headers })).json();
      const shelves = await (await fetch(new URL(`/api/v1/repositories/${repoId}/shelves`, c.baseUrl), { headers })).json();
      return { operations: tasks.map((task: { operation: string }) => task.operation), shelves };
    }, repoId);
    expect(operations.operations).not.toContain("shelfCreate");
    expect(operations.shelves).toEqual([]);
  } finally {
    await app?.close(); await fixture.cleanup(); await rm(appData, { recursive: true, force: true });
  }
}, 90_000);
