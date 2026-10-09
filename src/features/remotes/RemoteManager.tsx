import { useEffect, useRef, useState, type FormEvent } from "react";
import type { BranchSnapshotResponse, RemoteSnapshotResponse } from "../../api/client";
import { httpsHostFromRemote } from "../../shared/lib/https-remote-host";
import type { CredentialEditorRenderer } from "../../shared/ui/credential-editor-renderer";
import { useDialogFocus } from "../../shared/use-dialog-focus";

interface RemoteManagerProps {
  snapshot?: RemoteSnapshotResponse;
  branches?: BranchSnapshotResponse;
  loading: boolean;
  busy: boolean;
  disabled: boolean;
  disabledReason: string;
  error: string;
  renderCredentialEditor: CredentialEditorRenderer;
  openRequest?: number;
  onFetch?: () => void;
  onRefresh: () => void;
  onAdd: (name: string, url: string) => void;
  onSetUrl: (name: string, url: string) => void;
  onDelete: (name: string) => void;
  onSetDefault: (name: string | null) => void;
  onSetUpstream: (localBranch: string, remoteName: string, remoteBranch: string) => void;
}

export function RemoteManager({ snapshot, branches, loading, busy, disabled, disabledReason, error, renderCredentialEditor, openRequest, onFetch, onRefresh, onAdd, onSetUrl, onDelete, onSetDefault, onSetUpstream }: RemoteManagerProps) {
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [editingName, setEditingName] = useState("");
  const [editingUrl, setEditingUrl] = useState("");
  const [deleteCandidate, setDeleteCandidate] = useState("");
  const [localBranch, setLocalBranch] = useState("");
  const [upstreamRemote, setUpstreamRemote] = useState("");
  const [upstreamBranch, setUpstreamBranch] = useState("");
  const [recoveryMode, setRecoveryMode] = useState(false);
  const manageButtonRef = useRef<HTMLButtonElement>(null);
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(() => setOpen(false), busy, () => manageButtonRef.current, open);

  useEffect(() => {
    if (openRequest) {
      setOpen(true);
      setRecoveryMode(true);
    }
  }, [openRequest]);

  const remoteList = Array.isArray(snapshot?.remotes) ? snapshot.remotes : undefined;
  const branchList = Array.isArray(branches?.branches) ? branches.branches : [];
  const localBranches = branchList.filter((branch) => branch.kind === "local");
  const currentRemoteBranches = branchList
    .filter((branch) => branch.kind === "remote" && branch.fullName.startsWith(`refs/remotes/${upstreamRemote}/`))
    .map((branch) => ({ branch, name: branch.fullName.slice(`refs/remotes/${upstreamRemote}/`.length) }));
  const credentialHosts = [...new Set((remoteList || []).flatMap((remote) => remote.fetchUrls.map(httpsHostFromRemote).filter((host): host is string => Boolean(host))))];

  function submitAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newName.trim() || !newUrl.trim() || busy || disabled) return;
    onAdd(newName.trim(), newUrl.trim());
    setNewName("");
    setNewUrl("");
  }

  function submitUrl(event: FormEvent<HTMLFormElement>, name: string) {
    event.preventDefault();
    if (!editingUrl.trim() || busy || disabled) return;
    onSetUrl(name, editingUrl.trim());
    setEditingName("");
    setEditingUrl("");
  }

  function submitUpstream(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!localBranch || !upstreamRemote || !upstreamBranch || busy || disabled) return;
    onSetUpstream(localBranch, upstreamRemote, upstreamBranch);
  }

  return (
    <section className="remoteManager" aria-label="Repository remotes">
      <div className="navGroupTitle remoteManagerHeading">
        <span>Remotes</span>
        {remoteList && <span className="countBadge">{remoteList.length}</span>}
        <button className="iconTextButton" type="button" disabled={disabled || loading} onClick={onRefresh} aria-label="Refresh remotes" title="Refresh remotes">↻</button>
        <button ref={manageButtonRef} className="iconTextButton" type="button" disabled={disabled} title={disabled ? disabledReason : "Manage remotes"} onClick={() => setOpen(true)} aria-label="Manage remotes">Manage</button>
      </div>
      {!snapshot && loading && <div className="navEmpty" role="status">Loading remotes…</div>}
      {!snapshot && !loading && !error && <div className="navEmpty">Open a repository to view remotes</div>}
      {remoteList && remoteList.length === 0 && <div className="navEmpty">No remotes configured</div>}
      {remoteList && remoteList.length > 0 && <ul className="remoteList" aria-label="Configured remotes">
        {remoteList.map((remote) => <li className="remoteItem" key={remote.name}>
          <span className="remoteName" title={remote.name}>{remote.name}</span>
          {remote.isDefault && <span className="remoteDefaultTag">DEFAULT</span>}
          <small title={remote.fetchUrls[0] || "No fetch URL"}>{remote.fetchUrls[0] || "No fetch URL"}</small>
        </li>)}
      </ul>}
      {error && <div className="statusLoadError remoteManagerError" role="alert"><span>{error}</span><button type="button" disabled={disabled} onClick={onRefresh}>Retry</button></div>}
      {disabled && disabledReason && <p className="cloneHelp remoteDisabledReason">{disabledReason}</p>}

      {open && <div className="paletteBackdrop remoteBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setOpen(false); }}>
        <section ref={dialogRef} className="cloneDialog remoteDialog" role="dialog" aria-modal="true" aria-labelledby="remote-dialog-title" onKeyDown={onKeyDown}>
          <header className="taskCenterHeader">
            <div><p className="sectionEyebrow">REPOSITORY CONFIGURATION</p><h2 id="remote-dialog-title">Manage remotes</h2></div>
            <button className="quietButton compact" type="button" disabled={busy} onClick={() => setOpen(false)} aria-label="Close remote manager">Close</button>
          </header>
          <div className="cloneFormBody remoteDialogBody">
            {disabled && <p className="cloneHelp" role="note">{disabledReason}</p>}
            <section aria-labelledby="remote-list-title">
              <div className="remoteDialogSectionTitle"><h3 id="remote-list-title">Configured remotes</h3><span>{snapshot?.remotes.length || 0}</span></div>
              {!snapshot && <p className="cloneHelp">{loading ? "Loading remote configuration…" : "Remote configuration is unavailable."}</p>}
              {remoteList?.map((remote) => <article className="remoteCard" key={remote.name}>
                <div className="remoteCardHeading"><strong>{remote.name}</strong>{remote.isDefault ? <span className="remoteDefaultTag">DEFAULT</span> : <button className="textButton" type="button" disabled={busy || disabled} onClick={() => onSetDefault(remote.name)}>Set default</button>}</div>
                <div className="remoteUrlDetails"><span>Fetch</span><code title={remote.fetchUrls.join("\n")}>{remote.fetchUrls.join(", ") || "Not configured"}</code></div>
                <div className="remoteUrlDetails"><span>Push</span><code title={remote.pushUrls.join("\n")}>{remote.pushUrls.join(", ") || "Uses fetch URL"}</code></div>
                {editingName === remote.name ? <form className="remoteInlineForm" onSubmit={(event) => submitUrl(event, remote.name)}>
                  <label className="cloneField">New URL<input autoFocus disabled={busy || disabled} value={editingUrl} onChange={(event) => setEditingUrl(event.target.value)} autoComplete="url" /></label>
                  <div className="remoteInlineActions"><button className="textButton" type="button" disabled={busy} onClick={() => setEditingName("")}>Cancel</button><button className="secondaryButton" type="submit" disabled={busy || disabled || !editingUrl.trim()}>{busy ? "Saving…" : "Save URL"}</button></div>
                </form> : <div className="remoteCardActions">
                  <button className="textButton" type="button" disabled={busy || disabled} onClick={() => { setEditingName(remote.name); setEditingUrl(remote.fetchUrls[0] || ""); setDeleteCandidate(""); }}>Edit URL</button>
                  {deleteCandidate === remote.name ? <><span className="remoteDeletePrompt">Remove {remote.name}?</span><button className="dangerTextButton" type="button" disabled={busy || disabled} onClick={() => { onDelete(remote.name); setDeleteCandidate(""); }}>Confirm remove</button><button className="textButton" type="button" disabled={busy} onClick={() => setDeleteCandidate("")}>Cancel</button></> : <button className="dangerTextButton" type="button" disabled={busy || disabled} onClick={() => { setDeleteCandidate(remote.name); setEditingName(""); }}>Remove</button>}
                </div>}
              </article>)}
              {snapshot?.defaultRemote && <button className="textButton remoteClearDefault" type="button" disabled={busy || disabled} onClick={() => onSetDefault(null)}>Use automatic default (origin)</button>}
            </section>

            <section className="credentialSection" aria-labelledby="credential-section-title">
              <div className="remoteDialogSectionTitle"><h3 id="credential-section-title">HTTPS credentials</h3><span>{credentialHosts.length}</span></div>
              {credentialHosts.length === 0 ? <p className="cloneHelp">Add an HTTPS remote to configure credentials for its host.</p> : credentialHosts.map((host) => <div key={host}>{renderCredentialEditor(host, disabled || busy)}</div>)}
              {recoveryMode && <div className="credentialRecoveryAction"><p className="cloneHelp">After updating a credential, retry the fetch to check authentication.</p><button className="secondaryButton" type="button" disabled={disabled || busy || !onFetch} onClick={() => { setRecoveryMode(false); onFetch?.(); }}>Retry fetch</button></div>}
            </section>

            <form className="remoteAddForm" onSubmit={submitAdd}>
              <h3>Add remote</h3>
              <div className="remoteAddFields">
                <label className="cloneField">Name<input autoFocus disabled={busy || disabled} value={newName} onChange={(event) => setNewName(event.target.value)} maxLength={255} autoComplete="off" /></label>
                <label className="cloneField">URL<input disabled={busy || disabled} value={newUrl} onChange={(event) => setNewUrl(event.target.value)} maxLength={2048} autoComplete="url" placeholder="https://host/owner/repository.git" /></label>
              </div>
              <p className="cloneHelp">Credentials in URLs are rejected. HTTPS uses your configured Git credential helper; SSH uses your system SSH configuration.</p>
              <button className="secondaryButton" type="submit" disabled={busy || disabled || !newName.trim() || !newUrl.trim()}>{busy ? "Working…" : "Add remote"}</button>
            </form>

            <form className="remoteUpstreamForm" onSubmit={submitUpstream}>
              <h3>Branch upstream</h3>
              {localBranches.length === 0 ? <p className="cloneHelp">Create a local branch before assigning an upstream.</p> : <div className="remoteAddFields">
                <label className="cloneField">Local branch<select value={localBranch} onChange={(event) => setLocalBranch(event.target.value)} disabled={busy || disabled}><option value="">Choose branch</option>{localBranches.map((branch) => <option key={branch.fullName} value={branch.name}>{branch.name}{branch.isCurrent ? " (current)" : ""}</option>)}</select></label>
                <label className="cloneField">Remote<select value={upstreamRemote} onChange={(event) => { setUpstreamRemote(event.target.value); setUpstreamBranch(""); }} disabled={busy || disabled}><option value="">Choose remote</option>{remoteList?.map((remote) => <option key={remote.name} value={remote.name}>{remote.name}</option>)}</select></label>
                <label className="cloneField">Remote branch<select value={upstreamBranch} onChange={(event) => setUpstreamBranch(event.target.value)} disabled={busy || disabled || !upstreamRemote}><option value="">Choose branch</option>{currentRemoteBranches.map(({ branch, name }) => <option key={branch.fullName} value={name}>{name}</option>)}</select></label>
              </div>}
              <button className="secondaryButton" type="submit" disabled={busy || disabled || !localBranch || !upstreamRemote || !upstreamBranch}>Set upstream</button>
            </form>
            {error && <p className="taskCenterError" role="alert">{error}</p>}
          </div>
        </section>
      </div>}
    </section>
  );
}
