import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";

const root = process.cwd();
const output = join(root, "dist");
const executable = await findPackagedExecutable(output);
const appData = await mkdtemp(join(tmpdir(), "gitcrest-package-smoke-"));
let app;
let sidecarUrl;

try {
  app = await electron.launch({
    executablePath: executable,
    args: [],
    env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: join(appData, "gitcrest.sqlite") },
  });
  const runtime = await app.evaluate(({ app: electronApp }) => ({
    isPackaged: electronApp.isPackaged,
    resourcesPath: process.resourcesPath,
    platform: process.platform,
  }));
  assert.equal(runtime.isPackaged, true, "smoke test should launch the packaged Electron application");
  const sidecarName = runtime.platform === "win32" ? "gitcrest-core.exe" : "gitcrest-core";
  assert.equal(existsSync(join(runtime.resourcesPath, "bin", sidecarName)), true, "platform sidecar should be copied to resources/bin");
  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded", { timeout: 15_000 });
  await window.getByText("Core connected").waitFor({ timeout: 20_000 });
  sidecarUrl = await window.evaluate(async () => {
    const connection = await window.gitcrest.getSidecarConnection();
    return connection.baseUrl;
  });
  const health = await fetch(new URL("/health", sidecarUrl));
  assert.equal(health.status, 204, "packaged sidecar health probe should succeed");
} finally {
  await app?.close();
  await rm(appData, { recursive: true, force: true });
}

if (sidecarUrl) {
  const deadline = Date.now() + 5_000;
  let exited = false;
  while (Date.now() < deadline) {
    try {
      await fetch(new URL("/health", sidecarUrl), { signal: AbortSignal.timeout(250) });
    } catch {
      exited = true;
      break;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  assert.equal(exited, true, "sidecar should stop when the packaged Electron app closes");
}

console.log(`Packaged startup and sidecar shutdown passed: ${executable}`);

async function findPackagedExecutable(distPath) {
  if (process.platform === "win32") return join(distPath, "win-unpacked", "GitCrest.exe");
  if (process.platform === "linux") return join(distPath, "linux-unpacked", "gitcrest");
  if (process.platform === "darwin") {
    const entries = await readdir(distPath, { withFileTypes: true });
    const macDirectory = entries.find((entry) => entry.isDirectory() && entry.name.startsWith("mac"));
    if (macDirectory) return join(distPath, macDirectory.name, "GitCrest.app", "Contents", "MacOS", "GitCrest");
  }
  throw new Error(`No packaged GitCrest executable was found for ${process.platform} in ${resolve(distPath)}.`);
}
