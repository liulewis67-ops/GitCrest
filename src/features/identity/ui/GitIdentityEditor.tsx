import { useEffect, useState, type FormEvent } from "react";
import { GitCrestApiError, type GitCrestApiClient } from "../../../api/client";
import { useI18n } from "../../../shared/i18n";
import { useGitIdentity, type IdentityScope } from "../model/use-git-identity";

/**
 * Edits the commit author name and email. Settings edits the global identity; with a `repoId` the
 * editor can also save a repository-level identity that overrides it.
 */
export function GitIdentityEditor({ api, repoId, onSaved }: {
  api: GitCrestApiClient;
  repoId?: string;
  onSaved?: () => void;
}) {
  const { t } = useI18n();
  const { identity, error: loadError, save, clearLocal } = useGitIdentity(api, repoId);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [scope, setScope] = useState<IdentityScope>("global");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState("");

  useEffect(() => {
    if (!identity) return;
    setName(identity.name ?? "");
    setEmail(identity.email ?? "");
  }, [identity]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    setFailure("");
    try {
      await save(name, email, scope);
      setMessage(t("id.saved"));
      onSaved?.();
    } catch (reason) {
      setFailure(reason instanceof GitCrestApiError ? reason.body.error.message : t("id.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function removeLocal() {
    setBusy(true);
    setMessage("");
    setFailure("");
    try {
      await clearLocal();
      onSaved?.();
    } catch (reason) {
      setFailure(reason instanceof GitCrestApiError ? reason.body.error.message : t("id.saveFailed"));
    } finally {
      setBusy(false);
    }
  }

  const usesLocal = identity?.nameScope === "local" || identity?.emailScope === "local";
  return <form className="identityEditor" onSubmit={(event) => void submit(event)}>
    <label>{t("id.name")}<input value={name} maxLength={256} required autoComplete="name" onChange={(event) => setName(event.target.value)} /></label>
    <label>{t("id.email")}<input type="email" value={email} maxLength={256} required autoComplete="email" onChange={(event) => setEmail(event.target.value)} /></label>
    {repoId && <fieldset className="identityScope">
      <legend>{t("id.scope")}</legend>
      <label><input type="radio" name="identity-scope" checked={scope === "global"} onChange={() => setScope("global")} />{t("id.scopeGlobal")}</label>
      <label><input type="radio" name="identity-scope" checked={scope === "local"} onChange={() => setScope("local")} />{t("id.scopeLocal")}</label>
    </fieldset>}
    {repoId && identity && <p className="cloneHelp">{usesLocal ? t("id.appliesLocal") : t("id.appliesGlobal")}</p>}
    {failure && <p className="dialogError" role="alert">{failure}</p>}
    {!failure && loadError && <p className="cloneHelp">{t("id.loadFailed")}</p>}
    {message && <p className="commitCopyStatus" role="status">{message}</p>}
    <div className="identityActions">
      <button className="secondaryButton" type="submit" disabled={busy || !name.trim() || !email.trim()}>{busy ? t("id.saving") : t("id.save")}</button>
      {repoId && usesLocal && <button className="textButton" type="button" disabled={busy} onClick={() => void removeLocal()}>{t("id.removeLocal")}</button>}
    </div>
  </form>;
}
