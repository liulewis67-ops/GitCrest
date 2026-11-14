import { MetaList } from "../../../shared/ui/MetaList";
import { Button } from "../../../shared/ui/Button";
import { Dialog, DialogHeader, DialogFooter } from "../../../shared/ui/Dialog";
import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { type DisplayError } from "../../../shared/i18n/api-errors";
import { useI18n } from "../../../shared/i18n";
import { useState } from "react";
import type { components } from "../../../api/schema";

type PullPreflight = components["schemas"]["PullPreflight"];
type PullStrategy = components["schemas"]["PullRequest"]["strategy"];

interface PullDialogProps {
  snapshot?: PullPreflight;
  loading: boolean;
  busy: boolean;
  error: DisplayError;
  disabled: boolean;
  disabledReason: string;
  onRefresh: () => void;
  onPull: (strategy: PullStrategy) => void;
  onClose: () => void;
}

export function PullDialog({ snapshot, loading, busy, error, disabled, disabledReason, onRefresh, onPull, onClose }: PullDialogProps) {
  const { t } = useI18n();

  const [strategy, setStrategy] = useState<PullStrategy>("merge");
  const canPull = Boolean(snapshot && !snapshot.hasConflicts && !snapshot.operationInProgress);

  return (
    <Dialog className="cloneDialog pushDialog" role="dialog" aria-labelledby="pull-dialog-title" onClose={onClose} busy={busy} closeLabel={t("pull.closeAria")} backdropClassName="pushBackdrop">
        <DialogHeader className="taskCenterHeader">
          <div><h2 id="pull-dialog-title">{t("pull.title")}</h2></div>

        </DialogHeader>
        <div className="cloneFormBody pushDialogBody">
          {loading && <p role="status" className="cloneHelp">{t("pull.checking")}</p>}
          {!loading && !snapshot && <p className="cloneHelp">{t("pull.unavailable")}</p>}
          {snapshot && <>
            <div className="pushTarget"><span>{t("pull.target")}</span><strong>{snapshot.remoteName}/{snapshot.remoteBranch}</strong><small><MetaList items={[snapshot.localBranch, t("pull.ahead", { count: snapshot.ahead }), t("pull.behind", { count: snapshot.behind })]} /></small></div>
            {(snapshot.hasConflicts || snapshot.operationInProgress) && <div className="pushWarning" role="alert"><strong>{t("pull.resolveFirst")}</strong><span>{snapshot.hasConflicts ? t("pull.conflicts") : ""}{snapshot.operationInProgress ? t("pull.opInProgress") : ""}</span></div>}
            {!snapshot.isClean && canPull && <p className="cloneHelp" role="status">{t("preserve.hint")}</p>}
            {snapshot.dirtyPaths.length > 0 && <section className="pushPreviewSection" aria-label={t("pull.blockingAria")}><h3>{t("pull.localPaths", { count: snapshot.dirtyPaths.length + snapshot.omittedDirtyPathCount })}</h3><ul>{snapshot.dirtyPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>{snapshot.omittedDirtyPathCount > 0 && <p className="cloneHelp">{t("pull.omitted", { count: snapshot.omittedDirtyPathCount })}</p>}</section>}
            <fieldset className="pullStrategy">
              <legend>{t("pull.strategy")}</legend>
              <label><input type="radio" name="pull-strategy" value="merge" checked={strategy === "merge"} disabled={busy} onChange={() => setStrategy("merge")} /><span><strong>{t("pull.merge")}</strong><small>{t("pull.mergeHint")}</small></span></label>
              <label><input type="radio" name="pull-strategy" value="rebase" checked={strategy === "rebase"} disabled={busy} onChange={() => setStrategy("rebase")} /><span><strong>{t("pull.rebase")}</strong><small>{t("pull.rebaseHint")}</small></span></label>
            </fieldset>
          </>}
          {disabled && disabledReason && <p className="cloneHelp" role="note">{disabledReason}</p>}
          {error && <div className="taskCenterError" role="alert"><span><ErrorMessage error={error} /></span><Button variant="quiet" type="button" disabled={busy || disabled} onClick={onRefresh}>{t("pull.refresh")}</Button></div>}
        </div>
        <DialogFooter className="cloneDialogActions">
          <Button variant="secondary" type="button" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="quiet" size="compact" type="button" disabled={busy || disabled || loading} onClick={onRefresh}>{t("pull.refresh")}</Button>
          <Button variant="primary" type="button" disabled={busy || disabled || loading || !canPull || !snapshot} onClick={() => onPull(strategy)}>{busy ? t("pull.starting") : strategy === "merge" ? t("pull.withMerge") : t("pull.withRebase")}</Button>
        </DialogFooter>
      </Dialog>
  );
}
