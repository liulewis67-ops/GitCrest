// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompareResultResponse, DiffDocumentResponse, GitCrestApiClient } from "../../src/api/client";
import { CompareDialog } from "../../src/features/compare/ui/CompareDialog";

afterEach(cleanup);

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const ANCESTOR = "c".repeat(40);

function commit(oid: string, subject: string) {
  return { oid, shortOid: oid.slice(0, 7), subject, authorName: "Ada", authoredAtMs: 1_700_000_000_000 };
}
function result(overrides: Partial<CompareResultResponse> = {}): CompareResultResponse {
  return {
    repoId: "repo_a", base: "main", head: "feature", baseOid: BASE, headOid: HEAD, fromOid: ANCESTOR, mergeBaseOid: ANCESTOR,
    mode: "threeDot", offset: 0, limit: 100,
    onlyInBase: { items: [commit("1".repeat(40), "add main file")], hasMore: false },
    onlyInHead: { items: [commit("2".repeat(40), "extend a")], hasMore: true },
    files: { items: [{ path: "a.txt", originalPath: null, kind: "modified" }, { path: "new.txt", originalPath: "old.txt", kind: "renamed" }], hasMore: false },
    ...overrides,
  };
}
const document: DiffDocumentResponse = {
  repoId: "repo_a", path: "a.txt", revision: "r1", originalPath: null, scope: "commit", changeKind: "modified", status: "text",
  hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, header: "@@", rows: [
    { kind: "context", oldLine: 1, newLine: 1, oldText: "one", newText: "one" },
    { kind: "change", oldLine: null, newLine: 2, oldText: null, newText: "two" },
  ] }],
} as unknown as DiffDocumentResponse;

function fakeApi(methods: Record<string, unknown>) {
  let api: Record<string, unknown>;
  api = { getRepositoryTags: vi.fn().mockResolvedValue({ tags: [{ name: "v1.0" }, { name: "main" }] }), ...methods, withSignal: vi.fn(() => api) };
  return api as unknown as GitCrestApiClient;
}
function renderDialog(api: GitCrestApiClient, initial: { base?: string; head?: string; workingTree?: boolean } = {}) {
  render(<CompareDialog api={api} repoId="repo_a" initial={initial} currentBranch="main" refNames={["main", "feature"]} onClose={vi.fn()} />);
}

describe("compare dialog", () => {
  it("lists the commits only on each side and the changed files for the two refs", async () => {
    const compareRevisions = vi.fn().mockResolvedValue(result());
    renderDialog(fakeApi({ compareRevisions }), { base: "main", head: "feature" });
    expect(await screen.findByText("extend a")).toBeTruthy();
    expect(compareRevisions).toHaveBeenCalledWith("repo_a", { base: "main", head: "feature", mode: "threeDot", limit: 100 });
    expect(within(screen.getByRole("region", { name: "Only in main" })).getByText("add main file")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "Only in feature" })).getByText("extend a")).toBeTruthy();
    expect(screen.getByText("old.txt → new.txt")).toBeTruthy();
    expect(screen.getByText(/They diverged at ccccccc/)).toBeTruthy();
  });

  it("asks for both sides before comparing and says why the button is off", () => {
    const compareRevisions = vi.fn();
    renderDialog(fakeApi({ compareRevisions }));
    const run = screen.getByRole("button", { name: "Compare" }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    expect(run.title).toBe("Enter what to compare it with, or choose the working tree.");
    fireEvent.click(screen.getByRole("checkbox", { name: /working tree/i }));
    expect(run.disabled).toBe(false);
    expect(compareRevisions).not.toHaveBeenCalled();
  });

  it("compares a commit with the working tree without a head", async () => {
    const compareRevisions = vi.fn().mockResolvedValue(result({ head: null, headOid: null, mode: "twoDot", fromOid: BASE }));
    renderDialog(fakeApi({ compareRevisions }), { base: BASE, workingTree: true });
    await screen.findByText(/Untracked files are not part/);
    expect(compareRevisions).toHaveBeenCalledWith("repo_a", { base: BASE, mode: "threeDot", limit: 100 });
  });

  it("pages one list by what it already shows and shows a file's change", async () => {
    const more = result({ onlyInHead: { items: [commit("3".repeat(40), "add feature file")], hasMore: false } });
    const compareRevisions = vi.fn().mockResolvedValueOnce(result()).mockResolvedValueOnce(more);
    const getRepositoryCompareDiff = vi.fn().mockResolvedValue(document);
    renderDialog(fakeApi({ compareRevisions, getRepositoryCompareDiff }), { base: "main", head: "feature" });
    const headColumn = await screen.findByRole("region", { name: "Only in feature" });
    fireEvent.click(within(headColumn).getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("add feature file")).toBeTruthy();
    expect(compareRevisions).toHaveBeenLastCalledWith("repo_a", expect.objectContaining({ offset: 1, head: "feature" }));
    expect(within(screen.getByRole("region", { name: "Only in feature" })).queryByRole("button", { name: "Load more" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "a.txt" }));
    await waitFor(() => expect(screen.getByText("+two")).toBeTruthy());
    expect(getRepositoryCompareDiff).toHaveBeenCalledWith("repo_a", { from: ANCESTOR, to: HEAD, path: "a.txt" });
  });

  it("can be cancelled while it runs and reports a failed comparison", async () => {
    let signalled: AbortSignal | undefined;
    const pending = vi.fn(() => new Promise(() => undefined));
    const api = fakeApi({ compareRevisions: pending });
    (api as unknown as { withSignal: (signal: AbortSignal) => unknown }).withSignal = vi.fn((signal: AbortSignal) => { signalled = signal; return api; });
    renderDialog(api, { base: "main", head: "feature" });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(signalled?.aborted).toBe(true);
    expect(await screen.findByText("The comparison was cancelled.")).toBeTruthy();
  });

  it("opens a file in the Diff window, with the comparison's own commit IDs, instead of reading it here", async () => {
    const onOpenFile = vi.fn().mockResolvedValue(undefined);
    const getRepositoryCompareDiff = vi.fn();
    render(<CompareDialog api={fakeApi({ compareRevisions: vi.fn().mockResolvedValue(result()), getRepositoryCompareDiff })} repoId="repo_a" initial={{ base: "main", head: "feature" }} refNames={[]} onOpenFile={onOpenFile} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "a.txt" }));
    await waitFor(() => expect(onOpenFile).toHaveBeenCalledWith({ path: "a.txt", fromOid: ANCESTOR, toOid: HEAD }));
    expect(await screen.findByText("a.txt is open in the Diff window.")).toBeTruthy();
    expect(getRepositoryCompareDiff).not.toHaveBeenCalled();
  });

  it("leaves the end out when comparing with the working tree, and reports a window that would not open", async () => {
    const onOpenFile = vi.fn().mockRejectedValue(new Error("window failed"));
    render(<CompareDialog api={fakeApi({ compareRevisions: vi.fn().mockResolvedValue(result({ head: null, headOid: null, mode: "twoDot", fromOid: BASE })) })} repoId="repo_a" initial={{ base: BASE, workingTree: true }} refNames={[]} onOpenFile={onOpenFile} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "a.txt" }));
    await waitFor(() => expect(onOpenFile).toHaveBeenCalledWith({ path: "a.txt", fromOid: BASE }));
    expect((await screen.findByRole("alert")).textContent).toContain("window failed");
  });

  it("suggests the repository's tags next to its branches", async () => {
    renderDialog(fakeApi({ compareRevisions: vi.fn() }));
    await waitFor(() => expect(window.document.querySelectorAll("datalist option").length).toBe(3));
    expect([...window.document.querySelectorAll("datalist option")].map((option) => option.getAttribute("value"))).toEqual(["main", "feature", "v1.0"]);
  });

  it("shows why a comparison failed", async () => {
    renderDialog(fakeApi({ compareRevisions: vi.fn().mockRejectedValue(new Error("One side of the comparison is not a commit in this repository.")) }), { base: "nope", head: "feature" });
    expect((await screen.findByRole("alert")).textContent).toContain("not a commit");
  });
});
