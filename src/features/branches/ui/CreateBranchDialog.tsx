import { useState } from "react";
import { GitCrestApiError, type GitCrestApiClient, type TaskSnapshotResponse } from "../../../api/client";
import { useDialogFocus } from "../../../shared/hooks/use-dialog-focus";
import { useI18n } from "../../../shared/i18n";
import { LocalFilesPicker } from "./LocalFilesPicker";
import { useWorktreeFolderCheck, worktreeFolderProblemMessage } from "../model/use-worktree-folder-check";
import { isAbsoluteFolder, rememberCopyFiles, rememberWorktreeParent, suggestWorktreePath, worktreePathInParent } from "../model/worktree-path";

type Placement = "switch" | "stay" | "worktree";

/** Creates a branch that starts at a chosen commit: switch to it, leave HEAD alone, or check it out in a new worktree. */
export function CreateBranchDialog({ api, repoId, repositoryPath, startOid, disabled, onChooseFolder, onClose, onStarted }: {
  api: GitCrestApiClient;
  repoId: string;
  repositoryPath?: string;
  startOid: string;
  disabled: boolean;
  onChooseFolder?: () => Promise<string | undefined>;
  onClose: () => void;
  onStarted: (task: TaskSnapshotResponse) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [placement, setPlacement] = useState<Placement>("switch");
  const [worktreePath, setWorktreePath] = useState("");
  const [worktreeEdited, setWorktreeEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copyFiles, setCopyFiles] = useState<string[]>([]);
  const [error, setError] = useState("");
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(onClose, busy);
  const suggested = suggestWorktreePath(repositoryPath, name.trim());
  const folder = (worktreeEdited ? worktreePath : suggested).trim();
  const relativeFolder = placement === "worktree" && folder !== "" && !isAbsoluteFolder(folder);
  const folderProblem = useWorktreeFolderCheck(api, repoId, folder, placement === "worktree");
  const ready = name.trim() !== "" && (placement !== "worktree" || (folder !== "" && !relativeFolder && !folderProblem)) && !disabled && !busy;

  async function submit() {
    if (!ready) return;
    setBusy(true);
    setError("");
    try {
      const task = await api.createRepositoryBranch(repoId, name.trim(), {
        checkout: placement === "switch",
        startPoint: startOid,
        ...(placement === "worktree" ? { worktreePath: folder, copyFiles } : {}),
      });
      if (placement === "worktree") {
        rememberWorktreeParent(folder);
        rememberCopyFiles(repoId, copyFiles);
      }
      onStarted(task);
    } catch (reason) {
      setError(reason instanceof GitCrestApiError ? reason.body.error.message : reason instanceof Error ? reason.message : t("cb.createFailed"));
    } finally {
      setBusy(false);
    }
  }

  const choose = async () => {
    try {
      const parent = await onChooseFolder?.();
      if (!parent) return;
      setWorktreePath(worktreePathInParent(parent, suggested));
      setWorktreeEdited(true);
    } catch {
      /* the picker was dismissed or unavailable; keep the current folder */
    }
  };

  return <div className="paletteBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={dialogRef} className="taskCenter workflowDialog" role="dialog" aria-modal="true" aria-labelledby="create-branch-title" onKeyDown={onKeyDown}>
      <div className="taskCenterHeader">
        <div><p className="sectionEyebrow">{t("cb.eyebrow")}</p><h2 id="create-branch-title">{t("cb.title")}</h2></div>
        <button className="quietButton compact" type="button" disabled={busy} onClick={onClose}>{t("cb.close")}</button>
      </div>
      <div className="workflowDialogBody">
        <div className="repositoryFact"><span>{t("cb.startsAt")}</span><strong className="monoText" title={startOid}>{startOid.slice(0, 12)}</strong></div>
        <label className="cloneField">{t("cb.name")}<input autoFocus data-dialog-initial-focus value={name} spellCheck={false} placeholder="feature/my-change" onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && ready) { event.preventDefault(); void submit(); } }} /></label>
        <fieldset className="branchPlacement">
          <legend>{t("cb.after")}</legend>
          <label><input type="radio" name="branch-placement" checked={placement === "switch"} onChange={() => setPlacement("switch")} />{t("cb.switch")}</label>
          <label><input type="radio" name="branch-placement" checked={placement === "stay"} onChange={() => setPlacement("stay")} />{t("cb.stay")}</label>
          <label><input type="radio" name="branch-placement" checked={placement === "worktree"} onChange={() => setPlacement("worktree")} />{t("cb.worktree")}</label>
        </fieldset>
        {placement === "switch" && <p className="cloneHelp">{t("cb.switchHelp")}</p>}
        {placement === "worktree" && <label className="branchWorktreeField">{t("cb.newWorktreeFolder")}
          <span className="branchWorktreeInput">
            <input value={worktreeEdited ? worktreePath : suggested} aria-label={t("cb.folderAria")} spellCheck={false} onChange={(event) => { setWorktreePath(event.target.value); setWorktreeEdited(true); }} />
            {onChooseFolder && <button className="secondaryButton" type="button" onClick={() => void choose()}>{t("cb.browse")}</button>}
          </span>
        </label>}
        {placement === "worktree" && <LocalFilesPicker api={api} repoId={repoId} selected={copyFiles} onChange={setCopyFiles} disabled={busy} />}
        {relativeFolder && <p className="taskCenterError" role="alert">{t("nw.fullPath")}</p>}
        {placement === "worktree" && folderProblem && <p className="taskCenterError" role="alert">{worktreeFolderProblemMessage(folderProblem)}</p>}
        {error && <p className="taskCenterError" role="alert">{error}</p>}
        <div className="taskCenterActions">
          <button className="quietButton compact" type="button" disabled={busy} onClick={onClose}>{t("cb.cancel")}</button>
          <button className="primaryButton" type="button" disabled={!ready} onClick={() => void submit()}>{busy ? t("cb.creating") : placement === "switch" ? t("cb.createSwitch") : placement === "worktree" ? t("cb.createWorktree") : t("cb.create")}</button>
        </div>
      </div>
    </section>
  </div>;
}
