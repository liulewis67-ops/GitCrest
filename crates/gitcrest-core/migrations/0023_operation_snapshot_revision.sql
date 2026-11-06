ALTER TABLE git_operations ADD COLUMN snapshot_revision INTEGER NOT NULL DEFAULT 1
    CHECK(typeof(snapshot_revision) = 'integer' AND snapshot_revision >= 1);
UPDATE git_operations SET snapshot_revision=version;

-- Snapshot revisions may skip values within one transaction. They order the
-- complete committed view of one operation, independently of command CAS.
CREATE TRIGGER git_operation_snapshot_parent
AFTER UPDATE OF repo_id,resource_key,request_id,request_hash,request_json,state_json,
    version,terminal,created_at_ms,updated_at_ms ON git_operations
BEGIN
    UPDATE git_operations SET snapshot_revision=snapshot_revision+1
    WHERE operation_id=NEW.operation_id;
END;
