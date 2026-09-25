# Decisions (ADR log)

Short architecture decision records. Newest last. Full rationale in `ARCHITECTURE-DECISIONS.md` once written.

| # | Decision | Why | Consequence |
|---|---|---|---|
| 1 | TypeScript monorepo (npm workspaces): Fastify 5 API, pg-boss worker, React 18/Vite web | One language across API/worker/web; shared typed contracts | Node 22 LTS required (bundled locally in `.local/node`) |
| 2 | PostgreSQL 16 is the system of record incl. queue (pg-boss) | One stateful dependency to operate/back up; transactional enqueue | Redis not needed; queue throughput bounded by PG (sufficient for ingestion volumes; revisit at very high scale) |
| 3 | S3 API for all object storage; originals in versioned buckets with Object Lock (GOVERNANCE default, COMPLIANCE allowed) + conditional writes | WORM immutability independent of application bugs; portable (AWS/MinIO/Ceph/NetApp) | Dev uses versitygw (MinIO binary unavailable, 410); Object Lock behaviour verified on versitygw |
| 4 | Tamper-evident audit ledger inside PostgreSQL (hash chain, append-only triggers, privilege revocation, signed checkpoints) | Chain of custody must be provable; even DB superuser edits detectable | Global advisory lock serialises audit appends (~thousands/s; fine) |
| 5 | DB-level evidence guard trigger (immutable columns after registration, no DELETE) | Defence in depth beyond API code | Tier migration/disposal are the only allowed storage-pointer changes |
| 6 | Three DB roles: owner (migrations), `ksp_app` (DML), `ksp_ai` (column-level grants only) | Least privilege; AI isolation enforced by the database | New tables auto-granted to `ksp_app`; `ksp_ai` needs explicit grants |
| 7 | Jurisdiction = ltree org path; role grants apply to a subtree; evidence carries denormalised `org_path` | Fast subtree filters; simple, auditable rule | Org units cannot be re-parented (would invalidate evidence scope) |
| 8 | Out-of-jurisdiction resources return 404, not 403 | Prevents IDOR existence probing | Tests assert 404 |
| 9 | Session = httpOnly SameSite=Strict cookies + CSRF double-submit + Origin check for browsers; Bearer tokens for station client/integrations; EdDSA access JWT 15 min + rotating opaque refresh tokens with reuse detection; every request re-checks the session row | Immediate revocation; stolen refresh tokens detected | One DB read per request (+10 s principal cache) |
| 10 | Media is never served by storage URLs; API streams with short-lived HMAC tokens bound to user, session, evidence and scope | Spec: controlled access; no permanent/public links | API is in the streaming path (scale horizontally; CDN with signed tokens is a later option) |
| 11 | Postgres full-text + trigram + GIN for search (OpenSearch deferred) | Permission-aware SQL filtering in the same query; fewer moving parts | Revisit if corpus exceeds tens of millions of detections |
| 12 | Docker unavailable on the dev host | Environment constraint | Container/compose/k8s artefacts are UNVERIFIED until built elsewhere |
| 13 | PostgreSQL JIT disabled for the application database (`ALTER DATABASE … SET jit = off`, migration 0901) | Jurisdiction filters inflate planner cost estimates so JIT compilation dominated dashboard queries (1.3 s → 75–82 ms on 50k evidence rows) | Affects every module; re-evaluate per query if analytical workloads are added |
| 14 | Single React 18.3.1 pinned at the repository root + Vite `resolve.dedupe` | A test library had hoisted React 19 beside the web app's React 18 | Upgrade React deliberately, across the workspace |
| 15 | Backups encrypted with age (X25519 recipients); backup hosts hold only public keys, the identity is offline | AEAD, streaming, no shared secret on the backup host (`openssl enc` has no GCM CLI) | Restore needs the offline key (two-person retrieval); keep every old identity |
| 16 | Backup verification = restore into a scratch DB + migration checksums + `audit_verify()` + manifest head-hash check | Hashes alone do not prove restorability or catch a re-sealed tampered dump | Weekly verify job needs a scratch PostgreSQL |
| 17 | DR object copies keep the same bucket names at the DR site; native replication (version IDs preserved) is primary, `s3-replicate.ts` is fallback + verifier with `--repoint` (custody-audited `EVIDENCE_STORAGE_REPOINTED`) | The DB references originals by bucket/key/version; the evidence guard permits version-id changes only | Repoint needed after failover onto tool-made copies |
| 18 | Migrations run as the database owner (`ksp_owner` LOGIN), never a superuser, in deployed environments | Least privilege; verified all migrations apply as NOSUPERUSER owner | DB owner could still disable its own triggers — tampering remains detectable via the hash chain |
| 19 | One-shot Jobs (migrate, models) are applied separately before workloads (`scripts/ops/k8s-deploy.sh`) | Job templates are immutable; new pods must not start on an old schema | Deploy is a two-phase script, not a single `kubectl apply` |
