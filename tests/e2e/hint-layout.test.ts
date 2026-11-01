import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication } from "playwright";
import { expect, it } from "vitest";

const run = promisify(execFile);

it("keeps the first-run dismiss label on one line and eight change rows visible", async () => {
  const { stdout } = await run(process.execPath, ["scripts/review-fixture.mjs"]);
  const path = stdout.trim();
  const appData = await mkdtemp(join(tmpdir(), "gitcrest-hint-layout-"));
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({ args: [".", "--lang=en-US", "--disable-gpu", "--user-data-dir=" + join(appData, "profile")], env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: join(appData, "gitcrest.sqlite") } });
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await window.evaluate(() => localStorage.setItem("gitcrest-locale", "en"));
    await window.reload();
    await window.locator(".connectionBadge.connected").waitFor({ timeout: 40_000 });
    await app.evaluate(({ dialog }, destination) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] }); }, path);
    await window.getByRole("button", { name: /^Open local repository/ }).click();
    await window.locator(".changeTreeRow").first().waitFor();
    const cdp = await window.context().newCDPSession(window);
    await mkdir(".review/screens/d1.5-layout", { recursive: true });
    for (const locale of ["en", "zh"]) for (const theme of ["light", "dark"]) for (const [width, height] of [[1280, 816], [960, 700]]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await window.evaluate(({ locale, theme }) => { localStorage.setItem("gitcrest-locale", locale); localStorage.setItem("gitcrest-hints-v1", "[]"); localStorage.setItem("gitcrest-appearance-v1", JSON.stringify({ mode: theme })); }, { locale, theme });
      await window.reload();
      await window.locator(".changeTreeRow").nth(9).waitFor();
      const metrics = await window.locator(".commitPanel").evaluate((panel) => {
        const hint = panel.querySelector(".inlineHint")!;
        const button = hint.querySelector("button")!;
        const tree = panel.querySelector(".changeTree")!.getBoundingClientRect();
        const range = document.createRange(); range.selectNodeContents(button);
        const style = getComputedStyle(button);
        const rows = [...panel.querySelectorAll(".changeTreeRow")].filter((row) => { const rect = row.getBoundingClientRect(); return rect.top >= tree.top && rect.bottom <= tree.bottom; });
        return { visibleRows: rows.length, whiteSpace: style.whiteSpace, shrink: style.flexShrink, textLines: range.getClientRects().length };
      });
      const variant = width + "x" + height + "-" + theme + "-" + locale;
      await window.screenshot({ path: ".review/screens/d1.5-layout/" + variant + ".png", animations: "disabled", scale: "css" });
      expect(metrics, variant).toMatchObject({ whiteSpace: "nowrap", shrink: "0" });
      expect(metrics.textLines, variant).toBe(1);
      expect(metrics.visibleRows, variant).toBeGreaterThanOrEqual(8);
    }
  } finally {
    await app?.close();
    await rm(dirname(path), { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    await rm(appData, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}, 180_000);
