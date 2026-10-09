import { existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixturePath = resolve(process.argv[2] || join(os.tmpdir(), "gitcrest-s7.2-100k-fixture"));
const reportPath = resolve(process.argv[3] || join(root, "doc", "evidence", "S7.2", `desktop-frame-diagnostic-${process.platform}.json`));

function packagedAppExecutablePath() {
  const configuredPath = process.env.GITCREST_BENCH_EXECUTABLE;
  if (configuredPath) return resolve(configuredPath);
  if (process.platform === "win32") return join(root, "dist", "win-unpacked", "GitCrest.exe");
  if (process.platform === "linux") return join(root, "dist", "linux-unpacked", "gitcrest");
  if (process.platform === "darwin") {
    return ["mac", "mac-arm64", "mac-x64", "mac-universal"]
      .map((directory) => join(root, "dist", directory, "GitCrest.app", "Contents", "MacOS", "GitCrest"))
      .find((candidate) => existsSync(candidate))
      || join(root, "dist", "mac", "GitCrest.app", "Contents", "MacOS", "GitCrest");
  }
  throw new Error(`Unsupported desktop benchmark platform: ${process.platform}`);
}

async function registerFixture(page) {
  const result = await page.evaluate(async (path) => {
    const connection = await window.gitcrest.getSidecarConnection();
    const response = await fetch(new URL("/api/v1/repositories", connection.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "X-GitCrest-API-Version": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path }),
    });
    return { status: response.status, body: await response.json() };
  }, fixturePath);
  if (result.status !== 200) throw new Error(`Could not register benchmark fixture: ${JSON.stringify(result.body)}`);
}

async function sampleAnimationFrames(page, label, durationMs, scroll) {
  return page.evaluate(async ({ sampleLabel, sampleDuration, shouldScroll }) => {
    const viewport = shouldScroll ? document.querySelector(".graphViewport") : null;
    if (shouldScroll && !viewport) throw new Error("Commit graph viewport is missing.");
    const deltas = [];
    const startedAt = performance.now();
    const endsAt = startedAt + sampleDuration;
    let previous = 0;
    let scrollDistance = 0;
    await new Promise((resolveFrame) => {
      const frame = (now) => {
        if (previous) deltas.push(now - previous);
        previous = now;
        if (viewport) {
          const previousTop = viewport.scrollTop;
          viewport.scrollTop = Math.min(previousTop + 8, viewport.scrollHeight - viewport.clientHeight);
          scrollDistance += viewport.scrollTop - previousTop;
        }
        if (now < endsAt) requestAnimationFrame(frame);
        else resolveFrame();
      };
      requestAnimationFrame(frame);
    });
    deltas.sort((left, right) => left - right);
    const p95FrameMs = deltas[Math.max(0, Math.ceil(deltas.length * 0.95) - 1)];
    return {
      label: sampleLabel,
      durationMs: sampleDuration,
      frameSamples: deltas.length,
      p95FrameMs,
      p5Fps: p95FrameMs ? 1000 / p95FrameMs : null,
      scrollDistancePx: scrollDistance,
      documentVisibilityState: document.visibilityState,
      documentHasFocus: document.hasFocus(),
      devicePixelRatio: window.devicePixelRatio,
      viewport: { innerWidth: window.innerWidth, innerHeight: window.innerHeight, screenWidth: screen.width, screenHeight: screen.height },
    };
  }, { sampleLabel: label, sampleDuration: durationMs, shouldScroll: scroll });
}

const executablePath = packagedAppExecutablePath();
await stat(executablePath);
const dataDir = await mkdtemp(join(os.tmpdir(), "gitcrest-s7.2-frame-diagnostic-"));
let app;
try {
  app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${join(dataDir, "user-data")}`],
    cwd: root,
    env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: join(dataDir, "gitcrest.sqlite") },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded", { timeout: 15_000 });
  await page.waitForFunction(() => document.body.innerText.includes("Core connected"), undefined, { timeout: 20_000 });
  await page.bringToFront();
  const emptyWorkspace = await sampleAnimationFrames(page, "empty-workspace-idle", 5_000, false);

  await registerFixture(page);
  await page.reload();
  await page.getByRole("heading", { name: "Recent repositories" }).waitFor({ timeout: 15_000 });
  await page.locator(".repositoryRowOpen").first().click();
  await page.locator(".commitGraphEntry").first().waitFor({ timeout: 20_000 });
  await page.bringToFront();
  const historyIdle = await sampleAnimationFrames(page, "loaded-history-idle", 5_000, false);
  const historyScroll = await sampleAnimationFrames(page, "loaded-history-scroll", 10_000, true);
  const samples = [emptyWorkspace, historyIdle, historyScroll];
  const report = {
    generatedAt: new Date().toISOString(),
    host: { os: `${os.type()} ${os.release()}`, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model || "unknown" },
    software: { electron: process.versions.electron || "37.0.0", node: process.version, launchMode: "packaged application", applicationExecutable: executablePath },
    fixture: { commits: 100_000, path: fixturePath },
    thresholds: { targetScrollP5Fps: 60, rafTargetPeriodMs: 1000 / 60 },
    samples,
    interpretation: {
      emptyWorkspaceBelow60Fps: emptyWorkspace.p5Fps < 60,
      loadedHistoryIdleBelow60Fps: historyIdle.p5Fps < 60,
      scrollBelow60Fps: historyScroll.p5Fps < 60,
      historyScrollComparedWithEmptyFps: Number((historyScroll.p5Fps - emptyWorkspace.p5Fps).toFixed(3)),
      visibleAndFocusedForAllSamples: samples.every((sample) => sample.documentVisibilityState === "visible" && sample.documentHasFocus),
    },
  };
  const fs = await import("node:fs/promises");
  await fs.mkdir(dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (samples.some((sample) => sample.p5Fps < 60)) process.exitCode = 2;
} finally {
  await app?.close();
  await rm(dataDir, { recursive: true, force: true });
}
