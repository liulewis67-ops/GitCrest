// S7.2 stage 545: lists what the renderer loads on the start screen and on the first repository screen.
// Usage (after `pnpm build`): node doc/evidence/S7.2/renderer-request-probe-stage545.mjs [report.json]
// It runs the development entry (`electron .`, debug sidecar), so its heap numbers are indicative, not acceptance data.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const reportPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
const runs = Number(process.env.GITCREST_PROBE_RUNS || 3);
const LAZY_ASSET = /\.wasm$|editor\.api|editor\.worker|monaco-setup|Monaco|grammar-loader|SplitDiff|tsMode|ts\.worker/;

async function fixtureRepository() {
  const path = await mkdtemp(join(tmpdir(), "gitcrest-probe-repo-"));
  const git = (...args) => execFileSync("git", ["-C", path, ...args]);
  git("init", "--quiet");
  await mkdir(join(path, "src"));
  await writeFile(join(path, "src", "a.ts"), "export const a = 1;\n");
  git("add", ".");
  git("-c", "user.name=probe", "-c", "user.email=probe@example.com", "commit", "--quiet", "-m", "init");
  await writeFile(join(path, "src", "a.ts"), "export const a = 2;\n");
  return path;
}

function summarizeRequests(urls) {
  const files = urls.map((url) => url.split("?")[0]);
  return {
    assets: files.filter((url) => url.startsWith("file:")).map((url) => url.split("/").pop()),
    lazyAssets: files.filter((url) => url.startsWith("file:") && LAZY_ASSET.test(url)).map((url) => url.split("/").pop()),
    // Anything off the machine; the core's loopback API does not count.
    remoteRequests: files.filter((url) => /^https?:/.test(url) && !new URL(url).hostname.startsWith("127.")),
  };
}

async function waitForCore(page) {
  await page.waitForLoadState("domcontentloaded");
  await page.getByText("Core connected").waitFor({ timeout: 20_000 });
}

async function probeOnce(repositoryPath) {
  const dataDir = await mkdtemp(join(tmpdir(), "gitcrest-probe-"));
  const app = await electron.launch({
    // Without this flag Chromium buckets performance.memory and repeats its first reading.
    args: [".", "--lang=en-US", "--enable-precise-memory-info", `--user-data-dir=${join(dataDir, "user-data")}`],
    cwd: root,
    env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: join(dataDir, "gitcrest.sqlite") },
  });
  try {
    const page = await app.firstWindow();
    await waitForCore(page);
    const registered = await page.evaluate(async (path) => {
      const connection = await window.gitcrest.getSidecarConnection();
      const response = await fetch(new URL("/api/v1/repositories", connection.baseUrl), {
        method: "POST",
        headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      return response.status;
    }, repositoryPath);
    if (registered !== 200) throw new Error(`Could not register the probe repository (${registered}).`);

    // A reload is a fresh renderer load whose requests are all observed.
    const startScreen = [];
    const onStartRequest = (request) => startScreen.push(request.url());
    page.on("request", onStartRequest);
    await page.reload();
    await waitForCore(page);
    await page.getByRole("heading", { name: "Recent repositories" }).waitFor();
    await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
    const startHeap = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
    page.off("request", onStartRequest);

    // Opening the repository selects its changed file, so this screen shows a Diff.
    const repositoryScreen = [];
    page.on("request", (request) => repositoryScreen.push(request.url()));
    await page.locator(".repositoryRowOpen").first().click();
    await page.locator(".monacoFileDiff .view-lines").first().waitFor({ state: "visible", timeout: 30_000 });
    await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
    const diffHeap = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
    const diffText = (await page.locator(".monacoFileDiff").innerText()).replace(/\s+/g, " ");
    return {
      startScreen: { ...summarizeRequests(startScreen), usedJsHeapMiB: startHeap && Number((startHeap / 2 ** 20).toFixed(1)) },
      repositoryScreenWithDiff: {
        ...summarizeRequests(repositoryScreen),
        diffShowsBothSides: diffText.includes("const a = 1;") && diffText.includes("const a = 2;"),
        usedJsHeapMiB: diffHeap && Number((diffHeap / 2 ** 20).toFixed(1)),
      },
    };
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

const repositoryPath = await fixtureRepository();
const samples = [];
try {
  for (let run = 0; run < runs; run += 1) samples.push(await probeOnce(repositoryPath));
} finally {
  await rm(repositoryPath, { recursive: true, force: true });
}
const report = { generatedAt: new Date().toISOString(), launchMode: "development entry (electron .) with the debug sidecar", runs, samples };
if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
