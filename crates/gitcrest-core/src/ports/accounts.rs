use crate::domain::{account::HostingAccount, error::RepositoryError};

pub(crate) trait HostingAccountStorePort: Send + Sync {
    fn list_hosting_accounts(&self) -> Result<Vec<HostingAccount>, RepositoryError>;

    /// `(host, account_id)` pairs, one per host that has a selected account.
    fn list_hosting_account_selections(&self) -> Result<Vec<(String, String)>, RepositoryError>;

    /// Inserts the account, or replaces the row with the same `account_id`.
    fn save_hosting_account(&self, account: &HostingAccount) -> Result<(), RepositoryError>;

    fn select_hosting_account(&self, host: &str, account_id: &str) -> Result<(), RepositoryError>;

    /// Deletes the account and its selection, if any.
    fn delete_hosting_account(&self, account_id: &str) -> Result<(), RepositoryError>;
}
