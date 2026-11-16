import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication } from "playwright";
import { expect, it } from "vitest";
import { createTempGitRepository } from "../fixtures/temp-repo";

const run = promisify(execFile);

it("keeps subjects readable beyond a dense commit graph in a narrow window", async () => {
  const fixture = await createTempGitRepository();
  const appData = await mkdtemp(join(tmpdir(), "gitcrest-graph-layout-"));
  const git = async (...args: string[]) => (await run("git", ["-C", fixture.path, ...args])).stdout.trim();
  let app: ElectronApplication | undefined;
  try {
    await git("commit", "--allow-empty", "-m", "Shared base");
    const base = await git("rev-parse", "HEAD");
    const tree = await git("rev-parse", "HEAD^{tree}");
    for (let index = 0; index < 40; index += 8) {
      await Promise.all(Array.from({ length: 8 }, async (_, offset) => {
        const branch = `topic-${index + offset}`;
        const tip = await git("commit-tree", tree, "-p", base, "-m", branch);
        await git("branch", branch, tip);
      }));
    }
    app = await electron.launch({
      args: [".", "--lang=en-US", "--disable-gpu", `--user-data-dir=${join(appData, "profile")}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: join(appData, "gitcrest.sqlite") },
    });
    const page = await app.firstWindow({ timeout: 20_000 });
    page.setDefaultTimeout(15_000);
    await page.waitForLoadState("domcontentloaded");
    await page.locator(".connectionBadge.connected").waitFor();
    await app.evaluate(({ BrowserWindow, dialog }, path) => {
      BrowserWindow.getAllWindows()[0].setSize(960, 700);
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, fixture.path);
    await page.getByRole("button", { name: /^Open local repository/ }).click();
    await page.getByRole("tab", { name: "History", exact: true }).click();
    const viewport = page.locator(".graphViewport");
    await page.locator(".commitGraphEntry").first().waitFor();
    await viewport.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    const row = page.locator(`[data-commit-oid="${base}"]`);
    await row.waitFor({ state: "attached" });
    await viewport.evaluate((node) => { node.scrollLeft = node.scrollWidth; });
    const subject = row.locator(".commitGraphSubject");
    await expect.poll(() => subject.evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      const view = node.closest(".graphViewport")!.getBoundingClientRect();
      return Math.min(bounds.right, view.right) - Math.max(bounds.left, view.left);
    })).toBeGreaterThanOrEqual(120);
    await subject.click();
    await expect.poll(() => row.getAttribute("aria-current")).toBe("true");
    await row.press("ArrowUp");
    await expect.poll(() => row.getAttribute("aria-current")).toBeNull();
  } finally {
    await app?.close();
    await fixture.cleanup();
    await rm(appData, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}, 90_000);
