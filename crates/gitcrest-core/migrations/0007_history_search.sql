CREATE TABLE IF NOT EXISTS history_search_index_state (
    repo_id TEXT PRIMARY KEY NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    refs_fingerprint TEXT NOT NULL,
    indexed_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS history_search_documents (
    id INTEGER PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    oid TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    parents_json TEXT NOT NULL,
    author_name TEXT NOT NULL,
    author_email TEXT NOT NULL,
    committed_at_ms INTEGER NOT NULL,
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    UNIQUE(repo_id, oid)
);

CREATE INDEX IF NOT EXISTS history_search_documents_repo_order
    ON history_search_documents(repo_id, sort_order);

CREATE VIRTUAL TABLE IF NOT EXISTS history_search_fts USING fts5(
    message,
    content='history_search_documents',
    content_rowid='id',
    tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS history_search_documents_insert
AFTER INSERT ON history_search_documents BEGIN
    INSERT INTO history_search_fts(rowid, message) VALUES (new.id, new.message);
END;

CREATE TRIGGER IF NOT EXISTS history_search_documents_delete
AFTER DELETE ON history_search_documents BEGIN
    INSERT INTO history_search_fts(history_search_fts, rowid, message)
    VALUES ('delete', old.id, old.message);
END;

CREATE TRIGGER IF NOT EXISTS history_search_documents_update
AFTER UPDATE ON history_search_documents BEGIN
    INSERT INTO history_search_fts(history_search_fts, rowid, message)
    VALUES ('delete', old.id, old.message);
    INSERT INTO history_search_fts(rowid, message) VALUES (new.id, new.message);
END;
