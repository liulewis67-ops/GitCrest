// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConflictWindow } from "../../src/features/workflows/ui/ConflictWindow";

// API/state tests isolate the browser editor; real editor history/focus is exercised in Electron E2E.
vi.mock("../../src/features/workflows/ui/ConflictWorkspace", async () => {
  const React = await import("react");
  return { ConflictWorkspace: (props: { ours: string; theirs: string; draft: string; resultRef: React.Ref<{ focus: () => void; value: () => string }>; onChange: (value: string) => void; onReady: () => void }) => {
    const input = React.useRef<HTMLTextAreaElement>(null);
    React.useEffect(() => { props.onReady(); }, []);
    React.useImperativeHandle(props.resultRef, () => ({ focus: () => input.current?.focus(), value: () => input.current?.value ?? props.draft }));
    return <><textarea aria-label="Current version" value={props.ours} readOnly /><textarea ref={input} aria-label="Working result" value={props.draft} onChange={(event) => props.onChange(event.target.value)} /><textarea aria-label="Incoming version" value={props.theirs} readOnly /></>;
  } };
});

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
    resultRevision: "b".repeat(64), isText: true, oursPresent: true, theirsPresent: true,
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
  await screen.findByRole("textbox", { name: "Working result" });
  expect((screen.getByRole("textbox", { name: "Current version" }) as HTMLTextAreaElement).value).toBe("ours value");
  expect((screen.getByRole("textbox", { name: "Incoming version" }) as HTMLTextAreaElement).value).toBe("theirs value");
  const editor = screen.getByRole("textbox", { name: "Working result" }) as HTMLTextAreaElement;
  expect(editor.value).toContain("<<<<<<< ours");
  fireEvent.click(screen.getByRole("button", { name: "Use incoming" }));
  expect(editor.value).toContain("theirs first");
  expect(editor.value).toContain("<<<<<<< ours\nours second");
  expect(editor.value).not.toContain("<<<<<<< ours\nours first");
  fireEvent.click(screen.getByRole("button", { name: "Use current" }));
  expect(editor.value).toContain("ours second");
  fireEvent.change(editor, { target: { value: "resolved through editor\n" } });
  expect(screen.queryByText("RESULT PREVIEW")).toBeNull();
  expect(screen.getByRole("button", { name: "Save & mark resolved" })).toBeTruthy();
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
    resultRevision: "b".repeat(64), isText: true, oursPresent: true, theirsPresent: true,
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
      resultContent: "resolved\n", resultRevision: "b".repeat(64), isText: true, oursPresent: true, theirsPresent: true,
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
  await waitFor(() => expect((screen.getByRole("button", { name: "Mark resolved" }) as HTMLButtonElement).disabled).toBe(false));
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
    resultContent: "<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n", resultRevision: "b".repeat(64), isText: true, oursPresent: true, theirsPresent: true,
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
    baseContent: stages.base, oursContent: stages.ours, theirsContent: stages.theirs, resultContent, resultRevision: "f".repeat(64), isText: true, oursPresent: true, theirsPresent: true,
  };
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (input) => new Response(
    JSON.stringify(String(input).includes("conflicts/file") ? conflict : preview), { status: 200, headers: { "X-GitCrest-API-Version": "1" } },
  )));
  render(<ConflictWindow />);
  return screen.findByRole("textbox", { name: "Working result" }) as Promise<HTMLTextAreaElement>;
}

const marked = "top\n<<<<<<< ours\nconst a = 2;\nnew line\n=======\nconst a = 3;\n>>>>>>> theirs\nbottom\n";
const stageSet = { base: "top\nconst a = 1;\nbottom\n", ours: "top\nconst a = 2;\nnew line\nbottom\n", theirs: "top\nconst a = 3;\nbottom\n" };

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
    resultContent: "<<<<<<< ours\nours\n=======\ntheirs\n>>>>>>> theirs\n", resultRevision: "b".repeat(64), isText: true, oursPresent: true, theirsPresent: true,
  };
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("conflicts/resolved")) {
      calls.push("resolve");
      expect(JSON.parse(String(init?.body)).expectedResultRevision).toBe("c".repeat(64));
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

it("lets the user take a whole side for a binary file and for a delete/modify conflict", async () => {
  const repoId = `repo_${"8".repeat(64)}`;
  window.history.replaceState({}, "", `/?view=conflicts&repoId=${repoId}&taskId=task-8-1`);
  Object.defineProperty(window, "gitcrest", {
    configurable: true,
    value: { getSidecarConnection: vi.fn().mockResolvedValue({ baseUrl: "http://127.0.0.1:4100", token: "conflict-scoped", windowAccess: "conflictResolution" }) },
  });
  let preview = {
    repoId, taskId: "task-8-1", operation: "merge", headOid: "a".repeat(40), dirtyPaths: ["logo.png", "gone.txt"],
    omittedDirtyPathCount: 0, conflictedPaths: ["logo.png", "gone.txt"], omittedConflictedPathCount: 0, canContinue: false, canSkip: false, canAbort: true,
  };
  const files: Record<string, unknown> = {
    "logo.png": { repoId, taskId: "task-8-1", path: "logo.png", operation: "merge", headOid: "a".repeat(40), baseContent: null, oursContent: null, theirsContent: null, resultContent: null, resultRevision: "1".repeat(64), isText: false, oursPresent: true, theirsPresent: true },
    "gone.txt": { repoId, taskId: "task-8-1", path: "gone.txt", operation: "merge", headOid: "a".repeat(40), baseContent: "x\n", oursContent: "edit\n", theirsContent: null, resultContent: "edit\n", resultRevision: "2".repeat(64), isText: true, oursPresent: true, theirsPresent: false },
  };
  const chosen: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = new URL(String(input), "http://127.0.0.1:4100");
    if (url.pathname.endsWith("conflicts/choose")) {
      const body = JSON.parse(String(init?.body)) as { path: string };
      chosen.push(body);
      preview = { ...preview, conflictedPaths: preview.conflictedPaths.filter((path) => path !== body.path) };
      return new Response(JSON.stringify({ taskId: "choose-task", status: "queued" }), { status: 202, headers: { "X-GitCrest-API-Version": "1" } });
    }
    if (url.pathname.endsWith("conflicts/file")) return new Response(JSON.stringify(files[url.searchParams.get("path") ?? ""]), { status: 200, headers: { "X-GitCrest-API-Version": "1" } });
    return new Response(JSON.stringify(preview), { status: 200, headers: { "X-GitCrest-API-Version": "1" } });
  }));
  render(<ConflictWindow />);
  expect(await screen.findByText(/binary or non-text/)).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Working result" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Use theirs (incoming)" }));
  await waitFor(() => expect(chosen).toHaveLength(1));
  expect(chosen[0]).toMatchObject({ path: "logo.png", side: "theirs", expectedResultRevision: "1".repeat(64) });
  expect(await screen.findByText(/incoming branch deleted this file/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Accept deletion (theirs)" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Accept deletion (theirs)" }));
  await waitFor(() => expect(chosen).toHaveLength(2));
  expect(chosen[1]).toMatchObject({ path: "gone.txt", side: "theirs" });
});

function fileAction(label: string) {
  fireEvent.click(screen.getByRole("button", { name: "File actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: label }));
}

it("keeps a single result, blocks malformed-marker completion and supports ordered local choices", async () => {
  const editor = await mountConflict(marked, stageSet, "1");
  expect(screen.getAllByRole("textbox", { name: "Working result" })).toHaveLength(1);
  expect((screen.getByRole("button", { name: "Mark resolved" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(editor, { target: { value: "<<<<<<< incomplete\n" } });
  expect(screen.getByText("Incomplete conflict markers. Edit the result before resolving.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Save & mark resolved" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(editor, { target: { value: marked } });
  fireEvent.click(screen.getByRole("button", { name: "Accept both" }));
  expect(editor.value).toBe("top\nconst a = 2;\nnew line\nconst a = 3;\nbottom\n");
});

it("protects dirty whole-file replacement consistently and keeps base inspection secondary", async () => {
  const editor = await mountConflict(marked, stageSet, "2");
  fireEvent.change(editor, { target: { value: marked + "manual\n" } });
  fileAction("Use entire ours");
  expect(screen.getByRole("dialog", { name: "Replace working result" })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep my edits" }));
  fireEvent.click(screen.getByRole("button", { name: "Keep my edits" }));
  expect(editor.value).toBe(marked + "manual\n");
  fileAction("Use entire theirs");
  fireEvent.click(screen.getByRole("button", { name: "Replace working result" }));
  expect(editor.value).toBe(stageSet.theirs);
});

it("preserves ignore-both semantics without presenting base as the result", async () => {
  const editor = await mountConflict(marked, stageSet, "3");
  fireEvent.click(screen.getByRole("button", { name: "More options" }));
  fireEvent.click(screen.getByRole("button", { name: "Ignore ours" }));
  expect(editor.value).toBe(marked);
  fireEvent.click(screen.getByRole("button", { name: "Ignore theirs" }));
  expect(editor.value).toBe(stageSet.base);
});

it("retains non-conflicting reconstruction under File actions", async () => {
  const stages = { base: "a\nb\nc\nd\ne\n", ours: "a\nB\nc\nd\ne\n", theirs: "a\nb\nc\nd\nE\n" };
  const editor = await mountConflict("a\n<<<<<<< ours\nB\n=======\nx\n>>>>>>> theirs\nc\nd\nE\n", stages, "4");
  fileAction("Use entire ours");
  expect(editor.value).toBe(stages.ours);
  fileAction("Apply all non-conflicting changes");
  fireEvent.click(screen.getByRole("button", { name: "Replace working result" }));
  expect(editor.value).toBe("a\nB\nc\nd\nE\n");
});

it("retains Smart Merge and overlapping conflicts", async () => {
  const stages = { base: "a\nb\nc\nm\nx = 1;\nz\n", ours: "a\nB\nc\nm\nx = 2;\nz\n", theirs: "a\nb\nC\nm\nx = 3;\nz\n" };
  const marked = "a\n<<<<<<< ours\nB\nc\n=======\nb\nC\n>>>>>>> theirs\nm\n<<<<<<< ours\nx = 2;\n=======\nx = 3;\n>>>>>>> theirs\nz\n";
  const editor = await mountConflict(marked, stages, "5");
  fileAction("Smart Merge eligible conflicts (1)");
  expect(editor.value).toBe("a\nB\nC\nm\n<<<<<<< ours\nx = 2;\n=======\nx = 3;\n>>>>>>> theirs\nz\n");
  expect(screen.getByText("Conflict 1 of 1")).toBeTruthy();
});

it("does not stage after a failed save and keeps the user's draft available to retry", async () => {
  const editor = await mountConflict(marked, stageSet, "6");
  const originalFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
  let staged = false;
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    if (String(input).includes("conflicts/resolved")) staged = true;
    if (String(input).includes("conflicts/file") && init?.method === "PUT") return new Response("save failed", { status: 500, headers: { "X-GitCrest-API-Version": "1" } });
    return originalFetch(input, init);
  });
  fireEvent.change(editor, { target: { value: "reviewed result\n" } });
  fireEvent.click(screen.getByRole("button", { name: "Save & mark resolved" }));
  await screen.findByRole("alert");
  expect(staged).toBe(false);
  expect(editor.value).toBe("reviewed result\n");
  expect((screen.getByRole("button", { name: "Save result" }) as HTMLButtonElement).disabled).toBe(false);
});

it("retains the saved result and offers Mark resolved after staging fails", async () => {
  const editor = await mountConflict(marked, stageSet, "7");
  const originalFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
  let saved = false;
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    if (String(input).includes("conflicts/resolved")) return new Response("stage failed", { status: 500, headers: { "X-GitCrest-API-Version": "1" } });
    if (String(input).includes("conflicts/file") && init?.method === "PUT") { saved = true; return new Response(JSON.stringify({ taskId: "save-task", status: "queued" }), { status: 202, headers: { "X-GitCrest-API-Version": "1" } }); }
    const response = await originalFetch(input, init);
    if (saved && String(input).includes("conflicts/file")) return new Response(JSON.stringify({ ...await response.json(), resultContent: "reviewed result\n", resultRevision: "c".repeat(64) }), { status: 200, headers: { "X-GitCrest-API-Version": "1" } });
    return response;
  });
  fireEvent.change(editor, { target: { value: "reviewed result\n" } });
  fireEvent.click(screen.getByRole("button", { name: "Save & mark resolved" }));
  await screen.findByRole("alert");
  expect(editor.value).toBe("reviewed result\n");
  expect((screen.getByRole("button", { name: "Save result" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Mark resolved" }) as HTMLButtonElement).disabled).toBe(false);
});

it("carries an unsaved draft across a core restart instead of reloading saved text over it", async () => {
  await mountConflict(marked, stageSet, "8");
  cleanup();
  let restarted: ((status: import("../../src/api/core-status").CoreStatus) => void) | undefined;
  window.gitcrest!.subscribeToCoreStatus = (listener) => { restarted = listener; return () => {}; };
  render(<ConflictWindow />);
  const editor = await screen.findByRole("textbox", { name: "Working result" });
  fireEvent.change(editor, { target: { value: "unsaved review\r\n" } });
  act(() => restarted?.({ state: "ready", generation: 2 }));
  await waitFor(() => expect((screen.getByRole("textbox", { name: "Working result" }) as HTMLTextAreaElement).value).toBe("unsaved review\n"));
  expect((screen.getByRole("button", { name: "Save result" }) as HTMLButtonElement).disabled).toBe(false);
});

it("keeps a recovered draft visible if the restarted core no longer lists that conflict", async () => {
  await mountConflict(marked, stageSet, "9");
  cleanup();
  let restarted: ((status: import("../../src/api/core-status").CoreStatus) => void) | undefined;
  window.gitcrest!.subscribeToCoreStatus = (listener) => { restarted = listener; return () => {}; };
  render(<ConflictWindow />);
  const editor = await screen.findByRole("textbox", { name: "Working result" });
  fireEvent.change(editor, { target: { value: "keep this review\n" } });
  const originalFetch = vi.mocked(globalThis.fetch).getMockImplementation()!;
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const response = await originalFetch(input, init);
    if (String(input).includes("recovery-preflight")) return new Response(JSON.stringify({ ...await response.json(), conflictedPaths: [] }), { status: 200, headers: { "X-GitCrest-API-Version": "1" } });
    return response;
  });
  act(() => restarted?.({ state: "ready", generation: 2 }));
  await screen.findByText("Recovered draft");
  expect((screen.getByRole("textbox", { name: "Working result" }) as HTMLTextAreaElement).value).toBe("keep this review\n");
  expect(screen.queryByRole("heading", { name: "All conflicts resolved" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Discard recovered draft" }));
  fireEvent.click(screen.getByRole("dialog").querySelector<HTMLButtonElement>('.gcButton-danger')!);
  await screen.findByRole("heading", { name: "All conflicts resolved" });
});
