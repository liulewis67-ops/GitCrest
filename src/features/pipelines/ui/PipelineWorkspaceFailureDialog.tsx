import { useState } from "react";
import { GitCrestApiError, type GitCrestApiClient } from "../../../api/client";
import { useDialogFocus } from "../../../shared/hooks/use-dialog-focus";
import { useI18n } from "../../../shared/i18n";
import { dismissPipelineWorkspaceFailure, type PipelineWorkspaceFailure } from "../model/pipeline-store";

/**
 * The temporary worktree could not be used. GitCrest never switches to the user's own working tree
 * on its own, so the choice is offered here: once, for always, or not at all.
 */
export function PipelineWorkspaceFailureDialog({ api, failure }: { api: GitCrestApiClient; failure: PipelineWorkspaceFailure }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const cancel = () => dismissPipelineWorkspaceFailure(failure.runId);
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(cancel, busy);

  async function runInPlace(always: boolean) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (always) {
        const current = await api.getPipelineRepositorySettings(failure.repoId);
        await api.setPipelineRepositorySettings(failure.repoId, { executionMode: "switchInPlace", inPlaceDirtyPolicy: current.inPlaceDirtyPolicy });
      }
      await api.startPipelineRun(failure.repoId, {
        ruleId: failure.ruleId,
        sourceBranch: failure.sourceBranch,
        sourceOid: failure.sourceOid,
        executionMode: "switchInPlace",
      });
      dismissPipelineWorkspaceFailure(failure.runId);
    } catch (reason) {
      setError(reason instanceof GitCrestApiError ? reason.body.error.message : reason instanceof Error ? reason.message : t("pl.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  return <div className="paletteBackdrop" role="presentation">
    <section ref={dialogRef} className="taskCenter workflowDialog" role="dialog" aria-modal="true" aria-labelledby="pipeline-workspace-title" onKeyDown={onKeyDown}>
      <div className="taskCenterHeader"><div><p className="sectionEyebrow">{t("pl.conflictAborted.eyebrow")}</p><h2 id="pipeline-workspace-title">{t("pl.workspace.title")}</h2></div></div>
      <div className="workflowDialogBody">
        <p className="cloneHelp">{t("pl.workspace.body")}</p>
        {failure.message && <p className="taskMessage">{failure.message}</p>}
        <p className="cloneHelp">{t("pl.workspace.warning")}</p>
        {error && <p className="taskCenterError" role="alert">{error}</p>}
        <div className="taskCenterActions">
          <button className="quietButton compact" type="button" disabled={busy} onClick={cancel}>{t("pl.workspace.cancel")}</button>
          <button className="quietButton compact" type="button" disabled={busy} onClick={() => void runInPlace(true)}>{t("pl.workspace.always")}</button>
          <button className="primaryButton" type="button" disabled={busy} onClick={() => void runInPlace(false)}>{t("pl.workspace.once")}</button>
        </div>
      </div>
    </section>
  </div>;
}
