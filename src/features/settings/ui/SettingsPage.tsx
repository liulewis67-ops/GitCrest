import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { GitCrestApiClient } from "../../../api/client";
import {
  defaultShortcutPreferences,
  displayShortcut,
  shortcutActions,
  shortcutConflict,
  shortcutFromEvent,
  type ShortcutAction,
  type ShortcutPreferences,
} from "../model/shortcut-preferences";
import { previewTheme } from "../model/appearance-store";
import { useDialogFocus } from "../../../shared/hooks/use-dialog-focus";
import { AiProvidersSection } from "./AiProvidersSection";
import { AppearanceSettings } from "./AppearanceSettings";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "./settings-sections";
import type { UpdateStatus } from "../../../api/update-status";
import { LOCALES, useI18n } from "../../../shared/i18n";
import { AccountsSection } from "../../accounts";
import { LanguagesSection } from "../../languages";
import { GitIdentityEditor, SigningSettings } from "../../identity";
import { ExternalToolsSettings } from "./ExternalToolsSettings";
import { BackgroundFetchSettings } from "../../remotes";
import { NotificationSettings } from "../../tasks";
import { resetHints, useAnyHintDismissed } from "../../../shared/hints/hints-store";

export function SettingsPage({
  api,
  repoId,
  onClose,
  initialSection,
  credentialHosts,
  shortcuts = defaultShortcutPreferences,
  onShortcutsChange = () => {},
  updateStatus,
  onCheckForUpdates,
  onInstallUpdate,
}: {
  api: GitCrestApiClient;
  repoId?: string;
  onClose: () => void;
  initialSection?: SettingsSectionId;
  credentialHosts?: readonly string[];
  shortcuts?: ShortcutPreferences;
  onShortcutsChange?: (shortcuts: ShortcutPreferences) => void;
  updateStatus?: UpdateStatus;
  onCheckForUpdates?: () => void | Promise<void>;
  onInstallUpdate?: () => void;
}) {
  const { t, locale, setLocale } = useI18n();
  const anyHintDismissed = useAnyHintDismissed();
  const [recordingShortcut, setRecordingShortcut] = useState<ShortcutAction>();
  const [shortcutError, setShortcutError] = useState("");
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(initialSection ?? "general");
  const contentRef = useRef<HTMLDivElement>(null);
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(onClose);
  const isMac = navigator.platform.toLowerCase().includes("mac");
  const sections = SETTINGS_SECTIONS.filter((id) => id !== "updates" || updateStatus);

  // A theme left half-edited is never saved by closing Settings.
  useEffect(() => () => previewTheme(undefined), []);

  useEffect(() => {
    if (initialSection) scrollToSection(initialSection, false);
  }, []);

  function sectionElement(id: SettingsSectionId) {
    return contentRef.current?.querySelector<HTMLElement>(`#settings-section-${id}`) ?? null;
  }

  function scrollToSection(id: SettingsSectionId, moveFocus = true) {
    const content = contentRef.current;
    const section = sectionElement(id);
    if (!content || !section) return;
    const top = Math.max(0, section.offsetTop - 16);
    if (typeof content.scrollTo === "function") content.scrollTo({ top, behavior: moveFocus ? "smooth" : "auto" });
    else content.scrollTop = top;
    setActiveSection(id);
    if (moveFocus) section.querySelector<HTMLElement>("h3")?.focus({ preventScroll: true });
  }

  function followScroll() {
    const content = contentRef.current;
    if (!content) return;
    let current: SettingsSectionId = sections[0];
    for (const id of sections) {
      const section = sectionElement(id);
      if (section && section.offsetTop - content.scrollTop <= 48) current = id;
    }
    // At the bottom the last short section can never reach the top; treat it as current.
    if (content.scrollTop + content.clientHeight >= content.scrollHeight - 2) current = sections[sections.length - 1];
    setActiveSection(current);
  }

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

  return (
    <section ref={dialogRef} className="settingsPage" role="dialog" aria-modal="true" aria-labelledby="settings-title" onKeyDown={onKeyDown}>
      <header className="settingsPageHeader">
        <div><p className="sectionEyebrow">{t("settings.eyebrow")}</p><h2 id="settings-title">{t("settings.title")}</h2></div>
        <button className="quietButton settingsCloseButton" type="button" onClick={onClose} aria-label={t("settings.close")} title={t("settings.closeTitle")}>×</button>
      </header>
      <div className="settingsPageBody">
        <nav className="settingsNav" aria-label={t("settings.sections")}>
          {sections.map((id) => (
            <button key={id} type="button" aria-current={activeSection === id ? "true" : undefined} onClick={() => scrollToSection(id)}>
              {t(`settings.section.${id}`)}
            </button>
          ))}
        </nav>
        <div className="settingsContent" ref={contentRef} onScroll={followScroll}>
          <div className="settingsColumn">
            <section className="settingsSection" id="settings-section-general" aria-labelledby="settings-general-title">
              <h3 id="settings-general-title" tabIndex={-1}>{t("settings.section.general")}</h3>
              <div className="settingsCard">
                <div className="settingsRow">
                  <div className="settingsRowText"><span id="language-preferences-title">{t("language.label")}</span><p>{t("language.description")}</p></div>
                  <div className="segmentedControl" role="radiogroup" aria-labelledby="language-preferences-title">
                    {LOCALES.map((code) => (
                      <label key={code} className={locale === code ? "selected" : undefined}>
                        <input type="radio" name="settings-language" value={code} checked={locale === code} onChange={() => setLocale(code)} />
                        <span>{t(`language.${code}`)}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
              <div className="settingsCard">
                <div className="settingsRow">
                  <div className="settingsRowText"><span>{t("id.title")}</span><p>{t("id.description")}</p></div>
                </div>
                <GitIdentityEditor api={api} />
              </div>
              <div className="settingsCard" id="settings-signing">
                <div className="settingsRow">
                  <div className="settingsRowText"><span>{t("sg.title")}</span><p>{t("sg.description")}</p></div>
                </div>
                <SigningSettings api={api} repoId={repoId} />
              </div>
              <div className="settingsCard">
                <div className="settingsRow">
                  <div className="settingsRowText"><span>{t("tools.title")}</span><p>{t("tools.description")}</p></div>
                </div>
                <ExternalToolsSettings />
              </div>
              <div className="settingsCard">
                <div className="settingsRow">
                  <div className="settingsRowText"><span>{t("bf.title")}</span><p>{t("bf.description")}</p></div>
                </div>
                <BackgroundFetchSettings repoId={repoId} />
              </div>
              <div className="settingsCard">
                <NotificationSettings />
              </div>
              <div className="settingsCard">
                <div className="settingsRow">
                  <div className="settingsRowText"><span>{t("hint.settingsTitle")}</span><p>{t("hint.settingsHelp")}</p></div>
                  <button className="secondaryButton" type="button" disabled={!anyHintDismissed} onClick={resetHints}>{t("hint.showAgain")}</button>
                </div>
              </div>
            </section>

            <AccountsSection api={api} credentialHosts={credentialHosts} />

            <section className="settingsSection" id="settings-section-appearance" aria-labelledby="settings-appearance-title">
              <h3 id="settings-appearance-title" tabIndex={-1}>{t("settings.section.appearance")}</h3>
              <AppearanceSettings />
            </section>

            <LanguagesSection />

            <section className="settingsSection" id="settings-section-shortcuts" aria-labelledby="shortcut-preferences-title">
              <div className="settingsSectionHeading">
                <h3 id="shortcut-preferences-title" tabIndex={-1}>{t("settings.shortcuts")}</h3>
                <button type="button" className="quietButton" onClick={() => { onShortcutsChange({ ...defaultShortcutPreferences }); setRecordingShortcut(undefined); setShortcutError(""); }}>{t("settings.restoreDefaults")}</button>
              </div>
              <div className="settingsCard">
                <p className="settingsHint">{t("settings.shortcutsHelp")}</p>
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
              </div>
            </section>

            <AiProvidersSection api={api} repoId={repoId} />

            {updateStatus && <section className="settingsSection" id="settings-section-updates" aria-labelledby="application-updates-title">
              <h3 id="application-updates-title" tabIndex={-1}>{t("settings.updates")}</h3>
              <div className="settingsCard">
                <p className="settingsHint" role="status" aria-live="polite">
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
              </div>
            </section>}
          </div>
        </div>
      </div>
    </section>
  );
}
