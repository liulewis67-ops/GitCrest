import { useI18n } from "../../../shared/i18n";
import { useEffect, useState, type FormEvent } from "react";
import type { CredentialStatusResponse, GitCrestApiClient } from "../../../api/client";

interface CredentialEditorProps {
  api?: GitCrestApiClient;
  host: string;
  disabled?: boolean;
}

export function CredentialEditor({ api, host, disabled = false }: CredentialEditorProps) {
  const { t } = useI18n();
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
      if (active) setError(reason instanceof Error ? reason.message : t("cred.readFailed"));
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
      setNotice(t("cred.saved"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("cred.saveFailed"));
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
      setNotice(t("cred.removed"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("cred.removeFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="credentialCard" aria-label={t("cred.aria", { host })}>
      <div className="remoteCardHeading"><strong>{host}</strong><span className="credentialStatus">{loading ? t("cred.checking") : status?.isConfigured ? t("cred.statusSaved") : t("cred.statusNotSet")}</span></div>
      <form className="credentialForm" onSubmit={(event) => void save(event)}>
        <label className="cloneField">{t("cred.username")}<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} disabled={busy || disabled || loading} maxLength={255} /></label>
        <label className="cloneField">{t("cred.token")}<input type="password" autoComplete="new-password" value={token} onChange={(event) => setToken(event.target.value)} disabled={busy || disabled} maxLength={65536} /></label>
        <div className="remoteInlineActions">
          <button className="secondaryButton" type="submit" disabled={!api || busy || disabled || loading || !username.trim() || !token}>{busy ? t("cred.saving") : status?.isConfigured ? t("cred.replace") : t("cred.save")}</button>
          {status?.isConfigured && (confirmDelete ? <><span className="remoteDeletePrompt">{t("cred.removeQ")}</span><button className="dangerTextButton" type="button" disabled={busy || disabled} onClick={() => void remove()}>{t("cred.confirmRemove")}</button><button className="textButton" type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>{t("cred.cancel")}</button></> : <button className="textButton" type="button" disabled={busy || disabled} onClick={() => setConfirmDelete(true)}>{t("cred.remove")}</button>)}
        </div>
      </form>
      {error && <p className="taskCenterError" role="alert">{error}</p>}
      {notice && <p className="credentialNotice" role="status">{notice}</p>}
      <p className="cloneHelp">{t("cred.note")}</p>
    </article>
  );
}
