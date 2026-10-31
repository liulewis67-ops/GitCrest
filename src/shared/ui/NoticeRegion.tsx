import { useI18n } from "../i18n";
import { ErrorMessage } from "./ErrorMessage";
import { dismissNotice, useNotices } from "../notices/notice-store";

/**
 * The one place notices appear and are announced. The live region is always in the page so that a
 * notice added later is read out; it never takes focus, and an action is just a button to reach.
 */
export function NoticeRegion() {
  const { t } = useI18n();
  const notices = useNotices();
  return <div className="noticeRegion" role="status" aria-live="polite" aria-atomic="false" aria-label={t("notice.region")}>
    {notices.map((notice) => <div className={`notice notice-${notice.kind}`} key={notice.id} data-kind={notice.kind}>
      <span className="noticeKind" aria-hidden="true">{notice.kind === "success" ? "✓" : notice.kind === "warning" ? "!" : "✕"}</span>
      <span className="noticeMessage"><span className="srOnly">{t(`notice.${notice.kind}`)}: </span><ErrorMessage error={notice.message} /></span>
      {notice.action && <button className="textButton" type="button" onClick={() => { const { run } = notice.action!; dismissNotice(notice.id); run(); }}>{notice.action.label}</button>}
      <button className="noticeDismiss" type="button" aria-label={t("notice.dismiss")} title={t("notice.dismiss")} onClick={() => dismissNotice(notice.id)}>×</button>
    </div>)}
  </div>;
}
