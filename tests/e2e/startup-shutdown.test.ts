import { spawn, execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createTempGitRepository } from "../fixtures/temp-repo";

const exec = promisify(execFile);
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const token = "startup-shutdown-test-token";

function startCore(database: string, extra: NodeJS.ProcessEnv = {}) {
  const child = spawn(resolve("crates/gitcrest-core/target/debug", process.platform === "win32" ? "gitcrest-core.exe" : "gitcrest-core"), [], {
    windowsHide: true,
    env: { ...process.env, GITCREST_READONLY_TOKEN: "", GITCREST_CONFLICT_TOKEN: "", GITCREST_AUTH_TOKEN: token,
      GITCREST_DATABASE_PATH: database, GITCREST_HOST: "127.0.0.1", GITCREST_PORT: "0", ...extra },
    stdio: "pipe",
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
  child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
  child.stdin.on("error", () => {});
  const exited = new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("close", done);
  });
  return {
    child, exited,
    output: () => stdout,
    async ready() {
      await expect.poll(() => stdout.includes('"event":"ready"'), { timeout: 10_000 }).toBe(true);
      const line = stdout.split(/\r?\n/).find((item) => item.includes('"event":"ready"'))!;
      const ready = JSON.parse(line) as { host: string; port: number };
      return `http://${ready.host}:${ready.port}`;
    },
    async stop() {
      child.stdin.end();
      await expect.poll(() => child.exitCode !== null || child.signalCode !== null, { timeout: 10_000 }).toBe(true);
      expect(await exited, stderr).toBe(0);
    },
    async cleanup() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.end();
      const stopped = await Promise.race([exited.then(() => true), pause(2_000).then(() => false)]);
      if (!stopped) {
        if (process.platform === "win32") await exec("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
        else child.kill("SIGKILL");
        await exited;
      }
    },
  };
}

it("closing during database initialization never announces ready or starts orphan cleanup", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "gitcrest-startup-db-"));
  const database = resolve(directory, "core.sqlite");
  const marker = resolve(directory, "pipelines", "orphan", "valuable.txt");
  await mkdir(resolve(marker, ".."), { recursive: true });
  await writeFile(marker, "preserve me");
  const db = new DatabaseSync(database);
  db.exec("CREATE TABLE startup_probe(value TEXT); BEGIN EXCLUSIVE");
  const core = startCore(database);
  try {
    await pause(300);
    expect(core.child.exitCode).toBeNull();
    expect(core.output()).not.toContain('"event":"ready"');
    core.child.stdin.end();
    await pause(300);
    db.exec("COMMIT");
    await core.stop();
    expect(core.output()).not.toContain('"event":"ready"');
    expect(await readFile(marker, "utf8")).toBe("preserve me");
  } finally {
    db.close();
    await core.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it("accepts the parent's idle recovery request and exits cleanly without a forced stop", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "gitcrest-idle-recovery-"));
  const core = startCore(resolve(directory, "core.sqlite"));
  try {
    const baseUrl = await core.ready();
    core.child.stdin.write(`recover-if-idle ${Date.now() - 1}\n`);
    await pause(100);
    expect(core.output()).not.toContain('"event":"idleRecoveryAccepted"');

    const body = "{}";
    const pending = request(new URL("/api/v1/repositories", baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-GitCrest-API-Version": "1",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        Expect: "100-continue",
      },
    });
    pending.setTimeout(5_000, () => pending.destroy(new Error("Timed out waiting for the core")));
    try {
      const admitted = new Promise<void>((resolve, reject) => {
        pending.once("continue", resolve);
        pending.once("error", reject);
      });
      pending.flushHeaders();
      await admitted;
      core.child.stdin.write(`recover-if-idle ${Date.now() + 2_000}\n`);
      await pause(100);
      const health = await fetch(new URL("/health", baseUrl));
      expect(health.status).toBe(204);
      expect(core.output()).not.toContain('"event":"idleRecoveryAccepted"');
      const completed = new Promise<void>((resolve, reject) => {
        pending.once("error", reject);
        pending.once("response", (response) => {
          response.once("end", resolve);
          response.once("error", reject);
          response.resume();
        });
      });
      pending.end(body);
      await completed;
    } finally {
      pending.destroy();
    }

    core.child.stdin.write(`recover-if-idle ${Date.now() + 2_000}\n`);
    await expect.poll(() => core.output().includes('"event":"idleRecoveryAccepted"'), { timeout: 3_000 }).toBe(true);
    await expect(core.exited).resolves.toBe(0);
  } finally {
    await core.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
});

// A test executable at the Git boundary lets startup enter a real, blocked child
// without adding timing hooks or fault-injection flags to the application.
async function blockedGit(directory: string) {
  const wrapper = resolve(directory, "bin");
  await mkdir(wrapper);
  if (process.platform === "win32") {
    await writeFile(resolve(wrapper, "git.cs"), `using System;
using System.IO;
using System.Threading;
public class StartupGitProbe {
  public static void Main() {
    string dir = Environment.GetEnvironmentVariable("GITCREST_STARTUP_PROBE");
    File.WriteAllText(Path.Combine(dir, "entered"), "entered");
    var deadline = DateTime.UtcNow.AddSeconds(25);
    while (Directory.Exists(dir) && DateTime.UtcNow < deadline) {
      if (File.Exists(Path.Combine(dir, "release"))) {
        File.WriteAllText(Path.Combine(dir, "late"), "escaped");
        return;
      }
      Thread.Sleep(25);
    }
  }
}`);
    await writeFile(resolve(wrapper, "build.ps1"), 'Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot "git.cs")) -OutputAssembly (Join-Path $PSScriptRoot "git.exe") -OutputType ConsoleApplication\n');
    await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", resolve(wrapper, "build.ps1")], { windowsHide: true });
  } else {
    const path = resolve(wrapper, "git");
    await writeFile(path, '#!/bin/sh\nprintf entered > "$GITCREST_STARTUP_PROBE/entered"\ncount=0\nwhile [ -d "$GITCREST_STARTUP_PROBE" ] && [ "$count" -lt 500 ]; do\n if [ -f "$GITCREST_STARTUP_PROBE/release" ]; then printf escaped > "$GITCREST_STARTUP_PROBE/late"; exit 0; fi\n sleep 0.05\n count=$((count + 1))\ndone\n');
    await chmod(path, 0o755);
  }
  return wrapper;
}

it("closing during recovery stops its Git child and leaves orphan cleanup untouched", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "gitcrest-startup-recovery-"));
  const fixture = await createTempGitRepository();
  const database = resolve(directory, "core.sqlite");
  const first = startCore(database);
  let recovering: ReturnType<typeof startCore> | undefined;
  try {
    await writeFile(resolve(fixture.path, "base.txt"), "base\n");
    await exec("git", ["-C", fixture.path, "add", "base.txt"]);
    await exec("git", ["-C", fixture.path, "commit", "--quiet", "-m", "base"]);
    const oid = (await exec("git", ["-C", fixture.path, "rev-parse", "HEAD"])).stdout.trim();
    const branch = (await exec("git", ["-C", fixture.path, "branch", "--show-current"])).stdout.trim();
    const base = await first.ready();
    const response = await fetch(`${base}/api/v1/repositories`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "X-GitCrest-API-Version": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ path: fixture.path }),
    });
    expect(response.status).toBe(200);
    const { repoId } = await response.json() as { repoId: string };
    await first.stop();
    const db = new DatabaseSync(database);
    try {
      const rule = { ruleId: "startup", name: "Startup recovery", enabled: true, trigger: { kind: "afterPush", branchPattern: "*" },
        targets: [{ branch, remote: "origin" }], commands: [], mergeMode: "noFastForward", commitMessageTemplate: "merge",
        pushAfterMerge: true, onConflict: "openResolver", afterConflictResolved: "continue", confirmation: "auto" };
      db.prepare("INSERT INTO pipeline_runs VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)")
        .run("startup_run", repoId, JSON.stringify(rule), branch, oid, "switchInPlace", "running", Date.now(), Date.now());
      db.prepare("INSERT INTO pipeline_steps (run_id, position, target_branch, remote, state) VALUES (?, 0, ?, 'origin', 'merging')")
        .run("startup_run", branch);
    } finally { db.close(); }
    const marker = resolve(directory, "pipelines", "orphan", "valuable.txt");
    await mkdir(resolve(marker, ".."), { recursive: true });
    await writeFile(marker, "preserve me");
    const wrapper = await blockedGit(directory);
    recovering = startCore(database, { PATH: `${wrapper}${delimiter}${process.env.PATH ?? ""}`, GITCREST_STARTUP_PROBE: directory });
    await expect.poll(() => access(resolve(directory, "entered")).then(() => true, () => false), { timeout: 10_000 }).toBe(true);
    expect(recovering.output()).not.toContain('"event":"ready"');
    await recovering.stop();
    expect(recovering.output()).not.toContain('"event":"ready"');
    await writeFile(resolve(directory, "release"), "release");
    await pause(300);
    expect(await access(resolve(directory, "late")).then(() => true, () => false)).toBe(false);
    expect(await readFile(marker, "utf8")).toBe("preserve me");
    expect((await exec("git", ["-C", fixture.path, "rev-parse", "HEAD"])).stdout.trim()).toBe(oid);
    expect((await exec("git", ["-C", fixture.path, "status", "--porcelain"])).stdout.trim()).toBe("");
  } finally {
    await first.cleanup();
    await recovering?.cleanup();
    await rm(directory, { recursive: true, force: true });
    await fixture.cleanup();
  }
}, 60_000);
