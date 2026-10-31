import { type CommitAction } from "../../features/commits";
import { type PushTarget } from "../../features/remotes";
import type { Shell } from "./use-app-shell";
import type { Connection } from "./use-app-connection";
import type { Repositories } from "./use-app-repositories";
import type { DiffArea } from "./use-app-diff";
import type { Work } from "./use-app-work";
import type { Navigation } from "./use-app-navigation";

export function useAppCommitActions(ctx: Shell & Connection & Repositories & DiffArea & Work & Navigation) {
  const { activeCommitAction, addCommitDiffSelection, canCommit, commitSubmission, diffState, rememberCommitAction, selectedRepository, setCommitActionMenuOpen, setPushTargetDialogOpen } = ctx;

  function runCommitAction(action: CommitAction) {
    if (action === "commitAndPushTo") {
      setPushTargetDialogOpen(true);
      return;
    }
    void commitChanges(action);
  }

  function chooseCommitAction(action: CommitAction) {
    rememberCommitAction(action);
    setCommitActionMenuOpen(false);
    runCommitAction(action);
  }

  function commitChanges(action: CommitAction = activeCommitAction, target?: PushTarget) {
    void commitSubmission.submit(action, canCommit, target);
  }

  function addDiffSelectionToCommit(selections: Array<{ hunkIndex: number; rowIndex?: number; side?: "old" | "new" }>) {
    const document = diffState.document;
    if (!selectedRepository || !document || document.scope !== "index") return;
    addCommitDiffSelection(document.path, document.revision, selections);
  }

  return { runCommitAction, chooseCommitAction, commitChanges, addDiffSelectionToCommit };
}

export type CommitActions = ReturnType<typeof useAppCommitActions>;
