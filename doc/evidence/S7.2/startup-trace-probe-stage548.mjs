// S7.2 stage 548: one cold start of a packaged build with a Chromium startup trace, plus the renderer's own timing entries.
// Usage: node doc/evidence/S7.2/startup-trace-probe-stage548.mjs <GitCrest.exe> <trace.json>
//        node doc/evidence/S7.2/startup-trace-probe-stage548.mjs --summarize <trace.json>
// The trace inflates timings; use it to see what blocks the renderer main thread, not as startup evidence.
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { _electron as electron } from "playwright";

const TRACE_CATEGORIES = "devtools.timeline,disabled-by-default-devtools.timeline,v8,v8.execute,blink,loading,toplevel,navigation";

async function probe(executablePath, tracePath) {
  const dataDir = await mkdtemp(join(tmpdir(), "gitcrest-startup-trace-"));
  const start = performance.now();
  const app = await electron.launch({
    executablePath,
    args: ["--lang=en-US", `--user-data-dir=${join(dataDir, "user-data")}`, `--trace-startup=${TRACE_CATEGORIES}`,
      `--trace-startup-file=${tracePath}`, "--trace-startup-duration=6", "--trace-startup-format=json"],
    env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: join(dataDir, "gitcrest.sqlite"), GITCREST_BENCH_STARTUP_PHASES: "1" },
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => document.body.innerText.includes("Core connected"), undefined, { timeout: 20_000, polling: 5 });
  const connectedMs = performance.now() - start;
  const launchEpoch = performance.timeOrigin + start;
  const mainPhases = await app.evaluate(() => globalThis.gitcrestStartupPhases ?? {});
  const renderer = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0];
    return {
      timeOrigin: performance.timeOrigin,
      domInteractiveMs: navigation?.domInteractive,
      domContentLoadedMs: navigation?.domContentLoadedEventEnd,
      firstPaintMs: performance.getEntriesByType("paint").find((entry) => entry.name === "first-paint")?.startTime,
      fetches: performance.getEntriesByType("resource").map((entry) => ({ name: entry.name.split("/").pop(), startMs: entry.startTime, endMs: entry.responseEnd })),
    };
  });
  // The startup trace is written when its duration ends, so the app stays open until then.
  await new Promise((resolveWait) => setTimeout(resolveWait, 7_000));
  await app.close();
  console.log(JSON.stringify({
    connectedMs: Math.round(connectedMs),
    mainPhasesMs: Object.fromEntries(Object.entries(mainPhases).map(([name, epoch]) => [name, Math.round(epoch - launchEpoch)])),
    rendererTimeOriginMs: Math.round(renderer.timeOrigin - launchEpoch),
    renderer: { ...renderer, timeOrigin: undefined },
  }, null, 2));
}

// Long tasks on the renderer main thread, with the cause Chromium names for each.
async function summarize(tracePath) {
  const { traceEvents } = JSON.parse(await readFile(tracePath, "utf8"));
  const threads = new Map(traceEvents.filter((event) => event.ph === "M" && event.name === "thread_name").map((event) => [`${event.pid}:${event.tid}`, event.args.name]));
  const firstTs = Math.min(...traceEvents.filter((event) => event.ts > 0).map((event) => event.ts));
  const rendererMain = traceEvents.filter((event) => threads.get(`${event.pid}:${event.tid}`) === "CrRendererMain" && event.ph === "X" && event.dur >= 8_000);
  const interesting = /LocalWindowProxy::Initialize|ScheduledActionBeginLayerTreeFrameSinkCreation|v8\.compileModule|v8\.evaluateModule|UpdateStyleAndLayout|FunctionCall|CommitNavigation$/;
  for (const event of rendererMain.sort((left, right) => left.ts - right.ts)) {
    const label = event.args?.src_func ?? event.name;
    if (!interesting.test(event.name) && !interesting.test(label)) continue;
    console.log(`${((event.ts - firstTs) / 1000).toFixed(1).padStart(8)} ms  +${(event.dur / 1000).toFixed(1).padStart(6)} ms  ${label}`);
  }
}

if (process.argv[2] === "--summarize") await summarize(resolve(process.argv[3]));
else await probe(resolve(process.argv[2]), resolve(process.argv[3]));
