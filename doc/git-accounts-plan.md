# Git hosting accounts: GitHub and GitLab sign-in plan

Status: phase 1 (token sign-in, switching, sign-out) and phase 2 (browser sign-in, token refresh, re-checking accounts after Git authentication failures) are implemented. Browser sign-in stays hidden until the OAuth applications are registered and their client IDs are set (see "Client IDs"). Phase 3 is a proposal. Where the build differs from the original proposal, the sections below describe what was built.

## Goal

Users can sign in to GitHub and GitLab accounts, see which accounts are signed in, switch the account GitCrest uses for a host, and sign out. Fetch, pull, push and clone over HTTPS then authenticate with the active account without the user pasting a token into each remote.

## What already exists

- `crates/gitcrest-core/src/credentials/` keeps one HTTPS username + token per host in the OS keyring (service `com.gitcrest.git-https`, entry key = normalized host).
- `git/command.rs::askpass_environment()` points `GIT_ASKPASS` at the core binary itself. `bootstrap.rs::run_git_askpass()` parses Git's `Username for '…'` / `Password for '…'` prompt, resolves the host, and answers from the keyring.
- `/v1/credentials` (GET/PUT/DELETE by host) feeds `src/features/credentials/ui/CredentialEditor.tsx`, which `RemoteManager`, `CloneDialog` and the task center's "configure credentials" path render per HTTPS host.
- Secrets never reach the renderer: responses carry metadata only, request DTOs use `Zeroizing<String>`.
- `reqwest` with rustls is already a dependency, so the core can call provider APIs.
- Electron's window-open handler already sends `http(s)` URLs to the system browser.

The account feature builds on this pipeline instead of replacing it. The manual per-host credential stays as the fallback for hosts that have no account.

## Sign-in methods

| Provider | Primary | Fallback | Git HTTPS username |
| --- | --- | --- | --- |
| GitHub.com | OAuth device flow (no client secret, no redirect URI) | Personal access token (classic or fine-grained) | account login (any non-empty value works with a token) |
| GitHub Enterprise Server | Personal access token | Device flow with a user-supplied OAuth app client ID (later) | account login |
| GitLab.com | OAuth device authorization grant (GitLab 17.1+) | Personal access token | `oauth2` for OAuth tokens, login for PATs |
| Self-managed GitLab | Personal access token | Device grant with a user-supplied application ID, if the instance is 17.1+ | same as above |

Why device flow for both: it needs no loopback listener or custom URL scheme, works the same in dev and packaged builds, and sidesteps the open question of whether GitLab accepts ephemeral loopback ports for registered redirect URIs. The user sees a short code, the app opens the verification page in the system browser, and the core polls the token endpoint.

Scopes:
- GitHub OAuth: `repo`, `read:user`, `user:email` (add `workflow` only if pushing `.github/workflows` changes must work).
- GitHub PAT link: `https://github.com/settings/tokens/new?description=GitCrest&scopes=repo,read:user`.
- GitLab OAuth: `read_user`, `read_repository`, `write_repository` (or `api` if PR/MR features land later).
- GitLab PAT link: `https://<host>/-/user_settings/personal_access_tokens?name=GitCrest&scopes=read_user,read_repository,write_repository`.

Prerequisite (owner action): register a GitHub OAuth App with device flow enabled and a non-confidential GitLab.com application with the device grant enabled. Only the public client IDs ship in the app. No client secret is embedded.

### Client IDs

`OAuthApps::from_environment()` (in `features/accounts/providers.rs`) reads `GITCREST_GITHUB_OAUTH_CLIENT_ID` and `GITCREST_GITLAB_OAUTH_CLIENT_ID` at run time, falling back to the same variables captured at compile time with `option_env!`, so a release build sets them in the build environment and a developer sets them when starting the core. Values must be ASCII letters, digits, `_`, `-` or `.`. Without a client ID the provider has no browser sign-in: `GET /v1/accounts` lists it nowhere in `browserSignIn`, the Settings form shows only the token method, and `POST /v1/accounts/device-flows` answers `ACCOUNT_PROVIDER_NOT_CONFIGURED`. Browser sign-in covers only github.com and gitlab.com; Enterprise and self-managed hosts keep token sign-in until a user-supplied client ID is supported.

The browser scopes are `repo read:user workflow` for GitHub (`workflow` so pushes that touch `.github/workflows` work) and `read_user read_repository write_repository` for GitLab.

## Token lifetimes

- GitHub OAuth App tokens do not expire; they stop working when the user revokes them.
- GitLab OAuth access tokens expire after 2 hours and come with a refresh token. The core refreshes before launching a Git network command when the token is within 5 minutes of expiry, and on a 401 from the provider API. Refresh tokens rotate, so the new pair replaces the old one atomically in the keyring.
- PATs may carry an expiry; the profile check records it when the provider reports it, and the UI warns 7 days ahead.

## Data model

Metadata in SQLite, secrets in the keyring.

`migrations/0017_accounts.sql`:

`migrations/0017_hosting_accounts.sql` creates `hosting_accounts` (account id `acct_` + 32 hex characters, provider, normalized host, API root, provider user id, login, display name, avatar URL, `auth_kind` = `token`, comma-separated scopes, token expiry, `active` / `needsReauth` state, timestamps; unique per provider + host + provider user id) and `hosting_account_selections` (one selected account per host, deleted with its account). Phase 2 widens `auth_kind` to `oauth`.

Keyring: service `com.gitcrest.hosting-accounts`, entry key = account id, value = JSON `{ gitUsername, token, refreshToken? }` wrapped in `Zeroizing`. Browser sign-ins store `auth_kind = 'oauth'` (the migration already allowed it); GitLab OAuth accounts use the Git username `oauth2`, GitHub ones the login. For OAuth accounts `token_expires_at_ms` is the access token's expiry from the token response, and validation leaves it alone.

"Switch account" = upsert `hosting_account_selections(host)`. Signing in to the first account on a host selects it. Signing in again as the same `remote_user_id` replaces that account's token instead of adding a duplicate.

## Backend (Rust core)

New feature module `crates/gitcrest-core/src/features/accounts/` laid out like the others (`dto.rs`, `handlers.rs`, `routes.rs`, `service.rs`, `mod.rs`), plus:

- `credentials/accounts.rs`: `AccountSecretStore` trait with `SystemAccountSecretStore` (keyring) and a `#[cfg(test)]` memory store, mirroring `CredentialStore`.
- `ports/accounts.rs` + a SQLite adapter for `hosting_accounts` / `hosting_account_selection`.
- `features/accounts/providers/{mod,github,gitlab}.rs`: a `HostingProvider` trait:
  - `start_device_flow(scopes) -> DeviceCode { device_code, user_code, verification_uri, expires_in, interval }`
  - `poll_device_flow(device_code) -> Pending | SlowDown | Granted(TokenSet) | Denied | Expired`
  - `refresh(refresh_token) -> TokenSet` (GitLab only)
  - `fetch_profile(token) -> Profile { id, login, name, avatar_url, scopes, expires_at }`
    - GitHub: `GET /user`, scopes from the `X-OAuth-Scopes` header.
    - GitLab: `GET /api/v4/user`, PAT details from `GET /api/v4/personal_access_tokens/self`.
  - `revoke(token)`: GitLab `POST /oauth/revoke` with the client ID; GitHub has no secret-free revoke, so sign-out deletes locally and the UI links to `https://github.com/settings/applications`.
- `AccountService` in `AppState`, holding in-flight device flows in memory (`HashMap<FlowId, FlowState>`, 15 min TTL, a tokio task per flow that polls at the provider's interval and honours `slow_down`).

Routes (all mutations require the main window's full token; the read-only and conflict-resolution tokens get 403):

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/accounts` | List accounts + per-host selection, metadata only |
| POST | `/v1/accounts/device-flows` | `{ provider, host }` → `{ flowId, userCode, verificationUri, expiresAt }` |
| GET | `/v1/accounts/device-flows/{flowId}` | `pending` / `completed { account }` / `denied` / `expired` / `failed` |
| DELETE | `/v1/accounts/device-flows/{flowId}` | Cancel |
| POST | `/v1/accounts/tokens` | `{ provider, host, token }` → validate via profile call, create or replace account |
| POST | `/v1/accounts/{id}/select` | Make this account the one Git uses for its host |
| POST | `/v1/accounts/{id}/validate` | Re-check token, refresh profile, clear or set `needsReauth` |
| DELETE | `/v1/accounts/{id}` | Sign out: revoke where possible, delete keyring entry and row, reselect another account on that host if one exists |

Events: `accounts.changed` (after sign-in, switch, sign-out, a validation that changed the state, or a failed background refresh) and `accounts.deviceFlow.updated { flowId, status }` when a browser sign-in finishes; both are documented in `doc/api/events-v1.md`. The renderer has a single event connection in `App`, so the sign-in form polls `GET /v1/accounts/device-flows/{flowId}` every 2 seconds instead (the core does the provider polling); the repository refresh planner ignores `accounts.*` events so they do not trigger a repository resync.

Device flows live in memory in `AccountService`: at most 8, a new flow for the same provider and host replaces a pending one, finished flows stay readable for 10 minutes, the poller honours `slow_down` (+5 s), gives up after 3 consecutive network failures, and only accepts a verification URI on the provider's own host. Signing out of a GitLab browser account also revokes its access and refresh tokens (best effort, after the local delete); GitHub OAuth App tokens need the client secret to revoke, so the notice points to the user's GitHub application settings.

Error codes added to `ApiErrorCode`: `AccountInputInvalid`, `AccountNotFound`, `AccountTokenRejected` (401 from provider), `AccountProviderUnreachable`, `AccountProviderNotConfigured` (no client ID for that host, 409), `AccountFlowNotFound` (404) and `AccountSignInRejected` (the provider refused the device request, for example a disabled OAuth app, 502). Denied and expired sign-ins are flow statuses, not errors.

Spec: add the routes and schemas to `doc/api/v1.yaml`, regenerate `src/api/schema.ts` with `pnpm api:types`, and document the events in `doc/api/events-v1.md`.

### Git authentication path

As built in phase 1, the core does not resolve each remote's host before spawning Git. The prompt already names the host:

1. `AccountService` keeps an in-memory copy of the per-host selections (`credentials::AccountSelections`), shared with `GitCommandService` and refreshed after every sign-in, switch and sign-out.
2. Every Git network command (fetch, pull, push, remote branch delete, clone) gets `GITCREST_ASKPASS_ACCOUNTS=host=acct_…;host=acct_…` plus, through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`, an empty `credential.https://<host>.helper` for each selected host. Git consults credential helpers before askpass, so without this a configured helper such as Git Credential Manager would answer for those hosts with whatever it has stored. Hosts without a selected account keep their helpers.
3. In the askpass process, `answer_askpass_prompt` takes the host from Git's prompt, answers from the selected account's keyring entry, and otherwise falls back to the per-host credential. The askpass process stays keyring-only and never opens SQLite.
4. Before spawning, `GitCommandService::network_environment()` asks `AccountSelections::refresh_expiring_tokens()` to renew the selected OAuth accounts whose token expires within 5 minutes. `AccountService` registers itself as the `AccountTokenRefresher` at startup. Refreshes are serialized (refresh tokens rotate), the new access + refresh pair replaces the old one in a single keyring write, and a refresh token the provider rejects marks the account `needsReauth`. A provider that cannot be reached leaves the old token for Git to try.
5. When a task fails with the `authentication` error category, `TaskService` hands its message and log to `AccountService::authentication_failed`, which takes the `https://` hosts Git named (`fatal: Authentication failed for 'https://github.com/…'`) and re-validates the account selected for each. Validation renews a rejected OAuth token first and marks the account `needsReauth` only when the provider really refuses it, so a token that merely lacks access to one repository is not flagged. Instead of an `accountId` on the task, the existing "configure credentials" action opens Settings → Accounts for the repository's hosts, where the account shows **Needs sign-in** with **Sign in again**.

SSH remotes are unaffected; accounts only cover HTTPS.

## Frontend

New feature slice `src/features/accounts/` (keep `pnpm frontend:boundaries` passing):

- `model/`: `useAccounts(api)` hook (list, select, sign out, subscribe to `accounts.changed`), `providerForHost(host)` (github.com → GitHub, gitlab.com → GitLab, else unknown and ask).
- `ui/AccountsSection.tsx`: a new **Accounts** section in Settings (add `"accounts"` to `SETTINGS_SECTIONS` after `general`). Accounts grouped by host; each row shows avatar, display name, `@login`, provider, method (Browser / Token), and a state badge (Active / Needs sign-in / Token expires in N days). Actions: **Use for <host>** (switch), **Sign in again**, **Sign out** (inline confirm, same pattern as `CredentialEditor`'s remove).
- `ui/SignInDialog.tsx`: step 1 choose GitHub or GitLab and host (prefilled `github.com` / `gitlab.com`, editable for Enterprise / self-managed); step 2a browser sign-in shows the user code large with **Copy code** and **Open GitHub/GitLab**, a waiting state, cancel, and expiry/denied messages; step 2b token sign-in shows a password field and a "Create a token" link with the scopes prefilled. Self-managed hosts without a configured client ID go straight to the token tab.
- `ui/AccountChip.tsx` (phase 3): in the workspace header, the active account for the current repository's default remote host; its menu lists other accounts on that host, **Add account…**, **Sign out**.
- `CredentialEditor` integration: when the host has a selected account, show "Signed in as @login · Switch" instead of the username/token form, with "Use a token for this host instead" folding the old form open. When the host is github.com / gitlab.com and nothing is configured, show **Sign in with GitHub/GitLab** above the manual form. This reaches clone, remote manager and task recovery without changing those callers.
- `api/client.ts`: `listAccounts`, `startDeviceFlow`, `getDeviceFlow`, `cancelDeviceFlow`, `signInWithToken`, `selectAccount`, `validateAccount`, `signOut`.
- i18n: `src/shared/i18n/messages/accounts.ts` with English and Chinese strings, registered in `messages/index.ts`.
- Avatars: load the provider avatar URL with `referrerPolicy="no-referrer"`, fall back to initials; check the renderer CSP allows `img-src https://avatars.githubusercontent.com https://gitlab.com https://secure.gravatar.com`, or proxy through the core.

## Security checklist

- Tokens live only in the keyring and in core memory as `Zeroizing`; no route returns them, and logs and task output never print them (add a test that the GET routes never contain the token string).
- DTOs use `deny_unknown_fields`, hosts go through `normalize_host`, provider API base URLs are built from the host and must be `https://`.
- Device-flow IDs are random and unguessable; flows are bound to the main window token and expire.
- Never send a token to a host other than the one the account belongs to (askpass checks prompt host == account host).
- Sign-out deletes the keyring entry before the row, so a crash in between never leaves a token without a visible account.
- Only the OAuth client IDs ship in the app; no client secret.

## Phases

1. **Accounts with tokens (done).** Migration, keyring store, GitHub + GitLab providers (`fetch_profile` only), `/v1/accounts` list / tokens / selection / delete / validate, askpass integration, Settings → Accounts with token sign-in, switch and sign-out. Already delivers sign in, switch and sign out for both providers, including Enterprise and self-managed.
2. **Browser sign-in (done, pending client IDs).** Device flow routes and events, refresh before Git commands, a Browser / Access token choice in the Settings sign-in form (one-time code, **Copy code and open GitHub/GitLab**, waiting, declined, expired and **Get a new code** states), and re-checking the account after failed Git tasks. Not yet verified against the live providers: GitLab's refresh grant for a public client is sent with `client_id` only, without `redirect_uri`.
3. **Everywhere else.** Header account chip, `CredentialEditor` integration, optional one-time import of existing per-host credentials into accounts (validate each with `fetch_profile`, keep the legacy entry if validation fails), and later per-repository account override (`repository_account` table keyed by RepoId) for users with work and personal accounts on the same host.

## Tests

- Rust unit: memory secret store + in-memory SQLite; selection rules (first account selected, sign-out reselects, duplicate sign-in replaces); askpass answers from the selected account and refuses a mismatched host; refresh replaces both tokens.
- Rust integration: run a small axum fake provider on 127.0.0.1 inside the test to serve `/login/device/code`, `/login/oauth/access_token` (pending → slow_down → granted), `/user`, GitLab `/oauth/token` and `/api/v4/user`; point the provider at it with the API base URL override.
- Router tests in `src/tests.rs`: read-only token gets 403 on mutations, GET never leaks secrets.
- Frontend vitest: Accounts section states, sign-in dialog transitions (pending, denied, expired, cancel), CredentialEditor's signed-in view.
- e2e: token sign-in against the fake provider, then a push to a local HTTPS test remote that requires that token.

## Open decisions

1. Who registers and owns the GitHub OAuth App and GitLab.com application (their client IDs ship in the build)?
2. Multiple accounts per host in phase 1, or one account per host until per-repository override exists?
3. Import existing per-host credentials into accounts automatically, on request, or never?
