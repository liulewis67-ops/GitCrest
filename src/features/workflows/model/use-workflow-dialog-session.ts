import { useState } from "react";
import type { TaskSnapshotResponse } from "../../../api/client";
import type { WorkflowAction } from "../WorkflowDialog";

interface WorkflowDialogContext {
  repoId: string;
  targetOid: string;
  action: WorkflowAction;
}

interface WorkflowDialogSessionOptions {
  appendTask: (task: TaskSnapshotResponse) => void;
  setTaskError: (message: string) => void;
  openTaskCenter: () => void;
}

export function useWorkflowDialogSession({ appendTask, setTaskError, openTaskCenter }: WorkflowDialogSessionOptions) {
  const [context, setContext] = useState<WorkflowDialogContext>();
  const [rebaseOpen, setRebaseOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  function open(repoId: string, targetOid: string, action: WorkflowAction) {
    setContext({ repoId, targetOid, action });
  }

  function close() {
    setContext(undefined);
  }

  function openRebase() {
    setRebaseOpen(true);
  }

  function closeRebase() {
    setRebaseOpen(false);
  }

  function openReset() {
    setResetOpen(true);
  }

  function closeReset() {
    setResetOpen(false);
  }

  function startTask(task: TaskSnapshotResponse) {
    appendTask(task);
    close();
    setTaskError("");
    openTaskCenter();
  }

  return { context, open, close, rebaseOpen, openRebase, closeRebase, resetOpen, openReset, closeReset, startTask };
}
