import { useEffect, useRef } from "react";

interface TaskRefreshCallbacks {
  activeRepositoryId?: string;
  refreshTasks: () => Promise<void>;
  refreshRepositoryStatus: (repoId: string) => Promise<void>;
  refreshRepositoryBranches: (repoId: string) => Promise<void>;
  refreshHistory: () => void;
}

interface TaskRefreshLifecycleOptions extends TaskRefreshCallbacks {
  taskCenterOpen: boolean;
  hasActiveTasks: boolean;
}

export function useTaskRefreshLifecycle({
  taskCenterOpen,
  hasActiveTasks,
  ...callbacks
}: TaskRefreshLifecycleOptions) {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const hasActiveTasksRef = useRef(hasActiveTasks);
  hasActiveTasksRef.current = hasActiveTasks;

  useEffect(() => {
    if (taskCenterOpen) void callbacksRef.current.refreshTasks();
    const timer = window.setInterval(() => {
      if (taskCenterOpen || hasActiveTasksRef.current) void callbacksRef.current.refreshTasks();
    }, 1000);
    return () => window.clearInterval(timer);
  }, [taskCenterOpen]);

  useEffect(() => {
    const refreshAfterChildWindow = () => {
      const current = callbacksRef.current;
      void current.refreshTasks();
      if (!current.activeRepositoryId) return;
      void current.refreshRepositoryStatus(current.activeRepositoryId);
      void current.refreshRepositoryBranches(current.activeRepositoryId);
      current.refreshHistory();
    };
    window.addEventListener("focus", refreshAfterChildWindow);
    return () => window.removeEventListener("focus", refreshAfterChildWindow);
  }, [callbacks.activeRepositoryId]);
}
