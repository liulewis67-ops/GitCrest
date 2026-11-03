import { Button } from "../../../shared/ui/Button";
import { Dialog, DialogHeader, DialogFooter } from "../../../shared/ui/Dialog";
import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { useEffect, useState } from "react";
import { type GitCrestApiClient } from "../../../api/client";
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
  const [error, setError] = useState<DisplayError>("");
  const anyProtected = prompt.protectedTarget || prompt.targets.some(isProtectedTarget);
  const notNow = () => dismissPipelineTrigger(prompt.runId);

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
      setError(describeApiError(reason, t("pl.actionFailed")));
    } finally {
      setBusy(false);
    }
  }

  return <Dialog className="taskCenter workflowDialog" role="dialog" aria-labelledby="pipeline-trigger-title" onClose={notNow} busy={busy}>
      <DialogHeader className="taskCenterHeader"><div><h2 id="pipeline-trigger-title">{t("pl.trigger.title", { branch: prompt.sourceBranch })}</h2></div></DialogHeader>
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
        {prompt.commandDescriptions?.map((description, index) => <p key={index} className="cloneHelp monoText">{description}</p>)}
        {mode && prompt.targets.length > (prompt.commandDescriptions?.length ?? 0) && <p className="cloneHelp" role="status">{mode === "temporaryWorktree" ? t("pl.trigger.modeWorktree") : t("pl.trigger.modeInPlace")}</p>}
        {!anyProtected && <label className="settingsCheck"><input type="checkbox" checked={dontAsk} disabled={busy} onChange={(event) => setDontAsk(event.target.checked)} />{t("pl.trigger.dontAsk")}</label>}
        {error && <p className="taskCenterError" role="alert"><ErrorMessage error={error} /></p>}
        <DialogFooter className="taskCenterActions">
          <Button variant="secondary" type="button" disabled={busy} onClick={notNow}>{t("pl.trigger.notNow")}</Button>
          <Button variant="primary" type="button" disabled={busy || selected.length === 0} onClick={() => void run()}>{busy ? t("pl.trigger.starting") : t("pl.trigger.run")}</Button>
        </DialogFooter>
      </div>
    </Dialog>;
}
