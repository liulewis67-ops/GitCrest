import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { afterEach, expect, it } from "vitest";
import { createTempGitRepository } from "../fixtures/temp-repo";

const execFileAsync = promisify(execFile);
const git = async (repo: string, ...args: string[]) => (await execFileAsync("git", ["-C", repo, ...args])).stdout.trim();

let app: ElectronApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

it("opens the conflict resolver by itself when a merge conflicts and stages the resolved file", async () => {
  const fixture = await createTempGitRepository();
  const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-conflict-e2e-app-data-"));
  try {
    const file = resolve(fixture.path, "shared.txt");
    await writeFile(file, "base\n");
    await git(fixture.path, "add", "shared.txt");
    await git(fixture.path, "commit", "--quiet", "-m", "base");
    const main = await git(fixture.path, "rev-parse", "--abbrev-ref", "HEAD");
    await git(fixture.path, "switch", "--quiet", "--create", "other");
    await writeFile(file, "from other\n");
    await git(fixture.path, "commit", "--quiet", "-am", "other change");
    await git(fixture.path, "switch", "--quiet", main);
    await writeFile(file, "from main\n");
    await git(fixture.path, "commit", "--quiet", "-am", "main change");

    app = await electron.launch({
      args: [".", "--lang=en-US", "--disable-gpu"],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
    await window.getByText("Core connected").waitFor({ timeout: 40_000 });
    await window.evaluate(async (repositoryPath) => {
      const connection = await (globalThis.window as unknown as Window & {
        gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
      }).gitcrest.getSidecarConnection();
      await fetch(new URL("/api/v1/repositories", connection.baseUrl), {
        method: "POST",
        headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ path: repositoryPath }),
      });
    }, fixture.path);
    await window.reload();
    await window.getByRole("heading", { name: "Recent repositories" }).waitFor();
    await window.locator(".repositoryRowOpen").click();
    await window.locator(".workspaceCrumb").waitFor();
    await window.getByRole("tab", { name: "History" }).click();

    const otherRow = window.locator(".branchItem", { hasText: "other" });
    const merge = otherRow.getByRole("button", { name: /Merge refs\/heads\/other/ });
    await expect.poll(async () => { await otherRow.hover(); return merge.isEnabled(); }, { timeout: 20_000 }).toBe(true);
    const conflictWindowPromise = app.waitForEvent("window", { timeout: 30_000 });
    await merge.click();
    await window.getByRole("button", { name: "Start merge" }).click();

    const conflictWindow: Page = await conflictWindowPromise;
    await conflictWindow.getByRole("main", { name: "Conflict resolution window" }).waitFor();
    await conflictWindow.getByRole("button", { name: "Use theirs for conflict 1" }).click();
    await conflictWindow.getByRole("button", { name: "Save & mark resolved" }).click();
    try {
      await conflictWindow.getByText("0 unresolved").waitFor({ timeout: 45_000 });
    } catch (error) {
      console.log("DIAG window text:", (await conflictWindow.locator("body").innerText().catch(() => "?")).slice(0, 1500));
      console.log("DIAG git status:", await git(fixture.path, "status", "--short").catch(() => "?"), "| unmerged:", await git(fixture.path, "ls-files", "--unmerged").catch(() => "?"));
      console.log("DIAG tasks:", await window.evaluate(async () => { const c = await (globalThis.window as unknown as { gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> } }).gitcrest.getSidecarConnection(); const r = await fetch(new URL("/api/v1/tasks", c.baseUrl), { headers: { Authorization: `Bearer ${c.token}`, "X-GitCrest-API-Version": "1" } }); return JSON.stringify((await r.json()).map((t: { operation: string; status: string; message: string | null }) => [t.operation, t.status, t.message])); }).catch(() => "?"));
      throw error;
    }

    await expect.poll(() => git(fixture.path, "ls-files", "--unmerged"), { timeout: 15_000 }).toBe("");
    expect((await readFile(file, "utf8")).replace(/\r\n/g, "\n")).toBe("from other\n");
  } finally {
    await app?.close();
    app = undefined;
    await fixture.cleanup();
    await rm(appDataPath, { recursive: true, force: true });
  }
}, 120_000);

it("resolves a binary conflict by taking one whole version", async () => {
  const fixture = await createTempGitRepository();
  const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-binary-conflict-e2e-app-data-"));
  try {
    const file = resolve(fixture.path, "logo.bin");
    await writeFile(file, Buffer.from([0, 1, 2, 3]));
    await git(fixture.path, "add", "logo.bin");
    await git(fixture.path, "commit", "--quiet", "-m", "base");
    const main = await git(fixture.path, "rev-parse", "--abbrev-ref", "HEAD");
    await git(fixture.path, "switch", "--quiet", "--create", "other");
    await writeFile(file, Buffer.from([0, 9, 9, 9]));
    await git(fixture.path, "commit", "--quiet", "-am", "other binary");
    await git(fixture.path, "switch", "--quiet", main);
    await writeFile(file, Buffer.from([0, 5, 5, 5]));
    await git(fixture.path, "commit", "--quiet", "-am", "main binary");

    app = await electron.launch({
      args: [".", "--lang=en-US", "--disable-gpu"],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
    await window.getByText("Core connected").waitFor({ timeout: 40_000 });
    await window.evaluate(async (repositoryPath) => {
      const connection = await (globalThis.window as unknown as Window & {
        gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
      }).gitcrest.getSidecarConnection();
      await fetch(new URL("/api/v1/repositories", connection.baseUrl), {
        method: "POST",
        headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ path: repositoryPath }),
      });
    }, fixture.path);
    await window.reload();
    await window.getByRole("heading", { name: "Recent repositories" }).waitFor();
    await window.locator(".repositoryRowOpen").click();
    await window.locator(".workspaceCrumb").waitFor();
    await window.getByRole("tab", { name: "History" }).click();

    const otherRow = window.locator(".branchItem").filter({ has: window.getByText("other", { exact: true }) });
    const merge = otherRow.getByRole("button", { name: /Merge refs\/heads\/other/ });
    await expect.poll(async () => { await otherRow.hover(); return merge.isEnabled(); }, { timeout: 20_000 }).toBe(true);
    const conflictWindowPromise = app.waitForEvent("window", { timeout: 30_000 });
    await merge.click();
    await window.getByRole("button", { name: "Start merge" }).click();

    const conflictWindow: Page = await conflictWindowPromise;
    await conflictWindow.getByText(/binary or non-text/).waitFor();
    await conflictWindow.getByRole("button", { name: "Use theirs (incoming)" }).click();
    await conflictWindow.getByText("0 unresolved").waitFor({ timeout: 45_000 });
    await expect.poll(() => git(fixture.path, "ls-files", "--unmerged"), { timeout: 15_000 }).toBe("");
    expect([...(await readFile(file))]).toEqual([0, 9, 9, 9]);
  } finally {
    await app?.close();
    app = undefined;
    await fixture.cleanup();
    await rm(appDataPath, { recursive: true, force: true });
  }
}, 120_000);

it("adopts a merge started outside GitCrest so it can be resolved and continued", async () => {
  const fixture = await createTempGitRepository();
  const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-adopt-e2e-app-data-"));
  try {
    const file = resolve(fixture.path, "shared.txt");
    await writeFile(file, "base\n");
    await git(fixture.path, "add", "shared.txt");
    await git(fixture.path, "commit", "--quiet", "-m", "base");
    const main = await git(fixture.path, "rev-parse", "--abbrev-ref", "HEAD");
    await git(fixture.path, "switch", "--quiet", "--create", "other");
    await writeFile(file, "from other\n");
    await git(fixture.path, "commit", "--quiet", "-am", "other change");
    await git(fixture.path, "switch", "--quiet", main);
    await writeFile(file, "from main\n");
    await git(fixture.path, "commit", "--quiet", "-am", "main change");
    // Start the merge from the terminal; GitCrest has no task for it.
    await execFileAsync("git", ["-C", fixture.path, "merge", "other"]).catch(() => undefined);
    await git(fixture.path, "rev-parse", "-q", "--verify", "MERGE_HEAD");

    app = await electron.launch({
      args: [".", "--lang=en-US", "--disable-gpu"],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
    await window.getByText("Core connected").waitFor({ timeout: 40_000 });
    await window.evaluate(async (repositoryPath) => {
      const connection = await (globalThis.window as unknown as Window & {
        gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
      }).gitcrest.getSidecarConnection();
      await fetch(new URL("/api/v1/repositories", connection.baseUrl), {
        method: "POST",
        headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ path: repositoryPath }),
      });
    }, fixture.path);
    await window.reload();
    await window.getByRole("heading", { name: "Recent repositories" }).waitFor();
    const conflictWindowPromise = app.waitForEvent("window", { timeout: 30_000 });
    await window.locator(".repositoryRowOpen").click();

    const conflictWindow: Page = await conflictWindowPromise;
    await conflictWindow.getByRole("button", { name: "Use theirs for conflict 1" }).click();
    await conflictWindow.getByRole("button", { name: "Save & mark resolved" }).click();
    await conflictWindow.getByText("0 unresolved").waitFor({ timeout: 45_000 });

    await window.getByRole("button", { name: /^Background tasks/ }).click();
    const tasks = window.getByRole("dialog", { name: "Tasks" });
    await tasks.getByRole("button", { name: "Refresh preview" }).click();
    const proceed = tasks.getByRole("button", { name: "Continue" });
    await expect.poll(async () => proceed.isEnabled(), { timeout: 15_000 }).toBe(true);
    await proceed.click();
    await expect.poll(() => git(fixture.path, "rev-parse", "-q", "--verify", "MERGE_HEAD").then(() => true, () => false), { timeout: 20_000 }).toBe(false);
    expect((await readFile(file, "utf8")).replace(/\r\n/g, "\n")).toBe("from other\n");
  } finally {
    await app?.close();
    app = undefined;
    await fixture.cleanup();
    await rm(appDataPath, { recursive: true, force: true });
  }
}, 150_000);
