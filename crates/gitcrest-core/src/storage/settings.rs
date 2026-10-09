use rusqlite::params;

use crate::ports::settings::AiProviderSettingsPort;

use super::{now_ms, RepositoryStore};

impl RepositoryStore {
    pub fn ai_provider_settings(&self) -> Result<(String, String, String), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        connection
            .query_row(
                "SELECT provider, base_url, model FROM ai_provider_settings WHERE singleton_id=1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|error| error.to_string())
    }

    pub fn set_ai_provider_settings(
        &self,
        provider: &str,
        base_url: &str,
        model: &str,
    ) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "repository database lock poisoned".to_string())?;
        connection
            .execute(
                "UPDATE ai_provider_settings SET provider=?1, base_url=?2, model=?3, updated_at_ms=?4 WHERE singleton_id=1",
                params![provider, base_url, model, now_ms()],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

impl AiProviderSettingsPort for RepositoryStore {
    fn read_ai_provider_settings(
        &self,
    ) -> Result<(String, String, String), crate::domain::error::RepositoryError> {
        RepositoryStore::ai_provider_settings(self)
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
    }

    fn save_ai_provider_settings(
        &self,
        provider: &str,
        base_url: &str,
        model: &str,
    ) -> Result<(), crate::domain::error::RepositoryError> {
        RepositoryStore::set_ai_provider_settings(self, provider, base_url, model)
            .map_err(|_| crate::domain::error::RepositoryError::StorageUnavailable)
    }
}
