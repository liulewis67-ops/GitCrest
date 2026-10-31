import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { createTempGitRepository } from "../fixtures/temp-repo";

const execFileAsync = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim();

/** Calls the core's HTTP API from the renderer, the way the app itself does. */
async function core(window: Page, method: string, path: string, body?: unknown) {
  return window.evaluate(async ({ method, path, body }) => {
    const connection = await (globalThis.window as unknown as Window & {
      gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
    }).gitcrest.getSidecarConnection();
    const response = await fetch(new URL(path, connection.baseUrl), {
      method,
      headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => undefined) };
  }, { method, path, body });
}

describe("post-push pipeline E2E", () => {
  let app: ElectronApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  for (const mode of ["temporaryWorktree", "switchInPlace"] as const) {
    it(`merges a pushed branch into uat and dev in ${mode} mode`, async () => {
      const fixture = await createTempGitRepository();
      const remote = await mkdtemp(resolve(tmpdir(), "gitcrest-e2e-pipeline-remote-"));
      const appData = await mkdtemp(resolve(tmpdir(), "gitcrest-e2e-pipeline-data-"));

      try {
        await execFileAsync("git", ["init", "--bare", "--quiet", remote]);
        await writeFile(resolve(fixture.path, "base.txt"), "base\n");
        await git(fixture.path, "add", "base.txt");
        await git(fixture.path, "commit", "--quiet", "-m", "base");
        await git(fixture.path, "remote", "add", "origin", remote);
        await git(fixture.path, "branch", "uat");
        await git(fixture.path, "branch", "dev");
        await git(fixture.path, "checkout", "--quiet", "-b", "feature/1");
        await git(fixture.path, "push", "--quiet", "origin", "uat", "dev");
        await git(fixture.path, "push", "--quiet", "--set-upstream", "origin", "feature/1");
        await writeFile(resolve(fixture.path, "feature.txt"), "feature\n");
        await git(fixture.path, "add", "feature.txt");
        await git(fixture.path, "commit", "--quiet", "-m", "feature work");
        const featureHead = await git(fixture.path, "rev-parse", "HEAD");

        app = await electron.launch({
          args: [".", "--lang=en-US", "--disable-gpu"],
          env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appData, "gitcrest.sqlite") },
        });
        const window = await app.firstWindow();
        await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
        await window.getByText("Core connected").waitFor({ timeout: 40_000 });

        const opened = await core(window, "POST", "/api/v1/repositories", { path: fixture.path });
        expect(opened.status).toBe(200);
        const repoId = (opened.body as { repoId: string }).repoId;
        expect((await core(window, "PUT", "/api/v1/settings/pipelines", { executionMode: mode, inPlaceDirtyPolicy: "shelve" })).status).toBe(200);
        const rule = {
          ruleId: "r_01", name: "Promote feature", enabled: true,
          trigger: { kind: "afterPush", branchPattern: "feature/*" },
          targets: [{ branch: "uat", remote: "origin" }, { branch: "dev", remote: "origin" }],
          mergeMode: "noFastForward", commitMessageTemplate: "Merge branch '{source}' into {target}",
          pushAfterMerge: true, onConflict: "openResolver", afterConflictResolved: "continue", confirmation: "auto",
        };
        expect((await core(window, "PUT", `/api/v1/repositories/${repoId}/pipelines/rules`, { rules: [rule] })).status).toBe(200);

        await window.reload();
        await window.getByRole("heading", { name: "Recent repositories" }).waitFor();
        await window.locator(".repositoryRowOpen").click();
        await window.locator(".workspaceCrumb").waitFor();
        await window.getByRole("button", { name: "Push", exact: true }).click();
        const pushDialog = window.getByRole("dialog", { name: "Push current branch" });
        await pushDialog.getByText("origin/feature/1", { exact: true }).waitFor();
        await pushDialog.getByRole("button", { name: "Push", exact: true }).click();

        // The pipeline follows the push in the background; wait for its run to finish.
        let status = "";
        for (let attempt = 0; attempt < 120 && !["succeeded", "failed", "partiallySucceeded", "cancelled"].includes(status); attempt += 1) {
          await new Promise((done) => setTimeout(done, 500));
          const runs = await core(window, "GET", `/api/v1/repositories/${repoId}/pipelines/runs`);
          status = (runs.body as { runs: Array<{ status: string }> } | undefined)?.runs[0]?.status ?? "";
        }
        expect(status).toBe("succeeded");

        for (const target of ["uat", "dev"]) {
          expect(await git(remote, "log", "-1", "--format=%s", target)).toBe(`Merge branch 'feature/1' into ${target}`);
          expect(await git(remote, "merge-base", "--is-ancestor", featureHead, target).then(() => "yes", () => "no")).toBe("yes");
        }
        expect(await git(fixture.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feature/1");

        // The run is visible in the Task Center.
        const tasks = window.getByRole("dialog", { name: "Tasks" });
        // Pushing already opened the Task Center; open it only when it is closed.
        if ((await tasks.count()) === 0) await window.getByRole("button", { name: /^Background tasks/ }).click();
        const row = tasks.getByRole("article", { name: "Promote feature" });
        await row.waitFor({ timeout: 10_000 });
        await expect(row.innerText()).resolves.toContain("feature/1 → uat ✓ → dev ✓");
      } finally {
        await app?.close();
        app = undefined;
        await fixture.cleanup();
        await rm(remote, { recursive: true, force: true });
        await rm(appData, { recursive: true, force: true });
      }
    }, 120_000);
  }
});
