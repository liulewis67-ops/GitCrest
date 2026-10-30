import { useEffect, useRef, useState } from "react";
import { GitCrestApiError, type GitCrestApiClient, type ReflogPageResponse } from "../../../api/client";
import { useDialogFocus } from "../../../shared/hooks/use-dialog-focus";
import { useI18n } from "../../../shared/i18n";
import { formatCommitDate } from "./format-commit-date";

type Entry = ReflogPageResponse["entries"][number];
type Backup = ReflogPageResponse["backups"][number];

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof GitCrestApiError) return error.body.error.message;
  return error instanceof Error ? error.message : fallback;
}

/**
 * Where HEAD or a branch has been. Every row is a state that can still be reached: it can start a
 * branch, or be reviewed as a reset target through the usual preview, so nothing runs from here.
 */
export function ReflogDialog({ api, repoId, branchNames, disabled, onClose, onCreateBranch, onResetTo }: {
  api: GitCrestApiClient;
  repoId: string;
  /** Local branches whose own reflog can be read. */
  branchNames: readonly string[];
  /** Git operations cannot start now. */
  disabled: boolean;
  onClose: () => void;
  onCreateBranch: (oid: string) => void;
  onResetTo: (oid: string) => void;
}) {
  const { t } = useI18n();
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(onClose, false);
  const [reference, setReference] = useState("HEAD");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [backups, setBackups] = useState<Backup[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const requestRef = useRef(0);

  useEffect(() => {
    const request = ++requestRef.current;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api.withSignal(controller.signal).getRepositoryReflog(repoId, { ref: reference })
      .then((page) => {
        if (request !== requestRef.current) return;
        if (!Array.isArray(page.entries)) throw new Error(t("reflog.loadFailed"));
        setEntries(page.entries);
        setBackups(page.backups ?? []);
        setNextOffset(page.nextOffset);
      })
      .catch((reason) => {
        if (controller.signal.aborted || request !== requestRef.current) return;
        setEntries([]);
        setBackups([]);
        setNextOffset(null);
        setError(errorMessage(reason, t("reflog.loadFailed")));
      })
      .finally(() => { if (request === requestRef.current) setLoading(false); });
    return () => controller.abort();
  }, [api, repoId, reference, attempt]);

  async function loadMore() {
    if (nextOffset === null || loading) return;
    const request = requestRef.current;
    setLoading(true);
    try {
      const page = await api.getRepositoryReflog(repoId, { ref: reference, offset: nextOffset });
      if (request !== requestRef.current) return;
      setEntries((current) => [...current, ...page.entries]);
      setNextOffset(page.nextOffset);
    } catch (reason) {
      if (request === requestRef.current) setError(errorMessage(reason, t("reflog.loadFailed")));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }

  const actions = (oid: string) => <span className="reflogActions">
    <button className="textButton" type="button" disabled={disabled} title={disabled ? t("reflog.busy") : undefined} onClick={() => onCreateBranch(oid)}>{t("reflog.createBranch")}</button>
    <button className="textButton" type="button" disabled={disabled} title={disabled ? t("reflog.busy") : t("reflog.resetTitle")} onClick={() => onResetTo(oid)}>{t("reflog.reset")}</button>
  </span>;

  return <div className="paletteBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="cloneDialog reflogDialog" role="dialog" aria-modal="true" aria-labelledby="reflog-title" onKeyDown={onKeyDown}>
      <header className="taskCenterHeader">
        <div><p className="sectionEyebrow">{t("reflog.eyebrow")}</p><h2 id="reflog-title">{t("reflog.title")}</h2></div>
        <button className="quietButton compact" type="button" onClick={onClose}>{t("common.close")}</button>
      </header>
      <div className="cloneFormBody">
        <p className="cloneHelp">{t("reflog.help")}</p>
        <label className="rebaseTargetField">{t("reflog.ref")}
          <select value={reference} onChange={(event) => setReference(event.target.value)}>
            <option value="HEAD">HEAD</option>
            {branchNames.map((name) => <option key={name} value={`refs/heads/${name}`}>{name}</option>)}
          </select>
        </label>
        {error && <div className="statusLoadError" role="alert"><span>{error}</span><button type="button" onClick={() => setAttempt((value) => value + 1)}>{t("tags.retry")}</button></div>}
        {backups.length > 0 && <section aria-label={t("reflog.backups")}>
          <h3>{t("reflog.backups")}</h3>
          <ul className="reflogList">{backups.map((backup) => <li key={backup.reference}>
            <span className="commitRefBadge">{t(backup.kind === "rebase" ? "reflog.backupRebase" : "reflog.backupReset")}</span>
            <code>{backup.oid.slice(0, 9)}</code>
            <span className="reflogMessage" title={backup.subject}>{backup.subject || t("push.noSubject")}</span>
            <small>{formatCommitDate(backup.createdAtMs)}</small>
            {actions(backup.oid)}
          </li>)}</ul>
        </section>}
        <section aria-label={t("reflog.entries")}>
          <h3>{t("reflog.entries")}</h3>
          {loading && entries.length === 0 && <p role="status" className="cloneHelp">{t("reflog.loading")}</p>}
          {!loading && !error && entries.length === 0 && <p className="cloneHelp">{t("reflog.empty")}</p>}
          <ul className="reflogList">{entries.map((entry) => <li key={entry.selector}>
            <code title={entry.selector}>{entry.oid.slice(0, 9)}</code>
            <span className="reflogMessage" title={entry.message}>{entry.message}</span>
            <small>{formatCommitDate(entry.createdAtMs)}</small>
            {actions(entry.oid)}
          </li>)}</ul>
          {nextOffset !== null && <button className="quietButton compact" type="button" disabled={loading} onClick={() => void loadMore()}>{t("reflog.loadMore")}</button>}
        </section>
      </div>
    </section>
  </div>;
}
