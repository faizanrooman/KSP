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
| `signing_private_key`, `signing_certificate`, `signing_key_id` (or `pkcs11_pin` + HSM key, [§ HSM](#hsm)) | api/worker (export manifests, custody reports, audit checkpoints) | RSA-3072 / ECDSA P-256 + CA certificate (**HSM via PKCS#11 in production**) | per certificate policy; new `SIGNING_KEY_ID` per key | old exports carry their certificate; checkpoints verify via the `signing_certificates` archive |
| `backup_age_recipients` | backup job | age public key(s) | yearly; add new recipient first | none |
| `backup_age_identity` | verify job, restore operator | age private key | yearly (keep all old identities to read old backups!) | **offline**, two-person custody |
| `backup_signing_key` → `BACKUP_SIGNING_KEY_FILE` | backup job | Ed25519 PEM (signs `manifest.json`) | yearly | none; keep every old **public** key to verify old backups |
| `backup_signing_pubkey` → `BACKUP_SIGNING_PUBKEY_FILE` | verify job, restore operator | Ed25519 public PEM | with the key | not secret; when set, unsigned/invalid manifests are refused |
| `grafana_admin_password` | grafana | random 40 | 90 days | none |
| `S3_ROOT_*` (bundled gateway) | compose s3 only | random | yearly | gateway restart |
| TLS certificate `ksp-vms-tls` | ingress | X.509 | cert-manager auto-renew | none |
| Kubeconfigs for CD | GitHub Environments `staging`/`production` | kubeconfig (namespace-scoped SA) | 90 days | none |

## HSM / PKCS#11 signing key {#hsm}

Production evidence signing uses a key that never leaves an HSM or smart-card token (EXT-3):
`SIGNING_PROVIDER=pkcs11` (`packages/core/src/signing-pkcs11.ts`, optional native dependency `pkcs11js`).

| Variable | Meaning |
|---|---|
| `PKCS11_MODULE` | vendor PKCS#11 library (`.so`) mounted into the api **and** worker containers |
| `PKCS11_TOKEN_LABEL` / `PKCS11_SLOT` | token by label (preferred) or slot index/id |
| `PKCS11_PIN_FILE` | file with the user PIN (mounted secret; inline PINs are not accepted) |
| `PKCS11_KEY_LABEL` / `PKCS11_KEY_ID` | `CKA_LABEL` (+ optional hex `CKA_ID`) of the private key |
| `PKCS11_CERTIFICATE` | CA-issued certificate (PEM / `file:`) when it is not stored on the token as `CKO_CERTIFICATE` with the same label/id |
| `PKCS11_RSA_SCHEME` | `pkcs1` (RSA-SHA256, default — verifies with `openssl dgst -sha256 -verify`) or `pss` (RSA-PSS-SHA256, MGF1-SHA256, salt 32) |
| `SIGNING_KEY_ID` | identifier written into manifests / checkpoints; new id per key |

Supported keys: RSA (2048+, 3072+ recommended) and ECDSA P-256 (`CKM_ECDSA` over a SHA-256 digest; the raw r‖s is
DER-encoded so VERIFY.txt's `openssl dgst -sha256 -verify` works unchanged). At startup the signer opens a session,
logs in, finds the key and certificate and **verifies a self-test signature against the certificate** (a mismatched
certificate fails the start, not the first export); a lost session (HSM restart / failover) is re-opened and the
signature retried once. PKCS#11 login state is per application + token: the PIN is checked when the first session
logs in.

**Verified** against SoftHSM2 2.6.1 (`apps/api/test/pkcs11-signer.test.ts`, 7 tests: RSA PKCS#1 v1.5 and PSS, ECDSA
P-256, certificate from token and from file, custody report + audit checkpoint signatures verified with OpenSSL, session
re-open, wrong PIN / label / token / certificate). The test is skipped only when SoftHSM2 is not installed
(`SOFTHSM2_MODULE` / `SOFTHSM2_UTIL`, or `<main checkout>/.local/softhsm` — `apt-get download softhsm2 libsofthsm2` +
`dpkg -x`). **UNVERIFIED** with vendor HSMs (Thales Luna, Utimaco, Entrust nShield, YubiHSM 2): vendor modules differ in
session limits and mechanism support — run the same test against the vendor module (`SOFTHSM2_MODULE` is just the
module path) before go-live.

Images: `pkcs11js` builds with node-gyp; the image build stage needs `python3 make g++` for it to be installed (it is
an optional dependency — without the toolchain the image still builds and `SIGNING_PROVIDER=pem` works, and
`SIGNING_PROVIDER=pkcs11` fails at startup with an explicit message). The vendor module and its configuration are
mounted at runtime, never baked into the image.

**Key ceremony (production):** generate the key **inside** the HSM (non-extractable, `CKA_SENSITIVE`), create a CSR
from it with the vendor tool, have the CA / DSC provider issue the certificate, store it on the token or as
`PKCS11_CERTIFICATE`, set a new `SIGNING_KEY_ID`, run `npm run preflight -- --service api`. Every certificate that has
signed a checkpoint is archived in the append-only `signing_certificates` table (migration 1151) and checkpoints are
verified with the certificate matching their `cert_fingerprint`, so older checkpoints stay verifiable after rotation;
exports carry their own `signing-cert.pem`.

**DSC / CCA eSign (future):** an eSign-backed signer (Aadhaar/DSC signing service licensed by the CCA) is a future
`Signer` implementation behind the same interface (`sign(data) → { algorithm, keyId, signature, certificatePem }`).
It is **not implemented**: it depends on the eSign service provider's API contract (request/response format, the
signer's consent flow, whether detached CMS/PKCS#7 or raw signatures are returned, timestamping). Do not fake it.

**Test keys:** the development key (CN "… NOT FOR COURT USE", self-signed, key id `ksp-dev-signing-key`) is refused by
the production preflight. On staging it may be allowed with `KSP_ALLOW_NONEVIDENTIARY_SIGNING=true`
(`KSP_ENVIRONMENT=staging|demo` only); every Fact Sheet, custody report and VERIFY.txt then carries
**"NON-EVIDENTIARY – TEST KEY"** (any self-signed certificate is stamped, whatever the environment).

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
