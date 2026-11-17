// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  it("shows initial loading followed by the empty state", async () => {
    const getRepositoryStashes = vi.fn().mockResolvedValue({ repoId: "repo_a", stashes: [] });
    render(<StashList api={fakeApi({ getRepositoryStashes })} repoId="repo_a" refreshKey={0} onOpenFile={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toContain("Loading Git stashes");
    expect(await screen.findByText("This repository has no Git stashes.")).toBeTruthy();
  });

  it("labels entries as Git stash and opens a file of the stash commit", async () => {
    const onOpenFile = vi.fn();
    const api = fakeApi({
      getRepositoryStashes: vi.fn().mockResolvedValue({ repoId: "repo_a", stashes: [entry()] }),
      getRepositoryCommit: vi.fn().mockResolvedValue(detail(STASH, ["src/a.ts"])),
    });
    render(<StashList api={api} repoId="repo_a" refreshKey={0} onOpenFile={onOpenFile} />);

    fireEvent.click(await screen.findByRole("button", { name: "Show files of stash tracked work" }));
    expect(screen.getByText("stash@{0}")).toBeTruthy();
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

  it("preserves loaded rows on refresh failure and cancels details for a removed stash", async () => {
    const getRepositoryStashes = vi.fn()
      .mockResolvedValueOnce({ stashes: [entry()] })
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce({ stashes: [] });
    let resolveDetail!: (value: CommitDetailResponse) => void;
    const getRepositoryCommit = vi.fn(() => new Promise<CommitDetailResponse>((resolve) => { resolveDetail = resolve; }));
    const api = fakeApi({ getRepositoryStashes, getRepositoryCommit });
    const onOpenFile = vi.fn();
    const { rerender } = render(<StashList api={api} repoId="repo_a" refreshKey={0} onOpenFile={onOpenFile} />);
    const row = await screen.findByRole("button", { name: "Show files of stash tracked work" });
    fireEvent.click(row);
    const signal = vi.mocked(api.withSignal).mock.lastCall?.[0];
    rerender(<StashList api={api} repoId="repo_a" refreshKey={1} onOpenFile={onOpenFile} />);
    expect(await screen.findByText("The displayed stash list may be out of date.")).toBeTruthy();
    expect(row.isConnected).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("This repository has no Git stashes.");
    await waitFor(() => expect(signal?.aborted).toBe(true));
    await act(async () => resolveDetail(detail(STASH, ["src/a.ts"])));
    expect(screen.queryByRole("button", { name: "Open commit diff for src/a.ts" })).toBeNull();
  });
});
