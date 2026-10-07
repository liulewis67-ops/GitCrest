import { useState } from "react";
import type { GitCrestApiClient } from "../../api/client";
import { CredentialEditor, httpsHostFromRemote } from "../credentials/CredentialEditor";

interface CloneDialogProps {
  initialRemoteUrl?: string;
  initialDirectoryName?: string;
  parentPath?: string;
  error: string;
  busy: boolean;
  api?: GitCrestApiClient;
  onChooseParent: () => Promise<string | undefined>;
  onClose: () => void;
  onSubmit: (remoteUrl: string, parentPath: string, directoryName: string) => void;
}

function folderFromRemote(remote: string): string {
  const normalized = remote.replace(/[?#].*$/, "").replace(/\/$/, "");
  return normalized.split(/[/:]/).pop()?.replace(/\.git$/i, "") || "";
}

export function CloneDialog({ initialRemoteUrl = "", initialDirectoryName = "", parentPath, error, busy, api, onChooseParent, onClose, onSubmit }: CloneDialogProps) {
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
      <section className="cloneDialog" role="dialog" aria-modal="true" aria-labelledby="clone-title">
        <div className="taskCenterHeader"><div><p className="sectionEyebrow">REMOTE REPOSITORY</p><h2 id="clone-title">Clone repository</h2></div><button className="quietButton compact" type="button" disabled={busy} onClick={onClose} aria-label="Close clone dialog">Close</button></div>
        <div className="cloneFormBody">
          <label className="cloneField">Remote URL<input autoFocus value={remoteUrl} onChange={(event) => { setRemoteUrl(event.target.value); if (!folderEdited) setDirectoryName(folderFromRemote(event.target.value)); }} placeholder="https://host/owner/repository.git" autoComplete="url" /></label>
          <p className="cloneHelp">HTTPS credentials are stored in the system credential store; SSH uses your system SSH agent. Credentials in URLs are rejected.</p>
          {credentialHost && <CredentialEditor key={credentialHost} api={api} host={credentialHost} disabled={busy} />}
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
