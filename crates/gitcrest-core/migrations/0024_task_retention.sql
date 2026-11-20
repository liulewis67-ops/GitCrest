CREATE TABLE IF NOT EXISTS task_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    retention_days INTEGER NOT NULL CHECK (retention_days BETWEEN 1 AND 3650)
);
CREATE INDEX IF NOT EXISTS tasks_retention ON tasks(status, updated_at_ms);
