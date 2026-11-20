import { HelpDisclosure } from "../../../shared/ui/HelpDisclosure";
import { Button } from "../../../shared/ui/Button";
import { Dialog, DialogHeader, DialogFooter } from "../../../shared/ui/Dialog";
import { type DisplayError } from "../../../shared/i18n/api-errors";
import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { useI18n } from "../../../shared/i18n";
import { useState } from "react";
import { httpsHostFromRemote } from "../../../shared/lib/https-remote-host";

interface CloneDialogProps {
  initialRemoteUrl?: string;
  initialDirectoryName?: string;
  parentPath?: string;
  error: DisplayError;
  busy: boolean;
  onManageAccounts: (draft: { remoteUrl: string; parentPath: string; directoryName: string }, hosts: string[]) => void;
  onChooseParent: () => Promise<string | undefined>;
  onClose: () => void;
  onSubmit: (remoteUrl: string, parentPath: string, directoryName: string) => void;
}

function folderFromRemote(remote: string): string {
  const normalized = remote.replace(/[?#].*$/, "").replace(/\/$/, "");
  return normalized.split(/[/:]/).pop()?.replace(/\.git$/i, "") || "";
}

export function CloneDialog({ initialRemoteUrl = "", initialDirectoryName = "", parentPath, error, busy, onManageAccounts, onChooseParent, onClose, onSubmit }: CloneDialogProps) {
  const { t } = useI18n();

  const [remoteUrl, setRemoteUrl] = useState(initialRemoteUrl);
  const [directoryName, setDirectoryName] = useState(initialDirectoryName || folderFromRemote(initialRemoteUrl));
  const [folderEdited, setFolderEdited] = useState(Boolean(initialDirectoryName));
  const [selectedParent, setSelectedParent] = useState(parentPath || "");
  const [parentError, setParentError] = useState<DisplayError>("");

  async function chooseParent() {
    try {
      const selected = await onChooseParent();
      if (selected) { setSelectedParent(selected); setParentError(""); }
    } catch {
      setParentError(t("clone.parentFailed"));
    }
  }

  const inferredFolder = folderFromRemote(remoteUrl);
  const credentialHost = httpsHostFromRemote(remoteUrl);
  return (
    <Dialog className="cloneDialog" role="dialog" aria-labelledby="clone-title" onClose={onClose} busy={busy} closeLabel={t("clone.closeAria")} backdropClassName="cloneBackdrop">
        <DialogHeader className="taskCenterHeader"><div><h2 id="clone-title">{t("clone.title")}</h2></div></DialogHeader>
        <div className="cloneFormBody">
          <label className="cloneField">{t("clone.remoteUrl")}<input autoFocus data-dialog-initial-focus value={remoteUrl} onChange={(event) => { setRemoteUrl(event.target.value); if (!folderEdited) setDirectoryName(folderFromRemote(event.target.value)); }} placeholder="https://host/owner/repository.git" autoComplete="url" /></label>
          <div className="cloneSignIn"><HelpDisclosure>{t("clone.credHelp")}</HelpDisclosure><Button variant="quiet" type="button" disabled={busy} onClick={() => onManageAccounts({ remoteUrl: remoteUrl.trim(), parentPath: selectedParent, directoryName: directoryName.trim() }, credentialHost ? [credentialHost] : [])}>{t("clone.manageAccounts")}</Button></div>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); onSubmit(remoteUrl.trim(), selectedParent, directoryName.trim()); }}>
          <div className="cloneFormBody">
          <label className="cloneField">{t("clone.folderName")}<input value={directoryName} onChange={(event) => { setDirectoryName(event.target.value); setFolderEdited(true); }} placeholder={inferredFolder || t("clone.folderPlaceholder")} /></label>
          <div className="cloneDestination"><div><strong>{t("clone.location")}</strong><small>{selectedParent || t("clone.chooseParentHint")}</small></div><Button variant="secondary" type="button" disabled={busy} onClick={() => void chooseParent()}>{t("clone.chooseFolder")}</Button></div>
          {(error || parentError) && <p className="taskCenterError" role="alert"><ErrorMessage error={error || parentError} /></p>}
          </div>
          <DialogFooter className="cloneDialogActions"><Button variant="secondary" type="button" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button><Button variant="primary" type="submit" disabled={busy || !remoteUrl.trim() || !directoryName.trim() || !selectedParent}>{busy ? t("clone.starting") : t("clone.start")}</Button></DialogFooter>
        </form>
      </Dialog>
  );
}
