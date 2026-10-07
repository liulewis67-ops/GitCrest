import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { createTempGitRepository } from "../fixtures/temp-repo";

const execFileAsync = promisify(execFile);

describe("desktop startup E2E", () => {
  let app: ElectronApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("starts Electron and the authenticated sidecar with a disposable Git fixture", async () => {
    const fixture = await createTempGitRepository();
    const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-e2e-app-data-"));
    try {
      expect(fixture.path).toContain("gitcrest-e2e-");

      app = await electron.launch({
        args: ["."],
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

      await window.reload();
      await window.getByRole("heading", { name: "Recent repositories" }).waitFor();
      expect(await window.locator(".repositoryList").innerText()).toContain(fixture.path);
      await window.locator(".repositoryRowOpen").click();
      await window.locator(".workspaceCrumb").waitFor();
      expect(await window.locator(".workspaceCrumb").innerText()).toContain(fixture.path);

      await window.getByRole("button", { name: "Workspace", exact: true }).click();
      await mkdir(resolve(fixture.path, "src"), { recursive: true });
      await writeFile(resolve(fixture.path, "src/example.ts"), "export const greeting = 'hello';\n");
      await execFileAsync("git", ["-C", fixture.path, "add", "src/example.ts"]);
      await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-m", "add source fixture"]);
      await writeFile(resolve(fixture.path, "src/example.ts"), "export const greeting = 'welcome';\n");
      await window.getByRole("button", { name: "Refresh working tree status" }).click();
      await window.getByRole("button", { name: "modified src/example.ts" }).click();
      const rendererErrors: string[] = [];
      window.on("console", (message) => { if (message.type() === "error") rendererErrors.push(message.text()); });
      await window.getByRole("button", { name: "Monaco view" }).click();
      const monacoLines = window.locator(".monacoDiffHunk .view-lines");
      await monacoLines.first().waitFor({ state: "visible", timeout: 15_000 });
      expect(await monacoLines.last().innerText()).toContain("welcome");
      const parsedHunk = window.locator(".monacoDiffHunk").first();
      await parsedHunk.waitFor({ state: "visible" });
      expect(["parsed", "recovered"], rendererErrors.join("\n")).toContain(await parsedHunk.getAttribute("data-tree-sitter-state"));

      await window.setViewportSize({ width: 900, height: 820 });
      expect(await window.locator(".navigationPanel").isVisible()).toBe(false);
      expect(await window.locator(".mainPanel").isVisible()).toBe(true);
      expect(await window.locator(".commitSection").isVisible()).toBe(false);
      await window.setViewportSize({ width: 1280, height: 820 });

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
        await window.getByRole("button", { name: "Welcome", exact: true }).click();
        await window.screenshot({ path: resolve(evidencePath, "welcome.png") });
        const themeButton = window.getByRole("button", { name: /Color theme:/ });
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if ((await themeButton.getAttribute("aria-label"))?.includes("dark")) break;
          await themeButton.click();
        }
        await window.screenshot({ path: resolve(evidencePath, "welcome-dark.png") });
        await window.getByRole("button", { name: "Workspace", exact: true }).click();
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
  });
});
