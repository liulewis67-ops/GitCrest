// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitCrestApiClient, ReflogPageResponse } from "../../src/api/client";
import { ReflogDialog } from "../../src/features/history/ui/ReflogDialog";

afterEach(cleanup);

const LOST = "a".repeat(40);
const BACKUP = "b".repeat(40);

function entry(index: number, oid: string, message: string) {
  return { index, oid, selector: `HEAD@{${index}}`, message, createdAtMs: 1_700_000_000_000 - index * 1000 };
}
function page(overrides: Partial<ReflogPageResponse> = {}): ReflogPageResponse {
  return {
    repoId: "repo_a", ref: "HEAD", offset: 0, limit: 100,
    entries: [entry(0, "c".repeat(40), "reset: moving to HEAD~2"), entry(1, LOST, "commit: third")],
    nextOffset: null,
    backups: [{ reference: "refs/gitcrest/reset-backups/t1", oid: BACKUP, kind: "reset", subject: "second", createdAtMs: 1_700_000_000_000 }],
    ...overrides,
  };
}
function fakeApi(getRepositoryReflog: ReturnType<typeof vi.fn>) {
  let api: Record<string, unknown>;
  api = { getRepositoryReflog, withSignal: vi.fn(() => api) };
  return api as unknown as GitCrestApiClient;
}
function renderDialog(api: GitCrestApiClient, handlers: { onCreateBranch?: (oid: string) => void; onResetTo?: (oid: string) => void; disabled?: boolean } = {}) {
  render(<ReflogDialog api={api} repoId="repo_a" branchNames={["main", "feature/x"]} disabled={handlers.disabled ?? false} onClose={vi.fn()} onCreateBranch={handlers.onCreateBranch ?? vi.fn()} onResetTo={handlers.onResetTo ?? vi.fn()} />);
}

describe("reflog dialog", () => {
  it("lists where HEAD has been and GitCrest's own backups", async () => {
    renderDialog(fakeApi(vi.fn().mockResolvedValue(page())));
    expect(await screen.findByText("commit: third")).toBeTruthy();
    expect(screen.getByText("reset: moving to HEAD~2")).toBeTruthy();
    const backups = screen.getByRole("region", { name: "GitCrest backups" });
    expect(within(backups).getByText("reset backup")).toBeTruthy();
    expect(within(backups).getByText("second")).toBeTruthy();
  });

  it("starts a branch from a lost commit", async () => {
    const onCreateBranch = vi.fn();
    renderDialog(fakeApi(vi.fn().mockResolvedValue(page())), { onCreateBranch });
    const row = (await screen.findByText("commit: third")).closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Create branch here…" }));
    expect(onCreateBranch).toHaveBeenCalledWith(LOST);
  });

  it("hands a reset to the reviewed reset flow instead of running it", async () => {
    const onResetTo = vi.fn();
    renderDialog(fakeApi(vi.fn().mockResolvedValue(page())), { onResetTo });
    const backups = await screen.findByRole("region", { name: "GitCrest backups" });
    fireEvent.click(within(backups).getByRole("button", { name: "Reset to here…" }));
    expect(onResetTo).toHaveBeenCalledWith(BACKUP);
  });

  it("switches to a branch's own reflog", async () => {
    const getRepositoryReflog = vi.fn().mockResolvedValue(page());
    renderDialog(fakeApi(getRepositoryReflog));
    await screen.findByText("commit: third");
    fireEvent.change(screen.getByLabelText("Show the history of"), { target: { value: "refs/heads/feature/x" } });
    await waitFor(() => expect(getRepositoryReflog).toHaveBeenLastCalledWith("repo_a", { ref: "refs/heads/feature/x" }));
  });

  it("loads older entries on request", async () => {
    const getRepositoryReflog = vi.fn()
      .mockResolvedValueOnce(page({ nextOffset: 2 }))
      .mockResolvedValueOnce(page({ offset: 2, entries: [entry(2, "d".repeat(40), "commit: first")], nextOffset: null, backups: [] }));
    renderDialog(fakeApi(getRepositoryReflog));
    await screen.findByText("commit: third");
    fireEvent.click(screen.getByRole("button", { name: "Load older entries" }));
    expect(await screen.findByText("commit: first")).toBeTruthy();
    expect(getRepositoryReflog).toHaveBeenLastCalledWith("repo_a", { ref: "HEAD", offset: 2 });
    expect(screen.queryByRole("button", { name: "Load older entries" })).toBeNull();
  });

  it("blocks recovery actions while a Git task runs", async () => {
    renderDialog(fakeApi(vi.fn().mockResolvedValue(page())), { disabled: true });
    await screen.findByText("commit: third");
    for (const button of screen.getAllByRole("button", { name: /Create branch here|Reset to here/ })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("shows an error with a retry, and an empty state", async () => {
    const getRepositoryReflog = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue(page({ entries: [], backups: [] }));
    renderDialog(fakeApi(getRepositoryReflog));
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("There is nothing in this reflog yet.")).toBeTruthy();
  });
});
