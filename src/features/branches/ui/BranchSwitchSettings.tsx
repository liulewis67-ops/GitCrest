import { SearchableSelect } from "../../../shared/ui/SearchableSelect";
import { useState } from "react";
import { useI18n } from "../../../shared/i18n";
import { setBranchChangePolicy, useBranchChangePolicy, type BranchChangePolicy } from "../../../shared/preferences/branch-change-policy";

export function BranchSwitchSettings() {
  const { t } = useI18n();
  const policy = useBranchChangePolicy();
  const [error, setError] = useState(false);
  return <div className="settingsRow">
    <div className="settingsRowText"><span id="branch-change-policy-title">{t("bc.settingsTitle")}</span><p>{t("bc.settingsHelp")}</p>{error && <p className="dialogError" role="alert">{t("bc.saveFailed")}</p>}</div>
    <SearchableSelect aria-labelledby="branch-change-policy-title" value={policy} onChange={(event) => {
      try { setBranchChangePolicy(event.target.value as BranchChangePolicy); setError(false); }
      catch { setError(true); }
    }}>
      <option value="ask">{t("bc.ask")}</option>
      <option value="keep">{t("bc.keep")}</option>
      <option value="carry">{t("bc.carry")}</option>
    </SearchableSelect>
  </div>;
}
