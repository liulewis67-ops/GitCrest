import { MetaList } from "../../../shared/ui/MetaList";
import { Button } from "../../../shared/ui/Button";
import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { useEffect, useState, type FormEvent } from "react";
import type { AccountResponse, BrowserSignInHost, DeviceFlowResponse, GitCrestApiClient, HostingProvider } from "../../../api/client";
import { useI18n } from "../../../shared/i18n";
import { emitCredentialSaved } from "../../../shared/lib/credential-events";
import { HostCredentials } from "../../credentials";
import { browserSignInAvailable, DEFAULT_HOSTS, DEVICE_FLOW_POLL_MS, groupAccountsByHost, tokenCreationUrl, tokenExpiry, type SignInMethod } from "../model/accounts";

interface SignInDraft {
  provider: HostingProvider;
  host: string;
  token: string;
  method: SignInMethod;
}

interface AccountsSectionProps {
  api: GitCrestApiClient;
  /** HTTPS hosts to show credential cards for, such as the remotes of the repository that asked to sign in. */
  credentialHosts?: readonly string[];
}

export function AccountsSection({ api, credentialHosts }: AccountsSectionProps) {
  const { t } = useI18n();
  const [accounts, setAccounts] = useState<AccountResponse[]>();
  const [browserHosts, setBrowserHosts] = useState<BrowserSignInHost[]>([]);
  const [draft, setDraft] = useState<SignInDraft>();
  const [flow, setFlow] = useState<DeviceFlowResponse>();
  const [codeCopied, setCodeCopied] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [confirmSignOut, setConfirmSignOut] = useState("");
  const [error, setError] = useState<DisplayError>("");
  const [notice, setNotice] = useState("");

  async function reload(signal?: AbortSignal) {
    const list = await (signal ? api.withSignal(signal) : api).listAccounts();
    if (signal?.aborted) return;
    setAccounts(list.accounts);
    setBrowserHosts(list.browserSignIn ?? []);
  }

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(describeApiError(reason, t("accounts.loadFailed")));
    });
    return () => controller.abort();
  }, [api]);

  // The core polls the provider; the form only asks the core how the browser sign-in is going.
  useEffect(() => {
    if (flow?.status !== "pending") return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api.getDeviceFlow(flow.flowId).then(async (next) => {
        if (cancelled) return;
        if (next.status !== "completed" || !next.account) {
          setFlow(next);
          return;
        }
        const account = next.account;
        setFlow(undefined);
        setDraft(undefined);
        await reload().catch(() => undefined);
        setNotice(t("accounts.signedIn", { login: account.login, host: account.host }));
        emitCredentialSaved(account.host.toLowerCase());
      }, (reason: unknown) => {
        if (cancelled) return;
        setFlow(undefined);
        setError(describeApiError(reason, t("accounts.browser.failed")));
      });
    }, DEVICE_FLOW_POLL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [api, flow]);

  async function run(action: string, work: () => Promise<string>, fallback: string) {
    setBusyAction(action);
    setError("");
    setNotice("");
    try {
      const message = await work();
      await reload();
      setNotice(message);
    } catch (reason) {
      setError(describeApiError(reason, fallback));
    } finally {
      setBusyAction("");
    }
  }

  function startSignIn(provider: HostingProvider = "github", host = DEFAULT_HOSTS[provider], method: SignInMethod = "browser") {
    setDraft({ provider, host, token: "", method });
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

  function stopFlow() {
    if (flow?.status === "pending") void api.cancelDeviceFlow(flow.flowId).catch(() => undefined);
    setFlow(undefined);
  }

  function closeForm() {
    stopFlow();
    setDraft(undefined);
  }

  async function startBrowserSignIn() {
    if (!draft) return;
    setBusyAction("browser");
    setError("");
    setNotice("");
    setCodeCopied(false);
    try {
      setFlow(await api.startDeviceFlow(draft.provider, draft.host.trim()));
    } catch (reason) {
      setError(describeApiError(reason, t("accounts.browser.failed")));
    } finally {
      setBusyAction("");
    }
  }

  async function copyCode(code: string) {
    try {
      if (!navigator.clipboard?.writeText) return;
      await navigator.clipboard.writeText(code);
      setCodeCopied(true);
    } catch {
      // The code stays on screen to type by hand.
    }
  }

  function signIn(event: FormEvent) {
    event.preventDefault();
    if (!draft || busyAction || flow || !draft.host.trim()) return;
    if (method === "browser") {
      void startBrowserSignIn();
      return;
    }
    if (!draft.token.trim()) return;
    const { provider, host, token } = draft;
    void run("sign-in", async () => {
      const account = await api.signInWithToken(provider, host.trim(), token);
      setDraft(undefined);
      emitCredentialSaved(account.host.toLowerCase());
      return t("accounts.signedIn", { login: account.login, host: account.host });
    }, t("accounts.form.failed"));
  }

  function signedOutMessage(account: AccountResponse, provider: string) {
    if (account.authKind !== "oauth") return t("accounts.signedOut", { login: account.login, provider });
    return account.provider === "github"
      ? t("accounts.signedOutGithubApp", { login: account.login })
      : t("accounts.signedOutRevoked", { login: account.login, provider });
  }

  const busy = Boolean(busyAction);
  const groups = groupAccountsByHost(accounts ?? []);
  const browserAvailable = draft ? browserSignInAvailable(browserHosts, draft.provider, draft.host) : false;
  const method: SignInMethod = browserAvailable && draft?.method === "browser" ? "browser" : "token";
  const tokenUrl = draft ? tokenCreationUrl(draft.provider, draft.host.trim()) : undefined;
  const draftProvider = draft ? t(`accounts.provider.${draft.provider}`) : "";
  const formLocked = busy || Boolean(flow);

  return (
    <section className="settingsSection" id="settings-section-accounts" aria-labelledby="settings-accounts-title">
      <div className="settingsSectionHeading">
        <h3 id="settings-accounts-title" tabIndex={-1}>{t("settings.section.accounts")}</h3>
        {!draft && <Button variant="secondary" type="button" disabled={busy} onClick={() => startSignIn()}>{t("accounts.add")}</Button>}
      </div>
      <p className="settingsHint">{t("accounts.intro")}</p>

      {draft && <form className="settingsForm accountSignInForm" onSubmit={signIn} aria-labelledby="account-sign-in-title">
        <h4 id="account-sign-in-title">{t(browserAvailable ? "accounts.form.titleAny" : "accounts.form.title")}</h4>
        <div className="settingsFieldStack">
          <span id="account-provider-label">{t("accounts.form.provider")}</span>
          <div className="segmentedControl" role="radiogroup" aria-labelledby="account-provider-label">
            {(["github", "gitlab"] as const).map((provider) => (
              <label key={provider} className={draft.provider === provider ? "selected" : undefined}>
                <input type="radio" name="account-provider" value={provider} checked={draft.provider === provider} disabled={formLocked} onChange={() => changeProvider(provider)} />
                <span>{t(`accounts.provider.${provider}`)}</span>
              </label>
            ))}
          </div>
        </div>
        <label>{t("accounts.form.host")}
          <input value={draft.host} onChange={(event) => setDraft({ ...draft, host: event.target.value })} disabled={formLocked} maxLength={260} autoComplete="off" spellCheck={false} aria-describedby="account-host-help" />
        </label>
        <p id="account-host-help" className="settingsHint">{t("accounts.form.hostHelp")}</p>
        {browserAvailable && <div className="settingsFieldStack">
          <span id="account-method-label">{t("accounts.form.method")}</span>
          <div className="segmentedControl" role="radiogroup" aria-labelledby="account-method-label">
            {(["browser", "token"] as const).map((option) => (
              <label key={option} className={method === option ? "selected" : undefined}>
                <input type="radio" name="account-method" value={option} checked={method === option} disabled={formLocked} onChange={() => setDraft({ ...draft, method: option })} />
                <span>{t(option === "browser" ? "accounts.form.methodBrowser" : "accounts.form.methodToken")}</span>
              </label>
            ))}
          </div>
        </div>}

        {method === "token" && <>
          <label>{t("accounts.form.token")}
            <input type="password" value={draft.token} onChange={(event) => setDraft({ ...draft, token: event.target.value })} disabled={busy} maxLength={65536} autoComplete="new-password" spellCheck={false} aria-describedby="account-token-help" />
          </label>
          <p id="account-token-help" className="settingsHint">
            {t(draft.provider === "github" ? "accounts.form.githubScopes" : "accounts.form.gitlabScopes")}
            {tokenUrl && <> <a href={tokenUrl} target="_blank" rel="noreferrer">{t("accounts.form.createToken", { host: draft.host.trim() })}</a></>}
          </p>
          <div className="settingsActions">
            <Button variant="primary" type="submit" disabled={busy || !draft.host.trim() || !draft.token.trim()}>{busyAction === "sign-in" ? t("accounts.form.signingIn") : t("accounts.form.signIn")}</Button>
            <Button variant="secondary" type="button" disabled={busy} onClick={closeForm}>{t("accounts.form.cancel")}</Button>
          </div>
        </>}

        {method === "browser" && !flow && <>
          <p className="settingsHint">{t("accounts.browser.hint", { host: draft.host.trim() })}</p>
          <div className="settingsActions">
            <Button variant="primary" type="submit" disabled={busy}>{busyAction === "browser" ? t("accounts.browser.starting") : t("accounts.browser.start")}</Button>
            <Button variant="secondary" type="button" disabled={busy} onClick={closeForm}>{t("accounts.form.cancel")}</Button>
          </div>
        </>}

        {method === "browser" && flow && <div className="deviceFlowPanel" role="group" aria-labelledby="device-flow-title">
          {flow.status === "pending" ? <>
            <p id="device-flow-title">{t("accounts.browser.enterCode", { provider: draftProvider })}</p>
            <output className="deviceFlowCode" aria-label={t("accounts.browser.codeAria")}>{flow.userCode}</output>
            <div className="settingsActions">
              <a className="primaryButton" href={flow.verificationUriComplete ?? flow.verificationUri} target="_blank" rel="noreferrer" onClick={() => void copyCode(flow.userCode)}>{t("accounts.browser.copyAndOpen", { provider: draftProvider })}</a>
              <Button variant="secondary" type="button" onClick={() => void copyCode(flow.userCode)}>{codeCopied ? t("accounts.browser.copied") : t("accounts.browser.copy")}</Button>
              <Button variant="secondary" type="button" onClick={closeForm}>{t("accounts.form.cancel")}</Button>
            </div>
            <p className="settingsHint" role="status">{t("accounts.browser.waiting", { host: flow.host })}</p>
          </> : <>
            <p id="device-flow-title" className="formError" role="alert">
              {flow.status === "denied" && t("accounts.browser.denied", { provider: draftProvider })}
              {flow.status === "expired" && t("accounts.browser.expired")}
              {flow.status === "failed" && <ErrorMessage error={flow.error ? describeApiError({ body: { error: flow.error } }) : t("accounts.browser.failed")} />}
            </p>
            <div className="settingsActions">
              <Button variant="primary" type="button" disabled={busy} onClick={() => void startBrowserSignIn()}>{busyAction === "browser" ? t("accounts.browser.starting") : t("accounts.browser.retry")}</Button>
              <Button variant="secondary" type="button" disabled={busy} onClick={closeForm}>{t("accounts.form.cancel")}</Button>
            </div>
          </>}
        </div>}
      </form>}

      {!accounts && !error && <p className="settingsHint" role="status">{t("accounts.loading")}</p>}
      {accounts?.length === 0 && !draft && <div className="settingsCard"><p className="settingsHint">{t("accounts.empty")}</p></div>}
      {groups.map(({ host, accounts: hostAccounts }) => (
        <div className="settingsCard accountHostCard" key={host} role="group" aria-label={t("accounts.hostAria", { host })}>
          <span className="accountHostName">{host}</span>
          <ul className="accountList">
            {hostAccounts.map((account) => {
              // A browser sign-in's short-lived token renews itself, so only pasted tokens warn.
              const expiry = account.authKind === "token" ? tokenExpiry(account.tokenExpiresAtMs, Date.now()) : undefined;
              const provider = t(`accounts.provider.${account.provider}`);
              const browserRenewal = account.authKind === "oauth" || browserSignInAvailable(browserHosts, account.provider, account.host);
              return (
                <li className="accountRow" key={account.accountId} aria-label={account.login}>
                  <AccountAvatar account={account} />
                  <div className="accountIdentity">
                    <span className="accountName">{account.displayName || account.login}{account.displayName && <span className="accountLogin"> @{account.login}</span>}</span>
                    <MetaList className="accountMeta" items={[provider, t(`accounts.method.${account.authKind}`), account.scopes.length > 0 && t("accounts.scopes", { scopes: account.scopes.join(", ") })]} />
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
                      <Button variant="danger" type="button" disabled={busy} onClick={() => void run(`sign-out:${account.accountId}`, async () => {
                        await api.signOutAccount(account.accountId);
                        setConfirmSignOut("");
                        return signedOutMessage(account, provider);
                      }, t("accounts.actionFailed"))}>{t("accounts.confirmSignOut")}</Button>
                      <Button variant="quiet" type="button" disabled={busy} onClick={() => setConfirmSignOut("")}>{t("accounts.cancel")}</Button>
                    </> : <>
                      {!account.selected && <Button variant="secondary" type="button" disabled={busy} onClick={() => void run(`select:${account.accountId}`, async () => {
                        const selected = await api.selectAccount(account.accountId);
                        return t("accounts.switched", { login: selected.login, host: selected.host });
                      }, t("accounts.actionFailed"))}>{t("accounts.use", { host: account.host })}</Button>}
                      {account.state === "needsReauth"
                        ? <Button variant="quiet" type="button" disabled={busy || Boolean(flow)} onClick={() => startSignIn(account.provider, account.host, browserRenewal ? "browser" : "token")}>{t(account.authKind === "oauth" ? "accounts.signInAgain" : "accounts.replaceToken")}</Button>
                        : <Button variant="quiet" type="button" disabled={busy} onClick={() => void run(`validate:${account.accountId}`, async () => {
                          const checked = await api.validateAccount(account.accountId);
                          return checked.state === "active"
                            ? t("accounts.valid", { login: checked.login })
                            : t("accounts.invalid", { login: checked.login, provider });
                        }, t("accounts.actionFailed"))}>{busyAction === `validate:${account.accountId}` ? t("accounts.checking") : t("accounts.check")}</Button>}
                      <Button variant="quiet" type="button" disabled={busy} onClick={() => setConfirmSignOut(account.accountId)}>{t("accounts.signOut")}</Button>
                    </>}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {error && <p className="formError" role="alert"><ErrorMessage error={error} /></p>}
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
