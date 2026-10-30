import { useState } from "react";
import type { TaskSnapshotResponse } from "../../../api/client";
import type { WorkflowAction } from "./workflow-action";

interface WorkflowDialogContext {
  repoId: string;
  targetOid: string;
  action: WorkflowAction;
  targetLabel?: string;
}

interface WorkflowDialogSessionOptions {
  appendTask: (task: TaskSnapshotResponse) => void;
  setTaskError: (message: string) => void;
  openTaskCenter: () => void;
}

export function useWorkflowDialogSession({ appendTask, setTaskError, openTaskCenter }: WorkflowDialogSessionOptions) {
  const [context, setContext] = useState<WorkflowDialogContext>();
  const [rebaseOpen, setRebaseOpen] = useState(false);
  /** The branch tip the rebase dialog starts on; undefined lets the dialog choose. */
  const [rebaseOnto, setRebaseOnto] = useState<string>();
  const [resetOpen, setResetOpen] = useState(false);
  const [resetTargetOid, setResetTargetOid] = useState<string>();

  function open(repoId: string, targetOid: string, action: WorkflowAction, targetLabel?: string) {
    setContext({ repoId, targetOid, action, targetLabel });
  }

  function close() {
    setContext(undefined);
  }

  function openRebase() {
    setRebaseOnto(undefined);
    setRebaseOpen(true);
  }

  function openRebaseOnto(oid: string) {
    setRebaseOnto(oid);
    setRebaseOpen(true);
  }

  function closeRebase() {
    setRebaseOpen(false);
  }

  function openReset(targetOid?: string) {
    setResetTargetOid(targetOid);
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

  return { context, open, close, rebaseOpen, rebaseOnto, openRebase, openRebaseOnto, closeRebase, resetOpen, resetTargetOid, openReset, closeReset, startTask };
}
