# Administrator Guide

For users holding `SYSTEM_ADMINISTRATOR` (web administration) and for operators running the platform. Installation
and infrastructure: [DEPLOYMENT.md](DEPLOYMENT.md) (**container/k8s paths UNVERIFIED**), day-2 routines:
[OPERATIONS.md](OPERATIONS.md), incidents: [RUNBOOK.md](RUNBOOK.md), secrets: [SECRETS.md](SECRETS.md),
backup/DR: [BACKUP-RESTORE-RUNBOOK.md](BACKUP-RESTORE-RUNBOOK.md), [DISASTER-RECOVERY.md](DISASTER-RECOVERY.md).

Administrators have **no evidence media access** by default. Every administrative change is written to the audit
ledger and visible to auditors.

## First administrator

Production: run the seed with `--production` (DEPLOYMENT.md step 6); it prints a one-time password for `admin`.
Sign in over HTTPS, change the password, enrol two-step verification (mandatory for administrators).
Development: `npm run db:seed` creates the dev users listed in [CONTRACTS.md](CONTRACTS.md) §2.

## Organisation units (**Organisation units**)

Hierarchy zone → district → station (ltree path). Role grants apply to the unit **and its subtree**, so create
units before users. Units cannot be re-parented (evidence jurisdiction is immutable); deactivate instead.

## Users (**Users**)

* **New user**: username, name, badge/rank, home unit, initial role grants. A one-time password is shown once —
  hand it over out of band; the user must change it at first sign-in.
* On a user: edit details, change status (active / disabled), **unlock** after a lockout, **reset password**,
  **reset MFA** (user re-enrols on next sign-in), view and revoke sessions, grant/revoke roles at a unit.
* Guards: you cannot change your own status; the last root-level administrator cannot be removed; you cannot grant
  permissions you do not hold (privilege-escalation guard); separation-of-duties conflicts are refused.

## Roles & permissions (**Roles & permissions**)

Eight system roles are seeded (`packages/shared/src/permissions.ts`; summary in [USER-GUIDE.md](USER-GUIDE.md)).
Custom roles are created from the permission catalogue. Conflicting pairs cannot share a role and a user cannot
hold both through different roles: `evidence:dispose_request` + `evidence:dispose_approve`,
`audit:read` + `roles:manage`. Requester ≠ approver is additionally enforced at runtime and in the database for
disposals and court exports. Open decision: whether custodians should approve exports (KNOWN-ISSUES EXT-10).

## Devices (**Devices**)

Register body-worn cameras (serial, model, unit), assign/unassign to officers, retire. Uploads may reference a
device only within the uploader's jurisdiction.

## System settings (**System settings**)

| Setting | Defaults | Notes |
|---|---|---|
| `passwordPolicy` | min 12, upper/lower/digit/symbol, history 5, max age 90 days | |
| `lockoutPolicy` | 5 failures → 15 min lock; 30 failures per IP per 15 min | an expired lock restarts the count |
| `sessionPolicy` | idle 30 min, absolute 12 h, 3 concurrent sessions, `requireMfaForRoles` | MFA mandatory for SUPERVISOR, SYSTEM_ADMINISTRATOR, AUDITOR, EVIDENCE_CUSTODIAN by default |
| `uploadPolicy` | max 50 GiB/file, 16 MiB chunks, 72 h session TTL, 20 concurrent sessions/user | > 5 GiB uploads UNVERIFIED |
| `storagePolicy` | warn 75 %, critical 90 %, capacity bytes | drives storage alerts |
| `shareExportPolicy` | shares ≤ 30 days, exports kept 30 days, excessive-downloads alert 20/h | |

## Retention (**Retention policies**)

Policies by category: retention days, *Archive after*, *Long-term after*. The default policy cannot be deleted;
policies in use cannot be deleted. Tier moves and disposal candidates are computed every 15 minutes
(`lifecycle.scan`); disposal always needs a custodian request **and** a different approver, and is blocked by legal
holds and open cases.

## Integrations and API clients (**Integrations**, **API clients**)

* Integrations: configure adapters (`fixture` for testing, `http-json` for a CCTNS-style endpoint), **Health check**,
  **Run contract test**. Outbound calls go through an SSRF guard (private ranges refused unless allow-listed).
  Real CCTNS contracts are **UNVERIFIED** (KNOWN-ISSUES EXT-2).
* API clients: **New client** → scopes, IP allow-list (IPv4 CIDR / exact IPv6), expiry. The secret is shown once
  (**I have stored the secret**). **Rotate** / **Revoke**. Clients can call only `/api/v1/integration/*` and tokenised
  downloads; every call is audited and rate-limited per client. See [INTEGRATIONS.md](INTEGRATIONS.md).

## AI models and watchlists (**AI models**, **Watchlists**)

`npm run fetch-models -w @ksp/ai-worker` (or the k8s models Job) downloads, SHA-256-verifies and registers the
models. In **AI models** activate/retire versions and export reviewed training datasets. Before production:
ANPR licence review and face-recognition DPIA (KNOWN-ISSUES EXT-4/EXT-5); keep `FACE_RECOGNITION` unused until
cleared. See [AI-MODEL-LIFECYCLE.md](AI-MODEL-LIFECYCLE.md).

## Alerts, reports, health (**Alert rules**, **Reports**, **System health**)

* Alert rules: 10 built-in rules (integrity failure, audit chain broken, storage thresholds, failed processing,
  brute force, excessive downloads…) with thresholds and channels. Channels: in-app, webhook (HMAC-signed) and
  e-mail (SMTP, `ALERT_SMTP_URL`); failed external deliveries are retried with exponential backoff
  (Settings → Alert delivery: attempts, first delay, extra recipients per severity; per-rule recipients on the
  Alert rules page).
* Reports: 9 types, CSV/JSON/PDF, jurisdiction-scoped, hashed; recurring schedules not implemented.
* System health: API/worker heartbeats, queue depth, storage, DB. Prometheus metrics on the internal metrics port
  (see [MONITORING.md](MONITORING.md)).

## Routine checklist

Daily: open alerts, backup status. Weekly: backup verification result, dependency scan. Quarterly: access review
(users, grants, API clients), DR drill on staging. Yearly: key rotation ([SECRETS.md](SECRETS.md)). Details in
[OPERATIONS.md](OPERATIONS.md).
