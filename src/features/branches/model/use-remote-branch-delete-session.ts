import { useState } from "react";
import type { TaskSnapshotResponse } from "../../../api/client";

interface RemoteBranchDeleteSessionOptions {
  appendTask: (task: TaskSnapshotResponse) => void;
  clearTaskError: () => void;
  openTaskCenter: () => void;
}

export function useRemoteBranchDeleteSession({ appendTask, clearTaskError, openTaskCenter }: RemoteBranchDeleteSessionOptions) {
  const [target, setTarget] = useState<string>();

  function open(branchRef: string) {
    setTarget(branchRef);
  }

  function close() {
    setTarget(undefined);
  }

  function startTask(task: TaskSnapshotResponse) {
    appendTask(task);
    close();
    clearTaskError();
    openTaskCenter();
  }

  return { target, open, close, startTask };
}
