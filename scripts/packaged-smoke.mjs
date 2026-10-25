import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "playwright";
import { isUpdateFeedConfigured } from "../electron/main/update-config-policy.mjs";

const root = process.cwd();
const output = resolve(process.env.GITCREST_PACKAGED_OUTPUT ?? join(root, "dist"));
let executable = await findPackagedExecutable(output);
await assertReleaseArtifactSizes(output);
let appData;
let installDirectory;
let diskImageMountPoint;
let diskImageMounted = false;
let app;
let sidecarUrl;

try {
  appData = await mkdtemp(join(tmpdir(), "gitcrest-package-smoke-"));
  if (process.platform === "win32") {
    installDirectory = join(appData, "installed");
    await mkdir(installDirectory);
    const installer = await findWindowsInstaller(output);
    await runProcess(installer, ["/S", `/D=${installDirectory}`]);
    executable = join(installDirectory, "GitCrest.exe");
    assert.equal(existsSync(executable), true, "the Windows installer should place GitCrest.exe in the requested install directory");
  } else if (process.platform === "darwin") {
    installDirectory = join(appData, "installed");
    diskImageMountPoint = join(appData, "mounted");
    await mkdir(installDirectory);
    await mkdir(diskImageMountPoint);
    await runProcess("hdiutil", ["attach", await findMacDiskImage(output), "-nobrowse", "-readonly", "-mountpoint", diskImageMountPoint]);
    diskImageMounted = true;
    const mountedApp = join(diskImageMountPoint, "GitCrest.app");
    assert.equal(existsSync(mountedApp), true, "the macOS DMG should contain GitCrest.app");
    const installedApp = join(installDirectory, "GitCrest.app");
    await cp(mountedApp, installedApp, { recursive: true });
    executable = join(installedApp, "Contents", "MacOS", "GitCrest");
    assert.equal(existsSync(executable), true, "the mounted macOS app should copy into the isolated install directory");
  }
  app = await electron.launch({
    executablePath: executable,
    // The UI follows the system language, and the waits below match English text.
    args: ["--lang=en-US"],
    env: {
      ...process.env,
      ...(process.platform === "linux" ? { APPIMAGE_EXTRACT_AND_RUN: "1" } : {}),
      ELECTRON_RENDERER_URL: "",
      GITCREST_DATABASE_PATH: join(appData, "gitcrest.sqlite"),
    },
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
  const updateStatus = await window.evaluate(async () => window.gitcrest.getUpdateStatus());
  const updateConfigPath = join(runtime.resourcesPath, "app-update.yml");
  const updateConfig = existsSync(updateConfigPath) ? await readFile(updateConfigPath, "utf8") : undefined;
  const expectedUpdateState = isUpdateFeedConfigured(true, runtime.platform, updateConfig) ? "idle" : "notConfigured";
  assert.equal(
    updateStatus.state,
    expectedUpdateState,
    "packaged update state should match the platform-specific updater trust policy",
  );
  sidecarUrl = await window.evaluate(async () => {
    const connection = await window.gitcrest.getSidecarConnection();
    return connection.baseUrl;
  });
  const health = await fetch(new URL("/health", sidecarUrl));
  assert.equal(health.status, 204, "packaged sidecar health probe should succeed");
} finally {
  try {
    await app?.close();
    if (sidecarUrl) await assertSidecarStopped(sidecarUrl);
  } finally {
    try {
      if (installDirectory) {
        if (process.platform === "win32") {
          const uninstaller = join(installDirectory, "Uninstall GitCrest.exe");
          if (existsSync(uninstaller)) await runProcess(uninstaller, ["/S"]);
        }
      }
    } finally {
      try {
        if (diskImageMounted && diskImageMountPoint) {
          await runProcess("hdiutil", ["detach", diskImageMountPoint]);
          diskImageMounted = false;
        }
      } finally {
        if (appData) {
          await removeTemporaryDirectory(appData);
        }
      }
    }
  }
}

async function removeTemporaryDirectory(path) {
  const deadline = Date.now() + 5_000;
  let lastError;
  while (existsSync(path) && Date.now() < deadline) {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    } catch (error) {
      lastError = error;
    }
    if (existsSync(path)) await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  if (existsSync(path)) {
    if (lastError) throw lastError;
    assert.fail("the temporary packaged smoke directory should be removed");
  }
}

console.log(`Packaged installation, startup and sidecar shutdown passed: ${executable}`);

async function assertReleaseArtifactSizes(distPath) {
  const entries = await readdir(distPath, { withFileTypes: true });
  const extension = process.platform === "win32" ? ".exe" : process.platform === "darwin" ? undefined : ".AppImage";
  const artifacts = entries.filter((entry) => entry.isFile() && (extension ? entry.name.endsWith(extension) : /\.(dmg|zip)$/i.test(entry.name)));
  assert.ok(artifacts.length > 0, `release artifacts should exist in ${distPath}`);
  const maxBytes = 150 * 1024 * 1024;
  for (const artifact of artifacts) {
    const bytes = (await stat(join(distPath, artifact.name))).size;
    assert.ok(bytes < maxBytes, `${artifact.name} is ${bytes} bytes, above the 150 MiB package limit`);
  }
}

async function findPackagedExecutable(distPath) {
  if (process.platform === "win32") return join(distPath, "win-unpacked", "GitCrest.exe");
  if (process.platform === "linux") return await findLinuxAppImage(distPath);
  if (process.platform === "darwin") {
    const entries = await readdir(distPath, { withFileTypes: true });
    const macDirectory = entries.find((entry) => entry.isDirectory() && entry.name.startsWith("mac"));
    if (macDirectory) return join(distPath, macDirectory.name, "GitCrest.app", "Contents", "MacOS", "GitCrest");
  }
  throw new Error(`No packaged GitCrest executable was found for ${process.platform} in ${resolve(distPath)}.`);
}

async function findLinuxAppImage(distPath) {
  const entries = await readdir(distPath, { withFileTypes: true });
  const appImages = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".appimage"))
    .map((entry) => join(distPath, entry.name));
  assert.ok(appImages.length > 0, `a Linux AppImage should exist in ${resolve(distPath)}`);
  return appImages.sort((left, right) => right.localeCompare(left))[0];
}

async function findWindowsInstaller(distPath) {
  const entries = await readdir(distPath, { withFileTypes: true });
  const installers = entries
    .filter((entry) => entry.isFile() && /^GitCrest Setup .*\.exe$/i.test(entry.name))
    .map((entry) => join(distPath, entry.name));
  assert.ok(installers.length > 0, `a Windows NSIS installer should exist in ${resolve(distPath)}`);
  return installers.sort((left, right) => right.localeCompare(left))[0];
}

async function findMacDiskImage(distPath) {
  const entries = await readdir(distPath, { withFileTypes: true });
  const images = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".dmg"))
    .map((entry) => join(distPath, entry.name));
  assert.ok(images.length > 0, `a macOS DMG should exist in ${resolve(distPath)}`);
  return images.sort((left, right) => right.localeCompare(left))[0];
}

function runProcess(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: true });
    const timeout = setTimeout(() => child.kill(), 120_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} exited with code ${code ?? "null"} and signal ${signal ?? "none"}`));
    });
  });
}

async function assertSidecarStopped(baseUrl) {
  const deadline = Date.now() + 5_000;
  let unavailableSince;
  while (Date.now() < deadline) {
    try {
      await fetch(new URL("/health", baseUrl), { signal: AbortSignal.timeout(250) });
      unavailableSince = undefined;
    } catch {
      unavailableSince ??= Date.now();
      if (Date.now() - unavailableSince >= 1_000) return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  assert.fail("sidecar should stop when the packaged Electron app closes");
}
