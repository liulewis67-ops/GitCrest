import { openTaskDetails } from "./task-details";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
        await window.locator(".workspaceToolbar").waitFor();
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
        const tasks = await openTaskDetails(window);
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

  it("stops an in-flight hook when the app closes and does not replay it after restart", async () => {
    const fixture = await createTempGitRepository();
    const appData = await mkdtemp(resolve(tmpdir(), "gitcrest-pipeline-shutdown-e2e-"));
    const progressPath = resolve(appData, "progress");
    const childPidPath = resolve(appData, "child.pid");
    const progress = () => readFile(progressPath, "utf8").catch(() => "");
    const stopLeakedChild = async () => {
      const before = await progress();
      await new Promise((done) => setTimeout(done, 300));
      if (before === await progress()) return;
      const pid = (await readFile(childPidPath, "utf8")).trim();
      if (!/^\d+$/.test(pid)) throw new Error("The fixture child PID is invalid");
      if (process.platform === "win32") await execFileAsync("taskkill.exe", ["/PID", pid, "/T", "/F"], { windowsHide: true }).catch(() => undefined);
      else process.kill(Number(pid), "SIGTERM");
    };
    const launch = async () => {
      app = await electron.launch({ args: [".", "--lang=en-US", "--disable-gpu"], env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appData, "gitcrest.sqlite") } });
      const window = await app.firstWindow();
      await window.getByText("Core connected").waitFor({ timeout: 40_000 });
      return window;
    };
    try {
      await writeFile(resolve(fixture.path, "base.txt"), "base\n");
      await git(fixture.path, "add", "base.txt");
      await git(fixture.path, "commit", "--quiet", "-m", "base");
      const branch = await git(fixture.path, "branch", "--show-current");
      const oid = await git(fixture.path, "rev-parse", "HEAD");
      let program: string;
      let args: string[];
      if (process.platform === "win32") {
        await writeFile(resolve(appData, "child.ps1"), "while ($true) { Add-Content -LiteralPath (Join-Path $PSScriptRoot 'progress') -Value 'tick'; Start-Sleep -Milliseconds 50 }\n");
        await writeFile(resolve(appData, "parent.ps1"), [
          "$ErrorActionPreference = 'Stop'", "$info = New-Object System.Diagnostics.ProcessStartInfo",
          "$info.FileName = Join-Path $PSHOME 'powershell.exe'", "$info.Arguments = '-NoProfile -NonInteractive -File child.ps1'",
          "$info.WorkingDirectory = $PSScriptRoot", "$info.UseShellExecute = $false", "$info.CreateNoWindow = $true",
          "$child = [System.Diagnostics.Process]::Start($info)", "Set-Content -LiteralPath (Join-Path $PSScriptRoot 'child.pid') -Value $child.Id", "$child.WaitForExit()",
        ].join("\n"));
        program = "powershell.exe"; args = ["-NoProfile", "-NonInteractive", "-File", resolve(appData, "parent.ps1")];
      } else {
        await writeFile(resolve(appData, "child.sh"), "while :; do echo tick >>progress; sleep 0.05; done\n");
        await writeFile(resolve(appData, "parent.sh"), "cd -- \"$(dirname -- \"$0\")\" || exit 1\nsh child.sh &\necho $! >child.pid\nwait\n");
        program = "sh"; args = [resolve(appData, "parent.sh")];
      }
      const window = await launch();
      const opened = await core(window, "POST", "/api/v1/repositories", { path: fixture.path });
      expect(opened.status).toBe(200);
      const repo = (opened.body as { repoId: string }).repoId;
      const rule = { ruleId: "r_shutdown", name: "Shutdown writer", enabled: true, trigger: { kind: "afterCommit", branchPattern: "*" }, targets: [], commands: [{ program, args, timeoutSeconds: 60 }], mergeMode: "noFastForward", commitMessageTemplate: "merge", pushAfterMerge: false, onConflict: "openResolver", afterConflictResolved: "continue", confirmation: "auto" };
      expect((await core(window, "PUT", `/api/v1/repositories/${repo}/pipelines/rules`, { rules: [rule] })).status).toBe(200);
      expect((await core(window, "POST", `/api/v1/repositories/${repo}/pipelines/runs`, { ruleId: "r_shutdown", sourceBranch: branch, sourceOid: oid })).status).toBe(202);
      await expect.poll(async () => (await progress()).length, { timeout: 20_000 }).toBeGreaterThan(0);
      await app!.close(); app = undefined;
      const stopped = await progress();
      await new Promise((done) => setTimeout(done, 500));
      const after = await progress();
      if (after !== stopped) await stopLeakedChild();
      expect(after).toBe(stopped);
      const reopened = await launch();
      const runs = (await core(reopened, "GET", `/api/v1/repositories/${repo}/pipelines/runs`)).body as { runs: Array<{ status: string; steps: Array<{ message: string }> }> };
      expect(runs.runs).toHaveLength(1);
      expect(runs.runs[0].status).toBe("failed");
      expect(runs.runs[0].steps[0].message).toContain("requires review");
      await new Promise((done) => setTimeout(done, 500));
      expect(await progress()).toBe(stopped);
      expect(await readFile(resolve(fixture.path, "base.txt"), "utf8")).toBe("base\n");
    } finally {
      await app?.close(); app = undefined;
      await stopLeakedChild();
      await fixture.cleanup();
      await rm(appData, { recursive: true, force: true });
    }
  }, 120_000);
});
