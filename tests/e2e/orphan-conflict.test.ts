import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { expect, it } from "vitest";
import { createTempGitRepository } from "../fixtures/temp-repo";

const exec = promisify(execFile);
it("opens orphaned index conflicts automatically and lets a conflict file reopen the resolver", async () => {
  const fixture = await createTempGitRepository();
  const appData = await mkdtemp(resolve(tmpdir(), "gitcrest-orphan-conflict-"));
  const git = async (...args: string[]) => (await exec("git", ["-C", fixture.path, ...args])).stdout.trim();
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const file = resolve(fixture.path, "shared.txt");
    await writeFile(file, "base\n");
    await git("add", "."); await git("commit", "-qm", "base");
    const branch = await git("branch", "--show-current");
    await git("switch", "-qc", "incoming");
    await writeFile(file, "incoming edit\n"); await git("commit", "-qam", "incoming");
    await git("switch", branch);
    await writeFile(file, "local edit\n"); await git("commit", "-qam", "local");
    await git("merge", "incoming").catch(() => {});
    // Shelf/stash apply conflicts have index stages without MERGE_HEAD.
    await git("update-ref", "-d", "MERGE_HEAD");
    expect(await git("ls-files", "-u")).not.toBe("");
    const originalHead = await git("rev-parse", "HEAD");
    const originalFile = await readFile(file, "utf8");
    app = await electron.launch({
      args: [".", "--lang=en-US", "--disable-gpu", `--user-data-dir=${resolve(appData, "profile")}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appData, "test.sqlite") },
    });
    const main = await app.firstWindow();
    await main.getByText("Core connected").waitFor({ timeout: 40_000 });
    await main.evaluate(async (path) => {
      const c = await window.gitcrest!.getSidecarConnection();
      const r = await fetch(new URL("/api/v1/repositories", c.baseUrl), {
        method: "POST", headers: { Authorization: `Bearer ${c.token}`, "X-GitCrest-API-Version": "1", "Content-Type": "application/json" }, body: JSON.stringify({ path }),
      });
      if (!r.ok) throw new Error(await r.text());
    }, fixture.path);
    await main.reload();
    const automaticallyOpened = app.waitForEvent("window", { timeout: 20_000 });
    await main.locator(".repositoryRowOpen").click();
    let resolver = await automaticallyOpened;
    await resolver.getByRole("main", { name: "Conflict resolution window" }).waitFor();
    expect(await readFile(file, "utf8")).toBe(originalFile);
    await resolver.close();
    const manuallyOpened = app.waitForEvent("window", { timeout: 15_000 });
    await main.locator(".changeTreeFile").filter({ hasText: "shared.txt" }).click();
    resolver = await manuallyOpened;
    await resolver.getByRole("main", { name: "Conflict resolution window" }).waitFor();
    await resolver.close();
    if (process.env.GITCREST_BANNER_SCREENSHOT) await main.screenshot({ path: process.env.GITCREST_BANNER_SCREENSHOT });
    const reopened = app.waitForEvent("window", { timeout: 15_000 });
    await main.locator(".workspaceBanner").getByRole("button", { name: "Resolve conflicts", exact: true }).click();
    resolver = await reopened;
    await resolver.getByRole("main", { name: "Conflict resolution window" }).waitFor();
    expect(app.windows()).toHaveLength(2);
    await resolver.close();
    const resumed = app.waitForEvent("window", { timeout: 20_000 });
    await main.reload();
    resolver = await resumed;
    await resolver.getByRole("button", { name: "Use current", exact: true }).click();
    await resolver.getByRole("button", { name: "Save & mark resolved" }).click();
    await resolver.getByText("0 unresolved").waitFor({ timeout: 30_000 });
    expect((await readFile(file, "utf8")).replace(/\r\n/g, "\n")).toBe("local edit\n");
    expect(await git("rev-parse", "HEAD")).toBe(originalHead);
    const completion = await main.evaluate(async () => {
      const c = await window.gitcrest!.getSidecarConnection();
      const headers = { Authorization: `Bearer ${c.token}`, "X-GitCrest-API-Version": "1", "Content-Type": "application/json" };
      const tasks = await (await fetch(new URL("/api/v1/tasks", c.baseUrl), { headers })).json();
      const waiting = tasks.find((task: { operation: string; status: string }) => task.operation === "resolveConflicts" && task.status === "waitingForInput");
      const preview = await (await fetch(new URL(`/api/v1/repositories/${waiting.repoId}/workflows/recovery-preflight?taskId=${waiting.taskId}`, c.baseUrl), { headers })).json();
      if (!preview.canContinue || preview.canAbort || preview.canSkip) throw new Error("Unsafe conflict recovery actions");
      const r = await fetch(new URL(`/api/v1/repositories/${waiting.repoId}/workflows/recovery`, c.baseUrl), {
        method: "POST", headers, body: JSON.stringify({ taskId: waiting.taskId, action: "continue", expectedOperation: "resolveConflicts", expectedHeadOid: preview.headOid, expectedConflictedPaths: [] }),
      });
      if (!r.ok) throw new Error(await r.text());
      return (await r.json()).taskId as string;
    });
    await expect.poll(() => main.evaluate(async (taskId) => {
      const c = await window.gitcrest!.getSidecarConnection();
      const tasks = await (await fetch(new URL("/api/v1/tasks", c.baseUrl), { headers: { Authorization: `Bearer ${c.token}`, "X-GitCrest-API-Version": "1" } })).json();
      return tasks.find((task: { taskId: string }) => task.taskId === taskId)?.status;
    }, completion), { timeout: 15_000 }).toBe("succeeded");
    expect(await git("rev-parse", "HEAD")).toBe(originalHead);
    expect((await readFile(file, "utf8")).replace(/\r\n/g, "\n")).toBe("local edit\n");
  } finally {
    await app?.close();
    await fixture.cleanup();
    await rm(appData, { recursive: true, force: true });
  }
}, 100_000);
