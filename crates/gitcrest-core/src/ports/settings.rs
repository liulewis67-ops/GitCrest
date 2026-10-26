use std::path::Path;

use crate::domain::{ai::AiProviderConfig, error::RepositoryError};

pub(crate) trait AiProviderConfigPort: Send + Sync {
    fn read_ai_provider_config(&self) -> Result<AiProviderConfig, RepositoryError>;

    fn save_ai_provider_config(&self, config: &AiProviderConfig) -> Result<(), RepositoryError>;

    /// Where the configuration lives, shown in Settings so it can be edited or backed up by hand.
    fn ai_provider_config_location(&self) -> Option<&Path>;
}
