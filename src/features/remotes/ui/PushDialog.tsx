import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { type DisplayError } from "../../../shared/i18n/api-errors";
import { useI18n } from "../../../shared/i18n";
import { useRef, useState } from "react";
import type { components } from "../../../api/schema";
import { useDialogFocus } from "../../../shared/hooks/use-dialog-focus";

type PushPreflight = components["schemas"]["PushPreflight"];
export type PushTagsChoice = components["schemas"]["PushRequest"]["tags"];

interface PushDialogProps {
  snapshot?: PushPreflight;
  loading: boolean;
  busy: boolean;
  error: DisplayError;
  disabled: boolean;
  disabledReason: string;
  forceWithLeaseOnly?: boolean;
  onRefresh: () => void;
  onFetch: () => void;
  onPush: (forceWithLease: boolean, tags: PushTagsChoice) => void;
  onClose: () => void;
}

export function PushDialog({ snapshot, loading, busy, error, disabled, disabledReason, forceWithLeaseOnly = false, onRefresh, onFetch, onPush, onClose }: PushDialogProps) {
  const { t } = useI18n();
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(onClose, busy);
  const forceButtonRef = useRef<HTMLButtonElement>(null);
  const [confirmLease, setConfirmLease] = useState(false);
  const [tags, setTags] = useState<PushTagsChoice>("followTags");
  const forceAvailable = Boolean(snapshot && snapshot.ahead > 0 && (snapshot.behind > 0 || forceWithLeaseOnly));
  const activeSnapshot = snapshot;

  return (
    <div className="paletteBackdrop pushBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section ref={dialogRef} className="cloneDialog pushDialog" role="dialog" aria-modal="true" aria-labelledby="push-dialog-title" onKeyDown={onKeyDown}>
        <header className="taskCenterHeader">
          <div><p className="sectionEyebrow">{t("push.eyebrow")}</p><h2 id="push-dialog-title">{t("push.title")}</h2></div>
          <button className="quietButton compact" type="button" disabled={busy} onClick={onClose} aria-label={t("push.closeAria")}>{t("common.close")}</button>
        </header>
        <div className="cloneFormBody pushDialogBody">
          {loading && <p role="status" className="cloneHelp">{t("push.checking")}</p>}
          {!loading && !snapshot && <p className="cloneHelp">{t("push.unavailable")}</p>}
          {snapshot && <>
            <div className="pushTarget"><span>{t("pull.target")}</span><strong>{snapshot.remoteName}/{snapshot.remoteBranch}</strong><small>{snapshot.localBranch} → {snapshot.remoteName}/{snapshot.remoteBranch}</small></div>
            <div className="pushCounts"><div><strong>{snapshot.ahead}</strong><span>{t("push.commitsToPush")}</span></div><div><strong>{snapshot.behind}</strong><span>{t("push.remoteOnly")}</span></div><div><strong>{snapshot.changedPathCount}</strong><span>{t("push.changedPaths")}</span></div></div>
            {snapshot.behind > 0 && <div className="pushWarning" role="alert"><strong>{t("push.fetchBefore")}</strong><span>{snapshot.behind === 1 ? t("push.remoteHasOne", { count: snapshot.behind }) : t("push.remoteHasMany", { count: snapshot.behind })}</span><button className="textButton" type="button" disabled={busy || disabled} onClick={onFetch}>{t("push.fetchReview")}</button></div>}
            {snapshot.ahead === 0 && <p className="cloneHelp">{t("push.nothing")}</p>}
            <label className="rebaseTargetField">{t("push.tags")}
              <select value={tags} disabled={busy} onChange={(event) => setTags(event.target.value as PushTagsChoice)}>
                <option value="followTags">{t("push.tagsFollow")}</option>
                <option value="none">{t("push.tagsNone")}</option>
                <option value="all">{t("push.tagsAll")}</option>
              </select>
            </label>
            {snapshot.commitsToPush.length > 0 && <section className="pushPreviewSection" aria-label={t("push.commitsAria")}><h3>{t("push.commitsAria")}</h3><ul>{snapshot.commitsToPush.map((commit) => <li key={commit.oid}><code>{commit.oid.slice(0, 8)}</code><span>{commit.subject || t("push.noSubject")}</span></li>)}</ul>{snapshot.ahead > snapshot.commitsToPush.length && <p className="cloneHelp">{t("push.showing", { shown: snapshot.commitsToPush.length, total: snapshot.ahead })}</p>}</section>}
            {snapshot.changedPaths.length > 0 && <section className="pushPreviewSection" aria-label={t("push.pathsAria")}><h3>{t("push.pathsHeading", { count: snapshot.changedPathCount })}</h3><ul>{snapshot.changedPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>{snapshot.omittedChangedPathCount > 0 && <p className="cloneHelp">{t("push.omitted", { count: snapshot.omittedChangedPathCount })}</p>}</section>}
            {confirmLease && forceAvailable && activeSnapshot && <ForcePushConfirmation snapshot={activeSnapshot} busy={busy} disabled={disabled} returnFocus={() => forceButtonRef.current} onPush={() => { setConfirmLease(false); onPush(true, tags); }} onCancel={() => setConfirmLease(false)} />}
          </>}
          {disabled && disabledReason && <p className="cloneHelp" role="note">{disabledReason}</p>}
          {error && <div className="taskCenterError" role="alert"><span><ErrorMessage error={error} /></span><button className="textButton" type="button" disabled={busy || disabled} onClick={onRefresh}>{t("pull.refresh")}</button></div>}
        </div>
        <footer className="cloneDialogActions">
          <button className="quietButton" type="button" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
          <button className="quietButton compact" type="button" disabled={busy || disabled || loading} onClick={onRefresh}>{t("pull.refresh")}</button>
          {forceAvailable && !confirmLease && <button ref={forceButtonRef} className="dangerTextButton" type="button" disabled={busy || disabled} onClick={() => setConfirmLease(true)}>{t("push.forceLease")}</button>}
          {snapshot && snapshot.ahead > 0 && snapshot.behind === 0 && !forceWithLeaseOnly && <button className="primaryButton" type="button" disabled={busy || disabled} onClick={() => onPush(false, tags)}>{busy ? t("push.starting") : t("push.push")}</button>}
        </footer>
      </section>
    </div>
  );
}

function ForcePushConfirmation({ snapshot, busy, disabled, returnFocus, onPush, onCancel }: {
  snapshot: PushPreflight;
  busy: boolean;
  disabled: boolean;
  returnFocus: () => HTMLElement | null;
  onPush: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLDivElement>(onCancel, busy, returnFocus);
  const ref = `${snapshot.remoteName}/${snapshot.remoteBranch}`;
  return <div ref={dialogRef} className="pushLeaseConfirmation" role="alertdialog" aria-label={t("push.confirmAria")} onKeyDown={onKeyDown}>
    <strong>{snapshot.behind > 0 ? t("push.replaceQ") : t("push.confirmQ")}</strong>
    <p>{snapshot.behind > 0
      ? t(snapshot.overwrittenCommitCount === 1 ? "push.replaceOne" : "push.replaceMany", { ref, commits: snapshot.overwrittenCommitCount, paths: snapshot.changedPathCount, ps: snapshot.changedPathCount === 1 ? "" : "s", oid: snapshot.expectedRemoteOid.slice(0, 8) })
      : t("push.leaseOnly", { ref, oid: snapshot.expectedRemoteOid.slice(0, 8) })}</p>
    <div className="remoteInlineActions"><button className="dangerTextButton" type="button" disabled={busy || disabled} onClick={onPush}>{t("push.confirmForce")}</button><button className="textButton" type="button" disabled={busy} data-dialog-initial-focus onClick={onCancel}>{t("common.cancel")}</button></div>
  </div>;
}
