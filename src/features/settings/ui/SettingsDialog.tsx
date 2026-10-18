import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import type { AiSettingsResponse, GitCrestApiClient } from "../../../api/client";
import {
  defaultShortcutPreferences,
  displayShortcut,
  shortcutActions,
  shortcutConflict,
  shortcutFromEvent,
  type ShortcutAction,
  type ShortcutPreferences,
} from "../model/shortcut-preferences";
import { useDialogFocus } from "../../../shared/hooks/use-dialog-focus";
import { PrivacyScopePreview } from "./PrivacyScopePreview";
import type { UpdateStatus } from "../../../api/update-status";
import { LOCALES, useI18n } from "../../../shared/i18n";

export function SettingsDialog({
  api,
  repoId,
  onClose,
  shortcuts = defaultShortcutPreferences,
  onShortcutsChange = () => {},
  updateStatus,
  onCheckForUpdates,
  onInstallUpdate,
}: {
  api: GitCrestApiClient;
  repoId?: string;
  onClose: () => void;
  shortcuts?: ShortcutPreferences;
  onShortcutsChange?: (shortcuts: ShortcutPreferences) => void;
  updateStatus?: UpdateStatus;
  onCheckForUpdates?: () => void | Promise<void>;
  onInstallUpdate?: () => void;
}) {
  const { t, locale, setLocale } = useI18n();
  const [settings, setSettings] = useState<AiSettingsResponse>();
  const [provider, setProvider] = useState<AiSettingsResponse["provider"]>("none");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [recordingShortcut, setRecordingShortcut] = useState<ShortcutAction>();
  const [shortcutError, setShortcutError] = useState("");
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(onClose, busy);
  const isMac = navigator.platform.toLowerCase().includes("mac");

  function captureShortcut(event: KeyboardEvent<HTMLButtonElement>, action: ShortcutAction) {
    if (recordingShortcut !== action) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setRecordingShortcut(undefined);
      setShortcutError("");
      return;
    }
    const binding = shortcutFromEvent(event.nativeEvent);
    if (!binding) {
      setShortcutError(t("settings.pressCtrlCmd"));
      return;
    }
    const conflict = shortcutConflict(action, binding, shortcuts);
    if (conflict) {
      setShortcutError(conflict);
      return;
    }
    onShortcutsChange({ ...shortcuts, [action]: binding });
    setRecordingShortcut(undefined);
    setShortcutError("");
  }

  useEffect(() => {
    const controller = new AbortController();
    void api.withSignal(controller.signal).getAiSettings().then((value) => {
      if (controller.signal.aborted) return;
      setSettings(value);
      setProvider(value.provider);
      setBaseUrl(value.baseUrl);
      setModel(value.model);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : t("settings.loadFailed"));
    });
    return () => controller.abort();
  }, [api]);

  function changeProvider(next: AiSettingsResponse["provider"]) {
    setProvider(next);
    if (next === "openAiCompatible" && !baseUrl) setBaseUrl("https://api.openai.com/v1");
    if (next === "openAiCompatible" && !model) setModel("gpt-4o-mini");
    if (next === "ollama" && !baseUrl) setBaseUrl("http://127.0.0.1:11434");
    if (next === "ollama" && !model) setModel("qwen2.5-coder:7b");
    if (next === "none") { setBaseUrl(""); setModel(""); }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      const saved = await api.setAiSettings(provider, provider === "none" ? "" : baseUrl, provider === "none" ? "" : model);
      setSettings(saved); setBaseUrl(saved.baseUrl); setModel(saved.model); setNotice(t("settings.providerSaved"));
    } catch (reason) { setError(reason instanceof Error ? reason.message : t("settings.saveFailed")); }
    finally { setBusy(false); }
  }

  async function saveKey(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      const saved = await api.setAiCredential(apiKey);
      setSettings(saved); setApiKey(""); setNotice(t("settings.keySavedNotice"));
    } catch (reason) { setError(reason instanceof Error ? reason.message : t("settings.keySaveFailed")); }
    finally { setBusy(false); }
  }

  async function removeKey() {
    setBusy(true); setError(""); setNotice("");
    try {
      await api.deleteAiCredential();
      setSettings((current) => current ? { ...current, hasCloudCredential: false } : current);
      setNotice(t("settings.keyRemoved"));
    } catch (reason) { setError(reason instanceof Error ? reason.message : t("settings.keyRemoveFailed")); }
    finally { setBusy(false); }
  }

  return (
    <div className="paletteBackdrop cloneBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section ref={dialogRef} className="taskCenter workflowDialog settingsDialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onKeyDown={onKeyDown}>
        <header className="taskCenterHeader"><div><p className="sectionEyebrow">{t("settings.eyebrow")}</p><h2 id="settings-title">{t("settings.title")}</h2></div><button className="quietButton" type="button" onClick={onClose} disabled={busy} aria-label={t("settings.close")}>×</button></header>
        <div className="workflowDialogBody">
          <section className="shortcutPreferences" aria-labelledby="language-preferences-title">
            <div className="settingsSectionHeading"><h3 id="language-preferences-title">{t("language.label")}</h3></div>
            <p>{t("language.description")}</p>
            <div className="settingsForm"><select aria-label={t("language.label")} value={locale} onChange={(event) => setLocale(event.target.value as typeof LOCALES[number])}>{LOCALES.map((code) => <option key={code} value={code}>{t(`language.${code}`)}</option>)}</select></div>
          </section>
          <section className="shortcutPreferences" aria-labelledby="shortcut-preferences-title">
            <div className="settingsSectionHeading"><h3 id="shortcut-preferences-title">{t("settings.shortcuts")}</h3><button type="button" className="quietButton" onClick={() => { onShortcutsChange({ ...defaultShortcutPreferences }); setRecordingShortcut(undefined); setShortcutError(""); }}>{t("settings.restoreDefaults")}</button></div>
            <p>{t("settings.shortcutsHelp")}</p>
            <div className="shortcutPreferenceList">
              {shortcutActions.map(({ id }) => <div className="shortcutPreferenceRow" key={id}>
                <span>{t(`sc.${id}`)}</span>
                <button
                  type="button"
                  className="shortcutCaptureButton"
                  aria-label={t("settings.recordShortcut", { label: t(`sc.${id}`) })}
                  onClick={() => { setRecordingShortcut(id); setShortcutError(""); }}
                  onKeyDown={(event) => captureShortcut(event, id)}
                >
                  <kbd>{recordingShortcut === id ? t("settings.pressShortcut") : displayShortcut(shortcuts[id], isMac)}</kbd>
                </button>
              </div>)}
            </div>
            {shortcutError && <p className="formError" role="alert">{shortcutError}</p>}
          </section>
          {updateStatus && <section className="shortcutPreferences" aria-labelledby="application-updates-title">
            <div className="settingsSectionHeading"><h3 id="application-updates-title">{t("settings.updates")}</h3></div>
            <p role="status" aria-live="polite">
              {updateStatus.state === "notConfigured" && t("settings.updNotConfigured")}
              {updateStatus.state === "idle" && t("settings.updIdle")}
              {updateStatus.state === "checking" && t("settings.updChecking")}
              {updateStatus.state === "notAvailable" && t("settings.updUpToDate")}
              {updateStatus.state === "available" && t("settings.updAvailable", { version: updateStatus.version })}
              {updateStatus.state === "downloading" && t("settings.updDownloading", { version: updateStatus.version ? ` ${updateStatus.version}` : "", percent: Math.round(updateStatus.percent) })}
              {updateStatus.state === "downloaded" && t("settings.updDownloaded", { version: updateStatus.version })}
              {updateStatus.state === "error" && updateStatus.message}
            </p>
            <div className="settingsActions">
              <button className="secondaryButton" type="button" disabled={!onCheckForUpdates || ["notConfigured", "checking", "available", "downloading", "downloaded"].includes(updateStatus.state)} onClick={() => void onCheckForUpdates?.()}>
                {updateStatus.state === "checking" ? t("settings.checkingBtn") : t("settings.checkUpdates")}
              </button>
              {updateStatus.state === "downloaded" && <button className="primaryButton" type="button" disabled={!onInstallUpdate} onClick={onInstallUpdate}>{t("settings.restartInstall")}</button>}
            </div>
          </section>}
          <p className="settingsNotice">{t("settings.providerNotice")}</p>
          <form className="settingsForm" onSubmit={saveSettings}>
            <label>{t("settings.provider")}<select aria-label={t("settings.providerAria")} value={provider} onChange={(event) => changeProvider(event.target.value as AiSettingsResponse["provider"])}><option value="none">{t("settings.providerDisabled")}</option><option value="openAiCompatible">{t("settings.providerOpenAi")}</option><option value="ollama">{t("settings.providerOllama")}</option></select></label>
            {provider !== "none" && <>
              <label>{t("settings.endpoint")}<input aria-label={t("settings.endpointAria")} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={provider === "ollama" ? "http://127.0.0.1:11434" : "https://api.openai.com/v1"} autoComplete="url" /></label>
              <label>{t("settings.model")}<input aria-label={t("settings.modelAria")} value={model} onChange={(event) => setModel(event.target.value)} /></label>
            </>}
            <button className="primaryButton" type="submit" disabled={busy || !settings}>{busy ? t("settings.saving") : t("settings.saveProvider")}</button>
          </form>
          {provider === "openAiCompatible" && <form className="settingsForm settingsKeyForm" onSubmit={saveKey}>
            <h3>{t("settings.cloudKey")}</h3>
            {settings?.provider !== "openAiCompatible" && <p>{t("settings.saveProviderFirst")}</p>}
            <p>{settings?.hasCloudCredential ? t("settings.keySaved") : t("settings.keyNotSaved")} {t("settings.keyNeverReturned")}</p>
            <label>{t("settings.apiKey")}<input aria-label={t("settings.cloudKey")} type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="new-password" /></label>
            <div className="settingsActions"><button className="secondaryButton" type="submit" disabled={busy || settings?.provider !== "openAiCompatible" || !apiKey}>{busy ? t("settings.saving") : t("settings.saveKey")}</button>{settings?.hasCloudCredential && <button className="dangerTextButton" type="button" disabled={busy} onClick={() => void removeKey()}>{t("settings.removeKey")}</button>}</div>
          </form>}
          <PrivacyScopePreview api={api} repoId={repoId} settings={settings} />
          {error && <p className="formError" role="alert">{error}</p>}{notice && <p className="settingsNotice" role="status">{notice}</p>}
        </div>
      </section>
    </div>
  );
}
