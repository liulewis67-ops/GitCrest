import { useEffect, useState, type FormEvent } from "react";
import type { CredentialStatusResponse, GitCrestApiClient } from "../../../api/client";

interface CredentialEditorProps {
  api?: GitCrestApiClient;
  host: string;
  disabled?: boolean;
}

export function CredentialEditor({ api, host, disabled = false }: CredentialEditorProps) {
  const [status, setStatus] = useState<CredentialStatusResponse>();
  const [username, setUsername] = useState("");
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    if (!api) {
      setLoading(false);
      return () => { active = false; };
    }
    void api.getCredentialStatus(host).then((value) => {
      if (!active) return;
      setStatus(value);
      setUsername(value.username || "");
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Could not read saved credential status.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [api, host]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!api || busy || disabled || !username.trim() || !token) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await api.setCredential(host, username.trim(), token);
      setStatus(next);
      setUsername(next.username || "");
      setToken("");
      setNotice("Credential saved to the system credential store.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save the credential.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!api || busy || disabled) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.deleteCredential(host);
      setStatus({ host, username: null, isConfigured: false });
      setUsername("");
      setToken("");
      setConfirmDelete(false);
      setNotice("Saved credential removed.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not remove the credential.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="credentialCard" aria-label={`HTTPS credential for ${host}`}>
      <div className="remoteCardHeading"><strong>{host}</strong><span className="credentialStatus">{loading ? "Checking…" : status?.isConfigured ? "Saved" : "Not set"}</span></div>
      <form className="credentialForm" onSubmit={(event) => void save(event)}>
        <label className="cloneField">Username<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} disabled={busy || disabled || loading} maxLength={255} /></label>
        <label className="cloneField">Token or password<input type="password" autoComplete="new-password" value={token} onChange={(event) => setToken(event.target.value)} disabled={busy || disabled} maxLength={65536} /></label>
        <div className="remoteInlineActions">
          <button className="secondaryButton" type="submit" disabled={!api || busy || disabled || loading || !username.trim() || !token}>{busy ? "Saving…" : status?.isConfigured ? "Replace credential" : "Save credential"}</button>
          {status?.isConfigured && (confirmDelete ? <><span className="remoteDeletePrompt">Remove saved credential?</span><button className="dangerTextButton" type="button" disabled={busy || disabled} onClick={() => void remove()}>Confirm remove</button><button className="textButton" type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>Cancel</button></> : <button className="textButton" type="button" disabled={busy || disabled} onClick={() => setConfirmDelete(true)}>Remove</button>)}
        </div>
      </form>
      {error && <p className="taskCenterError" role="alert">{error}</p>}
      {notice && <p className="credentialNotice" role="status">{notice}</p>}
      <p className="cloneHelp">The secret stays in the system credential store. Git reads it only when this HTTPS host asks for authentication.</p>
    </article>
  );
}
