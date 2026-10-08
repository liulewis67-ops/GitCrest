import { useState } from "react";
import type { GitCrestApiClient, TaskSnapshotResponse } from "../../../api/client";

export function useTaskCenter(getApi: () => GitCrestApiClient | undefined) {
  const [tasks, setTasks] = useState<TaskSnapshotResponse[]>([]);
  const [error, setError] = useState("");

  async function refresh() {
    const api = getApi();
    if (!api) return;
    try {
      setTasks(await api.listTasks());
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not read task history.");
    }
  }

  function prependTask(task: TaskSnapshotResponse) {
    setTasks((current) => [task, ...current.filter((item) => item.taskId !== task.taskId)]);
  }

  function appendTask(task: TaskSnapshotResponse) {
    setTasks((current) => [...current.filter((item) => item.taskId !== task.taskId), task]);
  }

  return {
    tasks,
    error,
    setError,
    refresh,
    prependTask,
    appendTask,
  };
}
