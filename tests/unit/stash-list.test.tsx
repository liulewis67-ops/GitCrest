// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommitDetailResponse, GitCrestApiClient, StashEntryResponse } from "../../src/api/client";
import { StashList } from "../../src/features/shelves/ui/StashList";

afterEach(cleanup);

const STASH = "a".repeat(40);
const UNTRACKED = "b".repeat(40);

function entry(overrides: Partial<StashEntryResponse> = {}): StashEntryResponse {
  return { index: 0, oid: STASH, baseOid: "c".repeat(40), untrackedOid: null, branch: "main", message: "tracked work", createdAtMs: 1_700_000_000_000, ...overrides };
}
function detail(oid: string, paths: string[]): CommitDetailResponse {
  return {
    repoId: "repo_a", oid, parents: [], authorName: "Ada", authorEmail: "ada@example.test", committedAtMs: 1, message: "stash", stats: { filesChanged: paths.length, insertions: 0, deletions: 0 },
    files: paths.map((path) => ({ path, status: "modified", additions: 1, deletions: 2 })),
  } as unknown as CommitDetailResponse;
}
function fakeApi(methods: Record<string, unknown>) {
  let api: Record<string, unknown>;
  api = { ...methods, withSignal: vi.fn(() => api) };
  return api as unknown as GitCrestApiClient;
}

describe("Git stash list", () => {
  it("renders nothing when the repository has no stash", async () => {
    const getRepositoryStashes = vi.fn().mockResolvedValue({ repoId: "repo_a", stashes: [] });
    const { container } = render(<StashList api={fakeApi({ getRepositoryStashes })} repoId="repo_a" refreshKey={0} onOpenFile={vi.fn()} />);
    await waitFor(() => expect(getRepositoryStashes).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("labels entries as Git stash and opens a file of the stash commit", async () => {
    const onOpenFile = vi.fn();
    const api = fakeApi({
      getRepositoryStashes: vi.fn().mockResolvedValue({ repoId: "repo_a", stashes: [entry()] }),
      getRepositoryCommit: vi.fn().mockResolvedValue(detail(STASH, ["src/a.ts"])),
    });
    render(<StashList api={api} repoId="repo_a" refreshKey={0} onOpenFile={onOpenFile} />);

    fireEvent.click(await screen.findByRole("button", { name: "Show files of stash tracked work" }));
    expect(screen.getAllByText("Git stash").length).toBeGreaterThan(1);
    fireEvent.click(await screen.findByRole("button", { name: "Open commit diff for src/a.ts" }));
    expect(onOpenFile).toHaveBeenCalledWith("src/a.ts", STASH);
  });

  it("shows the untracked part of a stash made with -u", async () => {
    const onOpenFile = vi.fn();
    const getRepositoryCommit = vi.fn(async (_repo: string, oid: string) => oid === STASH ? detail(STASH, ["src/a.ts"]) : detail(UNTRACKED, ["notes.txt"]));
    const api = fakeApi({
      getRepositoryStashes: vi.fn().mockResolvedValue({ repoId: "repo_a", stashes: [entry({ untrackedOid: UNTRACKED })] }),
      getRepositoryCommit,
    });
    render(<StashList api={api} repoId="repo_a" refreshKey={0} onOpenFile={onOpenFile} />);

    fireEvent.click(await screen.findByRole("button", { name: "Show files of stash tracked work" }));
    const untracked = await screen.findByRole("button", { name: "Open commit diff for notes.txt" });
    expect(untracked.textContent).toContain("untracked");
    fireEvent.click(untracked);
    expect(onOpenFile).toHaveBeenCalledWith("notes.txt", UNTRACKED);
  });

  it("offers a retry when the list cannot be read", async () => {
    const getRepositoryStashes = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue({ repoId: "repo_a", stashes: [entry()] });
    render(<StashList api={fakeApi({ getRepositoryStashes })} repoId="repo_a" refreshKey={0} onOpenFile={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Show files of stash tracked work" })).toBeTruthy();
  });
});
