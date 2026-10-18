import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { createTempGitRepository } from "../fixtures/temp-repo";

const execFileAsync = promisify(execFile);

describe("shelf workflow E2E", () => {
  let app: ElectronApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("creates a shelf from selected working-tree changes and restores it after reviewed apply", async () => {
    const fixture = await createTempGitRepository();
    const appDataPath = await mkdtemp(resolve(tmpdir(), "gitcrest-shelf-e2e-app-data-"));
    const sourcePath = resolve(fixture.path, "src/shelved.ts");
    const original = "export const draft = 'base';\n";
    const changed = "export const draft = 'saved in shelf';\n";

    try {
      await mkdir(resolve(fixture.path, "src"), { recursive: true });
      await writeFile(sourcePath, original);
      await execFileAsync("git", ["-C", fixture.path, "add", "src/shelved.ts"]);
      await execFileAsync("git", ["-C", fixture.path, "commit", "--quiet", "-m", "add shelf fixture"]);
      await writeFile(sourcePath, changed);

      app = await electron.launch({
        args: [".", "--disable-gpu"],
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
        return { status: response.status, body: await response.json() };
      }, fixture.path);
      expect(opened.status).toBe(200);

      await window.reload();
      await window.getByRole("heading", { name: "Recent repositories" }).waitFor();
      await window.locator(".repositoryRowOpen").click();
      await window.locator(".workspaceCrumb").waitFor();
      await window.getByRole("button", { name: "Workspace", exact: true }).click();
      await window.getByRole("button", { name: "Refresh working tree status" }).click();

      await window.getByRole("button", { name: "Shelve selected changes" }).click();
      const composer = window.getByRole("dialog", { name: "Shelve selected changes" });
      await composer.getByRole("textbox", { name: "Name" }).fill("E2E working-tree shelf");
      const fileCheckbox = composer.getByRole("checkbox", { name: /src\/shelved\.ts/ });
      await fileCheckbox.click();
      await expect.poll(() => fileCheckbox.isChecked()).toBe(true);
      await composer.getByRole("button", { name: "Create shelf" }).click();

      const shelfButton = window.locator(".shelfSelectButton").filter({ hasText: "E2E working-tree shelf" });
      await shelfButton.waitFor({ state: "visible", timeout: 15_000 });
      await window.getByRole("button", { name: /Background tasks/ }).click();
      const createTask = window.locator(".taskCard").filter({ has: window.locator(".taskCardHeading strong", { hasText: "shelfCreate" }) });
      await createTask.waitFor({ state: "visible" });
      await window.waitForFunction(() => {
        const card = [...document.querySelectorAll(".taskCard")].find((entry) => entry.querySelector(".taskCardHeading strong")?.textContent === "shelfCreate");
        return Boolean(card && !["queued", "running"].includes(card.querySelector(".taskStatus")?.textContent || ""));
      }, undefined, { timeout: 15_000 });
      const createTaskBody = await createTask.innerText();
      if (!createTaskBody.includes("Succeeded")) throw new Error(`Shelf creation task did not succeed: ${createTaskBody}`);
      expect((await readFile(sourcePath, "utf8")).replace(/\r\n/g, "\n")).toBe(original);
      expect((await execFileAsync("git", ["-C", fixture.path, "diff", "--", "src/shelved.ts"])).stdout).toBe("");
      await window.getByRole("dialog", { name: "Tasks" }).getByRole("button", { name: "Close tasks" }).click();

      await shelfButton.click();
      const detail = window.getByRole("region", { name: "Shelf preview: E2E working-tree shelf" });
      await detail.waitFor();
      await expect.poll(() => detail.locator(".shelfPatchPreview").innerText()).toContain("saved in shelf");
      await detail.getByRole("button", { name: "Preview apply" }).click();
      await detail.getByRole("status").filter({ hasText: "Patch applies cleanly" }).waitFor();
      await detail.getByRole("button", { name: "Apply reviewed shelf" }).click();

      await expect.poll(async () => (await readFile(sourcePath, "utf8")).replace(/\r\n/g, "\n"), { timeout: 15_000 }).toBe(changed);
      await expect.poll(() => shelfButton.count(), { timeout: 15_000 }).toBe(0);
    } finally {
      await app?.close();
      app = undefined;
      await fixture.cleanup();
      await rm(appDataPath, { recursive: true, force: true });
    }
  }, 60_000);
});
