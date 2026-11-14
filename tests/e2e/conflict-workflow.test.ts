import { openTaskDetails } from "./task-details";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { afterEach, expect, it } from "vitest";
import { createTempGitRepository } from "../fixtures/temp-repo";
import { expectReadableText } from "./readability";

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
    await window.locator(".workspaceToolbar").waitFor();
    await window.getByRole("tab", { name: "History" }).click();

    const otherRow = window.locator(".branchItem", { hasText: "other" });
    const merge = otherRow.getByRole("button", { name: /Merge refs\/heads\/other/ });
    await expect.poll(async () => { await otherRow.hover(); return merge.isEnabled(); }, { timeout: 20_000 }).toBe(true);
    const conflictWindowPromise = app.waitForEvent("window", { timeout: 30_000 });
    await merge.click();
    await window.getByRole("button", { name: "Start merge" }).click();

    const conflictWindow: Page = await conflictWindowPromise;
    await conflictWindow.getByRole("main", { name: "Conflict resolution window" }).waitFor();
    await conflictWindow.locator(".resolverResult .view-lines").waitFor({ state: "visible" });
    await expectReadableText(conflictWindow, "Conflict window");
    const resultText = conflictWindow.locator(".resolverResult .view-lines");
    expect(await resultText.innerText()).not.toContain("<<<<<<<");
    const currentArrow = conflictWindow.getByRole("button", { name: "Use current #1", exact: true });
    const incomingArrow = conflictWindow.getByRole("button", { name: "Use incoming #1", exact: true });
    await currentArrow.click();
    await expect.poll(() => conflictWindow.locator(".resolverMergeArrow").count()).toBe(0);
    await conflictWindow.getByRole("button", { name: "Undo", exact: true }).click();
    await currentArrow.waitFor();
    expect(await resultText.innerText()).not.toContain("<<<<<<<");
    // Manually combine both sides in the actual clean result, then undo back to a pending choice.
    const editor = conflictWindow.locator(".resolverResult textarea");
    await editor.press("Control+A");
    await conflictWindow.keyboard.insertText("from current and other\n");
    await expect.poll(() => conflictWindow.locator(".resolverMergeArrow").count()).toBe(0);
    await conflictWindow.getByRole("button", { name: "Save result", exact: true }).click();
    await conflictWindow.getByText(/Saved to the working tree/).waitFor();
    expect((await readFile(file, "utf8")).replace(/\r\n/g, "\n")).toBe("from current and other\n");
    await conflictWindow.getByRole("button", { name: "Undo", exact: true }).click();
    await incomingArrow.waitFor();
    await incomingArrow.click();
    await expect.poll(() => conflictWindow.locator(".resolverMergeArrow").count()).toBe(0);
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

it("preserves CRLF and missing final newlines through editor choices, saving and staging", async () => {
  const fixture = await createTempGitRepository();
  const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-conflict-eol-"));
  try {
    await git(fixture.path, "config", "core.autocrlf", "false");
    for (const [path, content] of [["context.txt", "top\r\nbase\r\nbottom"], ["eof.txt", "top\r\nbase"], ["mixed.txt", "top\r\nbase\nbottom\r\nend"]]) await writeFile(resolve(fixture.path, path), content);
    await git(fixture.path, "add", "."); await git(fixture.path, "commit", "-qm", "base EOL files");
    const branch = await git(fixture.path, "branch", "--show-current");
    await git(fixture.path, "switch", "-qc", "eol-incoming");
    for (const [path, content] of [["context.txt", "top\r\nincoming\r\nbottom"], ["eof.txt", "top\r\nincoming"], ["mixed.txt", "top\r\nincoming\nbottom\r\nend"]]) await writeFile(resolve(fixture.path, path), content);
    await git(fixture.path, "commit", "-qam", "incoming EOL files");
    await git(fixture.path, "switch", "-q", branch);
    for (const [path, content] of [["context.txt", "top\r\ncurrent\r\nbottom"], ["eof.txt", "top\r\ncurrent"], ["mixed.txt", "top\r\ncurrent\nbottom\r\nend"]]) await writeFile(resolve(fixture.path, path), content);
    await git(fixture.path, "commit", "-qam", "current EOL files");
    await git(fixture.path, "merge", "eol-incoming").catch(() => {});
    app = await electron.launch({ args: [".", "--lang=en-US", "--disable-gpu", `--user-data-dir=${resolve(appDataPath, "profile")}`], env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "test.sqlite") } });
    const main = await app.firstWindow(); await main.getByText("Core connected").waitFor({ timeout: 40_000 });
    const target = await main.evaluate(async (path) => {
      const c = await window.gitcrest!.getSidecarConnection();
      const post = async (url: string, body?: unknown) => {
        const response = await fetch(new URL(`/api/v1${url}`, c.baseUrl), { method: "POST", headers: { Authorization: `Bearer ${c.token}`, "X-GitCrest-API-Version": "1", "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
        if (!response.ok) throw new Error(await response.text());
        return response.json();
      };
      const repo = await post("/repositories", { path });
      const adoption = await post(`/repositories/${repo.repoId}/workflows/adopt`);
      return { repoId: repo.repoId as string, taskId: adoption.task.taskId as string };
    }, fixture.path);
    const opened = app.waitForEvent("window");
    await main.evaluate((target) => window.gitcrest!.openConflictWindow(target), target);
    const resolver = await opened;
    await resolver.locator(".resolverResult .view-lines").waitFor();
    await resolver.getByRole("button", { name: "Use current", exact: true }).click();
    await resolver.getByRole("button", { name: "Save result", exact: true }).click();
    await resolver.getByText(/Saved to the working tree/).waitFor();
    expect(await readFile(resolve(fixture.path, "context.txt"), "utf8")).toBe("top\r\ncurrent\r\nbottom");
    await resolver.getByRole("button", { name: "Undo", exact: true }).click();
    await resolver.getByRole("button", { name: "Use incoming", exact: true }).click();
    await resolver.getByRole("button", { name: "Save & mark resolved", exact: true }).click();
    await resolver.getByText("2 unresolved", { exact: true }).waitFor();
    expect(await readFile(resolve(fixture.path, "context.txt"), "utf8")).toBe("top\r\nincoming\r\nbottom");
    await resolver.getByRole("button", { name: "Use current", exact: true }).click();
    await resolver.getByRole("button", { name: "Save & mark resolved", exact: true }).click();
    await resolver.getByText("1 unresolved", { exact: true }).waitFor();
    expect(await readFile(resolve(fixture.path, "eof.txt"), "utf8")).toBe("top\r\ncurrent");
    await resolver.getByRole("button", { name: "Use current", exact: true }).click();
    await resolver.getByRole("button", { name: "Save result", exact: true }).click();
    await resolver.getByText(/Saved to the working tree/).waitFor();
    expect(await readFile(resolve(fixture.path, "mixed.txt"), "utf8")).toBe("top\r\ncurrent\nbottom\r\nend");
    await resolver.getByRole("button", { name: "Undo", exact: true }).click();
    await resolver.getByRole("button", { name: "Use incoming", exact: true }).click();
    await resolver.getByRole("button", { name: "Save & mark resolved", exact: true }).click();
    await resolver.getByRole("heading", { name: "All conflicts resolved", exact: true }).waitFor();
    expect(await readFile(resolve(fixture.path, "mixed.txt"), "utf8")).toBe("top\r\nincoming\nbottom\r\nend");
    expect(await git(fixture.path, "ls-files", "--unmerged")).toBe("");
  } finally {
    await app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.destroy()));
    await app?.close(); app = undefined;
    await fixture.cleanup(); await rm(appDataPath, { recursive: true, force: true });
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
    await window.locator(".workspaceToolbar").waitFor();
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
    await conflictWindow.getByRole("button", { name: "Use incoming", exact: true }).click();
    await conflictWindow.getByRole("button", { name: "Save & mark resolved" }).click();
    await conflictWindow.getByText("0 unresolved").waitFor({ timeout: 45_000 });

    const tasks = await openTaskDetails(window);
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
