// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitCrestApiClient } from "../../src/api/client";
import { TagList } from "../../src/features/history";
import { ShelfCenter } from "../../src/features/shelves";
import { HINTS_STORAGE_KEY, HINT_IDS, dismissHint, readDismissedHints, resetHints, resetHintsCache } from "../../src/shared/hints/hints-store";
import { EmptyState } from "../../src/shared/ui/EmptyState";
import { InlineHint } from "../../src/shared/ui/InlineHint";

beforeEach(() => {
  localStorage.clear();
  resetHintsCache();
});
afterEach(cleanup);

function fakeApi(methods: Record<string, unknown>) {
  let api: Record<string, unknown>;
  api = { ...methods, withSignal: vi.fn(() => api) };
  return api as unknown as GitCrestApiClient;
}

describe("first-use hints", () => {
  it("shows a hint as a note, once, until it is dismissed", () => {
    const { unmount } = render(<InlineHint id="changes" title="Choose what goes into the commit">Tick a file.</InlineHint>);
    const note = screen.getByRole("note");
    expect(note.textContent).toContain("Tick a file.");
    // A note is read in place; it is not an alert and does not take focus.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Got it" }));
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("note")).toBeNull();
    unmount();

    // It stays gone on the next visit, and other hints are unaffected.
    resetHintsCache();
    render(<><InlineHint id="changes">Tick a file.</InlineHint><InlineHint id="shelves">Shelves.</InlineHint></>);
    expect(screen.queryByText("Tick a file.")).toBeNull();
    expect(screen.getByText("Shelves.")).toBeTruthy();
  });

  it("comes back when reset", () => {
    render(<InlineHint id="ai">Nothing is sent without your confirmation.</InlineHint>);
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByRole("note")).toBeNull();
    act(() => resetHints());
    expect(screen.getByRole("note")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(HINTS_STORAGE_KEY)!)).toEqual([]);
  });

  it("remembers only hints that exist, and survives bad storage", () => {
    expect([...readDismissedHints(JSON.stringify(["changes", "nonsense", 3]))]).toEqual(["changes"]);
    expect(readDismissedHints("{broken").size).toBe(0);
    expect(readDismissedHints(null).size).toBe(0);
    dismissHint("structure");
    expect(JSON.parse(localStorage.getItem(HINTS_STORAGE_KEY)!)).toEqual(["structure"]);
    expect(HINT_IDS).toEqual(["changes", "shelves", "structure", "ai"]);
  });
});

describe("empty states", () => {
  it("offers the next step as a button that works by keyboard", () => {
    const onAction = vi.fn();
    render(<EmptyState actionLabel="Add a remote" onAction={onAction}>No remotes configured</EmptyState>);
    const button = screen.getByRole("button", { name: "Add a remote" });
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("shows only the sentence when there is no action, and says why an action waits", () => {
    const { rerender } = render(<EmptyState>Nothing here</EmptyState>);
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<EmptyState actionLabel="Do it" onAction={vi.fn()} actionDisabled actionTitle="Wait for the running Git task to finish.">Nothing here</EmptyState>);
    const button = screen.getByRole("button", { name: "Do it" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe("Wait for the running Git task to finish.");
  });

  it("an empty tag list offers to create the first tag", async () => {
    const onCreateTag = vi.fn();
    const api = fakeApi({ getRepositoryTags: vi.fn().mockResolvedValue({ repoId: "repo_a", offset: 0, limit: 100, tags: [], nextOffset: null }) });
    render(<TagList api={api} repoId="repo_a" refreshKey={0} onSelectCommit={vi.fn()} onCreateTag={onCreateTag} />);
    fireEvent.click(await screen.findByRole("button", { name: "Create a tag" }));
    expect(onCreateTag).toHaveBeenCalled();
  });

  it("an empty shelf list explains shelving and opens the shelve dialog", async () => {
    const api = fakeApi({ listRepositoryShelves: vi.fn().mockResolvedValue([]), getRepositoryStashes: vi.fn().mockResolvedValue({ repoId: "repo_a", stashes: [] }) });
    render(<ShelfCenter api={api} repoId="repo_a" headOid={null} files={[]} statusReady disabled={false} refreshKey={0} openComposerRequest={0} onTaskSubmitted={vi.fn()} />);
    expect(await screen.findByText(/No saved shelves/)).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain("Saved shelves");
    fireEvent.click(screen.getByRole("button", { name: "Shelve some changes…" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });
});
