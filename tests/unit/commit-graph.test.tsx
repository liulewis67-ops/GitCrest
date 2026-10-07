// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitCrestApiClient } from "../../src/api/client";
import { CommitGraph } from "../../src/features/history/CommitGraph";

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
    await screen.findByText("main");
    expect(getRepositoryCommits).toHaveBeenCalledWith("repo_fixture", 0, 50);
    expect(list.querySelectorAll('[role="listitem"]')).toHaveLength(26);
    expect(screen.getByRole("button", { name: /Commit 0/ }).getAttribute("aria-current")).toBe("true");

    fireEvent.keyDown(screen.getByRole("button", { name: /Commit 0/ }), { key: "ArrowDown" });
    expect(onSelect).toHaveBeenCalledWith(entries[1].oid);

    fireEvent.scroll(screen.getByRole("region", { name: "Commit graph view" }));
    await waitFor(() => expect(getRepositoryCommits).toHaveBeenCalledWith("repo_fixture", 50, 50));
    expect(list.querySelectorAll('[role="listitem"]').length).toBeLessThan(40);
  });
});
