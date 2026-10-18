import { useI18n } from "../../../shared/i18n";
import { useState } from "react";
import type { components } from "../../../api/schema";
import { useDialogFocus } from "../../../shared/hooks/use-dialog-focus";

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
  const { t } = useI18n();
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(onClose, busy);
  const [strategy, setStrategy] = useState<PullStrategy>("merge");
  const canPull = Boolean(snapshot?.isClean && !snapshot.hasConflicts && !snapshot.operationInProgress);

  return (
    <div className="paletteBackdrop pushBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section ref={dialogRef} className="cloneDialog pushDialog" role="dialog" aria-modal="true" aria-labelledby="pull-dialog-title" onKeyDown={onKeyDown}>
        <header className="taskCenterHeader">
          <div><p className="sectionEyebrow">{t("pull.eyebrow")}</p><h2 id="pull-dialog-title">{t("pull.title")}</h2></div>
          <button className="quietButton compact" type="button" disabled={busy} onClick={onClose} aria-label={t("pull.closeAria")}>{t("common.close")}</button>
        </header>
        <div className="cloneFormBody pushDialogBody">
          {loading && <p role="status" className="cloneHelp">{t("pull.checking")}</p>}
          {!loading && !snapshot && <p className="cloneHelp">{t("pull.unavailable")}</p>}
          {snapshot && <>
            <div className="pushTarget"><span>{t("pull.target")}</span><strong>{snapshot.remoteName}/{snapshot.remoteBranch}</strong><small>{snapshot.localBranch} · {t("pull.ahead", { count: snapshot.ahead })} · {t("pull.behind", { count: snapshot.behind })}</small></div>
            {!snapshot.isClean && <div className="pushWarning" role="alert"><strong>{t("pull.resolveFirst")}</strong><span>{snapshot.hasConflicts ? t("pull.conflicts") : ""}{snapshot.operationInProgress ? t("pull.opInProgress") : ""}{t("pull.commitOrResolve")}</span></div>}
            {snapshot.dirtyPaths.length > 0 && <section className="pushPreviewSection" aria-label={t("pull.blockingAria")}><h3>{t("pull.localPaths", { count: snapshot.dirtyPaths.length + snapshot.omittedDirtyPathCount })}</h3><ul>{snapshot.dirtyPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>{snapshot.omittedDirtyPathCount > 0 && <p className="cloneHelp">{t("pull.omitted", { count: snapshot.omittedDirtyPathCount })}</p>}</section>}
            <fieldset className="pullStrategy">
              <legend>{t("pull.strategy")}</legend>
              <label><input type="radio" name="pull-strategy" value="merge" checked={strategy === "merge"} disabled={busy} onChange={() => setStrategy("merge")} /><span><strong>{t("pull.merge")}</strong><small>{t("pull.mergeHint")}</small></span></label>
              <label><input type="radio" name="pull-strategy" value="rebase" checked={strategy === "rebase"} disabled={busy} onChange={() => setStrategy("rebase")} /><span><strong>{t("pull.rebase")}</strong><small>{t("pull.rebaseHint")}</small></span></label>
            </fieldset>
          </>}
          {disabled && disabledReason && <p className="cloneHelp" role="note">{disabledReason}</p>}
          {error && <div className="taskCenterError" role="alert"><span>{error}</span><button className="textButton" type="button" disabled={busy || disabled} onClick={onRefresh}>{t("pull.refresh")}</button></div>}
        </div>
        <footer className="cloneDialogActions">
          <button className="quietButton" type="button" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
          <button className="quietButton compact" type="button" disabled={busy || disabled || loading} onClick={onRefresh}>{t("pull.refresh")}</button>
          <button className="primaryButton" type="button" disabled={busy || disabled || loading || !canPull || !snapshot} onClick={() => onPull(strategy)}>{busy ? t("pull.starting") : strategy === "merge" ? t("pull.withMerge") : t("pull.withRebase")}</button>
        </footer>
      </section>
    </div>
  );
}
