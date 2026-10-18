// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConflictWindow } from "../../src/features/workflows/ui/ConflictWindow";

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

it("aborts save polling when the conflict window closes", async () => {
  const repoId = `repo_${"c".repeat(64)}`;
  const taskId = "task-save-close-1";
  window.history.replaceState({}, "", `/?view=conflicts&repoId=${repoId}&taskId=${taskId}`);
  Object.defineProperty(window, "gitcrest", {
    configurable: true,
    value: { getSidecarConnection: vi.fn().mockResolvedValue({ baseUrl: "http://127.0.0.1:4100", token: "conflict-scoped", windowAccess: "conflictResolution" }) },
  });
  const preview = {
    repoId, taskId, operation: "merge", headOid: "a".repeat(40), dirtyPaths: ["conflict.ts"],
    omittedDirtyPathCount: 0, conflictedPaths: ["conflict.ts"], omittedConflictedPathCount: 0, canContinue: false, canSkip: false, canAbort: true,
  };
  const conflict = {
    repoId, taskId, path: "conflict.ts", operation: "merge", headOid: "a".repeat(40),
    baseContent: "base", oursContent: "ours", theirsContent: "theirs", resultContent: "<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n",
    resultRevision: "b".repeat(64), isText: true,
  };
  const pollResponse = deferred<Response>();
  let fileReads = 0;
  let pollSignal: AbortSignal | null | undefined;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes("recovery-preflight")) return Promise.resolve(new Response(JSON.stringify(preview), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }));
    if (url.includes("conflicts/file") && init?.method === "PUT") return Promise.resolve(new Response(JSON.stringify({ taskId: "save-task", status: "queued" }), { status: 202, headers: { "X-GitCrest-API-Version": "1" } }));
    if (url.includes("conflicts/file")) {
      fileReads += 1;
      if (fileReads === 1) return Promise.resolve(new Response(JSON.stringify(conflict), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }));
      pollSignal = init?.signal;
      return pollResponse.promise;
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  }));

  const view = render(<ConflictWindow />);
  const editor = await screen.findByRole("textbox", { name: "Working result" });
  fireEvent.change(editor, { target: { value: "saved result\n" } });
  fireEvent.click(screen.getByRole("button", { name: "Save result" }));
  await waitFor(() => expect(pollSignal).toBeTruthy());
  view.unmount();
  expect(pollSignal?.aborted).toBe(true);
  await act(async () => pollResponse.resolve(new Response(JSON.stringify({ ...conflict, resultContent: "saved result\n" }), { status: 200, headers: { "X-GitCrest-API-Version": "1" } })));
});

it("aborts resolved-state polling when the conflict window closes", async () => {
  const repoId = `repo_${"d".repeat(64)}`;
  const taskId = "task-resolve-close-1";
  window.history.replaceState({}, "", `/?view=conflicts&repoId=${repoId}&taskId=${taskId}`);
  Object.defineProperty(window, "gitcrest", {
    configurable: true,
    value: { getSidecarConnection: vi.fn().mockResolvedValue({ baseUrl: "http://127.0.0.1:4100", token: "conflict-scoped", windowAccess: "conflictResolution" }) },
  });
  const preview = {
    repoId, taskId, operation: "merge", headOid: "a".repeat(40), dirtyPaths: [],
    omittedDirtyPathCount: 0, conflictedPaths: ["conflict.ts"], omittedConflictedPathCount: 0, canContinue: false, canSkip: false, canAbort: true,
  };
  const pollPreview = deferred<Response>();
  let preflightCalls = 0;
  let pollSignal: AbortSignal | null | undefined;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes("conflicts/file")) return Promise.resolve(new Response(JSON.stringify({
      repoId, taskId, path: "conflict.ts", operation: "merge", headOid: "a".repeat(40), baseContent: "base", oursContent: "ours", theirsContent: "theirs",
      resultContent: "resolved\n", resultRevision: "b".repeat(64), isText: true,
    }), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }));
    if (url.includes("conflicts/resolved")) return Promise.resolve(new Response(JSON.stringify({ taskId: "resolve-task", status: "queued" }), { status: 202, headers: { "X-GitCrest-API-Version": "1" } }));
    if (url.includes("recovery-preflight")) {
      preflightCalls += 1;
      if (preflightCalls === 1) return Promise.resolve(new Response(JSON.stringify(preview), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }));
      pollSignal = init?.signal;
      return pollPreview.promise;
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  }));

  const view = render(<ConflictWindow />);
  await screen.findByRole("textbox", { name: "Working result" });
  fireEvent.click(screen.getByRole("button", { name: "Mark resolved" }));
  await waitFor(() => expect(pollSignal).toBeTruthy());
  view.unmount();
  expect(pollSignal?.aborted).toBe(true);
  await act(async () => pollPreview.resolve(new Response(JSON.stringify({ ...preview, conflictedPaths: [] }), { status: 200, headers: { "X-GitCrest-API-Version": "1" } })));
});

it("aborts error-recovery preflight when the conflict window closes", async () => {
  const repoId = `repo_${"e".repeat(64)}`;
  const taskId = "task-recovery-close-1";
  window.history.replaceState({}, "", `/?view=conflicts&repoId=${repoId}&taskId=${taskId}`);
  Object.defineProperty(window, "gitcrest", {
    configurable: true,
    value: { getSidecarConnection: vi.fn().mockResolvedValue({ baseUrl: "http://127.0.0.1:4100", token: "conflict-scoped", windowAccess: "conflictResolution" }) },
  });
  const preview = {
    repoId, taskId, operation: "merge", headOid: "a".repeat(40), dirtyPaths: ["conflict.ts"],
    omittedDirtyPathCount: 0, conflictedPaths: ["conflict.ts"], omittedConflictedPathCount: 0, canContinue: false, canSkip: false, canAbort: true,
  };
  const conflict = {
    repoId, taskId, path: "conflict.ts", operation: "merge", headOid: "a".repeat(40), baseContent: "base", oursContent: "ours", theirsContent: "theirs",
    resultContent: "<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n", resultRevision: "b".repeat(64), isText: true,
  };
  const recoveryResponse = deferred<Response>();
  let fileReads = 0;
  let preflightCalls = 0;
  let recoverySignal: AbortSignal | null | undefined;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes("conflicts/file") && init?.method === "PUT") return Promise.resolve(new Response(JSON.stringify({ taskId: "save-task", status: "queued" }), { status: 202, headers: { "X-GitCrest-API-Version": "1" } }));
    if (url.includes("conflicts/file")) {
      fileReads += 1;
      if (fileReads === 1) return Promise.resolve(new Response(JSON.stringify(conflict), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }));
      return Promise.reject(new Error("simulated poll failure"));
    }
    if (url.includes("recovery-preflight")) {
      preflightCalls += 1;
      if (preflightCalls === 1) return Promise.resolve(new Response(JSON.stringify(preview), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }));
      recoverySignal = init?.signal;
      return recoveryResponse.promise;
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  }));

  const view = render(<ConflictWindow />);
  const editor = await screen.findByRole("textbox", { name: "Working result" });
  fireEvent.change(editor, { target: { value: "saved result\n" } });
  fireEvent.click(screen.getByRole("button", { name: "Save result" }));
  await waitFor(() => expect(recoverySignal).toBeTruthy());
  view.unmount();
  expect(recoverySignal?.aborted).toBe(true);
  await act(async () => recoveryResponse.resolve(new Response(JSON.stringify(preview), { status: 200, headers: { "X-GitCrest-API-Version": "1" } })));
});

it("shows aligned ours/result/theirs blocks, a resolved counter, and accepts both sides", async () => {
  const repoId = `repo_${"d".repeat(64)}`;
  window.history.replaceState({}, "", `/?view=conflicts&repoId=${repoId}&taskId=task-blocks-1`);
  Object.defineProperty(window, "gitcrest", {
    configurable: true,
    value: { getSidecarConnection: vi.fn().mockResolvedValue({ baseUrl: "http://127.0.0.1:4100", token: "conflict-scoped", windowAccess: "conflictResolution" }) },
  });
  const preview = {
    repoId, taskId: "task-blocks-1", operation: "merge", headOid: "a".repeat(40), dirtyPaths: ["c.ts"],
    omittedDirtyPathCount: 0, conflictedPaths: ["c.ts"], omittedConflictedPathCount: 0, canContinue: false, canSkip: false, canAbort: true,
  };
  const conflict = {
    repoId, taskId: "task-blocks-1", path: "c.ts", operation: "merge", headOid: "a".repeat(40),
    baseContent: "b", oursContent: "o", theirsContent: "t",
    resultContent: "<<<<<<< ours\nA\n||||||| base\nB\n=======\nC\n>>>>>>> theirs\nmid\n<<<<<<< ours\nD\n=======\nE\n>>>>>>> theirs\n",
    resultRevision: "e".repeat(64), isText: true,
  };
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const body = String(input).includes("conflicts/file") ? conflict : preview;
    return new Response(JSON.stringify(body), { status: 200, headers: { "X-GitCrest-API-Version": "1" } });
  }));
  render(<ConflictWindow />);
  const editor = await screen.findByRole("textbox", { name: "Working result" }) as HTMLTextAreaElement;
  expect(screen.getByText("0 of 2 resolved · 2 remaining")).toBeTruthy();
  expect(screen.getByLabelText("Unresolved result for conflict 1").textContent).toBe("1B");
  fireEvent.click(screen.getByRole("button", { name: "Use both for conflict 1" }));
  expect(editor.value.startsWith("A\nC\nmid\n")).toBe(true);
  expect(screen.getByText("1 of 2 resolved · 1 remaining")).toBeTruthy();
});

function mountConflict(resultContent: string, stages: { base: string | null; ours: string | null; theirs: string | null }, token = "e") {
  const repoId = `repo_${token.repeat(64)}`;
  window.history.replaceState({}, "", `/?view=conflicts&repoId=${repoId}&taskId=task-${token}-1`);
  Object.defineProperty(window, "gitcrest", {
    configurable: true,
    value: { getSidecarConnection: vi.fn().mockResolvedValue({ baseUrl: "http://127.0.0.1:4100", token: "conflict-scoped", windowAccess: "conflictResolution" }) },
  });
  const preview = {
    repoId, taskId: `task-${token}-1`, operation: "merge", headOid: "a".repeat(40), dirtyPaths: ["c.ts"],
    omittedDirtyPathCount: 0, conflictedPaths: ["c.ts"], omittedConflictedPathCount: 0, canContinue: false, canSkip: false, canAbort: true,
  };
  const conflict = {
    repoId, taskId: preview.taskId, path: "c.ts", operation: "merge", headOid: "a".repeat(40),
    baseContent: stages.base, oursContent: stages.ours, theirsContent: stages.theirs, resultContent, resultRevision: "f".repeat(64), isText: true,
  };
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (input) => new Response(
    JSON.stringify(String(input).includes("conflicts/file") ? conflict : preview), { status: 200, headers: { "X-GitCrest-API-Version": "1" } },
  )));
  render(<ConflictWindow />);
  return screen.findByRole("textbox", { name: "Working result" }) as Promise<HTMLTextAreaElement>;
}

const marked = "top\n<<<<<<< ours\nconst a = 2;\nnew line\n=======\nconst a = 3;\n>>>>>>> theirs\nbottom\n";
const stageSet = { base: "top\nconst a = 1;\nbottom\n", ours: "top\nconst a = 2;\nnew line\nbottom\n", theirs: "top\nconst a = 3;\nbottom\n" };

it("highlights changed lines and words against the base with text markers", async () => {
  await mountConflict(marked, stageSet, "1");
  const ours = screen.getByLabelText("Ours for conflict 1");
  expect(ours.querySelector('[aria-label="changed line"]')?.textContent).toBe("~");
  expect(ours.querySelector('[aria-label="added line"]')?.textContent).toBe("+");
  expect(ours.querySelector("mark")?.textContent).toBe("2");
  expect(screen.getByLabelText("Theirs for conflict 1").querySelector("mark")?.textContent).toBe("3");
  expect(screen.getByLabelText("Unresolved result for conflict 1").textContent).toContain("const a = 1;");
  expect(screen.getByText(/Changes shown against base/)).toBeTruthy();
});

it("ignores one side without resolving, then resolves to base when both sides are ignored", async () => {
  const editor = await mountConflict(marked, stageSet, "2");
  fireEvent.click(screen.getByRole("button", { name: "Ignore ours for conflict 1" }));
  expect(editor.value).toBe(marked);
  expect((screen.getByRole("button", { name: "Use ours for conflict 1" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Use both for conflict 1" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Ignore ours for conflict 1" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Ignore ours for conflict 1" }));
  expect(screen.getByRole("button", { name: "Ignore ours for conflict 1" }).getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Ignore ours for conflict 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Ignore theirs for conflict 1" }));
  expect(editor.value).toBe("top\nconst a = 1;\nbottom\n");
  expect(screen.getByText("All 1 conflicts resolved")).toBeTruthy();
});

it("undoes and redoes gutter actions", async () => {
  const editor = await mountConflict(marked, stageSet, "3");
  fireEvent.click(screen.getByRole("button", { name: "Use theirs for conflict 1" }));
  expect(editor.value).toBe("top\nconst a = 3;\nbottom\n");
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(editor.value).toBe(marked);
  expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Redo" }));
  expect(editor.value).toBe("top\nconst a = 3;\nbottom\n");
});

it("applies non-conflicting changes from one side after using the other side entirely, confirming before replacing edits", async () => {
  const stages = { base: "a\nb\nc\nd\ne\n", ours: "a\nB\nc\nd\ne\n", theirs: "a\nb\nc\nd\nE\n" };
  const editor = await mountConflict("a\n<<<<<<< ours\nB\n=======\nx\n>>>>>>> theirs\nc\nd\nE\n", stages, "4");
  fireEvent.click(screen.getByRole("button", { name: "Use entire ours" }));
  expect(editor.value).toBe(stages.ours);
  fireEvent.click(screen.getByRole("button", { name: "Apply non-conflicting changes from theirs" }));
  expect(screen.getByRole("group", { name: "Confirm apply non-conflicting changes" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Keep my edits" }));
  expect(editor.value).toBe(stages.ours);
  fireEvent.click(screen.getByRole("button", { name: "Apply all non-conflicting changes" }));
  fireEvent.click(screen.getByRole("button", { name: "Replace working result" }));
  expect(editor.value).toBe("a\nB\nc\nd\nE\n");
  expect(screen.getByText(/No conflicts remain/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(editor.value).toBe(stages.ours);
});

it("rebuilds remaining conflicts with diff3 markers and disables apply when a side is absent", async () => {
  const stages = { base: "a\nb\nc\n", ours: "a\nO\nc\nx\n", theirs: "a\nT\nc\n" };
  const editor = await mountConflict("a\n<<<<<<< ours\nO\n=======\nT\n>>>>>>> theirs\nc\n", stages, "5");
  fireEvent.click(screen.getByRole("button", { name: "Apply all non-conflicting changes" }));
  expect(editor.value).toBe("a\n<<<<<<< ours\nO\n||||||| base\nb\n=======\nT\n>>>>>>> theirs\nc\nx\n");
  expect(screen.getByText(/1 conflict left to resolve/)).toBeTruthy();
  expect(screen.getByLabelText("Unresolved result for conflict 1").textContent).toContain("b");
  cleanup();
  await mountConflict("<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n", { base: "z\n", ours: null, theirs: "y\n" }, "6");
  expect((screen.getByRole("button", { name: "Apply all non-conflicting changes" }) as HTMLButtonElement).disabled).toBe(true);
});

it("saves and marks a fully resolved file in one step", async () => {
  const repoId = `repo_${"d".repeat(64)}`;
  window.history.replaceState({}, "", `/?view=conflicts&repoId=${repoId}&taskId=task-one-step-1`);
  Object.defineProperty(window, "gitcrest", {
    configurable: true,
    value: { getSidecarConnection: vi.fn().mockResolvedValue({ baseUrl: "http://127.0.0.1:4100", token: "conflict-scoped", windowAccess: "conflictResolution" }) },
  });
  let preview = {
    repoId, taskId: "task-one-step-1", operation: "merge", headOid: "a".repeat(40), dirtyPaths: ["one.ts"],
    omittedDirtyPathCount: 0, conflictedPaths: ["one.ts"], omittedConflictedPathCount: 0, canContinue: false, canSkip: false, canAbort: true,
  };
  let conflict = {
    repoId, taskId: "task-one-step-1", path: "one.ts", operation: "merge", headOid: "a".repeat(40),
    baseContent: "base", oursContent: "ours", theirsContent: "theirs",
    resultContent: "<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n", resultRevision: "b".repeat(64), isText: true,
  };
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("conflicts/resolved")) {
      calls.push("resolve");
      preview = { ...preview, conflictedPaths: [], canContinue: true };
      return new Response(JSON.stringify({ taskId: "resolve-task", status: "queued" }), { status: 202, headers: { "X-GitCrest-API-Version": "1" } });
    }
    if (url.includes("conflicts/file") && init?.method === "PUT") {
      calls.push("save");
      const request = JSON.parse(String(init.body)) as { content: string };
      conflict = { ...conflict, resultContent: request.content, resultRevision: "c".repeat(64) };
      return new Response(JSON.stringify({ taskId: "save-task", status: "queued" }), { status: 202, headers: { "X-GitCrest-API-Version": "1" } });
    }
    if (url.includes("conflicts/file")) return new Response(JSON.stringify(conflict), { status: 200, headers: { "X-GitCrest-API-Version": "1" } });
    return new Response(JSON.stringify(preview), { status: 200, headers: { "X-GitCrest-API-Version": "1" } });
  }));
  render(<ConflictWindow />);
  const editor = await screen.findByRole("textbox", { name: "Working result" }) as HTMLTextAreaElement;
  expect(screen.queryByRole("button", { name: "Save & mark resolved" })).toBeNull();
  fireEvent.change(editor, { target: { value: "merged\n" } });
  fireEvent.click(await screen.findByRole("button", { name: "Save & mark resolved" }));
  await waitFor(() => expect(screen.getByText("0 unresolved")).toBeTruthy());
  expect(calls).toEqual(["save", "resolve"]);
});
