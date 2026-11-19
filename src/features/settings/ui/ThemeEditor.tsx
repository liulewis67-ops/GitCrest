import { SearchableSelect } from "../../../shared/ui/SearchableSelect";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../shared/i18n";
import { normalizeHex, type Hex } from "../model/color";
import { previewTheme, saveCustomTheme } from "../model/appearance-store";
import {
  ACCENT_PRESETS,
  BUILT_IN_THEMES,
  CODE_FONT_SIZES,
  contrastChecks,
  DEFAULT_THEME_ID,
  derivePalette,
  fixContrast,
  sanitizeThemeName,
  STYLE_FIELDS,
  STYLE_OPTIONS,
  THEME_NAME_MAX_LENGTH,
  THEME_SEEDS,
  TOKEN_GROUPS,
  UI_FONT_SIZES,
  type CustomTheme,
  type StyleField,
  type ThemeBase,
  type ThemeSeed,
  type ThemeStyle,
  type AdvancedThemeToken,
} from "../model/themes";
import { useAppearance } from "../model/use-theme-preference";
import { styleOptionKey } from "./StyleSettings";

function ColorField({ id, label, pickerLabel, value, pinned, onChange, onReset, resetLabel }: {
  id: string;
  label: string;
  pickerLabel: string;
  value: Hex;
  pinned?: boolean;
  onChange: (value: Hex) => void;
  onReset?: () => void;
  resetLabel?: string;
}) {
  const [text, setText] = useState<string>(value);
  useEffect(() => setText(value), [value]);
  const valid = normalizeHex(text) !== undefined;
  return (
    <div className={`colorField${pinned ? " pinned" : ""}`}>
      <label htmlFor={`${id}-hex`}>{label}</label>
      <div className="colorFieldInputs">
        <input type="color" aria-label={pickerLabel} value={value} onChange={(event) => onChange(normalizeHex(event.target.value) ?? value)} tabIndex={-1} />
        <input
          id={`${id}-hex`}
          className="colorHexInput"
          value={text}
          maxLength={7}
          spellCheck={false}
          aria-invalid={!valid}
          onChange={(event) => {
            setText(event.target.value);
            const color = normalizeHex(event.target.value.startsWith("#") ? event.target.value : `#${event.target.value}`);
            if (color && event.target.value.replace("#", "").length === 6) onChange(color);
          }}
          onBlur={() => setText(value)}
        />
        {onReset && <button type="button" className="textButton" aria-label={resetLabel} title={resetLabel} onClick={onReset}>↺</button>}
      </div>
    </div>
  );
}

export function ThemeEditor({ initialTheme, isNew, takenNames, onDone }: {
  initialTheme: CustomTheme;
  isNew: boolean;
  takenNames: readonly string[];
  onDone: (saved?: CustomTheme) => void;
}) {
  const { t } = useI18n();
  const { preferences } = useAppearance();
  const [theme, setTheme] = useState<CustomTheme>(initialTheme);
  const [fixedContrast, setFixedContrast] = useState(false);
  const palette = useMemo(() => derivePalette(theme.base, theme.seeds, theme.overrides), [theme]);
  const checks = useMemo(() => contrastChecks(palette), [palette]);
  const name = sanitizeThemeName(theme.name);
  const nameTaken = takenNames.some((taken) => taken.toLowerCase() === name.toLowerCase());
  const failing = checks.filter((check) => !check.passes).length;

  // Every edit shows live across the app; leaving without saving restores the saved theme.
  useEffect(() => { previewTheme(theme); }, [theme]);
  useEffect(() => { if (failing) setFixedContrast(false); }, [failing]);

  function setSeed(seed: ThemeSeed, value: Hex) {
    setTheme((current) => ({ ...current, seeds: { ...current.seeds, [seed]: value } }));
  }

  function setOverride(token: AdvancedThemeToken, value: Hex | undefined) {
    setTheme((current) => {
      const overrides = { ...current.overrides };
      if (value) overrides[token] = value;
      else delete overrides[token];
      return { ...current, overrides };
    });
  }

  function changeBase(base: ThemeBase) {
    if (base === theme.base) return;
    // Backgrounds from the other base make no sense; start from that base's defaults and carry the accent across.
    const defaults = BUILT_IN_THEMES.find((candidate) => candidate.id === DEFAULT_THEME_ID[base])!.seeds;
    const preset = ACCENT_PRESETS.find((candidate) => candidate[theme.base] === theme.seeds.accent);
    setTheme((current) => ({ ...current, base, seeds: { ...defaults, accent: preset ? preset[base] : current.seeds.accent }, overrides: {} }));
  }

  function setTypographyOverride(field: "uiFontSize" | "codeFontSize", value: number | undefined) {
    setTheme((current) => {
      const typography = { ...current.typography };
      if (value === undefined) delete typography[field];
      else typography[field] = value;
      const next: CustomTheme = { ...current, typography };
      if (!Object.keys(typography).length) delete next.typography;
      return next;
    });
  }

  function setStyleOverride(field: StyleField, value: string) {
    setTheme((current) => {
      const style: Partial<Record<StyleField, string>> = { ...current.style };
      if (value) style[field] = value;
      else delete style[field];
      const next: CustomTheme = { ...current, style: style as Partial<ThemeStyle> };
      if (!Object.keys(style).length) delete next.style;
      return next;
    });
  }

  function fixReadability() {
    setTheme(fixContrast);
    setFixedContrast(true);
  }

  function cancel() {
    previewTheme(undefined);
    onDone();
  }

  function save() {
    const saved = { ...theme, name };
    saveCustomTheme(saved);
    onDone(saved);
  }

  return (
    <div className="themeEditor" role="group" aria-labelledby="theme-editor-title">
      <div className="settingsSectionHeading">
        <div className="settingsRowText">
          <span id="theme-editor-title">{isNew ? t("editor.newTitle") : t("editor.editTitle", { name: initialTheme.name })}</span>
          <p>{t("editor.livePreview")}</p>
        </div>
      </div>

      <div className="settingsFieldGrid">
        <label>{t("editor.name")}
          <input value={theme.name} maxLength={THEME_NAME_MAX_LENGTH} aria-invalid={!name || nameTaken} onChange={(event) => setTheme((current) => ({ ...current, name: event.target.value }))} autoFocus />
          {nameTaken && <span className="fieldError">{t("editor.nameTaken")}</span>}
        </label>
        <div className="settingsFieldStack">
          <span id="theme-editor-base">{t("editor.base")}</span>
          <div className="segmentedControl" role="radiogroup" aria-labelledby="theme-editor-base">
            {(["dark", "light"] as const).map((base) => (
              <label key={base} className={theme.base === base ? "selected" : undefined}>
                <input type="radio" name="theme-editor-base" value={base} checked={theme.base === base} onChange={() => changeBase(base)} />
                <span>{t(base === "dark" ? "appearance.baseDark" : "appearance.baseLight")}</span>
              </label>
            ))}
          </div>
          <span className="settingsHint">{t("editor.baseHelp")}</span>
        </div>
      </div>

      <fieldset className="themeEditorGroup">
        <legend>{t("editor.accent")}</legend>
        <div className="accentPresets">
          {ACCENT_PRESETS.map((preset) => {
            const color = preset[theme.base];
            return (
              <button
                key={preset.id}
                type="button"
                className="accentSwatch"
                style={{ background: color }}
                aria-pressed={theme.seeds.accent === color}
                aria-label={t(`editor.accent.${preset.id}`)}
                title={t(`editor.accent.${preset.id}`)}
                onClick={() => setSeed("accent", color)}
              />
            );
          })}
          <ColorField id="theme-seed-accent" label={t("editor.seed.accent")} pickerLabel={t("editor.picker", { label: t("editor.seed.accent") })} value={theme.seeds.accent} onChange={(value) => setSeed("accent", value)} />
        </div>
      </fieldset>

      <fieldset className="themeEditorGroup">
        <legend>{t("editor.colors")}</legend>
        <div className="colorFieldGrid">
          {THEME_SEEDS.filter((seed) => seed !== "accent").map((seed) => (
            <ColorField key={seed} id={`theme-seed-${seed}`} label={t(`editor.seed.${seed}`)} pickerLabel={t("editor.picker", { label: t(`editor.seed.${seed}`) })} value={theme.seeds[seed]} onChange={(value) => setSeed(seed, value)} />
          ))}
        </div>
      </fieldset>

      <details className="themeEditorGroup themeEditorAdvanced">
        <summary>{t("editor.advanced", { count: Object.keys(theme.overrides).length })}</summary>
        <p className="settingsHint">{t("editor.advancedHelp")}</p>
        {TOKEN_GROUPS.map((group) => (
          <section className="themeTokenGroup" key={group.id} aria-labelledby={`theme-token-group-${group.id}`}>
            <h4 id={`theme-token-group-${group.id}`}>{t(`editor.group.${group.id}`)}</h4>
            {group.id === "graph" && <p className="settingsHint">{t("editor.group.graphHelp")}</p>}
            <div className="colorFieldGrid">
              {group.tokens.map((token: AdvancedThemeToken) => (
                <ColorField
                  key={token}
                  id={`theme-token-${token}`}
                  label={t(`editor.token.${token}`)}
                  pickerLabel={t("editor.picker", { label: t(`editor.token.${token}`) })}
                  value={palette[token]}
                  pinned={Boolean(theme.overrides[token])}
                  onChange={(value) => setOverride(token, value)}
                  onReset={theme.overrides[token] ? () => setOverride(token, undefined) : undefined}
                  resetLabel={t("editor.resetToken", { label: t(`editor.token.${token}`) })}
                />
              ))}
            </div>
          </section>
        ))}
      </details>

      <fieldset className="themeEditorGroup">
        <legend>{t("editor.text")}</legend>
        <div className="settingsFieldGrid">
          {([["uiFontSize", UI_FONT_SIZES, "appearance.uiFontSize"], ["codeFontSize", CODE_FONT_SIZES, "appearance.codeFontSize"]] as const).map(([field, limits, label]) => (
            <label key={field}>{t(label)}
              <SearchableSelect
                value={theme.typography?.[field] ?? ""}
                onChange={(event) => setTypographyOverride(field, event.target.value ? Number(event.target.value) : undefined)}
              >
                <option value="">{t("editor.useGlobalSize")}</option>
                {Array.from({ length: limits.max - limits.min + 1 }, (_, index) => limits.min + index).map((size) => <option key={size} value={size}>{t("appearance.size", { size })}</option>)}
              </SearchableSelect>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="themeEditorGroup">
        <legend>{t("editor.style")}</legend>
        <div className="settingsFieldGrid">
          {STYLE_FIELDS.map((field) => (
            <label key={field}>{t(`appearance.style.${field}`)}
              <SearchableSelect value={theme.style?.[field] ?? ""} onChange={(event) => setStyleOverride(field, event.target.value)}>
                <option value="">{t("editor.useGlobalStyle", { value: t(styleOptionKey(field, preferences.style[field])) })}</option>
                {(STYLE_OPTIONS[field] as readonly ThemeStyle[typeof field][]).map((value) => <option key={value} value={value}>{t(styleOptionKey(field, value))}</option>)}
              </SearchableSelect>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="themeEditorPreview" aria-hidden="true">
        <div className="themePreviewRow"><span className="themePreviewBadge" style={{ color: palette.gitModified }}>M</span><span>src/app/App.tsx</span></div>
        <div className="themePreviewRow"><span className="themePreviewBadge" style={{ color: palette.gitAdded }}>A</span><span>src/features/settings/model/themes.ts</span></div>
        <div className="themePreviewRow"><span className="themePreviewBadge" style={{ color: palette.gitDeleted }}>D</span><span>src/legacy/theme.css</span></div>
        <div className="themePreviewRow"><span className="themePreviewBadge" style={{ color: palette.gitConflicted }}>U</span><span className="themePreviewMuted">README.md</span></div>
        <div className="themePreviewCode" style={{ background: palette.surface }}>
          <div><span style={{ color: palette.syntaxComment }}>{`// ${t("editor.group.syntax")}`}</span></div>
          <div><span style={{ color: palette.syntaxKeyword }}>export function</span> load(user: <span style={{ color: palette.syntaxType }}>User</span>) {"{"}</div>
          <div>{"  "}<span style={{ color: palette.syntaxKeyword }}>return</span> {"{ "}<span style={{ color: palette.syntaxTag }}>name</span>: <span style={{ color: palette.syntaxString }}>&quot;dark&quot;</span>, <span style={{ color: palette.syntaxTag }}>size</span>: <span style={{ color: palette.syntaxNumber }}>13</span>{" };"}</div>
          <div>{"}"}</div>
        </div>
        <div className="themePreviewLanes">
          {TOKEN_GROUPS[3].tokens.map((token) => <span key={token} style={{ background: palette[token] }} />)}
        </div>
        <div className="themePreviewButtons"><span className="primaryButton">{t("editor.previewPrimary")}</span><span className="secondaryButton">{t("editor.previewSecondary")}</span><span className="themePreviewLink">{t("editor.previewLink")}</span></div>
      </div>

      <div className="contrastReport" aria-live="polite">
        <div className="contrastSummaryRow">
          <p className={failing ? "contrastSummary warn" : "contrastSummary"}>{failing ? t("editor.contrastFailing", { count: failing }) : fixedContrast ? t("editor.fixContrastDone") : t("editor.contrastOk")}</p>
          {failing > 0 && <button type="button" className="secondaryButton compact" onClick={fixReadability}>{t("editor.fixContrast")}</button>}
        </div>
        <ul>
          {checks.map((check) => (
            <li key={check.id} className={check.passes ? "pass" : "fail"}>
              <span>{t(`editor.check.${check.id}`)}</span>
              <span>{t(check.passes ? "editor.checkPass" : "editor.checkFail", { ratio: check.ratio.toFixed(2), minimum: check.minimum })}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="settingsActions">
        <button type="button" className="primaryButton" disabled={!name || nameTaken} onClick={save}>{isNew ? t("editor.create") : t("editor.save")}</button>
        <button type="button" className="secondaryButton" onClick={cancel}>{t("editor.cancel")}</button>
      </div>
    </div>
  );
}
