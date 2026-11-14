import { MetaList } from "../../../shared/ui/MetaList";
import { Icon as UiIcon } from "../../../shared/ui/Icon";
import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { useCallback, useEffect, useState } from "react";
import {
  type GitCrestApiClient,
  type PipelineAppSettingsResponse,
  type PipelineRepositorySettingsResponse,
  type PipelineRule,
} from "../../../api/client";
import { useI18n } from "../../../shared/i18n";
import { hasProtectedTarget, moveItem, newPipelineRule, nextRuleId, splitRemoteBranch } from "../model/rule-form";
import { PipelineRuleEditor, type RemoteBranchChoice } from "./PipelineRuleEditor";

type Mode = PipelineAppSettingsResponse["executionMode"];
type Policy = PipelineAppSettingsResponse["inPlaceDirtyPolicy"];

function message(reason: unknown, fallback: string): DisplayError {
  return describeApiError(reason, fallback);
}

/** Settings → Automations: repository Hook execution, and the open repository's rules. */
export function AutomationsSection({ api, repoId }: { api: GitCrestApiClient; repoId?: string }) {
  const { t } = useI18n();
  const [app, setApp] = useState<PipelineAppSettingsResponse>();
  const [repository, setRepository] = useState<PipelineRepositorySettingsResponse>();
  const [rules, setRules] = useState<PipelineRule[]>();
  const [localBranches, setLocalBranches] = useState<string[]>([]);
  const [remoteBranches, setRemoteBranches] = useState<RemoteBranchChoice[]>([]);
  const [editing, setEditing] = useState<{ rule: PipelineRule; isNew: boolean }>();
  const [error, setError] = useState<DisplayError>("");
  const [editorError, setEditorError] = useState<DisplayError>("");
  const [saving, setSaving] = useState(false);
  const [review, setReview] = useState<PipelineRule[]>();
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    setError("");
    void (async () => {
      try {
        const nextApp = await api.getPipelineAppSettings();
        if (cancelled) return;
        setApp(nextApp);
        if (!repoId) {
          setRepository(undefined);
          setRules(undefined);
          return;
        }
        const [nextRepository, nextRules, branches] = await Promise.all([
          api.getPipelineRepositorySettings(repoId),
          api.listPipelineRules(repoId),
          api.getRepositoryBranches(repoId),
        ]);
        if (cancelled) return;
        setRepository(nextRepository);
        setRules(nextRules);
        setLocalBranches(branches.branches.filter((branch) => branch.kind === "local").map((branch) => branch.name));
        setRemoteBranches(branches.branches.flatMap((branch) => {
          const split = branch.kind === "remote" ? splitRemoteBranch(branch.fullName) : undefined;
          return split ? [split] : [];
        }));
      } catch (reason) {
        if (!cancelled) setError(message(reason, t("pl.loadFailed")));
      }
    })();
    return () => { cancelled = true; };
  }, [api, repoId]);

  const saveApp = useCallback(async (changes: Partial<PipelineAppSettingsResponse>) => {
    if (!app) return;
    setError("");
    try {
      setApp(await api.setPipelineAppSettings({ ...app, ...changes }));
      if (repoId) setRepository(await api.getPipelineRepositorySettings(repoId));
    } catch (reason) {
      setError(message(reason, t("pl.saveFailed")));
    }
  }, [api, app, repoId, t]);

  async function saveRepository(changes: { executionMode?: Mode | null; inPlaceDirtyPolicy?: Policy | null }) {
    if (!repoId || !repository) return;
    setError("");
    try {
      setRepository(await api.setPipelineRepositorySettings(repoId, {
        executionMode: repository.executionMode,
        inPlaceDirtyPolicy: repository.inPlaceDirtyPolicy,
        ...changes,
      }));
    } catch (reason) {
      setError(message(reason, t("pl.saveFailed")));
    }
  }

  async function saveRules(next: PipelineRule[], fromEditor = false) {
    if (!repoId) return false;
    setSaving(true);
    setError("");
    setEditorError("");
    try {
      setRules(await api.replacePipelineRules(repoId, next));
      return true;
    } catch (reason) {
      (fromEditor ? setEditorError : setError)(message(reason, t("pl.saveFailed")));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveEdited(rule: PipelineRule) {
    if (!rules || !editing) return;
    const next = editing.isNew ? [...rules, rule] : rules.map((existing) => existing.ruleId === rule.ruleId ? rule : existing);
    if (await saveRules(next, true)) setEditing(undefined);
  }

  async function exportToRepository() {
    if (!repoId) return;
    setError("");
    setNotice("");
    try {
      const written = await api.writePipelineRulesFile(repoId);
      setNotice(t("pl.share.exported", { path: written.path }));
    } catch (reason) {
      setError(message(reason, t("pl.share.exportFailed")));
    }
  }

  async function reviewImport() {
    if (!repoId) return;
    setError("");
    setNotice("");
    try {
      setReview((await api.importPipelineRules(repoId, { apply: false })).imported);
    } catch (reason) {
      setError(message(reason, t("pl.share.importFailed")));
    }
  }

  async function confirmImport() {
    if (!repoId || !review) return;
    setSaving(true);
    setError("");
    try {
      const result = await api.importPipelineRules(repoId, { apply: true, document: { schemaVersion: 1, rules: review } });
      setRules(result.rules);
      setNotice(t("pl.share.imported", { count: result.imported.length }));
      setReview(undefined);
    } catch (reason) {
      setError(message(reason, t("pl.share.importFailed")));
    } finally {
      setSaving(false);
    }
  }

  const effectiveMode = repository?.effectiveExecutionMode ?? app?.executionMode;
  return <section className="settingsSection" id="settings-section-automations" aria-labelledby="settings-automations-title">
    <h3 id="settings-automations-title" tabIndex={-1}>{t("settings.section.automations")}</h3>
    <div className="settingsCard">
      <p className="settingsHint">{t("pl.settings.description")}</p>
      {error && <p className="formError" role="alert"><ErrorMessage error={error} /></p>}
      {app && <>
        <fieldset className="pipelineModes">
          <legend><MetaList items={[t("pl.mode.title"), t("pl.mode.appDefault")]} /></legend>
          {(["temporaryWorktree", "switchInPlace"] as const).map((mode) => <label key={mode} className="settingsCheck">
            <input type="radio" name="pipeline-app-mode" checked={app.executionMode === mode} onChange={() => void saveApp({ executionMode: mode })} />
            <span>{mode === "temporaryWorktree" ? t("pl.mode.worktree") : t("pl.mode.inPlace")}</span>
            <small className="cloneHelp">{mode === "temporaryWorktree" ? t("pl.mode.worktreeHelp") : t("pl.mode.inPlaceHelp")}</small>
          </label>)}
        </fieldset>
        {repository && <label className="settingsFieldStack">{t("pl.mode.thisRepository")}
          <select value={repository.executionMode ?? ""} onChange={(event) => void saveRepository({ executionMode: (event.target.value || null) as Mode | null })}>
            <option value="">{t("pl.mode.useDefault")}</option>
            <option value="temporaryWorktree">{t("pl.mode.worktree")}</option>
            <option value="switchInPlace">{t("pl.mode.inPlace")}</option>
          </select>
        </label>}
        {effectiveMode === "switchInPlace" && <label className="settingsFieldStack">{t("pl.dirty.title")}
          <select value={repository ? repository.inPlaceDirtyPolicy ?? "" : app.inPlaceDirtyPolicy} onChange={(event) => {
            const value = event.target.value as Policy | "";
            if (repository) void saveRepository({ inPlaceDirtyPolicy: value || null });
            else if (value) void saveApp({ inPlaceDirtyPolicy: value });
          }}>
            {repository && <option value="">{t("pl.mode.useDefault")}</option>}
            <option value="shelve">{t("pl.dirty.shelve")}</option>
            <option value="refuse">{t("pl.dirty.refuse")}</option>
          </select>
        </label>}
      </>}
    </div>
    <div className="settingsCard">
      <div className="settingsRow">
        <div className="settingsRowText"><span>{t("pl.rules.title")}</span></div>
        <div className="pipelineRuleActions">
          <button className="quietButton compact" type="button" disabled={!rules || Boolean(editing) || Boolean(review)} onClick={() => void exportToRepository()}>{t("pl.share.export")}</button>
          <button className="quietButton compact" type="button" disabled={!rules || Boolean(editing) || Boolean(review)} onClick={() => void reviewImport()}>{t("pl.share.import")}</button>
          <button className="secondaryButton" type="button" disabled={!rules || Boolean(editing) || Boolean(review)} onClick={() => { setEditorError(""); setEditing({ rule: newPipelineRule(nextRuleId(rules ?? [])), isNew: true }); }}>{t("pl.rules.add")}</button>
        </div>
      </div>
      {notice && <p className="settingsHint" role="status">{notice}</p>}
      {review && <section className="pipelineImportReview" aria-label={t("pl.share.reviewTitle")}>
        <h4>{t("pl.share.reviewTitle")}</h4>
        <p className="cloneHelp">{t("pl.share.reviewHelp")}</p>
        {review.length === 0 ? <p className="cloneHelp">{t("pl.share.reviewEmpty")}</p> : <ul className="pipelineRuleList">
          {review.map((rule) => <li key={rule.ruleId}>
            <span aria-hidden="true">+</span>
            <div><strong>{rule.name}</strong><p className="cloneHelp monoText">{t("pl.rules.summary", { pattern: `${t(`pl.event.${rule.trigger.kind}`)}: ${rule.trigger.branchPattern}`, targets: [...rule.targets.map((target) => target.branch), ...(rule.commands ?? []).map((command) => `${command.program} ${JSON.stringify(command.args)} (${command.timeoutSeconds}s)`)].join(", ") })}</p></div>
            <span />
          </li>)}
        </ul>}
        <div className="settingsActions">
          <button className="quietButton" type="button" disabled={saving} onClick={() => setReview(undefined)}>{t("pl.editor.cancel")}</button>
          <button className="primaryButton" type="button" disabled={saving || review.length === 0} onClick={() => void confirmImport()}>{t("pl.share.confirm", { count: review.length })}</button>
        </div>
      </section>}
      {!repoId && <p className="settingsHint">{t("pl.rules.needRepository")}</p>}
      {rules && rules.length === 0 && !editing && <p className="settingsHint">{t("pl.rules.empty")}</p>}
      {rules && <ul className="pipelineRuleList">
        {rules.map((rule, index) => <li key={rule.ruleId}>
          <label className="settingsCheck"><input type="checkbox" aria-label={`${t("pl.rules.enabled")}: ${rule.name}`} checked={rule.enabled} disabled={saving} onChange={(event) => void saveRules(rules.map((other) => other.ruleId === rule.ruleId ? { ...other, enabled: event.target.checked } : other))} /></label>
          <div>
            <strong>{rule.name}</strong>
            <p className="cloneHelp monoText">{t("pl.rules.summary", { pattern: `${t(`pl.event.${rule.trigger.kind}`)}: ${rule.trigger.branchPattern}`, targets: [...rule.targets.map((target) => target.branch), ...(rule.commands ?? []).map((command) => `${command.program} ${JSON.stringify(command.args)} (${command.timeoutSeconds}s)`)].join(", ") })}</p>
            {hasProtectedTarget(rule) && <p className="cloneHelp">{t("pl.rules.askAlways")}</p>}
          </div>
          <div className="pipelineRuleActions">
            <button className="quietButton compact" type="button" disabled={saving || index === 0} aria-label={`${t("pl.rules.moveUp")}: ${rule.name}`} onClick={() => void saveRules(moveItem(rules, index, index - 1))}><UiIcon name="arrowUp" /></button>
            <button className="quietButton compact" type="button" disabled={saving || index === rules.length - 1} aria-label={`${t("pl.rules.moveDown")}: ${rule.name}`} onClick={() => void saveRules(moveItem(rules, index, index + 1))}><UiIcon name="arrowDown" /></button>
            <button className="quietButton compact" type="button" disabled={Boolean(editing)} onClick={() => { setEditorError(""); setEditing({ rule, isNew: false }); }}>{t("pl.rules.edit")}</button>
            <button className="quietButton compact" type="button" disabled={saving} onClick={() => void saveRules(rules.filter((other) => other.ruleId !== rule.ruleId))}>{t("pl.rules.delete")}</button>
          </div>
        </li>)}
      </ul>}
      {editing && rules && <PipelineRuleEditor
        key={editing.rule.ruleId}
        rule={editing.rule}
        otherRules={rules.filter((other) => other.ruleId !== editing.rule.ruleId)}
        localBranches={localBranches}
        remoteBranches={remoteBranches}
        saving={saving}
        error={editorError}
        onSave={(rule) => void saveEdited(rule)}
        onCancel={() => setEditing(undefined)}
      />}
    </div>
  </section>;
}
