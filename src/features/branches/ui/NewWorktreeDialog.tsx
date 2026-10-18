import { useState } from "react";
import { GitCrestApiError, type GitCrestApiClient, type TaskSnapshotResponse } from "../../../api/client";
import { useDialogFocus } from "../../../shared/hooks/use-dialog-focus";
import { useI18n } from "../../../shared/i18n";
import { LocalFilesPicker } from "./LocalFilesPicker";
import { useWorktreeFolderCheck, worktreeFolderProblemMessage } from "../model/use-worktree-folder-check";
import { isAbsoluteFolder, rememberCopyFiles, rememberWorktreeParent, suggestWorktreePath, worktreePathInParent } from "../model/worktree-path";

/** Checks an existing local branch out into a new worktree folder. */
export function NewWorktreeDialog({ api, repoId, repositoryPath, branch, fromRemote = false, disabled, onChooseFolder, onClose, onStarted }: {
  api: GitCrestApiClient;
  repoId: string;
  repositoryPath?: string;
  branch: string;
  /** `branch` is a remote-tracking branch such as origin/feature; a local tracking branch is created. */
  fromRemote?: boolean;
  disabled: boolean;
  onChooseFolder?: () => Promise<string | undefined>;
  onClose: () => void;
  onStarted: (task: TaskSnapshotResponse) => void;
}) {
  const { t } = useI18n();
  const localName = fromRemote ? branch.slice(branch.indexOf("/") + 1) : branch;
  const suggested = suggestWorktreePath(repositoryPath, localName);
  const [folder, setFolder] = useState(suggested);
  const [busy, setBusy] = useState(false);
  const [copyFiles, setCopyFiles] = useState<string[]>([]);
  const [error, setError] = useState("");
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(onClose, busy);
  const relative = folder.trim() !== "" && !isAbsoluteFolder(folder);
  const folderProblem = useWorktreeFolderCheck(api, repoId, folder, true);
  const ready = folder.trim() !== "" && !relative && !folderProblem && !disabled && !busy;

  async function submit() {
    if (!ready) return;
    setBusy(true);
    setError("");
    try {
      const task = await api.addRepositoryWorktree(repoId, branch, folder.trim(), fromRemote, copyFiles);
      rememberWorktreeParent(folder);
      rememberCopyFiles(repoId, copyFiles);
      onStarted(task);
    } catch (reason) {
      setError(reason instanceof GitCrestApiError ? reason.body.error.message : reason instanceof Error ? reason.message : t("nw.createFailed"));
    } finally {
      setBusy(false);
    }
  }

  const browse = async () => {
    try {
      const parent = await onChooseFolder?.();
      if (parent) setFolder(worktreePathInParent(parent, suggested || branch));
    } catch {
      /* the picker was dismissed or unavailable; keep the current folder */
    }
  };

  return <div className="paletteBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={dialogRef} className="taskCenter workflowDialog" role="dialog" aria-modal="true" aria-labelledby="new-worktree-title" onKeyDown={onKeyDown}>
      <div className="taskCenterHeader">
        <div><p className="sectionEyebrow">{t("nw.eyebrow")}</p><h2 id="new-worktree-title">{t("nw.title")}</h2></div>
        <button className="quietButton compact" type="button" disabled={busy} onClick={onClose}>{t("nw.close")}</button>
      </div>
      <div className="workflowDialogBody">
        <div className="repositoryFact"><span>{fromRemote ? t("nw.remoteBranch") : t("nw.branch")}</span><strong>{branch}</strong></div>
        {fromRemote && <p className="cloneHelp">{t("nw.localWillBeCreated", { name: localName, branch })}</p>}
        <label className="branchWorktreeField">{t("nw.folder")}
          <span className="branchWorktreeInput">
            <input autoFocus data-dialog-initial-focus value={folder} aria-label={t("nw.folder")} spellCheck={false} onChange={(event) => setFolder(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && ready) { event.preventDefault(); void submit(); } }} />
            {onChooseFolder && <button className="secondaryButton" type="button" onClick={() => void browse()}>{t("nw.browse")}</button>}
          </span>
        </label>
        <LocalFilesPicker api={api} repoId={repoId} selected={copyFiles} onChange={setCopyFiles} disabled={busy} />
        <p className="cloneHelp">{t("nw.help")}</p>
        {relative && <p className="taskCenterError" role="alert">{t("nw.fullPath")}</p>}
        {folderProblem && <p className="taskCenterError" role="alert">{worktreeFolderProblemMessage(folderProblem)}</p>}
        {error && <p className="taskCenterError" role="alert">{error}</p>}
        <div className="taskCenterActions">
          <button className="quietButton compact" type="button" disabled={busy} onClick={onClose}>{t("nw.cancel")}</button>
          <button className="primaryButton" type="button" disabled={!ready} onClick={() => void submit()}>{busy ? t("nw.creating") : t("nw.create")}</button>
        </div>
      </div>
    </section>
  </div>;
}
