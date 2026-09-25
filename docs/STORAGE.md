# Storage: tiers, immutability and verified behaviour

Buckets by role (`packages/core/src/storage.ts`): `staging`, `evidence` (ACTIVE tier), `archive`,
`longterm` (originals: versioning + Object Lock, `OBJECT_LOCK_MODE` / `OBJECT_LOCK_DAYS`), `derived`,
`exports`, `reports`. Clients never receive storage URLs or locations.

## Originals

* Key: `originals/<yyyy>/<mm>/<evidenceId>/<sha256>` — identical key in every tier bucket.
* Written with `{ lock: true, ifNoneMatch: true }`: conditional create (never overwrite) + Object Lock retention.
* `evidence.storage_bucket/key/version_id/tier` point at the CURRENT copy. `evidence_storage_copies` records
  every copy ever written (`CURRENT`, `RETAINED` superseded copies the store refused to delete, `DELETED`,
  `DISPOSED`). Rows written by ingestion before a lifecycle operation are reconciled lazily by the worker.
* The DB guard allows the storage location to change only together with a tier change (migration) or disposal.

## Tier migration

Copy (Object Lock applied to the new version) → re-hash new version (SHA-256 + SHA-512 + size) → switch pointer
only on a match → governance-bypass delete of the old version (or keep it as `RETAINED`). See
`docs/EVIDENCE-LIFECYCLE.md`. Objects > 5 GiB are streamed through the worker instead of CopyObject.

## Behaviour verified against the dev object store (versitygw, `GOVERNANCE` mode) — by automated tests

| Behaviour | Result | Test |
|---|---|---|
| Put with `If-None-Match: *` on an existing key | refused (`PreconditionFailed`) | manual probe during development |
| Object Lock retention on put and on CopyObject | applied (`ObjectLockMode=GOVERNANCE`, retain-until returned by HEAD) | `apps/worker/test/lifecycle.test.ts` |
| `PutObjectLegalHold` ON/OFF + `GetObjectLegalHold` | supported | `apps/api/test/evidence.test.ts` (legal hold) |
| Delete of a locked version **without** bypass | refused (`AccessDenied`) | manual probe |
| Delete of a locked version **with** `x-amz-bypass-governance-retention` (dev root credentials) | **allowed** — version really removed (re-listed) | disposal + tier tests |
| Delete with bypass while an S3 legal hold is ON | refused (`AccessDenied`) — used to test the "storage refused" disposal path | `evidence.test.ts` ("never fakes success") |

## UNVERIFIED / production notes

* AWS S3 / MinIO / Ceph: governance bypass requires the `s3:BypassGovernanceRetention` permission for the
  worker's credentials. Without it disposal and superseded-copy cleanup are **refused and recorded** (requests
  stay APPROVED with the error; copies stay RETAINED) — nothing is reported as deleted. In `COMPLIANCE` mode
  deletion before retain-until is impossible by design: disposal can only complete after the object lock expires
  (set `OBJECT_LOCK_DAYS` consistently with the retention policies).
* Stores that do not implement `PutObjectLegalHold` return `NOT_SUPPORTED`; the DB hold still applies.
* CopyObject between buckets in different storage classes / regions and the > 5 GiB streamed path are not
  exercised by tests (fixtures are small).
* AWS requires a Content-MD5/checksum for PutObject with Object Lock; the SDK is configured with
  `requestChecksumCalculation: 'WHEN_REQUIRED'` — verify against real AWS.
