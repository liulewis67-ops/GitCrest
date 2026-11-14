import { useEffect, useRef } from "react";
import type { TaskSnapshotResponse } from "../../../api/client";
import { t } from "../../../shared/i18n";
import { getNotificationsEnabled } from "./notification-preferences";
import { notificationForFinishedTask, type TaskNotificationText } from "./task-notification";

export interface TaskNotificationRequest {
  title: string;
  body: string;
  repoId?: string;
  taskId: string;
}

interface TaskNotificationOptions {
  tasks: TaskSnapshotResponse[];
  /** The display name of a repository, or nothing when it is unknown. */
  repositoryName: (repoId: string) => string | undefined;
  /** Shows a system notification; absent outside the desktop app. */
  notify?: (request: TaskNotificationRequest) => void;
  /** The window is in front, so the user can see the task finish themselves. */
  windowFocused?: () => boolean;
}

function textFor(kind: TaskNotificationText["kind"], name: string | undefined): { title: string; body: string } {
  const where = name ? ` — ${name}` : "";
  switch (kind) {
    case "pushDone": return { title: t("notify.pushDone"), body: `${t("notify.pushBody")}${where}` };
    case "pullDone": return { title: t("notify.pullDone"), body: `${t("notify.pullBody")}${where}` };
    case "cloneDone": return { title: t("notify.cloneDone"), body: `${t("notify.cloneBody")}${where}` };
    case "fetchNew": return { title: t("notify.fetchNew"), body: `${t("notify.fetchBody")}${where}` };
    case "failed": return { title: t("notify.failed"), body: `${t("notify.failedBody")}${where}` };
  }
}

/**
 * Raises a system notification when a long task ends while the window is not in front. The text is
 * fixed per kind plus the repository's name, so a URL or credential in a task's log never reaches it.
 */
export function useTaskNotifications({ tasks, repositoryName, notify, windowFocused = () => document.hasFocus() }: TaskNotificationOptions) {
  const statuses = useRef<Map<string, TaskSnapshotResponse["status"]> | null>(null);
  const latest = useRef({ repositoryName, notify, windowFocused });
  latest.current = { repositoryName, notify, windowFocused };

  useEffect(() => {
    const previous = statuses.current;
    statuses.current = new Map(tasks.map((task) => [task.taskId, task.status]));
    // The first list only records what already ended; nothing from before the app started is announced.
    if (!previous) return;
    const { notify: show, repositoryName: nameOf, windowFocused: focused } = latest.current;
    if (!show || !getNotificationsEnabled() || focused()) return;
    for (const task of tasks) {
      const before = previous.get(task.taskId);
      const wasRunning = before === "queued" || before === "running" || before === "waitingForInput";
      // A task that was never seen unfinished (such as one loaded late) is not announced.
      if (!wasRunning || task.status === before) continue;
      const message = notificationForFinishedTask(task);
      if (!message) continue;
      const text = textFor(message.kind, task.repoId ? nameOf(task.repoId) : undefined);
      show({ ...text, repoId: task.repoId ?? undefined, taskId: task.taskId });
    }
  }, [tasks]);
}
