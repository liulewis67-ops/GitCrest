// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommitDetailResponse, GitCrestApiClient } from "../../src/api/client";
import { CommitDetails } from "../../src/features/history/ui/CommitDetails";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const MESSAGE = "feat: add thing\n\nBody line one.\nBody line two.";

function renderDetails(props: { draftHasText?: boolean; onUseMessage?: (message: string) => void }) {
  const detail: CommitDetailResponse = {
    repoId: "repo_a", oid: "a".repeat(40), parents: [], authorName: "Ada", authorEmail: "ada@example.test",
    committedAtMs: 1, message: MESSAGE, stats: { filesChanged: 0, insertions: 0, deletions: 0 }, files: [],
  };
  const api = { withSignal: () => api, getRepositoryCommit: vi.fn().mockResolvedValue(detail) } as unknown as GitCrestApiClient;
  return render(<CommitDetails api={api} repoId="repo_a" oid={detail.oid} {...props} />);
}

describe("commit message reuse", () => {
  it("copies the full multi-line message", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderDetails({});
    fireEvent.click(await screen.findByRole("button", { name: "Copy message" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(MESSAGE));
  });

  it("fills an empty draft without asking", async () => {
    const onUseMessage = vi.fn();
    renderDetails({ onUseMessage, draftHasText: false });
    fireEvent.click(await screen.findByRole("button", { name: "Use as new commit message" }));
    expect(onUseMessage).toHaveBeenCalledWith(MESSAGE);
  });

  it("asks before replacing a non-empty draft", async () => {
    const onUseMessage = vi.fn();
    renderDetails({ onUseMessage, draftHasText: true });
    fireEvent.click(await screen.findByRole("button", { name: "Use as new commit message" }));
    expect(onUseMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    expect(onUseMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use as new commit message" }));
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(onUseMessage).toHaveBeenCalledWith(MESSAGE);
  });
});
