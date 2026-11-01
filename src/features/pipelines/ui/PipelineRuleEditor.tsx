import { Icon as UiIcon } from "../../../shared/ui/Icon";
import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { type DisplayError } from "../../../shared/i18n/api-errors";
import { useMemo, useState } from "react";
import type { PipelineRule } from "../../../api/client";
import { useI18n } from "../../../shared/i18n";
import {
  effectiveConfirmation,
  globMatch,
  hasProtectedTarget,
  isProtectedTarget,
  moveItem,
  renderCommitMessage,
  validateRule,
  type PipelineRuleIssue,
} from "../model/rule-form";

export interface RemoteBranchChoice {
  remote: string;
  branch: string;
}

function issueText(issue: PipelineRuleIssue, t: ReturnType<typeof useI18n>["t"]): string {
  switch (issue.code) {
    case "name": return t("pl.issue.name");
    case "pattern": return t("pl.issue.pattern");
    case "noTargets": return t("pl.issue.noTargets");
    case "emptyTarget": return t("pl.issue.emptyTarget");
    case "duplicateTarget": return t("pl.issue.duplicateTarget", { branch: issue.branch });
    case "targetMatchesTrigger": return t("pl.issue.targetMatchesTrigger", { branch: issue.branch });
    case "unknownPlaceholder": return t("pl.issue.unknownPlaceholder", { name: issue.name });
    case "unbalancedTemplate": return t("pl.issue.unbalancedTemplate");
    case "duplicateRuleId": return t("pl.issue.duplicateRuleId");
  }
}

/** Edits one pipeline rule with live previews; Save is offered only for a rule the core accepts. */
export function PipelineRuleEditor({ rule, otherRules, localBranches, remoteBranches, saving, error, onSave, onCancel }: {
  rule: PipelineRule;
  otherRules: readonly PipelineRule[];
  localBranches: readonly string[];
  remoteBranches: readonly RemoteBranchChoice[];
  saving?: boolean;
  error?: DisplayError;
  onSave: (rule: PipelineRule) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<PipelineRule>(rule);
  const [chosen, setChosen] = useState("");
  const [touched, setTouched] = useState(false);
  const issue = validateRule(draft, otherRules);
  const matches = useMemo(
    () => localBranches.filter((name) => draft.trigger.branchPattern && globMatch(draft.trigger.branchPattern, name)).slice(0, 5),
    [localBranches, draft.trigger.branchPattern],
  );
  const protectedTargets = draft.targets.filter((target) => isProtectedTarget(target.branch));
  const forcedAsk = hasProtectedTarget(draft);
  const available = remoteBranches.filter((choice) => !draft.targets.some((target) => target.remote === choice.remote && target.branch === choice.branch));
  const sampleSource = matches[0] ?? "feature/1";
  const sampleTarget = draft.targets[0]?.branch ?? "uat";
  const update = (changes: Partial<PipelineRule>) => { setTouched(true); setDraft((current) => ({ ...current, ...changes })); };

  function addTarget() {
    const picked = available.find((choice) => `${choice.remote}/${choice.branch}` === chosen);
    if (!picked) return;
    update({ targets: [...draft.targets, picked] });
    setChosen("");
  }

  return <form className="pipelineRuleEditor" aria-label={t("pl.editor.title")} onSubmit={(event) => { event.preventDefault(); if (!issue) onSave({ ...draft, confirmation: effectiveConfirmation(draft) }); }}>
    <label>{t("pl.editor.name")}
      <input value={draft.name} onChange={(event) => update({ name: event.target.value })} />
    </label>
    <label>{t("pl.editor.pattern")}
      <input className="monoText" value={draft.trigger.branchPattern} onChange={(event) => update({ trigger: { ...draft.trigger, branchPattern: event.target.value } })} />
    </label>
    <p className="cloneHelp">{t("pl.editor.patternHelp")}</p>
    <p className="cloneHelp" role="status">{matches.length > 0 ? t("pl.editor.matches", { names: matches.join(", ") }) : t("pl.editor.matchesNone")}</p>

    <fieldset className="pipelineTargets">
      <legend>{t("pl.editor.targets")}</legend>
      {draft.targets.length === 0 && <p className="cloneHelp">{t("pl.editor.noTargets")}</p>}
      <ol>
        {draft.targets.map((target, index) => <li key={`${target.remote}/${target.branch}`}>
          <span className="monoText">{target.remote}/{target.branch}</span>
          <button className="quietButton compact" type="button" disabled={index === 0} aria-label={t("pl.editor.moveTarget", { target: target.branch })} onClick={() => update({ targets: moveItem(draft.targets, index, index - 1) })}><UiIcon name="arrowUp" /></button>
          <button className="quietButton compact" type="button" aria-label={t("pl.editor.removeTarget", { target: target.branch })} onClick={() => update({ targets: draft.targets.filter((_, position) => position !== index) })}><UiIcon name="close" /></button>
        </li>)}
      </ol>
      <div className="pipelineAddTarget">
        <select aria-label={t("pl.editor.chooseTarget")} value={chosen} onChange={(event) => setChosen(event.target.value)}>
          <option value="">{t("pl.editor.chooseTarget")}</option>
          {available.map((choice) => <option key={`${choice.remote}/${choice.branch}`} value={`${choice.remote}/${choice.branch}`}>{choice.remote}/{choice.branch}</option>)}
        </select>
        <button className="secondaryButton" type="button" disabled={!chosen} onClick={addTarget}>{t("pl.editor.addTarget")}</button>
      </div>
      {protectedTargets.map((target) => <p className="cloneHelp" role="note" key={target.branch}>{t("pl.editor.protected", { target: target.branch })}</p>)}
    </fieldset>

    <label>{t("pl.editor.mergeMode")}
      <select value={draft.mergeMode} onChange={(event) => update({ mergeMode: event.target.value as PipelineRule["mergeMode"] })}>
        <option value="noFastForward">{t("pl.editor.mergeCommit")}</option>
        <option value="fastForwardIfPossible">{t("pl.editor.fastForward")}</option>
      </select>
    </label>
    <label>{t("pl.editor.message")}
      <input className="monoText" value={draft.commitMessageTemplate} onChange={(event) => update({ commitMessageTemplate: event.target.value })} />
    </label>
    <p className="cloneHelp">{t("pl.editor.messageHelp")}</p>
    {!issue && <p className="cloneHelp" role="status">{t("pl.editor.messagePreview", { message: renderCommitMessage(draft.commitMessageTemplate, sampleSource, sampleTarget) })}</p>}
    <label className="settingsCheck"><input type="checkbox" checked={draft.pushAfterMerge} onChange={(event) => update({ pushAfterMerge: event.target.checked })} />{t("pl.editor.push")}</label>
    <label>{t("pl.editor.onConflict")}
      <select value={draft.onConflict} onChange={(event) => update({ onConflict: event.target.value as PipelineRule["onConflict"] })}>
        <option value="openResolver">{t("pl.editor.conflictResolver")}</option>
        <option value="skipTarget">{t("pl.editor.conflictSkip")}</option>
        <option value="stopRun">{t("pl.editor.conflictStop")}</option>
      </select>
    </label>
    <label>{t("pl.editor.afterResolved")}
      <select value={draft.afterConflictResolved} disabled={draft.onConflict !== "openResolver"} onChange={(event) => update({ afterConflictResolved: event.target.value as PipelineRule["afterConflictResolved"] })}>
        <option value="continue">{t("pl.editor.afterContinue")}</option>
        <option value="ask">{t("pl.editor.afterAsk")}</option>
      </select>
    </label>
    <label>{t("pl.editor.confirmation")}
      <select value={effectiveConfirmation(draft)} disabled={forcedAsk} onChange={(event) => update({ confirmation: event.target.value as PipelineRule["confirmation"] })}>
        <option value="ask">{t("pl.editor.confirmAsk")}</option>
        <option value="auto">{t("pl.editor.confirmAuto")}</option>
      </select>
    </label>

    {issue && touched && <p className="formError" role="alert">{issueText(issue, t)}</p>}
    {error && <p className="formError" role="alert"><ErrorMessage error={error} /></p>}
    <div className="settingsActions">
      <button className="quietButton" type="button" onClick={onCancel} disabled={saving}>{t("pl.editor.cancel")}</button>
      <button className="primaryButton" type="submit" disabled={Boolean(issue) || saving}>{t("pl.editor.save")}</button>
    </div>
  </form>;
}
