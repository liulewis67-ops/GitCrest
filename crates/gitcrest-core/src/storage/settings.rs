use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

use crate::{
    domain::{ai::AiProviderConfig, error::RepositoryError},
    ports::settings::AiProviderConfigPort,
};

pub(crate) const AI_PROVIDER_CONFIG_FILE: &str = "ai-providers.json";
const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

/// AI providers live in a JSON file beside the database instead of a SQLite table, so the
/// configuration (API keys included) can be read, edited or backed up by hand.
pub(crate) struct JsonAiProviderStore {
    path: PathBuf,
    write_lock: Mutex<()>,
}

impl JsonAiProviderStore {
    pub(crate) fn beside_database(database_path: &Path) -> Self {
        let directory = database_path.parent().unwrap_or_else(|| Path::new("."));
        Self::new(directory.join(AI_PROVIDER_CONFIG_FILE))
    }

    pub(crate) fn new(path: PathBuf) -> Self {
        Self {
            path,
            write_lock: Mutex::new(()),
        }
    }

    fn read(&self) -> Result<AiProviderConfig, RepositoryError> {
        let metadata = match std::fs::metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(AiProviderConfig::default())
            }
            Err(_) => return Err(RepositoryError::StorageUnavailable),
        };
        if !metadata.is_file() || metadata.len() > MAX_CONFIG_BYTES {
            return Err(RepositoryError::StorageUnavailable);
        }
        let bytes = std::fs::read(&self.path).map_err(|_| RepositoryError::StorageUnavailable)?;
        // A file the user broke by hand is reported, never silently replaced.
        let config: AiProviderConfig =
            serde_json::from_slice(&bytes).map_err(|_| RepositoryError::StorageUnavailable)?;
        if config.version > AiProviderConfig::VERSION {
            return Err(RepositoryError::StorageUnavailable);
        }
        Ok(config)
    }

    fn write(&self, config: &AiProviderConfig) -> Result<(), RepositoryError> {
        let directory = self
            .path
            .parent()
            .ok_or(RepositoryError::StorageUnavailable)?;
        std::fs::create_dir_all(directory).map_err(|_| RepositoryError::StorageUnavailable)?;
        let mut bytes =
            serde_json::to_vec_pretty(config).map_err(|_| RepositoryError::StorageUnavailable)?;
        bytes.push(b'\n');
        // The temporary file is owner-only on Unix; the rename keeps a crash from leaving half a file.
        let mut file = tempfile::NamedTempFile::new_in(directory)
            .map_err(|_| RepositoryError::StorageUnavailable)?;
        file.write_all(&bytes)
            .and_then(|_| file.as_file().sync_all())
            .map_err(|_| RepositoryError::StorageUnavailable)?;
        file.persist(&self.path)
            .map_err(|_| RepositoryError::StorageUnavailable)?;
        Ok(())
    }
}

impl AiProviderConfigPort for JsonAiProviderStore {
    fn read_ai_provider_config(&self) -> Result<AiProviderConfig, RepositoryError> {
        self.read()
    }

    fn save_ai_provider_config(&self, config: &AiProviderConfig) -> Result<(), RepositoryError> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| RepositoryError::StorageUnavailable)?;
        self.write(config)
    }

    fn ai_provider_config_location(&self) -> Option<&Path> {
        Some(&self.path)
    }
}

#[cfg(test)]
#[derive(Default)]
pub(crate) struct MemoryAiProviderStore {
    config: Mutex<Option<AiProviderConfig>>,
}

#[cfg(test)]
impl AiProviderConfigPort for MemoryAiProviderStore {
    fn read_ai_provider_config(&self) -> Result<AiProviderConfig, RepositoryError> {
        Ok(self
            .config
            .lock()
            .map_err(|_| RepositoryError::StorageUnavailable)?
            .clone()
            .unwrap_or_default())
    }

    fn save_ai_provider_config(&self, config: &AiProviderConfig) -> Result<(), RepositoryError> {
        *self
            .config
            .lock()
            .map_err(|_| RepositoryError::StorageUnavailable)? = Some(config.clone());
        Ok(())
    }

    fn ai_provider_config_location(&self) -> Option<&Path> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::ai::{AiApiFormat, AiProviderRecord};

    #[test]
    fn provider_config_round_trips_through_the_json_file() {
        let directory = tempfile::tempdir().unwrap();
        let store = JsonAiProviderStore::beside_database(&directory.path().join("gitcrest.sqlite"));
        assert!(store
            .read_ai_provider_config()
            .unwrap()
            .providers
            .is_empty());

        let config = AiProviderConfig {
            version: AiProviderConfig::VERSION,
            active_provider_id: Some("claude".into()),
            providers: vec![AiProviderRecord {
                id: "claude".into(),
                name: "Claude".into(),
                api_format: AiApiFormat::AnthropicMessages,
                base_url: "https://api.anthropic.com/v1".into(),
                model: "claude-model".into(),
                api_key: Some("secret-key".to_string().into()),
                max_output_tokens: Some(4096),
            }],
        };
        store.save_ai_provider_config(&config).unwrap();

        let text = std::fs::read_to_string(directory.path().join(AI_PROVIDER_CONFIG_FILE)).unwrap();
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(json["activeProviderId"], "claude");
        assert_eq!(json["providers"][0]["apiFormat"], "anthropicMessages");
        assert_eq!(json["providers"][0]["apiKey"], "secret-key");

        let reopened =
            JsonAiProviderStore::beside_database(&directory.path().join("gitcrest.sqlite"));
        let read = reopened.read_ai_provider_config().unwrap();
        assert_eq!(read.active_provider().unwrap().model, "claude-model");
        assert_eq!(
            read.active_provider()
                .unwrap()
                .api_key
                .as_deref()
                .map(String::as_str),
            Some("secret-key")
        );
    }

    #[test]
    fn a_broken_file_is_reported_and_left_in_place() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(AI_PROVIDER_CONFIG_FILE);
        std::fs::write(&path, "{ not json").unwrap();
        let store = JsonAiProviderStore::new(path.clone());
        assert_eq!(
            store.read_ai_provider_config().unwrap_err(),
            RepositoryError::StorageUnavailable
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
    }
}
