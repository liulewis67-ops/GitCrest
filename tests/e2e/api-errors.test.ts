import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication } from "playwright";
import { expect, it } from "vitest";
import { createTempGitRepository } from "../fixtures/temp-repo";

const run = promisify(execFile);

it("localizes a missing-repository response and exposes core text only in Details", async () => {
  const fixture = await createTempGitRepository();
  const appData = await mkdtemp(join(tmpdir(), "gitcrest-api-error-app-"));
  let app: ElectronApplication | undefined;
  try {
    await writeFile(join(fixture.path, "README.md"), "# Error review\n");
    await run("git", ["-C", fixture.path, "add", "."]);
    await run("git", ["-C", fixture.path, "commit", "--quiet", "-m", "Initial review commit"]);
    app = await electron.launch({
      args: [".", "--lang=zh-CN", "--disable-gpu", `--user-data-dir=${join(appData, "profile")}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: join(appData, "gitcrest.sqlite") },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.evaluate(() => localStorage.setItem("gitcrest-locale", "zh"));
    await window.reload();
    await window.locator(".connectionBadge.connected").waitFor({ timeout: 40_000 });
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, fixture.path);
    await window.getByRole("button", { name: /^打开本地仓库/ }).click();
    await window.getByRole("tab", { name: "历史", exact: true }).click();
    await window.locator(".commitGraphRow").first().waitFor();
    // Keep the view mounted: folder-deletion recovery is covered separately in D1.2.
    await window.route(/\/api\/v1\/repositories\/[^/]+\/commits(?:\?|$)/, (route) => route.fulfill({
      status: 404,
      json: { error: { code: "REPOSITORY_PATH_NOT_FOUND", message: "The selected repository path no longer exists." } },
    }));
    await window.locator(".historyMessageSearch input").fill("missing repository");
    await window.locator(".historyMessageSearch input").press("Enter");
    const panel = window.locator('.repositoryRecovery[role="alert"]');
    await panel.waitFor();
    await expect.poll(() => window.getByRole("alert").filter({ hasText: /\S/ }).count()).toBe(1);
    await expect.poll(() => window.locator(".historyChangesPane").count()).toBe(0);
    expect(await window.locator(".loadingSpinner").count()).toBe(0);
    const summary = await panel.locator(".apiErrorMessage > span").first().innerText();
    expect(summary).toMatch(/仓库|历史/);
    expect(summary).toMatch(/请/);
    expect(summary).not.toContain("The selected repository");
    const details = panel.locator(".apiErrorDetails");
    expect(await details.isVisible()).toBe(false);
    expect(await details.textContent()).toContain("The selected repository path no longer exists.");
    await panel.getByRole("button", { name: "详情", exact: true }).click();
    await expect.poll(() => details.isVisible(), { timeout: 5_000 }).toBe(true);
    await window.getByRole("tab", { name: "工作区", exact: true }).click();
    await window.locator('.repositoryRecovery[role="alert"]').waitFor();
    expect(await window.getByRole("alert").filter({ hasText: /\S/ }).count()).toBe(1);
    expect(await window.locator(".loadingSpinner").count()).toBe(0);
  } finally {
    await app?.close();
    await fixture.cleanup();
    await rm(appData, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}, 90_000);

it("keeps a failed selected-commit read out of the inspector and restores it after retry", async () => {
  const fixture = await createTempGitRepository();
  const appData = await mkdtemp(join(tmpdir(), "gitcrest-commit-error-app-"));
  let app: ElectronApplication | undefined;
  try {
    for (const message of ["Initial commit", "Second commit"]) {
      await writeFile(join(fixture.path, "README.md"), message + "\n");
      await run("git", ["-C", fixture.path, "add", "."]);
      await run("git", ["-C", fixture.path, "commit", "--quiet", "-m", message]);
    }
    app = await electron.launch({
      args: [".", "--lang=en-US", "--disable-gpu", `--user-data-dir=${join(appData, "profile")}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: join(appData, "gitcrest.sqlite") },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.evaluate(() => localStorage.setItem("gitcrest-locale", "en"));
    await window.reload();
    await window.locator(".connectionBadge.connected").waitFor({ timeout: 40_000 });
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, fixture.path);
    await window.getByRole("button", { name: /^Open local repository/ }).click();
    await window.getByRole("tab", { name: "History", exact: true }).click();
    await window.locator(".commitGraphRow").nth(1).waitFor();
    if (await window.getByRole("button", { name: "Show commit details", exact: true }).count()) await window.getByRole("button", { name: "Show commit details", exact: true }).click();
    await window.locator(".commitDetails").waitFor();
    const detailsRoute = /\/api\/v1\/repositories\/[^/]+\/commits\/[a-f0-9]{40}(?:\?|$)/;
    await window.route(detailsRoute, (route) => route.fulfill({ status: 404, json: { error: { code: "HISTORY_COMMIT_NOT_FOUND", message: "The selected commit is unavailable." } } }));
    await window.locator(".commitGraphRow").nth(1).getByRole("button").click();
    await window.locator('.commitChanges [role="alert"]').waitFor();
    await expect.poll(() => window.getByRole("alert").filter({ hasText: /\S/ }).count()).toBe(1);
    await expect.poll(() => window.locator(".inspector").count()).toBe(0);
    expect(await window.locator(".commitChangesHeader").count()).toBe(0);
    expect(await window.locator(".loadingSpinner").count()).toBe(0);
    await window.unroute(detailsRoute);
    await window.getByRole("button", { name: "Retry loading commit", exact: true }).click();
    await window.locator(".commitChangesHeader").getByRole("heading", { name: "Initial commit", exact: true }).waitFor();
    await window.locator(".inspector .commitDetails").waitFor();
    expect(await window.getByRole("alert").filter({ hasText: /\S/ }).count()).toBe(0);
  } finally {
    await app?.close();
    await fixture.cleanup();
    await rm(appData, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}, 90_000);
