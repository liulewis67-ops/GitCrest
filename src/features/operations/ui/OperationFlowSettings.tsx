import { useState } from "react";
import { useI18n } from "../../../shared/i18n";
import { setOperationFlowEnabled, useOperationFlowEnabled } from "../../../shared/preferences/operation-flow";

/** The opt-in for step-by-step protected operations; off by default and safe to turn off at any time. */
export function OperationFlowSettings() {
  const { t } = useI18n();
  const enabled = useOperationFlowEnabled();
  const [error, setError] = useState(false);
  return <>
    <div className="settingsRow">
      <div className="settingsRowText"><span>{t("of.title")}</span><p>{t("of.description")}</p></div>
    </div>
    <div className="identityEditor">
      <label className="settingsCheck">
        <input type="checkbox" checked={enabled} onChange={(event) => {
          try { setOperationFlowEnabled(event.target.checked); setError(false); } catch { setError(true); }
        }} />{t("of.enabled")}
      </label>
      {error && <p className="dialogError" role="alert">{t("of.saveFailed")}</p>}
    </div>
  </>;
}
