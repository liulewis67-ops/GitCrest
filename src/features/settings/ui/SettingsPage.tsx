import { Button } from "../../../shared/ui/Button";
import { Dialog, DialogHeader } from "../../../shared/ui/Dialog";
import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { type DisplayError } from "../../../shared/i18n/api-errors";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { GitCrestApiClient } from "../../../api/client";
import {
  defaultShortcutPreferences,
  displayShortcut,
  shortcutGroups,
  shortcutConflict,
  shortcutFromEvent,
  type ShortcutAction,
  type ShortcutPreferences,
} from "../model/shortcut-preferences";
import { previewTheme } from "../model/appearance-store";
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
import { BranchSwitchSettings } from "../../branches";
import { OperationFlowSettings } from "../../operations";
import { AutomationsSection } from "../../pipelines";
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
  const [shortcutQuery, setShortcutQuery] = useState("");
  const [shortcutError, setShortcutError] = useState<DisplayError>("");
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(initialSection ?? "general");
  const contentRef = useRef<HTMLDivElement>(null);

  const isMac = navigator.platform.toLowerCase().includes("mac");
  const sections = SETTINGS_SECTIONS.filter((id) => id !== "updates" || updateStatus);
  const matchingShortcutGroups = shortcutGroups.map((group) => ({ ...group, actions: group.actions.filter((id) => `${t(`sc.${id}`)} ${displayShortcut(shortcuts[id], isMac)}`.toLocaleLowerCase().includes(shortcutQuery.trim().toLocaleLowerCase())) })).filter((group) => group.actions.length > 0);

  // A theme left half-edited is never saved by closing Settings.
  useEffect(() => () => previewTheme(undefined), []);

  // Leave enough space after the last section for its heading to align with the viewport,
  // just like every other navigation target, even when the section itself is short.
  useLayoutEffect(() => {
    const content = contentRef.current;
    const last = content?.querySelector<HTMLElement>(`#settings-section-${sections[sections.length - 1]}`);
    if (!content || !last) return;
    const fit = () => content.style.setProperty("--settings-end-space", `${Math.max(32, content.clientHeight - last.offsetHeight - 16)}px`);
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(fit);
    observer.observe(content);
    observer.observe(last);
    return () => observer.disconnect();
  }, [Boolean(updateStatus)]);

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
    <Dialog className="settingsPage" role="dialog" aria-labelledby="settings-title" onClose={onClose} busy={false} returnFocus={() => document.querySelector<HTMLButtonElement>(".settingsButton")} closeLabel={t("settings.close")} fullPage backgroundSelector="[data-settings-background]" onKeyDownCapture={(event) => {
      // Customizable native select pickers live in the top layer. Let their own Escape
      // handling close the picker before the enclosing Settings dialog handles Escape.
      if (event.key === "Escape" && event.target instanceof Element && event.target.closest("select")?.matches(":open")) event.stopPropagation();
    }}>
      <DialogHeader className="settingsPageHeader">
        <div><h2 id="settings-title">{t("settings.title")}</h2></div>

      </DialogHeader>
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
              <div className="settingsCard"><BranchSwitchSettings /></div>
              <div className="settingsCard"><OperationFlowSettings /></div>
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
                  <Button variant="secondary" type="button" disabled={!anyHintDismissed} onClick={resetHints}>{t("hint.showAgain")}</Button>
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
                <Button type="button" variant="quiet" onClick={() => { onShortcutsChange({ ...defaultShortcutPreferences }); setRecordingShortcut(undefined); setShortcutError(""); }}>{t("settings.restoreDefaults")}</Button>
              </div>
              <div className="settingsCard">
                <p className="settingsHint">{t("settings.shortcutsHelp")}</p>
                <label className="shortcutSearch">{t("settings.searchShortcuts")}<input type="search" value={shortcutQuery} onChange={(event) => setShortcutQuery(event.target.value)} /></label>
                {matchingShortcutGroups.map((group) => <section className="shortcutGroup" key={group.id} aria-labelledby={`shortcut-group-${group.id}`}>
                  <h4 id={`shortcut-group-${group.id}`}>{t(`settings.shortcutGroup.${group.id}`)}</h4>
                  <div className="shortcutPreferenceList">
                  {group.actions.map((id) => <div className="shortcutPreferenceRow" key={id}>
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
                </section>)}
                {matchingShortcutGroups.length === 0 && <p className="settingsHint" role="status">{t("settings.noShortcuts")}</p>}
                {shortcutError && <p className="formError" role="alert"><ErrorMessage error={shortcutError} /></p>}
              </div>
            </section>

            <AiProvidersSection api={api} repoId={repoId} />

            <AutomationsSection api={api} repoId={repoId} />

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
                  <Button variant="secondary" type="button" disabled={!onCheckForUpdates || ["notConfigured", "checking", "available", "downloading", "downloaded"].includes(updateStatus.state)} onClick={() => void onCheckForUpdates?.()}>
                    {updateStatus.state === "checking" ? t("settings.checkingBtn") : t("settings.checkUpdates")}
                  </Button>
                  {updateStatus.state === "downloaded" && <Button variant="primary" type="button" disabled={!onInstallUpdate} onClick={onInstallUpdate}>{t("settings.restartInstall")}</Button>}
                </div>
              </div>
            </section>}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
