import { useI18n } from "../../../shared/i18n";
import { useState } from "react";
import { httpsHostFromRemote } from "../../../shared/lib/https-remote-host";
import { useDialogFocus } from "../../../shared/hooks/use-dialog-focus";

interface CloneDialogProps {
  initialRemoteUrl?: string;
  initialDirectoryName?: string;
  parentPath?: string;
  error: string;
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
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(onClose, busy);
  const [remoteUrl, setRemoteUrl] = useState(initialRemoteUrl);
  const [directoryName, setDirectoryName] = useState(initialDirectoryName || folderFromRemote(initialRemoteUrl));
  const [folderEdited, setFolderEdited] = useState(Boolean(initialDirectoryName));
  const [selectedParent, setSelectedParent] = useState(parentPath || "");
  const [parentError, setParentError] = useState("");

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
    <div className="paletteBackdrop cloneBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section ref={dialogRef} className="cloneDialog" role="dialog" aria-modal="true" aria-labelledby="clone-title" onKeyDown={onKeyDown}>
        <div className="taskCenterHeader"><div><p className="sectionEyebrow">{t("clone.eyebrow")}</p><h2 id="clone-title">{t("clone.title")}</h2></div><button className="quietButton compact" type="button" disabled={busy} onClick={onClose} aria-label={t("clone.closeAria")}>{t("common.close")}</button></div>
        <div className="cloneFormBody">
          <label className="cloneField">{t("clone.remoteUrl")}<input autoFocus data-dialog-initial-focus value={remoteUrl} onChange={(event) => { setRemoteUrl(event.target.value); if (!folderEdited) setDirectoryName(folderFromRemote(event.target.value)); }} placeholder="https://host/owner/repository.git" autoComplete="url" /></label>
          <div className="cloneSignIn"><p className="cloneHelp">{t("clone.credHelp")}</p><button className="textButton" type="button" disabled={busy} onClick={() => onManageAccounts({ remoteUrl: remoteUrl.trim(), parentPath: selectedParent, directoryName: directoryName.trim() }, credentialHost ? [credentialHost] : [])}>{t("clone.manageAccounts")}</button></div>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); onSubmit(remoteUrl.trim(), selectedParent, directoryName.trim()); }}>
          <div className="cloneFormBody">
          <label className="cloneField">{t("clone.folderName")}<input value={directoryName} onChange={(event) => { setDirectoryName(event.target.value); setFolderEdited(true); }} placeholder={inferredFolder || t("clone.folderPlaceholder")} /></label>
          <div className="cloneDestination"><div><strong>{t("clone.location")}</strong><small>{selectedParent || t("clone.chooseParentHint")}</small></div><button className="secondaryButton" type="button" disabled={busy} onClick={() => void chooseParent()}>{t("clone.chooseFolder")}</button></div>
          {(error || parentError) && <p className="taskCenterError" role="alert">{error || parentError}</p>}
          </div>
          <div className="cloneDialogActions"><button className="quietButton" type="button" disabled={busy} onClick={onClose}>{t("common.cancel")}</button><button className="primaryButton" type="submit" disabled={busy || !remoteUrl.trim() || !directoryName.trim() || !selectedParent}>{busy ? t("clone.starting") : t("clone.start")}</button></div>
        </form>
      </section>
    </div>
  );
}
