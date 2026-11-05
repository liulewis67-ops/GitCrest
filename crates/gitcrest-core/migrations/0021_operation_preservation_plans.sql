CREATE TABLE git_operation_preservation_plans (
    operation_id TEXT PRIMARY KEY NOT NULL
        REFERENCES git_operations(operation_id) ON DELETE RESTRICT,
    plan_json TEXT NOT NULL
);
