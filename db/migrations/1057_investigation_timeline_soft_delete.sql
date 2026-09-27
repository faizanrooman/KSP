-- 1057: manual timeline events are soft-deleted like annotations (FN-12): deleted_at + deleted_by, never physically
-- removed by the application (DELETE revoked from ksp_app).
ALTER TABLE timeline_events ADD COLUMN deleted_at timestamptz;
ALTER TABLE timeline_events ADD COLUMN deleted_by uuid REFERENCES users(id);
ALTER TABLE timeline_events ADD CONSTRAINT timeline_events_deleted_by_required CHECK (deleted_at IS NULL OR deleted_by IS NOT NULL);
CREATE INDEX timeline_events_live ON timeline_events (workspace_id, occurred_at) WHERE deleted_at IS NULL;
REVOKE DELETE, TRUNCATE ON timeline_events FROM ksp_app;
