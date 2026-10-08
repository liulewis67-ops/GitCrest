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

  it("blocks pull while preserving uncommitted worktree changes", async () => {
    const fixture = await createTempGitRepository();
    const bareRemotePath = await mkdtemp(resolve(tmpdir(), "gitcrest-e2e-dirty-pull-remote-"));
    const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-dirty-pull-e2e-app-data-"));
    const filePath = resolve(fixture.path, "src/dirty-pull.ts");

    try {
      await mkdir(resolve(fixture.path, "src"), { recursive: true });
      await writeFile(filePath, "export const state = 'committed baseline';\n");
      await execFileAsync("git", ["-C", fixture.path, "add", "src/dirty-pull.ts"]);
      await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-m", "add dirty pull fixture"]);
      await execFileAsync("git", ["init", "--bare", "--quiet", bareRemotePath]);
      await execFileAsync("git", ["-C", fixture.path, "remote", "add", "origin", bareRemotePath]);
      await execFileAsync("git", ["-C", fixture.path, "push", "--quiet", "--set-upstream", "origin", "HEAD"]);
      const branch = (await execFileAsync("git", ["-C", fixture.path, "branch", "--show-current"])).stdout.trim();
      const baselineHead = (await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD"])).stdout.trim();
      const baselineTracking = (await execFileAsync("git", ["-C", fixture.path, "rev-parse", `refs/remotes/origin/${branch}`])).stdout.trim();
      const localEdit = "export const state = 'keep my uncommitted edit';\n";
      await writeFile(filePath, localEdit);

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
      await window.getByRole("button", { name: "Pull", exact: true }).click();

      const pullDialog = window.getByRole("dialog", { name: "Pull current branch" });
      await pullDialog.getByText("Resolve the worktree state before pulling.").waitFor();
      await pullDialog.getByRole("region", { name: "Local changes blocking pull" }).getByText("src/dirty-pull.ts").waitFor();
      expect(await pullDialog.getByRole("button", { name: "Pull with merge" }).isEnabled()).toBe(false);
      await pullDialog.getByLabel("Rebase").check();
      expect(await pullDialog.getByRole("button", { name: "Pull with rebase" }).isEnabled()).toBe(false);
      await pullDialog.getByRole("button", { name: "Cancel" }).click();

      expect((await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD"])).stdout.trim()).toBe(baselineHead);
      expect((await execFileAsync("git", ["-C", fixture.path, "rev-parse", `refs/remotes/origin/${branch}`])).stdout.trim()).toBe(baselineTracking);
      expect((await readFile(filePath, "utf8")).replace(/\r\n/g, "\n")).toBe(localEdit);
    } finally {
      await app?.close();
      app = undefined;
      await fixture.cleanup();
      await rm(bareRemotePath, { recursive: true, force: true });
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

  it("cancels an active fetch and a queued pull before repository state changes", async () => {
    const fixture = await createTempGitRepository();
    const bareRemotePath = await mkdtemp(resolve(tmpdir(), "gitcrest-e2e-fetch-cancel-remote-"));
    const peerPath = await mkdtemp(resolve(tmpdir(), "gitcrest-e2e-fetch-cancel-peer-"));
    const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-fetch-cancel-app-data-"));
    const markerPath = resolve(appDataPath, "reference-transaction-prepared.txt");
    const filePath = resolve(fixture.path, "src/fetch-cancel.ts");

    try {
      await mkdir(resolve(fixture.path, "src"), { recursive: true });
      await writeFile(filePath, "export const fetched = 'base';\n");
      await execFileAsync("git", ["-C", fixture.path, "add", "src/fetch-cancel.ts"]);
      await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-m", "add fetch cancellation fixture"]);
      await execFileAsync("git", ["init", "--bare", "--quiet", bareRemotePath]);
      await execFileAsync("git", ["-C", fixture.path, "remote", "add", "origin", bareRemotePath]);
      await execFileAsync("git", ["-C", fixture.path, "push", "--quiet", "--set-upstream", "origin", "HEAD"]);
      const branch = (await execFileAsync("git", ["-C", fixture.path, "branch", "--show-current"])).stdout.trim();
      const baselineHead = (await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD"])).stdout.trim();
      await execFileAsync("git", ["clone", "--quiet", bareRemotePath, peerPath]);
      await execFileAsync("git", ["-C", peerPath, "config", "user.name", "GitCrest Peer Test"]);
      await execFileAsync("git", ["-C", peerPath, "config", "user.email", "gitcrest-peer@example.invalid"]);
      await writeFile(resolve(peerPath, "src/fetch-cancel.ts"), "export const fetched = 'remote';\n");
      await execFileAsync("git", ["-C", peerPath, "add", "src/fetch-cancel.ts"]);
      await execFileAsync("git", ["-C", peerPath, "commit", "--quiet", "-m", "remote change for cancelled fetch"]);
      await execFileAsync("git", ["-C", peerPath, "push", "--quiet", "origin", "HEAD"]);

      const hookDirectory = resolve(fixture.path, ".git", "gitcrest-hooks");
      await mkdir(hookDirectory, { recursive: true });
      const shellMarkerPath = markerPath.replace(/\\/g, "/").replace(/'/g, "'\\''");
      await writeFile(resolve(hookDirectory, "reference-transaction"), `#!/bin/sh\nif [ "$1" = "prepared" ]; then\n  printf prepared > '${shellMarkerPath}'\n  sleep 30\nfi\n`, "utf8");
      await execFileAsync("git", ["-C", fixture.path, "config", "core.hooksPath", hookDirectory]);

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
      await expect.poll(async () => await readFile(markerPath, "utf8").catch(() => ""), { timeout: 20_000 }).toBe("prepared");

      const queuedPull = await window.evaluate(async (repositoryPath) => {
        const connection = await (globalThis.window as unknown as Window & {
          gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
        }).gitcrest.getSidecarConnection();
        const headers = { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1", "Content-Type": "application/json" };
        const repositoriesResponse = await fetch(new URL("/api/v1/repositories", connection.baseUrl), { headers });
        const repositories = await repositoriesResponse.json() as Array<{ repoId: string; path: string }>;
        const repository = repositories.find((entry) => entry.path === repositoryPath);
        if (!repository) throw new Error("The test repository was not registered.");
        const preflightResponse = await fetch(new URL(`/api/v1/repositories/${encodeURIComponent(repository.repoId)}/pull-preflight`, connection.baseUrl), { headers });
        const preflight = await preflightResponse.json() as { localOid: string; trackingOid: string };
        const response = await fetch(new URL(`/api/v1/repositories/${encodeURIComponent(repository.repoId)}/pull`, connection.baseUrl), {
          method: "POST",
          headers,
          body: JSON.stringify({ expectedLocalOid: preflight.localOid, expectedTrackingOid: preflight.trackingOid, strategy: "merge" }),
        });
        const task = await response.json() as { taskId: string; operation: string; status: string };
        return { status: response.status, task };
      }, fixture.path);
      expect(queuedPull.status).toBe(202);
      expect(queuedPull.task.operation).toBe("pullMerge");

      await tasksDialog.getByRole("button", { name: "Refresh" }).click();
      const pullTask = tasksDialog.locator(".taskCard").filter({ has: window.locator(".taskCardHeading strong", { hasText: "pullMerge" }) }).last();
      await pullTask.waitFor({ state: "visible" });
      await pullTask.getByText("queued", { exact: true }).waitFor();
      await pullTask.getByRole("button", { name: "Cancel task" }).click();
      await pullTask.getByText("cancelled", { exact: true }).waitFor({ timeout: 20_000 });

      await fetchTask.getByRole("button", { name: "Cancel task" }).click();
      await fetchTask.getByText("cancelled", { exact: true }).waitFor({ timeout: 20_000 });

      expect((await execFileAsync("git", ["-C", fixture.path, "rev-parse", `refs/remotes/origin/${branch}`])).stdout.trim()).toBe(baselineHead);
      expect((await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD"])).stdout.trim()).toBe(baselineHead);
    } finally {
      await app?.close();
      app = undefined;
      await fixture.cleanup();
      await rm(bareRemotePath, { recursive: true, force: true });
      await rm(peerPath, { recursive: true, force: true });
      await rm(appDataPath, { recursive: true, force: true });
    }
  }, 60_000);

  it("safely rolls back an interrupted pull merge before reporting cancellation", async () => {
    const fixture = await createTempGitRepository();
    const bareRemotePath = await mkdtemp(resolve(tmpdir(), "gitcrest-e2e-pull-cancel-remote-"));
    const peerPath = await mkdtemp(resolve(tmpdir(), "gitcrest-e2e-pull-cancel-peer-"));
    const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-pull-cancel-app-data-"));
    const markerPath = resolve(appDataPath, "pre-merge-commit-started.txt");
    const localFile = resolve(fixture.path, "src/local-before-pull.ts");
    const remoteFile = resolve(fixture.path, "src/remote-before-pull.ts");

    try {
      await mkdir(resolve(fixture.path, "src"), { recursive: true });
      await writeFile(resolve(fixture.path, "src/pull-cancel-base.ts"), "export const base = true;\n");
      await execFileAsync("git", ["-C", fixture.path, "add", "src/pull-cancel-base.ts"]);
      await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-m", "add pull cancellation fixture"]);
      await execFileAsync("git", ["init", "--bare", "--quiet", bareRemotePath]);
      await execFileAsync("git", ["-C", fixture.path, "remote", "add", "origin", bareRemotePath]);
      await execFileAsync("git", ["-C", fixture.path, "push", "--quiet", "--set-upstream", "origin", "HEAD"]);
      await execFileAsync("git", ["clone", "--quiet", bareRemotePath, peerPath]);
      await execFileAsync("git", ["-C", peerPath, "config", "user.name", "GitCrest Peer Test"]);
      await execFileAsync("git", ["-C", peerPath, "config", "user.email", "gitcrest-peer@example.invalid"]);

      await writeFile(localFile, "export const local = 'retain after pull cancel';\n");
      await execFileAsync("git", ["-C", fixture.path, "add", "src/local-before-pull.ts"]);
      await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-m", "local commit before pull"]);
      const localHead = (await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD"])).stdout.trim();

      await writeFile(resolve(peerPath, "src/remote-before-pull.ts"), "export const remote = 'retain after pull cancel';\n");
      await execFileAsync("git", ["-C", peerPath, "add", "src/remote-before-pull.ts"]);
      await execFileAsync("git", ["-C", peerPath, "commit", "--quiet", "-m", "remote commit before pull"]);
      await execFileAsync("git", ["-C", peerPath, "push", "--quiet", "origin", "HEAD"]);
      const remoteHead = (await execFileAsync("git", ["-C", peerPath, "rev-parse", "HEAD"])).stdout.trim();
      await execFileAsync("git", ["-C", fixture.path, "fetch", "--quiet", "origin"]);

      const hookDirectory = resolve(fixture.path, ".git", "gitcrest-hooks");
      await mkdir(hookDirectory, { recursive: true });
      const shellMarkerPath = markerPath.replace(/\\/g, "/").replace(/'/g, "'\\''");
      await writeFile(resolve(hookDirectory, "pre-merge-commit"), `#!/bin/sh\nprintf started > '${shellMarkerPath}'\nsleep 30\n`, "utf8");
      await execFileAsync("git", ["-C", fixture.path, "config", "core.hooksPath", hookDirectory]);

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
      await window.getByRole("button", { name: "Pull", exact: true }).click();
      const pullDialog = window.getByRole("dialog", { name: "Pull current branch" });
      await pullDialog.locator(".pushTarget small").filter({ hasText: "1 ahead · 1 behind" }).waitFor();
      await pullDialog.getByRole("button", { name: "Pull with merge" }).click();

      const tasksDialog = window.getByRole("dialog", { name: "Tasks" });
      const pullTask = tasksDialog.locator(".taskCard").filter({ has: window.locator(".taskCardHeading strong", { hasText: "pullMerge" }) }).last();
      await pullTask.waitFor({ state: "visible" });
      await expect.poll(async () => await readFile(markerPath, "utf8").catch(() => ""), { timeout: 20_000 }).toBe("started");
      await writeFile(localFile, "export const local = 'concurrent user edit preserved';\n");
      await pullTask.getByRole("button", { name: "Cancel task" }).click();
      try {
        await pullTask.getByText("cancelled", { exact: true }).waitFor({ timeout: 20_000 });
      } catch {
        const taskState = await pullTask.innerText();
        const indexTree = await execFileAsync("git", ["-C", fixture.path, "write-tree"]).then(({ stdout }) => stdout.trim()).catch((error: unknown) => String(error));
        const expectedMergeTree = await execFileAsync("git", ["-C", fixture.path, "merge-tree", "--write-tree", localHead, remoteHead]).then(({ stdout }) => stdout.trim()).catch((error: unknown) => String(error));
        throw new Error(`Pull did not cancel cleanly. Task: ${taskState}. Index tree: ${indexTree}. Expected merge tree: ${expectedMergeTree}`);
      }

      expect((await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD"])).stdout.trim()).toBe(localHead);
      expect((await execFileAsync("git", ["-C", fixture.path, "diff", "--cached", "--name-only"])).stdout.trim()).toBe("");
      expect((await execFileAsync("git", ["-C", fixture.path, "rev-parse", `refs/remotes/origin/${(await execFileAsync("git", ["-C", fixture.path, "branch", "--show-current"])).stdout.trim()}`])).stdout.trim()).toBe(remoteHead);
      expect((await readFile(localFile, "utf8")).replace(/\r\n/g, "\n")).toBe("export const local = 'concurrent user edit preserved';\n");
      await expect(readFile(remoteFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await app?.close();
      app = undefined;
      await fixture.cleanup();
      await rm(bareRemotePath, { recursive: true, force: true });
      await rm(peerPath, { recursive: true, force: true });
      await rm(appDataPath, { recursive: true, force: true });
    }
  }, 90_000);

  it("resolves a pull merge conflict from the waiting task and completes the merge", async () => runPullConflictRecovery("merge"), 90_000);

  it("resolves a pull rebase conflict from the waiting task and completes the rebase", async () => runPullConflictRecovery("rebase"), 90_000);

  it("cancels a pull rebase before replay changes repository state", async () => {
    const fixture = await createTempGitRepository();
    const bareRemotePath = await mkdtemp(resolve(tmpdir(), "gitcrest-e2e-pull-rebase-cancel-remote-"));
    const peerPath = await mkdtemp(resolve(tmpdir(), "gitcrest-e2e-pull-rebase-cancel-peer-"));
    const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-pull-rebase-cancel-app-data-"));
    const markerPath = resolve(appDataPath, "pre-rebase-started.txt");

    try {
      await mkdir(resolve(fixture.path, "src"), { recursive: true });
      await writeFile(resolve(fixture.path, "src/rebase-cancel-base.ts"), "export const base = true;\n");
      await execFileAsync("git", ["-C", fixture.path, "add", "src/rebase-cancel-base.ts"]);
      await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-m", "add rebase cancellation fixture"]);
      await execFileAsync("git", ["init", "--bare", "--quiet", bareRemotePath]);
      await execFileAsync("git", ["-C", fixture.path, "remote", "add", "origin", bareRemotePath]);
      await execFileAsync("git", ["-C", fixture.path, "push", "--quiet", "--set-upstream", "origin", "HEAD"]);
      await execFileAsync("git", ["clone", "--quiet", bareRemotePath, peerPath]);
      await execFileAsync("git", ["-C", peerPath, "config", "user.name", "GitCrest Peer Test"]);
      await execFileAsync("git", ["-C", peerPath, "config", "user.email", "gitcrest-peer@example.invalid"]);

      await writeFile(resolve(fixture.path, "src/local-rebase-only.ts"), "export const local = true;\n");
      await execFileAsync("git", ["-C", fixture.path, "add", "src/local-rebase-only.ts"]);
      await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-m", "local commit before rebase pull"]);
      const localHead = (await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD"])).stdout.trim();

      await writeFile(resolve(peerPath, "src/remote-rebase-only.ts"), "export const remote = true;\n");
      await execFileAsync("git", ["-C", peerPath, "add", "src/remote-rebase-only.ts"]);
      await execFileAsync("git", ["-C", peerPath, "commit", "--quiet", "-m", "remote commit before rebase pull"]);
      await execFileAsync("git", ["-C", peerPath, "push", "--quiet", "origin", "HEAD"]);
      const remoteHead = (await execFileAsync("git", ["-C", peerPath, "rev-parse", "HEAD"])).stdout.trim();
      await execFileAsync("git", ["-C", fixture.path, "fetch", "--quiet", "origin"]);

      const hookDirectory = resolve(fixture.path, ".git", "gitcrest-hooks");
      await mkdir(hookDirectory, { recursive: true });
      const shellMarkerPath = markerPath.replace(/\\/g, "/").replace(/'/g, "'\\''");
      await writeFile(resolve(hookDirectory, "pre-rebase"), `#!/bin/sh\nprintf started > '${shellMarkerPath}'\nsleep 30\n`, "utf8");
      await execFileAsync("git", ["-C", fixture.path, "config", "core.hooksPath", hookDirectory]);

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
      await window.getByRole("button", { name: "Pull", exact: true }).click();
      const pullDialog = window.getByRole("dialog", { name: "Pull current branch" });
      await pullDialog.locator(".pushTarget small").filter({ hasText: "1 ahead · 1 behind" }).waitFor();
      await pullDialog.locator('input[name="pull-strategy"][value="rebase"]').check();
      await pullDialog.getByRole("button", { name: "Pull with rebase" }).click();

      const tasksDialog = window.getByRole("dialog", { name: "Tasks" });
      const pullTask = tasksDialog.locator(".taskCard").filter({ has: window.locator(".taskCardHeading strong", { hasText: "pullRebase" }) }).last();
      await pullTask.waitFor({ state: "visible" });
      await expect.poll(async () => await readFile(markerPath, "utf8").catch(() => ""), { timeout: 20_000 }).toBe("started");
      await pullTask.getByRole("button", { name: "Cancel task" }).click();
      await pullTask.getByText("cancelled", { exact: true }).waitFor({ timeout: 20_000 });

      expect((await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD"])).stdout.trim()).toBe(localHead);
      expect((await execFileAsync("git", ["-C", fixture.path, "rev-parse", "refs/remotes/origin/" + (await execFileAsync("git", ["-C", fixture.path, "branch", "--show-current"])).stdout.trim()])).stdout.trim()).toBe(remoteHead);
      expect((await execFileAsync("git", ["-C", fixture.path, "status", "--porcelain"])).stdout.trim()).toBe("");
    } finally {
      await app?.close();
      app = undefined;
      await fixture.cleanup();
      await rm(bareRemotePath, { recursive: true, force: true });
      await rm(peerPath, { recursive: true, force: true });
      await rm(appDataPath, { recursive: true, force: true });
    }
  }, 90_000);

  it("aborts a pull rebase safely when cancellation interrupts a replayed commit", async () => {
    const fixture = await createTempGitRepository();
    const bareRemotePath = await mkdtemp(resolve(tmpdir(), "gitcrest-e2e-pull-rebase-abort-remote-"));
    const peerPath = await mkdtemp(resolve(tmpdir(), "gitcrest-e2e-pull-rebase-abort-peer-"));
    const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-pull-rebase-abort-app-data-"));
    const markerPath = resolve(appDataPath, "post-applypatch-started.txt");

    try {
      await mkdir(resolve(fixture.path, "src"), { recursive: true });
      await writeFile(resolve(fixture.path, "src/rebase-abort-base.ts"), "export const base = true;\n");
      await execFileAsync("git", ["-C", fixture.path, "add", "src/rebase-abort-base.ts"]);
      await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-m", "add rebase abort fixture"]);
      await execFileAsync("git", ["init", "--bare", "--quiet", bareRemotePath]);
      await execFileAsync("git", ["-C", fixture.path, "remote", "add", "origin", bareRemotePath]);
      await execFileAsync("git", ["-C", fixture.path, "push", "--quiet", "--set-upstream", "origin", "HEAD"]);
      await execFileAsync("git", ["clone", "--quiet", bareRemotePath, peerPath]);
      await execFileAsync("git", ["-C", peerPath, "config", "user.name", "GitCrest Peer Test"]);
      await execFileAsync("git", ["-C", peerPath, "config", "user.email", "gitcrest-peer@example.invalid"]);
      await execFileAsync("git", ["-C", fixture.path, "config", "rebase.backend", "apply"]);

      await writeFile(resolve(fixture.path, "src/local-replayed.ts"), "export const local = true;\n");
      await execFileAsync("git", ["-C", fixture.path, "add", "src/local-replayed.ts"]);
      await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-m", "local commit to replay"]);
      const localHead = (await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD"])).stdout.trim();

      await writeFile(resolve(peerPath, "src/remote-replayed.ts"), "export const remote = true;\n");
      await execFileAsync("git", ["-C", peerPath, "add", "src/remote-replayed.ts"]);
      await execFileAsync("git", ["-C", peerPath, "commit", "--quiet", "-m", "remote commit before rebase"]);
      await execFileAsync("git", ["-C", peerPath, "push", "--quiet", "origin", "HEAD"]);
      const remoteHead = (await execFileAsync("git", ["-C", peerPath, "rev-parse", "HEAD"])).stdout.trim();
      await execFileAsync("git", ["-C", fixture.path, "fetch", "--quiet", "origin"]);

      const hookDirectory = resolve(fixture.path, ".git", "gitcrest-hooks");
      await mkdir(hookDirectory, { recursive: true });
      const shellMarkerPath = markerPath.replace(/\\/g, "/").replace(/'/g, "'\\''");
      await writeFile(resolve(hookDirectory, "post-applypatch"), `#!/bin/sh\nprintf started > '${shellMarkerPath}'\nsleep 30\n`, "utf8");
      await execFileAsync("git", ["-C", fixture.path, "config", "core.hooksPath", hookDirectory]);

      app = await electron.launch({
        args: ["."],
        env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
      });
      const window = await app.firstWindow();
      await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
      await window.getByText("Core connected").waitFor({ timeout: 15_000 });
      const connection = await window.evaluate(async () => await (globalThis.window as unknown as Window & {
        gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
      }).gitcrest.getSidecarConnection());
      const headers = { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1", "Content-Type": "application/json" };
      const opened = await fetch(new URL("/api/v1/repositories", connection.baseUrl), {
        method: "POST", headers, body: JSON.stringify({ path: fixture.path }),
      });
      expect(opened.status).toBe(200);
      const repositoriesResponse = await fetch(new URL("/api/v1/repositories", connection.baseUrl), { headers });
      const repositories = await repositoriesResponse.json() as Array<{ repoId: string; path: string }>;
      const repository = repositories.find((entry) => entry.path === fixture.path);
      expect(repository).toBeDefined();
      const preflightResponse = await fetch(new URL(`/api/v1/repositories/${encodeURIComponent(repository!.repoId)}/pull-preflight`, connection.baseUrl), { headers });
      const preflight = await preflightResponse.json() as { localOid: string; trackingOid: string };
      const pullResponse = await fetch(new URL(`/api/v1/repositories/${encodeURIComponent(repository!.repoId)}/pull`, connection.baseUrl), {
        method: "POST", headers, body: JSON.stringify({ expectedLocalOid: preflight.localOid, expectedTrackingOid: preflight.trackingOid, strategy: "rebase" }),
      });
      expect(pullResponse.status).toBe(202);
      const pullTask = await pullResponse.json() as { taskId: string; status: string };

      await expect.poll(async () => await readFile(markerPath, "utf8").catch(() => ""), { timeout: 20_000 }).toBe("started");
      await writeFile(resolve(fixture.path, "src/rebase-abort-base.ts"), "export const base = 'concurrent edit preserved';\n");
      await fetch(new URL(`/api/v1/tasks/${encodeURIComponent(pullTask.taskId)}/cancel`, connection.baseUrl), { method: "POST", headers });
      await expect.poll(async () => {
        const response = await fetch(new URL("/api/v1/tasks", connection.baseUrl), { headers });
        const tasks = await response.json() as Array<{ taskId: string; status: string }>;
        return tasks.find((task) => task.taskId === pullTask.taskId)?.status;
      }, { timeout: 20_000 }).toBe("cancelled");

      expect((await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD"])).stdout.trim()).toBe(localHead);
      expect((await execFileAsync("git", ["-C", fixture.path, "rev-parse", "refs/remotes/origin/" + (await execFileAsync("git", ["-C", fixture.path, "branch", "--show-current"])).stdout.trim()])).stdout.trim()).toBe(remoteHead);
      expect((await readFile(resolve(fixture.path, "src/rebase-abort-base.ts"), "utf8")).replace(/\r\n/g, "\n")).toBe("export const base = 'concurrent edit preserved';\n");
    } finally {
      await app?.close();
      app = undefined;
      await fixture.cleanup();
      await rm(bareRemotePath, { recursive: true, force: true });
      await rm(peerPath, { recursive: true, force: true });
      await rm(appDataPath, { recursive: true, force: true });
    }
  }, 120_000);

  it("aborts a pull rebase safely after replay with the merge backend", async () => {
    const fixture = await createTempGitRepository();
    const bareRemotePath = await mkdtemp(resolve(tmpdir(), "gitcrest-e2e-pull-rebase-merge-backend-remote-"));
    const peerPath = await mkdtemp(resolve(tmpdir(), "gitcrest-e2e-pull-rebase-merge-backend-peer-"));
    const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-pull-rebase-merge-backend-app-data-"));
    const markerPath = resolve(appDataPath, "post-commit-started.txt");

    try {
      await mkdir(resolve(fixture.path, "src"), { recursive: true });
      await writeFile(resolve(fixture.path, "src/rebase-merge-base.ts"), "export const base = true;\n");
      await execFileAsync("git", ["-C", fixture.path, "add", "src/rebase-merge-base.ts"]);
      await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-m", "add merge backend rebase fixture"]);
      await execFileAsync("git", ["init", "--bare", "--quiet", bareRemotePath]);
      await execFileAsync("git", ["-C", fixture.path, "remote", "add", "origin", bareRemotePath]);
      await execFileAsync("git", ["-C", fixture.path, "push", "--quiet", "--set-upstream", "origin", "HEAD"]);
      await execFileAsync("git", ["clone", "--quiet", bareRemotePath, peerPath]);
      await execFileAsync("git", ["-C", peerPath, "config", "user.name", "GitCrest Peer Test"]);
      await execFileAsync("git", ["-C", peerPath, "config", "user.email", "gitcrest-peer@example.invalid"]);
      await execFileAsync("git", ["-C", fixture.path, "config", "rebase.backend", "merge"]);

      await writeFile(resolve(fixture.path, "src/local-merge-replayed.ts"), "export const local = true;\n");
      await execFileAsync("git", ["-C", fixture.path, "add", "src/local-merge-replayed.ts"]);
      await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-m", "local commit to replay"]);
      const localHead = (await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD"])).stdout.trim();

      await writeFile(resolve(peerPath, "src/remote-merge-replayed.ts"), "export const remote = true;\n");
      await execFileAsync("git", ["-C", peerPath, "add", "src/remote-merge-replayed.ts"]);
      await execFileAsync("git", ["-C", peerPath, "commit", "--quiet", "-m", "remote commit before rebase"]);
      await execFileAsync("git", ["-C", peerPath, "push", "--quiet", "origin", "HEAD"]);
      const remoteHead = (await execFileAsync("git", ["-C", peerPath, "rev-parse", "HEAD"])).stdout.trim();
      await execFileAsync("git", ["-C", fixture.path, "fetch", "--quiet", "origin"]);

      const hookDirectory = resolve(fixture.path, ".git", "gitcrest-hooks");
      await mkdir(hookDirectory, { recursive: true });
      const shellMarkerPath = markerPath.replace(/\\/g, "/").replace(/'/g, "'\\''");
      await writeFile(resolve(hookDirectory, "post-commit"), `#!/bin/sh\nprintf started > '${shellMarkerPath}'\nsleep 30\n`, "utf8");
      await execFileAsync("git", ["-C", fixture.path, "config", "core.hooksPath", hookDirectory]);

      app = await electron.launch({
        args: ["."],
        env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
      });
      const window = await app.firstWindow();
      await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
      await window.getByText("Core connected").waitFor({ timeout: 15_000 });
      const connection = await window.evaluate(async () => await (globalThis.window as unknown as Window & {
        gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
      }).gitcrest.getSidecarConnection());
      const headers = { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1", "Content-Type": "application/json" };
      const opened = await fetch(new URL("/api/v1/repositories", connection.baseUrl), {
        method: "POST", headers, body: JSON.stringify({ path: fixture.path }),
      });
      expect(opened.status).toBe(200);
      const repositoriesResponse = await fetch(new URL("/api/v1/repositories", connection.baseUrl), { headers });
      const repositories = await repositoriesResponse.json() as Array<{ repoId: string; path: string }>;
      const repository = repositories.find((entry) => entry.path === fixture.path);
      expect(repository).toBeDefined();
      const preflightResponse = await fetch(new URL(`/api/v1/repositories/${encodeURIComponent(repository!.repoId)}/pull-preflight`, connection.baseUrl), { headers });
      const preflight = await preflightResponse.json() as { localOid: string; trackingOid: string };
      const pullResponse = await fetch(new URL(`/api/v1/repositories/${encodeURIComponent(repository!.repoId)}/pull`, connection.baseUrl), {
        method: "POST", headers, body: JSON.stringify({ expectedLocalOid: preflight.localOid, expectedTrackingOid: preflight.trackingOid, strategy: "rebase" }),
      });
      expect(pullResponse.status).toBe(202);
      const pullTask = await pullResponse.json() as { taskId: string; status: string };

      await expect.poll(async () => await readFile(markerPath, "utf8").catch(() => ""), { timeout: 20_000 }).toBe("started");
      const statusBeforeCancel = (await execFileAsync("git", ["-C", fixture.path, "status", "--porcelain=v1", "--untracked-files=all"])).stdout.trim();
      await fetch(new URL(`/api/v1/tasks/${encodeURIComponent(pullTask.taskId)}/cancel`, connection.baseUrl), { method: "POST", headers });
      await expect.poll(async () => {
        const response = await fetch(new URL("/api/v1/tasks", connection.baseUrl), { headers });
        const tasks = await response.json() as Array<{ taskId: string; status: string; message: string; logs: string[] }>;
        return tasks.find((task) => task.taskId === pullTask.taskId);
      }, { timeout: 3_000 }).toMatchObject({ status: "cancelled" }).catch(async () => {
        const response = await fetch(new URL("/api/v1/tasks", connection.baseUrl), { headers });
        const tasks = await response.json() as Array<{ taskId: string; status: string; message: string; logs: string[] }>;
        throw new Error(`Pull cancellation recovery failed; pre-cancel status=${JSON.stringify(statusBeforeCancel)}; task=${JSON.stringify(tasks.find((task) => task.taskId === pullTask.taskId))}`);
      });

      expect((await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD"])).stdout.trim()).toBe(localHead);
      expect((await execFileAsync("git", ["-C", fixture.path, "rev-parse", "refs/remotes/origin/" + (await execFileAsync("git", ["-C", fixture.path, "branch", "--show-current"])).stdout.trim()])).stdout.trim()).toBe(remoteHead);
      expect((await execFileAsync("git", ["-C", fixture.path, "status", "--porcelain"])).stdout.trim()).toBe("");
    } finally {
      await app?.close();
      app = undefined;
      await fixture.cleanup();
      await rm(bareRemotePath, { recursive: true, force: true });
      await rm(peerPath, { recursive: true, force: true });
      await rm(appDataPath, { recursive: true, force: true });
    }
  }, 120_000);

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
