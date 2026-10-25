import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixturePath = resolve(process.argv[2] || join(os.tmpdir(), "gitcrest-s7.2-100k-fixture"));
const reportPath = resolve(process.argv[3] || join(root, "doc", "evidence", "S7.2", `desktop-${process.platform}-batched.json`));
const totalIterations = Number(process.env.GITCREST_BENCH_ITERATIONS || 20);
const batchSize = Number(process.env.GITCREST_BENCH_BATCH_SIZE || 5);

if (totalIterations < 20) throw new Error("The plan requires at least 20 measured runs.");
if (batchSize < 1 || batchSize >= totalIterations) throw new Error("Batch size must be between 1 and total iterations - 1.");

function nearestRank(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function summarize(values) {
  return {
    samples: values.length,
    p50Ms: nearestRank(values, 0.5),
    p95Ms: nearestRank(values, 0.95),
    maxMs: Math.max(...values),
    samplesMs: values,
  };
}

function summarizeMeasuredValues(values) {
  return {
    samples: values.length,
    p5: nearestRank(values, 0.05),
    p50: nearestRank(values, 0.5),
    p95: nearestRank(values, 0.95),
    max: Math.max(...values),
    samplesValues: values,
  };
}

const batchDirectory = `${reportPath}.batches`;
await mkdir(batchDirectory, { recursive: true });
const batchReports = [];
let completedIterations = 0;
for (let batch = 1; completedIterations < totalIterations; batch += 1) {
  const batchIterations = Math.min(batchSize, totalIterations - completedIterations);
  const batchReportPath = join(batchDirectory, `batch-${String(batch).padStart(2, "0")}.json`);
  let report;
  if (existsSync(batchReportPath)) {
    report = JSON.parse(await readFile(batchReportPath, "utf8"));
    process.stdout.write(`Reusing saved desktop benchmark batch ${batch} (${report.iterations} iterations).\n`);
  } else {
    process.stdout.write(`Running desktop benchmark batch ${batch} (${batchIterations} iterations; ${completedIterations}/${totalIterations} completed)…\n`);
    await execFileAsync(process.execPath, [join(root, "scripts", "performance", "desktop-benchmark.mjs"), fixturePath, batchReportPath], {
      cwd: root,
      env: { ...process.env, GITCREST_BENCH_ITERATIONS: String(batchIterations), GITCREST_BENCH_ALLOW_BATCH: "1" },
      maxBuffer: 10 * 1024 * 1024,
    });
    report = JSON.parse(await readFile(batchReportPath, "utf8"));
  }
  if (report.startup.samples !== batchIterations || report.firstHistoryFrame.samples !== batchIterations || report.work.iterations.length !== batchIterations) {
    throw new Error(`Batch ${batch} did not produce ${batchIterations} startup, history, and scroll samples.`);
  }
  batchReports.push({ ...report, _batchReportPath: batchReportPath });
  completedIterations += batchIterations;
}

const startupMs = batchReports.flatMap(({ startup }) => startup.samplesMs);
const firstHistoryFrameMs = batchReports.flatMap(({ firstHistoryFrame }) => firstHistoryFrame.samplesMs);
// Batches saved before startup phases existed have none; a phase is summarized over the batches that marked it.
const startupPhaseNames = [...new Set(batchReports.flatMap(({ startupPhases }) => Object.keys(startupPhases?.phases ?? {})))];
const startupPhases = {
  method: batchReports.find(({ startupPhases }) => startupPhases)?.startupPhases.method ?? null,
  phases: Object.fromEntries(startupPhaseNames.map((phase) => [phase, batchReports.flatMap(({ startupPhases }) => startupPhases?.phases?.[phase]?.samplesMs ?? [])]).filter(([, values]) => values.length > 0).map(([phase, values]) => [phase, summarize(values)])),
};
const idleMemorySamplesBytes = batchReports.flatMap(({ idleProcessTreeMemory }) => idleProcessTreeMemory.samplesBytes);
const repositoryMemorySamplesBytes = batchReports.flatMap(({ loadedRepositoryIdleProcessTreeMemory }) => loadedRepositoryIdleProcessTreeMemory.samplesBytes);
const scrollSamples = batchReports.flatMap(({ work }) => work.iterations)
  .map((sample, index) => ({ ...sample, iteration: index + 1 }));
const peakBytes = (values) => values.length ? Math.max(...values) : null;
const { _batchReportPath: _lastBatchReportPath, ...lastReport } = batchReports.at(-1);
const report = {
  ...lastReport,
  mode: "full-batched",
  generatedAt: new Date().toISOString(),
  iterations: completedIterations,
  batchSize,
  batchReports: batchReports.map(({ _batchReportPath }) => _batchReportPath),
  startup: summarize(startupMs),
  startupPhases,
  firstHistoryFrame: summarize(firstHistoryFrameMs),
  idleProcessTreeMemory: { sampleCount: idleMemorySamplesBytes.length, peakBytes: peakBytes(idleMemorySamplesBytes), samplesBytes: idleMemorySamplesBytes },
  loadedRepositoryIdleProcessTreeMemory: { sampleCount: repositoryMemorySamplesBytes.length, peakBytes: peakBytes(repositoryMemorySamplesBytes), samplesBytes: repositoryMemorySamplesBytes },
  work: {
    iterations: scrollSamples,
    idleAnimationFrameP5Fps: summarizeMeasuredValues(scrollSamples.map(({ idleAnimationFrame }) => idleAnimationFrame.p5Fps)),
    scrollP5Fps: summarizeMeasuredValues(scrollSamples.map(({ scroll }) => scroll.p5Fps)),
    workMemoryPeakBytes: summarizeMeasuredValues(scrollSamples.map(({ workMemoryPeakBytes }) => workMemoryPeakBytes)),
  },
  batchMetadata: {
    count: batchReports.length,
    reports: batchReports.map(({ _batchReportPath }) => _batchReportPath),
    note: "Each batch runs in a fresh Node.js process to bound Playwright harness lifetime. Batch reports are retained beside this aggregate.",
  },
};
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
