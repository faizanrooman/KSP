# Evidence registry, integrity & lifecycle (spec modules 4, 5, 6)

Owner code: `apps/api/src/modules/evidence/` (`/api/v1/evidence`), `apps/api/src/modules/retention/`
(`/api/v1/retention`), `apps/worker/src/jobs/lifecycle/`, `apps/web/src/modules/evidence/`.
Schema: `db/migrations/0003_evidence.sql` (evidence, guard trigger, retention_policies, integrity_checks,
disposal_requests) and `db/migrations/0300_evidence_lifecycle.sql` (copy registry, legal-hold history,
disposal execution outcome).

Evidence rows are created by ingestion (upload → `RECEIVED` → finalize → `REGISTERED`). This module manages
them afterwards.

## State machine

```
REGISTERED ──request──▶ DISPOSAL_PENDING ──approve (2nd officer)──▶ [DISPOSAL_EXECUTE job] ──▶ DISPOSED (final)
     ▲                        │  reject / cancel                         │ storage refused / legal hold
     └────────────────────────┘                                          └─▶ stays DISPOSAL_PENDING, request APPROVED + execution_error
```

* `DISPOSED` is final (DB trigger). The evidence row, hashes, integrity history and audit trail are kept forever.
* Legal hold can be placed on any non-disposed evidence. It blocks: requesting disposal (API 409), approving
  (API 409), executing (worker, row locked `FOR UPDATE` for the whole execution), and the DB itself
  (`evidence_guard`: `status = 'DISPOSED'` is refused while `legal_hold`). An S3 Object Lock legal hold is also
  applied to every stored copy (defence in depth; DB is authoritative).
* Evidence linked to an **open** case (status not `CLOSED`/`ARCHIVED`) cannot be requested, approved or executed
  for disposal.

## API

All single-item routes call `loadEvidenceFor` (out of scope → 404, visible-but-not-permitted → 403 +
`EVIDENCE_ACCESS_DENIED`). All lists use `evidenceVisibleSql`. No response ever contains a storage bucket,
key or version id (asserted by tests).

| Method & path | Permission | Notes |
|---|---|---|
| `GET /evidence` | any of evidence:read / read_own / cases:read / search:use | filters `q, status, mediaStatus, storageTier` (comma lists), `orgUnitId` (subtree), `officerId, deviceId, uploadedBy, caseId, category, tag, recordedFrom/To, createdFrom/To, legalHold, hasGps`; `sort` ∈ ±`created_at, recorded_at, evidence_number, size_bytes, duration_ms`; `page, pageSize≤200` |
| `GET /evidence/:id` | visibility | detail (superset of `EvidenceSummary`) + `permissions{…}`; audits `EVIDENCE_VIEWED` |
| `PATCH /evidence/:id` | evidence:edit_metadata | only `title, description, category, incidentAt, locationText` (strict schema); `EVIDENCE_METADATA_UPDATED` with before/after |
| `POST /evidence/:id/tags` `{tag}` · `DELETE /evidence/:id/tags/:tag` | evidence:edit_metadata | lower-cased, `^[a-z0-9][a-z0-9 _:.-]{0,62}$`; only MANUAL tags removable; `EVIDENCE_TAGGED` |
| `GET /evidence/:id/jobs` | visibility | processing_jobs (results sanitised of storage fields) |
| `POST /evidence/:id/legal-hold` `{reason}` · `DELETE …` `{reason}` | evidence:legal_hold | returns `{storageHold: APPLIED\|NOT_SUPPORTED\|FAILED\|NOT_APPLICABLE}`; history in `evidence_legal_hold_events` |
| `POST /evidence/:id/verify` | evidence:verify | 202, queues `FIXITY_CHECK` (ON_DEMAND, singleton per evidence) |
| `GET /evidence/:id/integrity` | visibility | hashes, last result, pending job, check history |
| `GET /evidence/:id/lifecycle` | visibility | tier, lock-until, retention, copy registry (tier/status only), hold history, disposal requests |
| `POST /evidence/:id/retention` `{policyId}` | retention:manage | recomputes `retain_until`; `EVIDENCE_RETENTION_ASSIGNED` |
| `POST /evidence/:id/tier` `{targetTier}` | retention:manage | 202, queues `TIER_MIGRATE` |
| `GET /evidence/disposal-candidates` | retention:manage or dispose_request | REGISTERED, past `retain_until`, no hold, no open case, no open request. **Never auto-disposed.** |
| `POST /evidence/:id/disposal-requests` `{reason≥10, authorityRef}` | evidence:dispose_request | → `DISPOSAL_PENDING` |
| `GET /evidence/disposal-requests?status=` | dispose_request or dispose_approve | scoped by evidence visibility; each item has `canDecide/canCancel/canRetry` |
| `POST /evidence/disposal-requests/:id/approve\|reject` `{note}` | evidence:dispose_approve | approver ≠ requester (API 403 + DB CHECK); approve queues `DISPOSAL_EXECUTE` |
| `POST /evidence/disposal-requests/:id/cancel` | requester only | → back to `REGISTERED` |
| `POST /evidence/disposal-requests/:id/retry` | evidence:dispose_approve | re-queue a failed execution |
| `GET/POST /retention/policies`, `PATCH/DELETE /retention/policies/:id` | GET: evidence:read etc.; writes: retention:manage | exactly one default (switching unsets the old one; cannot unset directly); default or in-use policy cannot be deleted; changing `retentionDays` recomputes `retain_until` of live evidence under the policy |

Retention clock: `retain_until = coalesce(registered_at, created_at) + retention_days` (NULL days = indefinite).
Tier ages (`archive_after_days`, `long_term_after_days`) are also measured from registration.

## Worker (`apps/worker/src/jobs/lifecycle`)

| Queue / cron | Handler | Behaviour |
|---|---|---|
| `integrity.fixity` | `runFixityCheck` | streams the current copy (bucket/key/**version**), recomputes SHA-256 + SHA-512 + size; inserts `integrity_checks`; OK → `last_verified_at`; mismatch or missing object → `EVIDENCE_INTEGRITY_FAILED` + CRITICAL `INTEGRITY_FAILURE` alert (`dedupe_key = INTEGRITY_FAILURE:<id>`, occurrences bumped). Transient S3 errors are retried by pg-boss and record nothing. |
| `lifecycle.tier` | `runTierMigration` | copy to target tier bucket with Object Lock (CopyObject ≤ 5 GiB, streamed re-upload above) → re-hash the new version → **only if SHA-256/512/size match** switch the evidence pointer in one tx (copy registry, `integrity_checks` TIER_MIGRATION, `EVIDENCE_TIER_CHANGED`) → apply S3 legal hold to the new copy if held → delete the superseded version with governance bypass. Refused (or under legal hold) → kept as `RETAINED` in `evidence_storage_copies` with the reason. Verification failure → no switch, bad copy removed, `EVIDENCE_TIER_CHANGE_FAILED` + CRITICAL alert. |
| `lifecycle.dispose` | `runDisposal` | locks request + evidence rows; re-checks APPROVED / legal hold / open cases; lists **all versions and delete markers** under `originals/…/<evidenceId>/` in all three tier buckets (plus any registry location) and deletes each with governance bypass; re-lists to prove nothing remains; deletes `evidence/<id>/` in the derived bucket; then `DISPOSED`, request `EXECUTED`, `EVIDENCE_DISPOSED`. Any refusal → request stays `APPROVED` with `execution_error`, `EVIDENCE_DISPOSAL_FAILED` (outcome FAILURE). |
| cron `lifecycle.scan` (*/15) | `runLifecycleScan` | assigns the default policy where missing (custody event per item), queues due tier moves (skips items with a queued/running move), re-queues approved-but-never-executed disposals older than 15 min, counts disposal candidates. |
| cron `integrity.sweep` (02:00) | `runIntegritySweep` | **coverage target** (setting `integrityPolicy`): nightly batch = clamp(⌈copies / `fullCycleDays` (90)⌉, `minPerNight` 100, `maxPerNight` 200 000) within `maxBytesPerNight` (2 TiB); copies = current originals + RETAINED copies (`evidence_storage_copies`) + recorded DR copies (`dr_object_copies`, needs `DR_S3_*` on the worker). Order: never verified → originals moved by a tier migration in the last 7 days (verified only while copying) → least recently verified; copies verified in the last 24 h are skipped. Secondary copies get their own `integrity_checks` rows (`copy_kind` RETAINED / DR + copy id), their own `last_verified_at` and alert (`INTEGRITY_FAILURE:<id>:<kind>:<copyId>`). System health → "Integrity (fixity) coverage": % verified within the cycle, never verified, projected full-cycle days (degraded when longer than the policy), last sweep. |

Handlers are idempotent (tier NOOP when already in target; existing target copy is re-verified, not overwritten;
disposal re-run on an executed request is a no-op).

## Audit codes added

`EVIDENCE_DISPOSAL_CANCELLED`, `EVIDENCE_DISPOSAL_FAILED`, `EVIDENCE_INTEGRITY_CHECK_REQUESTED`,
`EVIDENCE_TIER_CHANGE_REQUESTED`, `EVIDENCE_TIER_CHANGE_FAILED` (all custody).

## Web

`/evidence` (list, URL-state filters, sortable table with thumbnails), `/evidence/:id` (detail; hosts
`EVIDENCE_TABS` / `EVIDENCE_ACTIONS` from every module, `?tab=` URL state; an extension is shown when the
user holds one of its `anyOf` permissions **and** the matching per-evidence flag in `detail.permissions` is
true — see `PERMISSION_FLAGS` in `modules/evidence/types.ts`), `/evidence/disposals` (requests + candidates),
`/retention/policies`. Own tabs: Overview (0), Integrity (80), Lifecycle (90). Own actions: Verify (80),
Legal hold (85), Request disposal (95).

## Test fixture

`apps/api/test/fixtures/evidence.ts` → `createRegisteredEvidence({ orgCode, uploadedBy, officerId?, deviceId?,
title?, description?, category?, recordedAt?, registeredAt?, retentionPolicyCode? (null = none), gps?,
corruptRecordedHash?, db? })` generates an FFmpeg MP4 (unique bytes per call), stores it at
`originals/<yyyy>/<mm>/<id>/<sha256>` with `{lock, ifNoneMatch}` and inserts a REGISTERED row with real
hashes/probe fields and an `EVIDENCE_REGISTERED` audit event. Pass `db` from non-API tests.
