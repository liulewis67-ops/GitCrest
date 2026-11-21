import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { expect, it } from "vitest";
import { GitCrestApiClient } from "../../src/api/client";
import { createTempGitRepository } from "../fixtures/temp-repo";

const exec = promisify(execFile);

it("checks out a commit with local edits as a durable operation when the opt-in is on", async () => {
  const fixture = await createTempGitRepository();
  const appData = await mkdtemp(resolve(tmpdir(), "gitcrest-operation-commit-"));
  // Never take optional index locks while the app runs its own Git commands.
  const git = async (...args: string[]) => (await exec("git", ["-C", fixture.path, ...args], { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } })).stdout.trim();
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await git("config", "core.autocrlf", "false");
    await writeFile(resolve(fixture.path, "f.txt"), "a\nb\nc\nd\ne\n");
    await git("add", ".");
    await git("commit", "-qm", "first commit");
    const firstOid = await git("rev-parse", "HEAD");
    await writeFile(resolve(fixture.path, "f.txt"), "A\nb\nc\nd\ne\n");
    await git("commit", "-qam", "second commit");
    const branch = await git("branch", "--show-current");
    // A local edit far from the line the commits differ on: the file overlaps, and it restores without a conflict.
    // (Edits on adjacent lines would conflict, which is correct but not what this test is about.)
    await writeFile(resolve(fixture.path, "f.txt"), "A\nb\nc\nd\ne local\n");

    app = await electron.launch({
      args: [".", "--lang=en-US", "--disable-gpu", `--user-data-dir=${resolve(appData, "profile")}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appData, "test.sqlite"), GITCREST_OPERATION_CREATION: "1" },
    });
    const window = await app.firstWindow();
    await window.getByText("Core connected").waitFor({ timeout: 40_000 });
    const connection = await window.evaluate(() => globalThis.window.gitcrest!.getSidecarConnection());
    const api = new GitCrestApiClient(connection.baseUrl, connection.token);
    const { repoId } = await api.openRepository(fixture.path);
    await window.evaluate(() => {
      localStorage.setItem("gitcrest-operation-flow-v1", "on");
      localStorage.setItem("gitcrest-branch-change-policy-v1", "carry");
    });
    await window.reload();
    await window.locator(".repositoryRowOpen").click();
    await window.locator(".workspaceToolbar").waitFor();

    await window.getByRole("tab", { name: "History" }).click();
    await window.getByText("first commit", { exact: true }).first().click();
    await window.keyboard.press("Control+k");
    await window.getByRole("textbox", { name: "Search commands" }).fill("check out selected commit");
    await window.getByRole("button", { name: /Check out selected commit/ }).click();

    // HEAD is detached at the first commit; every task was a succeeded operation action; the local edit came along.
    await expect.poll(() => git("rev-parse", "HEAD"), { timeout: 60_000 }).toBe(firstOid);
    expect(await git("branch", "--show-current")).toBe("");
    await expect.poll(async () => {
      const tasks = (await api.listTasks()).filter((task) => task.repoId === repoId);
      return tasks.length > 0 && tasks.every((task) => task.operation === "operationAction" && task.status === "succeeded");
    }, { timeout: 60_000 }).toBe(true);
    expect((await readFile(resolve(fixture.path, "f.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("a\nb\nc\nd\ne local\n");
    expect(branch).not.toBe("");
  } finally {
    await app?.close().catch(() => undefined);
    await rm(appData, { recursive: true, force: true });
    await fixture.cleanup();
  }
}, 180_000);
