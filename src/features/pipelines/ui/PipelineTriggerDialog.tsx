import { useEffect, useState } from "react";
import { GitCrestApiError, type GitCrestApiClient } from "../../../api/client";
import { useDialogFocus } from "../../../shared/hooks/use-dialog-focus";
import { useI18n } from "../../../shared/i18n";
import { dismissPipelineTrigger, type PipelineTriggerPrompt } from "../model/pipeline-store";
import { isProtectedTarget } from "../model/rule-form";

/** A rule with confirmation "ask" fired after a push: choose the targets and run, or leave it queued. */
export function PipelineTriggerDialog({ api, prompt }: { api: GitCrestApiClient; prompt: PipelineTriggerPrompt }) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<string[]>(prompt.targets);
  const [mode, setMode] = useState<"temporaryWorktree" | "switchInPlace">();
  const [dontAsk, setDontAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const anyProtected = prompt.protectedTarget || prompt.targets.some(isProtectedTarget);
  const notNow = () => dismissPipelineTrigger(prompt.runId);
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(notNow, busy);

  useEffect(() => {
    let cancelled = false;
    void api.getPipelineRepositorySettings(prompt.repoId).then((settings) => {
      if (!cancelled) setMode(settings.effectiveExecutionMode);
    }, () => {});
    return () => { cancelled = true; };
  }, [api, prompt.repoId]);

  async function run() {
    if (busy || selected.length === 0) return;
    setBusy(true);
    setError("");
    try {
      if (dontAsk && !anyProtected) {
        const rules = await api.listPipelineRules(prompt.repoId);
        await api.replacePipelineRules(prompt.repoId, rules.map((rule) => rule.ruleId === prompt.ruleId ? { ...rule, confirmation: "auto" } : rule));
      }
      await api.startPipelineRun(prompt.repoId, { runId: prompt.runId, ...(selected.length === prompt.targets.length ? {} : { targets: selected }) });
      dismissPipelineTrigger(prompt.runId);
    } catch (reason) {
      setError(reason instanceof GitCrestApiError ? reason.body.error.message : reason instanceof Error ? reason.message : t("pl.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  return <div className="paletteBackdrop" role="presentation">
    <section ref={dialogRef} className="taskCenter workflowDialog" role="dialog" aria-modal="true" aria-labelledby="pipeline-trigger-title" onKeyDown={onKeyDown}>
      <div className="taskCenterHeader"><div><p className="sectionEyebrow">{t("pl.conflictAborted.eyebrow")}</p><h2 id="pipeline-trigger-title">{t("pl.trigger.title", { branch: prompt.sourceBranch })}</h2></div></div>
      <div className="workflowDialogBody">
        <p className="cloneHelp">{t("pl.trigger.body", { rule: prompt.ruleName })}</p>
        <fieldset className="pipelineTargets">
          <legend>{t("pl.trigger.targets")}</legend>
          {prompt.targets.map((target) => <label key={target} className="settingsCheck">
            <input type="checkbox" checked={selected.includes(target)} disabled={busy} onChange={(event) => setSelected(prompt.targets.filter((name) => name === target ? event.target.checked : selected.includes(name)))} />
            <span className="monoText">{target}</span>
            {isProtectedTarget(target) && <small className="cloneHelp">{t("pl.trigger.protected")}</small>}
          </label>)}
        </fieldset>
        {mode && <p className="cloneHelp" role="status">{mode === "temporaryWorktree" ? t("pl.trigger.modeWorktree") : t("pl.trigger.modeInPlace")}</p>}
        {!anyProtected && <label className="settingsCheck"><input type="checkbox" checked={dontAsk} disabled={busy} onChange={(event) => setDontAsk(event.target.checked)} />{t("pl.trigger.dontAsk")}</label>}
        {error && <p className="taskCenterError" role="alert">{error}</p>}
        <div className="taskCenterActions">
          <button className="quietButton compact" type="button" disabled={busy} onClick={notNow}>{t("pl.trigger.notNow")}</button>
          <button className="primaryButton" type="button" disabled={busy || selected.length === 0} onClick={() => void run()}>{busy ? t("pl.trigger.starting") : t("pl.trigger.run")}</button>
        </div>
      </div>
    </section>
  </div>;
}
