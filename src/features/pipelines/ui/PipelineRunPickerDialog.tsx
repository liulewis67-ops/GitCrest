import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { useEffect, useState } from "react";
import { type GitCrestApiClient, type PipelineRule } from "../../../api/client";
import { useDialogFocus } from "../../../shared/hooks/use-dialog-focus";
import { useI18n } from "../../../shared/i18n";
import { isProtectedTarget } from "../model/rule-form";

export interface PipelineRunSource {
  branch: string;
  /** The pushed commit of the branch. */
  oid: string;
}

/** Why a branch cannot be run through a pipeline without pushing first; `undefined` when it can. */
export function pipelineRunBlocker(branch: { upstream: string | null; ahead: number | null; upstreamGone?: boolean }): "noUpstream" | "unpushed" | undefined {
  if (!branch.upstream || branch.upstreamGone) return "noUpstream";
  if (branch.ahead === null || branch.ahead > 0) return "unpushed";
  return undefined;
}

/** The current local branch as a pipeline source, with the reason it cannot run yet when it cannot. */
export function currentPipelineSource(snapshot: { branches: ReadonlyArray<{ kind: string; isCurrent: boolean; name: string; oid: string; upstream: string | null; ahead: number | null; upstreamGone?: boolean }> } | undefined): (PipelineRunSource & { blocker?: "noUpstream" | "unpushed" }) | undefined {
  const current = snapshot?.branches.find((branch) => branch.kind === "local" && branch.isCurrent);
  if (!current) return undefined;
  const blocker = pipelineRunBlocker(current);
  return { branch: current.name, oid: current.oid, ...(blocker ? { blocker } : {}) };
}

/** Runs one of the repository's rules for the pushed commit of a branch, without pushing. */
export function PipelineRunPickerDialog({ api, repoId, source, onClose }: {
  api: GitCrestApiClient;
  repoId: string;
  source: PipelineRunSource;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [rules, setRules] = useState<PipelineRule[]>();
  const [ruleId, setRuleId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DisplayError>("");
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(onClose, busy);
  const rule = rules?.find((candidate) => candidate.ruleId === ruleId);

  useEffect(() => {
    let cancelled = false;
    void api.listPipelineRules(repoId).then((loaded) => {
      if (cancelled) return;
      const usable = loaded.filter((candidate) => candidate.enabled);
      setRules(usable);
      setRuleId(usable[0]?.ruleId ?? "");
      setSelected(usable[0]?.targets.map((target) => target.branch) ?? []);
    }, (reason: unknown) => {
      if (!cancelled) {
        setRules([]);
        setError(describeApiError(reason, t("pl.loadFailed")));
      }
    });
    return () => { cancelled = true; };
  }, [api, repoId]);

  function choose(nextId: string) {
    setRuleId(nextId);
    setSelected(rules?.find((candidate) => candidate.ruleId === nextId)?.targets.map((target) => target.branch) ?? []);
  }

  async function run() {
    if (!rule || busy || selected.length === 0) return;
    setBusy(true);
    setError("");
    try {
      await api.startPipelineRun(repoId, {
        ruleId: rule.ruleId,
        sourceBranch: source.branch,
        sourceOid: source.oid,
        ...(selected.length === rule.targets.length ? {} : { targets: selected }),
      });
      onClose();
    } catch (reason) {
      setError(describeApiError(reason, t("pl.actionFailed")));
    } finally {
      setBusy(false);
    }
  }

  return <div className="paletteBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={dialogRef} className="taskCenter workflowDialog" role="dialog" aria-modal="true" aria-labelledby="pipeline-picker-title" onKeyDown={onKeyDown}>
      <div className="taskCenterHeader"><div><p className="sectionEyebrow">{t("pl.conflictAborted.eyebrow")}</p><h2 id="pipeline-picker-title">{t("pl.picker.title", { branch: source.branch })}</h2></div><button className="quietButton compact" type="button" disabled={busy} onClick={onClose}>{t("pl.editor.cancel")}</button></div>
      <div className="workflowDialogBody">
        {rules === undefined && <p role="status">{t("wf.checking")}</p>}
        {rules && rules.length === 0 && <p className="cloneHelp">{t("pl.picker.noRules")}</p>}
        {rules && rules.length > 0 && <>
          <label>{t("pl.picker.rule")}
            <select value={ruleId} disabled={busy} onChange={(event) => choose(event.target.value)}>
              {rules.map((candidate) => <option key={candidate.ruleId} value={candidate.ruleId}>{candidate.name}</option>)}
            </select>
          </label>
          {rule && <fieldset className="pipelineTargets">
            <legend>{t("pl.trigger.targets")}</legend>
            {rule.targets.map((target) => <label key={target.branch} className="settingsCheck">
              <input type="checkbox" checked={selected.includes(target.branch)} disabled={busy} onChange={(event) => setSelected(rule.targets.map((candidate) => candidate.branch).filter((name) => name === target.branch ? event.target.checked : selected.includes(name)))} />
              <span className="monoText">{target.branch}</span>
              {isProtectedTarget(target.branch) && <small className="cloneHelp">{t("pl.trigger.protected")}</small>}
            </label>)}
          </fieldset>}
          <p className="cloneHelp">{t("pl.picker.help", { commit: source.oid.slice(0, 12) })}</p>
        </>}
        {error && <p className="taskCenterError" role="alert"><ErrorMessage error={error} /></p>}
        <div className="taskCenterActions">
          <button className="primaryButton" type="button" disabled={!rule || busy || selected.length === 0} onClick={() => void run()}>{busy ? t("pl.trigger.starting") : t("pl.trigger.run")}</button>
        </div>
      </div>
    </section>
  </div>;
}
