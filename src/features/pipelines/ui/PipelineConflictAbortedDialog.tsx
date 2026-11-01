import { Button } from "../../../shared/ui/Button";
import { Dialog, DialogHeader, DialogFooter } from "../../../shared/ui/Dialog";
import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { useState } from "react";
import { type GitCrestApiClient } from "../../../api/client";
import { useI18n } from "../../../shared/i18n";
import { dismissPipelineConflictPrompt, type PipelineConflictPrompt } from "../model/pipeline-store";

/** Asked when the merge of a pipeline target was aborted: skip that target or stop the whole run. */
export function PipelineConflictAbortedDialog({ api, prompt }: { api: GitCrestApiClient; prompt: PipelineConflictPrompt }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DisplayError>("");
  const later = () => dismissPipelineConflictPrompt(prompt.runId);

  async function choose(action: "skipTarget" | "stop") {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api.actOnPipelineRun(prompt.repoId, prompt.runId, action);
      dismissPipelineConflictPrompt(prompt.runId);
    } catch (reason) {
      setError(describeApiError(reason, t("pl.actionFailed")));
    } finally {
      setBusy(false);
    }
  }

  return <Dialog className="taskCenter workflowDialog" role="dialog" aria-labelledby="pipeline-aborted-title" onClose={later} busy={busy}>
      <DialogHeader className="taskCenterHeader"><div><h2 id="pipeline-aborted-title">{t("pl.conflictAborted.title", { target: prompt.targetBranch })}</h2></div></DialogHeader>
      <div className="workflowDialogBody">
        <p className="cloneHelp">{t("pl.conflictAborted.body", { target: prompt.targetBranch })}</p>
        {error && <p className="taskCenterError" role="alert"><ErrorMessage error={error} /></p>}
        <DialogFooter className="taskCenterActions">
          <Button variant="secondary" type="button" disabled={busy} onClick={later}>{t("pl.conflictAborted.later")}</Button>
          <Button variant="quiet" size="compact" type="button" disabled={busy} onClick={() => void choose("stop")}>{t("pl.conflictAborted.stop")}</Button>
          <Button variant="primary" type="button" disabled={busy} onClick={() => void choose("skipTarget")}>{t("pl.conflictAborted.skip")}</Button>
        </DialogFooter>
      </div>
    </Dialog>;
}
