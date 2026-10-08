use std::{
    env,
    error::Error,
    ffi::OsString,
    fmt,
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    str::FromStr,
};

use axum::http::HeaderValue;

pub(crate) struct AppConfig {
    pub(crate) listen_address: SocketAddr,
    pub(crate) write_token: String,
    pub(crate) read_only_token: Option<String>,
    pub(crate) conflict_token: Option<String>,
    pub(crate) database_path: PathBuf,
    pub(crate) cors_origin: Option<HeaderValue>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ConfigError {
    NonUnicodeValue(&'static str),
    MissingWriteToken,
    EmptyWriteToken,
    InvalidHost,
    InvalidPort,
    DuplicateReadOnlyToken,
    DuplicateConflictToken,
    InvalidCorsOrigin,
    EmptyDatabasePath,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::NonUnicodeValue(name) => {
                return write!(formatter, "{name} must be valid Unicode")
            }
            Self::MissingWriteToken => "GITCREST_AUTH_TOKEN is required to start gitcrest-core",
            Self::EmptyWriteToken => "GITCREST_AUTH_TOKEN must not be empty",
            Self::InvalidHost => "GITCREST_HOST must be a loopback IP address",
            Self::InvalidPort => "GITCREST_PORT must be an integer from 0 to 65535",
            Self::DuplicateReadOnlyToken => {
                "GITCREST_READONLY_TOKEN must differ from GITCREST_AUTH_TOKEN"
            }
            Self::DuplicateConflictToken => {
                "GITCREST_CONFLICT_TOKEN must be distinct from other API tokens"
            }
            Self::InvalidCorsOrigin => "GITCREST_CORS_ORIGIN must be a valid HTTP header value",
            Self::EmptyDatabasePath => "GITCREST_DATABASE_PATH must not be empty",
        };
        formatter.write_str(message)
    }
}

impl Error for ConfigError {}

impl AppConfig {
    pub(crate) fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|name| env::var_os(name))
    }

    fn from_lookup(mut lookup: impl FnMut(&str) -> Option<OsString>) -> Result<Self, ConfigError> {
        let host = lookup("GITCREST_HOST")
            .map(|value| unicode_value("GITCREST_HOST", value))
            .transpose()?
            .unwrap_or_else(|| "127.0.0.1".to_owned());
        let host = parse_loopback_host(&host)?;
        let port = lookup("GITCREST_PORT")
            .map(|value| unicode_value("GITCREST_PORT", value))
            .transpose()?
            .map(|value| parse_port(&value))
            .transpose()?
            .unwrap_or(0);
        let write_token = lookup("GITCREST_AUTH_TOKEN")
            .ok_or(ConfigError::MissingWriteToken)
            .and_then(|value| unicode_value("GITCREST_AUTH_TOKEN", value))?;
        if write_token.is_empty() {
            return Err(ConfigError::EmptyWriteToken);
        }
        let read_only_token = optional_token(&mut lookup, "GITCREST_READONLY_TOKEN")?;
        if read_only_token.as_deref() == Some(write_token.as_str()) {
            return Err(ConfigError::DuplicateReadOnlyToken);
        }
        let conflict_token = optional_token(&mut lookup, "GITCREST_CONFLICT_TOKEN")?;
        if conflict_token.as_deref() == Some(write_token.as_str())
            || (conflict_token.is_some() && conflict_token.as_deref() == read_only_token.as_deref())
        {
            return Err(ConfigError::DuplicateConflictToken);
        }

        let database_path = lookup("GITCREST_DATABASE_PATH")
            .map(PathBuf::from)
            .map(Ok)
            .unwrap_or_else(|| default_database_path(&mut lookup));
        let database_path = database_path?;
        if database_path.as_os_str().is_empty() {
            return Err(ConfigError::EmptyDatabasePath);
        }
        let cors_origin = lookup("GITCREST_CORS_ORIGIN")
            .map(|value| unicode_value("GITCREST_CORS_ORIGIN", value))
            .transpose()?
            .filter(|origin| !origin.is_empty())
            .map(|origin| {
                HeaderValue::from_str(&origin).map_err(|_| ConfigError::InvalidCorsOrigin)
            })
            .transpose()?;

        Ok(Self {
            listen_address: SocketAddr::new(host, port),
            write_token,
            read_only_token,
            conflict_token,
            database_path,
            cors_origin,
        })
    }
}

fn unicode_value(name: &'static str, value: OsString) -> Result<String, ConfigError> {
    value
        .into_string()
        .map_err(|_| ConfigError::NonUnicodeValue(name))
}

fn optional_token(
    lookup: &mut impl FnMut(&str) -> Option<OsString>,
    name: &'static str,
) -> Result<Option<String>, ConfigError> {
    lookup(name)
        .map(|value| unicode_value(name, value))
        .transpose()
        .map(|value| value.filter(|token| !token.is_empty()))
}

fn parse_loopback_host(host: &str) -> Result<IpAddr, ConfigError> {
    let address = IpAddr::from_str(host).map_err(|_| ConfigError::InvalidHost)?;
    if address.is_loopback() {
        Ok(address)
    } else {
        Err(ConfigError::InvalidHost)
    }
}

fn parse_port(port: &str) -> Result<u16, ConfigError> {
    port.parse().map_err(|_| ConfigError::InvalidPort)
}

fn default_database_path(
    lookup: &mut impl FnMut(&str) -> Option<OsString>,
) -> Result<PathBuf, ConfigError> {
    if let Some(local_app_data) = lookup("LOCALAPPDATA") {
        return Ok(PathBuf::from(local_app_data)
            .join("GitCrest")
            .join("gitcrest.sqlite"));
    }
    if let Some(home) = lookup("HOME") {
        return Ok(PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("gitcrest")
            .join("gitcrest.sqlite"));
    }
    Ok(env::temp_dir().join("gitcrest").join("gitcrest.sqlite"))
}

#[cfg(test)]
mod tests {
    use std::{collections::HashMap, ffi::OsString, net::SocketAddr};

    use super::{parse_loopback_host, parse_port, AppConfig, ConfigError};

    #[test]
    fn config_requires_a_nonempty_write_token_and_distinct_optional_tokens() {
        let missing: HashMap<String, OsString> = HashMap::new();
        assert!(matches!(
            AppConfig::from_lookup(|name| missing.get(name).cloned()),
            Err(ConfigError::MissingWriteToken)
        ));

        let empty = HashMap::from([("GITCREST_AUTH_TOKEN", OsString::new())]);
        assert!(matches!(
            AppConfig::from_lookup(|name| empty.get(name).cloned()),
            Err(ConfigError::EmptyWriteToken)
        ));

        let duplicate = HashMap::from([
            ("GITCREST_AUTH_TOKEN", OsString::from("same")),
            ("GITCREST_READONLY_TOKEN", OsString::from("same")),
        ]);
        assert!(matches!(
            AppConfig::from_lookup(|name| duplicate.get(name).cloned()),
            Err(ConfigError::DuplicateReadOnlyToken)
        ));

        let duplicate_conflict = HashMap::from([
            ("GITCREST_AUTH_TOKEN", OsString::from("write")),
            ("GITCREST_READONLY_TOKEN", OsString::from("same")),
            ("GITCREST_CONFLICT_TOKEN", OsString::from("same")),
        ]);
        assert!(matches!(
            AppConfig::from_lookup(|name| duplicate_conflict.get(name).cloned()),
            Err(ConfigError::DuplicateConflictToken)
        ));
    }

    #[test]
    fn config_defaults_to_loopback_and_an_ephemeral_port() {
        let values = HashMap::from([("GITCREST_AUTH_TOKEN", OsString::from("write"))]);
        let config = AppConfig::from_lookup(|name| values.get(name).cloned()).unwrap();
        assert_eq!(config.listen_address, SocketAddr::from(([127, 0, 0, 1], 0)));
        assert_eq!(config.write_token, "write");
        assert!(config.read_only_token.is_none());
        assert!(config.conflict_token.is_none());
    }

    #[test]
    fn listen_host_must_be_an_ip_loopback_address() {
        assert!(parse_loopback_host("127.0.0.1").is_ok());
        assert!(parse_loopback_host("::1").is_ok());
        assert_eq!(
            parse_loopback_host("0.0.0.0"),
            Err(ConfigError::InvalidHost)
        );
        assert_eq!(
            parse_loopback_host("localhost"),
            Err(ConfigError::InvalidHost)
        );
    }

    #[test]
    fn invalid_ports_are_rejected_instead_of_silently_becoming_ephemeral() {
        assert_eq!(parse_port("0"), Ok(0));
        assert_eq!(parse_port("65535"), Ok(u16::MAX));
        assert_eq!(parse_port("65536"), Err(ConfigError::InvalidPort));
        assert_eq!(parse_port("invalid"), Err(ConfigError::InvalidPort));
    }
}
