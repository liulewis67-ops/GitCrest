import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { expect, it } from "vitest";
const run = promisify(execFile);

async function contrast(page: Page, selector: string, placeholder = false) {
  return page.locator(selector).first().evaluate((element, placeholder) => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const parse = (color: string) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].map((value, index) => index === 3 ? value / 255 : value); };
    const over = (front: number[], back: number[]) => [0, 1, 2].map((index) => front[index] * front[3] + back[index] * (1 - front[3])).concat(1);
    const ancestors: Element[] = []; for (let node: Element | null = element; node; node = node.parentElement) ancestors.unshift(node);
    let background = [255, 255, 255, 1];
    for (const node of ancestors) background = over(parse(getComputedStyle(node).backgroundColor), background);
    const style = getComputedStyle(element, placeholder ? "::placeholder" : undefined);
    const foreground = over(parse(style.color), background);
    const luminance = (rgb: number[]) => rgb.slice(0, 3).map((value) => { const n = value / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4; }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    const a = luminance(foreground), b = luminance(background);
    return { ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), foreground, background, opacity: style.opacity };
  }, placeholder);
}

it("keeps default-theme metadata readable and recent rows keyboard accessible in the rendered desktop", async () => {
  const { stdout } = await run(process.execPath, ["scripts/review-fixture.mjs"]);
  const fixture = stdout.trim();
  const appData = await mkdtemp(join(tmpdir(), "gitcrest-visual-cues-"));
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [".", "--lang=en-US", "--disable-gpu", `--user-data-dir=${join(appData, "profile")}`], env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: join(appData, "gitcrest.sqlite") } });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.locator(".connectionBadge.connected").waitFor({ timeout: 40_000 });
    await app.evaluate(({ dialog }, destination) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] }); }, fixture);
    await page.getByRole("button", { name: "Open local repository", exact: true }).click();
    await page.locator(".changeTreeRow").nth(9).waitFor();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 960, height: 700, deviceScaleFactor: 1, mobile: false });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => { localStorage.setItem("gitcrest-locale", "en"); localStorage.setItem("gitcrest-appearance-v1", JSON.stringify({ mode: theme })); localStorage.setItem("gitcrest-diff-view-v1", JSON.stringify({ layout: "full", sideBySide: true, structureOutline: true })); }, theme);
      await page.reload();
      await page.locator(".workspaceToolbar").waitFor({ state: "attached" });
      await page.getByRole("tab", { name: /^Workspace/ }).click();
      await page.locator(".changeTreeRow").nth(9).waitFor();
      await page.locator(".changeTreeFile").filter({ hasText: "layout-1.md" }).click();
      await page.locator(".fileDiffViewer").waitFor();
      expect(await page.locator(".toolbarHeadMark").innerText()).toBe("HEAD");
      expect(await page.evaluate(() => document.documentElement.dataset.graphColors)).toBe("lanes");
      for (const selector of [".status-added.statusFileCode", ".status-renamed.statusFileCode", ".composerStatus > span:last-child"]) {
        const result = await contrast(page, selector);
        expect(result.ratio, `${theme}: ${selector} ${JSON.stringify(result)}`).toBeGreaterThanOrEqual(4.5);
      }
      const panels = await page.locator(".fileDiffBody").evaluate((node) => { const outline = node.querySelector(".structureOutline")?.getBoundingClientRect(); const main = node.querySelector(".fileDiffMain")!.getBoundingClientRect(); return { outlineRight: outline?.right ?? main.left, mainLeft: main.left }; });
      expect(panels.outlineRight).toBeLessThanOrEqual(panels.mainLeft + 1);
      await page.keyboard.press("Control+2");
      await page.locator(".branchRemotePrefix").waitFor();
      for (const selector of [".branchRemotePrefix", ".branchCurrentLabel"]) expect((await contrast(page, selector)).ratio, `${theme}: ${selector}`).toBeGreaterThanOrEqual(4.5);
      await page.locator(".commitGraphRow").first().click();
      await page.locator(".commitFileButton .added").first().waitFor();
      await page.locator(".commitFileButton").first().click();
      expect((await contrast(page, ".commitFileButton .added")).ratio, `${theme}: selected history additions`).toBeGreaterThanOrEqual(4.5);
      await page.keyboard.press("Control+k");
      const search = page.getByRole("textbox", { name: "Search commands" });
      await search.fill("Create branch at current commit");
      await page.getByRole("button", { name: "Create branch at current commit", exact: true }).click();
      const placeholder = await contrast(page, ".cloneField input", true);
      expect(placeholder.opacity).toBe("1");
      expect(placeholder.ratio, `${theme}: branch placeholder`).toBeGreaterThanOrEqual(4.5);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("menuitem", { name: /All settings/ }).click();
      for (const selector of [".diffPreviewAdd", ".diffPreviewDel"]) expect((await contrast(page, selector)).ratio, `${theme}: ${selector}`).toBeGreaterThanOrEqual(4.5);
      await page.getByRole("button", { name: "Close settings", exact: true }).click();
      await page.locator(".brandButton").click();
      const help = page.getByRole("button", { name: "Help", exact: true });
      await help.click();
      const guide = page.getByRole("dialog", { name: "GitCrest guide" });
      await guide.getByRole("searchbox", { name: "Search help" }).fill("signing key");
      expect(await guide.locator(".quickGuideTopic").count()).toBe(1);
      await page.keyboard.press("Escape");
      expect(await help.evaluate((node) => node === document.activeElement)).toBe(true);
      const row = page.locator(".repositoryRow").first();
      expect(await row.evaluate((node) => [...node.querySelectorAll<HTMLElement>("button")].filter((button) => button.tabIndex === 0).length)).toBe(1);
      const primary = row.locator(".repositoryRowOpen");
      await primary.focus(); await page.keyboard.press("ArrowRight");
      expect(await row.locator(".repositoryRowAction").first().evaluate((node) => node === document.activeElement)).toBe(true);
      await page.keyboard.press("ArrowLeft");
      expect(await primary.evaluate((node) => node === document.activeElement)).toBe(true);
      expect((await contrast(page, ".repositoryIdentity small")).ratio).toBeGreaterThanOrEqual(4.5);
      await page.keyboard.press("Enter");
      await page.locator(".welcomePage").waitFor({ state: "hidden" });
      await page.getByRole("tab", { name: /^Workspace/ }).click();
      await page.locator(".changeTreeRow").nth(9).waitFor();
    }
  } finally {
    await app?.close();
    await rm(dirname(fixture), { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    await rm(appData, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}, 180_000);
