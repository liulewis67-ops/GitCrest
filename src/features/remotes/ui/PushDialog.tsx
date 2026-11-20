import { SearchableSelect } from "../../../shared/ui/SearchableSelect";
import { Icon as UiIcon } from "../../../shared/ui/Icon";
import { Button } from "../../../shared/ui/Button";
import { Dialog, DialogHeader, DialogFooter } from "../../../shared/ui/Dialog";
import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { type DisplayError } from "../../../shared/i18n/api-errors";
import { useI18n } from "../../../shared/i18n";
import { useRef, useState } from "react";
import type { components } from "../../../api/schema";

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

  const forceButtonRef = useRef<HTMLButtonElement>(null);
  const [confirmLease, setConfirmLease] = useState(false);
  const [tags, setTags] = useState<PushTagsChoice>("followTags");
  const forceAvailable = Boolean(snapshot && snapshot.ahead > 0 && (snapshot.behind > 0 || forceWithLeaseOnly));
  const activeSnapshot = snapshot;

  return (
    <Dialog className="cloneDialog pushDialog" role="dialog" aria-labelledby="push-dialog-title" onClose={onClose} busy={busy} closeLabel={t("push.closeAria")} backdropClassName="pushBackdrop">
        <DialogHeader className="taskCenterHeader">
          <div><h2 id="push-dialog-title">{t("push.title")}</h2></div>

        </DialogHeader>
        <div className="cloneFormBody pushDialogBody">
          {loading && <p role="status" className="cloneHelp">{t("push.checking")}</p>}
          {!loading && !snapshot && <p className="cloneHelp">{t("push.unavailable")}</p>}
          {snapshot && <>
            <div className="pushTarget"><span>{t("pull.target")}</span><strong>{snapshot.remoteName}/{snapshot.remoteBranch}</strong><small>{snapshot.localBranch} <UiIcon name="arrowRight" />{snapshot.remoteName}/{snapshot.remoteBranch}</small></div>
            <div className="pushCounts"><div><strong>{snapshot.ahead}</strong><span>{t("push.commitsToPush")}</span></div><div><strong>{snapshot.behind}</strong><span>{t("push.remoteOnly")}</span></div><div><strong>{snapshot.changedPathCount}</strong><span>{t("push.changedPaths")}</span></div></div>
            {snapshot.behind > 0 && <div className="pushWarning" role="alert"><strong>{t("push.fetchBefore")}</strong><span>{snapshot.behind === 1 ? t("push.remoteHasOne", { count: snapshot.behind }) : t("push.remoteHasMany", { count: snapshot.behind })}</span><Button variant="primary" type="button" disabled={busy || disabled || loading} onClick={onFetch}>{t("push.fetchReview")}</Button></div>}
            {snapshot.ahead === 0 && <p className="cloneHelp">{t("push.nothing")}</p>}
            <details className="flowDisclosure"><summary>{t("ux.options")}</summary><div className="flowDisclosureBody"><label className="rebaseTargetField">{t("push.tags")}
              <SearchableSelect value={tags} disabled={busy} onChange={(event) => setTags(event.target.value as PushTagsChoice)}>
                <option value="followTags">{t("push.tagsFollow")}</option>
                <option value="none">{t("push.tagsNone")}</option>
                <option value="all">{t("push.tagsAll")}</option>
              </SearchableSelect>
            </label></div></details>
            {snapshot.commitsToPush.length > 0 && <section className="pushPreviewSection" aria-label={t("push.commitsAria")}><h3>{t("push.commitsAria")}</h3><ul>{snapshot.commitsToPush.map((commit) => <li key={commit.oid}><code>{commit.oid.slice(0, 8)}</code><span>{commit.subject || t("push.noSubject")}</span></li>)}</ul>{snapshot.ahead > snapshot.commitsToPush.length && <p className="cloneHelp">{t("push.showing", { shown: snapshot.commitsToPush.length, total: snapshot.ahead })}</p>}</section>}
            {snapshot.changedPaths.length > 0 && <details className="flowDisclosure pushPreviewSection" aria-label={t("push.pathsAria")}><summary>{t("push.pathsHeading", { count: snapshot.changedPathCount })}</summary><div className="flowDisclosureBody"><ul>{snapshot.changedPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>{snapshot.omittedChangedPathCount > 0 && <p className="cloneHelp">{t("push.omitted", { count: snapshot.omittedChangedPathCount })}</p>}</div></details>}
            {confirmLease && forceAvailable && activeSnapshot && <ForcePushConfirmation snapshot={activeSnapshot} busy={busy} disabled={disabled || loading} returnFocus={() => forceButtonRef.current} onPush={() => { setConfirmLease(false); onPush(true, tags); }} onCancel={() => setConfirmLease(false)} />}
          </>}
          {disabled && disabledReason && <p className="cloneHelp" role="note">{disabledReason}</p>}
          {error && <div className="taskCenterError" role="alert"><span><ErrorMessage error={error} /></span><Button variant="quiet" type="button" disabled={busy || disabled} onClick={onRefresh}>{t("pull.refresh")}</Button></div>}
        </div>
        <DialogFooter className="cloneDialogActions">
          <Button variant={snapshot?.ahead === 0 && snapshot.behind === 0 ? "primary" : "secondary"} type="button" disabled={busy} onClick={onClose}>{snapshot?.ahead === 0 && snapshot.behind === 0 ? t("ux.done") : t("common.cancel")}</Button>
          <Button variant="quiet" size="compact" type="button" disabled={busy || disabled || loading} onClick={onRefresh}>{t("pull.refresh")}</Button>
          {forceAvailable && !confirmLease && <Button ref={forceButtonRef} variant="danger" type="button" disabled={busy || disabled || loading} onClick={() => setConfirmLease(true)}>{t("push.forceLease")}</Button>}
          {snapshot && snapshot.ahead > 0 && snapshot.behind === 0 && !forceWithLeaseOnly && <Button variant="primary" type="button" disabled={busy || disabled || loading} onClick={() => onPush(false, tags)}>{busy ? t("push.starting") : t("push.push")}</Button>}
        </DialogFooter>
      </Dialog>
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

  const ref = `${snapshot.remoteName}/${snapshot.remoteBranch}`;
  return <Dialog inline className="pushLeaseConfirmation" role="alertdialog" aria-label={t("push.confirmAria")} onClose={onCancel} busy={busy} returnFocus={returnFocus}>
    <DialogHeader><h2>{snapshot.behind > 0 ? t("push.replaceQ") : t("push.confirmQ")}</h2></DialogHeader>
    <p>{snapshot.behind > 0
      ? t(snapshot.overwrittenCommitCount === 1 ? "push.replaceOne" : "push.replaceMany", { ref, commits: snapshot.overwrittenCommitCount, paths: snapshot.changedPathCount, ps: snapshot.changedPathCount === 1 ? "" : "s", oid: snapshot.expectedRemoteOid.slice(0, 8) })
      : t("push.leaseOnly", { ref, oid: snapshot.expectedRemoteOid.slice(0, 8) })}</p>
    <DialogFooter><Button variant="secondary" type="button" disabled={busy} data-dialog-initial-focus onClick={onCancel}>{t("common.cancel")}</Button><Button variant="danger" type="button" disabled={busy || disabled} onClick={onPush}>{t("push.confirmForce")}</Button></DialogFooter>
  </Dialog>;
}
