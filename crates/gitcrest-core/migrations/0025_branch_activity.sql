CREATE TABLE IF NOT EXISTS branch_activity (
    resource_key TEXT NOT NULL,
    full_name TEXT NOT NULL,
    last_activity_at_ms INTEGER NOT NULL,
    PRIMARY KEY (resource_key, full_name)
);
