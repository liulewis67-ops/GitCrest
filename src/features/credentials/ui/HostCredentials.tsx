import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { type DisplayError } from "../../../shared/i18n/api-errors";
import { useI18n } from "../../../shared/i18n";
import { useState, type FormEvent } from "react";
import type { GitCrestApiClient } from "../../../api/client";
import { httpsHostFromRemote } from "../../../shared/lib/https-remote-host";
import { CredentialEditor } from "./CredentialEditor";

interface HostCredentialsProps {
  api: GitCrestApiClient;
  initialHosts?: readonly string[];
}

/** Accepts a bare host ("git.example.com:8443") or an HTTPS URL and returns the normalized host. */
export function credentialHostFromInput(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return httpsHostFromRemote(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
}

export function HostCredentials({ api, initialHosts = [] }: HostCredentialsProps) {
  const { t } = useI18n();
  // The system credential store cannot list saved hosts, so only hosts asked for here are shown.
  const [hosts, setHosts] = useState<string[]>(() => [...new Set(initialHosts)]);
  const [hostInput, setHostInput] = useState("");
  const [inputError, setInputError] = useState<DisplayError>("");

  function addHost(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const host = credentialHostFromInput(hostInput);
    if (!host) {
      setInputError(t("cred.hosts.invalid"));
      return;
    }
    setHosts((current) => current.includes(host) ? current : [...current, host]);
    setHostInput("");
    setInputError("");
  }

  return (
    <div className="hostCredentials" role="group" aria-labelledby="host-credentials-title">
      <h4 id="host-credentials-title">{t("cred.hosts.title")}</h4>
      <p className="settingsHint">{t("cred.hosts.intro")}</p>
      <form className="hostCredentialsLookup" onSubmit={addHost}>
        <label className="cloneField">{t("cred.hosts.host")}<input value={hostInput} onChange={(event) => { setHostInput(event.target.value); setInputError(""); }} placeholder="git.example.com" maxLength={2048} autoComplete="off" spellCheck={false} /></label>
        <button className="secondaryButton" type="submit" disabled={!hostInput.trim()}>{t("cred.hosts.open")}</button>
      </form>
      {inputError && <p className="formError" role="alert"><ErrorMessage error={inputError} /></p>}
      {hosts.map((host) => <CredentialEditor key={host} api={api} host={host} />)}
    </div>
  );
}
