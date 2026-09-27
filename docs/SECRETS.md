# Secrets inventory, storage and rotation

Generate a complete set: `scripts/ops/generate-secrets.sh --out <dir> --env-name <env> [--format files|compose|k8s|all]`
(idempotent: existing files are never overwritten unless `--force`). Store in the secrets manager (Vault / AWS
Secrets Manager); Kubernetes receives them through External Secrets (`deploy/k8s/components/external-secrets`) or
Sealed Secrets (`kubeseal < k8s-secrets.yaml`). Never commit generated files; `deploy/compose/secrets/` and `.env`
are git-ignored. The application never logs secrets (pino redaction; audit details exclude them).

| Secret (file name) | Used by | Format | Rotation | Impact of rotation |
|---|---|---|---|---|
| `pg_superuser_password` | DBA only (compose postgres) | random 40 | yearly / staff change | none |
| `ksp_owner_db_password` → `DATABASE_MIGRATION_URL` | migrate Job | random 40 | yearly | none (next migrate) |
| `ksp_app_db_password` → `DATABASE_URL` | api, worker, models Job, backup record | random 40 | 90 days: `ALTER ROLE ksp_app PASSWORD`, update secret, rolling restart | brief reconnects |
| `ksp_ai_db_password` → `DATABASE_AI_URL` | ai-worker | random 40 | 90 days | ai-worker restart |
| `ksp_backup_db_password` → `PGPASSWORD` | backup CronJob | random 40 | 90 days | none |
| `s3_access_key`/`s3_secret_key` | api, worker, migrate | IAM `app.json` | 90 days, dual-key overlap | rolling restart |
| `s3_ai_access_key`/`secret` | ai-worker | IAM `ai.json` (derived only) | 90 days | restart |
| `backup_s3_*`, `dr_s3_*`, `s3_replica_read_*` | backup/replicate jobs | IAM `backup.json`, `replicate.json` | 90 days | none |
| `jwt_private_key`/`jwt_public_key` | api | Ed25519 PEM | 180 days | all access tokens (15 min) invalid → silent refresh fails → users log in again. Refresh tokens are opaque DB rows and survive. |
| `data_encryption_key` → `DATA_ENCRYPTION_KEY`, or the versioned ring `DATA_ENCRYPTION_KEYS` (`id:base64,…`, first = current) | api (MFA secrets at rest) | 32 B base64 per key | yearly / on suspicion: put the new key first in `DATA_ENCRYPTION_KEYS`, roll out, run `npm run keys:rotate-data -w @ksp/core` (OPERATIONS.md § Key rotation) | a lost key makes the MFA enrolments encrypted with it unreadable → every key still referenced by a DB/backup must be **restored with that DB** |
| `media_token_secret` | api | 32 B hex | 90 days | outstanding media tokens (≤ 5 min) fail; players refetch |
| `signing_private_key`, `signing_certificate`, `signing_key_id` | api/worker (export manifests, audit checkpoints) | RSA-3072 + CA certificate (**HSM/DSC in production**) | per certificate policy; new `SIGNING_KEY_ID` per key | old exports stay verifiable with the old certificate — archive every certificate ever used |
| `backup_age_recipients` | backup job | age public key(s) | yearly; add new recipient first | none |
| `backup_age_identity` | verify job, restore operator | age private key | yearly (keep all old identities to read old backups!) | **offline**, two-person custody |
| `grafana_admin_password` | grafana | random 40 | 90 days | none |
| `S3_ROOT_*` (bundled gateway) | compose s3 only | random | yearly | gateway restart |
| TLS certificate `ksp-vms-tls` | ingress | X.509 | cert-manager auto-renew | none |
| Kubeconfigs for CD | GitHub Environments `staging`/`production` | kubeconfig (namespace-scoped SA) | 90 days | none |

## Rotation procedure (generic)

1. Generate the new value (`generate-secrets.sh --out new --force` for one file, or `openssl`).
2. For credentials with a server side (DB roles, S3 keys) create/enable the new credential **first**.
3. Update the secrets manager; External Secrets refreshes within `refreshInterval` (1 h) — or force
   `kubectl annotate externalsecret <name> force-sync=$(date +%s) --overwrite`.
4. `kubectl rollout restart deployment/ksp-api deployment/ksp-worker deployment/ksp-ai-worker`.
5. Revoke the old credential; record the rotation (change ticket).

## Compromise

Rotate everything the attacker may have seen; for JWT/media keys rotation alone ends sessions; for
`DATA_ENCRYPTION_KEY` compromise, force MFA re-enrolment for all users. Review `audit_events` for the period.
