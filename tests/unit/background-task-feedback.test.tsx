// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TaskSnapshotResponse } from "../../src/api/client";
import { useBackgroundTaskFeedback } from "../../src/features/tasks";
import { clearNotices, useNotices } from "../../src/shared/notices/notice-store";

afterEach(() => { cleanup(); clearNotices(); });
const task = (status: TaskSnapshotResponse["status"], operation = "pullMerge") => ({ taskId: "t", repoId: "repo", operation, status }) as TaskSnapshotResponse;

it("keeps running and completed operations quiet", () => {
  const openDetails = vi.fn();
  const { result, rerender } = renderHook(({ tasks }) => {
    useBackgroundTaskFeedback({ tasks, error: "", openDetails });
    return useNotices();
  }, { initialProps: { tasks: [task("running")] } });
  rerender({ tasks: [task("succeeded")] });
  expect(result.current).toEqual([]);
  expect(openDetails).not.toHaveBeenCalled();
});

it("offers failure details without opening them until the user asks", () => {
  const openDetails = vi.fn();
  const { result, rerender } = renderHook(({ tasks }) => {
    useBackgroundTaskFeedback({ tasks, error: "", openDetails });
    return useNotices();
  }, { initialProps: { tasks: [task("running")] } });
  rerender({ tasks: [task("failed")] });
  expect(result.current).toHaveLength(1);
  expect(result.current[0].kind).toBe("error");
  expect(openDetails).not.toHaveBeenCalled();
  result.current[0].action!.run();
  expect(openDetails).toHaveBeenCalledOnce();
  rerender({ tasks: [task("failed")] });
  expect(result.current).toHaveLength(1);
});

it("does not replay historical failures or interrupt scheduled fetch failures", () => {
  const { result, rerender } = renderHook(({ tasks }) => {
    useBackgroundTaskFeedback({ tasks, error: "", openDetails: vi.fn() });
    return useNotices();
  }, { initialProps: { tasks: [task("failed")] } });
  rerender({ tasks: [task("running", "fetchBackground")] });
  rerender({ tasks: [task("failed", "fetchBackground")] });
  expect(result.current).toEqual([]);
});

it("shows request errors as notices without opening Tasks", () => {
  const openDetails = vi.fn();
  const { result } = renderHook(() => {
    useBackgroundTaskFeedback({ tasks: [], error: "Could not start pull", openDetails });
    return useNotices();
  });
  expect(result.current[0].message).toBe("Could not start pull");
  expect(openDetails).not.toHaveBeenCalled();
});
