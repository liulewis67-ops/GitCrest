import { useEffect, useRef, useState } from "react";
import { GitCrestApiError, type GitCrestApiClient, type SubmoduleListResponse, type TaskSnapshotResponse } from "../../../api/client";
import { useDialogFocus } from "../../../shared/hooks/use-dialog-focus";
import { useI18n } from "../../../shared/i18n";

type Entry = SubmoduleListResponse["items"][number];

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof GitCrestApiError) return error.body.error.message;
  return error instanceof Error ? error.message : fallback;
}

const short = (oid: string | null) => (oid ? oid.slice(0, 9) : null);

/**
 * The submodules a repository declares: the commit it records for each, the commit that is checked
 * out, and what to do about a difference. Opening one gives it its own tab; updating runs as a task.
 */
export function SubmodulesDialog({ api, repoId, disabled, onClose, onOpen, onStarted }: {
  api: GitCrestApiClient;
  repoId: string;
  /** Git operations cannot start now. */
  disabled: boolean;
  onClose: () => void;
  /** Opens a submodule's folder as a repository of its own. */
  onOpen: (path: string) => void;
  onStarted: (task: TaskSnapshotResponse) => void;
}) {
  const { t } = useI18n();
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(onClose, false);
  const [items, setItems] = useState<Entry[]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const requestRef = useRef(0);

  useEffect(() => {
    const request = ++requestRef.current;
    const controller = new AbortController();
    setError("");
    api.withSignal(controller.signal).listSubmodules(repoId)
      .then((list) => { if (request === requestRef.current) setItems(list.items); })
      .catch((reason) => {
        if (controller.signal.aborted || request !== requestRef.current) return;
        setItems([]);
        setError(errorMessage(reason, t("sm.loadFailed")));
      });
    return () => controller.abort();
  }, [api, repoId, attempt]);

  async function update(paths: string[], init: boolean) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      onStarted(await api.updateSubmodules(repoId, { paths, init }));
    } catch (reason) {
      setError(errorMessage(reason, t("sm.startFailed")));
    } finally {
      setBusy(false);
    }
  }

  const blocked = disabled || busy;
  const reasonFor = (entry: Entry, init: boolean) => disabled ? t("sm.busy")
    : entry.state === "conflicted" ? t("sm.conflictedBlock")
      : !init && entry.state === "upToDate" ? t("sm.upToDateBlock") : undefined;
  const anyUninitialized = items?.some((entry) => entry.state === "uninitialized") ?? false;
  const anyOutOfDate = items?.some((entry) => entry.state === "outOfDate") ?? false;

  return <div className="paletteBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="cloneDialog submodulesDialog" role="dialog" aria-modal="true" aria-labelledby="submodules-title" onKeyDown={onKeyDown}>
      <header className="taskCenterHeader">
        <div><p className="sectionEyebrow">{t("sm.eyebrow")}</p><h2 id="submodules-title">{t("sm.title")}</h2></div>
        <button className="quietButton compact" type="button" onClick={onClose}>{t("common.close")}</button>
      </header>
      <div className="cloneFormBody">
        <p className="cloneHelp">{t("sm.help")}</p>
        {error && <div className="statusLoadError" role="alert"><span>{error}</span><button type="button" onClick={() => setAttempt((value) => value + 1)}>{t("tags.retry")}</button></div>}
        {items === undefined && <p role="status" className="cloneHelp">{t("sm.loading")}</p>}
        {items?.length === 0 && !error && <p className="cloneHelp">{t("sm.empty")}</p>}
        {items && items.length > 0 && <>
          <ul className="submoduleList">{items.map((entry) => {
            const initReason = reasonFor(entry, true);
            const updateReason = reasonFor(entry, false);
            return <li key={entry.path}>
              <div className="submoduleHead">
                <strong title={entry.name}>{entry.path}</strong>
                <span className={`commitRefBadge submoduleState-${entry.state}`}>{t(`sm.state.${entry.state}`)}</span>
              </div>
              <dl className="signingFacts">
                <div><dt>{t("sm.recorded")}</dt><dd><code>{short(entry.recordedOid) ?? t("sm.none")}</code></dd></div>
                <div><dt>{t("sm.checkedOut")}</dt><dd><code>{short(entry.checkedOutOid) ?? t("sm.none")}</code></dd></div>
                {entry.committedOid !== entry.recordedOid && <div><dt>{t("sm.committed")}</dt><dd><code>{short(entry.committedOid) ?? t("sm.none")}</code></dd></div>}
                {entry.url && <div><dt>{t("sm.url")}</dt><dd title={entry.url}>{entry.url}</dd></div>}
              </dl>
              <div className="reflogActions">
                <button className="textButton" type="button" disabled={entry.state === "uninitialized"} title={entry.state === "uninitialized" ? t("sm.openNeedsClone") : undefined} onClick={() => onOpen(entry.path)}>{t("sm.open")}</button>
                {entry.state === "uninitialized"
                  ? <button className="textButton" type="button" disabled={blocked || Boolean(initReason)} title={initReason} onClick={() => void update([entry.path], true)}>{t("sm.init")}</button>
                  : <button className="textButton" type="button" disabled={blocked || Boolean(updateReason)} title={updateReason ?? t("sm.updateTitle")} onClick={() => void update([entry.path], false)}>{t("sm.update")}</button>}
              </div>
            </li>;
          })}</ul>
          <div className="cloneDialogActions">
            {anyUninitialized && <button className="quietButton" type="button" disabled={blocked} title={disabled ? t("sm.busy") : undefined} onClick={() => void update([], true)}>{t("sm.initAll")}</button>}
            <button className="primaryButton" type="button" disabled={blocked || !anyOutOfDate} title={disabled ? t("sm.busy") : !anyOutOfDate ? t("sm.upToDateBlock") : undefined} onClick={() => void update([], false)}>{t("sm.updateAll")}</button>
          </div>
        </>}
      </div>
    </section>
  </div>;
}
