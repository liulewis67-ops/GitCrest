import { useCallback, useEffect, useState } from "react";
import {
  GitCrestApiError,
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

function message(reason: unknown, fallback: string): string {
  return reason instanceof GitCrestApiError ? reason.body.error.message : reason instanceof Error ? reason.message : fallback;
}

/** Settings → Automations: how post-push pipelines run, and the open repository's rules. */
export function AutomationsSection({ api, repoId }: { api: GitCrestApiClient; repoId?: string }) {
  const { t } = useI18n();
  const [app, setApp] = useState<PipelineAppSettingsResponse>();
  const [repository, setRepository] = useState<PipelineRepositorySettingsResponse>();
  const [rules, setRules] = useState<PipelineRule[]>();
  const [localBranches, setLocalBranches] = useState<string[]>([]);
  const [remoteBranches, setRemoteBranches] = useState<RemoteBranchChoice[]>([]);
  const [editing, setEditing] = useState<{ rule: PipelineRule; isNew: boolean }>();
  const [error, setError] = useState("");
  const [editorError, setEditorError] = useState("");
  const [saving, setSaving] = useState(false);

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

  const effectiveMode = repository?.effectiveExecutionMode ?? app?.executionMode;
  return <section className="settingsSection" id="settings-section-automations" aria-labelledby="settings-automations-title">
    <h3 id="settings-automations-title" tabIndex={-1}>{t("settings.section.automations")}</h3>
    <div className="settingsCard">
      <p className="settingsHint">{t("pl.settings.description")}</p>
      {error && <p className="formError" role="alert">{error}</p>}
      {app && <>
        <fieldset className="pipelineModes">
          <legend>{t("pl.mode.title")} · {t("pl.mode.appDefault")}</legend>
          {(["temporaryWorktree", "switchInPlace"] as const).map((mode) => <label key={mode} className="settingsCheck">
            <input type="radio" name="pipeline-app-mode" checked={app.executionMode === mode} onChange={() => void saveApp({ executionMode: mode })} />
            <span>{mode === "temporaryWorktree" ? t("pl.mode.worktree") : t("pl.mode.inPlace")}</span>
            <small className="cloneHelp">{mode === "temporaryWorktree" ? t("pl.mode.worktreeHelp") : t("pl.mode.inPlaceHelp")}</small>
          </label>)}
        </fieldset>
        {repository && <label>{t("pl.mode.thisRepository")}
          <select value={repository.executionMode ?? ""} onChange={(event) => void saveRepository({ executionMode: (event.target.value || null) as Mode | null })}>
            <option value="">{t("pl.mode.useDefault")}</option>
            <option value="temporaryWorktree">{t("pl.mode.worktree")}</option>
            <option value="switchInPlace">{t("pl.mode.inPlace")}</option>
          </select>
        </label>}
        {effectiveMode === "switchInPlace" && <label>{t("pl.dirty.title")}
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
        <button className="secondaryButton" type="button" disabled={!rules || Boolean(editing)} onClick={() => { setEditorError(""); setEditing({ rule: newPipelineRule(nextRuleId(rules ?? [])), isNew: true }); }}>{t("pl.rules.add")}</button>
      </div>
      {!repoId && <p className="settingsHint">{t("pl.rules.needRepository")}</p>}
      {rules && rules.length === 0 && !editing && <p className="settingsHint">{t("pl.rules.empty")}</p>}
      {rules && <ul className="pipelineRuleList">
        {rules.map((rule, index) => <li key={rule.ruleId}>
          <label className="settingsCheck"><input type="checkbox" aria-label={`${t("pl.rules.enabled")}: ${rule.name}`} checked={rule.enabled} disabled={saving} onChange={(event) => void saveRules(rules.map((other) => other.ruleId === rule.ruleId ? { ...other, enabled: event.target.checked } : other))} /></label>
          <div>
            <strong>{rule.name}</strong>
            <p className="cloneHelp monoText">{t("pl.rules.summary", { pattern: rule.trigger.branchPattern, targets: rule.targets.map((target) => target.branch).join(", ") })}</p>
            {hasProtectedTarget(rule) && <p className="cloneHelp">{t("pl.rules.askAlways")}</p>}
          </div>
          <div className="pipelineRuleActions">
            <button className="quietButton compact" type="button" disabled={saving || index === 0} aria-label={`${t("pl.rules.moveUp")}: ${rule.name}`} onClick={() => void saveRules(moveItem(rules, index, index - 1))}>↑</button>
            <button className="quietButton compact" type="button" disabled={saving || index === rules.length - 1} aria-label={`${t("pl.rules.moveDown")}: ${rule.name}`} onClick={() => void saveRules(moveItem(rules, index, index + 1))}>↓</button>
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
