CREATE TABLE staging_undo_records (
    record_id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_task_id TEXT NOT NULL UNIQUE,
    repo_id TEXT NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    created_at_ms INTEGER NOT NULL,
    reverse_patch BLOB NOT NULL
);

CREATE INDEX staging_undo_repo_created_idx
    ON staging_undo_records(repo_id, record_id DESC);
