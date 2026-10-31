// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitCrestApiClient, TagEntryResponse, TagPageResponse } from "../../src/api/client";
import { TagList } from "../../src/features/history";
import { useCommitTags } from "../../src/features/history/model/use-commit-tags";

afterEach(cleanup);

const A = "a".repeat(40);
const B = "b".repeat(40);

function tag(name: string, targetOid: string, annotated = false): TagEntryResponse {
  return { name, targetOid, annotated, taggerName: null, createdAtMs: 1, message: annotated ? "Release" : null };
}
function page(tags: TagEntryResponse[], nextOffset: number | null = null): TagPageResponse {
  return { repoId: "repo_a", offset: 0, limit: 100, tags, nextOffset };
}
function fakeApi(getRepositoryTags: ReturnType<typeof vi.fn>) {
  let api: Record<string, unknown>;
  api = { getRepositoryTags, withSignal: vi.fn(() => api) };
  return api as unknown as GitCrestApiClient;
}

describe("tag list", () => {
  it("lists tags, tells annotated from lightweight, and selects the tagged commit", async () => {
    const onSelectCommit = vi.fn();
    const api = fakeApi(vi.fn().mockResolvedValue(page([tag("v2", A, true), tag("v1", B)])));
    render(<TagList api={api} repoId="repo_a" refreshKey={0} onSelectCommit={onSelectCommit} />);

    const annotated = await screen.findByRole("button", { name: `Show commit ${A.slice(0, 8)} for tag v2` });
    expect(annotated.textContent).toContain("annotated");
    expect(screen.getByRole("button", { name: `Show commit ${B.slice(0, 8)} for tag v1` }).textContent).toContain("lightweight");
    fireEvent.click(annotated);
    expect(onSelectCommit).toHaveBeenCalledWith(A);
  });

  it("filters by name and loads further pages", async () => {
    const getRepositoryTags = vi.fn()
      .mockResolvedValueOnce(page([tag("v1", A)], 100))
      .mockResolvedValueOnce(page([tag("v0", B)]))
      .mockResolvedValue(page([]));
    render(<TagList api={fakeApi(getRepositoryTags)} repoId="repo_a" refreshKey={0} onSelectCommit={vi.fn()} />);

    await screen.findByText("v1");
    fireEvent.click(screen.getByRole("button", { name: "Load more tags" }));
    await screen.findByText("v0");
    expect(getRepositoryTags).toHaveBeenLastCalledWith("repo_a", { offset: 100, limit: 100, filter: undefined });

    fireEvent.change(screen.getByLabelText("Filter tags"), { target: { value: "zzz" } });
    expect(await screen.findByText("No tag matches “zzz”.")).toBeTruthy();
    expect(getRepositoryTags).toHaveBeenLastCalledWith("repo_a", { limit: 100, filter: "zzz" });
  });

  it("offers Compare with… for a tag and passes its name", async () => {
    const onCompare = vi.fn();
    render(<TagList api={fakeApi(vi.fn().mockResolvedValue(page([tag("v1", A)])))} repoId="repo_a" refreshKey={0} onSelectCommit={vi.fn()} onCompare={onCompare} />);
    fireEvent.click(await screen.findByRole("button", { name: "Actions for tag v1" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Compare with…" }));
    expect(onCompare).toHaveBeenCalledWith("v1");
  });

  it("shows an empty state and a retry on failure", async () => {
    const getRepositoryTags = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue(page([]));
    render(<TagList api={fakeApi(getRepositoryTags)} repoId="repo_a" refreshKey={0} onSelectCommit={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText(/no tags yet/)).toBeTruthy();
  });
});

describe("graph tag labels", () => {
  it("asks only for commits it has not asked about", async () => {
    const getRepositoryTags = vi.fn(async (_repoId: string, options: { targets?: readonly string[] }) =>
      page(options.targets?.includes(A) ? [tag("v1", A, true)] : []));
    const api = fakeApi(getRepositoryTags);
    const { result, rerender } = renderHook(({ oids }) => useCommitTags(api, "repo_a", oids, 0), { initialProps: { oids: [A] } });
    await waitFor(() => expect(result.current.get(A)).toEqual([{ name: "v1", annotated: true }]));

    await act(async () => rerender({ oids: [A, B] }));
    await waitFor(() => expect(getRepositoryTags).toHaveBeenCalledTimes(2));
    expect(getRepositoryTags.mock.calls[1][1].targets).toEqual([B]);
  });

  it("leaves labels off when the lookup fails", async () => {
    const api = fakeApi(vi.fn().mockRejectedValue(new Error("down")));
    const { result } = renderHook(() => useCommitTags(api, "repo_a", [A], 0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.size).toBe(0);
  });
});
