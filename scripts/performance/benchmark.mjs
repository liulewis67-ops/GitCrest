import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultFixture = join(os.tmpdir(), "gitcrest-s7.2-100k-fixture");
const iterations = Number(process.env.GITCREST_BENCH_ITERATIONS || 20);
const args = process.argv.slice(2);

function usage() {
  process.stdout.write("Usage:\n  node scripts/performance/benchmark.mjs prepare [fixture-path]\n  node scripts/performance/benchmark.mjs run [fixture-path] [report-path]\n");
}

async function git(cwd, args, options = {}) {
  return execFileAsync("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024, ...options });
}

async function writeFastImport(stream, text) {
  if (!stream.write(text)) await new Promise((resolveWrite) => stream.once("drain", resolveWrite));
}

async function prepareFixture(fixturePath) {
  try {
    await stat(fixturePath);
    throw new Error(`Fixture path already exists; move it or choose another path: ${fixturePath}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  await mkdir(fixturePath, { recursive: true });
  await execFileAsync("git", ["init", "--quiet", "-b", "main", fixturePath]);
  const baseLines = Array.from({ length: 1000 }, (_, index) => `baseline row ${String(index + 1).padStart(4, "0")}`);
  const baseText = `${baseLines.join("\n")}\n`;
  const fastImport = spawn("git", ["-C", fixturePath, "fast-import", "--quiet"], { stdio: ["pipe", "ignore", "pipe"] });
  let errorOutput = "";
  fastImport.stderr.setEncoding("utf8").on("data", (chunk) => { errorOutput += chunk; });
  fastImport.stdin.on("error", () => {});

  const blobMark = 1;
  await writeFastImport(fastImport.stdin, `blob\nmark :${blobMark}\ndata ${Buffer.byteLength(baseText)}\n${baseText}\n`);
  let previousMark;
  for (let index = 0; index < 100_000; index += 1) {
    const mark = index + 2;
    const subject = `benchmark commit ${String(index + 1).padStart(6, "0")}`;
    const seconds = 1_700_000_000 + index;
    await writeFastImport(
      fastImport.stdin,
      `commit refs/heads/main\nmark :${mark}\nauthor GitCrest Benchmark <benchmark@example.invalid> ${seconds} +0000\ncommitter GitCrest Benchmark <benchmark@example.invalid> ${seconds} +0000\ndata ${Buffer.byteLength(subject)}\n${subject}\n${previousMark ? `from :${previousMark}\n` : ""}${index === 0 ? `M 100644 :${blobMark} bench-diff.txt\n` : ""}\n`,
    );
    previousMark = mark;
  }
  fastImport.stdin.end();
  const exitCode = await new Promise((resolveExit, rejectExit) => {
    fastImport.once("error", rejectExit);
    fastImport.once("close", (code) => resolveExit(code));
  });
  if (exitCode !== 0) throw new Error(`git fast-import failed (${exitCode}): ${errorOutput}`);
  await git(fixturePath, ["checkout", "--quiet", "main"]);
  await git(fixturePath, ["config", "user.name", "GitCrest Benchmark"]);
  await git(fixturePath, ["config", "user.email", "benchmark@example.invalid"]);

  const changedLines = baseLines.map((line, index) => `changed row ${String(index + 1).padStart(4, "0")} ${line}`);
  await writeFile(join(fixturePath, "bench-diff.txt"), `${changedLines.join("\n")}\n`);
  process.stdout.write(`Prepared ${fixturePath} with 100,000 commits and a 1,000-line working-tree diff.\n`);
}

async function waitReady(child, timeoutMs = 15_000, getStderr = () => "") {
  return new Promise((resolveReady, rejectReady) => {
    let output = "";
    const timeout = setTimeout(() => rejectReady(new Error(`Sidecar did not announce readiness. Output: ${output}`)), timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString();
      for (const line of output.split(/\r?\n/)) {
        try {
          const message = JSON.parse(line);
          if (message.event === "ready") {
            clearTimeout(timeout);
            child.stdout.off("data", onData);
            resolveReady({ host: message.host, port: message.port });
            return;
          }
        } catch {}
      }
    };
    child.stdout.on("data", onData);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectReady(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      rejectReady(new Error(`Sidecar exited before ready (${code}). stdout: ${output}; stderr: ${getStderr()}`));
    });
  });
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await new Promise((resolveExit) => child.once("exit", resolveExit));
}

async function memoryBytes(pid) {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).WorkingSet64`]);
    return Number(stdout.trim());
  }
  if (process.platform === "linux") {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const rss = status.match(/^VmRSS:\s+(\d+) kB$/m);
    return rss ? Number(rss[1]) * 1024 : null;
  }
  const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)]);
  return Number(stdout.trim()) * 1024;
}

function percentile(values, quantile = 0.95) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

async function measure(name, operation, count = iterations, beforeEach = async () => {}) {
  const samplesMs = [];
  for (let index = 0; index < count; index += 1) {
    await beforeEach(index);
    const start = performance.now();
    await operation(index);
    samplesMs.push(Number((performance.now() - start).toFixed(3)));
  }
  return { name, samples: samplesMs.length, p50Ms: percentile(samplesMs, 0.5), p95Ms: percentile(samplesMs), maxMs: Math.max(...samplesMs), samplesMs };
}

async function requestJson(url, token, method = "GET", body) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-GitCrest-API-Version": "1",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}: ${await response.text()}`);
  return response.json();
}

async function openEventSocket(baseUrl, token) {
  const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/v1/events`, "gitcrest.events.v1", {
    headers: { Authorization: `Bearer ${token}`, "X-GitCrest-API-Version": "1" },
  });
  await new Promise((resolveOpen, rejectOpen) => {
    socket.once("open", resolveOpen);
    socket.once("error", rejectOpen);
  });
  return socket;
}

function waitForEvent(socket, predicate, timeoutMs = 5_000) {
  return new Promise((resolveEvent, rejectEvent) => {
    const onMessage = (data) => {
      let event;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!predicate(event)) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolveEvent(event);
    };
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      rejectEvent(new Error("Timed out waiting for the expected watcher event."));
    }, timeoutMs);
    socket.on("message", onMessage);
  });
}

async function cpuModel() {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", "(Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name)"]);
    return stdout.trim();
  }
  return os.cpus()[0]?.model || "unknown";
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

function makeSidecarEnv(token, databasePath) {
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (/^GITCREST_/i.test(key)) delete childEnv[key];
  }
  Object.assign(childEnv, {
    GITCREST_AUTH_TOKEN: token,
    GITCREST_READONLY_TOKEN: `readonly-${randomUUID()}`,
    GITCREST_CONFLICT_TOKEN: `conflict-${randomUUID()}`,
    GITCREST_DATABASE_PATH: databasePath,
    GITCREST_HOST: "127.0.0.1",
    GITCREST_PORT: "0",
  });
  return childEnv;
}

async function startSidecar(executable, databasePath) {
  const token = `benchmark-${randomUUID()}`;
  const child = spawn(executable, [], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: makeSidecarEnv(token, databasePath),
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const address = await waitReady(child, 15_000, () => stderr);
  return { child, address, token, getStderr: () => stderr };
}

async function measureColdHistorySearch(executable, fixturePath, tempDataPath) {
  const samplesMs = [];
  const pendingResponseSamplesMs = [];
  for (let index = 0; index < iterations; index += 1) {
    const sampleDirectory = join(tempDataPath, `cold-search-${index + 1}`);
    const databasePath = join(sampleDirectory, "gitcrest.sqlite");
    let instance;
    try {
      await mkdir(sampleDirectory, { recursive: true });
      instance = await startSidecar(executable, databasePath);
      const baseUrl = `http://${instance.address.host}:${instance.address.port}`;
      const repository = await requestJson(`${baseUrl}/api/v1/repositories`, instance.token, "POST", { path: fixturePath });
      const startedAt = performance.now();
      const searchUrl = `${baseUrl}/api/v1/repositories/${repository.repoId}/commits?offset=0&limit=50&message=benchmark%20commit%20099999`;
      let page = await requestJson(searchUrl, instance.token);
      pendingResponseSamplesMs.push(Number((performance.now() - startedAt).toFixed(3)));
      const deadline = startedAt + 30_000;
      while (page.searchPending === true) {
        if (performance.now() >= deadline) throw new Error("Cold history search index did not become ready within 30 seconds.");
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
        page = await requestJson(searchUrl, instance.token);
      }
      samplesMs.push(Number((performance.now() - startedAt).toFixed(3)));
      if (!page.commits.some((commit) => commit.subject === "benchmark commit 099999")) {
        throw new Error("Cold history search did not return its matching commit.");
      }
    } finally {
      if (instance) await stop(instance.child);
      await rm(sampleDirectory, { recursive: true, force: true });
    }
  }
  return {
    name: "historySearch100kColdIndex",
    samples: samplesMs.length,
    p50Ms: percentile(samplesMs, 0.5),
    p95Ms: percentile(samplesMs),
    maxMs: Math.max(...samplesMs),
    samplesMs,
    pendingResponseP95Ms: percentile(pendingResponseSamplesMs),
    pendingResponseMaxMs: Math.max(...pendingResponseSamplesMs),
    pendingResponseSamplesMs,
  };
}

async function runBenchmark(fixturePath, reportPath) {
  const executable = join(root, "crates", "gitcrest-core", "target", "release", process.platform === "win32" ? "gitcrest-core.exe" : "gitcrest-core");
  const tempData = await mkdtemp(join(os.tmpdir(), "gitcrest-s7.2-data-"));
  const databasePath = join(tempData, "gitcrest.sqlite");
  let child;
  let eventSocket;
  try {
    const startup = await measure("sidecarStartupToReady", async () => {
      const startTime = performance.now();
      const instance = await startSidecar(executable, databasePath);
      try {
        if (!instance.address.port) throw new Error("Sidecar did not bind an ephemeral port.");
      } finally {
        await stop(instance.child);
      }
      return Number((performance.now() - startTime).toFixed(3));
    });
    const coldHistorySearch = await measureColdHistorySearch(executable, fixturePath, tempData);
    const started = await startSidecar(executable, databasePath);
    child = started.child;
    const address = started.address;
    const token = started.token;
    const baseUrl = `http://${address.host}:${address.port}`;
    const repository = await requestJson(`${baseUrl}/api/v1/repositories`, token, "POST", { path: fixturePath });
    const repoId = repository.repoId;
    eventSocket = await openEventSocket(baseUrl, token);
    const headers = { Authorization: `Bearer ${token}`, "X-GitCrest-API-Version": "1" };
    const fetchJson = async (url) => {
      const response = await fetch(`${baseUrl}${url}`, { headers });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}: ${await response.text()}`);
      return response.json();
    };
    const history = await measure("historyFirstPage100k", async () => {
      const page = await fetchJson(`/api/v1/repositories/${repoId}/commits?offset=0&limit=50`);
      if (page.commits.length !== 50) throw new Error(`Expected 50 history entries, got ${page.commits.length}`);
    });
    const historySearchWarmupStarted = performance.now();
    let historySearchWarmupAttempts = 0;
    let historySearchWarmupMs = null;
    let historySearchIndexReady = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      historySearchWarmupAttempts += 1;
      const attemptStarted = performance.now();
      const page = await fetchJson(`/api/v1/repositories/${repoId}/commits?offset=0&limit=50&message=benchmark%20commit%20099999`);
      if (page.searchPending === true) {
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
        continue;
      }
      if (!page.commits.some((commit) => commit.subject === "benchmark commit 099999")) throw new Error("History search did not return its matching commit.");
      if (started.getStderr().includes("History message index ready")) {
        historySearchIndexReady = true;
        historySearchWarmupMs = Number((performance.now() - historySearchWarmupStarted).toFixed(3));
        break;
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
    }
    const historySearch = await measure("historySearch100k", async () => {
      const page = await fetchJson(`/api/v1/repositories/${repoId}/commits?offset=0&limit=50&message=benchmark%20commit%20099999`);
      if (!page.commits.some((commit) => commit.subject === "benchmark commit 099999")) throw new Error("History search did not return its matching commit.");
    });
    const diffPath = join(fixturePath, "bench-diff.txt");
    const originalDiff = await readFile(diffPath, "utf8");
    let dirtyScopedStatus;
    try {
      dirtyScopedStatus = await measure(
        "dirtyScopedStatusSnapshot",
        async () => {
          const snapshot = await fetchJson(`/api/v1/repositories/${repoId}/status?paths=bench-diff.txt`);
          if (!snapshot.files.some((file) => file.path === "bench-diff.txt" && file.worktreeStatus !== ".")) {
            throw new Error("Dirty-scope status refresh did not return the modified benchmark file.");
          }
        },
        iterations,
        async (index) => {
          const eventPromise = waitForEvent(
            eventSocket,
            (event) => event.type === "status.changed" && event.repoId === repoId,
          );
          const lines = originalDiff.split("\n");
          lines[0] = `changed row 0001 scope-refresh-${index} baseline row 0001`;
          await writeFile(diffPath, lines.join("\n"));
          const event = await eventPromise;
          if (event.payload.full || !event.payload.paths?.includes("bench-diff.txt")) {
            throw new Error("The watcher did not publish the benchmark file as a dirty path scope.");
          }
        },
      );
    } finally {
      await writeFile(diffPath, originalDiff);
    }
    const forcedFullStatus = await measure("forcedFullStatusSnapshot", async () => {
      await fetchJson(`/api/v1/repositories/${repoId}/status?refresh=true`);
    });
    const fullStatus = await measure("fullStatusSnapshot", async () => { await fetchJson(`/api/v1/repositories/${repoId}/status`); });
    const partialStatus = await measure("incrementalStatusSnapshot", async () => { await fetchJson(`/api/v1/repositories/${repoId}/status?paths=bench-diff.txt`); });
    const diff = await measure("workingTreeDiff1000Lines", async () => {
      const result = await fetchJson(`/api/v1/repositories/${repoId}/diff?path=bench-diff.txt&scope=workingTree`);
      if (result.hunks?.length === 0) throw new Error("Diff benchmark returned no hunks.");
    });
    const workingSetBytes = await memoryBytes(child.pid);
    const report = {
      generatedAt: new Date().toISOString(),
      host: { os: `${os.type()} ${os.release()}`, platform: process.platform, arch: process.arch, cpu: await cpuModel(), logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(), storage: await storageInfo() },
      software: { node: process.version, git: (await execFileAsync("git", ["--version"])).stdout.trim(), rustProfile: "release", executable, executableBytes: (await stat(executable)).size },
      fixture: { commits: 100_000, diffFileLines: 1_000, path: fixturePath, historyQuery: "first page, 50 entries", searchQuery: "message contains benchmark commit 099999" },
      iterations,
      searchIndexWarmup: { ready: historySearchIndexReady, attempts: historySearchWarmupAttempts, elapsedMs: historySearchWarmupMs },
      results: [startup, coldHistorySearch, history, historySearch, dirtyScopedStatus, forcedFullStatus, fullStatus, partialStatus, diff],
      memory: { sidecarWorkingSetBytes: workingSetBytes, sampleCount: 1, note: "Sidecar only; Electron renderer and desktop process tree are not included." },
      limitations: ["This harness measures the Rust sidecar API and does not claim Electron cold start, desktop process-tree memory, 30-second scroll P5, or installer size."],
      stderr: started.getStderr().trim() || undefined,
    };
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    if (eventSocket?.readyState === WebSocket.OPEN) {
      eventSocket.close();
      await new Promise((resolveClose) => eventSocket.once("close", resolveClose));
    }
    if (child) await stop(child);
    await rm(tempData, { recursive: true, force: true });
  }
}

const command = args[0];
const fixturePath = resolve(args[1] || defaultFixture);
if (command === "prepare") {
  await prepareFixture(fixturePath);
} else if (command === "run") {
  if (iterations < 20) throw new Error("The plan requires at least 20 measured runs; use GITCREST_BENCH_ITERATIONS >= 20.");
  const reportPath = resolve(args[2] || join(root, "doc", "evidence", "S7.2", `api-${process.platform}.json`));
  await runBenchmark(fixturePath, reportPath);
} else {
  usage();
  process.exitCode = 2;
}
