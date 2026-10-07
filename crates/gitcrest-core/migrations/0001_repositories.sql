CREATE TABLE IF NOT EXISTS repositories (
    repo_id TEXT PRIMARY KEY NOT NULL,
    path TEXT NOT NULL,
    head TEXT,
    branch TEXT,
    detached INTEGER NOT NULL,
    state TEXT NOT NULL,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    last_accessed_at INTEGER NOT NULL,
    availability TEXT NOT NULL DEFAULT 'available'
);

CREATE INDEX IF NOT EXISTS repositories_recent_idx
    ON repositories(is_favorite DESC, last_accessed_at DESC);
