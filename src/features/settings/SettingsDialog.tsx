import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import type { AiSettingsResponse, GitCrestApiClient } from "../../api/client";
import {
  defaultShortcutPreferences,
  displayShortcut,
  shortcutActions,
  shortcutConflict,
  shortcutFromEvent,
  type ShortcutAction,
  type ShortcutPreferences,
} from "../../shared/lib/shortcut-preferences";
import { useDialogFocus } from "../../shared/use-dialog-focus";
import { PrivacyScopePreview } from "./PrivacyScopePreview";
import type { UpdateStatus } from "../../api/update-status";

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
      setShortcutError("Press a Ctrl/Cmd shortcut. Escape cancels recording.");
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
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Settings could not be loaded.");
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
      setSettings(saved); setBaseUrl(saved.baseUrl); setModel(saved.model); setNotice("Provider settings saved. No model request was made.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Settings could not be saved."); }
    finally { setBusy(false); }
  }

  async function saveKey(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      const saved = await api.setAiCredential(apiKey);
      setSettings(saved); setApiKey(""); setNotice("API key saved to the system credential store.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "API key could not be saved."); }
    finally { setBusy(false); }
  }

  async function removeKey() {
    setBusy(true); setError(""); setNotice("");
    try {
      await api.deleteAiCredential();
      setSettings((current) => current ? { ...current, hasCloudCredential: false } : current);
      setNotice("Saved API key removed.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "API key could not be removed."); }
    finally { setBusy(false); }
  }

  return (
    <div className="paletteBackdrop cloneBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section ref={dialogRef} className="taskCenter workflowDialog settingsDialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onKeyDown={onKeyDown}>
        <header className="taskCenterHeader"><div><p className="sectionEyebrow">PREFERENCES</p><h2 id="settings-title">Settings</h2></div><button className="quietButton" type="button" onClick={onClose} disabled={busy} aria-label="Close settings">×</button></header>
        <div className="workflowDialogBody">
          <section className="shortcutPreferences" aria-labelledby="shortcut-preferences-title">
            <div className="settingsSectionHeading"><h3 id="shortcut-preferences-title">Keyboard shortcuts</h3><button type="button" className="quietButton" onClick={() => { onShortcutsChange({ ...defaultShortcutPreferences }); setRecordingShortcut(undefined); setShortcutError(""); }}>Restore defaults</button></div>
            <p>Choose a shortcut, then press the replacement. Shortcuts are saved on this device.</p>
            <div className="shortcutPreferenceList">
              {shortcutActions.map(({ id, label }) => <div className="shortcutPreferenceRow" key={id}>
                <span>{label}</span>
                <button
                  type="button"
                  className="shortcutCaptureButton"
                  aria-label={`Record shortcut for ${label}`}
                  onClick={() => { setRecordingShortcut(id); setShortcutError(""); }}
                  onKeyDown={(event) => captureShortcut(event, id)}
                >
                  <kbd>{recordingShortcut === id ? "Press shortcut…" : displayShortcut(shortcuts[id], isMac)}</kbd>
                </button>
              </div>)}
            </div>
            {shortcutError && <p className="formError" role="alert">{shortcutError}</p>}
          </section>
          {updateStatus && <section className="shortcutPreferences" aria-labelledby="application-updates-title">
            <div className="settingsSectionHeading"><h3 id="application-updates-title">Application updates</h3></div>
            <p role="status" aria-live="polite">
              {updateStatus.state === "notConfigured" && "Updates are not configured for this build."}
              {updateStatus.state === "idle" && "You can check for a newer version."}
              {updateStatus.state === "checking" && "Checking for updates…"}
              {updateStatus.state === "notAvailable" && "GitCrest is up to date."}
              {updateStatus.state === "available" && `Version ${updateStatus.version} is available. Downloading…`}
              {updateStatus.state === "downloading" && `Downloading update${updateStatus.version ? ` ${updateStatus.version}` : ""}… ${Math.round(updateStatus.percent)}%`}
              {updateStatus.state === "downloaded" && `Version ${updateStatus.version} is ready to install.`}
              {updateStatus.state === "error" && updateStatus.message}
            </p>
            <div className="settingsActions">
              <button className="secondaryButton" type="button" disabled={!onCheckForUpdates || ["notConfigured", "checking", "available", "downloading", "downloaded"].includes(updateStatus.state)} onClick={() => void onCheckForUpdates?.()}>
                {updateStatus.state === "checking" ? "Checking…" : "Check for updates"}
              </button>
              {updateStatus.state === "downloaded" && <button className="primaryButton" type="button" disabled={!onInstallUpdate} onClick={onInstallUpdate}>Restart to install</button>}
            </div>
          </section>}
          <p className="settingsNotice">Provider settings are stored locally. Saving them does not send a request to an AI provider.</p>
          <form className="settingsForm" onSubmit={saveSettings}>
            <label>Provider<select aria-label="AI provider" value={provider} onChange={(event) => changeProvider(event.target.value as AiSettingsResponse["provider"])}><option value="none">Disabled</option><option value="openAiCompatible">OpenAI-compatible cloud</option><option value="ollama">Ollama on this machine</option></select></label>
            {provider !== "none" && <>
              <label>Endpoint<input aria-label="AI endpoint" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={provider === "ollama" ? "http://127.0.0.1:11434" : "https://api.openai.com/v1"} autoComplete="url" /></label>
              <label>Model<input aria-label="AI model" value={model} onChange={(event) => setModel(event.target.value)} /></label>
            </>}
            <button className="primaryButton" type="submit" disabled={busy || !settings}>{busy ? "Saving…" : "Save provider settings"}</button>
          </form>
          {provider === "openAiCompatible" && <form className="settingsForm settingsKeyForm" onSubmit={saveKey}>
            <h3>Cloud API key</h3>
            {settings?.provider !== "openAiCompatible" && <p>Save the OpenAI-compatible provider settings before adding its key.</p>}
            <p>{settings?.hasCloudCredential ? "An API key is saved in the system credential store." : "No API key is saved."} The key is never returned to this window.</p>
            <label>API key<input aria-label="Cloud API key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="new-password" /></label>
            <div className="settingsActions"><button className="secondaryButton" type="submit" disabled={busy || settings?.provider !== "openAiCompatible" || !apiKey}>{busy ? "Saving…" : "Save API key"}</button>{settings?.hasCloudCredential && <button className="dangerTextButton" type="button" disabled={busy} onClick={() => void removeKey()}>Remove key</button>}</div>
          </form>}
          <PrivacyScopePreview api={api} repoId={repoId} settings={settings} />
          {error && <p className="formError" role="alert">{error}</p>}{notice && <p className="settingsNotice" role="status">{notice}</p>}
        </div>
      </section>
    </div>
  );
}
