use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn unix_time_ms() -> i64 {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    i64::try_from(timestamp).unwrap_or(i64::MAX)
}
