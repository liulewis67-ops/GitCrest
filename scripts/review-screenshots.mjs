// Run pnpm build first. Captures in an owned, isolated Electron app with native window sizes.
// node scripts/review-screenshots.mjs [--output folder] [--cdp http://127.0.0.1:9222]
import { chromium } from "playwright";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createReviewFixture } from "./review-fixture.mjs";
import { resetReviewViewport, setReviewWindowSize, withReviewApp } from "./review-window.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const output = resolve(option("--output", `.review/screens/${new Date().toISOString().replaceAll(":", "-")}`));
async function captureReview(application, context) {
await mkdir(output, { recursive: true });
const originalPages = new Set(context.pages());
const page = context.pages().find((candidate) => !/[?&]view=/.test(candidate.url()) && /localhost|127\.0\.0\.1|index\.html/.test(candidate.url()));
if (!page) throw new Error("No GitCrest main renderer found. Start pnpm debug first.");
page.setDefaultTimeout(20_000);
await page.locator(".connectionBadge.connected").waitFor({ timeout: 40_000 });
await resetReviewViewport(page);
const cdp = application ? undefined : await context.newCDPSession(page);
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
      // Native sizing keeps the visible window filled; attached CDP mode is explicit opt-in.
      if (application) await setReviewWindowSize(application, page, { width, height });
      else await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
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
      // Reopen after the previous move-back to refresh cached availability/HEAD.
      await api("/repositories", "POST", { path: missing.path });
      await load(missingRepository, "history");
      await page.locator(".commitGraphRow").first().waitFor().catch(async (error) => {
        await page.screenshot({ path: join(output, `${prefix}-error-setup-failed.png`), scale: "css" });
        console.error(await page.locator("body").innerText());
        throw error;
      });
      await moveFixture(missing.path, join(missing.root, "moved-repository"));
      try {
        const search = page.locator(".historyMessageSearch input");
        if (await search.isVisible()) {
          try {
            await search.fill("missing repository", { timeout: 1_000 });
            await search.press("Enter", { timeout: 1_000 });
          } catch (error) {
            // A status refresh may already have replaced History with recovery.
            if (!await page.locator(".repositoryRecovery").isVisible()) throw error;
          }
        }
        await page.locator(".repositoryRecovery").waitFor();
        await page.waitForLoadState("networkidle", { timeout: 10_000 });
        await capture(`${prefix}-error`);
      } finally {
        await moveFixture(join(missing.root, "moved-repository"), missing.path);
      }
    }
  }
  // Capture the resolver last and reuse it. Reloading the main renderer while a
  // task waits can auto-open another resolver; no waiting task spans the main matrix.
  await load(conflictRepository);
  const adoption = await api(`/repositories/${conflictRepository.repoId}/workflows/adopt`, "POST");
  const conflictTask = adoption.task ?? (await api("/tasks")).find((task) => task.repoId === conflictRepository.repoId && task.status === "waitingForInput");
  if (!conflictTask) throw new Error("The conflicted fixture has no recoverable workflow task.");
  const findResolver = () => context.pages().find((candidate) => candidate.url().includes("view=conflicts") && candidate.url().includes(conflictRepository.repoId));
  for (let attempt = 0; attempt < 10 && !findResolver(); attempt++) await delay(100);
  if (!findResolver()) await page.evaluate(async ({ repoId, taskId }) => window.gitcrest.openConflictWindow({ repoId, taskId }), {
    repoId: conflictRepository.repoId, taskId: conflictTask.taskId,
  });
  conflictPage = findResolver();
  if (!conflictPage) throw new Error("The fixture's conflict window did not open.");
  const conflictCdp = application ? undefined : await context.newCDPSession(conflictPage);
  await conflictPage.locator(".resolverResult .view-lines").waitFor();
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      const appearance = JSON.parse(localStorage.getItem("gitcrest-appearance-v1") || "{}");
      localStorage.setItem("gitcrest-appearance-v1", JSON.stringify({ ...appearance, mode: theme }));
    }, theme);
    await conflictPage.waitForFunction((theme) => document.documentElement.dataset.theme === theme, theme);
    for (const [width, height] of [[1280, 816], [960, 700]]) {
      if (application) await setReviewWindowSize(application, conflictPage, { width, height });
      else await conflictCdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await capture(`${width}x${height}-${theme}-conflict`, conflictPage);
    }
  }
  if (captures.length !== 56) throw new Error(`Expected 56 captures; got ${captures.length}`);
  await writeFile(join(output, "manifest.json"), JSON.stringify({ createdAt: new Date().toISOString(), captures, fixture: fixture.path, conflict: conflicting.path }, null, 2));
} finally {
  // Repair sizing before any data cleanup that could fail; a disconnected CDP client
  // must never leave a small canvas and blank margins in a live desktop window.
  if (application) await setReviewWindowSize(application, page, { width: original.width, height: original.height });
  else await resetReviewViewport(page);
  await conflictPage?.close();
  // Drop fixture tabs before recovery/forgetting, so completion events and
  // delayed status refreshes cannot register a just-forgotten fixture again.
  await page.evaluate(({ storage }) => {
    localStorage.clear();
    for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
  }, original);
  await page.goto(original.url);
  if (original.welcome) await page.locator(".brandButton").click();
  await page.waitForFunction(({ width, height, theme }) => innerWidth === width && innerHeight === height && document.documentElement.dataset.theme === theme, original);
  await page.locator(".connectionBadge.connected").waitFor({ timeout: 40_000 });
  let cleanupError;
  // Adoption creates a persisted waiting task. Abort only our own fixture workflows
  // before forgetting their repositories, so later reloads cannot reopen them.
  try {
    const tasks = await api("/tasks");
    for (const task of tasks.filter((task) => registered.includes(task.repoId) && task.status === "waitingForInput")) {
      const preview = await api(`/repositories/${task.repoId}/workflows/recovery-preflight?taskId=${encodeURIComponent(task.taskId)}`);
      const recoveryTask = await api(`/repositories/${task.repoId}/workflows/recovery`, "POST", {
        taskId: task.taskId, action: "abort", expectedOperation: preview.operation,
        expectedHeadOid: preview.headOid, expectedConflictedPaths: preview.conflictedPaths,
      });
      for (let attempt = 0; ; attempt++) {
        const current = await Promise.all([...new Set([task.taskId, recoveryTask.taskId])].map((taskId) => api(`/tasks/${taskId}`)));
        if (current.every((entry) => ["succeeded", "failed", "cancelled"].includes(entry.status))) break;
        if (attempt >= 39) throw new Error(`Review task ${task.taskId} did not finish cleanup.`);
        await delay(250);
      }
    }
  } catch (error) {
    cleanupError = error;
  }
  for (const candidate of context.pages()) {
    if (!originalPages.has(candidate)) await candidate.close();
  }
  // Keep a fixture registered when recovery fails, so the user can still recover it.
  try {
    if (!cleanupError) {
      // Recovery completion refreshes repository metadata. Let those renderer reads
      // finish before forgetting the entries, so a late refresh cannot recreate one.
      await page.waitForLoadState("networkidle", { timeout: 10_000 });
      for (const repoId of registered) await api(`/repositories/${repoId}`, "DELETE");
      // Reconnect once more: persisted terminal tasks can trigger metadata refresh
      // on startup, and a forgotten entry must remain forgotten after that work.
      await page.reload();
      await page.locator(".connectionBadge.connected").waitFor({ timeout: 40_000 });
      if (original.welcome) await page.locator(".brandButton").click();
      await page.waitForLoadState("networkidle", { timeout: 10_000 });
      const remaining = (await api("/repositories")).filter((entry) => registered.includes(entry.repoId));
      if (remaining.length) throw new Error("Review repository cleanup did not finish.");
    }
  } catch (error) {
    cleanupError = error;
  }
  // A waiting task may auto-open a resolver alongside the explicitly requested one.
  // Preserve windows present on attachment and close every secondary window we caused.
  for (const candidate of context.pages()) {
    if (!originalPages.has(candidate)) await candidate.close();
  }
  await cdp?.detach();
  if (cleanupError) throw cleanupError;
}

}

if (args.includes("--cdp")) {
  const browser = await chromium.connectOverCDP(option("--cdp", "http://127.0.0.1:9222"));
  try { await captureReview(undefined, browser.contexts()[0]); }
  finally { await browser.close(); }
} else {
  await withReviewApp((application) => captureReview(application, application.context()));
}
