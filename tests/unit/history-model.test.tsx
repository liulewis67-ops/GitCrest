// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommitDetailResponse, CommitHistoryFilters, CommitPageResponse, GitCrestApiClient, RefSnapshotResponse } from "../../src/api/client";
import { useCommitTagCreation } from "../../src/features/history/model/use-commit-tag-creation";
import { useHistoryFilters } from "../../src/features/history/model/use-history-filters";
import { useRepositoryCommitDetail } from "../../src/features/history/model/use-repository-commit-detail";
import { useRepositoryHistory } from "../../src/features/history/model/use-repository-history";

const NO_FILTERS: CommitHistoryFilters = {};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function commit(oid: string) {
  return { oid, parents: [], authorName: "Ada", authorEmail: "ada@example.test", committedAtMs: 1, subject: oid };
}

function page(repoId: string, offset: number, commits: CommitPageResponse["commits"], nextOffset: number | null): CommitPageResponse {
  return { repoId, offset, limit: 50, commits, nextOffset };
}

function refs(repoId: string): RefSnapshotResponse {
  return { repoId, head: null, branch: null, detached: true, refs: [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function cancellableApi(methods: Record<string, unknown>) {
  const signals: AbortSignal[] = [];
  let api: Record<string, unknown>;
  api = {
    ...methods,
    withSignal: vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return api;
    }),
  };
  return { api: api as unknown as GitCrestApiClient, signals };
}

describe("history feature models", () => {
  it("applies only non-empty filters and clears the applied and draft values", () => {
    const { result } = renderHook(() => useHistoryFilters());

    act(() => {
      result.current.setDraftFilter("author", "Ada");
      result.current.setDraftFilter("message", "   ");
    });
    act(() => result.current.applyFilters());

    expect(result.current.filters).toEqual({ author: "Ada" });
    expect(result.current.hasFilters).toBe(true);

    act(() => result.current.resetFilters());
    expect(result.current.draftFilters).toEqual({});
    expect(result.current.filters).toEqual({});
    expect(result.current.hasFilters).toBe(false);
  });

  it("loads refs and pages history without duplicating a page request", async () => {
    const { api } = cancellableApi({
      getRepositoryCommits: vi.fn()
        .mockResolvedValueOnce(page("repo_a", 0, [commit("one")], 50))
        .mockResolvedValueOnce(page("repo_a", 50, [commit("two")], null)),
      getRepositoryRefs: vi.fn().mockResolvedValue(refs("repo_a")),
    });
    const { result } = renderHook(() => useRepositoryHistory(api, "repo_a", NO_FILTERS, 0));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.commits.map(({ oid }) => oid)).toEqual(["one"]);
    expect(result.current.refs).toEqual([]);

    act(() => {
      result.current.loadMore();
      result.current.loadMore();
    });
    await waitFor(() => expect(result.current.commits.map(({ oid }) => oid)).toEqual(["one", "two"]));
    expect((api.getRepositoryCommits as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });

  it("keeps a cold message search loading until the complete indexed page is ready", async () => {
    const messageFilters: CommitHistoryFilters = { message: "needle" };
    const { api } = cancellableApi({
      getRepositoryCommits: vi.fn()
        .mockResolvedValueOnce({ ...page("repo_a", 0, [], null), searchPending: true })
        .mockResolvedValueOnce(page("repo_a", 0, [commit("match")], null)),
      getRepositoryRefs: vi.fn().mockResolvedValue(refs("repo_a")),
    });
    const { result } = renderHook(() => useRepositoryHistory(api, "repo_a", messageFilters, 0));

    await waitFor(() => expect(result.current.searchPending).toBe(true));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.commits.map(({ oid }) => oid)).toEqual(["match"]), { timeout: 3000 });
    expect(result.current.searchPending).toBe(false);
    expect((api.getRepositoryCommits as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
  });

  it("ignores a history response from a repository that is no longer selected", async () => {
    const oldPage = deferred<CommitPageResponse>();
    const { api, signals } = cancellableApi({
      getRepositoryCommits: vi.fn((repoId: string) => repoId === "repo_old"
        ? oldPage.promise
        : Promise.resolve(page("repo_new", 0, [commit("new")], null))),
      getRepositoryRefs: vi.fn().mockResolvedValue(refs("repo_new")),
    });
    const { result, rerender } = renderHook(
      ({ repoId }) => useRepositoryHistory(api, repoId, NO_FILTERS, 0),
      { initialProps: { repoId: "repo_old" } },
    );

    rerender({ repoId: "repo_new" });
    expect(signals.some((signal) => signal.aborted)).toBe(true);
    await waitFor(() => expect(result.current.commits.map(({ oid }) => oid)).toEqual(["new"]));
    await act(async () => oldPage.resolve(page("repo_old", 0, [commit("old")], null)));
    expect(result.current.commits.map(({ oid }) => oid)).toEqual(["new"]);
  });

  it("ignores stale commit detail responses when selection changes", async () => {
    const first = deferred<CommitDetailResponse>();
    const second: CommitDetailResponse = {
      repoId: "repo_a", oid: "second", parents: [], authorName: "Ada", authorEmail: "ada@example.test",
      committedAtMs: 2, message: "second", stats: { filesChanged: 0, insertions: 0, deletions: 0 }, files: [],
    };
    const { api, signals } = cancellableApi({
      getRepositoryCommit: vi.fn((_repoId: string, oid: string) => oid === "first" ? first.promise : Promise.resolve(second)),
    });
    const { result, rerender } = renderHook(
      ({ oid }) => useRepositoryCommitDetail(api, "repo_a", oid),
      { initialProps: { oid: "first" } },
    );

    rerender({ oid: "second" });
    expect(signals[0]?.aborted).toBe(true);
    await waitFor(() => expect(result.current.detail?.oid).toBe("second"));
    await act(async () => first.resolve({ ...second, oid: "first", message: "first" }));
    expect(result.current.detail?.oid).toBe("second");
  });

  it("clears tag editor state after creation and when the selected commit changes", async () => {
    const api = {
      createRepositoryCommitTag: vi.fn().mockResolvedValue({ repoId: "repo_a", name: "v1", fullName: "refs/tags/v1", oid: "commit_a" }),
    } as unknown as GitCrestApiClient;
    const { result, rerender } = renderHook(
      ({ oid }) => useCommitTagCreation(api, "repo_a", oid),
      { initialProps: { oid: "commit_a" } },
    );

    act(() => {
      result.current.openEditor();
      result.current.setName("v1");
    });
    await act(async () => { await result.current.createTag(); });
    expect(api.createRepositoryCommitTag).toHaveBeenCalledWith("repo_a", "commit_a", "v1", "");
    expect(result.current.editorOpen).toBe(false);
    expect(result.current.name).toBe("");
    expect(result.current.status).toContain("Annotated tag v1 created");

    rerender({ oid: "commit_b" });
    expect(result.current.status).toBe("");
    expect(result.current.error).toBe("");
  });
});
