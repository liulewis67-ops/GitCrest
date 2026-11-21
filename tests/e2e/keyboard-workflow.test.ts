import { openTaskDetails } from "./task-details";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright";
import { expect, it } from "vitest";
import { createTempGitRepository } from "../fixtures/temp-repo";

const execFileAsync = promisify(execFile);

it("uses keyboard workflows for repository changes and reviews an AI conflict suggestion without applying it", async () => {
  const fixture = await createTempGitRepository();
  const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-keyboard-app-data-"));
  let app: ElectronApplication | undefined;
  let mockProvider: ReturnType<typeof createServer> | undefined;
  try {
    await writeFile(resolve(fixture.path, "seed.txt"), "seed\n");
    await execFileAsync("git", ["-C", fixture.path, "add", "seed.txt"]);
    await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-m", "seed"]);

    app = await electron.launch({
      args: [".", "--lang=en-US", "--disable-gpu", `--user-data-dir=${resolve(appDataPath, "profile")}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
    await window.getByText("Core connected").waitFor({ timeout: 40_000 });

    const providerRequests: Array<Record<string, unknown>> = [];
    mockProvider = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        providerRequests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        const body = JSON.stringify({ choices: [{ message: { content: "export const value = 'AI proposed merge';\n" } }] });
        response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
        response.end(body);
      });
    });
    await new Promise<void>((resolveListen) => mockProvider?.listen(0, "127.0.0.1", resolveListen));
    const providerAddress = mockProvider.address();
    if (!providerAddress || typeof providerAddress === "string") throw new Error("Could not bind the loopback AI test server.");
    const providerEndpoint = `http://127.0.0.1:${providerAddress.port}`;
    await window.getByRole("button", { name: "Settings" }).click();
    await window.getByRole("menuitem", { name: /All settings/ }).click();
    const settingsDialog = window.getByRole("dialog", { name: "Settings" });
    const addProvider = settingsDialog.getByRole("button", { name: "Add provider" });
    await expect.poll(() => addProvider.isEnabled(), { timeout: 5_000 }).toBe(true);
    await addProvider.click();
    const providerCard = settingsDialog.getByRole("group", { name: "Provider Provider 1" });
    await providerCard.getByRole("textbox", { name: /^Base URL/ }).fill(`${providerEndpoint}/v1`);
    await providerCard.getByRole("textbox", { name: "Model", exact: true }).fill("qwen-test");
    await settingsDialog.getByRole("button", { name: "Save providers" }).click();
    await settingsDialog.getByText("Providers saved. No model request was made.").waitFor();
    await settingsDialog.getByRole("button", { name: "Close settings" }).click();

    await app.evaluate(({ dialog }, repositoryPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [repositoryPath] });
    }, fixture.path);
    await window.keyboard.press("Control+o");
    await window.locator(".workspaceToolbar").waitFor();
    expect(await window.locator(".repositoryTab.active > button[role=tab]").getAttribute("title")).toContain(fixture.path);

    const repoId = await window.evaluate(async (repositoryPath) => {
      const connection = await (globalThis.window as unknown as Window & {
        gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
      }).gitcrest.getSidecarConnection();
      const response = await fetch(new URL("/api/v1/repositories", connection.baseUrl), {
        headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1" },
      });
      const repositories = await response.json() as Array<{ repoId: string; path: string }>;
      return repositories.find((repository) => repository.path === repositoryPath)?.repoId;
    }, fixture.path);
    if (!repoId) throw new Error("The keyboard-opened repository was not registered.");

    await writeFile(resolve(fixture.path, "keyboard.ts"), "export const keyboardWorkflow = true;\n");
    await enterButtonByTab(window, "Refresh working tree status");
    const changesList = window.getByRole("complementary", { name: "Working tree changes" });
    await changesList.getByText("keyboard.ts", { exact: true }).waitFor();
    expect(await window.getByRole("button", { name: "Stage all", exact: true }).isDisabled()).toBe(false);
    await window.keyboard.press("Control+Shift+a");
    await expect.poll(() => window.getByRole("checkbox", { name: "Stage keyboard.ts", exact: true }).isChecked(), { timeout: 15_000 }).toBe(true);

    const taskDialog = await openTaskDetails(window);
    if (await taskDialog.count()) await enterButtonByTab(window, "Close tasks");
    const message = window.getByRole("textbox", { name: "Commit message", exact: true });
    await message.focus();
    await window.keyboard.type("keyboard stage and commit");
    await expect.poll(() => window.getByRole("button", { name: "Commit", exact: true }).isEnabled(), { timeout: 15_000 }).toBe(true);
    await message.press("Control+Enter");
    await expect.poll(async () => (await execFileAsync("git", ["-C", fixture.path, "log", "-1", "--format=%s"])).stdout.trim(), { timeout: 15_000 }).toBe("keyboard stage and commit");
    expect((await execFileAsync("git", ["-C", fixture.path, "status", "--porcelain"])).stdout.trim()).toBe("");

    const branchCreation = await window.evaluate(async ({ repoId, name }) => {
      const connection = await (globalThis.window as unknown as Window & {
        gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
      }).gitcrest.getSidecarConnection();
      const response = await fetch(new URL(`/api/v1/repositories/${encodeURIComponent(repoId)}/branches`, connection.baseUrl), {
        method: "POST",
        headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      return response.status;
    }, { repoId, name: "keyboard-target" });
    expect(branchCreation).toBe(202);
    expect(await window.getByRole("dialog", { name: "Tasks" }).count()).toBe(0);
    await window.keyboard.press("Control+2");
    await window.locator(".branchItemName").filter({ hasText: "keyboard-target" }).waitFor();
    await window.keyboard.press("Control+b");
    const switchDialog = window.getByRole("dialog", { name: "Switch branch" });
    await switchDialog.waitFor();
    const branchChoice = switchDialog.getByRole("button", { name: "keyboard-target", exact: true });
    await enterButtonByTab(window, "keyboard-target", branchChoice);
    await expect.poll(async () => await window.evaluate(async (repoId) => {
      const connection = await (globalThis.window as unknown as Window & {
        gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
      }).gitcrest.getSidecarConnection();
      const response = await fetch(new URL(`/api/v1/repositories/${encodeURIComponent(repoId)}`, connection.baseUrl), {
        headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1" },
      });
      return (await response.json() as { branch: string }).branch;
    }, repoId), { timeout: 15_000 }).toBe("keyboard-target");
    expect(await window.getByRole("dialog", { name: "Tasks" }).count()).toBe(0);
    await window.getByRole("button", { name: "Background tasks, 0 active" }).waitFor();

    const resetBaseOid = (await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD"])).stdout.trim();
    await execFileAsync("git", ["-C", fixture.path, "branch", "keyboard-reset-base", resetBaseOid]);
    await writeFile(resolve(fixture.path, "reset-trigger.ts"), "export const reviewedReset = true;\n");
    await window.keyboard.press("Control+1");
    await enterButtonByTab(window, "Refresh working tree status");
    await changesList.getByText("reset-trigger.ts", { exact: true }).waitFor();
    await window.keyboard.press("Control+Shift+a");
    await expect.poll(() => window.getByRole("checkbox", { name: "Stage reset-trigger.ts", exact: true }).isChecked(), { timeout: 15_000 }).toBe(true);
    const resetCommitMessage = window.getByRole("textbox", { name: "Commit message", exact: true });
    await resetCommitMessage.focus();
    await window.keyboard.press("Control+a");
    await window.keyboard.press("Backspace");
    await window.keyboard.type("keyboard reset review");
    expect(await resetCommitMessage.inputValue()).toBe("keyboard reset review");
    await expect.poll(() => window.getByRole("button", { name: "Commit", exact: true }).isDisabled(), { timeout: 15_000 }).toBe(false);
    await window.keyboard.press("Control+Enter");
    await expect.poll(async () => (await execFileAsync("git", ["-C", fixture.path, "log", "-1", "--format=%s"])).stdout.trim(), { timeout: 15_000 }).toBe("keyboard reset review");
    expect(await window.getByRole("dialog", { name: "Tasks" }).count()).toBe(0);
    await window.keyboard.press("Control+k");
    await window.keyboard.type("Reset current branch");
    await enterButtonByTab(window, "Reset current branch");
    const resetDialog = window.getByRole("dialog", { name: "Reset current branch" });
    await resetDialog.waitFor();
    const resetTarget = resetDialog.locator("#reset-target");
    await expect.poll(() => resetTarget.isDisabled(), { timeout: 15_000 }).toBe(false);
    await focusControlByTab(window, "reset-target");
    // keyboard-reset-base was created outside the app; it shows up once the ref watcher refreshes branches.
    const findResetTargetIndex = () => resetTarget.locator("option").evaluateAll((options, targetOid) => options.findIndex((option) => option.textContent?.includes("keyboard-reset-base") && option.getAttribute("value") === targetOid), resetBaseOid);
    await expect.poll(findResetTargetIndex, { timeout: 15_000, message: "The keyboard reset target was not available in the branch commit list." }).toBeGreaterThan(0);
    await window.keyboard.press("Enter");
    await window.keyboard.type("keyboard-reset-base");
    await resetDialog.getByRole("listbox").getByRole("option").filter({ hasText: "keyboard-reset-base" }).waitFor();
    await window.keyboard.press("Enter");
    await enterButtonByTab(window, "Review impact");
    await resetDialog.getByText(/Affected paths/).waitFor();
    await focusControlByTab(window, "I reviewed the commit and path impact");
    await window.keyboard.press("Space");
    await enterButtonByTab(window, "Reset mixed");
    await expect.poll(async () => await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD"]).then(({ stdout }) => stdout.trim()), { timeout: 15_000 }).toBe(resetBaseOid);
    await execFileAsync("git", ["-C", fixture.path, "clean", "--quiet", "-f", "--", "reset-trigger.ts"]);

    const seedOid = (await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD~1"])).stdout.trim();
    await execFileAsync("git", ["-C", fixture.path, "branch", "keyboard-conflict-source", seedOid]);
    await execFileAsync("git", ["-C", fixture.path, "switch", "keyboard-conflict-source"]);
    await writeFile(resolve(fixture.path, "seed.txt"), "theirs conflict version\n");
    await execFileAsync("git", ["-C", fixture.path, "add", "seed.txt"]);
    await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-m", "source conflict change"]);
    const sourceOid = (await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD"])).stdout.trim();
    await execFileAsync("git", ["-C", fixture.path, "switch", "keyboard-target"]);
    await writeFile(resolve(fixture.path, "seed.txt"), "ours conflict version\n");
    await execFileAsync("git", ["-C", fixture.path, "add", "seed.txt"]);
    await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-m", "target conflict change"]);
    const expectedHeadOid = (await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD"])).stdout.trim();
    const cherryPick = await window.evaluate(async ({ repoId, targetOid, headOid }) => {
      const connection = await (globalThis.window as unknown as Window & {
        gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
      }).gitcrest.getSidecarConnection();
      const response = await fetch(new URL(`/api/v1/repositories/${encodeURIComponent(repoId)}/workflows`, connection.baseUrl), {
        method: "POST",
        headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cherryPick", targetOid, expectedHeadOid: headOid }),
      });
      return { status: response.status, task: await response.json() as { taskId: string; createdAtMs: number } };
    }, { repoId, targetOid: sourceOid, headOid: expectedHeadOid });
    expect(cherryPick.status).toBe(202);
    await enterButtonByTab(window, "Background tasks");
    const tasksDialog = await openTaskDetails(window);
    const cherryPickTask = tasksDialog.locator(".taskCard").filter({ has: window.locator('.taskCardHeading strong[data-operation="cherryPick"]') });
    await cherryPickTask.getByRole("button", { name: "Open conflict resolver" }).waitFor();
    // The conflict window is reused when one is already open, so no new window event is raised; find it instead.
    await enterButtonByTab(window, "Open conflict resolver");
    let conflictWindow: Page | undefined;
    await expect.poll(() => {
      conflictWindow = app?.windows().find((candidate) => candidate !== window);
      return conflictWindow !== undefined;
    }, { timeout: 30_000 }).toBe(true);
    if (!conflictWindow) throw new Error("The conflict window did not open.");
    await conflictWindow.getByRole("heading", { name: "Resolve conflicts" }).waitFor();
    await conflictWindow.bringToFront();
    const originalConflictResult = await conflictWindow.locator(".resolverResult .view-lines").innerText();
    await conflictWindow.getByRole("button", { name: "File actions", exact: true }).click();
    await conflictWindow.getByRole("menuitem", { name: "AI merge", exact: true }).click();
    const suggestionPanel = conflictWindow.getByRole("region", { name: "AI merge" });
    await suggestionPanel.getByText(providerEndpoint, { exact: false }).waitFor();
    await suggestionPanel.getByText(/Source: cherryPick, seed\.txt/).waitFor();
    expect(await suggestionPanel.getByRole("button", { name: "Merge with AI" }).isDisabled()).toBe(true);
    await suggestionPanel.getByRole("checkbox", { name: /I reviewed the endpoint, prompt, source stages, and result revision/ }).check();
    await suggestionPanel.getByRole("button", { name: "Merge with AI" }).click();
    const proposedResult = suggestionPanel.getByRole("region", { name: "Proposed merge" });
    await proposedResult.getByText("AI proposed merge").waitFor().catch(async () => { throw new Error(`AI merge did not arrive: ${await suggestionPanel.innerText()}`); });
    expect(await conflictWindow.locator(".resolverResult .view-lines").innerText()).toBe(originalConflictResult);
    expect(await execFileAsync("git", ["-C", fixture.path, "status", "--porcelain=v1", "--", "seed.txt"])).toMatchObject({ stdout: expect.stringContaining("UU seed.txt") });
    expect(providerRequests).toHaveLength(1);
    expect(providerRequests[0]?.model).toBe("qwen-test");
    expect(String(providerRequests[0]?.messages && (providerRequests[0].messages as Array<{ content?: string }>)[0]?.content)).toContain("theirs conflict version");
    await suggestionPanel.getByRole("button", { name: "Close" }).click();
    await conflictWindow.getByRole("button", { name: "Use incoming #1" }).waitFor();
    await enterButtonByTab(conflictWindow, "Use incoming #1");
    await enterButtonByTab(conflictWindow, "Save result");
    await conflictWindow.getByText(/Saved to the working tree/).waitFor();
    await enterButtonByTab(conflictWindow, "Mark resolved");
    await conflictWindow.getByText("0 unresolved").waitFor();
    await conflictWindow.close();

    await enterButtonByTab(window, "Refresh preview");
    const continueWorkflow = cherryPickTask.getByRole("button", { name: "Continue" });
    await expect.poll(() => continueWorkflow.isDisabled(), { timeout: 15_000 }).toBe(false);
    await enterButtonByTab(window, "Continue");
    await expect.poll(async () => await window.evaluate(async ({ repoId, startTime }) => {
      const connection = await (globalThis.window as unknown as Window & {
        gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
      }).gitcrest.getSidecarConnection();
      const response = await fetch(new URL("/api/v1/tasks", connection.baseUrl), {
        headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1" },
      });
      const tasks = await response.json() as Array<{ taskId: string; repoId: string | null; operation: string; status: string; createdAtMs: number }>;
      return tasks.find((task) => task.repoId === repoId && task.operation === "workflowContinue" && task.createdAtMs >= startTime)?.status;
    }, { repoId, startTime: cherryPick.task.createdAtMs }), { timeout: 15_000 }).toBe("succeeded");
    await expect.poll(async () => await window.evaluate(async (taskId) => {
      const connection = await (globalThis.window as unknown as Window & {
        gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
      }).gitcrest.getSidecarConnection();
      const response = await fetch(new URL("/api/v1/tasks", connection.baseUrl), {
        headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1" },
      });
      const tasks = await response.json() as Array<{ taskId: string; status: string }>;
      return tasks.find((task) => task.taskId === taskId)?.status;
    }, cherryPick.task.taskId), { timeout: 15_000 }).toBe("succeeded");
    expect((await execFileAsync("git", ["-C", fixture.path, "show", "HEAD:seed.txt"])).stdout).toBe("theirs conflict version\n");
  } finally {
    await app?.close();
    if (mockProvider) await new Promise<void>((resolveClose, rejectClose) => mockProvider?.close((error) => error ? rejectClose(error) : resolveClose()));
    await fixture.cleanup();
    await rm(appDataPath, { recursive: true, force: true });
  }
}, 75_000);

async function enterButtonByTab(page: Page, label: string, expectedButton?: Locator) {
  // Buttons are briefly disabled or absent while a task or status refresh is running, and Tab skips
  // them then; start walking only once the target can actually take focus.
  await expect.poll(async () => expectedButton
    ? await expectedButton.isVisible() && await expectedButton.isEnabled()
    : await page.evaluate((expected) => [...document.querySelectorAll("button")].some((button) =>
      !button.disabled && button.getClientRects().length > 0 && `${button.getAttribute("aria-label") || ""} ${button.innerText}`.includes(expected)), label),
  { timeout: 15_000 }).toBe(true);
  // Where focus starts depends on what just closed; reaching the button took 15 to 46 presses in measured runs, so allow generous headroom.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const focused = expectedButton ? await expectedButton.and(page.locator(":focus")).count() === 1 : await page.evaluate((expected) => {
      const active = document.activeElement;
      return active instanceof HTMLButtonElement && `${active.getAttribute("aria-label") || ""} ${active.innerText}`.includes(expected);
    }, label);
    if (focused) {
      await page.keyboard.press("Enter");
      return;
    }
    await page.keyboard.press("Tab");
  }
  throw new Error(`Could not reach the ${label} button by pressing Tab.`);
}

async function focusControlByTab(page: Page, label: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const isFocused = await page.evaluate((expected) => {
      const active = document.activeElement;
      const labels = active instanceof HTMLInputElement ? Array.from(active.labels || []).map((item) => item.innerText).join(" ") : "";
      return active instanceof HTMLElement && `${active.id} ${active.getAttribute("aria-label") || ""} ${labels}`.includes(expected);
    }, label);
    if (isFocused) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Could not reach the ${label} control by pressing Tab.`);
}
