BEGIN IMMEDIATE;

DROP TRIGGER IF EXISTS history_search_documents_insert;
DROP TRIGGER IF EXISTS history_search_documents_delete;
DROP TRIGGER IF EXISTS history_search_documents_update;
DROP TABLE IF EXISTS history_search_fts;
DROP TABLE IF EXISTS history_search_documents;
DELETE FROM history_search_index_state;

CREATE TABLE history_search_documents (
    id INTEGER PRIMARY KEY,
    repo_id TEXT NOT NULL REFERENCES repositories(repo_id) ON DELETE CASCADE,
    oid TEXT NOT NULL,
    message TEXT NOT NULL
);

CREATE INDEX history_search_documents_repo
    ON history_search_documents(repo_id);

CREATE VIRTUAL TABLE history_search_fts USING fts5(
    message,
    content='history_search_documents',
    content_rowid='id',
    tokenize='trigram'
);

CREATE TRIGGER history_search_documents_insert
AFTER INSERT ON history_search_documents BEGIN
    INSERT INTO history_search_fts(rowid, message) VALUES (new.id, new.message);
END;

CREATE TRIGGER history_search_documents_delete
AFTER DELETE ON history_search_documents BEGIN
    INSERT INTO history_search_fts(history_search_fts, rowid, message)
    VALUES ('delete', old.id, old.message);
END;

CREATE TRIGGER history_search_documents_update
AFTER UPDATE ON history_search_documents BEGIN
    INSERT INTO history_search_fts(history_search_fts, rowid, message)
    VALUES ('delete', old.id, old.message);
    INSERT INTO history_search_fts(rowid, message) VALUES (new.id, new.message);
END;

COMMIT;
