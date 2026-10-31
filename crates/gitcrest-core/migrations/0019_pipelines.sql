CREATE TABLE pipeline_rules (
    repo_id TEXT NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    rule_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    definition_json TEXT NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (repo_id, rule_id)
);

CREATE INDEX pipeline_rules_order_idx ON pipeline_rules(repo_id, position);

CREATE TABLE pipeline_repository_settings (
    repo_id TEXT PRIMARY KEY REFERENCES repositories(repo_id) ON DELETE CASCADE,
    execution_mode TEXT,
    in_place_dirty_policy TEXT
);

CREATE TABLE pipeline_runs (
    run_id TEXT PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    rule_snapshot_json TEXT NOT NULL,
    source_branch TEXT NOT NULL,
    source_oid TEXT NOT NULL,
    execution_mode TEXT NOT NULL,
    status TEXT NOT NULL,
    shelf_id TEXT,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);

CREATE INDEX pipeline_runs_repo_idx ON pipeline_runs(repo_id, created_at_ms DESC);

CREATE TABLE pipeline_steps (
    run_id TEXT NOT NULL REFERENCES pipeline_runs(run_id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    target_branch TEXT NOT NULL,
    remote TEXT NOT NULL,
    state TEXT NOT NULL,
    lease_oid TEXT,
    merge_oid TEXT,
    workspace_path TEXT,
    ephemeral_repo_id TEXT,
    message TEXT,
    PRIMARY KEY (run_id, position)
);

CREATE TABLE pipeline_app_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    execution_mode TEXT NOT NULL,
    in_place_dirty_policy TEXT NOT NULL
);
