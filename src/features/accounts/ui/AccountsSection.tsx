import { useEffect, useState, type FormEvent } from "react";
import type { AccountResponse, GitCrestApiClient, HostingProvider } from "../../../api/client";
import { useI18n } from "../../../shared/i18n";
import { HostCredentials } from "../../credentials";
import { DEFAULT_HOSTS, groupAccountsByHost, tokenCreationUrl, tokenExpiry } from "../model/accounts";

interface SignInDraft {
  provider: HostingProvider;
  host: string;
  token: string;
}

interface AccountsSectionProps {
  api: GitCrestApiClient;
  /** HTTPS hosts to show credential cards for, such as the remotes of the repository that asked to sign in. */
  credentialHosts?: readonly string[];
}

export function AccountsSection({ api, credentialHosts }: AccountsSectionProps) {
  const { t } = useI18n();
  const [accounts, setAccounts] = useState<AccountResponse[]>();
  const [draft, setDraft] = useState<SignInDraft>();
  const [busyAction, setBusyAction] = useState("");
  const [confirmSignOut, setConfirmSignOut] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function reload(signal?: AbortSignal) {
    const list = await (signal ? api.withSignal(signal) : api).listAccounts();
    if (!signal?.aborted) setAccounts(list.accounts);
  }

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : t("accounts.loadFailed"));
    });
    return () => controller.abort();
  }, [api]);

  async function run(action: string, work: () => Promise<string>, fallback: string) {
    setBusyAction(action);
    setError("");
    setNotice("");
    try {
      const message = await work();
      await reload();
      setNotice(message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : fallback);
    } finally {
      setBusyAction("");
    }
  }

  function startSignIn(provider: HostingProvider = "github", host = DEFAULT_HOSTS[provider]) {
    setDraft({ provider, host, token: "" });
    setError("");
    setNotice("");
  }

  function changeProvider(provider: HostingProvider) {
    setDraft((current) => {
      if (!current) return current;
      // Keep a host the user typed; follow the provider while it is still the other default.
      const host = current.host === DEFAULT_HOSTS[current.provider] || !current.host ? DEFAULT_HOSTS[provider] : current.host;
      return { ...current, provider, host };
    });
  }

  function signIn(event: FormEvent) {
    event.preventDefault();
    if (!draft || busyAction || !draft.host.trim() || !draft.token.trim()) return;
    const { provider, host, token } = draft;
    void run("sign-in", async () => {
      const account = await api.signInWithToken(provider, host.trim(), token);
      setDraft(undefined);
      return t("accounts.signedIn", { login: account.login, host: account.host });
    }, t("accounts.form.failed"));
  }

  const busy = Boolean(busyAction);
  const groups = groupAccountsByHost(accounts ?? []);
  const tokenUrl = draft ? tokenCreationUrl(draft.provider, draft.host.trim()) : undefined;

  return (
    <section className="settingsSection" id="settings-section-accounts" aria-labelledby="settings-accounts-title">
      <div className="settingsSectionHeading">
        <h3 id="settings-accounts-title" tabIndex={-1}>{t("settings.section.accounts")}</h3>
        {!draft && <button className="secondaryButton" type="button" disabled={busy} onClick={() => startSignIn()}>{t("accounts.add")}</button>}
      </div>
      <p className="settingsHint">{t("accounts.intro")}</p>

      {draft && <form className="settingsForm accountSignInForm" onSubmit={signIn} aria-labelledby="account-sign-in-title">
        <h4 id="account-sign-in-title">{t("accounts.form.title")}</h4>
        <div className="settingsFieldStack">
          <span id="account-provider-label">{t("accounts.form.provider")}</span>
          <div className="segmentedControl" role="radiogroup" aria-labelledby="account-provider-label">
            {(["github", "gitlab"] as const).map((provider) => (
              <label key={provider} className={draft.provider === provider ? "selected" : undefined}>
                <input type="radio" name="account-provider" value={provider} checked={draft.provider === provider} disabled={busy} onChange={() => changeProvider(provider)} />
                <span>{t(`accounts.provider.${provider}`)}</span>
              </label>
            ))}
          </div>
        </div>
        <label>{t("accounts.form.host")}
          <input value={draft.host} onChange={(event) => setDraft({ ...draft, host: event.target.value })} disabled={busy} maxLength={260} autoComplete="off" spellCheck={false} aria-describedby="account-host-help" />
        </label>
        <p id="account-host-help" className="settingsHint">{t("accounts.form.hostHelp")}</p>
        <label>{t("accounts.form.token")}
          <input type="password" value={draft.token} onChange={(event) => setDraft({ ...draft, token: event.target.value })} disabled={busy} maxLength={65536} autoComplete="new-password" spellCheck={false} aria-describedby="account-token-help" />
        </label>
        <p id="account-token-help" className="settingsHint">
          {t(draft.provider === "github" ? "accounts.form.githubScopes" : "accounts.form.gitlabScopes")}
          {tokenUrl && <> <a href={tokenUrl} target="_blank" rel="noreferrer">{t("accounts.form.createToken", { host: draft.host.trim() })}</a></>}
        </p>
        <div className="settingsActions">
          <button className="primaryButton" type="submit" disabled={busy || !draft.host.trim() || !draft.token.trim()}>{busyAction === "sign-in" ? t("accounts.form.signingIn") : t("accounts.form.signIn")}</button>
          <button className="textButton" type="button" disabled={busy} onClick={() => setDraft(undefined)}>{t("accounts.form.cancel")}</button>
        </div>
      </form>}

      {!accounts && !error && <p className="settingsHint" role="status">{t("accounts.loading")}</p>}
      {accounts?.length === 0 && !draft && <div className="settingsCard"><p className="settingsHint">{t("accounts.empty")}</p></div>}
      {groups.map(({ host, accounts: hostAccounts }) => (
        <div className="settingsCard accountHostCard" key={host} role="group" aria-label={t("accounts.hostAria", { host })}>
          <span className="accountHostName">{host}</span>
          <ul className="accountList">
            {hostAccounts.map((account) => {
              const expiry = tokenExpiry(account.tokenExpiresAtMs, Date.now());
              const provider = t(`accounts.provider.${account.provider}`);
              return (
                <li className="accountRow" key={account.accountId} aria-label={account.login}>
                  <AccountAvatar account={account} />
                  <div className="accountIdentity">
                    <span className="accountName">{account.displayName || account.login}{account.displayName && <span className="accountLogin"> @{account.login}</span>}</span>
                    <span className="accountMeta">
                      {provider} · {t(`accounts.method.${account.authKind}`)}
                      {account.scopes.length > 0 && <> · {t("accounts.scopes", { scopes: account.scopes.join(", ") })}</>}
                    </span>
                    <span className="accountBadges">
                      {account.selected && <span className="accountBadge selected">{t("accounts.usedFor", { host: account.host })}</span>}
                      {account.state === "needsReauth" && <span className="accountBadge warning">{t("accounts.needsReauth")}</span>}
                      {expiry?.kind === "expired" && <span className="accountBadge warning">{t("accounts.expired")}</span>}
                      {expiry?.kind === "today" && <span className="accountBadge warning">{t("accounts.expiresToday")}</span>}
                      {expiry?.kind === "soon" && <span className="accountBadge warning">{t("accounts.expiresSoon", { days: expiry.days })}</span>}
                    </span>
                  </div>
                  <div className="accountActions">
                    {confirmSignOut === account.accountId ? <>
                      <span className="remoteDeletePrompt">{t("accounts.signOutQ", { login: account.login })}</span>
                      <button className="dangerTextButton" type="button" disabled={busy} onClick={() => void run(`sign-out:${account.accountId}`, async () => {
                        await api.signOutAccount(account.accountId);
                        setConfirmSignOut("");
                        return t("accounts.signedOut", { login: account.login, provider });
                      }, t("accounts.actionFailed"))}>{t("accounts.confirmSignOut")}</button>
                      <button className="textButton" type="button" disabled={busy} onClick={() => setConfirmSignOut("")}>{t("accounts.cancel")}</button>
                    </> : <>
                      {!account.selected && <button className="secondaryButton" type="button" disabled={busy} onClick={() => void run(`select:${account.accountId}`, async () => {
                        const selected = await api.selectAccount(account.accountId);
                        return t("accounts.switched", { login: selected.login, host: selected.host });
                      }, t("accounts.actionFailed"))}>{t("accounts.use", { host: account.host })}</button>}
                      {account.state === "needsReauth"
                        ? <button className="textButton" type="button" disabled={busy} onClick={() => startSignIn(account.provider, account.host)}>{t("accounts.replaceToken")}</button>
                        : <button className="textButton" type="button" disabled={busy} onClick={() => void run(`validate:${account.accountId}`, async () => {
                          const checked = await api.validateAccount(account.accountId);
                          return checked.state === "active"
                            ? t("accounts.valid", { login: checked.login })
                            : t("accounts.invalid", { login: checked.login, provider });
                        }, t("accounts.actionFailed"))}>{busyAction === `validate:${account.accountId}` ? t("accounts.checking") : t("accounts.check")}</button>}
                      <button className="textButton" type="button" disabled={busy} onClick={() => setConfirmSignOut(account.accountId)}>{t("accounts.signOut")}</button>
                    </>}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {error && <p className="formError" role="alert">{error}</p>}
      {notice && <p className="settingsNotice" role="status">{notice}</p>}
      <HostCredentials api={api} initialHosts={credentialHosts} />
    </section>
  );
}

function AccountAvatar({ account }: { account: AccountResponse }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  if (account.avatarUrl && !failed) {
    return <img className="accountAvatar" src={account.avatarUrl} alt={t("accounts.avatarAlt", { login: account.login })} referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
  }
  return <span className="accountAvatar accountAvatarInitial" aria-hidden="true">{(account.displayName || account.login).slice(0, 1).toUpperCase()}</span>;
}
