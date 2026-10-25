// S7.2 stage 551 (P1.3): process-tree memory after opening three Diffs of one repository from the main window.
// Usage: node doc/evidence/S7.2/diff-window-memory-probe-stage551.mjs <GitCrest.exe> [report.json]
// Each run uses a fresh profile and a three-file fixture repository. Trace is off; memory is sampled after a 5 s settle.
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";

const execFileAsync = promisify(execFile);
const executablePath = resolve(process.argv[2]);
const reportPath = process.argv[3] ? resolve(process.argv[3]) : undefined;
const runs = Number(process.env.GITCREST_PROBE_RUNS || 5);
const FILES = ["src/alpha.ts", "src/beta.ts", "src/gamma.ts"];

async function fixtureRepository() {
  const path = await mkdtemp(join(tmpdir(), "gitcrest-diff-window-repo-"));
  const git = (...args) => execFileSync("git", ["-C", path, ...args]);
  git("init", "--quiet");
  await mkdir(join(path, "src"));
  const lines = (label) => Array.from({ length: 200 }, (_, index) => `export const ${label}${index} = ${index};`).join("\n") + "\n";
  for (const file of FILES) await writeFile(join(path, file), lines("value"));
  git("add", ".");
  git("-c", "user.name=probe", "-c", "user.email=probe@example.com", "commit", "--quiet", "-m", "init");
  for (const file of FILES) await writeFile(join(path, file), lines("changed"));
  return path;
}

// Working Set from Get-Process and Private Working Set from the PerfProc counter, summed over the main process tree.
async function processTreeMemory(rootPid) {
  const command = `$rootPid=${rootPid}; $processes=Get-CimInstance Win32_Process; $ids=@([uint32]$rootPid); do { $previousCount=$ids.Count; $ids += @($processes | Where-Object { $ids -contains $_.ParentProcessId } | ForEach-Object { [uint32]$_.ProcessId }); $ids=@($ids | Select-Object -Unique) } while ($ids.Count -gt $previousCount); $filter=(($ids | ForEach-Object { "IDProcess = $_" }) -join ' OR '); $private=(Get-CimInstance -ClassName Win32_PerfFormattedData_PerfProc_Process -Filter $filter | Measure-Object -Property WorkingSetPrivate -Sum).Sum; $ws=(Get-Process -Id $ids -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum).Sum; $renderers=@($processes | Where-Object { $ids -contains $_.ProcessId -and $_.CommandLine -match '--type=renderer' }).Count; ConvertTo-Json -Compress @{ processes=$ids.Count; renderers=$renderers; workingSetBytes=[int64]$ws; privateWorkingSetBytes=[int64]$private }`;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command]);
  return JSON.parse(stdout.trim());
}

async function probeOnce(repositoryPath) {
  const dataDir = await mkdtemp(join(tmpdir(), "gitcrest-diff-window-probe-"));
  const app = await electron.launch({
    executablePath,
    args: ["--lang=en-US", `--user-data-dir=${join(dataDir, "user-data")}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: join(dataDir, "gitcrest.sqlite") },
  });
  try {
    const window = await app.firstWindow();
    await window.getByText("Core connected").waitFor({ timeout: 20_000 });
    const status = await window.evaluate(async (path) => {
      const connection = await window.gitcrest.getSidecarConnection();
      const response = await fetch(new URL("/api/v1/repositories", connection.baseUrl), {
        method: "POST",
        headers: { Authorization: `Bearer ${connection.token}`, "X-GitCrest-API-Version": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      return response.status;
    }, repositoryPath);
    if (status !== 200) throw new Error(`Could not register the probe repository (${status}).`);
    await window.reload();
    await window.locator(".repositoryRowOpen").first().click();
    for (const file of FILES) {
      await window.getByRole("button", { name: `modified ${file}` }).click();
      await window.getByRole("button", { name: "Open in Diff window" }).click();
      // Wait until some Diff window shows this file, whether it is a new window or a new tab.
      await waitFor(async () => {
        for (const page of app.windows()) {
          if (page === window) continue;
          if (await page.locator(".diffWindowHeader h1").getAttribute("title").catch(() => null) === file) return true;
        }
        return false;
      }, 20_000, `a Diff window showing ${file}`);
    }
    const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
    const memory = await processTreeMemory(app.process().pid);
    return { windows, ...memory };
  } finally {
    await app.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function nearestRank(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

const repositoryPath = await fixtureRepository();
const samples = [];
try {
  for (let index = 0; index < runs; index += 1) {
    samples.push(await probeOnce(repositoryPath));
    process.stdout.write(`run ${index + 1}/${runs}: ${JSON.stringify(samples.at(-1))}\n`);
  }
} finally {
  await rm(repositoryPath, { recursive: true, force: true }).catch(() => undefined);
}
const mib = (bytes) => Number((bytes / 1048576).toFixed(1));
const summary = (key) => ({ p50MiB: mib(nearestRank(samples.map((sample) => sample[key]), 0.5)), maxMiB: mib(Math.max(...samples.map((sample) => sample[key]))) });
const report = {
  stage: 551,
  generatedAt: new Date().toISOString(),
  executablePath,
  method: "Main window opens Diffs for three modified files of one repository (200-line files) with \"Open in Diff window\"; after the last one shows and a 5 s settle, Working Set and Private Working Set are summed over the main process tree.",
  runs,
  workingSet: summary("workingSetBytes"),
  privateWorkingSet: summary("privateWorkingSetBytes"),
  samples,
};
if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ...report, samples: undefined }, null, 2));
