import { useState } from "react";
import type { TaskSnapshotResponse } from "../../../api/client";

interface RemoteBranchDeleteSessionOptions {
  appendTask: (task: TaskSnapshotResponse) => void;
  clearTaskError: () => void;
}

export function useRemoteBranchDeleteSession({ appendTask, clearTaskError }: RemoteBranchDeleteSessionOptions) {
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
  }

  return { target, open, close, startTask };
}
