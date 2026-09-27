-- 1001: shared rate-limit store for @fastify/rate-limit (SEC-R4) so limits hold across API replicas.
-- UNLOGGED: counters are ephemeral (lost on crash / not replicated) — acceptable for rate limiting and avoids WAL.
CREATE UNLOGGED TABLE rate_limit_counters (
  key         text PRIMARY KEY,              -- <route prefix>-<client key (ip)>
  window_ms   integer NOT NULL CHECK (window_ms > 0),
  count       integer NOT NULL DEFAULT 1,
  expires_at  timestamptz NOT NULL
);
CREATE INDEX rate_limit_counters_expires ON rate_limit_counters (expires_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limit_counters TO ksp_app;
