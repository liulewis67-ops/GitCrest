import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication } from "playwright";
import { expect, it } from "vitest";

const run = promisify(execFile);

it("opens seeded review data with history, changes and a commit composer", async () => {
  const { stdout } = await run(process.execPath, ["scripts/review-fixture.mjs"]);
  const path = stdout.trim();
  const appData = await mkdtemp(join(tmpdir(), "gitcrest-review-app-"));
  let app: ElectronApplication | undefined;
  try {
    const git = async (...args: string[]) => (await run("git", ["-C", path, ...args])).stdout.trim();
    expect(await git("rev-list", "--left-right", "--count", "HEAD...origin/main")).toBe("1\t1");
    expect(Number(await git("rev-list", "--all", "--count"))).toBeGreaterThanOrEqual(26);
    expect((await git("tag")).split("\n")).toHaveLength(2);
    expect(await git("status", "--short")).toContain("notes.txt -> review-notes.txt");
    expect(await git("log", "--all", "--graph", "--oneline")).toContain("Merge release notes");
    app = await electron.launch({
      args: [".", "--lang=en-US", "--disable-gpu", `--user-data-dir=${join(appData, "profile")}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: join(appData, "gitcrest.sqlite") },
    });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.evaluate(() => {
      window.localStorage.setItem("gitcrest-locale", "en");
      window.localStorage.removeItem("gitcrest-diff-view-v1");
    });
    await window.reload();
    await window.getByText("Core connected").waitFor({ timeout: 40_000 });
    await app.evaluate(({ dialog }, destination) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] });
    }, path);
    await window.getByRole("button", { name: /^Open local repository/ }).click();
    await window.locator(".workspaceCrumb").waitFor();
    await window.getByRole("textbox", { name: "Commit message", exact: true }).waitFor();
    await window.getByText("untracked.md", { exact: true }).first().waitFor();
    await window.getByText("README.md", { exact: true }).first().click();
    await window.locator(".view-lines").first().waitFor().catch(async () => {
      throw new Error(`Review diff did not load: ${await window.locator("body").innerText()}`);
    });
    await window.getByRole("tab", { name: "History", exact: true }).click();
    await window.locator(".commitGraphRow").first().waitFor();
  } finally {
    await app?.close();
    await rm(dirname(path), { recursive: true, force: true });
    await rm(appData, { recursive: true, force: true });
  }
}, 120_000);
