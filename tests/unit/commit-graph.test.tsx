// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommitPageResponse, GitCrestApiClient } from "../../src/api/client";
import { CommitGraph, occupiedLaneByRow } from "../../src/features/history/ui/CommitGraph";
import { CommitDetails } from "../../src/features/history/ui/CommitDetails";

afterEach(cleanup);

function cancellableApi(methods: Record<string, unknown>) {
  let api: Record<string, unknown>;
  api = { ...methods, withSignal: vi.fn(() => api) };
  return api as unknown as GitCrestApiClient;
}

function commit(index: number) {
  return {
    oid: index.toString(16).padStart(40, "0"),
    parents: index < 119 ? [(index + 1).toString(16).padStart(40, "0")] : [],
    authorName: `Author ${index}`,
    authorEmail: `author${index}@example.test`,
    committedAtMs: 1_791_386_400_000 - index * 60_000,
    subject: `Commit ${index}`,
  };
}

describe("CommitGraph", () => {
  it("applies branch selection directly and supports dismissing and removing advanced filters", async () => {
    const getRepositoryCommits = vi.fn(async () => ({ repoId: "repo", offset: 0, limit: 50, commits: [commit(0)], nextOffset: null }));
    const api = cancellableApi({ getRepositoryCommits, getRepositoryRefs: vi.fn(async () => ({ refs: [{ name: "main", fullName: "refs/heads/main", oid: commit(0).oid, kind: "local" }] })) });
    render(<CommitGraph api={api} repoId="repo" initialScrollTop={0} onScrollPosition={vi.fn()} onSelect={vi.fn()} />);
    await screen.findByRole("list", { name: "Commit history" });
    fireEvent.change(screen.getByRole("combobox", { name: "Filter by branch" }), { target: { value: "main" } });
    await waitFor(() => expect(getRepositoryCommits).toHaveBeenLastCalledWith("repo", 0, 50, { branch: "main" }));
    fireEvent.click(screen.getByRole("button", { name: "Show history filters" }));
    const pathFilter = screen.getByRole("textbox", { name: "Filter by path" });
    pathFilter.focus();
    fireEvent.keyDown(pathFilter, { key: "Escape", isComposing: true });
    expect(document.activeElement).toBe(pathFilter);
    fireEvent.change(pathFilter, { target: { value: "src/app.ts" } });
    fireEvent.submit(screen.getByRole("form", { name: "Commit history filters" }));
    await waitFor(() => expect(getRepositoryCommits).toHaveBeenLastCalledWith("repo", 0, 50, { branch: "main", path: "src/app.ts" }));
    expect(screen.queryByRole("textbox", { name: "Filter by path" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Show history filters" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Path: src/app.ts" }));
    await waitFor(() => expect(getRepositoryCommits).toHaveBeenLastCalledWith("repo", 0, 50, { branch: "main" }));
    const toggle = screen.getByRole("button", { name: "Show history filters" });
    fireEvent.click(toggle);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(toggle);
    expect(screen.queryByRole("textbox", { name: "Filter by path" })).toBeNull();
    fireEvent.click(toggle);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("textbox", { name: "Filter by path" })).toBeNull();
  });

  it.each([["fd59a12", { sha: "fd59a12" }], ["author: Ada", { author: "Ada" }], ["ada@example.test", { author: "ada@example.test" }]])("detects the search query %s", async (query, filters) => {
    const getRepositoryCommits = vi.fn(async () => ({ repoId: "repo", offset: 0, limit: 50, commits: [commit(0)], nextOffset: null }));
    const api = cancellableApi({ getRepositoryCommits, getRepositoryRefs: vi.fn(async () => ({ refs: [] })) });
    render(<CommitGraph api={api} repoId="repo" initialScrollTop={0} onScrollPosition={vi.fn()} onSelect={vi.fn()} />);
    await screen.findByRole("list", { name: "Commit history" });
    fireEvent.change(screen.getByRole("textbox", { name: "Search commits" }), { target: { value: query } });
    fireEvent.submit(screen.getByRole("form", { name: "Commit history filters" }));
    await waitFor(() => expect(getRepositoryCommits).toHaveBeenLastCalledWith("repo", 0, 50, filters));
  });
  it("shows the primary history failure once when refs and a later page both fail", async () => {
    let finishRetry!: (page: CommitPageResponse) => void;
    const retryPage = new Promise<CommitPageResponse>((resolve) => { finishRetry = resolve; });
    const onReadError = vi.fn();
    const api = cancellableApi({
      getRepositoryCommits: vi.fn().mockResolvedValueOnce({ repoId: "repo", offset: 0, limit: 50, commits: [commit(0)], nextOffset: 1 }).mockRejectedValueOnce(new Error("history unavailable")).mockReturnValueOnce(retryPage),
      getRepositoryRefs: vi.fn().mockRejectedValue(new Error("refs unavailable")),
    });
    const { container } = render(<CommitGraph api={api} repoId="repo" initialScrollTop={0} onScrollPosition={vi.fn()} onSelect={vi.fn()} onReadError={onReadError} />);
    await screen.findByRole("list", { name: "Commit history" });
    await waitFor(() => expect(container.querySelector(".historyLoadingMore")).not.toBeNull());
    const viewport = screen.getByRole("region", { name: "Commit graph view" });
    viewport.scrollTop = 1000;
    fireEvent.scroll(viewport);
    await screen.findByRole("alert");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(container.querySelector(".historyLoadingMore")).toBeNull();
    expect(container.querySelector(".loadingSpinner")).toBeNull();
    const reportedFailure = onReadError.mock.calls[onReadError.mock.calls.length - 1][0];
    fireEvent.click(screen.getByRole("button", { name: "Retry history" }));
    expect(onReadError).toHaveBeenLastCalledWith(reportedFailure);
    await act(async () => finishRetry({ repoId: "repo", offset: 1, limit: 50, commits: [], nextOffset: null }));
    await waitFor(() => expect(onReadError).toHaveBeenLastCalledWith(undefined));
  });

  it("shows one branch's history when scoped to it, and offers the way back to every branch", async () => {
    const getRepositoryCommits = vi.fn(async () => ({ repoId: "repo_fixture", offset: 0, limit: 50, commits: [commit(0)], nextOffset: null }));
    const api = cancellableApi({
      getRepositoryCommits,
      getRepositoryRefs: vi.fn(async () => ({ repoId: "repo_fixture", head: commit(0).oid, branch: "main", detached: false, refs: [] })),
    });
    const onClearBranchScope = vi.fn();
    const props = { api, repoId: "repo_fixture", initialScrollTop: 0, onScrollPosition: vi.fn(), onSelect: vi.fn(), onClearBranchScope };
    const { rerender } = render(<CommitGraph {...props} />);
    await screen.findByRole("list", { name: "Commit history" });
    expect(getRepositoryCommits).toHaveBeenLastCalledWith("repo_fixture", 0, 50, {});
    expect(screen.queryByText("History of")).toBeNull();

    rerender(<CommitGraph {...props} branchScope="origin/bootbase" />);
    await waitFor(() => expect(getRepositoryCommits).toHaveBeenLastCalledWith("repo_fixture", 0, 50, { branch: "origin/bootbase" }));
    expect(screen.getByText("History of")).toBeDefined();
    expect(screen.getByText("origin/bootbase", { selector: ".historyBranchScope .commitRefBadge" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Show history filters" }));
    const branchFilter = screen.getByRole("combobox", { name: "Filter by branch" }) as HTMLSelectElement;
    expect(branchFilter.disabled).toBe(true);
    // The scope is not one of the filters the user set, so it is not counted or cleared with them.
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show all branches" }));
    expect(onClearBranchScope).toHaveBeenCalledOnce();
  });

  it("draws commit parent edges when timestamp order places the parent first", async () => {
    const parent = { ...commit(3), parents: [] };
    const child = { ...commit(2), parents: [parent.oid] };
    const api = cancellableApi({
      getRepositoryCommits: vi.fn(async () => ({ repoId: "repo_fixture", offset: 0, limit: 50, commits: [parent, child], nextOffset: null })),
      getRepositoryRefs: vi.fn(async () => ({ repoId: "repo_fixture", head: child.oid, branch: "main", detached: false, refs: [] })),
    });
    const { container } = render(<CommitGraph api={api} repoId="repo_fixture" initialScrollTop={0} onScrollPosition={vi.fn()} onSelect={vi.fn()} />);

    await screen.findByRole("list", { name: "Commit history" });
    await waitFor(() => expect(container.querySelector(".commitGraphEdges path")).not.toBeNull());
  });

  it("finds the rightmost lane drawn in each row, including edges that only pass through", () => {
    // Row 0 on lane 0 merges a branch on lane 2 that ends at row 3; rows 1 and 2 sit on lane 0 but the edge crosses them.
    const lanes = [0, 0, 0, 2, 0];
    const edges = [
      { from: 0, to: 1, fromLane: 0, toLane: 0 },
      { from: 0, to: 3, fromLane: 0, toLane: 2 },
      { from: 1, to: 2, fromLane: 0, toLane: 0 },
      { from: 2, to: 4, fromLane: 0, toLane: 0 },
      { from: 3, to: 4, fromLane: 2, toLane: 0 },
    ];
    expect(occupiedLaneByRow(5, (row) => lanes[row], edges)).toEqual([2, 2, 2, 2, 2]);
    expect(occupiedLaneByRow(3, () => 0, [{ from: 0, to: 1, fromLane: 0, toLane: 1 }])).toEqual([1, 1, 0]);
    expect(occupiedLaneByRow(2, () => 0, [{ from: 1, to: 9, fromLane: 0, toLane: 3 }])).toEqual([0, 3]);
    expect(occupiedLaneByRow(0, () => 0, [])).toEqual([]);
  });

  it("starts each subject after every lane drawn in its row", async () => {
    const base = { ...commit(4), parents: [] };
    const side = { ...commit(3), parents: [base.oid] };
    const main = { ...commit(2), parents: [base.oid] };
    const merge = { ...commit(1), parents: [main.oid, side.oid] };
    const api = cancellableApi({
      getRepositoryCommits: vi.fn(async () => ({ repoId: "repo_fixture", offset: 0, limit: 50, commits: [merge, main, side, base], nextOffset: null })),
      getRepositoryRefs: vi.fn(async () => ({ repoId: "repo_fixture", head: merge.oid, branch: "main", detached: false, refs: [] })),
    });
    const { container } = render(<CommitGraph api={api} repoId="repo_fixture" initialScrollTop={0} onScrollPosition={vi.fn()} onSelect={vi.fn()} />);
    await screen.findByRole("list", { name: "Commit history" });
    await waitFor(() => expect(container.querySelectorAll(".commitGraphEntry")).toHaveLength(4));
    const padding = [...container.querySelectorAll<HTMLElement>(".commitGraphEntry")].map((entry) => entry.style.paddingLeft);
    // The "main" row is on lane 0, but the merge edge to "side" on lane 1 passes through it.
    expect(padding).toEqual(["62px", "62px", "62px", "62px"]);
  });

  it("persists the graph scroll position after scrolling ends", async () => {
    const oid = "a".repeat(40);
    const api = cancellableApi({
      getRepositoryCommits: vi.fn(async () => ({ repoId: "repo_fixture", offset: 0, limit: 50, commits: [commit(0)], nextOffset: null })),
      getRepositoryRefs: vi.fn(async () => ({ repoId: "repo_fixture", head: oid, branch: "main", detached: false, refs: [] })),
    });
    const onScrollPosition = vi.fn();
    render(<CommitGraph api={api} repoId="repo_fixture" initialScrollTop={0} onScrollPosition={onScrollPosition} onSelect={vi.fn()} />);

    const viewport = await screen.findByRole("region", { name: "Commit graph view" });
    viewport.scrollTop = 84;
    fireEvent.scroll(viewport);
    expect(onScrollPosition).not.toHaveBeenCalled();
    fireEvent(viewport, new Event("scrollend"));
    expect(onScrollPosition).toHaveBeenCalledWith(84);
  });

  it("focuses the message filter when a search shortcut request arrives", async () => {
    const api = cancellableApi({
      getRepositoryCommits: vi.fn(async () => ({ repoId: "repo_fixture", offset: 0, limit: 50, commits: [commit(0)], nextOffset: null })),
      getRepositoryRefs: vi.fn(async () => ({ repoId: "repo_fixture", head: commit(0).oid, branch: "main", detached: false, refs: [] })),
    });
    render(<CommitGraph api={api} repoId="repo_fixture" initialScrollTop={0} focusSearchRequest={{ repoId: "repo_fixture", sequence: 1 }} searchShortcut="Control+F" onScrollPosition={vi.fn()} onSelect={vi.fn()} />);

    const messageFilter = await screen.findByRole("textbox", { name: "Search commits" });
    await waitFor(() => expect(document.activeElement).toBe(messageFilter));
    expect(messageFilter.getAttribute("aria-keyshortcuts")).toBe("Control+F");
  });

  it("virtualizes rows, pages older commits, and supports keyboard selection", async () => {
    const entries = Array.from({ length: 120 }, (_, index) => commit(index));
    const getRepositoryCommits = vi.fn(async (_repoId: string, offset = 0, limit = 50) => ({
      repoId: "repo_fixture",
      offset,
      limit,
      commits: entries.slice(offset, offset + limit),
      nextOffset: offset + limit < entries.length ? offset + limit : null,
    }));
    const api = cancellableApi({
      getRepositoryCommits,
      getRepositoryRefs: vi.fn(async () => ({ repoId: "repo_fixture", head: entries[0].oid, branch: "main", detached: false, refs: [{ name: "main", fullName: "refs/heads/main", oid: entries[0].oid, kind: "local" as const, upstream: null }] })),
    });
    const onSelect = vi.fn();
    render(<CommitGraph api={api} repoId="repo_fixture" selectedOid={entries[0].oid} initialScrollTop={0} onScrollPosition={vi.fn()} onSelect={onSelect} />);

    const list = await screen.findByRole("list", { name: "Commit history" });
    await screen.findAllByText("main");
    expect(getRepositoryCommits).toHaveBeenCalledWith("repo_fixture", 0, 50, {});
    expect(list.querySelectorAll('[role="listitem"]')).toHaveLength(33);
    expect(screen.getByRole("button", { name: /Commit 0/ }).getAttribute("aria-current")).toBe("true");

    fireEvent.keyDown(screen.getByRole("button", { name: /Commit 0/ }), { key: "ArrowDown" });
    expect(onSelect).toHaveBeenCalledWith(entries[1].oid);

    fireEvent.scroll(screen.getByRole("region", { name: "Commit graph view" }));
    await waitFor(() => expect(getRepositoryCommits).toHaveBeenCalledWith("repo_fixture", 50, 50, {}));
    expect(list.querySelectorAll('[role="listitem"]').length).toBeLessThan(40);

    fireEvent.change(screen.getByRole("textbox", { name: "Search commits" }), { target: { value: "merge" } });
    // Message search submits on Enter; the other filters stay folded until asked for.
    expect(screen.queryByRole("textbox", { name: "Filter by author" })).toBeNull();
    fireEvent.submit(screen.getByRole("form", { name: "Commit history filters" }));
    await waitFor(() => expect(getRepositoryCommits).toHaveBeenCalledWith("repo_fixture", 0, 50, { message: "merge" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(getRepositoryCommits).toHaveBeenLastCalledWith("repo_fixture", 0, 50, {}));
  });

  it("shows the selected commit details and reports clipboard fallback", async () => {
    const oid = "a".repeat(40);
    const api = cancellableApi({
      getRepositoryCommit: vi.fn(async () => ({
        repoId: "repo_fixture", oid, parents: [], authorName: "GitCrest Author", authorEmail: "author@example.test",
        committedAtMs: 1_791_386_400_000, message: "A commit message\nwith context",
        stats: { filesChanged: 1, insertions: 2, deletions: 1 },
        files: [{ path: "src/file.ts", additions: 2, deletions: 1 }],
      })),
      createRepositoryCommitTag: vi.fn(async () => ({ repoId: "repo_fixture", name: "v1.0.0", fullName: "refs/tags/v1.0.0", oid })),
    });
    const onOpenFile = vi.fn();
    const onOpenDiffWindow = vi.fn();
    render(<CommitDetails api={api} repoId="repo_fixture" oid={oid} onOpenFile={onOpenFile} onOpenDiffWindow={onOpenDiffWindow} />);
    expect(await screen.findByText(/A commit message/)).toBeDefined();
    expect(screen.getByText("src/file.ts")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Copy SHA" }));
    expect((await screen.findByRole("status")).textContent).toContain("Clipboard access is unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Open commit diff for src/file.ts" }));
    expect(onOpenFile).toHaveBeenCalledWith("src/file.ts", oid);
    fireEvent.click(screen.getByRole("button", { name: "Open commit diff window for src/file.ts" }));
    expect(onOpenDiffWindow).toHaveBeenCalledWith("src/file.ts", oid);
    fireEvent.click(screen.getByRole("button", { name: "Create tag" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Tag name" }), { target: { value: "v1.0.0" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Tag annotation" }), { target: { value: "Release context" } });
    fireEvent.click(screen.getByRole("button", { name: "Create annotated tag" }));
    expect(await screen.findByText(/Annotated tag v1.0.0 created/)).toBeDefined();
    expect(api.createRepositoryCommitTag).toHaveBeenCalledWith("repo_fixture", oid, "v1.0.0", "Release context");
  });

  it("opens the tag editor when the tag shortcut request arrives", async () => {
    const oid = "a".repeat(40);
    const api = cancellableApi({
      getRepositoryCommit: vi.fn(async () => ({
        repoId: "repo_fixture", oid, parents: [], authorName: "Author", authorEmail: "author@example.test",
        committedAtMs: 1_791_386_400_000, message: "A commit message",
        stats: { filesChanged: 0, insertions: 0, deletions: 0 }, files: [],
      })),
    });
    render(<CommitDetails api={api} repoId="repo_fixture" oid={oid} openTagRequest={{ repoId: "repo_fixture", oid, sequence: 1 }} />);

    expect(await screen.findByRole("textbox", { name: "Tag name" })).toBeDefined();
  });
});
