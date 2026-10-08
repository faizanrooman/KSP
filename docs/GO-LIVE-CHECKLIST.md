# Go-live checklist

Every gate that stands between the tested software and a production deployment (FINAL-AUDIT §8, KNOWN-ISSUES EXT-* /
OPS-*). For each gate: the accountable owner (a role), the evidence that closes it, how the software **enforces or
records** it (so a gate cannot be skipped silently), and the command that verifies it. Sign each row in the change
ticket; the gate is closed only when the evidence is attached.

**The software enforces what it can.** With `NODE_ENV=production` the api, worker and ai-worker run the production
preflight at startup (`packages/core/src/preflight.ts`) and **refuse to start** (exit code 78, every violation listed)
while any rule below marked **P** is violated. Run it before every deployment:

```bash
npm run preflight                          # all services, config + database checks; exit 1 on any violation
npm run preflight -- --service ai-worker   # one service; --json for machine-readable output; --no-db for config only
kubectl -n ksp-vms run preflight --rm -it --image=<api image> --env-from=configmap/ksp-config -- node packages/core/dist/bin/preflight.js
```

Waivers are explicit environment variables, each logged as a preflight warning: `KSP_ALLOW_NONEVIDENTIARY_SIGNING`
(staging/demo only), `OBJECT_LOCK_MODE_ACCEPT_GOVERNANCE`, `DATABASE_TLS_WAIVED`, `KSP_PREFLIGHT=warn` (refused when
`KSP_ENVIRONMENT=production`; for demo clusters such as minikube set `KSP_ENVIRONMENT=demo KSP_PREFLIGHT=warn`).

## A. Legal & compliance

| # | Gate | Owner | Evidence required | Enforced / recorded by the software | Verify |
|---|---|---|---|---|---|
| A1 | Face detection / recognition legal basis + DPIA (EXT-5) | Legal / DPO | Signed DPIA ([DPIA-INPUT.md](DPIA-INPUT.md) is the technical input), legal-basis note, approval order reference | `AI_LEGAL_GATES=enforce` (production default, **P**: `off` refused). FACE_* need BOTH `AI_TASKS_ENABLED` and a recorded approval (Settings → Legal approvals → `aiLegalApprovals`, audit `LEGAL_APPROVAL_RECORDED`). API refuses (422 `AI_TASK_DISABLED`, audit `AI_TASK_REFUSED`), UI hides the task with the reason, the isolated AI worker refuses queued jobs (`TASK_NOT_PERMITTED`) | `GET /api/v1/ai/tasks` → `allowed`/`gate`; preflight warning `AI_LEGAL_APPROVAL` lists enabled-but-unapproved tasks |
| A2 | ANPR plate-detector licence review (EXT-4: YOLOv9 derivative, MIT vs GPL-3.0 upstream) | Legal | Licence opinion or replacement model; approval reference | Same mechanism as A1 (`aiLegalApprovals.ANPR`). Not in the production default `AI_TASKS_ENABLED` | as A1 |
| A3 | Court export package + BSA s.63 certificate template accepted (EXT-6) | Legal / prosecution | Written acceptance of the package format and template (reference + date) | Until `exportLegalApproval` is recorded every Fact Sheet page and VERIFY.txt carry **"TEMPLATE – PENDING LEGAL APPROVAL"**; the approval reference is printed in the annex afterwards (audit `LEGAL_APPROVAL_RECORDED`) | Build a test export; `pdftotext FACT_SHEET.pdf - \| grep -c 'PENDING LEGAL'` = 0; preflight warning `EXPORT_LEGAL_APPROVAL` absent |
| A4 | Export approval policy decision (EXT-10) | Product owner | Decision minute | Mechanism exists (grant `export:approve` in Roles admin); SoD requester ≠ approver enforced in API + DB CHECK | ADMIN-GUIDE.md § Export approval policy |
| A5 | Retention periods per category approved | Custodian / legal | Retention schedule signed | Retention policies (Admin → Retention); disposal needs approval + SoD; legal hold blocks disposal in the DB | `GET /api/v1/retention/policies` |

## B. Security

| # | Gate | Owner | Evidence required | Enforced / recorded by the software | Verify |
|---|---|---|---|---|---|
| B1 | CERT-In empanelled VAPT on staging; HIGH/CRITICAL fixed and re-tested (EXT-1) | Security officer | VAPT report + re-test letter | — (scope: [VAPT-SCOPE.md](VAPT-SCOPE.md)) | report reference in the change ticket |
| B2 | HSM/DSC-backed evidence signing key + CA-issued certificate (EXT-3) | Security officer | HSM key ceremony record, certificate chain, `SIGNING_KEY_ID` | **P** `SIGNING_TEST_KEY`: dev "NOT FOR COURT USE" / self-signed certificate / key id `ksp-dev-signing-key` refused. `SIGNING_PROVIDER=pkcs11` ([SECRETS.md § HSM](SECRETS.md#hsm)); self-test signature at startup; certificates archived in `signing_certificates` for later verification. Staging with a test key: every export / custody PDF stamped **"NON-EVIDENTIARY – TEST KEY"** | `npm run preflight -- --service api`; Settings page shows the signing key id/provider; verify an export offline with VERIFY.txt |
| B3 | All secrets generated for production (no dev/default values) | DevOps | Secrets-manager entries; rotation calendar | **P** `DEV_SECRET_*`: known dev values (`kspdevaccess`, `…change-me`), weak/short passwords in DB URLs, `.local/secrets` key files, missing data-encryption key | `npm run preflight` |
| B4 | TLS everywhere; secure cookies | DevOps | Certificates; ingress config | **P** `APP_BASE_URL_HTTPS`, `CORS_HTTPS`, `COOKIE_SECURE`, `DB_TLS` (URL `sslmode` + live `pg_stat_ssl`); `S3_TLS` warning | `npm run preflight`; `curl -I https://…` shows HSTS |
| B5 | Least-privilege DB roles | DBA | Role grants | **P** `DB_ROLE`: api/worker must not connect as owner/superuser/createrole/bypassrls; ai-worker must not read `evidence` | `npm run preflight` |
| B6 | Per-service S3 identities verified by negative tests (EXT-7) | Infra | Test log: AI identity denied on `ksp-evidence` | **P** `S3_AI_CREDENTIALS`: AI worker without its own identity (or with the app key) refused | `aws s3 ls s3://ksp-evidence --profile ksp-ai` must fail |
| B7 | MFA mandatory for privileged roles | Security officer | Settings screenshot | Production seed forces SYSTEM_ADMINISTRATOR into `requireMfaForRoles`; preflight warning `MFA_POLICY` if a privileged role is removed | `npm run preflight` |
| B8 | Rate limiting shared across API replicas | DevOps | — | **P** `RATE_LIMIT_STORE`: `memory` with more than one replica refused | `npm run preflight -- --service api` |
| B9 | Staff access only from authorised internal networks (tender §50) | Security officer / network | KSP + VPN CIDR list signed off | `ALLOWED_NETWORKS` → 403 `NETWORK_NOT_ALLOWED` before authentication, audit `ACCESS_DENIED`; share portal / tokenised media / health exempt; preflight warning `ALLOWED_NETWORKS` when empty | `curl` from an outside address → 403; from VPN → 401/200; `security-network.test.ts` |

## C. Data & storage

| # | Gate | Owner | Evidence required | Enforced / recorded by the software | Verify |
|---|---|---|---|---|---|
| C1 | Object Lock COMPLIANCE on evidence buckets (EXT-8) | Custodian + infra | Bucket configuration export | **P** `OBJECT_LOCK_MODE`: anything but COMPLIANCE refused unless `OBJECT_LOCK_MODE_ACCEPT_GOVERNANCE=true` (warning; record the custodian decision); NONE refused by the config loader; `ensure-buckets.mjs` fails on a WORM bucket without Object Lock | `npm run preflight`; `aws s3api get-object-lock-configuration --bucket ksp-evidence` |
| C2 | No development / UAT fixtures in the production database | Custodian | Preflight output | **P** `DEV_SEED_USERS`, `DEV_SEED_PASSWORD` (active dev seed users, any dev user or `admin` with the dev password); warning `DEV_SEED_ORG`; production seeding `npm run db:seed -- --production` creates only the root unit + one admin (one-time password, must change, MFA) | `npm run preflight`; for a staging DB promoted after UAT: `npm run ops:purge-demo-data` (dry run) then `-- --execute` |
| C3 | Real organisation hierarchy and initial users loaded | Admin | Signed-off CSVs | `npm run ops:bootstrap-org -- --units units.csv --users users.csv --dry-run` validates everything first; import is one transaction, audited (`ORG_BOOTSTRAP_IMPORTED`), one-time passwords to a 0600 file | re-run with `--dry-run`: "0 to create" |
| C4 | Backups at the DR site with Object Lock; restore drill (OPS-3) | DevOps | Drill report meeting the 2-hour RTO at representative volume | Signed backup manifests (OPS-8); verify job | [BACKUP-RESTORE-RUNBOOK.md](BACKUP-RESTORE-RUNBOOK.md), [DISASTER-RECOVERY.md](DISASTER-RECOVERY.md) |
| C5 | PostgreSQL JIT off on the restored/production DB | DBA | — | warning `DB_JIT` | `npm run preflight` |

## D. Integrations

| # | Gate | Owner | Evidence required | Enforced / recorded by the software | Verify |
|---|---|---|---|---|---|
| D1 | CCTNS / FIR contract agreed and contract-tested, or integrations descoped (EXT-2) | Integration owner | Items in [CCTNS-INTEGRATION-REQUEST.md](CCTNS-INTEGRATION-REQUEST.md) received; live contract test passed | **P** `FIXTURE_INTEGRATION`: enabled systems with the synthetic `fixture` adapter refused; `verified` only after a live probe (`POST /integrations/systems/:id/test`) | Admin → Integrations shows **Verified**; `npm run preflight` |

## E. Capacity & operations

| # | Gate | Owner | Evidence required | Enforced / recorded by the software | Verify |
|---|---|---|---|---|---|
| E1 | Transcoding capacity decision (EXT-9) | Infra / product | Decision: `MEDIA_PROFILE` + `MEDIA_ENCODER` + worker count from the capacity table | `MEDIA_PROFILE=full\|proxy-only\|on-demand-hls`; hardware encoders with automatic libx264 fallback | [INFRASTRUCTURE.md § Transcoding capacity](INFRASTRUCTURE.md#transcoding-capacity); `npm run media:benchmark -w @ksp/worker -- --file <representative clip>` on the target hardware |
| E2 | Images built, scanned (0 HIGH/CRITICAL), deployed by the pipeline (OPS-1, OPS-2) | DevOps | CI run links, Trivy reports | `scripts/ci/validate-deploy.sh` | CI |
| E3 | Monitoring and alerting end-to-end | DevOps | Test alert received | Prometheus rules, SLO probe, `/api/v1/system/health` | [MONITORING.md](MONITORING.md) |
| E4 | UAT signed off per role | Product owner | Signed sheet in [UAT-PLAN.md](UAT-PLAN.md) | — | — |
| E5 | Verification re-run on sound hardware (ENV-1) | QA | CI / staging test logs | — | `npm test`, `npm run test:e2e` |
| E6 | AI accuracy declared on KSP footage (tender §15/§16) | Forensic lead / AI owner | Evaluation reports per task (`npm run evaluate -w @ksp/ai-worker … --register`) on a reviewed, held-out KSP dataset | `ai_models.metrics.kspEvaluation` (precision, recall, FPR, FNR, latency) shown on **AI models**; upstream figures remain labelled `source: upstream` until then | `GET /api/v1/ai/models` → `metrics.kspEvaluation` present for every ACTIVE model |
| E7 | Kannada UI dictionary reviewed by a KSP language officer (tender §45) | Department / language officer | Review sign-off; corrections applied to `apps/web/src/i18n/kn/*.json` | `node scripts/i18n/build-dictionary.mjs --check` (100 % coverage enforced in CI) | switch to ಕನ್ನಡ on the sign-in page and walk the UAT scripts |

## F. Cut-over sequence

1. Fresh production database: `npm run db:migrate` (migrate Job) → `npm run db:seed -- --production` → log in as
   `admin` over HTTPS, change the one-time password, enrol MFA.
2. `npm run ops:bootstrap-org -- --units units.csv --users users.csv --dry-run`, then without `--dry-run`; distribute
   the one-time passwords from the 0600 credentials file through a secure channel and delete the file.
3. Record the legal approvals that exist (Settings → Legal approvals); leave the others pending.
4. `npm run preflight` → **PREFLIGHT PASSED**; review every warning and record the decision for each.
5. Deploy workloads (`scripts/ops/k8s-deploy.sh production <tag> …`); the services re-run the preflight at startup.
