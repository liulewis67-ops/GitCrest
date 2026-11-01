import { Button } from "../../../shared/ui/Button";
import { Dialog, DialogHeader, DialogFooter } from "../../../shared/ui/Dialog";
import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { useState } from "react";
import { type GitCrestApiClient } from "../../../api/client";
import { useI18n } from "../../../shared/i18n";
import { dismissPipelineWorkspaceFailure, type PipelineWorkspaceFailure } from "../model/pipeline-store";

/**
 * The temporary worktree could not be used. GitCrest never switches to the user's own working tree
 * on its own, so the choice is offered here: once, for always, or not at all.
 */
export function PipelineWorkspaceFailureDialog({ api, failure }: { api: GitCrestApiClient; failure: PipelineWorkspaceFailure }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DisplayError>("");
  const cancel = () => dismissPipelineWorkspaceFailure(failure.runId);

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
      setError(describeApiError(reason, t("pl.actionFailed")));
    } finally {
      setBusy(false);
    }
  }

  return <Dialog className="taskCenter workflowDialog" role="dialog" aria-labelledby="pipeline-workspace-title" onClose={cancel} busy={busy}>
      <DialogHeader className="taskCenterHeader"><div><h2 id="pipeline-workspace-title">{t("pl.workspace.title")}</h2></div></DialogHeader>
      <div className="workflowDialogBody">
        <p className="cloneHelp">{t("pl.workspace.body")}</p>
        {failure.message && <p className="taskMessage">{failure.message}</p>}
        <p className="cloneHelp">{t("pl.workspace.warning")}</p>
        {error && <p className="taskCenterError" role="alert"><ErrorMessage error={error} /></p>}
        <DialogFooter className="taskCenterActions">
          <Button variant="secondary" type="button" disabled={busy} onClick={cancel}>{t("pl.workspace.cancel")}</Button>
          <Button variant="quiet" size="compact" type="button" disabled={busy} onClick={() => void runInPlace(true)}>{t("pl.workspace.always")}</Button>
          <Button variant="primary" type="button" disabled={busy} onClick={() => void runInPlace(false)}>{t("pl.workspace.once")}</Button>
        </DialogFooter>
      </div>
    </Dialog>;
}
