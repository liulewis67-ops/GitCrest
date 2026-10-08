// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitCrestApiClient } from "../../src/api/client";
import { CommitDetails, CommitGraph } from "../../src/features/history/CommitGraph";

afterEach(cleanup);

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
  it("draws commit parent edges when timestamp order places the parent first", async () => {
    const parent = { ...commit(3), parents: [] };
    const child = { ...commit(2), parents: [parent.oid] };
    const api = {
      getRepositoryCommits: vi.fn(async () => ({ repoId: "repo_fixture", offset: 0, limit: 50, commits: [parent, child], nextOffset: null })),
      getRepositoryRefs: vi.fn(async () => ({ repoId: "repo_fixture", head: child.oid, branch: "main", detached: false, refs: [] })),
    } as unknown as GitCrestApiClient;
    const { container } = render(<CommitGraph api={api} repoId="repo_fixture" initialScrollTop={0} onScrollPosition={vi.fn()} onSelect={vi.fn()} />);

    await screen.findByRole("list", { name: "Commit history" });
    await waitFor(() => expect(container.querySelector(".commitGraphEdges path")).not.toBeNull());
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
    const api = {
      getRepositoryCommits,
      getRepositoryRefs: vi.fn(async () => ({ repoId: "repo_fixture", head: entries[0].oid, branch: "main", detached: false, refs: [{ name: "main", fullName: "refs/heads/main", oid: entries[0].oid, kind: "local" as const, upstream: null }] })),
    } as unknown as GitCrestApiClient;
    const onSelect = vi.fn();
    render(<CommitGraph api={api} repoId="repo_fixture" selectedOid={entries[0].oid} initialScrollTop={0} onScrollPosition={vi.fn()} onSelect={onSelect} />);

    const list = await screen.findByRole("list", { name: "Commit history" });
    await screen.findAllByText("main");
    expect(getRepositoryCommits).toHaveBeenCalledWith("repo_fixture", 0, 50, {});
    expect(list.querySelectorAll('[role="listitem"]')).toHaveLength(26);
    expect(screen.getByRole("button", { name: /Commit 0/ }).getAttribute("aria-current")).toBe("true");

    fireEvent.keyDown(screen.getByRole("button", { name: /Commit 0/ }), { key: "ArrowDown" });
    expect(onSelect).toHaveBeenCalledWith(entries[1].oid);

    fireEvent.scroll(screen.getByRole("region", { name: "Commit graph view" }));
    await waitFor(() => expect(getRepositoryCommits).toHaveBeenCalledWith("repo_fixture", 50, 50, {}));
    expect(list.querySelectorAll('[role="listitem"]').length).toBeLessThan(40);

    fireEvent.change(screen.getByRole("textbox", { name: "Filter by message" }), { target: { value: "merge" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(getRepositoryCommits).toHaveBeenCalledWith("repo_fixture", 0, 50, { message: "merge" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(getRepositoryCommits).toHaveBeenLastCalledWith("repo_fixture", 0, 50, {}));
  });

  it("shows the selected commit details and reports clipboard fallback", async () => {
    const oid = "a".repeat(40);
    const api = {
      getRepositoryCommit: vi.fn(async () => ({
        repoId: "repo_fixture", oid, parents: [], authorName: "GitCrest Author", authorEmail: "author@example.test",
        committedAtMs: 1_791_386_400_000, message: "A commit message\nwith context",
        stats: { filesChanged: 1, insertions: 2, deletions: 1 },
        files: [{ path: "src/file.ts", additions: 2, deletions: 1 }],
      })),
      createRepositoryCommitTag: vi.fn(async () => ({ repoId: "repo_fixture", name: "v1.0.0", fullName: "refs/tags/v1.0.0", oid })),
    } as unknown as GitCrestApiClient;
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
});
