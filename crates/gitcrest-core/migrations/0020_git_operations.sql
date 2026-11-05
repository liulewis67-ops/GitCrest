CREATE TABLE git_operations (
    operation_id TEXT PRIMARY KEY NOT NULL,
    repo_id TEXT NOT NULL REFERENCES repositories(repo_id) ON DELETE RESTRICT,
    resource_key TEXT NOT NULL,
    request_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    request_json TEXT NOT NULL,
    state_json TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version >= 1),
    terminal INTEGER NOT NULL CHECK(terminal IN (0, 1)),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE(repo_id, request_id),
    UNIQUE(operation_id, resource_key)
);

CREATE TABLE git_operation_owners (
    resource_key TEXT PRIMARY KEY NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    FOREIGN KEY(operation_id, resource_key)
        REFERENCES git_operations(operation_id, resource_key) ON DELETE RESTRICT
);

CREATE TABLE git_operation_steps (
    operation_id TEXT NOT NULL REFERENCES git_operations(operation_id) ON DELETE RESTRICT,
    sequence INTEGER NOT NULL CHECK(sequence >= 0),
    step_json TEXT NOT NULL,
    PRIMARY KEY(operation_id, sequence)
);

CREATE TABLE git_operation_backups (
    operation_id TEXT NOT NULL REFERENCES git_operations(operation_id) ON DELETE RESTRICT,
    shelf_id TEXT NOT NULL UNIQUE REFERENCES shelves(shelf_id) ON DELETE RESTRICT,
    save_order INTEGER NOT NULL CHECK(save_order >= 0),
    restore_order INTEGER NOT NULL CHECK(restore_order >= 0),
    backup_json TEXT NOT NULL,
    PRIMARY KEY(operation_id, shelf_id),
    UNIQUE(operation_id, save_order),
    UNIQUE(operation_id, restore_order)
);

CREATE INDEX git_operations_active_idx ON git_operations(terminal, created_at_ms, operation_id);
CREATE UNIQUE INDEX git_operations_active_repository_idx ON git_operations(repo_id) WHERE terminal=0;
