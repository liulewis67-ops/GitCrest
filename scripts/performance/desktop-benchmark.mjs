import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

function makeAppEnv(databasePath) {
  const env = { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: databasePath };
  for (const key of Object.keys(env)) if (/^GITCREST_/i.test(key) && key !== "GITCREST_DATABASE_PATH") delete env[key];
  return env;
}

async function processTreeWorkingSetBytes(pid) {
  if (process.platform === "win32") {
    const command = `$rootPid=${pid}; $processes=Get-CimInstance Win32_Process; $ids=@([uint32]$rootPid); do { $previousCount=$ids.Count; $ids += @($processes | Where-Object { $ids -contains $_.ParentProcessId } | ForEach-Object { [uint32]$_.ProcessId }); $ids=@($ids | Select-Object -Unique) } while ($ids.Count -gt $previousCount); (Get-Process -Id $ids -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum).Sum`;
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command]);
    return Number(stdout.trim());
  }
  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,rss="]);
  const processes = stdout.trim().split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number)).filter((parts) => parts.length === 3);
  const ids = new Set([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [childPid, parentPid] of processes) {
      if (ids.has(parentPid) && !ids.has(childPid)) { ids.add(childPid); changed = true; }
    }
  }
  return processes.reduce((sum, [processId, , rssKb]) => sum + (ids.has(processId) ? rssKb * 1024 : 0), 0);
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
        for (let sample = 0; sample < 20; sample += 1) {
          idleMemorySamplesBytes.push(await processTreeWorkingSetBytes(app.process().pid));
          await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
        }
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
        for (let sample = 0; sample < 20; sample += 1) {
          repositoryMemorySamplesBytes.push(await processTreeWorkingSetBytes(app.process().pid));
          await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
        }
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

    const scrollPromise = page.evaluate(async () => {
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
    const memory = [];
    let scrolling = true;
    const monitor = (async () => {
      while (scrolling) {
        memory.push(await processTreeWorkingSetBytes(app.process().pid));
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
      }
    })();
    const scroll = await scrollPromise;
    scrolling = false;
    await monitor;
    return { scroll, workMemorySampleCount: memory.length, workMemoryPeakBytes: Math.max(...memory) };
  } finally {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

if (iterations < 20) throw new Error("The plan requires at least 20 measured runs; use GITCREST_BENCH_ITERATIONS >= 20.");
const startedAt = new Date().toISOString();
const cold = await runColdLaunch();
const scroll = await runScroll();
const installerPath = join(root, "dist", "GitCrest Setup 0.1.0.exe");
let installerBytes = null;
try { installerBytes = (await stat(installerPath)).size; } catch {}
const report = {
  generatedAt: new Date().toISOString(),
  host: { os: `${os.type()} ${os.release()}`, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model || "unknown", logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(), storage: await storageInfo() },
  software: { electron: process.versions.electron || "37.0.0", node: process.version, rendererBuild: "production electron-vite build", rustProfile: "release" },
  fixture: { commits: 100_000, diffFileLines: 1_000, path: fixturePath },
  iterations,
  startedAt,
  startup: { samples: cold.startupMs.length, p50Ms: nearestRank(cold.startupMs, 0.5), p95Ms: nearestRank(cold.startupMs, 0.95), maxMs: Math.max(...cold.startupMs), samplesMs: cold.startupMs },
  firstHistoryFrame: { samples: cold.firstHistoryFrameMs.length, p50Ms: nearestRank(cold.firstHistoryFrameMs, 0.5), p95Ms: nearestRank(cold.firstHistoryFrameMs, 0.95), maxMs: Math.max(...cold.firstHistoryFrameMs), samplesMs: cold.firstHistoryFrameMs },
  idleProcessTreeMemory: { sampleCount: cold.idleMemorySamplesBytes.length, peakBytes: Math.max(...cold.idleMemorySamplesBytes), samplesBytes: cold.idleMemorySamplesBytes },
  loadedRepositoryIdleProcessTreeMemory: { sampleCount: cold.repositoryMemorySamplesBytes.length, peakBytes: Math.max(...cold.repositoryMemorySamplesBytes), samplesBytes: cold.repositoryMemorySamplesBytes },
  work: scroll,
  installer: { path: installerBytes === null ? null : installerPath, bytes: installerBytes, mebibytes: installerBytes === null ? null : Number((installerBytes / (1024 * 1024)).toFixed(2)) },
  limitations: installerBytes === null ? ["Installer size is unavailable because electron-builder did not produce an installer."] : [],
};
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
