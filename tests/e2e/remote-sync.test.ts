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
});
