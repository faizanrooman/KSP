# Audit ledger, viewer & compliance

The ledger (`db/migrations/0002_audit_ledger.sql`) is append-only (`audit_append()` only; UPDATE/DELETE/TRUNCATE
blocked by triggers and revoked from `ksp_app`) and hash-chained: `hash = sha256(prev_hash || '|' || canonical(row))`.
`audit_verify(from, to)` recomputes the chain and returns the first broken row.

## API (`apps/api/src/modules/audit`)

| Method | Path | Permission |
|---|---|---|
| GET | `/audit/events` — filters `from,to,actor,action(csv),category,outcome,resourceType,resourceId,evidenceId,caseId,orgUnitId,q` (details text), keyset `before=<seq>&limit≤200`, newest first → `{items,nextCursor}` | `audit:read` |
| GET | `/audit/events/:seq` — event + row verification `{hashOk,linkOk,verified}` | `audit:read` |
| POST | `/audit/export` `{format: csv\|json, filters}` → stored in the reports bucket (streamed), `{id,rowCount,sizeBytes,sha256,downloadUrl}` | `audit:export` |
| GET | `/audit/exports/:id/download` (creator only; `X-Content-SHA256`) | `audit:export` |
| POST | `/audit/verify` `{from?,to?}` → `audit_verify` + comparison with checkpoints in range | `audit:verify` |
| GET | `/audit/checkpoints` (+ current ledger head) | `audit:read` or `audit:verify` |
| POST | `/audit/checkpoints` — cut one now | `audit:verify` |
| GET | `/audit/checkpoints/:id/verify` — signature, head hash, chain since previous checkpoint | `audit:verify` |
| GET | `/audit/checkpoints/export` — all checkpoints + signed payloads + signing certificate | `audit:export` |

* **Scope**: a principal whose audit grant is at the state root sees everything; otherwise only events whose
  `org_unit_id` is inside their subtree (events without an org unit are root-only).
* **AUDIT_VIEWED** is written at most once per user per 10 minutes. `AUDIT_EXPORTED` records the file hash.
  `AUDIT_VERIFIED` records every verification (SUCCESS/FAILURE).
* A broken chain raises a **CRITICAL `AUDIT_CHAIN_BROKEN` alert** (dedupe per first bad seq).
* CSV cells starting with `= + - @` are prefixed with `'` (spreadsheet formula injection).

## Checkpoints

Worker cron `audit.checkpoint` (hourly, `apps/worker/src/jobs/audit`) → `createCheckpoint()`
(`packages/core/src/custody/checkpoint.ts`): verify the chain from the last good checkpoint's head+1 to the
current head; if intact, sign the verified head and insert `audit_checkpoints` (+ `cert_fingerprint`,
`verified_from_seq`, `chain_ok`) and `AUDIT_CHECKPOINT_CREATED`. A broken chain is **never signed**.

Signed payload (exact bytes):

```
KSP-AUDIT-CHECKPOINT
v=1
seq=<head_seq>
hash=<head_hash>
created=<ISO-8601 created_at>
key=<key_id>
```

### Exporting checkpoints to an external notary / WORM location

The database superuser could in principle rewrite ledger rows and recompute every later hash. Checkpoints
defeat that only if a copy lives outside the database's control:

1. Schedule `GET /api/v1/audit/checkpoints/export` (auditor/API account with `audit:export`) daily.
2. Store the JSON in a location the DB administrators cannot modify: an S3 bucket in a different account with
   Object Lock (COMPLIANCE mode), an RFC 3161 timestamping/notary service (hash of the file), or signed e-mail
   to the compliance officer. **UNVERIFIED**: no such external target is configured in this environment.
3. To check later: for each exported checkpoint, verify the signature over `payload` with the published
   certificate (`openssl dgst -sha256 -verify pub.pem -signature <(echo -n "$sig" | base64 -d) payload.txt`),
   and confirm the live ledger still has `hash` at `seq` (`GET /audit/checkpoints/:id/verify` or
   `/audit/events/:seq`).

## Tests

`apps/api/test/audit.test.ts`: authz (IO 403), filters + keyset pagination, district scope, throttled
AUDIT_VIEWED, CSV/JSON export hash == downloaded file, full verify, checkpoint signature + head, forged
signature / wrong head detected, and a tamper test that disables the trigger as the owner role, modifies a row
(custody + ledger verification fail, alert raised), then restores the exact bytes.
`apps/worker/test/audit.test.ts`: incremental checkpoints + cron consumer via pg-boss.

## Web

Nav **Compliance**: *Audit log* (filters in the URL, "Load more", event drawer with hash/prev hash and
verification, export dialog showing the file SHA-256) and *Ledger verification* (verify range, checkpoints with
per-row verify, sign now, export checkpoints).
