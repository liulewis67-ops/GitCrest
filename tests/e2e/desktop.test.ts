import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { createTempGitRepository } from "../fixtures/temp-repo";

const execFileAsync = promisify(execFile);

describe("desktop startup E2E", () => {
  let app: ElectronApplication | undefined;
  let mockOllama: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => mockOllama ? mockOllama.close(() => resolve()) : resolve());
    mockOllama = undefined;
    await app?.close();
    app = undefined;
  });

  it("starts Electron and the authenticated sidecar with a disposable Git fixture", async () => {
    const fixture = await createTempGitRepository();
    const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-e2e-app-data-"));
    try {
      expect(fixture.path).toContain("gitcrest-e2e-");

      app = await electron.launch({
        args: [".", "--lang=en-US", "--disable-gpu"],
        env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: resolve(appDataPath, "gitcrest.sqlite") },
      });
      const window = await app.firstWindow();
      await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
      await window.waitForFunction(
        () => document.body.innerText.includes("Core connected") || document.body.innerText.includes("Connecting to engine"),
        undefined,
        { timeout: 15_000 },
      );
      const body = await window.locator("body").innerText();
      expect(body).toContain("Core connected");
      expect(body).toContain("gitcrest-core 0.1.0 (API v1)");
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);

      const providerBodies: Array<Record<string, unknown>> = [];
      mockOllama = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          providerBodies.push(requestBody);
          const prompt = String(requestBody.messages && (requestBody.messages as Array<{ content?: string }>)[0]?.content);
          const content = providerBodies.length === 1
            ? "Mock local review response"
            : prompt.includes("Summarize the reviewed staged changes")
              ? "- Adds the reviewed staged export.\n- Leaves worktree edits out of this summary."
              : "feat: describe reviewed staged change";
          const body = JSON.stringify({ choices: [{ message: { content } }] });
          setTimeout(() => {
            response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
            response.end(body);
          }, 250);
        });
      });
      await new Promise<void>((resolve) => mockOllama?.listen(0, "127.0.0.1", resolve));
      const mockAddress = mockOllama.address();
      if (!mockAddress || typeof mockAddress === "string") throw new Error("Could not bind the loopback AI test server.");

      await window.getByRole("button", { name: "Settings" }).click();
      await window.getByRole("menuitem", { name: /All settings/ }).click();
      const settingsDialog = window.getByRole("dialog", { name: "Settings" });
      await settingsDialog.waitFor();
      const addProvider = settingsDialog.getByRole("button", { name: "Add provider" });
      await expect.poll(() => addProvider.isEnabled(), { timeout: 5_000 }).toBe(true);
      await addProvider.click();
      const providerCard = settingsDialog.getByRole("group", { name: "Provider Provider 1" });
      await providerCard.getByRole("textbox", { name: /^Base URL/ }).fill(`http://127.0.0.1:${mockAddress.port}/v1`);
      await providerCard.getByRole("textbox", { name: "Model", exact: true }).fill("qwen2.5-coder:7b");
      await settingsDialog.getByRole("button", { name: "Save providers" }).click();
      await settingsDialog.getByText("Providers saved. No model request was made.").waitFor();
      expect(providerBodies).toHaveLength(0);
      await settingsDialog.getByRole("button", { name: "Close settings" }).click();

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
        return { status: response.status, body: await response.json() };
      }, fixture.path);
      expect(opened.status).toBe(200);
      expect(opened.body).toMatchObject({
        path: fixture.path,
        head: null,
        detached: false,
        state: "normal",
        isFavorite: false,
        availability: "available",
      });
      expect(opened.body.repoId).toMatch(/^repo_[0-9a-f]{64}$/);

      // The diff layout is a saved preference; start from the full-file default whatever an earlier run chose.
      await window.evaluate(() => window.localStorage.removeItem("gitcrest-diff-view-v1"));
      await window.reload();
      await window.getByRole("heading", { name: "Recent repositories" }).waitFor();
      expect(await window.locator(".repositoryList").innerText()).toContain(fixture.path);
      await window.locator(".repositoryRowOpen").click();
      await window.locator(".workspaceCrumb").waitFor();
      expect(await window.locator(".workspaceCrumb").innerText()).toContain(fixture.path);

      await mkdir(resolve(fixture.path, "src"), { recursive: true });
      await writeFile(resolve(fixture.path, "src/example.ts"), "export const greeting = 'hello';\n");
      await writeFile(resolve(fixture.path, "src/other.ts"), "export const sibling = 'base';\n");
      await execFileAsync("git", ["-C", fixture.path, "add", "src/example.ts", "src/other.ts"]);
      await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-m", "add source fixture"]);
      const originalBranch = (await execFileAsync("git", ["-C", fixture.path, "branch", "--show-current"])).stdout.trim();
      await execFileAsync("git", ["-C", fixture.path, "checkout", "--quiet", "-b", "feature/e2e"]);
      await writeFile(resolve(fixture.path, "src/example.ts"), "export const greeting = 'feature branch';\n");
      await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-am", "change feature branch"]);
      await execFileAsync("git", ["-C", fixture.path, "checkout", "--quiet", originalBranch]);
      await writeFile(resolve(fixture.path, "src/example.ts"), "export const greeting = 'welcome';\n");
      await writeFile(resolve(fixture.path, "src/other.ts"), "export const sibling = 'changed';\n");
      await window.getByRole("button", { name: "Refresh working tree status" }).click();
      await window.getByRole("button", { name: "Settings" }).click();
      await window.getByRole("menuitem", { name: /All settings/ }).click();
      const privacyDialog = window.getByRole("dialog", { name: "Settings" });
      await privacyDialog.locator(".privacyScopeList").waitFor();
      await privacyDialog.locator(".privacyScopeList input").first().check();
      await privacyDialog.getByRole("button", { name: "Preview diff" }).first().click();
      await privacyDialog.locator(".privacyDiffPreview pre").waitFor();
      expect(await privacyDialog.locator(".privacyDiffPreview pre").innerText()).toContain("+export const greeting = 'welcome';");
      expect(await privacyDialog.innerText()).toContain("Inspect each diff before confirming.");
      await privacyDialog.getByRole("button", { name: "Review all selected diffs before sending" }).click();
      await privacyDialog.getByRole("heading", { name: "Confirm provider request" }).waitFor();
      expect(await privacyDialog.locator(".aiRequestReview pre").innerText()).toContain("+export const greeting = 'welcome';");
      await privacyDialog.getByRole("checkbox", { name: /I reviewed the files and diffs above/ }).check();
      await privacyDialog.getByRole("button", { name: "Send these exact diffs" }).click();
      await privacyDialog.getByText("Mock local review response").waitFor();
      const providerPrompt = String(providerBodies[0]?.messages && (providerBodies[0].messages as Array<{ content?: string }>)[0]?.content);
      expect(providerBodies[0]?.model).toBe("qwen2.5-coder:7b");
      expect(providerPrompt).toContain("export const greeting = 'welcome';");
      expect(providerPrompt).not.toContain("sibling = 'changed'");
      await privacyDialog.getByRole("button", { name: "Close settings" }).click();

      await writeFile(resolve(fixture.path, "src/commit-ai.ts"), "export const reviewedTitle = 'staged';\n");
      await execFileAsync("git", ["-C", fixture.path, "add", "src/commit-ai.ts"]);
      await writeFile(resolve(fixture.path, "src/commit-ai.ts"), "export const reviewedTitle = 'unstaged';\n");
      await window.getByRole("button", { name: "Refresh working tree status" }).click();
      // Staged, then edited again: the Commit panel shows the file as partly staged.
      await expect.poll(() => window.getByRole("checkbox", { name: "Stage src/commit-ai.ts", exact: true }).evaluate((box) => (box as HTMLInputElement).indeterminate), { timeout: 15_000 }).toBe(true);
      await window.keyboard.press("Control+g");
      const commitAssistant = window.getByRole("region", { name: "AI commit message suggestion" });
      await commitAssistant.locator(".privacyDiffPreview summary").waitFor({ timeout: 5000 }).catch(async () => { throw new Error(`Commit assistant did not prepare staged diffs: ${await commitAssistant.innerText()}`); });
      await commitAssistant.getByText("src/commit-ai.ts · staged/index · all staged changes").waitFor();
      expect(await commitAssistant.locator(".privacyDiffPreview pre").innerText()).toContain("+export const reviewedTitle = 'staged';");
      expect(await commitAssistant.locator(".privacyDiffPreview pre").innerText()).not.toContain("unstaged");
      await commitAssistant.getByRole("checkbox", { name: /I reviewed the staged diff/ }).check();
      await commitAssistant.getByRole("button", { name: "Send reviewed staged diff" }).click();
      await commitAssistant.getByText("Waiting for provider…").waitFor();
      await window.getByRole("textbox", { name: "Commit message", exact: true }).fill("my manual commit text");
      expect(await window.getByRole("button", { name: "Commit", exact: true }).isEnabled()).toBe(true);
      await commitAssistant.getByText("The commit draft changed while the provider was responding.").waitFor();
      expect(await window.getByRole("textbox", { name: "Commit message", exact: true }).inputValue()).toBe("my manual commit text");
      expect(await commitAssistant.getByRole("button", { name: "Use suggestion" }).isDisabled()).toBe(true);
      expect(await execFileAsync("git", ["-C", fixture.path, "log", "-1", "--format=%s"])).toMatchObject({ stdout: "add source fixture\n" });

      await commitAssistant.getByRole("button", { name: "Review current staged changes again" }).click();
      await commitAssistant.getByText("src/commit-ai.ts · staged/index · all staged changes").waitFor();
      await commitAssistant.getByRole("checkbox", { name: /I reviewed the staged diff/ }).check();
      await commitAssistant.getByRole("button", { name: "Send reviewed staged diff" }).click();
      await commitAssistant.getByRole("textbox", { name: "Commit message suggestion" }).waitFor();
      expect(await commitAssistant.getByRole("textbox", { name: "Commit message suggestion" }).inputValue()).toBe("feat: describe reviewed staged change");
      await commitAssistant.getByRole("button", { name: "Use suggestion" }).click();
      expect(await window.getByRole("textbox", { name: "Commit message", exact: true }).inputValue()).toBe("feat: describe reviewed staged change");
      const commitPrompt = String(providerBodies[1]?.messages && (providerBodies[1].messages as Array<{ content?: string }>)[0]?.content);
      expect(commitPrompt).toContain("reviewedTitle = 'staged'");
      expect(commitPrompt).not.toContain("reviewedTitle = 'unstaged'");
      expect(await execFileAsync("git", ["-C", fixture.path, "log", "-1", "--format=%s"])).toMatchObject({ stdout: "add source fixture\n" });

      await window.keyboard.press("Control+g");
      const summaryAssistant = window.getByRole("region", { name: "AI commit message suggestion" });
      await summaryAssistant.getByText("src/commit-ai.ts · staged/index · all staged changes").waitFor();
      await summaryAssistant.getByRole("combobox", { name: "AI output" }).selectOption("changeSummary");
      expect(await summaryAssistant.locator(".commitAiRequestDetails").innerText()).toContain("Summarize the reviewed staged changes");
      await summaryAssistant.getByRole("checkbox", { name: /I reviewed the staged diff/ }).check();
      await summaryAssistant.getByRole("button", { name: "Summarize reviewed staged diff" }).click();
      await summaryAssistant.locator(".commitAiSummary").waitFor();
      expect(await summaryAssistant.locator(".commitAiSummary").innerText()).toContain("Adds the reviewed staged export");
      expect(await window.getByRole("textbox", { name: "Commit message", exact: true }).inputValue()).toBe("feat: describe reviewed staged change");
      expect(await summaryAssistant.getByRole("button", { name: "Use suggestion" }).count()).toBe(0);
      await summaryAssistant.getByRole("button", { name: "Close" }).click();

      await execFileAsync("git", ["-C", fixture.path, "reset", "--quiet", "HEAD", "--", "src/commit-ai.ts"]);
      await rm(resolve(fixture.path, "src/commit-ai.ts"));
      await window.getByRole("button", { name: "Refresh working tree status" }).click();
      await window.waitForFunction(() => !document.body.innerText.includes("src/commit-ai.ts"));

      await window.keyboard.press("Control+b");
      const dirtySwitchDialog = window.getByRole("dialog", { name: "Switch branch" });
      await dirtySwitchDialog.waitFor();
      await dirtySwitchDialog.getByRole("button", { name: /feature\/e2e/ }).click();
      await dirtySwitchDialog.getByText("src/example.ts").waitFor();
      expect(await dirtySwitchDialog.getByText("May be overwritten").count()).toBe(1);
      expect(await dirtySwitchDialog.getByRole("button", { name: "Shelve & switch" }).isDisabled()).toBe(false);
      await dirtySwitchDialog.getByRole("button", { name: "Cancel" }).click();
      await dirtySwitchDialog.waitFor({ state: "detached" });
      expect(await window.getByTitle(/Switch branches \((?:Ctrl\+B|⌘B)\)/).innerText()).toContain(originalBranch);
      await window.getByRole("button", { name: "modified src/example.ts" }).click();
      const rendererErrors: string[] = [];
      window.on("console", (message) => { if (message.type() === "error") rendererErrors.push(message.text()); });
      const fullFileDiff = window.locator(".monacoFileDiff");
      await fullFileDiff.locator(".view-lines").first().waitFor({ state: "visible", timeout: 15_000 });
      await window.getByText("Difference 1 of 1").waitFor();
      const fullFileText = await fullFileDiff.innerText();
      expect(fullFileText).toContain("hello");
      expect(fullFileText).toContain("welcome");
      expect(await window.locator(".fileDiffSides").innerText()).toContain("Your version");
      await window.getByRole("button", { name: "Select lines…" }).click();
      await window.getByRole("button", { name: "Monaco view" }).click();
      const monacoLines = window.locator(".monacoDiffHunk .view-lines");
      await monacoLines.first().waitFor({ state: "visible", timeout: 15_000 });
      // Monaco lays its lines out after it becomes visible, so the text is polled rather than read once.
      await expect.poll(() => monacoLines.last().innerText(), { timeout: 10_000 }).toContain("welcome");
      const parsedHunk = window.locator(".monacoDiffHunk").first();
      await parsedHunk.waitFor({ state: "visible" });
      expect(["parsed", "recovered"], rendererErrors.join("\n")).toContain(await parsedHunk.getAttribute("data-tree-sitter-state"));

      const diffWindowPromise = app.waitForEvent("window");
      await window.getByRole("button", { name: "Open in Diff window" }).click();
      const diffWindow = await diffWindowPromise;
      await diffWindow.locator(".diffWindow").waitFor({ state: "visible" });
      // The header names the file it opened for and which side of it the diff reads.
      const diffTitle = diffWindow.locator(".diffWindowHeader h1");
      await diffTitle.waitFor({ state: "visible" });
      expect(await diffTitle.getAttribute("title")).toBe("src/example.ts");
      await diffWindow.locator(".diffWindowHeader .diffWindowScope").waitFor({ state: "visible" });
      await diffWindow.locator(".splitDiffRow").first().waitFor({ state: "visible" });
      expect(await diffWindow.locator(".diffWindowTabSelect").count()).toBe(2);
      await diffWindow.locator(".diffWindowTabSelect").filter({ hasText: "src/other.ts" }).click();
      await diffWindow.getByText("changed", { exact: false }).waitFor({ state: "visible" });
      // Blame annotates the split view in place rather than replacing it. The changed line is not
      // committed yet, so its annotation column is there but blank.
      const blameToggle = diffWindow.getByRole("button", { name: "Blame" });
      await blameToggle.click();
      expect(await blameToggle.getAttribute("aria-pressed")).toBe("true");
      const blamedRow = diffWindow.locator(".splitDiffRow.withBlame").first();
      await blamedRow.waitFor({ state: "visible" });
      expect(await blamedRow.innerText()).toContain("sibling = 'changed'");
      expect(await blamedRow.locator(".blameAnnotation").innerText()).toBe("");
      expect(await diffWindow.locator(".diffBlameNotice").count()).toBe(0);
      await diffWindow.locator(".diffWindowTabSelect").filter({ hasText: "src/example.ts" }).click();
      await diffWindow.locator(".splitDiffRow").first().waitFor({ state: "visible" });
      await diffWindow.getByRole("button", { name: "Close src/other.ts tab" }).click();
      // One file left needs no tab strip; the header still names it.
      await diffWindow.locator(".diffWindowTabs").waitFor({ state: "detached" });
      expect(await diffTitle.getAttribute("title")).toBe("src/example.ts");
      // A further Diff for the same repository opens as a tab in this window, not as another window.
      await window.getByRole("button", { name: "modified src/other.ts" }).click();
      await window.getByRole("button", { name: "Open in Diff window" }).click();
      await diffWindow.locator(".diffWindowTabSelect").filter({ hasText: "src/other.ts" }).waitFor({ state: "visible" });
      await expect.poll(() => diffTitle.getAttribute("title")).toBe("src/other.ts");
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2);
      await diffWindow.locator(".diffWindowTabSelect").filter({ hasText: "src/example.ts" }).click();
      await diffWindow.getByRole("button", { name: "Close src/other.ts tab" }).click();
      await diffWindow.locator(".diffWindowTabs").waitFor({ state: "detached" });
      // Back in the main window, return to src/example.ts in the Monaco hunk view that the checks below expect.
      // The line-selection mode stays on; the hunk view starts in Split for each file.
      await window.getByRole("button", { name: "modified src/example.ts" }).click();
      await window.getByRole("button", { name: "Monaco view" }).click();
      await window.locator(".monacoDiffHunk .view-lines").first().waitFor({ state: "visible", timeout: 15_000 });
      await diffWindow.getByRole("button", { name: "Unified" }).click();
      expect(await diffWindow.locator(".unifiedDiff").count()).toBe(1);
      // Blame stays on across tabs and layouts until it is turned off.
      await diffWindow.locator(".unifiedDiff.withBlame").waitFor({ state: "visible" });
      await blameToggle.click();
      await diffWindow.locator(".unifiedDiff.withBlame").waitFor({ state: "detached" });
      await diffWindow.keyboard.press("Control+\\");
      expect(await diffWindow.getByRole("button", { name: "Split", exact: true }).getAttribute("aria-pressed")).toBe("true");
      await diffWindow.keyboard.press("Control+\\");
      expect(await diffWindow.getByRole("button", { name: "Unified", exact: true }).getAttribute("aria-pressed")).toBe("true");
      expect(await diffWindow.getByRole("group", { name: /^Deleted line/ }).count()).toBeGreaterThan(0);
      expect(await diffWindow.getByRole("group", { name: /^Added line/ }).count()).toBeGreaterThan(0);
      const readonlyResult = await diffWindow.evaluate(async (repoId) => {
        const connection = await (globalThis.window as unknown as Window & {
          gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string; windowAccess: string }> };
        }).gitcrest.getSidecarConnection();
        const response = await fetch(new URL(`/api/v1/repositories/${encodeURIComponent(repoId)}/commits`, connection.baseUrl), {
          method: "POST",
          headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1", "Content-Type": "application/json" },
          body: JSON.stringify({ message: "must not commit from diff window" }),
        });
        return { access: connection.windowAccess, status: response.status };
      }, opened.body.repoId as string);
      expect(readonlyResult).toEqual({ access: "readOnly", status: 403 });
      await diffWindow.close();
      expect(await window.locator(".monacoDiffHunk").count()).toBeGreaterThan(0);

      await execFileAsync("git", ["-C", fixture.path, "checkout", "--", "src/example.ts", "src/other.ts"]);
      await window.getByRole("button", { name: "Refresh working tree status" }).click();
      await window.keyboard.press("Control+b");
      const cleanSwitchDialog = window.getByRole("dialog", { name: "Switch branch" });
      await cleanSwitchDialog.waitFor();
      await cleanSwitchDialog.getByRole("button", { name: /feature\/e2e/ }).click();
      await cleanSwitchDialog.getByText("The working tree is clean.").waitFor();
      await cleanSwitchDialog.getByRole("button", { name: "Switch to feature/e2e" }).click();
      await window.waitForFunction(() => [...document.querySelectorAll('button[title^="Switch branches"]')].some((button) => button.textContent?.includes("feature/e2e")), undefined, { timeout: 15_000 });

      await window.setViewportSize({ width: 900, height: 820 });
      // Narrow windows keep the view tabs and content, drop the path, and never scroll sideways.
      expect(await window.getByRole("tablist", { name: "Workspace views" }).isVisible()).toBe(true);
      expect(await window.locator(".viewMain").isVisible()).toBe(true);
      expect(await window.locator(".workspaceCrumb").isVisible()).toBe(false);
      expect(await window.evaluate(() => document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
      await window.setViewportSize({ width: 1280, height: 820 });

      const mainOid = (await execFileAsync("git", ["-C", fixture.path, "rev-parse", originalBranch])).stdout.trim();
      const rebaseApiPreview = await window.evaluate(async ({ repoId, ontoOid }) => {
        const connection = await (globalThis.window as unknown as Window & {
          gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
        }).gitcrest.getSidecarConnection();
        const url = new URL(`/api/v1/repositories/${encodeURIComponent(repoId)}/workflows/rebase-preview`, connection.baseUrl);
        url.searchParams.set("ontoOid", ontoOid);
        const response = await fetch(url, { headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1" } });
        return { status: response.status, body: await response.json() };
      }, { repoId: opened.body.repoId as string, ontoOid: mainOid });
      expect(rebaseApiPreview.status).toBe(200);
      expect(rebaseApiPreview.body.commits.map((commit: { subject: string }) => commit.subject)).toContain("change feature branch");
      const tasksDialogBeforeRebase = window.getByRole("dialog", { name: "Tasks" });
      if (await tasksDialogBeforeRebase.count()) await tasksDialogBeforeRebase.getByRole("button", { name: "Close tasks" }).click();
      await window.keyboard.press("Control+i");
      const rebaseDialog = window.getByRole("dialog", { name: "Interactive rebase" });
      await rebaseDialog.waitFor();
      await rebaseDialog.getByLabel("Rebase current branch onto").selectOption(mainOid);
      await rebaseDialog.getByRole("button", { name: "Refresh preview" }).click();
      try {
        await rebaseDialog.getByText("change feature branch").waitFor({ timeout: 10_000 });
      } catch {
        throw new Error(`Rebase preview did not load the expected commit: ${await rebaseDialog.innerText()}`);
      }
      const rebaseAction = rebaseDialog.locator("select[aria-label^='Action for']").first();
      await rebaseAction.selectOption("reword");
      await rebaseDialog.getByLabel(/Replacement message/).fill("Interactive rebase E2E message");
      await rebaseDialog.getByRole("button", { name: "Start rebase" }).click();
      const rebaseTaskCard = window.locator(".taskCard").filter({ has: window.locator(".taskCardHeading strong", { hasText: "rebase" }) });
      await rebaseTaskCard.waitFor({ state: "visible" });
      await window.waitForFunction(() => Array.from(document.querySelectorAll(".taskCard")).some((card) => card.querySelector(".taskCardHeading strong")?.textContent === "rebase" && card.querySelector(".taskStatus")?.textContent === "succeeded"), undefined, { timeout: 20_000 });
      await rebaseTaskCard.locator(".taskLogs summary").click();
      expect(await rebaseTaskCard.innerText()).toContain("refs/gitcrest/rebase-backups/");
      expect((await execFileAsync("git", ["-C", fixture.path, "log", "-1", "--format=%s"])).stdout.trim()).toBe("Interactive rebase E2E message");

      await window.getByRole("dialog", { name: "Tasks" }).getByRole("button", { name: "Close tasks" }).click();
      await window.keyboard.press("Control+i");
      const rollbackDialog = window.getByRole("dialog", { name: "Interactive rebase" });
      await rollbackDialog.waitFor();
      await rollbackDialog.getByLabel(/moves the current branch/).check();
      await rollbackDialog.getByRole("button", { name: "Restore selected backup" }).click();
      const rollbackTaskCard = window.locator(".taskCard").filter({ has: window.locator(".taskCardHeading strong", { hasText: "rebaseRollback" }) });
      await rollbackTaskCard.waitFor({ state: "visible" });
      await window.waitForFunction(() => Array.from(document.querySelectorAll(".taskCard")).some((card) => card.querySelector(".taskCardHeading strong")?.textContent === "rebaseRollback" && card.querySelector(".taskStatus")?.textContent === "succeeded"), undefined, { timeout: 20_000 });
      expect((await execFileAsync("git", ["-C", fixture.path, "log", "-1", "--format=%s"])).stdout.trim()).toBe("change feature branch");

      await window.getByRole("dialog", { name: "Tasks" }).getByRole("button", { name: "Close tasks" }).click();
      await window.keyboard.press("Control+k");
      const commandPalette = window.getByRole("dialog", { name: "Command palette" });
      await commandPalette.getByRole("button", { name: /Reset current branch/ }).click();
      const resetDialog = window.getByRole("dialog", { name: "Reset current branch" });
      await resetDialog.waitFor();
      await resetDialog.locator("#reset-target").selectOption(mainOid);
      await resetDialog.getByRole("button", { name: "Review impact" }).click();
      await resetDialog.getByText(/Affected paths/).waitFor();
      await resetDialog.getByLabel(/I reviewed the commit and path impact/).check();
      const featureOidBeforeReset = (await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD"])).stdout.trim();
      await resetDialog.getByRole("button", { name: "Reset mixed" }).click();
      const resetTaskCard = window.locator(".taskCard").filter({ has: window.locator(".taskCardHeading strong", { hasText: "reset" }) });
      await resetTaskCard.waitFor({ state: "visible" });
      await window.waitForFunction(() => Array.from(document.querySelectorAll(".taskCard")).some((card) => card.querySelector(".taskCardHeading strong")?.textContent === "reset" && card.querySelector(".taskStatus")?.textContent === "succeeded"), undefined, { timeout: 20_000 });
      expect((await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD"])).stdout.trim()).toBe(mainOid);

      await window.getByRole("dialog", { name: "Tasks" }).getByRole("button", { name: "Close tasks" }).click();
      await execFileAsync("git", ["-C", fixture.path, "restore", "--worktree", "--", "."]);
      await execFileAsync("git", ["-C", fixture.path, "clean", "-f"]);
      await window.keyboard.press("Control+k");
      const restorePalette = window.getByRole("dialog", { name: "Command palette" });
      await restorePalette.getByRole("button", { name: /Reset current branch/ }).click();
      const restoreResetDialog = window.getByRole("dialog", { name: "Reset current branch" });
      await restoreResetDialog.getByRole("button", { name: "Restore selected reset backup" }).waitFor({ state: "visible" });
      await restoreResetDialog.getByLabel(/replaces the current branch and checked-out files/).check();
      await restoreResetDialog.getByRole("button", { name: "Restore selected reset backup" }).click();
      const restoreTaskCard = window.locator(".taskCard").filter({ has: window.locator(".taskCardHeading strong", { hasText: "resetRestore" }) });
      await restoreTaskCard.waitFor({ state: "visible" });
      await window.waitForFunction(() => Array.from(document.querySelectorAll(".taskCard")).some((card) => card.querySelector(".taskCardHeading strong")?.textContent === "resetRestore" && card.querySelector(".taskStatus")?.textContent === "succeeded"), undefined, { timeout: 20_000 });
      expect((await execFileAsync("git", ["-C", fixture.path, "rev-parse", "HEAD"])).stdout.trim()).toBe(featureOidBeforeReset);

      await window.getByRole("dialog", { name: "Tasks" }).getByRole("button", { name: "Close tasks" }).click();
      const stagedBeforeUndo = (await execFileAsync("git", ["-C", fixture.path, "diff", "--cached", "--name-only"])).stdout.trim();
      await writeFile(resolve(fixture.path, "src/undo-me.ts"), "export const undoMe = true;\n");
      await window.getByRole("button", { name: "Refresh working tree status" }).click();
      await window.getByRole("button", { name: "untracked src/undo-me.ts", exact: true }).waitFor();
      const stageAllButton = window.getByRole("button", { name: "Stage all", exact: true });
      await window.waitForFunction(() => {
        const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.getAttribute("aria-label") === "Stage all");
        return Boolean(button && !button.disabled);
      }, undefined, { timeout: 5000 });
      await stageAllButton.click();
      await expect.poll(async () => (await execFileAsync("git", ["-C", fixture.path, "diff", "--cached", "--name-only", "--", "src/undo-me.ts"])).stdout.trim(), { timeout: 10_000 }).toBe("src/undo-me.ts");
      await expect.poll(() => window.getByRole("checkbox", { name: "Stage src/undo-me.ts", exact: true }).isChecked(), { timeout: 15_000 }).toBe(true);
      // Undo is refused while the staging task still counts as running.
      await window.getByRole("button", { name: "Background tasks, 0 active" }).waitFor({ timeout: 10_000 });
      // Successful staging reports through the titlebar; the Tasks dialog stays closed.
      expect(await window.getByRole("dialog", { name: "Tasks" }).count()).toBe(0);
      const refreshStatusButton = window.getByRole("button", { name: "Refresh working tree status" });
      await refreshStatusButton.focus();
      expect(await window.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Refresh working tree status");
      await window.keyboard.press("Control+z");
      const undoTask = window.locator(".taskCard").filter({ has: window.locator(".taskCardHeading strong", { hasText: "undoRecentOperation" }) });
      await undoTask.waitFor({ state: "visible", timeout: 5000 });
      await window.waitForFunction(() => Array.from(document.querySelectorAll(".taskCard")).some((card) => card.querySelector(".taskCardHeading strong")?.textContent === "undoRecentOperation" && card.querySelector(".taskStatus")?.textContent === "succeeded"), undefined, { timeout: 10_000 });
      const stagedAfterUndo = (await execFileAsync("git", ["-C", fixture.path, "diff", "--cached", "--name-only"])).stdout.trim();
      expect(stagedAfterUndo).toBe(stagedBeforeUndo);
      expect((await execFileAsync("git", ["-C", fixture.path, "status", "--porcelain", "--", "src/undo-me.ts"])).stdout.trim()).toBe("?? src/undo-me.ts");

      const forgotten = await window.evaluate(async (repoId) => {
        const connection = await (globalThis.window as unknown as Window & {
          gitcrest: { getSidecarConnection: () => Promise<{ baseUrl: string; token: string }> };
        }).gitcrest.getSidecarConnection();
        const response = await fetch(new URL(`/api/v1/repositories/${encodeURIComponent(repoId)}`, connection.baseUrl), {
          method: "DELETE",
          headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1" },
        });
        return response.status;
      }, opened.body.repoId as string);
      expect(forgotten).toBe(204);

      if (process.env.GITCREST_CAPTURE_E2E === "1") {
        const evidencePath = resolve("doc/evidence/S0.4");
        await mkdir(evidencePath, { recursive: true });
        await window.getByRole("button", { name: "Go to Welcome", exact: true }).click();
        await window.screenshot({ path: resolve(evidencePath, "welcome.png") });
        const themeButton = window.getByRole("button", { name: /Color theme:/ });
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if ((await themeButton.getAttribute("aria-label"))?.includes("dark")) break;
          await themeButton.click();
        }
        await window.screenshot({ path: resolve(evidencePath, "welcome-dark.png") });
        await window.getByRole("tab", { name: basename(fixture.path), exact: true }).click();
        await window.screenshot({ path: resolve(evidencePath, "workspace-dark.png") });
        await themeButton.click();
        await window.screenshot({ path: resolve(evidencePath, "workspace-light.png") });
      }
    } finally {
      await app?.close();
      app = undefined;
      await fixture.cleanup();
      await rm(appDataPath, { recursive: true, force: true });
    }
  }, 90_000);
});
