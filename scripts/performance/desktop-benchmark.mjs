import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
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

function benchmarkGpuFlags() {
  const args = [];
  if (process.env.GITCREST_BENCH_DISABLE_GPU === "1" && process.env.GITCREST_BENCH_IN_PROCESS_GPU === "1") {
    throw new Error("Choose either disabled GPU or in-process GPU for a benchmark run.");
  }
  if (process.env.GITCREST_BENCH_DISABLE_GPU === "1") args.push("--disable-gpu");
  if (process.env.GITCREST_BENCH_IN_PROCESS_GPU === "1") args.push("--in-process-gpu");
  return args;
}

function benchmarkElectronArgs(dataDir) {
  return [...benchmarkGpuFlags(), `--user-data-dir=${join(dataDir, "user-data")}`];
}

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

async function launchDesktopApp(dataDir) {
  const executablePath = packagedAppExecutablePath();
  try {
    await stat(executablePath);
  } catch {
    throw new Error(`Packaged GitCrest executable not found at ${executablePath}. Run "pnpm electron:package" first.`);
  }
  return electron.launch({
    executablePath,
    args: benchmarkElectronArgs(dataDir),
    cwd: root,
    env: makeAppEnv(join(dataDir, "gitcrest.sqlite")),
  });
}

async function electronProcessRootPid(launcherPid) {
  if (process.platform !== "win32") return launcherPid;
  const command = `$launcherPid=${launcherPid}; $processes=Get-CimInstance Win32_Process; $ids=@([uint32]$launcherPid); do { $previousCount=$ids.Count; $ids += @($processes | Where-Object { $ids -contains $_.ParentProcessId } | ForEach-Object { [uint32]$_.ProcessId }); $ids=@($ids | Select-Object -Unique) } while ($ids.Count -gt $previousCount); $main=@($processes | Where-Object { $ids -contains $_.ProcessId -and $_.Name -match '^(electron|gitcrest)\.exe$' -and $_.CommandLine -notmatch '--type=' }); if ($main.Count -ne 1) { throw "Expected exactly one Electron main process under launcher PID $launcherPid; found $($main.Count)." }; [uint32]$main[0].ProcessId`;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command]);
  const pid = Number(stdout.trim());
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Could not resolve the Electron main process PID for memory measurement.");
  return pid;
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
    const command = `$rootPid=${pid}; $processes=Get-CimInstance Win32_Process; $perf=Get-CimInstance Win32_PerfFormattedData_PerfProc_Process; $ids=@([uint32]$rootPid); do { $previousCount=$ids.Count; $ids += @($processes | Where-Object { $ids -contains $_.ParentProcessId } | ForEach-Object { [uint32]$_.ProcessId }); $ids=@($ids | Select-Object -Unique) } while ($ids.Count -gt $previousCount); $items=@($ids | ForEach-Object { $id=$_; $process=$processes | Where-Object { $_.ProcessId -eq $id } | Select-Object -First 1; $memory=Get-Process -Id $id -ErrorAction SilentlyContinue; $perfProcess=$perf | Where-Object { $_.IDProcess -eq $id } | Select-Object -First 1; $role=if ($process.Name -like 'gitcrest-core*') { 'rust-sidecar' } elseif ($process.CommandLine -match '--type=renderer') { 'renderer' } elseif ($process.CommandLine -match '--type=gpu-process') { 'gpu' } elseif ($process.CommandLine -match '--type=utility') { 'utility' } elseif ($id -eq $rootPid -or $process.Name -ieq 'electron.exe') { 'electron-main' } else { 'electron-child' }; [pscustomobject]@{ pid=$id; role=$role; image=$process.Name; workingSetBytes=[int64]$memory.WorkingSet64; privateWorkingSetBytes=if ($perfProcess) { [int64]$perfProcess.WorkingSetPrivate } else { $null }; privateBytes=[int64]$memory.PrivateMemorySize64 } }); ConvertTo-Json -InputObject $items -Compress`;
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command]);
    const parsed = JSON.parse(stdout.trim());
    return (Array.isArray(parsed) ? parsed : [parsed]).sort((left, right) => right.workingSetBytes - left.workingSetBytes);
  }
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,rss=,comm="]);
  const rows = stdout.trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/, 4));
  const treeIds = new Set(await processTreeIds(pid));
  return rows.filter(([id]) => treeIds.has(Number(id))).map(([id, , rss, image]) => ({ pid: Number(id), role: Number(id) === pid ? "electron-main" : image, image, workingSetBytes: Number(rss) * 1024, privateWorkingSetBytes: null })).sort((left, right) => right.workingSetBytes - left.workingSetBytes);
}

async function privateWorkingSetWindowSamples(pid, sampleCount = 3, intervalMs = 300) {
  if (process.platform !== "win32") return [];
  const ids = await processTreeIds(pid);
  const powershellIds = ids.join(",");
  const command = `$ids=@(${powershellIds}); $filter=(($ids | ForEach-Object { "IDProcess = $_" }) -join ' OR '); $samples=@(); for ($index=0; $index -lt ${sampleCount}; $index++) { $rows=Get-CimInstance -ClassName Win32_PerfFormattedData_PerfProc_Process -Filter $filter; $value=($rows | Measure-Object -Property WorkingSetPrivate -Sum).Sum; $bytes=if ($null -ne $value) { [int64]$value } else { 0 }; $samples += [pscustomobject]@{ sampledAtUtc=[DateTime]::UtcNow.ToString('o'); privateWorkingSetBytes=$bytes }; if ($index -lt ${sampleCount - 1}) { Start-Sleep -Milliseconds ${intervalMs} } }; ConvertTo-Json -InputObject $samples -Compress`;
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command]);
    const parsed = JSON.parse(stdout.trim());
    return (Array.isArray(parsed) ? parsed : [parsed])
      .filter((sample) => sample && Number.isFinite(Number(sample.privateWorkingSetBytes)) && typeof sample.sampledAtUtc === "string")
      .map((sample) => ({ sampledAtUtc: sample.sampledAtUtc, privateWorkingSetBytes: Number(sample.privateWorkingSetBytes) }));
  } catch {
    return [];
  }
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
      app = await launchDesktopApp(dataDir);
      page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded", { timeout: 15_000 });
      await page.waitForFunction(() => document.body.innerText.includes("Core connected"), undefined, { timeout: 20_000 });
      startupMs.push(Number((performance.now() - start).toFixed(3)));

      if (index === iterations - 1) {
        const memoryRootPid = await electronProcessRootPid(app.process().pid);
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 5000));
        const sampler = await startProcessTreeMemorySampler(memoryRootPid);
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
        const memoryRootPid = await electronProcessRootPid(app.process().pid);
        const sampler = await startProcessTreeMemorySampler(memoryRootPid);
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
    app = await launchDesktopApp(dataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 });
    await page.waitForFunction(() => document.body.innerText.includes("Core connected"), undefined, { timeout: 20_000 });
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 5000));
    const memoryRootPid = await electronProcessRootPid(app.process().pid);
    const idle = await processTreeMemoryBreakdown(memoryRootPid);
    const idlePrivateWorkingSetSamplesBytes = await privateWorkingSetWindowSamples(memoryRootPid);
    await openFixtureFromWindow(page);
    await page.reload();
    await page.getByRole("heading", { name: "Recent repositories" }).waitFor({ timeout: 15_000 });
    await page.locator(".repositoryRowOpen").first().click();
    await page.locator(".commitGraphEntry").first().waitFor({ timeout: 20_000 });
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 5000));
    const loaded = await processTreeMemoryBreakdown(memoryRootPid);
    const loadedPrivateWorkingSetSamplesBytes = await privateWorkingSetWindowSamples(memoryRootPid);
    const total = (processes) => ({
      workingSetBytes: processes.reduce((sum, process) => sum + process.workingSetBytes, 0),
      privateWorkingSetBytes: processes.every((process) => Number.isFinite(process.privateWorkingSetBytes))
        ? processes.reduce((sum, process) => sum + process.privateWorkingSetBytes, 0)
        : null,
      privateBytes: processes.every((process) => Number.isFinite(process.privateBytes))
        ? processes.reduce((sum, process) => sum + process.privateBytes, 0)
        : null,
    });
    return {
      idle,
      loaded,
      idleTotals: total(idle),
      loadedTotals: total(loaded),
      privateWorkingSetWindow: {
        requestedSleepBetweenSamplesMs: 300,
        idleSamples: idlePrivateWorkingSetSamplesBytes,
        idlePeakBytes: idlePrivateWorkingSetSamplesBytes.length ? Math.max(...idlePrivateWorkingSetSamplesBytes.map((sample) => sample.privateWorkingSetBytes)) : null,
        loadedSamples: loadedPrivateWorkingSetSamplesBytes,
        loadedPeakBytes: loadedPrivateWorkingSetSamplesBytes.length ? Math.max(...loadedPrivateWorkingSetSamplesBytes.map((sample) => sample.privateWorkingSetBytes)) : null,
      },
    };
  } finally {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function createCacheLifecycleRepositories(rootPath, repositoryCount, filesPerRepository) {
  const repositoryPaths = [];
  for (let repositoryIndex = 0; repositoryIndex < repositoryCount; repositoryIndex += 1) {
    const repositoryPath = join(rootPath, `repository-${String(repositoryIndex).padStart(2, "0")}`);
    await mkdir(repositoryPath, { recursive: true });
    await execFileAsync("git", ["init", "--quiet", "-b", "main", repositoryPath]);
    await execFileAsync("git", ["-C", repositoryPath, "-c", "user.name=GitCrest Benchmark", "-c", "user.email=benchmark@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "benchmark fixture"]);
    for (let fileIndex = 0; fileIndex < filesPerRepository; fileIndex += 1) {
      const fileName = `untracked-${String(fileIndex).padStart(4, "0")}.txt`;
      await writeFile(join(repositoryPath, fileName), `repository ${repositoryIndex} file ${fileIndex}\n`);
    }
    repositoryPaths.push(repositoryPath);
  }
  return repositoryPaths;
}

async function registerRepositoriesFromWindow(page, paths) {
  const result = await page.evaluate(async (repositoryPaths) => {
    const connection = await window.gitcrest.getSidecarConnection();
    const repositories = [];
    for (const path of repositoryPaths) {
      const response = await fetch(new URL("/api/v1/repositories", connection.baseUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${connection.token}`,
          "X-GitCrest-API-Version": "1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ path }),
      });
      const body = await response.json();
      if (response.status !== 200) throw new Error(`Could not register cache fixture: ${JSON.stringify(body)}`);
      repositories.push(body);
    }
    return repositories;
  }, paths);
  if (result.length !== paths.length) throw new Error("Not all cache lifecycle repositories were registered.");
  return result;
}

async function rendererHeapUsage(page) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Performance.enable");
    await session.send("HeapProfiler.enable");
    await session.send("HeapProfiler.collectGarbage");
    const { metrics } = await session.send("Performance.getMetrics");
    return metrics.find(({ name }) => name === "JSHeapUsedSize")?.value ?? null;
  } finally {
    await session.detach();
  }
}

async function runCacheLifecycle() {
  const repositoryCount = Number(process.env.GITCREST_BENCH_CACHE_REPOSITORIES || 32);
  const filesPerRepository = Number(process.env.GITCREST_BENCH_CACHE_FILES || 1_000);
  if (!Number.isInteger(repositoryCount) || repositoryCount < 2 || repositoryCount > 100) {
    throw new Error("GITCREST_BENCH_CACHE_REPOSITORIES must be an integer from 2 to 100.");
  }
  if (!Number.isInteger(filesPerRepository) || filesPerRepository < 1 || filesPerRepository > 10_000) {
    throw new Error("GITCREST_BENCH_CACHE_FILES must be an integer from 1 to 10000.");
  }

  const dataDir = await mkdtemp(join(os.tmpdir(), "gitcrest-s7.2-cache-lifecycle-"));
  let app;
  try {
    const repositoryPaths = await createCacheLifecycleRepositories(
      join(dataDir, "repositories"),
      repositoryCount,
      filesPerRepository,
    );
    app = await launchDesktopApp(dataDir);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 });
    await page.waitForFunction(() => document.body.innerText.includes("Core connected"), undefined, { timeout: 20_000 });
    const repositories = await registerRepositoriesFromWindow(page, repositoryPaths);
    await page.reload();
    await page.getByRole("heading", { name: "Recent repositories" }).waitFor({ timeout: 15_000 });

    for (let index = 0; index < repositories.length; index += 1) {
      const name = `repository-${String(index).padStart(2, "0")}`;
      await page.getByRole("button", { name: "Welcome", exact: true }).click();
      await page.locator(".repositoryRowOpen").filter({ hasText: name }).click();
      await page.waitForFunction(
        (expectedFiles) => document.querySelectorAll(".statusFileRow").length === expectedFiles,
        filesPerRepository,
        { timeout: 20_000 },
      );
    }

    const activeName = "repository-00";
    await page.getByRole("tab", { name: activeName }).click();
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 2_000));
    const openState = {
      rendererJsHeapBytes: await rendererHeapUsage(page),
      processes: await processTreeMemoryBreakdown(await electronProcessRootPid(app.process().pid)),
      visibleStatusRows: await page.locator(".statusFileRow").count(),
      openRepositoryTabs: await page.getByRole("tab").count(),
    };

    for (let index = repositories.length - 1; index > 0; index -= 1) {
      const name = `repository-${String(index).padStart(2, "0")}`;
      await page.getByRole("button", { name: `Close ${name} tab` }).evaluate((button) => button.click());
    }
    await page.waitForFunction(
      () => document.querySelectorAll('[role="tab"]').length === 1,
      undefined,
      { timeout: 10_000 },
    );
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 2_000));
    const closedState = {
      rendererJsHeapBytes: await rendererHeapUsage(page),
      processes: await processTreeMemoryBreakdown(await electronProcessRootPid(app.process().pid)),
      visibleStatusRows: await page.locator(".statusFileRow").count(),
      openRepositoryTabs: await page.getByRole("tab").count(),
    };
    const workingSetTotal = (state) => state.processes.reduce((sum, process) => sum + process.workingSetBytes, 0);
    return {
      repositories: repositoryCount,
      untrackedFilesPerRepository: filesPerRepository,
      totalCachedStatusFilesBeforeClose: repositoryCount * filesPerRepository,
      openState,
      afterCloseState: closedState,
      deltaAfterClose: {
        rendererJsHeapBytes: closedState.rendererJsHeapBytes !== null && openState.rendererJsHeapBytes !== null
          ? closedState.rendererJsHeapBytes - openState.rendererJsHeapBytes
          : null,
        processTreeWorkingSetBytes: workingSetTotal(closedState) - workingSetTotal(openState),
      },
      method: "Renderer heap is garbage-collected through CDP before sampling. Process Working Set is sampled once after a 2-second settle interval.",
    };
  } finally {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function runScrollIteration(iteration) {
  const dataDir = await mkdtemp(join(os.tmpdir(), "gitcrest-s7.2-scroll-"));
  let app;
  try {
    app = await launchDesktopApp(dataDir);
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

    const sampler = await startProcessTreeMemorySampler(await electronProcessRootPid(app.process().pid), 500);
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
    return { iteration, idleAnimationFrame, scroll, workMemorySampleCount: sampler.samples.length, workMemoryPeakBytes: Math.max(...sampler.samples) };
  } finally {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

function summarizeMeasuredValues(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    samples: values.length,
    p5: nearestRank(sorted, 0.05),
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    max: Math.max(...values),
    samplesValues: values,
  };
}

async function runScroll() {
  const samples = [];
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    process.stdout.write(`Running desktop scroll benchmark ${iteration}/${iterations}…\n`);
    samples.push(await runScrollIteration(iteration));
  }
  return {
    iterations: samples,
    idleAnimationFrameP5Fps: summarizeMeasuredValues(samples.map(({ idleAnimationFrame }) => idleAnimationFrame.p5Fps)),
    scrollP5Fps: summarizeMeasuredValues(samples.map(({ scroll }) => scroll.p5Fps)),
    workMemoryPeakBytes: summarizeMeasuredValues(samples.map(({ workMemoryPeakBytes }) => workMemoryPeakBytes)),
  };
}

const startedAt = new Date().toISOString();
const scrollOnly = process.env.GITCREST_BENCH_MODE === "scroll";
const memoryOnly = process.env.GITCREST_BENCH_MODE === "memory";
const cacheLifecycleOnly = process.env.GITCREST_BENCH_MODE === "cache-lifecycle";
if (iterations < 20 && process.env.GITCREST_BENCH_ALLOW_BATCH !== "1") {
  throw new Error("The plan requires at least 20 measured runs; use GITCREST_BENCH_ITERATIONS >= 20 or the batch runner.");
}
const memorySnapshot = memoryOnly ? await runMemorySnapshot() : null;
const repositoryCacheLifecycle = cacheLifecycleOnly ? await runCacheLifecycle() : null;
const cold = scrollOnly
  || memoryOnly
  || cacheLifecycleOnly
  ? { startupMs: [], firstHistoryFrameMs: [], idleMemorySamplesBytes: [], repositoryMemorySamplesBytes: [] }
  : await runColdLaunch();
const scroll = memoryOnly || cacheLifecycleOnly ? null : await runScroll();
const installerPath = join(root, "dist", "GitCrest Setup 0.1.0.exe");
let installerBytes = null;
try { installerBytes = (await stat(installerPath)).size; } catch {}
const report = {
  mode: scrollOnly ? "scroll-only" : memoryOnly ? "memory-only" : cacheLifecycleOnly ? "cache-lifecycle" : "full",
  generatedAt: new Date().toISOString(),
  host: { os: `${os.type()} ${os.release()}`, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model || "unknown", logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(), storage: await storageInfo() },
  software: { electron: process.versions.electron || "37.0.0", node: process.version, rendererBuild: "production electron-vite build", rustProfile: "release", launchMode: "packaged application", applicationExecutable: packagedAppExecutablePath(), launchFlags: benchmarkGpuFlags(), electronUserDataProfileIsolatedPerRun: true, memoryMeasurementRoot: "Electron main process and descendants; Playwright launcher excluded" },
  fixture: { commits: 100_000, diffFileLines: 1_000, path: fixturePath },
  iterations,
  startedAt,
  startup: summarize(cold.startupMs),
  firstHistoryFrame: summarize(cold.firstHistoryFrameMs),
  idleProcessTreeMemory: { sampleCount: cold.idleMemorySamplesBytes.length, peakBytes: cold.idleMemorySamplesBytes.length ? Math.max(...cold.idleMemorySamplesBytes) : null, samplesBytes: cold.idleMemorySamplesBytes },
  loadedRepositoryIdleProcessTreeMemory: { sampleCount: cold.repositoryMemorySamplesBytes.length, peakBytes: cold.repositoryMemorySamplesBytes.length ? Math.max(...cold.repositoryMemorySamplesBytes) : null, samplesBytes: cold.repositoryMemorySamplesBytes },
  processMemoryBreakdown: memorySnapshot,
  repositoryCacheLifecycle,
  work: scroll,
  installer: { path: installerBytes === null ? null : installerPath, bytes: installerBytes, mebibytes: installerBytes === null ? null : Number((installerBytes / (1024 * 1024)).toFixed(2)) },
  limitations: installerBytes === null ? ["Installer size is unavailable because electron-builder did not produce an installer."] : [],
};
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
