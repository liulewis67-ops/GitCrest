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

function benchmarkGpuFlags() {
  const flags = [];
  if (process.env.GITCREST_BENCH_DISABLE_GPU === "1" && process.env.GITCREST_BENCH_IN_PROCESS_GPU === "1") {
    throw new Error("Choose either disabled GPU or in-process GPU for a benchmark run.");
  }
  if (process.env.GITCREST_BENCH_DISABLE_GPU === "1") flags.push("--disable-gpu");
  if (process.env.GITCREST_BENCH_IN_PROCESS_GPU === "1") flags.push("--in-process-gpu");
  if (process.env.GITCREST_BENCH_DISABLE_FRAME_RATE_LIMIT === "1") flags.push("--disable-frame-rate-limit");
  return flags;
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

async function samplePresentedAnimationFrames(page, label, durationMs, scroll) {
  const client = await page.context().newCDPSession(page);
  const traceEvents = [];
  const detailedTrace = process.env.GITCREST_BENCH_DETAILED_TRACE === "1";
  const complete = new Promise((resolveComplete) => client.once("Tracing.tracingComplete", resolveComplete));
  client.on("Tracing.dataCollected", ({ value }) => traceEvents.push(...value));
  try {
    await client.send("Tracing.start", {
      categories: detailedTrace ? "viz,cc,gpu,benchmark,devtools.timeline" : "viz",
      transferMode: "ReportEvents",
    });
    const animationFrames = await sampleAnimationFrames(page, label, durationMs, scroll);
    await client.send("Tracing.end");
    await complete;
    const presentationTimestamps = traceEvents
      .filter((event) => event.name === "Display::FrameDisplayed" && Number.isFinite(event.ts))
      .map((event) => event.ts)
      .sort((left, right) => left - right);
    const intervalsMs = presentationTimestamps.slice(1).map((timestamp, index) => (timestamp - presentationTimestamps[index]) / 1_000);
    intervalsMs.sort((left, right) => left - right);
    const p95PresentedFrameMs = intervalsMs.length
      ? intervalsMs[Math.max(0, Math.ceil(intervalsMs.length * 0.95) - 1)]
      : null;
    const pipelineTraceEvents = detailedTrace
      ? traceEvents.filter((event) => /Begin.*Frame|PipelineReporter|SubmitCompositorFrame|DrawAndSwap|FrameDisplayed|RunTask|FunctionCall|EventDispatch|Paint|Composite|Raster|Activate|Layout|RecalculateStyle/i.test(event.name))
      : [];
    const pipelineTraceSummary = Object.groupBy(pipelineTraceEvents, (event) => `${event.cat || "unknown"}:${event.name}`);
    return {
      ...animationFrames,
      presentationTrace: {
        event: "benchmark,viz:Display::FrameDisplayed",
        frameCount: presentationTimestamps.length,
        intervalSamples: intervalsMs.length,
        p95FrameMs: p95PresentedFrameMs,
        p5Fps: p95PresentedFrameMs ? 1_000 / p95PresentedFrameMs : null,
        traceEventCount: traceEvents.length,
        ...(detailedTrace ? {
          detailedCategories: "viz,cc,gpu,benchmark,devtools.timeline",
          pipelineEvents: Object.entries(pipelineTraceSummary).map(([name, events]) => {
            const durationsMs = events
              .filter((event) => event.ph === "X" && Number.isFinite(event.dur))
              .map((event) => event.dur / 1_000)
              .sort((left, right) => left - right);
            const eventTimestampsMs = events
              .filter((event) => Number.isFinite(event.ts))
              .map((event) => event.ts)
              .sort((left, right) => left - right);
            const timestampIntervalsMs = eventTimestampsMs
              .slice(1)
              .map((timestamp, index) => (timestamp - eventTimestampsMs[index]) / 1_000)
              .sort((left, right) => left - right);
            return {
              name,
              count: events.length,
              durationSamples: durationsMs.length,
              p50DurationMs: durationsMs.length ? durationsMs[Math.ceil(durationsMs.length * 0.5) - 1] : null,
              p95DurationMs: durationsMs.length ? durationsMs[Math.ceil(durationsMs.length * 0.95) - 1] : null,
              maxDurationMs: durationsMs.length ? durationsMs[durationsMs.length - 1] : null,
              timestampIntervalSamples: timestampIntervalsMs.length,
              p50TimestampIntervalMs: timestampIntervalsMs.length ? timestampIntervalsMs[Math.ceil(timestampIntervalsMs.length * 0.5) - 1] : null,
              p95TimestampIntervalMs: timestampIntervalsMs.length ? timestampIntervalsMs[Math.ceil(timestampIntervalsMs.length * 0.95) - 1] : null,
            };
          }).sort((left, right) => right.count - left.count),
        } : {}),
      },
    };
  } finally {
    await client.detach();
  }
}

const executablePath = packagedAppExecutablePath();
const launchFlags = benchmarkGpuFlags();
await stat(executablePath);
const dataDir = await mkdtemp(join(os.tmpdir(), "gitcrest-s7.2-frame-diagnostic-"));
let app;
try {
  app = await electron.launch({
    executablePath,
    args: [...launchFlags, `--user-data-dir=${join(dataDir, "user-data")}`],
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
  const historyScroll = await samplePresentedAnimationFrames(page, "loaded-history-scroll", 10_000, true);
  const samples = [emptyWorkspace, historyIdle, historyScroll];
  const report = {
    generatedAt: new Date().toISOString(),
    host: { os: `${os.type()} ${os.release()}`, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model || "unknown" },
    software: { electron: process.versions.electron || "37.0.0", node: process.version, launchMode: "packaged application", applicationExecutable: executablePath, launchFlags },
    fixture: { commits: 100_000, path: fixturePath },
    thresholds: { targetScrollP5Fps: 60, rafTargetPeriodMs: 1000 / 60 },
    samples,
    interpretation: {
      emptyWorkspaceAnimationFrameBelow60Fps: emptyWorkspace.p5Fps < 60,
      loadedHistoryIdleAnimationFrameBelow60Fps: historyIdle.p5Fps < 60,
      requestAnimationFrameScrollBelow60Fps: historyScroll.p5Fps < 60,
      presentedScrollBelow60Fps: historyScroll.presentationTrace.p5Fps === null || historyScroll.presentationTrace.p5Fps < 60,
      historyScrollComparedWithEmptyAnimationFrameFps: Number((historyScroll.p5Fps - emptyWorkspace.p5Fps).toFixed(3)),
      visibleAndFocusedForAllSamples: samples.every((sample) => sample.documentVisibilityState === "visible" && sample.documentHasFocus),
    },
  };
  const fs = await import("node:fs/promises");
  await fs.mkdir(dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (historyScroll.presentationTrace.p5Fps === null || historyScroll.presentationTrace.p5Fps < 60) process.exitCode = 2;
} finally {
  await app?.close();
  await rm(dataDir, { recursive: true, force: true });
}
