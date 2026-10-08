// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { getGitCrestBridge, requireGitCrestBridge, type GitCrestBridge } from "../../src/api/bridge";

afterEach(() => {
  delete window.gitcrest;
});

describe("desktop bridge adapter", () => {
  it("reports the preload bridge as unavailable in browser preview", () => {
    expect(getGitCrestBridge()).toBeUndefined();
    expect(() => requireGitCrestBridge()).toThrow("Open this feature in the GitCrest desktop app.");
  });

  it("returns the installed preload bridge", () => {
    const bridge = {} as GitCrestBridge;
    window.gitcrest = bridge;
    expect(getGitCrestBridge()).toBe(bridge);
    expect(requireGitCrestBridge()).toBe(bridge);
  });
});
