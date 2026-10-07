// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConflictWindow } from "../../src/features/workflows/ConflictWindow";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("loads bounded three-way content using read-only window access", async () => {
  const repoId = `repo_${"a".repeat(64)}`;
  window.history.replaceState({}, "", `/?view=conflicts&repoId=${repoId}&taskId=task-123-1`);
  Object.defineProperty(window, "gitcrest", {
    configurable: true,
    value: { getSidecarConnection: vi.fn().mockResolvedValue({ baseUrl: "http://127.0.0.1:4100", token: "read-only", windowAccess: "readOnly" }) },
  });
  const preview = {
    repoId, taskId: "task-123-1", operation: "merge", headOid: "a".repeat(40), dirtyPaths: ["conflict.ts"],
    omittedDirtyPathCount: 0, conflictedPaths: ["conflict.ts"], omittedConflictedPathCount: 0, canContinue: false, canSkip: false, canAbort: true,
  };
  const conflict = {
    repoId, taskId: "task-123-1", path: "conflict.ts", operation: "merge", headOid: "a".repeat(40),
    baseContent: "base value", oursContent: "ours value", theirsContent: "theirs value", resultContent: "<<<<<<< ours", resultRevision: "b".repeat(64), isText: true,
  };
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input);
    const body = url.includes("conflicts/file") ? conflict : preview;
    return new Response(JSON.stringify(body), { status: 200, headers: { "X-GitCrest-API-Version": "1" } });
  }));
  render(<ConflictWindow />);
  expect(await screen.findByText("base value")).toBeTruthy();
  expect(screen.getByText("ours value")).toBeTruthy();
  expect(screen.getByText("theirs value")).toBeTruthy();
  expect(screen.getByText("<<<<<<< ours")).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
});
