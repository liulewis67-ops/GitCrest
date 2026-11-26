// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { GitCrestApiClient, type DiffDocumentResponse, type RepositoryResponse } from "../../src/api/client";
import { useRepositoryDiffQuery } from "../../src/features/diff/model/use-repository-diff-query";
import { WorkspaceDiffPanel } from "../../src/pages/workspace/WorkspaceDiffPanel";
import { defaultShortcutPreferences } from "../../src/features/settings/model/shortcut-preferences";
import { DEFAULT_DIFF_VIEW_PREFERENCES } from "../../src/features/diff/model/use-diff-view-preferences";

const editor = vi.hoisted(() => ({ mounted: vi.fn(), unmounted: vi.fn() }));
vi.mock("../../src/features/diff/ui/FileDiffViewer", async () => {
  const { createElement, useEffect } = await import("react");
  return { FileDiffViewer: ({ document }: { document: DiffDocumentResponse }) => {
    useEffect(() => { editor.mounted(); return () => { editor.unmounted(); }; }, []);
    return createElement("div", { "data-testid": "editor" }, document.revision);
  } };
});

afterEach(() => vi.restoreAllMocks());
afterEach(cleanup);
const repository: RepositoryResponse = { repoId: "repo", path: "C:/repo", head: "a".repeat(40), branch: "main", detached: false, state: "normal", isFavorite: false, lastAccessedAt: 1, availability: "available" };
const document: DiffDocumentResponse = { repoId: "repo", path: "file.ts", scope: "workingTree", revision: "before", changeKind: "modified", status: "text", hunks: [], originalPath: null };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function setup() {
  const api = new GitCrestApiClient("http://localhost", "token");
  const read = vi.spyOn(api, "getFileDiff").mockResolvedValue(document);
  const initialProps = { scope: "workingTree" as "workingTree" | "index", refreshKey: "modified", path: "file.ts", repository };
  const hook = renderHook((props) => useRepositoryDiffQuery({ api, enabled: true, context: "full", ...props }), { initialProps });
  await waitFor(() => expect(hook.result.current.state.document).toBe(document));
  return { ...hook, api, read, initialProps };
}

it("keeps the editor document mounted while staging moves the same file to the index", async () => {
  const { result, rerender, read, initialProps } = await setup();
  const pending = deferred<DiffDocumentResponse>();
  read.mockReturnValue(pending.promise);
  rerender({ ...initialProps, scope: "index", refreshKey: "staged" });
  // WorkspaceDiffPanel unmounts Monaco whenever the key or document is missing.
  expect(result.current.state.key).toBe(result.current.activeKey);
  expect(result.current.state.document).toBe(document);
  expect(result.current.state.loading).toBe(true);
  const staged = { ...document, scope: "index" as const, revision: "after" };
  await act(async () => pending.resolve(staged));
  expect(result.current.state.document).toBe(staged);
  expect(result.current.state.loading).toBe(false);
});

it("retains the document on status invalidation instead of rebuilding the editor", async () => {
  const { result, rerender, read, initialProps } = await setup();
  read.mockReturnValue(new Promise(() => {}));
  rerender({ ...initialProps, refreshKey: "partly-staged" });
  expect(result.current.state.key).toBe(result.current.activeKey);
  expect(result.current.state.document).toBe(document);
  expect(read).toHaveBeenCalledTimes(2);
});

it("reuses the local diff while refreshing after returning to the commit tab", async () => {
  const api = new GitCrestApiClient("http://localhost", "token");
  const read = vi.spyOn(api, "getFileDiff").mockResolvedValue(document);
  const { result, rerender } = renderHook(({ enabled, scope }: { enabled: boolean; scope: "workingTree" | "index" }) =>
    useRepositoryDiffQuery({ api, repository, enabled, scope, path: document.path, retainWhenHidden: true }),
    { initialProps: { enabled: true, scope: "workingTree" } });
  await waitFor(() => expect(result.current.state.document).toBe(document));
  rerender({ enabled: false, scope: "index" });
  expect(read).toHaveBeenCalledTimes(1);
  const pending = deferred<DiffDocumentResponse>();
  read.mockReturnValue(pending.promise);
  rerender({ enabled: true, scope: "index" });
  expect(result.current.state).toMatchObject({ key: result.current.activeKey, loading: true, document });
  expect(read).toHaveBeenLastCalledWith(repository.repoId, document.path, "index", "hunks");
  const staged = { ...document, scope: "index" as const, revision: "staged" };
  await act(async () => pending.resolve(staged));
  expect(result.current.state).toMatchObject({ document: staged, loading: false });
});

it("does not show the previous file or repository while another target loads", async () => {
  const { result, rerender, read, initialProps } = await setup();
  read.mockReturnValue(new Promise(() => {}));
  rerender({ ...initialProps, path: "other.ts" });
  expect(result.current.state.document).toBeUndefined();
  rerender({ ...initialProps, repository: { ...repository, repoId: "other" } });
  expect(result.current.state.document).toBeUndefined();
});

it("ignores an old response after a scope change and surfaces refresh errors", async () => {
  const { result, rerender, read, initialProps } = await setup();
  const old = deferred<DiffDocumentResponse>();
  read.mockReturnValueOnce(old.promise).mockRejectedValueOnce(new Error("Read failed"));
  act(() => result.current.retry());
  rerender({ ...initialProps, scope: "index" });
  await waitFor(() => expect(result.current.state.error).toBeDefined());
  await act(async () => old.resolve(document));
  expect(result.current.state.error).toBeDefined();
  expect(result.current.state.document).toBeUndefined();
});

it("updates the real workspace panel without unmounting its editor during staging", async () => {
  editor.mounted.mockClear();
  editor.unmounted.mockClear();
  const api = new GitCrestApiClient("http://localhost", "token");
  const read = vi.spyOn(api, "getFileDiff").mockResolvedValue(document);
  function Panel({ scope, refreshKey }: { scope: "workingTree" | "index"; refreshKey: string }) {
    const query = useRepositoryDiffQuery({ api, repository, enabled: true, path: "file.ts", scope, context: "full", refreshKey });
    return <WorkspaceDiffPanel path="file.ts" scope={scope} activeDiffKey={query.activeKey} diffState={query.state}
      selectionDisabled={false} focusMode={false} isMacPlatform={false} shortcuts={defaultShortcutPreferences}
      diffViewPreferences={DEFAULT_DIFF_VIEW_PREFERENCES} onChangeDiffViewPreferences={vi.fn()} onToggleFocusMode={vi.fn()}
      onRetryDiff={query.retry} onStageSelection={vi.fn()} onDiscardSelection={vi.fn()} onCommitSelection={vi.fn()} />;
  }
  const { rerender } = render(<Panel scope="workingTree" refreshKey="modified" />);
  await screen.findByTestId("editor");
  const pending = deferred<DiffDocumentResponse>();
  read.mockReturnValue(pending.promise);
  rerender(<Panel scope="workingTree" refreshKey="staged" />);
  expect(screen.getByTestId("editor").textContent).toBe("before");
  rerender(<Panel scope="index" refreshKey="staged" />);
  expect(screen.getByTestId("editor").textContent).toBe("before");
  await act(async () => pending.resolve({ ...document, scope: "index", revision: "after" }));
  expect(screen.getByTestId("editor").textContent).toBe("after");
  expect(editor.mounted).toHaveBeenCalledOnce();
  expect(editor.unmounted).not.toHaveBeenCalled();
});
