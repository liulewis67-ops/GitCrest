ALTER TABLE staging_undo_records
    ADD COLUMN operation_kind TEXT NOT NULL DEFAULT 'staging';

ALTER TABLE staging_undo_records
    ADD COLUMN scope TEXT;
