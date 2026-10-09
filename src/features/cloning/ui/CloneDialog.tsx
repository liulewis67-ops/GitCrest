import { useState } from "react";
import { httpsHostFromRemote } from "../../../shared/lib/https-remote-host";
import type { CredentialEditorRenderer } from "../../../shared/ui/credential-editor-renderer";
import { useDialogFocus } from "../../../shared/hooks/use-dialog-focus";

interface CloneDialogProps {
  initialRemoteUrl?: string;
  initialDirectoryName?: string;
  parentPath?: string;
  error: string;
  busy: boolean;
  renderCredentialEditor: CredentialEditorRenderer;
  onChooseParent: () => Promise<string | undefined>;
  onClose: () => void;
  onSubmit: (remoteUrl: string, parentPath: string, directoryName: string) => void;
}

function folderFromRemote(remote: string): string {
  const normalized = remote.replace(/[?#].*$/, "").replace(/\/$/, "");
  return normalized.split(/[/:]/).pop()?.replace(/\.git$/i, "") || "";
}

export function CloneDialog({ initialRemoteUrl = "", initialDirectoryName = "", parentPath, error, busy, renderCredentialEditor, onChooseParent, onClose, onSubmit }: CloneDialogProps) {
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
      setParentError("Could not open the folder picker. Check the desktop window permissions and try again.");
    }
  }

  const inferredFolder = folderFromRemote(remoteUrl);
  const credentialHost = httpsHostFromRemote(remoteUrl);
  return (
    <div className="paletteBackdrop cloneBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section ref={dialogRef} className="cloneDialog" role="dialog" aria-modal="true" aria-labelledby="clone-title" onKeyDown={onKeyDown}>
        <div className="taskCenterHeader"><div><p className="sectionEyebrow">REMOTE REPOSITORY</p><h2 id="clone-title">Clone repository</h2></div><button className="quietButton compact" type="button" disabled={busy} onClick={onClose} aria-label="Close clone dialog">Close</button></div>
        <div className="cloneFormBody">
          <label className="cloneField">Remote URL<input autoFocus data-dialog-initial-focus value={remoteUrl} onChange={(event) => { setRemoteUrl(event.target.value); if (!folderEdited) setDirectoryName(folderFromRemote(event.target.value)); }} placeholder="https://host/owner/repository.git" autoComplete="url" /></label>
          <p className="cloneHelp">HTTPS credentials are stored in the system credential store; SSH uses your system SSH agent. Credentials in URLs are rejected.</p>
          {credentialHost && renderCredentialEditor(credentialHost, busy)}
        </div>
        <form onSubmit={(event) => { event.preventDefault(); onSubmit(remoteUrl.trim(), selectedParent, directoryName.trim()); }}>
          <div className="cloneFormBody">
          <label className="cloneField">Folder name<input value={directoryName} onChange={(event) => { setDirectoryName(event.target.value); setFolderEdited(true); }} placeholder={inferredFolder || "repository"} /></label>
          <div className="cloneDestination"><div><strong>Clone location</strong><small>{selectedParent || "Choose a parent folder"}</small></div><button className="secondaryButton" type="button" disabled={busy} onClick={() => void chooseParent()}>Choose folder</button></div>
          {(error || parentError) && <p className="taskCenterError" role="alert">{error || parentError}</p>}
          </div>
          <div className="cloneDialogActions"><button className="quietButton" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primaryButton" type="submit" disabled={busy || !remoteUrl.trim() || !directoryName.trim() || !selectedParent}>{busy ? "Starting clone…" : "Start clone"}</button></div>
        </form>
      </section>
    </div>
  );
}
