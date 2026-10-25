// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitCrestBridge, GitCrestDiffWindowRequest } from "../../src/api/bridge";
import { DiffWindow } from "../../src/features/diff/ui/DiffWindow";

vi.mock("../../src/features/diff/ui/MonacoDiffHunk", () => ({
  MonacoDiffHunk: () => createElement("pre"),
}));

const repoId = `repo_${"a".repeat(64)}`;

afterEach(() => {
  cleanup();
  delete window.gitcrest;
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

function apiResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "X-GitCrest-API-Version": "1" } });
}

function binaryDiff(path: string) {
  return { repoId, path, revision: null, originalPath: null, scope: "workingTree", changeKind: "modified", status: "binary", hunks: [] };
}

/** Opens a Diff window for src/a.ts whose status read waits until the test releases it. */
function openDiffWindow() {
  window.history.replaceState(null, "", `/?view=diff&repoId=${repoId}&path=src/a.ts&scope=workingTree`);
  let releaseStatus: () => void = () => undefined;
  const statusRead = new Promise<void>((resolve) => { releaseStatus = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (input: URL) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/status")) {
      await statusRead;
      return apiResponse({ repoId, files: [
        { path: "src/a.ts", categories: ["unstaged"] },
        { path: "src/b.ts", categories: ["unstaged"] },
      ] });
    }
    return apiResponse(binaryDiff(url.searchParams.get("path") || ""));
  }));
  let deliver: (requests: GitCrestDiffWindowRequest[]) => void = () => undefined;
  const bridge: GitCrestBridge = {
    getSidecarConnection: vi.fn(async () => ({ baseUrl: "http://127.0.0.1:41001", token: "read-only", windowAccess: "readOnly" as const })),
    chooseRepository: vi.fn(),
    chooseCloneParent: vi.fn(),
    openDiffWindow: vi.fn(),
    openConflictWindow: vi.fn(),
    subscribeToEvents: vi.fn(async () => () => undefined),
    subscribeToDiffWindowRequests: (listener) => {
      deliver = listener;
      return () => { deliver = () => undefined; };
    },
  };
  window.gitcrest = bridge;
  render(<DiffWindow />);
  return { releaseStatus, deliver: (requests: GitCrestDiffWindowRequest[]) => act(() => deliver(requests)) };
}

function tabTitles() {
  return [...document.querySelectorAll(".diffWindowTabSelect")].map((tab) => tab.getAttribute("title"));
}

function activeTabTitle() {
  return document.querySelector('.diffWindowTabSelect[aria-current="page"]')?.getAttribute("title");
}

it("keeps a Diff sent while the window's own tabs load, and leaves it active", async () => {
  const { releaseStatus, deliver } = openDiffWindow();

  deliver([{ repoId, path: "src/c.ts", scope: "workingTree" }]);
  releaseStatus();

  await waitFor(() => expect(tabTitles()).toEqual(["Working tree · src/a.ts", "Working tree · src/b.ts", "Working tree · src/c.ts"]));
  expect(activeTabTitle()).toBe("Working tree · src/c.ts");
});

it("switches to a tab that is already open instead of adding it again, and ignores other repositories", async () => {
  const { releaseStatus, deliver } = openDiffWindow();
  releaseStatus();
  await waitFor(() => expect(tabTitles()).toHaveLength(2));
  expect(activeTabTitle()).toBe("Working tree · src/a.ts");

  deliver([{ repoId, path: "src/b.ts", scope: "workingTree" }]);
  expect(tabTitles()).toHaveLength(2);
  expect(activeTabTitle()).toBe("Working tree · src/b.ts");

  deliver([{ repoId: `repo_${"b".repeat(64)}`, path: "src/z.ts", scope: "workingTree" }]);
  expect(tabTitles()).toHaveLength(2);
  expect(activeTabTitle()).toBe("Working tree · src/b.ts");
});
