-- 1056: snapshot extraction runs in the worker (FN-8). The API validates and queues media.snapshot, then waits a
-- few seconds for the result (201 as before) or answers 202 + request id for polling.
CREATE TABLE snapshot_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id     uuid NOT NULL REFERENCES evidence(id),
  requested_by    uuid NOT NULL REFERENCES users(id),
  actor           jsonb NOT NULL,          -- audit actor snapshot for EVIDENCE_SNAPSHOT_CREATED
  params          jsonb NOT NULL,          -- {timeMs, source, frame, fps, bucket, key, versionId}
  status          text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED')),
  derivative_id   uuid REFERENCES evidence_derivatives(id) ON DELETE SET NULL,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE INDEX snapshot_requests_evidence ON snapshot_requests (evidence_id, created_at DESC);
REVOKE DELETE, TRUNCATE ON snapshot_requests FROM ksp_app;
