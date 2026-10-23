import { useI18n, type MessageKey } from "../../../shared/i18n";
import { MOTION_PREFERENCES, setMotion, setStyle } from "../model/appearance-store";
import { STYLE_FIELDS, STYLE_OPTIONS, type StyleField, type ThemeDefinition, type ThemeStyle } from "../model/themes";
import { useAppearance } from "../model/use-theme-preference";

/** Message key for one style choice, e.g. `appearance.style.density.compact`. */
export function styleOptionKey<Field extends StyleField>(field: Field, value: ThemeStyle[Field]): MessageKey {
  return `appearance.style.${field}.${value}` as MessageKey;
}

function SegmentedChoice<Value extends string>({ name, labelId, options, value, label, onChange }: {
  name: string;
  labelId: string;
  options: readonly Value[];
  value: Value;
  label: (option: Value) => string;
  onChange: (option: Value) => void;
}) {
  return (
    <div className="segmentedControl" role="radiogroup" aria-labelledby={labelId}>
      {options.map((option) => (
        <label key={option} className={value === option ? "selected" : undefined}>
          <input type="radio" name={name} value={option} checked={value === option} onChange={() => onChange(option)} />
          <span>{label(option)}</span>
        </label>
      ))}
    </div>
  );
}

/** A small mock of a list, a menu and the commit graph, drawn with the live tokens so every style choice shows here too. */
function StylePreview() {
  const { t } = useI18n();
  const lanes = [
    { lane: 1, path: "M 14 0 V 120" },
    { lane: 2, path: "M 14 45 C 14 60, 34 60, 34 75 V 120" },
    { lane: 3, path: "M 34 75 C 34 90, 54 90, 54 105 V 120" },
  ];
  return (
    <div className="stylePreview" role="img" aria-label={t("appearance.stylePreview")}>
      <div className="stylePreviewGraph" aria-hidden="true">
        <svg className="commitGraphEdges" width="68" height="120" viewBox="0 0 68 120">
          {lanes.map(({ lane, path }) => <path key={lane} className={`graphLane${lane}`} d={path} />)}
        </svg>
        {[[1, 0], [1, 1], [2, 2], [3, 3]].map(([lane, row]) => (
          <span key={row} className={`commitGraphNode graphLane${lane}`} style={{ left: 9 + (lane - 1) * 20, top: 10 + row * 30 }} />
        ))}
      </div>
      <ul className="stylePreviewList" aria-hidden="true">
        <li className="selected"><span className="stylePreviewBar" style={{ width: "62%" }} /></li>
        <li><span className="stylePreviewBar" style={{ width: "48%" }} /></li>
        <li><span className="stylePreviewBar" style={{ width: "70%" }} /></li>
        <li><span className="stylePreviewBar" style={{ width: "40%" }} /></li>
      </ul>
      <div className="stylePreviewMenu" aria-hidden="true">
        <span className="stylePreviewBar" style={{ width: "80%" }} />
        <span className="stylePreviewBar" style={{ width: "56%" }} />
        <span className="stylePreviewButton" />
      </div>
    </div>
  );
}

export function StyleSettings({ themeName }: { themeName: (theme: ThemeDefinition) => string }) {
  const { t } = useI18n();
  const { preferences, activeTheme } = useAppearance();
  const themeOverrides = Object.keys(activeTheme.style ?? {}).length > 0;
  return (
    <div className="settingsCard">
      <div className="settingsSectionHeading">
        <div className="settingsRowText">
          <span>{t("appearance.style")}</span>
          <p>{themeOverrides ? t("appearance.styleThemeOverride", { name: themeName(activeTheme) }) : t("appearance.styleHelp")}</p>
        </div>
      </div>
      <div className="styleSettingsLayout">
        <div className="styleSettingsRows">
          {STYLE_FIELDS.map((field) => (
            <div className="settingsRow" key={field}>
              <div className="settingsRowText"><span id={`appearance-style-${field}`}>{t(`appearance.style.${field}`)}</span></div>
              <SegmentedChoice
                name={`settings-style-${field}`}
                labelId={`appearance-style-${field}`}
                options={STYLE_OPTIONS[field] as readonly ThemeStyle[typeof field][]}
                value={preferences.style[field]}
                label={(option) => t(styleOptionKey(field, option))}
                onChange={(option) => setStyle({ [field]: option } as Partial<ThemeStyle>)}
              />
            </div>
          ))}
          <div className="settingsRow">
            <div className="settingsRowText"><span id="appearance-motion-label">{t("appearance.motion")}</span><p>{t("appearance.motionHelp")}</p></div>
            <SegmentedChoice
              name="settings-motion"
              labelId="appearance-motion-label"
              options={MOTION_PREFERENCES}
              value={preferences.motion}
              label={(option) => t(`appearance.motion.${option}`)}
              onChange={setMotion}
            />
          </div>
        </div>
        <StylePreview />
      </div>
    </div>
  );
}
