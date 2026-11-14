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

  await waitFor(() => expect(tabTitles()).toEqual(["Working tree: src/a.ts", "Working tree: src/b.ts", "Working tree: src/c.ts"]));
  expect(activeTabTitle()).toBe("Working tree: src/c.ts");
});

it("switches to a tab that is already open instead of adding it again, and ignores other repositories", async () => {
  const { releaseStatus, deliver } = openDiffWindow();
  releaseStatus();
  await waitFor(() => expect(tabTitles()).toHaveLength(2));
  expect(activeTabTitle()).toBe("Working tree: src/a.ts");

  deliver([{ repoId, path: "src/b.ts", scope: "workingTree" }]);
  expect(tabTitles()).toHaveLength(2);
  expect(activeTabTitle()).toBe("Working tree: src/b.ts");

  deliver([{ repoId: `repo_${"b".repeat(64)}`, path: "src/z.ts", scope: "workingTree" }]);
  expect(tabTitles()).toHaveLength(2);
  expect(activeTabTitle()).toBe("Working tree: src/b.ts");
});

it("opens a file of a comparison as a tab, lists the comparison's other files, and reads each between the two commits", async () => {
  const from = "c".repeat(40);
  const to = "d".repeat(40);
  window.history.replaceState(null, "", `/?view=diff&repoId=${repoId}&path=src/a.ts&scope=range&fromOid=${from}&toOid=${to}`);
  const urls: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: URL) => {
    const url = new URL(input);
    urls.push(url);
    if (url.pathname.endsWith("/compare")) {
      return apiResponse({ repoId, files: { items: [{ path: "src/a.ts", originalPath: null, kind: "modified" }, { path: "src/b.ts", originalPath: null, kind: "added" }], hasMore: false } });
    }
    return apiResponse({ repoId, path: url.searchParams.get("path"), revision: "r", originalPath: null, scope: "commit", changeKind: "modified", status: "empty", hunks: [] });
  }));
  window.gitcrest = {
    getSidecarConnection: vi.fn(async () => ({ baseUrl: "http://127.0.0.1:41001", token: "read-only", windowAccess: "readOnly" as const })),
    chooseRepository: vi.fn(), chooseCloneParent: vi.fn(), openDiffWindow: vi.fn(), openConflictWindow: vi.fn(),
    subscribeToEvents: vi.fn(async () => () => undefined),
    subscribeToDiffWindowRequests: () => () => undefined,
  } as GitCrestBridge;
  render(<DiffWindow />);

  await waitFor(() => expect(tabTitles()).toEqual(["Compare: src/a.ts", "Compare: src/b.ts"]));
  const compare = urls.find((url) => url.pathname.endsWith("/compare"))!;
  expect(Object.fromEntries(compare.searchParams)).toMatchObject({ base: from, head: to, mode: "twoDot" });
  await waitFor(() => expect(urls.some((url) => url.pathname.endsWith("/compare/diff"))).toBe(true));
  const diff = urls.find((url) => url.pathname.endsWith("/compare/diff"))!;
  expect(Object.fromEntries(diff.searchParams)).toMatchObject({ from, to, path: "src/a.ts" });
  // Blame needs one commit, so it is off for a comparison.
  expect((document.querySelector(".diffWindowBlameToggle button") as HTMLButtonElement).disabled).toBe(true);
});

it("opens a comparison with the working tree without an end commit", async () => {
  const from = "c".repeat(40);
  window.history.replaceState(null, "", `/?view=diff&repoId=${repoId}&path=src/a.ts&scope=range&fromOid=${from}`);
  const urls: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: URL) => {
    const url = new URL(input);
    urls.push(url);
    if (url.pathname.endsWith("/compare")) return apiResponse({ repoId, files: { items: [{ path: "src/a.ts", originalPath: null, kind: "modified" }], hasMore: false } });
    return apiResponse({ repoId, path: "src/a.ts", revision: "r", originalPath: null, scope: "commit", changeKind: "modified", status: "empty", hunks: [] });
  }));
  window.gitcrest = {
    getSidecarConnection: vi.fn(async () => ({ baseUrl: "http://127.0.0.1:41001", token: "read-only", windowAccess: "readOnly" as const })),
    chooseRepository: vi.fn(), chooseCloneParent: vi.fn(), openDiffWindow: vi.fn(), openConflictWindow: vi.fn(),
    subscribeToEvents: vi.fn(async () => () => undefined),
    subscribeToDiffWindowRequests: () => () => undefined,
  } as GitCrestBridge;
  render(<DiffWindow />);
  await waitFor(() => expect(urls.some((url) => url.pathname.endsWith("/compare/diff"))).toBe(true));
  const diff = urls.find((url) => url.pathname.endsWith("/compare/diff"))!;
  expect(diff.searchParams.get("to")).toBeNull();
  expect(urls.find((url) => url.pathname.endsWith("/compare"))!.searchParams.get("head")).toBeNull();
});

it("refuses a comparison window whose start is not a commit ID", async () => {
  window.history.replaceState(null, "", `/?view=diff&repoId=${repoId}&path=src/a.ts&scope=range&fromOid=main`);
  vi.stubGlobal("fetch", vi.fn());
  window.gitcrest = {
    getSidecarConnection: vi.fn(), chooseRepository: vi.fn(), chooseCloneParent: vi.fn(), openDiffWindow: vi.fn(), openConflictWindow: vi.fn(),
    subscribeToEvents: vi.fn(async () => () => undefined),
  } as unknown as GitCrestBridge;
  render(<DiffWindow />);
  await waitFor(() => expect(document.querySelector(".diffSpecialState[role=alert]")?.textContent).toContain("invalid"));
});
