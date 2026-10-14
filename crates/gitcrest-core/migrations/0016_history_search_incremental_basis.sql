BEGIN IMMEDIATE;

ALTER TABLE history_search_index_state ADD COLUMN tips TEXT;
ALTER TABLE history_search_index_state ADD COLUMN max_commit_time INTEGER;

COMMIT;
