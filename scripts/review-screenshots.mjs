// Run pnpm debug first. Captures real renderer states against disposable local repositories.
// node scripts/review-screenshots.mjs [--output folder] [--cdp http://127.0.0.1:9222]
import { chromium } from "playwright";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createReviewFixture } from "./review-fixture.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const output = resolve(option("--output", `.review/screens/${new Date().toISOString().replaceAll(":", "-")}`));
await mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP(option("--cdp", "http://127.0.0.1:9222"));
const context = browser.contexts()[0];
const page = context.pages().find((candidate) => !/[?&]view=/.test(candidate.url()) && /localhost|127\.0\.0\.1|index\.html/.test(candidate.url()));
if (!page) throw new Error("No GitCrest main renderer found. Start pnpm debug first.");
page.setDefaultTimeout(20_000);
const cdp = await context.newCDPSession(page);
const original = await page.evaluate(() => ({
  storage: { ...localStorage }, welcome: !document.querySelector(".workspaceCrumb"), url: location.href,
  width: innerWidth, height: innerHeight, theme: document.documentElement.dataset.theme,
}));
const registered = [];
const captures = [];
let conflictPage;

async function moveFixture(from, to) {
  // Git status reads and antivirus scanners can briefly hold a directory on Windows.
  for (let attempt = 0; ; attempt++) {
    try { return await rename(from, to); } catch (error) {
      if (attempt >= 19 || !["EBUSY", "EPERM", "EACCES"].includes(error.code)) throw error;
      await delay(250);
    }
  }
}

async function api(path, method = "GET", body) {
  return page.evaluate(async ({ path, method, body }) => {
    const connection = await window.gitcrest.getSidecarConnection();
    const response = await fetch(new URL(`/api/v1${path}`, connection.baseUrl), {
      method,
      headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${await response.text()}`);
    return response.status === 204 ? null : response.json();
  }, { path, method, body });
}
async function openFixture(path) {
  const repository = await api("/repositories", "POST", { path });
  registered.push(repository.repoId);
  return repository;
}
async function load(repository, mode = "changes", diff) {
  await page.evaluate(({ repository, mode, diff }) => {
    const session = repository ? {
      openRepoIds: [repository.repoId], activeRepoId: repository.repoId,
      tabs: { [repository.repoId]: { mode, graphScrollTop: 0, ...(diff ? { selectedFilePath: "src/navigation.ts", selectedFileScope: "workingTree" } : {}) } },
    } : { openRepoIds: [], tabs: {} };
    localStorage.setItem("gitcrest-workspace-session-v1", JSON.stringify(session));
    localStorage.setItem("gitcrest-diff-view-v1", JSON.stringify({ layout: "full", sideBySide: diff !== "unified", structureOutline: false }));
  }, { repository, mode, diff });
  await page.reload();
  await page.getByText("Core connected", { exact: true }).waitFor();
  if (repository) await page.locator(".workspaceCrumb").waitFor({ state: "attached" });
  else await page.getByRole("button", { name: "Go to Welcome", exact: true }).click();
}
async function capture(name, target = page) {
  await target.evaluate(async () => { await document.fonts.ready; });
  await target.screenshot({ path: join(output, `${name}.png`), animations: "disabled", scale: "css" });
  captures.push(name);
  console.log(name);
}
async function settings(section) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("menuitem", { name: /All settings/ }).click();
  await page.locator(".settingsPage").waitFor();
  await page.locator(`.settingsNav button`).filter({ hasText: new RegExp(`^${section}$`) }).click();
  await page.locator(`#settings-section-${section.toLowerCase()}`).evaluate((node) => node.scrollIntoView({ behavior: "instant", block: "start" }));
}
try {
  const fixture = await createReviewFixture();
  const conflicting = await createReviewFixture(undefined, { conflict: true });
  const missing = await createReviewFixture();
  const repository = await openFixture(fixture.path);
  const conflictRepository = await openFixture(conflicting.path);
  const missingRepository = await openFixture(missing.path);
  await page.evaluate(() => localStorage.setItem("gitcrest-locale", "en"));
  for (const theme of ["light", "dark"]) {
    for (const [width, height] of [[1280, 816], [960, 700]]) {
      // Electron does not implement Browser.setWindowBounds over renderer CDP.
      // Override the renderer viewport without moving or resizing the user's native window.
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await page.evaluate((theme) => {
        const appearance = JSON.parse(localStorage.getItem("gitcrest-appearance-v1") || "{}");
        localStorage.setItem("gitcrest-appearance-v1", JSON.stringify({ ...appearance, mode: theme }));
      }, theme);
      const prefix = `${width}x${height}-${theme}`;
      await load();
      await capture(`${prefix}-welcome`);
      await page.locator(".searchShortcut").click();
      await page.locator(".commandPalette").waitFor();
      await capture(`${prefix}-palette-no-repository`);
      await load(repository);
      await page.getByRole("textbox", { name: "Commit message", exact: true }).waitFor();
      await page.getByText("untracked.md", { exact: true }).first().waitFor();
      await page.locator(".changeTreeFile").filter({ hasText: "README.md" }).click();
      await page.locator(".view-lines").first().waitFor();
      await capture(`${prefix}-workspace`);
      await page.locator(".searchShortcut").click();
      await page.locator(".commandPalette").waitFor();
      await capture(`${prefix}-palette-repository`);
      await load(repository, "history");
      await page.locator(".commitGraphRow").first().click();
      await page.locator(".commitChangesMeta").waitFor();
      await page.locator(".view-lines").first().waitFor();
      await capture(`${prefix}-history`);
      for (const layout of ["split", "unified"]) {
        await load(repository, "changes", layout);
        await page.locator(".view-lines").first().waitFor();
        await capture(`${prefix}-diff-${layout}`);
      }
      for (const section of ["General", "Appearance", "Shortcuts"]) {
        await load(repository);
        await settings(section);
        await capture(`${prefix}-settings-${section.toLowerCase()}`);
      }
      await load(repository);
      const fetchTask = await api(`/repositories/${repository.repoId}/fetch`, "POST", { prune: false });
      await page.waitForFunction(async (taskId) => {
        const c = await window.gitcrest.getSidecarConnection();
        const response = await fetch(new URL(`/api/v1/tasks/${taskId}`, c.baseUrl), { headers: { Authorization: `Bearer ${c.token}`, "X-GitCrest-API-Version": "1" } });
        return ["succeeded", "failed", "cancelled"].includes((await response.json()).status);
      }, fetchTask.taskId);
      await page.getByRole("button", { name: /^Background tasks/ }).click();
      await page.locator(".taskCard").first().waitFor();
      await capture(`${prefix}-tasks`);
      await load(repository, "history");
      await page.locator(".commitGraphRow").first().click();
      await page.locator(".commitChangesActions").getByRole("button").click();
      await page.getByRole("menuitem", { name: /Create branch/ }).click();
      await page.getByRole("dialog").waitFor();
      await capture(`${prefix}-create-branch`);
      await load(conflictRepository);
      const adoption = await api(`/repositories/${conflictRepository.repoId}/workflows/adopt`, "POST");
      const conflictTask = adoption.task ?? (await api("/tasks")).find((task) => task.repoId === conflictRepository.repoId && task.status === "waitingForInput");
      if (!conflictTask) throw new Error("The conflicted fixture has no recoverable workflow task.");
      await page.evaluate(async ({ repoId, taskId }) => window.gitcrest.openConflictWindow({ repoId, taskId }), {
        repoId: conflictRepository.repoId, taskId: conflictTask.taskId,
      });
      conflictPage = context.pages().find((candidate) => candidate.url().includes("view=conflicts") && candidate.url().includes(conflictRepository.repoId));
      if (!conflictPage) {
        conflictPage = await context.waitForEvent("page");
        await conflictPage.waitForURL((url) => url.searchParams.get("repoId") === conflictRepository.repoId);
      }
      const conflictCdp = await context.newCDPSession(conflictPage);
      await conflictCdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await conflictPage.locator(".conflictLine").first().waitFor();
      await capture(`${prefix}-conflict`, conflictPage);
      await conflictPage.close();
      conflictPage = undefined;
      await load(missingRepository, "history");
      await page.locator(".commitGraphRow").first().waitFor();
      await moveFixture(missing.path, join(missing.root, "moved-repository"));
      try {
        await page.locator(".historyMessageSearch input").fill("missing repository");
        await page.locator(".historyMessageSearch input").press("Enter");
        await page.locator('[role="alert"]').first().waitFor();
        await capture(`${prefix}-error`);
      } finally {
        await moveFixture(join(missing.root, "moved-repository"), missing.path);
      }
    }
  }
  if (captures.length !== 56) throw new Error(`Expected 56 captures; got ${captures.length}`);
  await writeFile(join(output, "manifest.json"), JSON.stringify({ createdAt: new Date().toISOString(), captures, fixture: fixture.path, conflict: conflicting.path }, null, 2));
} finally {
  await conflictPage?.close();
  for (const repoId of registered) await api(`/repositories/${repoId}`, "DELETE").catch((error) => console.error(error.message));
  await page.evaluate(({ storage }) => {
    localStorage.clear();
    for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
  }, original);
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await page.goto(original.url);
  if (original.welcome) await page.locator(".brandButton").click();
  await page.waitForFunction(({ width, height, theme }) => innerWidth === width && innerHeight === height && document.documentElement.dataset.theme === theme, original);
  await cdp.detach();
  await browser.close();
}
