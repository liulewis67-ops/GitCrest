import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { _electron as electron } from "playwright";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixturePath = resolve(process.argv[2] || join(os.tmpdir(), "gitcrest-s7.2-100k-fixture"));
const reportPath = resolve(process.argv[3] || join(root, "doc", "evidence", "S7.2", `desktop-${process.platform}.json`));
const iterations = Number(process.env.GITCREST_BENCH_ITERATIONS || 20);

function nearestRank(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function summarize(values) {
  return values.length === 0
    ? { samples: 0, p50Ms: null, p95Ms: null, maxMs: null, samplesMs: [] }
    : { samples: values.length, p50Ms: nearestRank(values, 0.5), p95Ms: nearestRank(values, 0.95), maxMs: Math.max(...values), samplesMs: values };
}

function makeAppEnv(databasePath) {
  const env = { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: databasePath };
  for (const key of Object.keys(env)) if (/^GITCREST_/i.test(key) && key !== "GITCREST_DATABASE_PATH") delete env[key];
  return env;
}

async function processTreeIds(pid) {
  if (process.platform === "win32") {
    const command = `$rootPid=${pid}; $processes=Get-CimInstance Win32_Process; $ids=@([uint32]$rootPid); do { $previousCount=$ids.Count; $ids += @($processes | Where-Object { $ids -contains $_.ParentProcessId } | ForEach-Object { [uint32]$_.ProcessId }); $ids=@($ids | Select-Object -Unique) } while ($ids.Count -gt $previousCount); $ids -join ','`;
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command]);
    return stdout.trim().split(",").map(Number).filter(Number.isFinite);
  }
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid="]);
  const processes = stdout.trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number)).filter((parts) => parts.length === 2);
  const ids = new Set([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [childPid, parentPid] of processes) {
      if (ids.has(parentPid) && !ids.has(childPid)) { ids.add(childPid); changed = true; }
    }
  }
  return [...ids];
}

async function processTreeMemoryBreakdown(pid) {
  if (process.platform === "win32") {
    const command = `$rootPid=${pid}; $processes=Get-CimInstance Win32_Process; $ids=@([uint32]$rootPid); do { $previousCount=$ids.Count; $ids += @($processes | Where-Object { $ids -contains $_.ParentProcessId } | ForEach-Object { [uint32]$_.ProcessId }); $ids=@($ids | Select-Object -Unique) } while ($ids.Count -gt $previousCount); $items=@($ids | ForEach-Object { $id=$_; $process=$processes | Where-Object { $_.ProcessId -eq $id } | Select-Object -First 1; $memory=Get-Process -Id $id -ErrorAction SilentlyContinue; $role=if ($process.Name -like 'gitcrest-core*') { 'rust-sidecar' } elseif ($process.CommandLine -match '--type=renderer') { 'renderer' } elseif ($process.CommandLine -match '--type=gpu-process') { 'gpu' } elseif ($process.CommandLine -match '--type=utility') { 'utility' } elseif ($process.Name -ieq 'electron.exe') { 'electron-main' } elseif ($id -eq $rootPid) { 'harness-wrapper' } else { 'electron-child' }; [pscustomobject]@{ pid=$id; role=$role; image=$process.Name; workingSetBytes=[int64]$memory.WorkingSet64; privateBytes=[int64]$memory.PrivateMemorySize64 } }); ConvertTo-Json -InputObject $items -Compress`;
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command]);
    const parsed = JSON.parse(stdout.trim());
    return (Array.isArray(parsed) ? parsed : [parsed]).sort((left, right) => right.workingSetBytes - left.workingSetBytes);
  }
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,rss=,comm="]);
  const rows = stdout.trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/, 4));
  const treeIds = new Set(await processTreeIds(pid));
  return rows.filter(([id]) => treeIds.has(Number(id))).map(([id, , rss, image]) => ({ pid: Number(id), role: Number(id) === pid ? "electron-main" : image, image, workingSetBytes: Number(rss) * 1024 })).sort((left, right) => right.workingSetBytes - left.workingSetBytes);
}

async function startProcessTreeMemorySampler(pid, intervalMs = 250) {
  const ids = await processTreeIds(pid);
  if (process.platform === "win32") {
    const command = `$ids=@(${ids.join(",")}); while ($true) { $bytes=(Get-Process -Id $ids -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum).Sum; [Console]::Out.WriteLine($bytes); [Console]::Out.Flush(); Start-Sleep -Milliseconds ${intervalMs} }`;
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", command], { stdio: ["ignore", "pipe", "ignore"] });
    const samples = [];
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => { const value = Number(line.trim()); if (Number.isFinite(value) && value > 0) samples.push(value); });
    return {
      samples,
      stop: async () => {
        child.kill();
        await new Promise((resolveExit) => child.once("exit", resolveExit));
        lines.close();
      },
    };
  }
  const child = spawn("sh", ["-c", `while true; do ps -o rss= -p ${ids.join(",")} | awk '{s += $1} END {print s * 1024}'; sleep ${intervalMs / 1000}; done`], { stdio: ["ignore", "pipe", "ignore"] });
  const samples = [];
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => { const value = Number(line.trim()); if (Number.isFinite(value) && value > 0) samples.push(value); });
  return {
    samples,
    stop: async () => {
      child.kill();
      await new Promise((resolveExit) => child.once("exit", resolveExit));
      lines.close();
    },
  };
}

async function storageInfo() {
  if (process.platform !== "win32") return [];
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", "Get-PhysicalDisk | Select-Object FriendlyName,MediaType,BusType,Size | ConvertTo-Json -Compress"]);
    const parsed = JSON.parse(stdout.trim());
    return (Array.isArray(parsed) ? parsed : [parsed]).map(({ FriendlyName, MediaType, BusType, Size }) => ({ model: FriendlyName, mediaType: MediaType, bus: BusType, bytes: Size }));
  } catch {
    return [];
  }
}

async function openFixtureFromWindow(page) {
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

async function runColdLaunch() {
  const startupMs = [];
  const firstHistoryFrameMs = [];
  let idleMemorySamplesBytes = [];
  let repositoryMemorySamplesBytes = [];
  let app;
  let page;
  let dataDir;
  for (let index = 0; index < iterations; index += 1) {
    dataDir = await mkdtemp(join(os.tmpdir(), "gitcrest-s7.2-desktop-"));
    const start = performance.now();
    try {
      app = await electron.launch({ args: ["."], cwd: root, env: makeAppEnv(join(dataDir, "gitcrest.sqlite")) });
      page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 });
      await page.waitForFunction(() => document.body.innerText.includes("Core connected"), undefined, { timeout: 20_000 });
      startupMs.push(Number((performance.now() - start).toFixed(3)));

      if (index === iterations - 1) {
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 5000));
        const sampler = await startProcessTreeMemorySampler(app.process().pid);
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 5000));
        await sampler.stop();
        idleMemorySamplesBytes.push(...sampler.samples);
      }
      await openFixtureFromWindow(page);
      await page.reload();
      await page.getByRole("heading", { name: "Recent repositories" }).waitFor({ timeout: 15_000 });
      const firstHistoryStart = performance.now();
      await page.locator(".repositoryRowOpen").first().click();
      await page.locator(".commitGraphEntry").first().waitFor({ timeout: 20_000 });
      firstHistoryFrameMs.push(Number((performance.now() - firstHistoryStart).toFixed(3)));

      if (index === iterations - 1) {
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 5000));
        const sampler = await startProcessTreeMemorySampler(app.process().pid);
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 5000));
        await sampler.stop();
        repositoryMemorySamplesBytes.push(...sampler.samples);
      }
    } finally {
      await app?.close();
      app = undefined;
      page = undefined;
      await rm(dataDir, { recursive: true, force: true });
    }
  }
  return { startupMs, firstHistoryFrameMs, idleMemorySamplesBytes, repositoryMemorySamplesBytes };
}

async function runMemorySnapshot() {
  const dataDir = await mkdtemp(join(os.tmpdir(), "gitcrest-s7.2-memory-"));
  let app;
  try {
    const args = process.env.GITCREST_BENCH_DISABLE_GPU === "1" ? ["--disable-gpu", "."] : ["."];
    app = await electron.launch({ args, cwd: root, env: makeAppEnv(join(dataDir, "gitcrest.sqlite")) });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 });
    await page.waitForFunction(() => document.body.innerText.includes("Core connected"), undefined, { timeout: 20_000 });
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 5000));
    const idle = await processTreeMemoryBreakdown(app.process().pid);
    await openFixtureFromWindow(page);
    await page.reload();
    await page.getByRole("heading", { name: "Recent repositories" }).waitFor({ timeout: 15_000 });
    await page.locator(".repositoryRowOpen").first().click();
    await page.locator(".commitGraphEntry").first().waitFor({ timeout: 20_000 });
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 5000));
    const loaded = await processTreeMemoryBreakdown(app.process().pid);
    const total = (processes) => ({
      workingSetBytes: processes.reduce((sum, process) => sum + process.workingSetBytes, 0),
      privateBytes: processes.every((process) => Number.isFinite(process.privateBytes))
        ? processes.reduce((sum, process) => sum + process.privateBytes, 0)
        : null,
    });
    return { idle, loaded, idleTotals: total(idle), loadedTotals: total(loaded) };
  } finally {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function runScroll() {
  const dataDir = await mkdtemp(join(os.tmpdir(), "gitcrest-s7.2-scroll-"));
  let app;
  try {
    app = await electron.launch({ args: ["."], cwd: root, env: makeAppEnv(join(dataDir, "gitcrest.sqlite")) });
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => document.body.innerText.includes("Core connected"), undefined, { timeout: 20_000 });
    await openFixtureFromWindow(page);
    await page.reload();
    await page.getByRole("heading", { name: "Recent repositories" }).waitFor();
    await page.locator(".repositoryRowOpen").first().click();
    await page.locator(".commitGraphEntry").first().waitFor({ timeout: 20_000 });

    const idleAnimationFrame = await page.evaluate(async () => {
      const deltas = [];
      const end = performance.now() + 5_000;
      let previous = 0;
      await new Promise((resolveFrame) => {
        const frame = (now) => {
          if (previous) deltas.push(now - previous);
          previous = now;
          if (now < end) requestAnimationFrame(frame);
          else resolveFrame();
        };
        requestAnimationFrame(frame);
      });
      deltas.sort((left, right) => left - right);
      const p95FrameMs = deltas[Math.max(0, Math.ceil(deltas.length * 0.95) - 1)];
      return { durationMs: 5_000, frameSamples: deltas.length, p95FrameMs, p5Fps: p95FrameMs ? 1000 / p95FrameMs : null };
    });

    const sampler = await startProcessTreeMemorySampler(app.process().pid, 500);
    let scroll;
    try {
      scroll = await page.evaluate(async () => {
      const viewport = document.querySelector(".graphViewport");
      if (!viewport) throw new Error("Commit graph viewport is missing.");
      const deltas = [];
      const end = performance.now() + 30_000;
      let previous = 0;
      await new Promise((resolveScroll) => {
        const frame = (now) => {
          if (previous) deltas.push(now - previous);
          previous = now;
          viewport.scrollTop = Math.min(viewport.scrollTop + 8, viewport.scrollHeight - viewport.clientHeight);
          if (now < end) requestAnimationFrame(frame);
          else resolveScroll();
        };
        requestAnimationFrame(frame);
      });
      deltas.sort((left, right) => left - right);
      const p95FrameMs = deltas[Math.max(0, Math.ceil(deltas.length * 0.95) - 1)];
      return { durationMs: 30_000, frameSamples: deltas.length, p95FrameMs, p5Fps: p95FrameMs ? 1000 / p95FrameMs : null };
      });
    } finally {
      await sampler.stop();
    }
    return { idleAnimationFrame, scroll, workMemorySampleCount: sampler.samples.length, workMemoryPeakBytes: Math.max(...sampler.samples) };
  } finally {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

const startedAt = new Date().toISOString();
const scrollOnly = process.env.GITCREST_BENCH_MODE === "scroll";
const memoryOnly = process.env.GITCREST_BENCH_MODE === "memory";
if (!scrollOnly && !memoryOnly && iterations < 20) throw new Error("The plan requires at least 20 measured runs; use GITCREST_BENCH_ITERATIONS >= 20.");
const memorySnapshot = memoryOnly ? await runMemorySnapshot() : null;
const cold = scrollOnly
  || memoryOnly
  ? { startupMs: [], firstHistoryFrameMs: [], idleMemorySamplesBytes: [], repositoryMemorySamplesBytes: [] }
  : await runColdLaunch();
const scroll = scrollOnly || memoryOnly ? null : await runScroll();
const installerPath = join(root, "dist", "GitCrest Setup 0.1.0.exe");
let installerBytes = null;
try { installerBytes = (await stat(installerPath)).size; } catch {}
const report = {
  mode: scrollOnly ? "scroll-only" : memoryOnly ? "memory-only" : "full",
  generatedAt: new Date().toISOString(),
  host: { os: `${os.type()} ${os.release()}`, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model || "unknown", logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(), storage: await storageInfo() },
  software: { electron: process.versions.electron || "37.0.0", node: process.version, rendererBuild: "production electron-vite build", rustProfile: "release", gpuDisabled: process.env.GITCREST_BENCH_DISABLE_GPU === "1" },
  fixture: { commits: 100_000, diffFileLines: 1_000, path: fixturePath },
  iterations: scrollOnly || memoryOnly ? 1 : iterations,
  startedAt,
  startup: summarize(cold.startupMs),
  firstHistoryFrame: summarize(cold.firstHistoryFrameMs),
  idleProcessTreeMemory: { sampleCount: cold.idleMemorySamplesBytes.length, peakBytes: cold.idleMemorySamplesBytes.length ? Math.max(...cold.idleMemorySamplesBytes) : null, samplesBytes: cold.idleMemorySamplesBytes },
  loadedRepositoryIdleProcessTreeMemory: { sampleCount: cold.repositoryMemorySamplesBytes.length, peakBytes: cold.repositoryMemorySamplesBytes.length ? Math.max(...cold.repositoryMemorySamplesBytes) : null, samplesBytes: cold.repositoryMemorySamplesBytes },
  processMemoryBreakdown: memorySnapshot,
  work: scroll,
  installer: { path: installerBytes === null ? null : installerPath, bytes: installerBytes, mebibytes: installerBytes === null ? null : Number((installerBytes / (1024 * 1024)).toFixed(2)) },
  limitations: installerBytes === null ? ["Installer size is unavailable because electron-builder did not produce an installer."] : [],
};
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
