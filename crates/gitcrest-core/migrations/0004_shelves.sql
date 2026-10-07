CREATE TABLE shelves (
    shelf_id TEXT PRIMARY KEY NOT NULL,
    repo_id TEXT NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    paths_json TEXT NOT NULL,
    head_oid TEXT,
    created_at_ms INTEGER NOT NULL,
    patch BLOB NOT NULL
);

CREATE INDEX shelves_repo_created_idx
    ON shelves(repo_id, created_at_ms DESC, shelf_id DESC);