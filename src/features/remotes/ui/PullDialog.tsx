import { useState } from "react";
import type { components } from "../../../api/schema";
import { useDialogFocus } from "../../../shared/use-dialog-focus";

type PullPreflight = components["schemas"]["PullPreflight"];
type PullStrategy = components["schemas"]["PullRequest"]["strategy"];

interface PullDialogProps {
  snapshot?: PullPreflight;
  loading: boolean;
  busy: boolean;
  error: string;
  disabled: boolean;
  disabledReason: string;
  onRefresh: () => void;
  onPull: (strategy: PullStrategy) => void;
  onClose: () => void;
}

export function PullDialog({ snapshot, loading, busy, error, disabled, disabledReason, onRefresh, onPull, onClose }: PullDialogProps) {
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(onClose, busy);
  const [strategy, setStrategy] = useState<PullStrategy>("merge");
  const canPull = Boolean(snapshot?.isClean && !snapshot.hasConflicts && !snapshot.operationInProgress);

  return (
    <div className="paletteBackdrop pushBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section ref={dialogRef} className="cloneDialog pushDialog" role="dialog" aria-modal="true" aria-labelledby="pull-dialog-title" onKeyDown={onKeyDown}>
        <header className="taskCenterHeader">
          <div><p className="sectionEyebrow">REVIEW BEFORE INTEGRATING</p><h2 id="pull-dialog-title">Pull current branch</h2></div>
          <button className="quietButton compact" type="button" disabled={busy} onClick={onClose} aria-label="Close pull dialog">Close</button>
        </header>
        <div className="cloneFormBody pushDialogBody">
          {loading && <p role="status" className="cloneHelp">Checking upstream, worktree changes, and Git operation state…</p>}
          {!loading && !snapshot && <p className="cloneHelp">A pull preview is unavailable. Check that the current branch has a fetched upstream, then try again.</p>}
          {snapshot && <>
            <div className="pushTarget"><span>Target</span><strong>{snapshot.remoteName}/{snapshot.remoteBranch}</strong><small>{snapshot.localBranch} · {snapshot.ahead} ahead · {snapshot.behind} behind</small></div>
            {!snapshot.isClean && <div className="pushWarning" role="alert"><strong>Resolve the worktree state before pulling.</strong><span>{snapshot.hasConflicts ? "Unresolved conflicts are present. " : ""}{snapshot.operationInProgress ? "Another Git operation is in progress. " : ""}Commit or otherwise resolve local changes, then review again.</span></div>}
            {snapshot.dirtyPaths.length > 0 && <section className="pushPreviewSection" aria-label="Local changes blocking pull"><h3>Local paths ({snapshot.dirtyPaths.length + snapshot.omittedDirtyPathCount})</h3><ul>{snapshot.dirtyPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>{snapshot.omittedDirtyPathCount > 0 && <p className="cloneHelp">{snapshot.omittedDirtyPathCount} additional paths are omitted from this preview.</p>}</section>}
            <fieldset className="pullStrategy">
              <legend>Integration strategy</legend>
              <label><input type="radio" name="pull-strategy" value="merge" checked={strategy === "merge"} disabled={busy} onChange={() => setStrategy("merge")} /><span><strong>Merge</strong><small>Keep local commits and create a merge commit when needed.</small></span></label>
              <label><input type="radio" name="pull-strategy" value="rebase" checked={strategy === "rebase"} disabled={busy} onChange={() => setStrategy("rebase")} /><span><strong>Rebase</strong><small>Replay local commits on top of the fetched upstream.</small></span></label>
            </fieldset>
          </>}
          {disabled && disabledReason && <p className="cloneHelp" role="note">{disabledReason}</p>}
          {error && <div className="taskCenterError" role="alert"><span>{error}</span><button className="textButton" type="button" disabled={busy || disabled} onClick={onRefresh}>Refresh preview</button></div>}
        </div>
        <footer className="cloneDialogActions">
          <button className="quietButton" type="button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="quietButton compact" type="button" disabled={busy || disabled || loading} onClick={onRefresh}>Refresh preview</button>
          <button className="primaryButton" type="button" disabled={busy || disabled || loading || !canPull || !snapshot} onClick={() => onPull(strategy)}>{busy ? "Starting pull…" : `Pull with ${strategy}`}</button>
        </footer>
      </section>
    </div>
  );
}
