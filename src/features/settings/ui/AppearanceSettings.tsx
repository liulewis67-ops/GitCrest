import { Button } from "../../../shared/ui/Button";
import { useState } from "react";
import { useI18n, type MessageKey, type TranslateParams } from "../../../shared/i18n";
import {
  deleteCustomTheme,
  resetAppearance,
  selectTheme,
  setThemeMode,
  setTypography,
  THEME_MODES,
} from "../model/appearance-store";
import { serializeThemeFile, themeFileName } from "../model/theme-file";
import {
  CODE_FONT_SIZES,
  newCustomThemeId,
  uniqueThemeName,
  UI_FONT_SIZES,
  type CustomTheme,
  type ThemeDefinition,
} from "../model/themes";
import { useAppearance } from "../model/use-theme-preference";
import { StyleSettings } from "./StyleSettings";
import { ThemeEditor } from "./ThemeEditor";

type Editing = { theme: CustomTheme; isNew: boolean };
// Kept as a key so the message follows a language change.
type Message = { kind: "notice" | "error"; key: MessageKey; params?: TranslateParams };

function range(min: number, max: number) {
  return Array.from({ length: max - min + 1 }, (_, index) => min + index);
}

export function AppearanceSettings() {
  const { t } = useI18n();
  const appearance = useAppearance();
  const { preferences, themes, activeTheme, typography } = appearance;
  const [editing, setEditing] = useState<Editing>();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string>();
  const [message, setMessage] = useState<Message>();
  const themeNames = themes.map((theme) => themeName(theme));

  function themeName(theme: ThemeDefinition) {
    return theme.nameKey ? t(theme.nameKey) : theme.name;
  }

  function editableCopy(theme: ThemeDefinition, name: string): CustomTheme {
    return {
      id: newCustomThemeId(),
      name: uniqueThemeName(name, themeNames),
      base: theme.base,
      seeds: { ...theme.seeds },
      overrides: { ...theme.overrides },
      ...(theme.typography ? { typography: { ...theme.typography } } : {}),
      ...(theme.style ? { style: { ...theme.style } } : {}),
    };
  }

  function startEditing(next: Editing) {
    setMessage(undefined);
    setConfirmDeleteId(undefined);
    setEditing(next);
  }

  function exportTheme(theme: ThemeDefinition) {
    const url = URL.createObjectURL(new Blob([serializeThemeFile(theme)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = themeFileName(theme);
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  if (editing) {
    return (
      <div className="settingsCard">
        {message && <p className={message.kind === "error" ? "formError" : "settingsHint"} role={message.kind === "error" ? "alert" : "status"}>{t(message.key, message.params)}</p>}
        <ThemeEditor
          key={editing.theme.id}
          initialTheme={editing.theme}
          isNew={editing.isNew}
          takenNames={themes.filter((theme) => theme.id !== editing.theme.id).map(themeName)}
          onDone={(saved) => {
            setEditing(undefined);
            setMessage(saved ? { kind: "notice", key: "appearance.saved", params: { name: saved.name } } : undefined);
          }}
        />
      </div>
    );
  }

  return (
    <>
      <div className="settingsCard">
        <div className="settingsRow">
          <div className="settingsRowText"><span id="appearance-mode-label">{t("appearance.mode")}</span><p>{t("appearance.modeHelp")}</p></div>
          <div className="segmentedControl" role="radiogroup" aria-labelledby="appearance-mode-label">
            {THEME_MODES.map((mode) => (
              <label key={mode} className={preferences.mode === mode ? "selected" : undefined}>
                <input type="radio" name="settings-theme-mode" value={mode} checked={preferences.mode === mode} onChange={() => setThemeMode(mode)} />
                <span>{t(`theme.${mode}`)}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="settingsCard">
        <div className="settingsSectionHeading">
          <div className="settingsRowText"><span id="appearance-themes-label">{t("appearance.themes")}</span><p>{t("appearance.themesHelp")}</p></div>
          <div className="settingsActions">
            <Button type="button" variant="secondary" onClick={() => startEditing({ theme: editableCopy(activeTheme, t("appearance.newThemeName")), isNew: true })}>{t("appearance.newTheme")}</Button>
          </div>
        </div>
        {message && <p className={message.kind === "error" ? "formError" : "settingsHint"} role={message.kind === "error" ? "alert" : "status"}>{t(message.key, message.params)}</p>}
        <ul className="themeGallery" aria-labelledby="appearance-themes-label">
          {themes.map((theme) => {
            const name = themeName(theme);
            const slot = theme.base === "light" ? preferences.lightThemeId === theme.id : preferences.darkThemeId === theme.id;
            const showing = activeTheme.id === theme.id;
            const slotLabel = slot ? t(theme.base === "light" ? "appearance.usedLight" : "appearance.usedDark") : "";
            const { palette } = theme;
            return (
              <li key={theme.id} className={`themeCard${slot ? " selected" : ""}`}>
                <button
                  type="button"
                  className="themeCardSelect"
                  aria-pressed={slot}
                  aria-label={[name, t(theme.base === "light" ? "appearance.baseLight" : "appearance.baseDark"), slotLabel, showing ? t("appearance.showingNow") : ""].filter(Boolean).join(", ")}
                  onClick={() => selectTheme(theme.id)}
                >
                  <span className="themeSwatch" aria-hidden="true" style={{ background: palette.canvas, borderColor: palette.line }}>
                    <span className="themeSwatchBar" style={{ background: palette.surface, borderColor: palette.line }}>
                      <span style={{ background: palette.textMuted }} />
                      <span style={{ background: palette.accent }} />
                    </span>
                    <span className="themeSwatchPanel" style={{ background: palette.surfaceRaised, borderColor: palette.line }}>
                      <span style={{ background: palette.text, width: "70%" }} />
                      <span style={{ background: palette.textSecondary, width: "48%" }} />
                      <span className="themeSwatchDots">
                        <i style={{ background: palette.gitAdded }} /><i style={{ background: palette.gitModified }} /><i style={{ background: palette.gitDeleted }} />
                      </span>
                      <span className="themeSwatchButton" style={{ background: palette.accent }} />
                    </span>
                  </span>
                  <span className="themeCardName">{name}{showing && <span className="themeCardCheck" aria-hidden="true">✓</span>}</span>
                  <span className="themeCardMeta">{slotLabel || t(theme.base === "light" ? "appearance.baseLight" : "appearance.baseDark")}</span>
                </button>
                {confirmDeleteId === theme.id ? (
                  <div className="themeCardActions" role="group" aria-label={t("appearance.confirmDelete", { name })}>
                    <span>{t("appearance.confirmDelete", { name })}</span>
                    <Button type="button" variant="danger" onClick={() => { deleteCustomTheme(theme.id); setConfirmDeleteId(undefined); setMessage({ kind: "notice", key: "appearance.deleted", params: { name } }); }}>{t("appearance.delete")}</Button>
                    <Button type="button" variant="quiet" onClick={() => setConfirmDeleteId(undefined)}>{t("appearance.keep")}</Button>
                  </div>
                ) : (
                  <div className="themeCardActions">
                    {theme.builtIn ? (
                      <Button type="button" variant="quiet" aria-label={t("appearance.duplicateLabel", { name })} onClick={() => startEditing({ theme: editableCopy(theme, t("appearance.copyName", { name })), isNew: true })}>{t("appearance.duplicate")}</Button>
                    ) : <>
                      <Button type="button" variant="quiet" aria-label={t("appearance.editLabel", { name })} onClick={() => startEditing({ theme, isNew: false })}>{t("appearance.edit")}</Button>
                      <Button type="button" variant="quiet" aria-label={t("appearance.duplicateLabel", { name })} onClick={() => startEditing({ theme: editableCopy(theme, t("appearance.copyName", { name })), isNew: true })}>{t("appearance.duplicate")}</Button>
                      <Button type="button" variant="quiet" aria-label={t("appearance.exportLabel", { name })} onClick={() => exportTheme(theme)}>{t("appearance.export")}</Button>
                      <Button type="button" variant="danger" aria-label={t("appearance.deleteLabel", { name })} onClick={() => setConfirmDeleteId(theme.id)}>{t("appearance.delete")}</Button>
                    </>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <StyleSettings themeName={themeName} />

      <div className="settingsCard">
        <div className="settingsSectionHeading">
          <div className="settingsRowText"><span>{t("appearance.text")}</span><p>{activeTheme.typography ? t("appearance.textThemeOverride", { name: themeName(activeTheme) }) : t("appearance.textHelp")}</p></div>
        </div>
        <div className="settingsFieldGrid">
          <label>{t("appearance.uiFontSize")}
            <select value={preferences.typography.uiFontSize} onChange={(event) => setTypography({ uiFontSize: Number(event.target.value) })}>
              {range(UI_FONT_SIZES.min, UI_FONT_SIZES.max).map((size) => <option key={size} value={size}>{size === UI_FONT_SIZES.default ? t("appearance.sizeDefault", { size }) : t("appearance.size", { size })}</option>)}
            </select>
          </label>
          <label>{t("appearance.codeFontSize")}
            <select value={preferences.typography.codeFontSize} onChange={(event) => setTypography({ codeFontSize: Number(event.target.value) })}>
              {range(CODE_FONT_SIZES.min, CODE_FONT_SIZES.max).map((size) => <option key={size} value={size}>{size === CODE_FONT_SIZES.default ? t("appearance.sizeDefault", { size }) : t("appearance.size", { size })}</option>)}
            </select>
          </label>
          <label>{t("appearance.uiFont")}
            <input value={preferences.typography.uiFontFamily} placeholder={t("appearance.fontDefault")} spellCheck={false} onChange={(event) => setTypography({ uiFontFamily: event.target.value })} />
          </label>
          <label>{t("appearance.codeFont")}
            <input value={preferences.typography.codeFontFamily} placeholder={t("appearance.fontDefault")} spellCheck={false} onChange={(event) => setTypography({ codeFontFamily: event.target.value })} />
          </label>
        </div>
        <div className="typographyPreview" aria-label={t("appearance.preview")}>
          <p className="typographyPreviewUi">{t("appearance.previewUi")} <span>{t("appearance.previewSize", { size: typography.uiFontSize })}</span></p>
          <pre className="typographyPreviewCode"><span className="diffPreviewDel">- const theme = &quot;dark&quot;;</span><span className="diffPreviewAdd">+ const theme = loadTheme(user);</span></pre>
        </div>
      </div>

      <div className="settingsActions settingsResetRow">
        <Button type="button" variant="quiet" onClick={() => { resetAppearance(); setMessage({ kind: "notice", key: "appearance.resetDone" }); }}>{t("appearance.reset")}</Button>
      </div>
    </>
  );
}
