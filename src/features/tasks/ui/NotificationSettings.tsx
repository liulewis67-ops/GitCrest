import { getGitCrestBridge } from "../../../api/bridge";
import { useI18n } from "../../../shared/i18n";
import { setNotificationsEnabled, useNotificationsEnabled } from "../model/notification-preferences";

/** Whether the desktop app raises a system notification when a long task ends in the background. */
export function NotificationSettings() {
  const { t } = useI18n();
  const enabled = useNotificationsEnabled();
  const available = Boolean(getGitCrestBridge()?.showNotification);
  return <>
    <div className="settingsRow">
      <div className="settingsRowText"><span>{t("notify.title")}</span><p>{t("notify.description")}</p></div>
    </div>
    <div className="identityEditor">
      <label className="settingsCheck"><input type="checkbox" checked={enabled} disabled={!available} onChange={(event) => setNotificationsEnabled(event.target.checked)} />{t("notify.enabled")}</label>
      {!available && <p className="cloneHelp">{t("tools.desktopOnly")}</p>}
    </div>
  </>;
}
