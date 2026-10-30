// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskSnapshotResponse } from "../../src/api/client";
import { NOTIFICATIONS_STORAGE_KEY, getNotificationsEnabled, resetNotificationPreferenceCache, setNotificationsEnabled } from "../../src/features/tasks/model/notification-preferences";
import { fetchBroughtNewRefs, notificationForFinishedTask } from "../../src/features/tasks/model/task-notification";
import { useTaskNotifications, type TaskNotificationRequest } from "../../src/features/tasks/model/use-task-notifications";
import { NotificationSettings } from "../../src/features/tasks/ui/NotificationSettings";

function task(overrides: Partial<TaskSnapshotResponse>): TaskSnapshotResponse {
  return { taskId: "t1", repoId: "repo_a", operation: "push", status: "succeeded", phase: "", progress: null, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false, ...overrides } as TaskSnapshotResponse;
}

beforeEach(() => {
  localStorage.clear();
  resetNotificationPreferenceCache();
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "gitcrest");
});

describe("which endings are announced", () => {
  it("announces push, pull, clone, a fetch that brought something, and failures", () => {
    expect(notificationForFinishedTask(task({ operation: "push" }))).toEqual({ kind: "pushDone" });
    expect(notificationForFinishedTask(task({ operation: "pushForceWithLease" }))).toEqual({ kind: "pushDone" });
    expect(notificationForFinishedTask(task({ operation: "pullRebase" }))).toEqual({ kind: "pullDone" });
    expect(notificationForFinishedTask(task({ operation: "clone" }))).toEqual({ kind: "cloneDone" });
    expect(notificationForFinishedTask(task({ operation: "fetch", logs: ["   1a2b3c4..5d6e7f8  main       -> origin/main"] }))).toEqual({ kind: "fetchNew" });
    expect(notificationForFinishedTask(task({ operation: "merge", status: "failed" }))).toEqual({ kind: "failed" });
  });

  it("stays quiet for everything else", () => {
    expect(notificationForFinishedTask(task({ operation: "fetch", logs: ["git fetch --progress"] }))).toBeUndefined();
    expect(notificationForFinishedTask(task({ operation: "commit" }))).toBeUndefined();
    expect(notificationForFinishedTask(task({ operation: "push", status: "cancelled" }))).toBeUndefined();
    expect(notificationForFinishedTask(task({ operation: "fetchBackground", status: "failed" }))).toBeUndefined();
  });

  it("recognises the lines fetch prints for moved refs", () => {
    for (const line of [" * [new branch]      feature    -> origin/feature", " * [new tag]         v1         -> v1", " + 1a2b3c4...5d6e7f8 main       -> origin/main  (forced update)", "   1a2b3c4..5d6e7f8  main       -> origin/main"]) {
      expect(fetchBroughtNewRefs({ logs: [line] }), line).toBe(true);
    }
    expect(fetchBroughtNewRefs({ logs: ["git fetch --progress", "Fetching origin"] })).toBe(false);
  });
});

describe("raising notifications", () => {
  function setup(initial: TaskSnapshotResponse[], options: { focused?: boolean; notify?: boolean } = {}) {
    const notify = vi.fn<(request: TaskNotificationRequest) => void>();
    const hook = renderHook((tasks: TaskSnapshotResponse[]) => useTaskNotifications({
      tasks,
      repositoryName: (id) => (id === "repo_a" ? "my-project" : undefined),
      notify: options.notify === false ? undefined : notify,
      windowFocused: () => options.focused ?? false,
    }), { initialProps: initial });
    return { notify, ...hook };
  }

  it("announces a task that ends while the window is in the background", () => {
    const { notify, rerender } = setup([task({ status: "running" })]);
    rerender([task({ status: "succeeded" })]);
    expect(notify).toHaveBeenCalledWith({ title: "Push finished", body: "Your commits were pushed · my-project", repoId: "repo_a", taskId: "t1" });
  });

  it("says nothing while the window is in front", () => {
    const { notify, rerender } = setup([task({ status: "running" })], { focused: true });
    rerender([task({ status: "succeeded" })]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("says nothing for tasks that ended before the app looked, or that it never saw running", () => {
    const { notify, rerender } = setup([task({ taskId: "old", status: "succeeded" })]);
    rerender([task({ taskId: "old", status: "succeeded" }), task({ taskId: "late", status: "succeeded" })]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("announces each ending once", () => {
    const { notify, rerender } = setup([task({ status: "running" })]);
    rerender([task({ status: "succeeded" })]);
    rerender([task({ status: "succeeded" })]);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("is switched off by the setting, and does nothing outside the desktop app", () => {
    setNotificationsEnabled(false);
    const off = setup([task({ status: "running" })]);
    off.rerender([task({ status: "succeeded" })]);
    expect(off.notify).not.toHaveBeenCalled();
    setNotificationsEnabled(true);
    const noBridge = setup([task({ status: "running" })], { notify: false });
    expect(() => noBridge.rerender([task({ status: "succeeded" })])).not.toThrow();
  });

  it("never puts task text or a URL in the notification", () => {
    const secret = "https://user:hunter2@example.com/org/repo.git";
    const { notify, rerender } = setup([task({ operation: "pull", status: "running" })]);
    rerender([task({ operation: "pull", status: "failed", message: `fatal: unable to access '${secret}'`, logs: [`remote: ${secret}`] })]);
    const request = notify.mock.calls[0][0];
    expect(JSON.stringify(request)).not.toContain("hunter2");
    expect(JSON.stringify(request)).not.toContain("https://");
    expect(request.title).toBe("A Git task failed");
  });
});

describe("notification setting", () => {
  it("is on by default and remembers a change", () => {
    expect(getNotificationsEnabled()).toBe(true);
    setNotificationsEnabled(false);
    expect(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY)).toBe("off");
    resetNotificationPreferenceCache();
    expect(getNotificationsEnabled()).toBe(false);
  });

  it("is a checkbox in the desktop app and explains itself elsewhere", () => {
    Object.defineProperty(window, "gitcrest", { configurable: true, value: { showNotification: vi.fn() } });
    const { unmount } = render(<NotificationSettings />);
    const box = screen.getByLabelText("Notify me when a task ends") as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(getNotificationsEnabled()).toBe(false);
    unmount();

    Reflect.deleteProperty(window, "gitcrest");
    render(<NotificationSettings />);
    expect((screen.getByLabelText("Notify me when a task ends") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("Opening other programs works in the GitCrest desktop app.")).toBeTruthy();
  });
});
