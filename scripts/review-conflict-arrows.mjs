// Build first. Owns its app profile and disposable repository.
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createReviewFixture } from "./review-fixture.mjs";
import { setReviewWindowSize, withReviewApp } from "./review-window.mjs";

const output = resolve(".review/conflict-arrows");
await mkdir(output, { recursive: true });
const fixture = await createReviewFixture(undefined, { conflict: true });
try {
  await withReviewApp(async (app, main) => {
    let page;
    try {
      const target = await main.evaluate(async (path) => {
        localStorage.setItem("gitcrest-locale", "en");
        localStorage.setItem("gitcrest-appearance-v1", JSON.stringify({ mode: "light" }));
        const c = await window.gitcrest.getSidecarConnection();
        const api = async (path, body) => {
          const response = await fetch(new URL(`/api/v1${path}`, c.baseUrl), { method: "POST", headers: { Authorization: `Bearer ${c.token}`, "X-GitCrest-API-Version": "1", "Content-Type": "application/json" }, body: JSON.stringify(body) });
          if (!response.ok) throw Error(await response.text());
          return response.json();
        };
        const repo = await api("/repositories", { path });
        const adoption = await api(`/repositories/${repo.repoId}/workflows/adopt`);
        return { repoId: repo.repoId, taskId: adoption.task.taskId };
      }, fixture.path);
      await main.evaluate((target) => window.gitcrest.openConflictWindow(target), target);
      page = app.windows().find((candidate) => candidate.url().includes("view=conflicts"));
      assert(page);
      page.setDefaultTimeout(15000);
      const errors = []; page.on("pageerror", (error) => errors.push(error.message));
      await page.getByRole("button", { name: "Use current · 1", exact: true }).waitFor();
      const lines = page.locator(".resolverResult .view-lines");
      assert(!(await lines.innerText()).includes("<<<<<<<"));
      for (const locale of ["en", "zh"]) {
        await main.evaluate((locale) => localStorage.setItem("gitcrest-locale", locale), locale);
        for (const theme of ["light", "dark"]) {
          await main.evaluate((mode) => localStorage.setItem("gitcrest-appearance-v1", JSON.stringify({ mode })), theme);
          await page.waitForFunction((mode) => document.documentElement.dataset.theme === mode, theme);
          for (const [width, height] of [[1280, 816], [960, 700], [800, 600]]) {
            await setReviewWindowSize(app, page, { width, height });
            assert(await page.evaluate(() => document.querySelector(".resolverFooter").getBoundingClientRect().bottom <= innerHeight + 1));
            await page.screenshot({ path: join(output, `${width}-${locale}-${theme}.png`) });
          }
        }
      }
      await main.evaluate(() => { localStorage.setItem("gitcrest-locale", "en"); localStorage.setItem("gitcrest-appearance-v1", JSON.stringify({ mode: "light" })); });
      await setReviewWindowSize(app, page, { width: 1280, height: 816 });
      const arrow = page.getByRole("button", { name: "Use current · 1", exact: true });
      await arrow.click();
      assert.equal(await page.locator(".resolverMergeArrow").count(), 0);
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await arrow.waitFor();
      assert(!(await lines.innerText()).includes("<<<<<<<"));
      await page.getByRole("button", { name: "Redo", exact: true }).click();
      assert.equal(await page.locator(".resolverMergeArrow").count(), 0);
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await arrow.waitFor();
      const editor = page.locator(".resolverResult textarea");
      await editor.press("Control+A"); await page.keyboard.insertText("Main and Feature combined\n");
      assert.equal(await page.locator(".resolverMergeArrow").count(), 0);
      await page.screenshot({ path: join(output, "manual-composition.png") });
      await page.getByRole("button", { name: "Undo", exact: true }).click(); await arrow.waitFor();
      assert(!(await lines.innerText()).includes("<<<<<<<"));
      // Without an available ancestor, accepting current is a decision-only edit.
      // It must still have an undo transaction even though the visible text is identical.
      await page.route("**/workflows/conflicts/file?*", async (route) => {
        const response = await route.fetch();
        const file = await response.json();
        await route.fulfill({ response, json: { ...file, baseContent: null } });
      });
      await page.reload(); await arrow.waitFor();
      const proposal = await lines.innerText();
      await arrow.click();
      assert.equal(await page.locator(".resolverMergeArrow").count(), 0);
      assert.equal(await lines.innerText(), proposal);
      await page.getByRole("button", { name: "Undo", exact: true }).click(); await arrow.waitFor();
      assert.equal(await lines.innerText(), proposal);
      assert.deepEqual(errors, []);
      await writeFile(join(output, "verification.json"), JSON.stringify({ matrix: "1280/960/800 × en/zh × light/dark", markersHidden: true, arrowsDisappearOnAccept: true, undoRestoresPendingArrow: true, redoResolvesAgain: true, manualComposition: true, unchangedTextDecisionUndo: true, errors }, null, 2));
      console.log("Clean-result arrow checks passed");
    } catch (error) { await page?.screenshot({ path: join(output, "failure.png") }).catch(() => {}); throw error; }
    finally { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((window) => window.destroy())); }
  });
} finally {
  const target = resolve(fixture.root);
  if (dirname(target) !== resolve(tmpdir()) || !target.startsWith(join(resolve(tmpdir()), "gitcrest-review-"))) throw Error("Unexpected fixture cleanup path");
  await rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
