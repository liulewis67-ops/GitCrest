CREATE TABLE git_operation_actions (
    operation_id TEXT NOT NULL REFERENCES git_operations(operation_id) ON DELETE RESTRICT,
    request_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    action_json TEXT NOT NULL,
    active INTEGER NOT NULL CHECK(active IN (0, 1)),
    PRIMARY KEY(operation_id, request_id)
);
CREATE UNIQUE INDEX git_operation_action_active_idx
    ON git_operation_actions(operation_id) WHERE active=1;
