CREATE TABLE branch_favorites (
    repo_id TEXT NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    full_name TEXT NOT NULL,
    PRIMARY KEY (repo_id, full_name)
);

CREATE INDEX branch_favorites_repo_idx ON branch_favorites(repo_id, full_name);
