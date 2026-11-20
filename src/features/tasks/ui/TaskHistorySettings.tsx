import { useEffect, useState } from "react";
import type { GitCrestApiClient } from "../../../api/client";
import { Button } from "../../../shared/ui/Button";
import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { useI18n } from "../../../shared/i18n";

export function TaskHistorySettings({ api }: { api: GitCrestApiClient }) {
  const { t } = useI18n();
  const [days, setDays] = useState("15");
  const [savedDays, setSavedDays] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DisplayError>("");
  const [saved, setSaved] = useState(false);
  const valid = /^\d+$/.test(days) && Number(days) >= 1 && Number(days) <= 3650;

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const settings = await api.withSignal(controller.signal).getTaskSettings();
        if (!controller.signal.aborted) { setDays(String(settings.retentionDays)); setSavedDays(settings.retentionDays); }
      } catch (reason) {
        if (!controller.signal.aborted) setError(describeApiError(reason, t("tk.settingsLoadFailed")));
      }
    }
    void load();
    return () => controller.abort();
  }, [api]);

  async function save() {
    if (!valid || busy || savedDays === undefined) return;
    setBusy(true); setError(""); setSaved(false);
    try {
      const settings = await api.setTaskSettings(Number(days));
      setSavedDays(settings.retentionDays); setDays(String(settings.retentionDays)); setSaved(true);
    } catch (reason) { setError(describeApiError(reason, t("tk.settingsSaveFailed"))); }
    finally { setBusy(false); }
  }

  return <>
    <div className="settingsRow"><div className="settingsRowText"><span>{t("tk.retentionTitle")}</span><p>{t("tk.retentionHelp")}</p></div></div>
    <form className="identityEditor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label className="taskRetentionField"><span>{t("tk.retentionDays")}</span><input type="number" min={1} max={3650} step={1} required value={days} disabled={busy || savedDays === undefined} onChange={(event) => { setDays(event.target.value); setSaved(false); }} /></label>
      <Button variant="secondary" type="submit" disabled={!valid || busy || savedDays === undefined || Number(days) === savedDays}>{busy ? t("tk.savingSettings") : t("tk.saveSettings")}</Button>
      {saved && <p role="status" className="cloneHelp">{t("tk.settingsSaved")}</p>}
      {error && <p role="alert" className="taskCenterError"><ErrorMessage error={error} /></p>}
    </form>
  </>;
}
