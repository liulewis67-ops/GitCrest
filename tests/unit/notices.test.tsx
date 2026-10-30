// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskSnapshotResponse } from "../../src/api/client";
import { bulkStagingMessage, useStagingNotices } from "../../src/features/changes/model/use-staging-notices";
import { MAX_NOTICES, NOTICE_LIFETIME_MS, clearNotices, notify, pushNotice } from "../../src/shared/notices/notice-store";
import { NoticeRegion } from "../../src/shared/ui/NoticeRegion";

beforeEach(() => {
  vi.useFakeTimers();
  clearNotices();
});
afterEach(() => {
  cleanup();
  clearNotices();
  vi.useRealTimers();
});

describe("notice queue", () => {
  it("is announced through one polite live region that exists before any notice", () => {
    render(<NoticeRegion />);
    const region = screen.getByRole("status", { name: "Notifications" });
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.children).toHaveLength(0);
    act(() => { notify.success("Copied"); });
    expect(region.textContent).toContain("Copied");
    // Still the one region: there is no second status or alert element for notices.
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("names the kind for assistive technology and never takes focus", () => {
    render(<NoticeRegion />);
    const before = document.activeElement;
    act(() => { notify.error("Could not open the folder"); });
    expect(screen.getByText("Error:")).toBeTruthy();
    expect(document.activeElement).toBe(before);
  });

  it("clears success and warning notices by themselves but keeps errors until dismissed", () => {
    render(<NoticeRegion />);
    act(() => { notify.success("saved"); notify.warning("careful"); notify.error("failed"); });
    act(() => { vi.advanceTimersByTime(NOTICE_LIFETIME_MS.success + 10); });
    expect(screen.queryByText("saved")).toBeNull();
    expect(screen.getByText("careful")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(NOTICE_LIFETIME_MS.warning); });
    expect(screen.queryByText("careful")).toBeNull();
    act(() => { vi.advanceTimersByTime(10 * 60_000); });
    expect(screen.getByText("failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("failed")).toBeNull();
  });

  it("keeps a notice with an action longer, and the action runs once and dismisses it", () => {
    render(<NoticeRegion />);
    const run = vi.fn();
    act(() => { notify.success("Staged", { label: "Undo", run }); });
    act(() => { vi.advanceTimersByTime(NOTICE_LIFETIME_MS.success + 100); });
    expect(screen.getByText("Staged")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Staged")).toBeNull();
  });

  it("replaces a notice with the same key instead of stacking, and ignores empty messages", () => {
    render(<NoticeRegion />);
    act(() => {
      pushNotice({ kind: "warning", message: "first", key: "k" });
      pushNotice({ kind: "warning", message: "second", key: "k" });
      pushNotice({ kind: "warning", message: "   " });
    });
    expect(screen.queryByText("first")).toBeNull();
    expect(screen.getByText("second")).toBeTruthy();
    expect(screen.getAllByText(/second|first/)).toHaveLength(1);
  });

  it("makes room by dropping the oldest non-error notice, never an error", () => {
    render(<NoticeRegion />);
    act(() => {
      notify.error("keep me");
      for (let index = 0; index < MAX_NOTICES + 2; index += 1) notify.success(`ok ${index}`);
    });
    expect(screen.getByText("keep me")).toBeTruthy();
    expect(screen.queryByText("ok 0")).toBeNull();
    expect(screen.getByText(`ok ${MAX_NOTICES + 1}`)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Dismiss" })).toHaveLength(MAX_NOTICES);
  });
});

describe("bulk staging notices", () => {
  function task(operation: string, status: TaskSnapshotResponse["status"], repoId = "repo_a"): TaskSnapshotResponse {
    return { taskId: `${operation}-1`, repoId, operation, status, phase: "", progress: null, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false, targetPath: null, resultRepoId: null } as TaskSnapshotResponse;
  }
  function setup(initial: TaskSnapshotResponse[]) {
    const announce = vi.fn();
    const undo = vi.fn();
    const hook = renderHook((tasks: TaskSnapshotResponse[]) => useStagingNotices({ tasks, announce, undo, repoId: "repo_a" }), { initialProps: initial });
    return { announce, undo, ...hook };
  }

  it("offers Undo when a bulk stage finishes, wired to the undo operation", () => {
    const { announce, undo, rerender } = setup([task("stageAll", "running")]);
    rerender([task("stageAll", "succeeded")]);
    expect(announce).toHaveBeenCalledWith("All changes staged.", undo);
  });

  it("covers the other bulk operations but not a single file", () => {
    for (const [operation, expected] of [["unstageAll", "All changes unstaged."], ["stagePaths", "The selected files were staged."], ["unstagePaths", "The selected files were unstaged."]] as const) {
      const { announce, rerender, unmount } = setup([task(operation, "running")]);
      rerender([task(operation, "succeeded")]);
      expect(announce, operation).toHaveBeenCalledWith(expected, expect.any(Function));
      unmount();
    }
    expect(bulkStagingMessage("stageFile")).toBeUndefined();
    const single = setup([task("stageFile", "running")]);
    single.rerender([task("stageFile", "succeeded")]);
    expect(single.announce).not.toHaveBeenCalled();
  });

  it("stays quiet for failures, tasks never seen running, and other repositories", () => {
    const failed = setup([task("stageAll", "running")]);
    failed.rerender([task("stageAll", "failed")]);
    expect(failed.announce).not.toHaveBeenCalled();
    const late = setup([]);
    late.rerender([task("stageAll", "succeeded")]);
    expect(late.announce).not.toHaveBeenCalled();
    const other = setup([task("stageAll", "running", "repo_b")]);
    other.rerender([task("stageAll", "succeeded", "repo_b")]);
    expect(other.announce).not.toHaveBeenCalled();
  });
});
