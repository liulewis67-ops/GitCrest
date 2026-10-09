import { useRef, useState } from "react";
import type { components } from "../../../api/schema";
import { useDialogFocus } from "../../../shared/hooks/use-dialog-focus";

type PushPreflight = components["schemas"]["PushPreflight"];

interface PushDialogProps {
  snapshot?: PushPreflight;
  loading: boolean;
  busy: boolean;
  error: string;
  disabled: boolean;
  disabledReason: string;
  forceWithLeaseOnly?: boolean;
  onRefresh: () => void;
  onFetch: () => void;
  onPush: (forceWithLease: boolean) => void;
  onClose: () => void;
}

export function PushDialog({ snapshot, loading, busy, error, disabled, disabledReason, forceWithLeaseOnly = false, onRefresh, onFetch, onPush, onClose }: PushDialogProps) {
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(onClose, busy);
  const forceButtonRef = useRef<HTMLButtonElement>(null);
  const [confirmLease, setConfirmLease] = useState(false);
  const forceAvailable = Boolean(snapshot && snapshot.ahead > 0 && (snapshot.behind > 0 || forceWithLeaseOnly));
  const activeSnapshot = snapshot;

  return (
    <div className="paletteBackdrop pushBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section ref={dialogRef} className="cloneDialog pushDialog" role="dialog" aria-modal="true" aria-labelledby="push-dialog-title" onKeyDown={onKeyDown}>
        <header className="taskCenterHeader">
          <div><p className="sectionEyebrow">REVIEW REMOTE UPDATE</p><h2 id="push-dialog-title">Push current branch</h2></div>
          <button className="quietButton compact" type="button" disabled={busy} onClick={onClose} aria-label="Close push dialog">Close</button>
        </header>
        <div className="cloneFormBody pushDialogBody">
          {loading && <p role="status" className="cloneHelp">Checking the current upstream and push scope…</p>}
          {!loading && !snapshot && <p className="cloneHelp">A push preview is unavailable. Check the current branch and upstream configuration, then try again.</p>}
          {snapshot && <>
            <div className="pushTarget"><span>Target</span><strong>{snapshot.remoteName}/{snapshot.remoteBranch}</strong><small>{snapshot.localBranch} → {snapshot.remoteName}/{snapshot.remoteBranch}</small></div>
            <div className="pushCounts"><div><strong>{snapshot.ahead}</strong><span>commits to push</span></div><div><strong>{snapshot.behind}</strong><span>remote-only commits</span></div><div><strong>{snapshot.changedPathCount}</strong><span>changed paths</span></div></div>
            {snapshot.behind > 0 && <div className="pushWarning" role="alert"><strong>Fetch before a normal push.</strong><span>The remote has {snapshot.behind} commit{snapshot.behind === 1 ? "" : "s"} not present locally. Review the overwrite scope before using force-with-lease.</span><button className="textButton" type="button" disabled={busy || disabled} onClick={onFetch}>Fetch and review again</button></div>}
            {snapshot.ahead === 0 && <p className="cloneHelp">The local branch has no commits to push.</p>}
            {snapshot.commitsToPush.length > 0 && <section className="pushPreviewSection" aria-label="Commits to push"><h3>Commits to push</h3><ul>{snapshot.commitsToPush.map((commit) => <li key={commit.oid}><code>{commit.oid.slice(0, 8)}</code><span>{commit.subject || "(no subject)"}</span></li>)}</ul>{snapshot.ahead > snapshot.commitsToPush.length && <p className="cloneHelp">Showing {snapshot.commitsToPush.length} of {snapshot.ahead} commits.</p>}</section>}
            {snapshot.changedPaths.length > 0 && <section className="pushPreviewSection" aria-label="Changed paths"><h3>Changed paths ({snapshot.changedPathCount})</h3><ul>{snapshot.changedPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>{snapshot.omittedChangedPathCount > 0 && <p className="cloneHelp">{snapshot.omittedChangedPathCount} additional paths are omitted from this preview.</p>}</section>}
            {confirmLease && forceAvailable && activeSnapshot && <ForcePushConfirmation snapshot={activeSnapshot} busy={busy} disabled={disabled} returnFocus={() => forceButtonRef.current} onPush={() => { setConfirmLease(false); onPush(true); }} onCancel={() => setConfirmLease(false)} />}
          </>}
          {disabled && disabledReason && <p className="cloneHelp" role="note">{disabledReason}</p>}
          {error && <div className="taskCenterError" role="alert"><span>{error}</span><button className="textButton" type="button" disabled={busy || disabled} onClick={onRefresh}>Refresh preview</button></div>}
        </div>
        <footer className="cloneDialogActions">
          <button className="quietButton" type="button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="quietButton compact" type="button" disabled={busy || disabled || loading} onClick={onRefresh}>Refresh preview</button>
          {forceAvailable && !confirmLease && <button ref={forceButtonRef} className="dangerTextButton" type="button" disabled={busy || disabled} onClick={() => setConfirmLease(true)}>Force with lease…</button>}
          {snapshot && snapshot.ahead > 0 && snapshot.behind === 0 && !forceWithLeaseOnly && <button className="primaryButton" type="button" disabled={busy || disabled} onClick={() => onPush(false)}>{busy ? "Starting push…" : "Push"}</button>}
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
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLDivElement>(onCancel, busy, returnFocus);
  return <div ref={dialogRef} className="pushLeaseConfirmation" role="alertdialog" aria-label="Confirm force with lease" onKeyDown={onKeyDown}>
    <strong>{snapshot.behind > 0 ? "Replace remote-only commits?" : "Confirm lease-protected push?"}</strong>
    <p>{snapshot.behind > 0
      ? `This updates ${snapshot.remoteName}/${snapshot.remoteBranch}, replacing ${snapshot.overwrittenCommitCount} remote-only commit${snapshot.overwrittenCommitCount === 1 ? "" : "s"} across ${snapshot.changedPathCount} changed path${snapshot.changedPathCount === 1 ? "" : "s"}. The lease blocks the push if the remote moves from ${snapshot.expectedRemoteOid.slice(0, 8)}.`
      : `This updates ${snapshot.remoteName}/${snapshot.remoteBranch} only if its current tip still matches ${snapshot.expectedRemoteOid.slice(0, 8)}.`}</p>
    <div className="remoteInlineActions"><button className="dangerTextButton" type="button" disabled={busy || disabled} onClick={onPush}>Confirm force-with-lease</button><button className="textButton" type="button" disabled={busy} data-dialog-initial-focus onClick={onCancel}>Cancel</button></div>
  </div>;
}
