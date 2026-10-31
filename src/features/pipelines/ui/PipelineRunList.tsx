import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { useEffect, useState } from "react";
import {
  type GitCrestApiClient,
  type PipelineRunActionKind,
  type PipelineRunResponse,
  type PipelineRunStepResponse,
} from "../../../api/client";
import { useI18n } from "../../../shared/i18n";
import { replacePipelineRuns, usePipelineState } from "../model/pipeline-store";

const STEP_MARK: Record<PipelineRunStepResponse["state"], string> = {
  pending: "·",
  preparing: "…",
  merging: "…",
  waitingForConflicts: "⚠",
  pushing: "…",
  finishing: "…",
  done: "✓",
  upToDate: "=",
  skipped: "–",
  failed: "✗",
};

const ACTIVE: ReadonlySet<PipelineRunResponse["status"]> = new Set(["pendingConfirmation", "running", "waitingForConflicts", "interrupted"]);

/** Pipeline runs of the open repository as grouped rows, with the actions their state allows. */
export function PipelineRunList({ api, repoId, onOpenConflicts }: {
  api: GitCrestApiClient;
  repoId: string;
  /** Opens the conflict window of the step whose hidden context is `repoContext`. */
  onOpenConflicts: (repoContext: string) => void;
}) {
  const { t } = useI18n();
  const state = usePipelineState();
  const [busyRun, setBusyRun] = useState("");
  const [error, setError] = useState<DisplayError>("");
  const runs = Object.values(state.runs)
    .filter((run) => run.repoId === repoId)
    .sort((a, b) => b.createdAtMs - a.createdAtMs);

  useEffect(() => {
    let cancelled = false;
    void api.listPipelineRuns(repoId).then((loaded) => { if (!cancelled && Array.isArray(loaded)) replacePipelineRuns(repoId, loaded); }, () => {});
    return () => { cancelled = true; };
  }, [api, repoId]);

  async function act(run: PipelineRunResponse, action: PipelineRunActionKind) {
    setBusyRun(run.runId);
    setError("");
    try {
      await api.actOnPipelineRun(repoId, run.runId, action);
    } catch (reason) {
      setError(describeApiError(reason, t("pl.actionFailed")));
    } finally {
      setBusyRun("");
    }
  }

  async function runAgain(run: PipelineRunResponse) {
    setBusyRun(run.runId);
    setError("");
    try {
      await api.startPipelineRun(repoId, { ruleId: run.ruleId, sourceBranch: run.sourceBranch, sourceOid: run.sourceOid });
    } catch (reason) {
      setError(describeApiError(reason, t("pl.actionFailed")));
    } finally {
      setBusyRun("");
    }
  }

  if (runs.length === 0) return null;
  return <section className="pipelineRuns" aria-label={t("pl.runs.title")}>
    <h3>{t("pl.runs.title")}</h3>
    {error && <p className="taskCenterError" role="alert"><ErrorMessage error={error} /></p>}
    {runs.map((run) => {
      const waiting = run.steps.find((step) => step.state === "waitingForConflicts");
      const busy = busyRun === run.runId;
      const button = (label: string, action: PipelineRunActionKind, primary = false) => (
        <button key={action} className={primary ? "secondaryButton" : "quietButton compact"} type="button" disabled={busy} onClick={() => void act(run, action)}>{label}</button>
      );
      return <article className="taskCard pipelineRun" key={run.runId} aria-label={run.ruleName}>
        <div className="taskCardHeading">
          <strong>{run.sourceBranch}{run.steps.map((step) => ` → ${step.targetBranch} ${STEP_MARK[step.state]}`).join("")}</strong>
          <span className={`taskStatus task-${run.status}`} role="status">{t(`pl.runs.status.${run.status}`)}</span>
        </div>
        <div className="taskCardMeta"><span>{run.ruleName}</span><span>{run.executionMode === "temporaryWorktree" ? t("pl.runs.worktree") : t("pl.runs.inPlace")}</span></div>
        {run.shelfPending && <p className="taskCenterError" role="note">{t("pl.runs.shelfPending")}</p>}
        <details>
          <summary>{t("pl.runs.steps", { count: run.steps.length })}</summary>
          <ul className="pipelineRunSteps">
            {run.steps.map((step) => <li key={step.position}>
              <span className="monoText">{step.remote}/{step.targetBranch}</span> · {t(`pl.runs.step.${step.state}`)}
              {step.message && <small className="cloneHelp"> — {step.message}</small>}
            </li>)}
          </ul>
        </details>
        <div className="taskCenterActions">
          {run.status === "pendingConfirmation" && button(t("pl.runs.run"), "resume", true)}
          {run.status === "waitingForConflicts" && waiting?.repoContext && <button className="secondaryButton" type="button" onClick={() => onOpenConflicts(waiting.repoContext!)}>{t("pl.runs.resolve")}</button>}
          {run.status === "waitingForConflicts" && button(t("pl.runs.skipTarget"), "skipTarget")}
          {run.status === "waitingForConflicts" && button(t("pl.runs.stop"), "stop")}
          {run.status === "interrupted" && run.recovery === "resumePush" && button(t("pl.runs.pushMerge"), "resume", true)}
          {run.status === "interrupted" && run.recovery === "restartStep" && button(t("pl.runs.restartStep"), "resume", true)}
          {run.status === "interrupted" && run.recovery === "returnToSource" && button(t("pl.runs.returnToSource", { branch: run.sourceBranch }), "returnToSource", true)}
          {run.status === "interrupted" && button(run.recovery === "returnToSource" ? t("pl.runs.stay") : t("pl.runs.discard"), "discard")}
          {!ACTIVE.has(run.status) && run.status !== "succeeded" && <button className="quietButton compact" type="button" disabled={busy} onClick={() => void runAgain(run)}>{t("pl.runs.again")}</button>}
        </div>
      </article>;
    })}
  </section>;
}
