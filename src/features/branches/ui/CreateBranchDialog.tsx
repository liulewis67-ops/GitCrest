import { MetaList } from "../../../shared/ui/MetaList";
import { Button } from "../../../shared/ui/Button";
import { Dialog, DialogHeader, DialogFooter } from "../../../shared/ui/Dialog";
import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { useState } from "react";
import { type GitCrestApiClient, type TaskSnapshotResponse } from "../../../api/client";
import { useI18n } from "../../../shared/i18n";
import { LocalFilesPicker } from "./LocalFilesPicker";
import { useWorktreeFolderCheck, worktreeFolderProblemMessage } from "../model/use-worktree-folder-check";
import { isAbsoluteFolder, rememberCopyFiles, rememberWorktreeParent, suggestWorktreePath, worktreePathInParent } from "../model/worktree-path";

type Placement = "switch" | "stay" | "worktree";

/** Creates a branch that starts at a chosen commit: switch to it, leave HEAD alone, or check it out in a new worktree. */
export function CreateBranchDialog({ api, repoId, repositoryPath, startOid, worktreeFrom, disabled, onChooseFolder, onClose, onStarted }: {
  api: GitCrestApiClient;
  repoId: string;
  repositoryPath?: string;
  startOid: string;
  /** Names what `startOid` is, such as the current branch; the dialog then only creates a new worktree. */
  worktreeFrom?: string;
  disabled: boolean;
  onChooseFolder?: () => Promise<string | undefined>;
  onClose: () => void;
  onStarted: (task: TaskSnapshotResponse) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [placement, setPlacement] = useState<Placement>(worktreeFrom ? "worktree" : "switch");
  const [worktreePath, setWorktreePath] = useState("");
  const [worktreeEdited, setWorktreeEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copyFiles, setCopyFiles] = useState<string[]>([]);
  const [error, setError] = useState<DisplayError>("");

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
      setError(describeApiError(reason, t("cb.createFailed")));
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

  return <Dialog className="taskCenter workflowDialog" role="dialog" aria-labelledby="create-branch-title" onClose={onClose} busy={busy} closeLabel={t("cb.close")}>
      <DialogHeader className="taskCenterHeader">
        <div><h2 id="create-branch-title">{worktreeFrom ? t("cb.worktreeTitle", { name: worktreeFrom }) : t("cb.title")}</h2></div>

      </DialogHeader>
      <div className="workflowDialogBody">
        <div className="repositoryFact"><span>{t("cb.startsAt")}</span><strong className="monoText" title={startOid}><MetaList items={[worktreeFrom, startOid.slice(0, 12)]} /></strong></div>
        <label className="cloneField">{t("cb.name")}<input autoFocus data-dialog-initial-focus value={name} spellCheck={false} placeholder="feature/my-change" onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && ready) { event.preventDefault(); void submit(); } }} /></label>
        {worktreeFrom ? <p className="cloneHelp">{t("cb.worktreeHelp", { name: worktreeFrom })}</p> : <fieldset className="branchPlacement">
          <legend>{t("cb.after")}</legend>
          <label><input type="radio" name="branch-placement" checked={placement === "switch"} onChange={() => setPlacement("switch")} />{t("cb.switch")}</label>
          <label><input type="radio" name="branch-placement" checked={placement === "stay"} onChange={() => setPlacement("stay")} />{t("cb.stay")}</label>
          <label><input type="radio" name="branch-placement" checked={placement === "worktree"} onChange={() => setPlacement("worktree")} />{t("cb.worktree")}</label>
        </fieldset>}
        {placement === "switch" && <p className="cloneHelp">{t("cb.switchHelp")}</p>}
        {placement === "worktree" && <label className="branchWorktreeField">{t("cb.newWorktreeFolder")}
          <span className="branchWorktreeInput">
            <input value={worktreeEdited ? worktreePath : suggested} aria-label={t("cb.folderAria")} spellCheck={false} onChange={(event) => { setWorktreePath(event.target.value); setWorktreeEdited(true); }} />
            {onChooseFolder && <Button variant="secondary" type="button" onClick={() => void choose()}>{t("cb.browse")}</Button>}
          </span>
        </label>}
        {placement === "worktree" && <LocalFilesPicker api={api} repoId={repoId} selected={copyFiles} onChange={setCopyFiles} disabled={busy} />}
        {relativeFolder && <p className="taskCenterError" role="alert">{t("nw.fullPath")}</p>}
        {placement === "worktree" && folderProblem && <p className="taskCenterError" role="alert">{worktreeFolderProblemMessage(folderProblem)}</p>}
        {error && <p className="taskCenterError" role="alert"><ErrorMessage error={error} /></p>}
        <DialogFooter className="taskCenterActions">
          <Button variant="secondary" type="button" disabled={busy} onClick={onClose}>{t("cb.cancel")}</Button>
          <Button variant="primary" type="button" disabled={!ready} onClick={() => void submit()}>{busy ? t("cb.creating") : placement === "switch" ? t("cb.createSwitch") : placement === "worktree" ? t("cb.createWorktree") : t("cb.create")}</Button>
        </DialogFooter>
      </div>
    </Dialog>;
}
