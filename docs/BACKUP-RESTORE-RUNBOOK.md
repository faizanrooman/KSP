# Backup & restore runbook

Scripts live in `scripts/backup/` and run from the `backup` image (PostgreSQL 16 client, Node 22, age) or from a
checkout with those tools on PATH. All scripts are idempotent and exit non-zero on failure.

## Encryption choice

**age** (X25519 recipients, ChaCha20-Poly1305, authenticated, streaming). The backup job holds only the
**public** recipients; the **identity** (private key) is kept offline and is given only to the restore-verify job
and to the restore operator. Why not `openssl enc`: its CLI has no AEAD mode (no GCM) and uses a shared secret on
the backup host. gpg would work but is heavier to operate. Integrity is double-checked: SHA-256 of ciphertext and
plaintext are in the manifest, and age itself authenticates every chunk.

## What is backed up

| Kind | Tool | Schedule (k8s) | Where |
|---|---|---|---|
| Logical DB dump (`pg_dump -Fc`) | `pg-backup.sh` | nightly 02:00 IST (`ksp-pg-backup`) | `s3://ksp-db-backups/pg/<db>/<ts>/` (Object Lock, retention `BACKUP_LOCK_DAYS`) |
| Restore verification | `verify-backup.sh latest` | weekly (`ksp-backup-verify`) | scratch PostgreSQL |
| Object replication + hash check | `s3-replicate.ts` | hourly (`ksp-s3-replicate`) | DR object store, same bucket names |
| WAL + base backups (PITR) | CloudNativePG barman | continuous / weekly | `s3://ksp-pg-wal/` at the DR site |

Every run is recorded in `backup_runs` (`PG_DUMP`, `VERIFY`, `S3_REPLICATION`; status `RUNNING/SUCCEEDED/FAILED`).

## Manifest (`manifest.json`, uploaded last = commit marker)

`plainSha256`, `encryptedSha256`, sizes, server/pg_dump versions, `schemaMigrations {count, head}`,
`audit {headSeq, headHash}` (taken **before** the dump snapshot), `rowCounts`, `databaseSettings`
(`ALTER DATABASE … SET` values such as `jit=off`, which a single-database dump does not contain).

**Signature (OPS-8).** `pg-backup.sh` signs the manifest with the Ed25519 key `BACKUP_SIGNING_KEY_FILE`
(detached `manifest.json.sig`, uploaded before the manifest; `openssl pkeyutl -sign -rawin`). `verify-backup.sh`
and `restore.sh` verify it **before using any manifest field** when `BACKUP_SIGNING_PUBKEY_FILE` is set — then a
missing or invalid signature is fatal (always set it in production; `BACKUP_REQUIRE_SIGNATURE=1` refuses to run
without it). Manual check: `openssl pkeyutl -verify -pubin -inkey backup_signing_pubkey -rawin -in manifest.json
-sigfile manifest.json.sig`. `audit.headSeq` is validated as an integer and passed to SQL only as a psql variable.

## Verification (`verify-backup.sh`) — what "verified" means

0. manifest signature (when `BACKUP_SIGNING_PUBKEY_FILE` is set);
1. ciphertext SHA-256 = manifest; 2. age decryption with the identity; 3. plaintext SHA-256 = manifest;
4. `pg_restore --list`; 5. restore into a scratch DB; 6. every applied migration exists in `db/migrations` with the
same checksum; 7. `audit_verify()` recomputes the whole chain with no broken row; 8. the audit row
`manifest.audit.headSeq` still has `headHash` (history not rewritten); 9. row counts ≥ manifest.

Tested by `scripts/backup/test/verify-backup.test.sh` (14/14 pass): pristine signed backup accepted; manifest
modified with the old signature, signed by another key, signature missing, unsigned with `BACKUP_REQUIRE_SIGNATURE=1`,
non-integer `headSeq`, bit-flipped ciphertext, truncated ciphertext, wrong key, truncated dump re-encrypted with forged
manifest hashes, audit row tampered and re-sealed, migration checksum tampered and re-sealed, audit tail deleted and
re-sealed (the re-sealed cases are re-signed with the real key = signing-key compromise) — all rejected; a legacy
unsigned manifest is accepted only when no public key is configured.

## Routine commands

```bash
# ad-hoc backup (env: PG*, BACKUP_AGE_RECIPIENTS_FILE, BACKUP_S3_*, BACKUP_S3_BUCKET, BACKUP_RECORD_URL)
scripts/backup/pg-backup.sh
# verify the newest backup (env: VERIFY_ADMIN_URL, BACKUP_AGE_IDENTITY_FILE, BACKUP_S3_*)
scripts/backup/verify-backup.sh latest
# object replication / DR integrity sweep
node scripts/backup/s3-replicate.ts            # copy new objects, check originals vs DB
node scripts/backup/s3-replicate.ts --verify-only
```

## Full restore (database)

Prerequisites: target PostgreSQL 16 cluster, an admin role with CREATEDB+CREATEROLE, the age identity (from the
offline store, two-person retrieval), backup store credentials.

```bash
export BACKUP_AGE_IDENTITY_FILE=/secure/ksp-backup.agekey BACKUP_S3_ENDPOINT=… BACKUP_S3_ACCESS_KEY=… BACKUP_S3_SECRET_KEY=… BACKUP_S3_BUCKET=ksp-db-backups
# optional: NEW role passwords if compromise is suspected
export RESTORE_OWNER_DB_PASSWORD=… RESTORE_APP_DB_PASSWORD=… RESTORE_AI_DB_PASSWORD=… RESTORE_BACKUP_DB_PASSWORD=…
scripts/backup/restore.sh --admin-url postgres://admin@dr-db:5432/postgres --database ksp --source latest [--replace]
```

`restore.sh`: (1) roles bootstrap; (2) fetch + verify + decrypt before touching any DB; (3) if `ksp` already holds
this backup → exit 0 (idempotent), else with `--replace` rename it to `ksp_pre_restore_<ts>` (never dropped);
(4) restore into `ksp_restoring`, run all verification checks, rename to `ksp`, re-apply database settings;
(5) print next steps.

Then:

1. `node packages/core/dist/bin/migrate.js` (applies migrations newer than the backup).
2. `S3_ENDPOINT=<DR store> node scripts/ops/ensure-buckets.mjs` (verifies WORM buckets, creates staging).
3. If objects were copied by `s3-replicate.ts`: `node scripts/backup/s3-replicate.ts --repoint [--trust-marker]`
   (one `EVIDENCE_STORAGE_REPOINTED` custody event per original). Not needed with native replication.
4. Start services; `/health/ready`; log in; open evidence; run a fixity check; `SELECT * FROM audit_verify()`.
5. Secrets: the restored DB contains MFA secrets encrypted with `DATA_ENCRYPTION_KEY` — the **same** key must be
   restored from the secrets manager (a new key makes every MFA enrolment unreadable). JWT keys may be rotated
   (forces re-login). See [SECRETS.md](SECRETS.md).

## Point-in-time recovery (CloudNativePG)

Create a new `Cluster` with `bootstrap.recovery.source` = the barman object store and
`recoveryTarget.targetTime` = just before the incident. Validate with `verify`-style checks (`audit_verify()`,
migrations). UNVERIFIED — no cluster available to the dev team.

## Retention

Backups: `BACKUP_RETENTION_DAYS` (35) pruning; versions still under Object Lock are refused by the store and kept
(reported as `retainedByLock`). The backup identity cannot bypass governance retention (`deploy/s3/policies/backup.json`).
