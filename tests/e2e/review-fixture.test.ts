import { openTaskDetails } from "./task-details";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
    const extraRemote = join(dirname(path), "extra-remote.git");
    await run("git", ["clone", "--bare", "--quiet", path, extraRemote]);
    await git("remote", "add", "extra", extraRemote);
    const expectedRemoteHead = await git("rev-parse", "HEAD");
    await run("git", ["--git-dir", extraRemote, "update-ref", "refs/heads/fetch-all-check", expectedRemoteHead]);
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
    await window.locator(".workspaceToolbar").waitFor();
    await window.getByRole("textbox", { name: "Commit message", exact: true }).waitFor();
    const fetchAll = window.getByRole("button", { name: "Fetch all remotes", exact: true });
    expect(await fetchAll.evaluate((node) => node.previousElementSibling?.classList.contains("syncGroup"))).toBe(true);
    await fetchAll.click();
    await (await openTaskDetails(window)).locator('.taskCard:has(strong[data-operation="fetch"]) .taskStatus[data-status="succeeded"]').waitFor();
    expect(await git("rev-parse", "refs/remotes/extra/fetch-all-check")).toBe(expectedRemoteHead);
    expect(await git("rev-parse", "refs/remotes/origin/main")).not.toBe(expectedRemoteHead);
    await window.getByRole("button", { name: "Close tasks", exact: true }).click();
    await window.getByText("untracked.md", { exact: true }).first().waitFor();
    await window.getByText("README.md", { exact: true }).first().click();
    await window.locator(".view-lines").first().waitFor().catch(async () => {
      throw new Error(`Review diff did not load: ${await window.locator("body").innerText()}`);
    });
    await window.locator(".workspaceToolbar .branchSelector:not(.worktreeSelector)").click();
    const picker = window.getByRole("dialog", { name: "Switch branch", exact: true });
    await picker.getByRole("button", { name: "main", exact: true }).waitFor();
    await picker.getByRole("button", { name: "More actions for origin/main", exact: true }).waitFor();
    await run("git", ["--git-dir", extraRemote, "update-ref", "refs/heads/picker-refresh", expectedRemoteHead]);
    await picker.getByRole("button", { name: "Fetch all remotes", exact: true }).click();
    await picker.getByRole("button", { name: "More actions for extra/picker-refresh", exact: true }).waitFor({ timeout: 20_000 });
    expect(await window.getByRole("dialog", { name: "Tasks", exact: true }).count()).toBe(0);
    await picker.getByRole("button", { name: "More actions for origin/main", exact: true }).click();
    const remoteMenu = window.getByRole("menu", { name: "Actions for origin/main", exact: true });
    await remoteMenu.getByRole("menuitem", { name: "Check out as local branch…", exact: true }).waitFor({ timeout: 5_000 }).catch(async () => {
      if (process.env.GITCREST_LAYOUT_CAPTURE_DIR) {
        await mkdir(process.env.GITCREST_LAYOUT_CAPTURE_DIR, { recursive: true });
        await window.screenshot({ path: join(process.env.GITCREST_LAYOUT_CAPTURE_DIR, "branch-menu-diagnostic.png") });
      }
      throw new Error(`Branch menu unavailable: ${await window.locator('body').innerText()}`);
    });
    await remoteMenu.getByRole("menuitem", { name: "Rebase current branch onto origin/main…", exact: true }).waitFor();
    await window.keyboard.press("Escape");
    expect(await picker.isVisible()).toBe(true);
    await picker.getByRole("button", { name: "More actions for feature/search", exact: true }).click();
    await window.getByRole("menu").getByRole("menuitem", { name: "Rename…", exact: true }).click();
    expect(await picker.count()).toBe(0);
    const renameDialog = window.getByRole("dialog").filter({ has: window.getByRole("heading", { name: /Rename/ }) });
    await renameDialog.waitFor();
    await renameDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await window.getByRole("tab", { name: "History", exact: true }).click();
    await window.locator(".commitGraphRow").first().waitFor();
    const cdp = await window.context().newCDPSession(window);
    for (const [width, height, locale, theme] of [[1366, 728, "en", "light"], [1440, 900, "zh", "dark"], [960, 700, "zh", "light"], [1920, 1080, "en", "dark"]] as const) {
      await window.evaluate(({ locale, theme }) => {
        localStorage.setItem("gitcrest-locale", locale);
        localStorage.setItem("gitcrest-appearance-v1", JSON.stringify({ mode: theme }));
      }, { locale, theme });
      await window.reload();
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await window.locator(".commitGraphRow").first().waitFor();
      const geometry = await window.evaluate(() => {
        const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        const branch = rect(".repositoryControls"), views = rect(".viewSwitcher"), actions = rect(".toolbarActions");
        return { titlebar: rect(".titlebar").height, toolbar: rect(".workspaceToolbar").height, row: rect(".commitGraphRow").height, ordered: branch.right <= views.left && views.right <= actions.left, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      expect(geometry).toEqual({ titlebar: 40, toolbar: 44, row: 32, ordered: true, overflow: false });
      const viewportBefore = await window.locator(".graphViewport").boundingBox();
      const filterToggle = window.locator(".historyFilterToggle");
      await filterToggle.click();
      await window.locator(".historyAdvancedFilters").waitFor();
      expect(await window.locator(".graphViewport").boundingBox()).toEqual(viewportBefore);
      await window.keyboard.press("Escape");
      expect(await filterToggle.evaluate((node) => node === document.activeElement)).toBe(true);
      if (process.env.GITCREST_LAYOUT_CAPTURE_DIR) {
        await mkdir(process.env.GITCREST_LAYOUT_CAPTURE_DIR, { recursive: true });
        await window.screenshot({ path: join(process.env.GITCREST_LAYOUT_CAPTURE_DIR, `workspace-${width}-${locale}-${theme}.png`) });
        await window.locator("#workspace-tab-changes").click();
        await window.locator(".commitComposer").waitFor();
        await window.locator(".view-lines").first().waitFor();
        await window.screenshot({ path: join(process.env.GITCREST_LAYOUT_CAPTURE_DIR, `changes-${width}-${locale}-${theme}.png`) });
        await window.locator(".workspaceToolbar .branchSelector:not(.worktreeSelector)").click();
        await window.locator(".branchPickerRow.current").waitFor();
        await window.screenshot({ path: join(process.env.GITCREST_LAYOUT_CAPTURE_DIR, `branch-picker-${width}-${locale}-${theme}.png`) });
        await window.locator(".branchPickerRow").filter({ has: window.getByRole("button", { name: locale === "en" ? "More actions for origin/main" : "origin/main 的更多操作", exact: true }) }).locator(".branchChoice").click({ button: "right" });
        await window.getByRole("menu").waitFor();
        await window.screenshot({ path: join(process.env.GITCREST_LAYOUT_CAPTURE_DIR, `branch-picker-menu-${width}-${locale}-${theme}.png`) });
        await window.keyboard.press("Escape");
        await window.keyboard.press("Escape");
        await window.locator("#workspace-tab-history").click();
      }
    }
  } finally {
    await app?.close();
    await rm(dirname(path), { recursive: true, force: true });
    await rm(appData, { recursive: true, force: true });
  }
}, 120_000);
