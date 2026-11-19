import { SearchableSelect } from "../../../shared/ui/SearchableSelect";
import { useI18n } from "../../../shared/i18n";
import {
  FETCH_INTERVAL_MINUTES,
  setRepositoryBackgroundFetch,
  updateBackgroundFetchPreferences,
  useBackgroundFetchPreferences,
} from "../model/background-fetch-preferences";

/** Whether and how often the open repository is fetched without being asked. */
export function BackgroundFetchSettings({ repoId }: { repoId?: string }) {
  const { t } = useI18n();
  const preferences = useBackgroundFetchPreferences();
  const repositoryOn = repoId ? !preferences.disabledRepositories.includes(repoId) : true;
  return <div className="identityEditor">
    <label className="settingsCheck"><input type="checkbox" checked={preferences.enabled} onChange={(event) => updateBackgroundFetchPreferences({ enabled: event.target.checked })} />{t("bf.enabled")}</label>
    <label className="settingsFieldStack backgroundFetchInterval">{t("bf.interval")}
      <SearchableSelect value={preferences.intervalMinutes} disabled={!preferences.enabled} onChange={(event) => updateBackgroundFetchPreferences({ intervalMinutes: Number(event.target.value) })}>
        {FETCH_INTERVAL_MINUTES.map((minutes) => <option key={minutes} value={minutes}>{t("bf.minutes", { count: minutes })}</option>)}
      </SearchableSelect>
    </label>
    {repoId && <label className="settingsCheck"><input type="checkbox" checked={repositoryOn} disabled={!preferences.enabled} onChange={(event) => setRepositoryBackgroundFetch(repoId, event.target.checked)} />{t("bf.thisRepository")}</label>}
    <p className="cloneHelp">{t("bf.help")}</p>
  </div>;
}
