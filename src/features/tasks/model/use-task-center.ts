import { useEffect, useRef, useState } from "react";
import type { GitCrestApiClient, TaskSnapshotResponse } from "../../../api/client";

export function useTaskCenter(getApi: () => GitCrestApiClient | undefined) {
  const [tasks, setTasks] = useState<TaskSnapshotResponse[]>([]);
  const [error, setError] = useState("");
  const [actionId, setActionId] = useState("");
  const refreshControllerRef = useRef<AbortController>();
  const refreshGenerationRef = useRef(0);

  useEffect(() => () => {
    refreshGenerationRef.current += 1;
    refreshControllerRef.current?.abort();
    refreshControllerRef.current = undefined;
  }, []);

  async function refresh() {
    const api = getApi();
    if (!api) return;
    refreshControllerRef.current?.abort();
    const controller = new AbortController();
    const generation = ++refreshGenerationRef.current;
    refreshControllerRef.current = controller;
    try {
      const currentTasks = await api.withSignal(controller.signal).listTasks();
      if (!controller.signal.aborted && refreshGenerationRef.current === generation) {
        setTasks(currentTasks);
        setError("");
      }
    } catch (reason) {
      if (!controller.signal.aborted && refreshGenerationRef.current === generation) {
        setError(reason instanceof Error ? reason.message : "Could not read task history.");
      }
    } finally {
      if (refreshControllerRef.current === controller) refreshControllerRef.current = undefined;
    }
  }

  async function cancel(taskId: string) {
    const api = getApi();
    if (!api) return;
    setActionId(taskId);
    try {
      await api.cancelTask(taskId);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not request task cancellation.");
    } finally {
      setActionId("");
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
    actionId,
    setActionId,
    refresh,
    cancel,
    prependTask,
    appendTask,
  };
}
