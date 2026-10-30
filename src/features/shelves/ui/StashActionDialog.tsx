import { useEffect, useState } from "react";
import {
  GitCrestApiError,
  type GitCrestApiClient,
  type StashEntryResponse,
  type StashPreviewResponse,
  type TaskSnapshotResponse,
} from "../../../api/client";
import { useDialogFocus } from "../../../shared/hooks/use-dialog-focus";
import { useI18n } from "../../../shared/i18n";

export type StashAction = "apply" | "pop" | "drop" | "import";

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof GitCrestApiError) return error.body.error.message;
  return error instanceof Error ? error.message : fallback;
}

/**
 * Reviews one change to a Git stash entry before it runs. Applying and popping name the files and
 * the local edits that block them; dropping names what is lost; importing saves a shelf first.
 */
export function StashActionDialog({ api, repoId, stash, action, disabled, onClose, onTaskStarted, onChanged }: {
  api: GitCrestApiClient;
  repoId: string;
  stash: StashEntryResponse;
  action: StashAction;
  /** Git operations cannot start now. */
  disabled: boolean;
  onClose: () => void;
  /** Apply or pop started as a background task. */
  onTaskStarted: (task: TaskSnapshotResponse) => void;
  /** The stash list or the shelves changed (drop or import finished). */
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(onClose, busy);
  const [preview, setPreview] = useState<StashPreviewResponse>();
  const [loading, setLoading] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [name, setName] = useState(stash.message || `stash@{${stash.index}}`);
  const [dropAfter, setDropAfter] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    api.withSignal(controller.signal).previewStash(repoId, stash.oid)
      .then((value) => { if (!controller.signal.aborted) setPreview(value); })
      .catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason, t("stash.previewFailed"))); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, repoId, stash.oid]);

  const needsConfirm = action === "drop";
  const applying = action === "apply" || action === "pop";
  const blocked = applying && preview ? !preview.canApply : false;
  const canRun = Boolean(preview) && !disabled && !blocked && (!needsConfirm || confirmed) && (action !== "import" || name.trim().length > 0);

  async function run() {
    setBusy(true);
    setError("");
    try {
      if (applying) {
        onTaskStarted(await api.applyStash(repoId, stash.oid, action === "pop", preview?.headOid ?? null));
      } else if (action === "drop") {
        await api.dropStash(repoId, stash.oid);
        onChanged();
      } else {
        await api.importStash(repoId, stash.oid, name.trim(), dropAfter);
        onChanged();
      }
    } catch (reason) {
      setError(errorMessage(reason, t("stash.actionFailed")));
    } finally {
      setBusy(false);
    }
  }

  const titleKey = action === "apply" ? "stash.dialogApply" : action === "pop" ? "stash.dialogPop" : action === "drop" ? "stash.dialogDrop" : "stash.dialogImport";
  const runKey = action === "apply" ? "stash.doApply" : action === "pop" ? "stash.doPop" : action === "drop" ? "stash.doDrop" : "stash.doImport";
  const label = stash.message || `stash@{${stash.index}}`;
  return <div className="paletteBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={dialogRef} className="cloneDialog stashActionDialog" role="dialog" aria-modal="true" aria-labelledby="stash-action-title" onKeyDown={onKeyDown}>
      <header className="taskCenterHeader">
        <div><h2 id="stash-action-title">{t(titleKey, { name: label })}</h2></div>
        <button className="quietButton compact" type="button" disabled={busy} onClick={onClose}>{t("common.close")}</button>
      </header>
      <div className="cloneFormBody">
        {loading && <p role="status" className="cloneHelp">{t("stash.loadingFiles")}</p>}
        {preview && <>
          <p className="cloneHelp">{t("stash.pathsHeading", { count: preview.paths.length + preview.omittedPathCount })}</p>
          <ul className="resetAffectedPaths">{preview.paths.map((path) => <li key={path} className="monoText">{path}</li>)}</ul>
          {preview.omittedPathCount > 0 && <p className="cloneHelp">{t("stash.pathsOmitted", { count: preview.omittedPathCount })}</p>}
        </>}
        {applying && preview?.operationInProgress && <p className="taskCenterError" role="alert">{t("stash.operationBlocks")}</p>}
        {applying && preview && preview.overlappingDirtyPaths.length > 0 && <div className="taskCenterError" role="alert">
          <strong>{t("stash.overlapBlocks")}</strong>
          <ul>{preview.overlappingDirtyPaths.map((path) => <li key={path} className="monoText">{path}</li>)}</ul>
        </div>}
        {action === "pop" && <p className="cloneHelp">{t("stash.popNote")}</p>}
        {action === "apply" && <p className="cloneHelp">{t("stash.applyNote")}</p>}
        {action === "drop" && <p className="pushWarning">{t("stash.dropWarning")}</p>}
        {action === "import" && <>
          <label className="rebaseTargetField">{t("stash.shelfName")}
            <input value={name} maxLength={120} disabled={busy} onChange={(event) => setName(event.target.value)} />
          </label>
          <p className="cloneHelp">{t("stash.importNote")}</p>
          <label className="rebaseConfirm"><input type="checkbox" checked={dropAfter} disabled={busy} onChange={(event) => setDropAfter(event.target.checked)} />{t("stash.dropAfterImport")}</label>
        </>}
        {needsConfirm && <label className="rebaseConfirm"><input type="checkbox" checked={confirmed} disabled={busy || !preview} onChange={(event) => setConfirmed(event.target.checked)} />{t("stash.confirmDrop")}</label>}
        {disabled && <p className="cloneHelp" role="note">{t("stash.busyNote")}</p>}
        {error && <p className="taskCenterError" role="alert">{error}</p>}
      </div>
      <footer className="cloneDialogActions">
        <button className="quietButton" type="button" disabled={busy} onClick={onClose}>{t("common.cancel")}</button>
        <button className={action === "drop" ? "dangerTextButton" : "primaryButton"} type="button" disabled={busy || !canRun} onClick={() => void run()}>{busy ? t("stash.working") : t(runKey)}</button>
      </footer>
    </section>
  </div>;
}
