CREATE TABLE hosting_accounts (
    account_id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab')),
    host TEXT NOT NULL,
    api_base_url TEXT NOT NULL,
    remote_user_id TEXT NOT NULL,
    login TEXT NOT NULL,
    display_name TEXT,
    avatar_url TEXT,
    auth_kind TEXT NOT NULL CHECK (auth_kind IN ('token', 'oauth')),
    scopes TEXT NOT NULL DEFAULT '',
    token_expires_at_ms INTEGER,
    state TEXT NOT NULL CHECK (state IN ('active', 'needsReauth')),
    created_at_ms INTEGER NOT NULL,
    last_validated_at_ms INTEGER NOT NULL,
    UNIQUE (provider, host, remote_user_id)
);

CREATE TABLE hosting_account_selections (
    host TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES hosting_accounts(account_id) ON DELETE CASCADE
);
