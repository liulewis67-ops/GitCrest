CREATE TABLE tasks (
    task_id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL,
    status TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE INDEX tasks_updated_at ON tasks(updated_at_ms DESC);
