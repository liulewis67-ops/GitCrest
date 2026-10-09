// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConflictWindow } from "../../src/features/workflows/ConflictWindow";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.gitcrest;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

it("shows a desktop-app requirement when the preload bridge is missing", async () => {
  const repoId = `repo_${"a".repeat(64)}`;
  window.history.replaceState({}, "", `/?view=conflicts&repoId=${repoId}&taskId=task-123-1`);
  render(<ConflictWindow />);
  expect(await screen.findByText("GitCrest desktop bridge is unavailable. Open this feature in the GitCrest desktop app.")).toBeTruthy();
});

it("aborts a conflict file read when the conflict window closes", async () => {
  const repoId = `repo_${"a".repeat(64)}`;
  const taskId = "task-123-1";
  window.history.replaceState({}, "", `/?view=conflicts&repoId=${repoId}&taskId=${taskId}`);
  Object.defineProperty(window, "gitcrest", {
    configurable: true,
    value: { getSidecarConnection: vi.fn().mockResolvedValue({ baseUrl: "http://127.0.0.1:4100", token: "conflict-scoped", windowAccess: "conflictResolution" }) },
  });
  const fileResponse = deferred<Response>();
  let fileSignal: AbortSignal | null | undefined;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((input, init) => {
    if (String(input).includes("conflicts/file")) {
      fileSignal = init?.signal;
      return fileResponse.promise;
    }
    return Promise.resolve(new Response(JSON.stringify({
      repoId, taskId, operation: "merge", headOid: "a".repeat(40), dirtyPaths: [], omittedDirtyPathCount: 0,
      conflictedPaths: ["conflict.ts"], omittedConflictedPathCount: 0, canContinue: false, canSkip: false, canAbort: true,
    }), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }));
  }));

  const view = render(<ConflictWindow />);
  await waitFor(() => expect(fileSignal).toBeTruthy());
  view.unmount();
  expect(fileSignal?.aborted).toBe(true);
  await act(async () => fileResponse.resolve(new Response(JSON.stringify({
    repoId, taskId, path: "conflict.ts", operation: "merge", headOid: "a".repeat(40),
    baseContent: null, oursContent: null, theirsContent: null, resultContent: null, resultRevision: "b".repeat(64), isText: false,
  }), { status: 200, headers: { "X-GitCrest-API-Version": "1" } })));
});

it("aborts conflict session preflight when the conflict window closes", async () => {
  const repoId = `repo_${"b".repeat(64)}`;
  const taskId = "task-456-1";
  window.history.replaceState({}, "", `/?view=conflicts&repoId=${repoId}&taskId=${taskId}`);
  Object.defineProperty(window, "gitcrest", {
    configurable: true,
    value: { getSidecarConnection: vi.fn().mockResolvedValue({ baseUrl: "http://127.0.0.1:4100", token: "conflict-scoped", windowAccess: "conflictResolution" }) },
  });
  const preflightResponse = deferred<Response>();
  let preflightSignal: AbortSignal | null | undefined;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((input, init) => {
    if (String(input).includes("recovery-preflight")) {
      preflightSignal = init?.signal;
      return preflightResponse.promise;
    }
    return Promise.reject(new Error("Unexpected request in conflict preflight test."));
  }));

  const view = render(<ConflictWindow />);
  await waitFor(() => expect(preflightSignal).toBeTruthy());
  view.unmount();
  expect(preflightSignal?.aborted).toBe(true);
  await act(async () => preflightResponse.resolve(new Response(JSON.stringify({
    repoId, taskId, operation: "merge", headOid: "b".repeat(40), dirtyPaths: [], omittedDirtyPathCount: 0,
    conflictedPaths: [], omittedConflictedPathCount: 0, canContinue: true, canSkip: false, canAbort: true,
  }), { status: 200, headers: { "X-GitCrest-API-Version": "1" } })));
});

it("edits, saves, and marks a conflict resolved using conflict-scoped window access", async () => {
  const repoId = `repo_${"a".repeat(64)}`;
  window.history.replaceState({}, "", `/?view=conflicts&repoId=${repoId}&taskId=task-123-1`);
  Object.defineProperty(window, "gitcrest", {
    configurable: true,
    value: { getSidecarConnection: vi.fn().mockResolvedValue({ baseUrl: "http://127.0.0.1:4100", token: "conflict-scoped", windowAccess: "conflictResolution" }) },
  });
  let preview = {
    repoId, taskId: "task-123-1", operation: "merge", headOid: "a".repeat(40), dirtyPaths: ["conflict.ts"],
    omittedDirtyPathCount: 0, conflictedPaths: ["conflict.ts"], omittedConflictedPathCount: 0, canContinue: false, canSkip: false, canAbort: true,
  };
  let conflict = {
    repoId, taskId: "task-123-1", path: "conflict.ts", operation: "merge", headOid: "a".repeat(40),
    baseContent: "base value", oursContent: "ours value", theirsContent: "theirs value",
    resultContent: "prefix\n<<<<<<< ours\nours first\n=======\ntheirs first\n>>>>>>> theirs\nmiddle\n<<<<<<< ours\nours second\n=======\ntheirs second\n>>>>>>> theirs\nsuffix\n",
    resultRevision: "b".repeat(64), isText: true,
  };
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("conflicts/resolved")) {
      preview = { ...preview, conflictedPaths: [], canContinue: true };
      return new Response(JSON.stringify({ taskId: "resolve-task", status: "queued" }), { status: 202, headers: { "X-GitCrest-API-Version": "1" } });
    }
    if (url.includes("conflicts/file") && init?.method === "PUT") {
      const request = JSON.parse(String(init.body)) as { content: string };
      conflict = { ...conflict, resultContent: request.content, resultRevision: "c".repeat(64) };
      return new Response(JSON.stringify({ taskId: "save-task", status: "queued" }), { status: 202, headers: { "X-GitCrest-API-Version": "1" } });
    }
    if (url.includes("conflicts/file")) {
      return new Response(JSON.stringify(conflict), { status: 200, headers: { "X-GitCrest-API-Version": "1" } });
    }
    const body = preview;
    return new Response(JSON.stringify(body), { status: 200, headers: { "X-GitCrest-API-Version": "1" } });
  }));
  const view = render(<ConflictWindow />);
  expect(await screen.findByText("base value")).toBeTruthy();
  expect(screen.getByText("ours value")).toBeTruthy();
  expect(screen.getByText("theirs value")).toBeTruthy();
  const editor = screen.getByRole("textbox", { name: "Working result" }) as HTMLTextAreaElement;
  expect(editor.value).toContain("<<<<<<< ours");
  fireEvent.click(screen.getByRole("button", { name: "Use theirs for conflict 1" }));
  expect(editor.value).toContain("theirs first");
  expect(editor.value).toContain("<<<<<<< ours\nours second");
  expect(editor.value).not.toContain("<<<<<<< ours\nours first");
  fireEvent.click(screen.getByRole("button", { name: "Use ours for conflict 1" }));
  expect(editor.value).toContain("ours second");
  fireEvent.change(editor, { target: { value: "resolved through editor\n" } });
  fireEvent.click(screen.getByText("RESULT PREVIEW"));
  expect(screen.getByText("RESULT PREVIEW").parentElement?.querySelector("pre")?.textContent).toBe("resolved through editor\n");
  expect((screen.getByRole("button", { name: "Mark resolved" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Save result" }));
  expect(await screen.findByText(/Saved to the working tree/)).toBeTruthy();
  expect(editor.value).toBe("resolved through editor\n");
  view.unmount();
  render(<ConflictWindow />);
  const reopenedEditor = await screen.findByRole("textbox", { name: "Working result" }) as HTMLTextAreaElement;
  expect(reopenedEditor.value).toBe("resolved through editor\n");
  fireEvent.click(screen.getByRole("button", { name: "Mark resolved" }));
  await waitFor(() => expect(screen.getByText("0 unresolved")).toBeTruthy());
  expect(screen.getByText("No unresolved files remain. Return to Task Center to continue the Git operation.")).toBeTruthy();
});
