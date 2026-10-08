// @vitest-environment node
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { resolveSidecarPath } from "../../electron/main/sidecar-path";

it.each([
  ["win32", "gitcrest-core.exe"],
  ["darwin", "gitcrest-core"],
  ["linux", "gitcrest-core"],
] as const)("resolves the packaged %s sidecar name", (platform, executable) => {
  expect(resolveSidecarPath(platform, true, "resources", "app")).toBe(join("resources", "bin", executable));
});

it("resolves the platform-specific development sidecar beside the app", () => {
  expect(resolveSidecarPath("win32", false, "resources", "app")).toBe(resolve("app", "crates", "gitcrest-core", "target", "debug", "gitcrest-core.exe"));
  expect(resolveSidecarPath("linux", false, "resources", "app")).toBe(resolve("app", "crates", "gitcrest-core", "target", "debug", "gitcrest-core"));
});

it("rejects platforms without a sidecar build target", () => {
  expect(() => resolveSidecarPath("freebsd", true, "resources", "app")).toThrow("does not package a sidecar for freebsd");
});
