import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { createTempGitRepository } from "../fixtures/temp-repo";

const execFileAsync = promisify(execFile);

describe("remote sync E2E", () => {
  let app: ElectronApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("reviews and pushes a local commit to an isolated bare remote", async () => {
    const fixture = await createTempGitRepository();
    const bareRemotePath = await mkdtemp(resolve(tmpdir(), "gitcrest-e2e-remote-"));
    const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-remote-e2e-app-data-"));
    const filePath = resolve(fixture.path, "src/remote-sync.ts");

    try {
      await mkdir(resolve(fixture.path, "src"), { recursive: true });
      await writeFile(filePath, "export const sync = 'base';\n");
      await execFileAsync("git", ["-C", fixture.path, "add", "src/remote-sync.ts"]);
      await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-m", "add remote sync fixture"]);
      await execFileAsync("git", ["init", "--bare", "--quiet", bareRemotePath]);
      await execFileAsync("git", ["-C", fixture.path, "remote", "add", "origin", bareRemotePath]);
      await execFileAsync("git", ["-C", fixture.path, "push", "--quiet", "--set-upstream", "origin", "HEAD"]);
      await writeFile(filePath, "export const sync = 'pushed through GitCrest';\n");
      await execFileAsync("git", ["-C", fixture.path, "add", "src/remote-sync.ts"]);
      await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-m", "test reviewed push"]);
      const branch = (await execFileAsync("git", ["-C", fixture.path, "branch", "--show-current"])).stdout.trim();
      const localHead = (await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD"])).stdout.trim();

      app = await electron.launch({
        args: ["."],
        env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
      });
      const window = await app.firstWindow();
      await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
      await window.getByText("Core connected").waitFor({ timeout: 15_000 });

      const opened = await window.evaluate(async (repositoryPath) => {
        const connection = await (globalThis.window as unknown as Window & {
          gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
        }).gitcrest.getSidecarConnection();
        const response = await fetch(new URL("/api/v1/repositories", connection.baseUrl), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${connection.token}`,
            "X-GitCrest-API-Version": "1",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ path: repositoryPath }),
        });
        return { status: response.status };
      }, fixture.path);
      expect(opened.status).toBe(200);

      await window.reload();
      await window.getByRole("heading", { name: "Recent repositories" }).waitFor();
      await window.locator(".repositoryRowOpen").click();
      await window.locator(".workspaceCrumb").waitFor();
      await window.getByRole("button", { name: "Workspace", exact: true }).click();
      await window.getByRole("button", { name: "Push", exact: true }).click();

      const pushDialog = window.getByRole("dialog", { name: "Push current branch" });
      await pushDialog.getByText(`origin/${branch}`, { exact: true }).waitFor();
      await pushDialog.getByRole("region", { name: "Commits to push" }).getByText("test reviewed push").waitFor();
      await pushDialog.getByRole("button", { name: "Push", exact: true }).click();

      const tasksDialog = window.getByRole("dialog", { name: "Tasks" });
      const pushTask = tasksDialog.locator(".taskCard").filter({ has: window.locator(".taskCardHeading strong", { hasText: "push" }) });
      await pushTask.waitFor({ state: "visible" });
      await window.waitForFunction(() => {
        const card = [...document.querySelectorAll(".taskCard")].find((entry) => entry.querySelector(".taskCardHeading strong")?.textContent === "push");
        return Boolean(card && !["queued", "running"].includes(card.querySelector(".taskStatus")?.textContent || ""));
      }, undefined, { timeout: 20_000 });
      const pushTaskBody = await pushTask.innerText();
      if (!pushTaskBody.includes("Succeeded")) throw new Error(`Push task did not succeed: ${pushTaskBody}`);

      const remoteHead = (await execFileAsync("git", ["-C", bareRemotePath, "rev-parse", `refs/heads/${branch}`])).stdout.trim();
      expect(remoteHead).toBe(localHead);
    } finally {
      await app?.close();
      app = undefined;
      await fixture.cleanup();
      await rm(bareRemotePath, { recursive: true, force: true });
      await rm(appDataPath, { recursive: true, force: true });
    }
  }, 60_000);

  it("fetches a remote-only commit and reviews a clean pull before integrating it", async () => {
    const fixture = await createTempGitRepository();
    const bareRemotePath = await mkdtemp(resolve(tmpdir(), "gitcrest-e2e-pull-remote-"));
    const peerPath = await mkdtemp(resolve(tmpdir(), "gitcrest-e2e-pull-peer-"));
    const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-pull-e2e-app-data-"));
    const filePath = resolve(fixture.path, "src/remote-pull.ts");

    try {
      await mkdir(resolve(fixture.path, "src"), { recursive: true });
      await writeFile(filePath, "export const sync = 'base';\n");
      await execFileAsync("git", ["-C", fixture.path, "add", "src/remote-pull.ts"]);
      await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-m", "add pull fixture"]);
      await execFileAsync("git", ["init", "--bare", "--quiet", bareRemotePath]);
      await execFileAsync("git", ["-C", fixture.path, "remote", "add", "origin", bareRemotePath]);
      await execFileAsync("git", ["-C", fixture.path, "push", "--quiet", "--set-upstream", "origin", "HEAD"]);
      await execFileAsync("git", ["clone", "--quiet", bareRemotePath, peerPath]);
      await execFileAsync("git", ["-C", peerPath, "config", "user.name", "GitCrest Peer Test"]);
      await execFileAsync("git", ["-C", peerPath, "config", "user.email", "gitcrest-peer@example.invalid"]);
      await writeFile(resolve(peerPath, "src/remote-pull.ts"), "export const sync = 'fetched and pulled';\n");
      await execFileAsync("git", ["-C", peerPath, "add", "src/remote-pull.ts"]);
      await execFileAsync("git", ["-C", peerPath, "commit", "--quiet", "-m", "remote-only change"]);
      await execFileAsync("git", ["-C", peerPath, "push", "--quiet", "origin", "HEAD"]);
      const branch = (await execFileAsync("git", ["-C", fixture.path, "branch", "--show-current"])).stdout.trim();
      const remoteHead = (await execFileAsync("git", ["-C", peerPath, "rev-parse", "HEAD"])).stdout.trim();

      app = await electron.launch({
        args: ["."],
        env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
      });
      const window = await app.firstWindow();
      await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
      await window.getByText("Core connected").waitFor({ timeout: 15_000 });
      const opened = await window.evaluate(async (repositoryPath) => {
        const connection = await (globalThis.window as unknown as Window & {
          gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
        }).gitcrest.getSidecarConnection();
        const response = await fetch(new URL("/api/v1/repositories", connection.baseUrl), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${connection.token}`,
            "X-GitCrest-API-Version": "1",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ path: repositoryPath }),
        });
        return { status: response.status };
      }, fixture.path);
      expect(opened.status).toBe(200);

      await window.reload();
      await window.getByRole("heading", { name: "Recent repositories" }).waitFor();
      await window.locator(".repositoryRowOpen").click();
      await window.locator(".workspaceCrumb").waitFor();
      await window.getByRole("button", { name: "Workspace", exact: true }).click();
      await window.getByRole("button", { name: "Fetch", exact: true }).click();

      const tasksDialog = window.getByRole("dialog", { name: "Tasks" });
      const fetchTask = tasksDialog.locator(".taskCard").filter({ has: window.locator(".taskCardHeading strong", { hasText: "fetch" }) });
      await fetchTask.waitFor({ state: "visible" });
      await window.waitForFunction(() => {
        const card = [...document.querySelectorAll(".taskCard")].find((entry) => entry.querySelector(".taskCardHeading strong")?.textContent?.startsWith("fetch"));
        return Boolean(card && !["queued", "running"].includes(card.querySelector(".taskStatus")?.textContent || ""));
      }, undefined, { timeout: 20_000 });
      const fetchTaskBody = await fetchTask.innerText();
      if (!fetchTaskBody.includes("Succeeded")) throw new Error(`Fetch task did not succeed: ${fetchTaskBody}`);
      await tasksDialog.getByRole("button", { name: "Close tasks" }).click();

      await window.getByRole("button", { name: "Pull", exact: true }).click();
      const pullDialog = window.getByRole("dialog", { name: "Pull current branch" });
      await pullDialog.getByText(`origin/${branch}`, { exact: true }).waitFor();
      await pullDialog.locator(".pushTarget small").filter({ hasText: "1 behind" }).waitFor();
      await expect.poll(() => pullDialog.getByRole("button", { name: "Pull with merge" }).isEnabled()).toBe(true);
      await pullDialog.getByRole("button", { name: "Pull with merge" }).click();

      const pullTask = window.locator(".taskCard").filter({ has: window.locator(".taskCardHeading strong", { hasText: "pullMerge" }) });
      await pullTask.waitFor({ state: "visible" });
      await window.waitForFunction(() => {
        const card = [...document.querySelectorAll(".taskCard")].find((entry) => entry.querySelector(".taskCardHeading strong")?.textContent === "pullMerge");
        return Boolean(card && !["queued", "running"].includes(card.querySelector(".taskStatus")?.textContent || ""));
      }, undefined, { timeout: 20_000 });
      const pullTaskBody = await pullTask.innerText();
      if (!pullTaskBody.includes("Succeeded")) throw new Error(`Pull task did not succeed: ${pullTaskBody}`);

      expect((await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD"])).stdout.trim()).toBe(remoteHead);
      expect((await readFile(filePath, "utf8")).replace(/\r\n/g, "\n")).toBe("export const sync = 'fetched and pulled';\n");
    } finally {
      await app?.close();
      app = undefined;
      await fixture.cleanup();
      await rm(bareRemotePath, { recursive: true, force: true });
      await rm(peerPath, { recursive: true, force: true });
      await rm(appDataPath, { recursive: true, force: true });
    }
  }, 60_000);

  it("keeps remote tracking refs unchanged after a failed fetch and succeeds after retry", async () => {
    const fixture = await createTempGitRepository();
    const remoteRoot = await mkdtemp(resolve(tmpdir(), "gitcrest-e2e-fetch-retry-"));
    const bareRemotePath = resolve(remoteRoot, "origin.git");
    const sourceRemotePath = resolve(remoteRoot, "source.git");
    const peerPath = resolve(remoteRoot, "peer");
    const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-fetch-retry-app-data-"));
    const filePath = resolve(fixture.path, "src/fetch-retry.ts");

    try {
      await mkdir(resolve(fixture.path, "src"), { recursive: true });
      await writeFile(filePath, "export const fetched = 'base';\n");
      await execFileAsync("git", ["-C", fixture.path, "add", "src/fetch-retry.ts"]);
      await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-m", "add fetch retry fixture"]);
      await execFileAsync("git", ["init", "--bare", "--quiet", sourceRemotePath]);
      await execFileAsync("git", ["-C", fixture.path, "remote", "add", "origin", sourceRemotePath]);
      await execFileAsync("git", ["-C", fixture.path, "push", "--quiet", "--set-upstream", "origin", "HEAD"]);
      const branch = (await execFileAsync("git", ["-C", fixture.path, "branch", "--show-current"])).stdout.trim();
      const baselineHead = (await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD"])).stdout.trim();
      await execFileAsync("git", ["clone", "--quiet", sourceRemotePath, peerPath]);
      await execFileAsync("git", ["-C", peerPath, "config", "user.name", "GitCrest Peer Test"]);
      await execFileAsync("git", ["-C", peerPath, "config", "user.email", "gitcrest-peer@example.invalid"]);
      await writeFile(resolve(peerPath, "src/fetch-retry.ts"), "export const fetched = 'remote after retry';\n");
      await execFileAsync("git", ["-C", peerPath, "add", "src/fetch-retry.ts"]);
      await execFileAsync("git", ["-C", peerPath, "commit", "--quiet", "-m", "remote change for fetch retry"]);
      await execFileAsync("git", ["-C", peerPath, "push", "--quiet", "origin", "HEAD"]);
      const remoteHead = (await execFileAsync("git", ["-C", peerPath, "rev-parse", "HEAD"])).stdout.trim();
      await execFileAsync("git", ["-C", fixture.path, "remote", "set-url", "origin", bareRemotePath]);

      app = await electron.launch({
        args: ["."],
        env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
      });
      const window = await app.firstWindow();
      await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
      await window.getByText("Core connected").waitFor({ timeout: 15_000 });
      const opened = await window.evaluate(async (repositoryPath) => {
        const connection = await (globalThis.window as unknown as Window & {
          gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
        }).gitcrest.getSidecarConnection();
        const response = await fetch(new URL("/api/v1/repositories", connection.baseUrl), {
          method: "POST",
          headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1", "Content-Type": "application/json" },
          body: JSON.stringify({ path: repositoryPath }),
        });
        return response.status;
      }, fixture.path);
      expect(opened).toBe(200);

      await window.reload();
      await window.getByRole("heading", { name: "Recent repositories" }).waitFor();
      await window.locator(".repositoryRowOpen").click();
      await window.locator(".workspaceCrumb").waitFor();
      await window.getByRole("button", { name: "Workspace", exact: true }).click();
      await window.getByRole("button", { name: "Fetch", exact: true }).click();

      const tasksDialog = window.getByRole("dialog", { name: "Tasks" });
      const fetchTask = tasksDialog.locator(".taskCard").filter({ has: window.locator(".taskCardHeading strong", { hasText: "fetch" }) }).last();
      await fetchTask.waitFor({ state: "visible" });
      await window.waitForFunction(() => {
        const cards = [...document.querySelectorAll(".taskCard")];
        const card = cards.find((entry) => entry.querySelector(".taskCardHeading strong")?.textContent?.startsWith("fetch"));
        return Boolean(card && !["queued", "running"].includes(card.querySelector(".taskStatus")?.textContent || ""));
      }, undefined, { timeout: 20_000 });
      await fetchTask.getByText("failed", { exact: true }).waitFor();
      expect((await execFileAsync("git", ["-C", fixture.path, "rev-parse", `refs/remotes/origin/${branch}`])).stdout.trim()).toBe(baselineHead);

      const previousFetchTaskIds = await window.evaluate(async () => {
        const connection = await (globalThis.window as unknown as Window & {
          gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
        }).gitcrest.getSidecarConnection();
        const response = await fetch(new URL("/api/v1/tasks", connection.baseUrl), {
          headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1" },
        });
        const tasks = await response.json() as Array<{ taskId: string; operation: string }>;
        return tasks.filter((task) => task.operation === "fetch").map((task) => task.taskId);
      });
      await tasksDialog.getByRole("button", { name: "Close tasks" }).click();
      await execFileAsync("git", ["clone", "--quiet", "--bare", sourceRemotePath, bareRemotePath]);

      await window.getByRole("button", { name: "Workspace", exact: true }).click();
      await window.getByRole("button", { name: "Fetch", exact: true }).click();
      await expect.poll(async () => await window.evaluate(async (previousTaskIds) => {
        const connection = await (globalThis.window as unknown as Window & {
          gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
        }).gitcrest.getSidecarConnection();
        const response = await fetch(new URL("/api/v1/tasks", connection.baseUrl), {
          headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1" },
        });
        const tasks = await response.json() as Array<{ taskId: string; operation: string; status: string }>;
        return tasks.find((task) => task.operation === "fetch" && !previousTaskIds.includes(task.taskId))?.status;
      }, previousFetchTaskIds), { timeout: 20_000 }).toBe("succeeded");
      expect((await execFileAsync("git", ["-C", fixture.path, "rev-parse", `refs/remotes/origin/${branch}`])).stdout.trim()).toBe(remoteHead);
      expect((await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD"])).stdout.trim()).toBe(baselineHead);
    } finally {
      await app?.close();
      app = undefined;
      await fixture.cleanup();
      await rm(remoteRoot, { recursive: true, force: true });
      await rm(appDataPath, { recursive: true, force: true });
    }
  }, 60_000);

  it("resolves a pull merge conflict from the waiting task and completes the merge", async () => runPullConflictRecovery("merge"), 90_000);

  it("resolves a pull rebase conflict from the waiting task and completes the rebase", async () => runPullConflictRecovery("rebase"), 90_000);

  async function runPullConflictRecovery(strategy: "merge" | "rebase") {
    const fixture = await createTempGitRepository();
    const bareRemotePath = await mkdtemp(resolve(tmpdir(), "gitcrest-e2e-pull-conflict-remote-"));
    const peerPath = await mkdtemp(resolve(tmpdir(), "gitcrest-e2e-pull-conflict-peer-"));
    const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-pull-conflict-e2e-app-data-"));
    const filePath = resolve(fixture.path, "src/pull-conflict.ts");
    const pullOperation = strategy === "merge" ? "pullMerge" : "pullRebase";
    const conflictSide = "theirs";

    try {
      await mkdir(resolve(fixture.path, "src"), { recursive: true });
      await writeFile(filePath, "export const value = 'base';\n");
      await execFileAsync("git", ["-C", fixture.path, "add", "src/pull-conflict.ts"]);
      await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-m", "add pull conflict fixture"]);
      await execFileAsync("git", ["init", "--bare", "--quiet", bareRemotePath]);
      await execFileAsync("git", ["-C", fixture.path, "remote", "add", "origin", bareRemotePath]);
      await execFileAsync("git", ["-C", fixture.path, "push", "--quiet", "--set-upstream", "origin", "HEAD"]);
      await execFileAsync("git", ["clone", "--quiet", bareRemotePath, peerPath]);
      await execFileAsync("git", ["-C", peerPath, "config", "user.name", "GitCrest Peer Test"]);
      await execFileAsync("git", ["-C", peerPath, "config", "user.email", "gitcrest-peer@example.invalid"]);

      await writeFile(filePath, "export const value = 'local';\n");
      await execFileAsync("git", ["-C", fixture.path, "add", "src/pull-conflict.ts"]);
      await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-m", "local conflicting change"]);
      const localCommit = (await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD"])).stdout.trim();

      await writeFile(resolve(peerPath, "src/pull-conflict.ts"), "export const value = 'remote';\n");
      await execFileAsync("git", ["-C", peerPath, "add", "src/pull-conflict.ts"]);
      await execFileAsync("git", ["-C", peerPath, "commit", "--quiet", "-m", "remote conflicting change"]);
      await execFileAsync("git", ["-C", peerPath, "push", "--quiet", "origin", "HEAD"]);
      const remoteCommit = (await execFileAsync("git", ["-C", peerPath, "rev-parse", "HEAD"])).stdout.trim();

      app = await electron.launch({
        args: ["."],
        env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
      });
      const window = await app.firstWindow();
      await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
      await window.getByText("Core connected").waitFor({ timeout: 15_000 });
      const opened = await window.evaluate(async (repositoryPath) => {
        const connection = await (globalThis.window as unknown as Window & {
          gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
        }).gitcrest.getSidecarConnection();
        const response = await fetch(new URL("/api/v1/repositories", connection.baseUrl), {
          method: "POST",
          headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1", "Content-Type": "application/json" },
          body: JSON.stringify({ path: repositoryPath }),
        });
        return response.status;
      }, fixture.path);
      expect(opened).toBe(200);

      await window.reload();
      await window.getByRole("heading", { name: "Recent repositories" }).waitFor();
      await window.locator(".repositoryRowOpen").click();
      await window.locator(".workspaceCrumb").waitFor();
      await window.getByRole("button", { name: "Workspace", exact: true }).click();
      await window.getByRole("button", { name: "Fetch", exact: true }).click();
      const fetchTask = window.locator(".taskCard").filter({ has: window.locator(".taskCardHeading strong", { hasText: "fetch" }) });
      await fetchTask.waitFor({ state: "visible" });
      await window.waitForFunction(() => {
        const card = [...document.querySelectorAll(".taskCard")].find((entry) => entry.querySelector(".taskCardHeading strong")?.textContent?.startsWith("fetch"));
        return Boolean(card && !["queued", "running"].includes(card.querySelector(".taskStatus")?.textContent || ""));
      }, undefined, { timeout: 20_000 });
      expect(await fetchTask.innerText()).toContain("Succeeded");
      await window.getByRole("dialog", { name: "Tasks" }).getByRole("button", { name: "Close tasks" }).click();

      await window.getByRole("button", { name: "Pull", exact: true }).click();
      const pullDialog = window.getByRole("dialog", { name: "Pull current branch" });
      await pullDialog.locator(".pushTarget small").filter({ hasText: "1 ahead · 1 behind" }).waitFor();
      if (strategy === "rebase") await pullDialog.locator('input[name="pull-strategy"][value="rebase"]').check();
      await expect.poll(() => pullDialog.getByRole("button", { name: `Pull with ${strategy}` }).isEnabled()).toBe(true);
      await pullDialog.getByRole("button", { name: `Pull with ${strategy}` }).click();

      const taskDialog = window.getByRole("dialog", { name: "Tasks" });
      const pullTask = taskDialog.locator(".taskCard").filter({ has: window.locator(".taskCardHeading strong", { hasText: pullOperation }) });
      await pullTask.waitFor({ state: "visible" });
      try {
        await window.waitForFunction((operation) => {
          const card = [...document.querySelectorAll(".taskCard")].find((entry) => entry.querySelector(".taskCardHeading strong")?.textContent === operation);
          return Boolean(card && ["waitingForInput", "failed", "cancelled", "succeeded"].includes(card.querySelector(".taskStatus")?.textContent || ""));
        }, pullOperation, { timeout: 20_000 });
      } catch {
        const state = await pullTask.innerText();
        await pullTask.locator(".taskLogs summary").click();
        const logs = await pullTask.locator(".taskLogs pre").innerText();
        throw new Error(`Pull task did not reach a terminal or recovery state: ${state}\n${logs}`);
      }
      const pullTaskState = await pullTask.innerText();
      if (!pullTaskState.toLowerCase().includes("waitingforinput")) {
        await pullTask.locator(".taskLogs summary").click();
        const logs = await pullTask.locator(".taskLogs pre").innerText();
        throw new Error(`Pull did not pause for conflict recovery: ${pullTaskState}\n${logs}`);
      }
      await pullTask.getByRole("button", { name: "Open conflict resolver" }).waitFor({ timeout: 20_000 });
      const conflictWindowPromise = app.waitForEvent("window");
      await pullTask.getByRole("button", { name: "Open conflict resolver" }).click();
      const conflictWindow = await conflictWindowPromise;
      await conflictWindow.getByRole("heading", { name: "Resolve conflicts" }).waitFor();
      await conflictWindow.getByRole("button", { name: `Use ${conflictSide} for conflict 1` }).click();
      await conflictWindow.getByRole("button", { name: "Save result" }).click();
      await conflictWindow.getByText(/Saved to the working tree/).waitFor();
      await conflictWindow.getByRole("button", { name: "Mark resolved" }).click();
      await conflictWindow.getByText("0 unresolved").waitFor();
      await conflictWindow.close();

      await pullTask.getByRole("button", { name: "Refresh preview" }).click();
      await expect.poll(() => pullTask.getByRole("button", { name: "Continue" }).isEnabled(), { timeout: 15_000 }).toBe(true);
      await pullTask.getByRole("button", { name: "Continue" }).click();
      await expect.poll(async () => await window.evaluate(async () => {
        const connection = await (globalThis.window as unknown as Window & {
          gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
        }).gitcrest.getSidecarConnection();
        const response = await fetch(new URL("/api/v1/tasks", connection.baseUrl), {
          headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1" },
        });
        const tasks = await response.json() as Array<{ operation: string; status: string }>;
        return tasks.find((task) => task.operation === "workflowContinue")?.status;
      }), { timeout: 20_000 }).toBe("succeeded");
      await expect.poll(async () => await window.evaluate(async (operation) => {
        const connection = await (globalThis.window as unknown as Window & {
          gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
        }).gitcrest.getSidecarConnection();
        const response = await fetch(new URL("/api/v1/tasks", connection.baseUrl), {
          headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1" },
        });
        const tasks = await response.json() as Array<{ operation: string; status: string }>;
        return tasks.find((task) => task.operation === operation)?.status;
      }, pullOperation), { timeout: 20_000 }).toBe("succeeded");

      const headParents = (await execFileAsync("git", ["-C", fixture.path, "rev-list", "--parents", "-n", "1", "HEAD"])).stdout.trim().split(/\s+/);
      if (strategy === "merge") {
        expect(headParents).toContain(localCommit);
        expect(headParents).toContain(remoteCommit);
      } else {
        expect(headParents).toHaveLength(2);
        await execFileAsync("git", ["-C", fixture.path, "merge-base", "--is-ancestor", remoteCommit, "HEAD"]);
        expect((await execFileAsync("git", ["-C", fixture.path, "log", "-1", "--format=%s"])).stdout.trim()).toBe("local conflicting change");
      }
      const expectedValue = strategy === "merge" ? "remote" : "local";
      expect((await readFile(filePath, "utf8")).replace(/\r\n/g, "\n")).toBe(`export const value = '${expectedValue}';\n`);
    } finally {
      await app?.close();
      app = undefined;
      await fixture.cleanup();
      await rm(bareRemotePath, { recursive: true, force: true });
      await rm(peerPath, { recursive: true, force: true });
      await rm(appDataPath, { recursive: true, force: true });
    }
  }

  it("keeps a rejected push local and allows a reviewed retry after the remote is restored", async () => {
    const fixture = await createTempGitRepository();
    const bareRemotePath = await mkdtemp(resolve(tmpdir(), "gitcrest-e2e-retry-remote-"));
    const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-push-retry-e2e-app-data-"));
    const filePath = resolve(fixture.path, "src/push-retry.ts");

    try {
      await mkdir(resolve(fixture.path, "src"), { recursive: true });
      await writeFile(filePath, "export const retry = 'base';\n");
      await execFileAsync("git", ["-C", fixture.path, "add", "src/push-retry.ts"]);
      await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-m", "add retry fixture"]);
      await execFileAsync("git", ["init", "--bare", "--quiet", bareRemotePath]);
      await execFileAsync("git", ["-C", fixture.path, "remote", "add", "origin", bareRemotePath]);
      await execFileAsync("git", ["-C", fixture.path, "push", "--quiet", "--set-upstream", "origin", "HEAD"]);
      const branch = (await execFileAsync("git", ["-C", fixture.path, "branch", "--show-current"])).stdout.trim();
      const originalRemoteHead = (await execFileAsync("git", ["-C", bareRemotePath, "rev-parse", `refs/heads/${branch}`])).stdout.trim();
      await writeFile(filePath, "export const retry = 'pending push';\n");
      await execFileAsync("git", ["-C", fixture.path, "add", "src/push-retry.ts"]);
      await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-m", "commit retained after failed push"]);
      const localHead = (await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD"])).stdout.trim();
      const unavailableRemotePath = resolve(bareRemotePath, "temporarily-unavailable.git");
      await execFileAsync("git", ["-C", fixture.path, "remote", "set-url", "origin", unavailableRemotePath]);

      app = await electron.launch({
        args: ["."],
        env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
      });
      const window = await app.firstWindow();
      await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
      await window.getByText("Core connected").waitFor({ timeout: 15_000 });
      const opened = await window.evaluate(async (repositoryPath) => {
        const connection = await (globalThis.window as unknown as Window & {
          gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
        }).gitcrest.getSidecarConnection();
        const response = await fetch(new URL("/api/v1/repositories", connection.baseUrl), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${connection.token}`,
            "X-GitCrest-API-Version": "1",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ path: repositoryPath }),
        });
        return response.status;
      }, fixture.path);
      expect(opened).toBe(200);

      await window.reload();
      await window.getByRole("heading", { name: "Recent repositories" }).waitFor();
      await window.locator(".repositoryRowOpen").click();
      await window.locator(".workspaceCrumb").waitFor();
      await window.getByRole("button", { name: "Workspace", exact: true }).click();
      await window.getByRole("button", { name: "Push", exact: true }).click();
      const pushDialog = window.getByRole("dialog", { name: "Push current branch" });
      await pushDialog.getByText(`origin/${branch}`, { exact: true }).waitFor();
      await pushDialog.getByRole("button", { name: "Push", exact: true }).click();

      const tasksDialog = window.getByRole("dialog", { name: "Tasks" });
      const failedPush = tasksDialog.locator(".taskCard").filter({ has: window.locator(".taskCardHeading strong", { hasText: "push" }) }).last();
      await failedPush.waitFor({ state: "visible" });
      await window.waitForFunction(() => {
        const card = [...document.querySelectorAll(".taskCard")].find((entry) => entry.querySelector(".taskCardHeading strong")?.textContent === "push");
        return Boolean(card && !["queued", "running"].includes(card.querySelector(".taskStatus")?.textContent || ""));
      }, undefined, { timeout: 20_000 });
      await failedPush.getByText("failed", { exact: true }).waitFor();
      expect((await execFileAsync("git", ["-C", bareRemotePath, "rev-parse", `refs/heads/${branch}`])).stdout.trim()).toBe(originalRemoteHead);

      await execFileAsync("git", ["init", "--bare", "--quiet", unavailableRemotePath]);
      await execFileAsync("git", ["-C", fixture.path, "push", "--quiet", unavailableRemotePath, `${originalRemoteHead}:refs/heads/${branch}`]);

      const previousPushTaskIds = await window.evaluate(async () => {
        const connection = await (globalThis.window as unknown as Window & {
          gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
        }).gitcrest.getSidecarConnection();
        const response = await fetch(new URL("/api/v1/tasks", connection.baseUrl), {
          headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1" },
        });
        const tasks = await response.json() as Array<{ taskId: string; operation: string }>;
        return tasks.filter((task) => task.operation.startsWith("push")).map((task) => task.taskId);
      });
      await failedPush.getByRole("button", { name: "Review and retry push" }).click();
      const retryDialog = window.getByRole("dialog", { name: "Push current branch" });
      await retryDialog.getByRole("button", { name: "Push", exact: true }).click();
      await expect.poll(async () => await window.evaluate(async (previousTaskIds) => {
        const connection = await (globalThis.window as unknown as Window & {
          gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
        }).gitcrest.getSidecarConnection();
        const response = await fetch(new URL("/api/v1/tasks", connection.baseUrl), {
          headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1" },
        });
        const tasks = await response.json() as Array<{ taskId: string; operation: string; status: string }>;
        return tasks.find((task) => task.operation.startsWith("push") && !previousTaskIds.includes(task.taskId))?.status;
      }, previousPushTaskIds), { timeout: 20_000 }).toBe("succeeded");
      expect((await execFileAsync("git", ["-C", unavailableRemotePath, "rev-parse", `refs/heads/${branch}`])).stdout.trim()).toBe(localHead);
      expect((await execFileAsync("git", ["-C", bareRemotePath, "rev-parse", `refs/heads/${branch}`])).stdout.trim()).toBe(originalRemoteHead);
    } finally {
      await app?.close();
      app = undefined;
      await fixture.cleanup();
      await rm(bareRemotePath, { recursive: true, force: true });
      await rm(appDataPath, { recursive: true, force: true });
    }
  }, 60_000);
});
