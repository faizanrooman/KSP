-- Tender Appendix 1 §20: repository-wide suspect (face) search — "match the suspect person in less than one minute
-- with a database size of 1 lakh". A probe photo is embedded by the isolated AI worker and compared against the
-- stored face embeddings of every detected face. Results are returned to the requester filtered by evidence
-- visibility (the API applies evidenceVisibleSql); the worker never sees evidence metadata.

CREATE TABLE face_searches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by  uuid NOT NULL REFERENCES users(id),
  org_unit_id   uuid NOT NULL REFERENCES org_units(id),
  probe_key     text NOT NULL,                       -- derived bucket, ai/face-searches/<id>/probe.<ext>
  params        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {threshold, limit}
  status        text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED')),
  model_id      uuid REFERENCES ai_models(id),       -- recognition model used for the probe embedding
  result        jsonb,                               -- [{detectionId, evidenceId, similarity, frameTimeMs}] (top-K, unfiltered)
  stats         jsonb,                               -- {candidates, probeFaces, embedMs, scanMs, totalMs, worker}
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz
);
CREATE INDEX face_searches_queue ON face_searches (created_at) WHERE status = 'QUEUED';
CREATE INDEX face_searches_user ON face_searches (requested_by, created_at DESC);

-- ksp_ai: claim + complete searches, nothing else (requested_by/org_unit_id readable for audit attribution only).
GRANT SELECT ON face_searches TO ksp_ai;
GRANT UPDATE (status, started_at, finished_at, result, stats, error, model_id) ON face_searches TO ksp_ai;

-- ksp_ai may read the stored face embeddings it produced (still no access to review columns, crops, or evidence
-- metadata). `attributes` carries the embedding model id for FACE_DETECTION rows.
GRANT SELECT (id, evidence_id, task, model_id, frame_time_ms, embedding, attributes) ON ai_detections TO ksp_ai;

-- Candidate scan: every face with an embedding.
CREATE INDEX ai_detections_face_embeddings ON ai_detections (task, model_id) WHERE embedding IS NOT NULL;

-- The app role must not rewrite results after the worker wrote them (append-only outcome; cancellation only).
REVOKE DELETE ON face_searches FROM ksp_app;
