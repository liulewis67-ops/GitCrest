import { join, resolve } from "node:path";

export function resolveSidecarPath(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  resourcesPath: string,
  appPath: string,
): string {
  const executable = platform === "win32" ? "gitcrest-core.exe" : "gitcrest-core";
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    throw new Error(`GitCrest does not package a sidecar for ${platform}.`);
  }

  return isPackaged
    ? join(resourcesPath, "bin", executable)
    : resolve(appPath, "crates", "gitcrest-core", "target", "debug", executable);
}
