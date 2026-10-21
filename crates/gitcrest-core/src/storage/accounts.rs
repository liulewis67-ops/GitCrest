use rusqlite::{params, Row};

use crate::{
    domain::{
        account::{AccountAuthKind, AccountState, HostingAccount, HostingProvider},
        error::RepositoryError,
    },
    ports::accounts::HostingAccountStorePort,
};

use super::RepositoryStore;

const ACCOUNT_COLUMNS: &str = "account_id, provider, host, api_base_url, remote_user_id, login, display_name, avatar_url, auth_kind, scopes, token_expires_at_ms, state, created_at_ms, last_validated_at_ms";

fn account_from_row(row: &Row<'_>) -> rusqlite::Result<HostingAccount> {
    let invalid = |index: usize| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            "unknown hosting account value".into(),
        )
    };
    let provider: String = row.get(1)?;
    let auth_kind: String = row.get(8)?;
    let scopes: String = row.get(9)?;
    let state: String = row.get(11)?;
    Ok(HostingAccount {
        account_id: row.get(0)?,
        provider: HostingProvider::parse(&provider).ok_or_else(|| invalid(1))?,
        host: row.get(2)?,
        api_base_url: row.get(3)?,
        remote_user_id: row.get(4)?,
        login: row.get(5)?,
        display_name: row.get(6)?,
        avatar_url: row.get(7)?,
        auth_kind: AccountAuthKind::parse(&auth_kind).ok_or_else(|| invalid(8))?,
        scopes: scopes
            .split(',')
            .filter(|scope| !scope.is_empty())
            .map(str::to_owned)
            .collect(),
        token_expires_at_ms: row.get(10)?,
        state: AccountState::parse(&state).ok_or_else(|| invalid(11))?,
        created_at_ms: row.get(12)?,
        last_validated_at_ms: row.get(13)?,
    })
}

impl RepositoryStore {
    pub fn hosting_accounts(&self) -> Result<Vec<HostingAccount>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        let mut statement = connection
            .prepare(&format!(
                "SELECT {ACCOUNT_COLUMNS} FROM hosting_accounts ORDER BY host, login COLLATE NOCASE, account_id"
            ))
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], account_from_row)
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn hosting_account_selections(&self) -> Result<Vec<(String, String)>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        let mut statement = connection
            .prepare("SELECT host, account_id FROM hosting_account_selections ORDER BY host")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn save_hosting_account(&self, account: &HostingAccount) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        connection
            .execute(
                &format!(
                    "INSERT INTO hosting_accounts ({ACCOUNT_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                     ON CONFLICT(account_id) DO UPDATE SET
                        api_base_url=excluded.api_base_url,
                        login=excluded.login,
                        display_name=excluded.display_name,
                        avatar_url=excluded.avatar_url,
                        auth_kind=excluded.auth_kind,
                        scopes=excluded.scopes,
                        token_expires_at_ms=excluded.token_expires_at_ms,
                        state=excluded.state,
                        last_validated_at_ms=excluded.last_validated_at_ms"
                ),
                params![
                    account.account_id,
                    account.provider.as_str(),
                    account.host,
                    account.api_base_url,
                    account.remote_user_id,
                    account.login,
                    account.display_name,
                    account.avatar_url,
                    account.auth_kind.as_str(),
                    account.scopes.join(","),
                    account.token_expires_at_ms,
                    account.state.as_str(),
                    account.created_at_ms,
                    account.last_validated_at_ms,
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn select_hosting_account(&self, host: &str, account_id: &str) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        connection
            .execute(
                "INSERT INTO hosting_account_selections (host, account_id)
                 SELECT host, account_id FROM hosting_accounts WHERE account_id=?2 AND host=?1
                 ON CONFLICT(host) DO UPDATE SET account_id=excluded.account_id",
                params![host, account_id],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn delete_hosting_account(&self, account_id: &str) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        connection
            .execute(
                "DELETE FROM hosting_accounts WHERE account_id=?1",
                [account_id],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

impl HostingAccountStorePort for RepositoryStore {
    fn list_hosting_accounts(&self) -> Result<Vec<HostingAccount>, RepositoryError> {
        RepositoryStore::hosting_accounts(self).map_err(|_| RepositoryError::StorageUnavailable)
    }

    fn list_hosting_account_selections(&self) -> Result<Vec<(String, String)>, RepositoryError> {
        RepositoryStore::hosting_account_selections(self)
            .map_err(|_| RepositoryError::StorageUnavailable)
    }

    fn save_hosting_account(&self, account: &HostingAccount) -> Result<(), RepositoryError> {
        RepositoryStore::save_hosting_account(self, account)
            .map_err(|_| RepositoryError::StorageUnavailable)
    }

    fn select_hosting_account(&self, host: &str, account_id: &str) -> Result<(), RepositoryError> {
        RepositoryStore::select_hosting_account(self, host, account_id)
            .map_err(|_| RepositoryError::StorageUnavailable)
    }

    fn delete_hosting_account(&self, account_id: &str) -> Result<(), RepositoryError> {
        RepositoryStore::delete_hosting_account(self, account_id)
            .map_err(|_| RepositoryError::StorageUnavailable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(account_id: &str, host: &str, remote_user_id: &str) -> HostingAccount {
        HostingAccount {
            account_id: account_id.into(),
            provider: HostingProvider::Github,
            host: host.into(),
            api_base_url: "https://api.github.com".into(),
            remote_user_id: remote_user_id.into(),
            login: "octocat".into(),
            display_name: Some("The Octocat".into()),
            avatar_url: None,
            auth_kind: AccountAuthKind::Token,
            scopes: vec!["repo".into(), "read:user".into()],
            token_expires_at_ms: Some(42),
            state: AccountState::Active,
            created_at_ms: 1,
            last_validated_at_ms: 2,
        }
    }

    #[test]
    fn stores_accounts_and_drops_the_selection_with_its_account() {
        let store = RepositoryStore::default();
        store
            .save_hosting_account(&account("acct_a", "github.com", "1"))
            .unwrap();
        store
            .save_hosting_account(&account("acct_b", "github.com", "2"))
            .unwrap();
        assert_eq!(
            store.hosting_accounts().unwrap()[0],
            account("acct_a", "github.com", "1")
        );

        store
            .select_hosting_account("github.com", "acct_a")
            .unwrap();
        store
            .select_hosting_account("github.com", "acct_b")
            .unwrap();
        // A selection must name an account that belongs to the host.
        store
            .select_hosting_account("gitlab.com", "acct_a")
            .unwrap();
        assert_eq!(
            store.hosting_account_selections().unwrap(),
            vec![("github.com".to_string(), "acct_b".to_string())]
        );

        store.delete_hosting_account("acct_b").unwrap();
        assert!(store.hosting_account_selections().unwrap().is_empty());
        assert_eq!(store.hosting_accounts().unwrap().len(), 1);
    }

    #[test]
    fn rejects_a_second_row_for_the_same_remote_user() {
        let store = RepositoryStore::default();
        store
            .save_hosting_account(&account("acct_a", "github.com", "1"))
            .unwrap();
        assert!(store
            .save_hosting_account(&account("acct_b", "github.com", "1"))
            .is_err());
    }
}
