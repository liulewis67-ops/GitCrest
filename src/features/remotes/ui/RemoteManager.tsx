import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { type DisplayError } from "../../../shared/i18n/api-errors";
import { useI18n } from "../../../shared/i18n";
import { useRef, useState, type FormEvent } from "react";
import type { BranchSnapshotResponse, RemoteSnapshotResponse } from "../../../api/client";
import { httpsHostFromRemote } from "../../../shared/lib/https-remote-host";
import { remoteWebUrl } from "../../../shared/lib/remote-web-url";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { useDialogFocus } from "../../../shared/hooks/use-dialog-focus";

interface RemoteManagerProps {
  snapshot?: RemoteSnapshotResponse;
  branches?: BranchSnapshotResponse;
  loading: boolean;
  busy: boolean;
  disabled: boolean;
  disabledReason: string;
  error: DisplayError;
  onManageAccounts: (hosts: string[]) => void;
  onRefresh: () => void;
  onAdd: (name: string, url: string) => void;
  onSetUrl: (name: string, url: string) => void;
  onDelete: (name: string) => void;
  onSetDefault: (name: string | null) => void;
  onSetUpstream: (localBranch: string, remoteName: string, remoteBranch: string) => void;
  /** Opens a web address in the default browser; absent outside the desktop app. */
  onOpenWebUrl?: (url: string) => void;
}

export function RemoteManager({ snapshot, branches, loading, busy, disabled, disabledReason, error, onManageAccounts, onRefresh, onAdd, onSetUrl, onDelete, onSetDefault, onSetUpstream, onOpenWebUrl }: RemoteManagerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [editingName, setEditingName] = useState("");
  const [editingUrl, setEditingUrl] = useState("");
  const [deleteCandidate, setDeleteCandidate] = useState("");
  const [localBranch, setLocalBranch] = useState("");
  const [upstreamRemote, setUpstreamRemote] = useState("");
  const [upstreamBranch, setUpstreamBranch] = useState("");
  const manageButtonRef = useRef<HTMLButtonElement>(null);
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(() => setOpen(false), busy, () => manageButtonRef.current, open);

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
    <section className="navGroup remoteManager" aria-label={t("rm.aria")}>
      <div className="navGroupTitle remoteManagerHeading">
        <span>{t("rm.title")}</span>
        {remoteList && <span className="countBadge">{remoteList.length}</span>}
        <button className="iconTextButton" type="button" disabled={disabled || loading} onClick={onRefresh} aria-label={t("rm.refresh")} title={t("rm.refresh")}><svg className="remoteRefreshIcon" viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.46-3.54" /><path d="M13 3v2.5h-2.5" /></svg></button>
        <button ref={manageButtonRef} className="iconTextButton" type="button" disabled={disabled} title={disabled ? disabledReason : t("rm.manageTitle")} onClick={() => setOpen(true)} aria-label={t("rm.manageTitle")}>{t("rm.manage")}</button>
      </div>
      {!snapshot && loading && <div className="navEmpty" role="status">{t("rm.loading")}</div>}
      {!snapshot && !loading && !error && <div className="navEmpty">{t("rm.openToView")}</div>}
      {remoteList && remoteList.length === 0 && <EmptyState actionLabel={t("rm.addFirst")} onAction={() => setOpen(true)} actionDisabled={disabled} actionTitle={disabled ? disabledReason : undefined}>{t("rm.none")}</EmptyState>}
      {remoteList && remoteList.length > 0 && <ul className="remoteList" aria-label={t("rm.listAria")}>
        {remoteList.map((remote) => <li className="remoteItem" key={remote.name}>
          <span className="remoteName" title={remote.name}>{remote.name}</span>
          {remote.isDefault && <span className="remoteDefaultTag">{t("rm.default")}</span>}
          <small title={remote.fetchUrls[0] || t("rm.noFetchUrl")}>{remote.fetchUrls[0] || t("rm.noFetchUrl")}</small>
        </li>)}
      </ul>}
      {error && <div className="statusLoadError remoteManagerError" role="alert"><span><ErrorMessage error={error} /></span><button type="button" disabled={disabled} onClick={onRefresh}>{t("rm.retry")}</button></div>}
      {disabled && disabledReason && <p className="cloneHelp remoteDisabledReason">{disabledReason}</p>}

      {open && <div className="paletteBackdrop remoteBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setOpen(false); }}>
        <section ref={dialogRef} className="cloneDialog remoteDialog" role="dialog" aria-modal="true" aria-labelledby="remote-dialog-title" onKeyDown={onKeyDown}>
          <header className="taskCenterHeader">
            <div><p className="sectionEyebrow">{t("rm.dlgEyebrow")}</p><h2 id="remote-dialog-title">{t("rm.dlgTitle")}</h2></div>
            <button className="quietButton compact" type="button" disabled={busy} onClick={() => setOpen(false)} aria-label={t("rm.dlgClose")}>{t("common.close")}</button>
          </header>
          <div className="cloneFormBody remoteDialogBody">
            {disabled && <p className="cloneHelp" role="note">{disabledReason}</p>}
            <section aria-labelledby="remote-list-title">
              <div className="remoteDialogSectionTitle"><h3 id="remote-list-title">{t("rm.configured")}</h3><span>{snapshot?.remotes.length || 0}</span></div>
              {!snapshot && <p className="cloneHelp">{loading ? t("rm.loadingConfig") : t("rm.configUnavailable")}</p>}
              {remoteList?.map((remote) => <article className="remoteCard" key={remote.name}>
                <div className="remoteCardHeading"><strong>{remote.name}</strong>{remote.isDefault ? <span className="remoteDefaultTag">{t("rm.default")}</span> : <button className="textButton" type="button" disabled={busy || disabled} onClick={() => onSetDefault(remote.name)}>{t("rm.setDefault")}</button>}</div>
                <div className="remoteUrlDetails"><span>{t("rm.fetch")}</span><code title={remote.fetchUrls.join("\n")}>{remote.fetchUrls.join(", ") || t("rm.notConfigured")}</code></div>
                <div className="remoteUrlDetails"><span>{t("rm.push")}</span><code title={remote.pushUrls.join("\n")}>{remote.pushUrls.join(", ") || t("rm.usesFetchUrl")}</code></div>
                {editingName === remote.name ? <form className="remoteInlineForm" onSubmit={(event) => submitUrl(event, remote.name)}>
                  <label className="cloneField">{t("rm.newUrl")}<input autoFocus disabled={busy || disabled} value={editingUrl} onChange={(event) => setEditingUrl(event.target.value)} autoComplete="url" /></label>
                  <div className="remoteInlineActions"><button className="textButton" type="button" disabled={busy} onClick={() => setEditingName("")}>{t("rm.cancel")}</button><button className="secondaryButton" type="submit" disabled={busy || disabled || !editingUrl.trim()}>{busy ? t("rm.saving") : t("rm.saveUrl")}</button></div>
                </form> : <div className="remoteCardActions">
                  {onOpenWebUrl && (() => {
                    const webUrl = remoteWebUrl(remote.fetchUrls[0] || "");
                    return <button className="textButton" type="button" disabled={!webUrl} title={webUrl ?? t("rm.noWebPage")} onClick={() => { if (webUrl) onOpenWebUrl(webUrl); }}>{t("rm.openBrowser")}</button>;
                  })()}
                  <button className="textButton" type="button" disabled={busy || disabled} onClick={() => { setEditingName(remote.name); setEditingUrl(remote.fetchUrls[0] || ""); setDeleteCandidate(""); }}>{t("rm.editUrl")}</button>
                  {deleteCandidate === remote.name ? <><span className="remoteDeletePrompt">{t("rm.removeQ", { name: remote.name })}</span><button className="dangerTextButton" type="button" disabled={busy || disabled} onClick={() => { onDelete(remote.name); setDeleteCandidate(""); }}>{t("rm.confirmRemove")}</button><button className="textButton" type="button" disabled={busy} onClick={() => setDeleteCandidate("")}>{t("rm.cancel")}</button></> : <button className="dangerTextButton" type="button" disabled={busy || disabled} onClick={() => { setDeleteCandidate(remote.name); setEditingName(""); }}>{t("rm.remove")}</button>}
                </div>}
              </article>)}
              {snapshot?.defaultRemote && <button className="textButton remoteClearDefault" type="button" disabled={busy || disabled} onClick={() => onSetDefault(null)}>{t("rm.autoDefault")}</button>}
            </section>

            <section className="credentialSection" aria-labelledby="credential-section-title">
              <h3 id="credential-section-title">{t("rm.signIn")}</h3>
              <p className="cloneHelp">{t("rm.signInHelp")}</p>
              <button className="secondaryButton" type="button" disabled={busy} onClick={() => { setOpen(false); onManageAccounts(credentialHosts); }}>{t("rm.manageAccounts")}</button>
            </section>

            <form className="remoteAddForm" onSubmit={submitAdd}>
              <h3>{t("rm.addRemote")}</h3>
              <div className="remoteAddFields">
                <label className="cloneField">{t("rm.name")}<input autoFocus disabled={busy || disabled} value={newName} onChange={(event) => setNewName(event.target.value)} maxLength={255} autoComplete="off" /></label>
                <label className="cloneField">{t("rm.url")}<input disabled={busy || disabled} value={newUrl} onChange={(event) => setNewUrl(event.target.value)} maxLength={2048} autoComplete="url" placeholder="https://host/owner/repository.git" /></label>
              </div>
              <p className="cloneHelp">{t("rm.urlHelp")}</p>
              <button className="secondaryButton" type="submit" disabled={busy || disabled || !newName.trim() || !newUrl.trim()}>{busy ? t("rm.working") : t("rm.addRemote")}</button>
            </form>

            <form className="remoteUpstreamForm" onSubmit={submitUpstream}>
              <h3>{t("rm.branchUpstream")}</h3>
              {localBranches.length === 0 ? <p className="cloneHelp">{t("rm.createLocalFirst")}</p> : <div className="remoteAddFields">
                <label className="cloneField">{t("rm.localBranch")}<select value={localBranch} onChange={(event) => setLocalBranch(event.target.value)} disabled={busy || disabled}><option value="">{t("rm.chooseBranch")}</option>{localBranches.map((branch) => <option key={branch.fullName} value={branch.name}>{branch.name}{branch.isCurrent ? t("rm.current") : ""}</option>)}</select></label>
                <label className="cloneField">{t("rm.remote")}<select value={upstreamRemote} onChange={(event) => { setUpstreamRemote(event.target.value); setUpstreamBranch(""); }} disabled={busy || disabled}><option value="">{t("rm.chooseRemote")}</option>{remoteList?.map((remote) => <option key={remote.name} value={remote.name}>{remote.name}</option>)}</select></label>
                <label className="cloneField">{t("rm.remoteBranch")}<select value={upstreamBranch} onChange={(event) => setUpstreamBranch(event.target.value)} disabled={busy || disabled || !upstreamRemote}><option value="">{t("rm.chooseBranch")}</option>{currentRemoteBranches.map(({ branch, name }) => <option key={branch.fullName} value={name}>{name}</option>)}</select></label>
              </div>}
              <button className="secondaryButton" type="submit" disabled={busy || disabled || !localBranch || !upstreamRemote || !upstreamBranch}>{t("rm.setUpstream")}</button>
            </form>
            {error && <p className="taskCenterError" role="alert"><ErrorMessage error={error} /></p>}
          </div>
        </section>
      </div>}
    </section>
  );
}
