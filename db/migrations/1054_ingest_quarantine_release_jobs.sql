-- 1054: asynchronous quarantine release (FN-4). The API validates the decision and queues ingest.release; the worker
-- re-hashes (if needed), stores and registers the item through the same registration path, writing the
-- EVIDENCE_QUARANTINE_RELEASED audit in the registration transaction under the releasing user (actor snapshot).
CREATE TABLE quarantine_releases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id     uuid NOT NULL REFERENCES evidence(id),
  requested_by    uuid NOT NULL REFERENCES users(id),
  reason          text NOT NULL CHECK (length(reason) BETWEEN 5 AND 2000),
  actor           jsonb NOT NULL,          -- audit actor snapshot {type,id,name,ip,userAgent,sessionId}
  status          text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED')),
  outcome         text,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz
);
CREATE UNIQUE INDEX quarantine_releases_one_pending ON quarantine_releases (evidence_id) WHERE status IN ('QUEUED','RUNNING');
CREATE INDEX quarantine_releases_evidence ON quarantine_releases (evidence_id, created_at DESC);
REVOKE DELETE, TRUNCATE ON quarantine_releases FROM ksp_app;
