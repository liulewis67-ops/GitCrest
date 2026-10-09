use crate::domain::error::RepositoryError;

pub(crate) trait AiProviderSettingsPort: Send + Sync {
    fn read_ai_provider_settings(&self) -> Result<(String, String, String), RepositoryError>;

    fn save_ai_provider_settings(
        &self,
        provider: &str,
        base_url: &str,
        model: &str,
    ) -> Result<(), RepositoryError>;
}
