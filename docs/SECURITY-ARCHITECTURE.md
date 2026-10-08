# Security architecture (identity & access)

See also `docs/AUTHENTICATION.md`, `docs/AUTHORIZATION.md`, `docs/CONTRACTS.md` §4–5.

## Layers

| Layer | Control |
|---|---|
| Transport / browser | Helmet CSP (`default-src 'self'`, `frame-ancestors 'none'`), HSTS when `COOKIE_SECURE`, CORS allow-list, httpOnly `SameSite=Strict` cookies, CSRF double-submit + Origin check |
| Rate limiting | Global per-IP limit; stricter limits on login, MFA verify, password change, admin password reset |
| Authentication | Argon2id passwords, lockout + IP throttle, TOTP MFA (mandatory for privileged roles), short-lived EdDSA access JWT, rotating refresh tokens with reuse detection, server-side session row checked on every request |
| Authorization | Permission check (`app.authorize`) + jurisdiction (`hasPermissionAt`/`orgScopeSql`/`evidenceVisibleSql`) on every route; out-of-scope sensitive resources → 404 |
| Administration | Grantor rule, no self-modification, SoD across roles, last-administrator guard (see AUTHORIZATION.md) |
| Database | App connects as `ksp_app` (DML only); append-only hash-chained `audit_events`; triggers: evidence immutability, org unit path immutability & no delete, system-role no delete, role code immutability (0100); unique serials (case-insensitive) |
| Audit | Every auth event, admin change and refusal is written to the tamper-evident ledger (`audit_verify()`); secrets, passwords and one-time passwords are never written |

## Media & ingestion hardening (security testing workstream)

| Control | Where |
|---|---|
| FFmpeg/ffprobe open untrusted media only with `-protocol_whitelist` **and** `-format_whitelist` (`MEDIA_FORMAT_WHITELIST`: mov, matroska, avi, mpegts, asf, flv, mpeg) — HLS/concat/image-sequence demuxers are never selected for an uploaded file | `packages/core/src/media.ts`, `ingest/inspect.ts`, `apps/worker/src/jobs/media/process.ts` |
| Egress guard also denies IPv4-compatible IPv6 (`::/96`) | `apps/api/src/integrations/egress.ts` |
| `/media/download` refuses non-share tokens that carry a `ref` (tokens minted for other download routes) | `apps/api/src/modules/media/index.ts` |
| Report downloads re-check the session idle timeout | `apps/api/src/modules/reports/index.ts` |
| AES-256-GCM secrets at rest require the full 16-byte tag | `packages/core/src/crypto.ts` |
| Every registered route is enumerated in tests (`app.routeRegistry`): public allow-list, 401, CSRF, API-client confinement | `apps/api/test/security-routes.test.ts` |

Threat model: `docs/THREAT-MODEL.md`. Test results: `docs/SECURITY-TEST-REPORT.md`.

## Data minimisation in responses

User endpoints never return `password_hash`, `mfa_secret_enc`, `mfa_pending_secret_enc`, `mfa_recovery_codes` or
token hashes; tests assert that responses contain no argon2 material. One-time passwords appear only in the single
response that created them and are shown once in the UI (copy button, then discarded).

## Threats considered (identity & admin)

| Threat | Mitigation |
|---|---|
| Credential stuffing / brute force | IP throttle, account lockout, generic errors, equal-time unknown-user path, MFA |
| Session theft | httpOnly cookies, short access TTL, refresh rotation + reuse → family revoke, idle/absolute timeouts, admin revoke |
| Privilege escalation by a delegated admin | Grantor rule, role-definition rule, scope checks at grant org unit, no self-modification |
| Collusion-free abuse of disposal / audit | SoD pairs enforced within roles and across a user's roles; runtime requester ≠ approver |
| Administrative lock-out | Last state-level administrator guard (transactional) |
| Jurisdiction bypass via restructuring | Org unit path immutable in DB |
| IDOR on users/devices | 404 for out-of-scope ids |

## Authorised-network access (tender §50)

`ALLOWED_NETWORKS` (comma-separated IPv4/IPv6 CIDRs) restricts the staff API to KSP's internal / VPN networks at the
application layer, in addition to the perimeter: requests from any other source address get `403 NETWORK_NOT_ALLOWED`
before authentication and are audited as `ACCESS_DENIED` (one event per source IP per minute). The client address is
taken from the proxy headers only when `TRUST_PROXY` is set. `ALLOWED_NETWORKS_EXEMPT_PREFIXES` (default: share
portal, tokenised media stream/download, health) keeps the external evidence-share portal reachable from the public
internet, which is the only part of the system designed for outside access. Empty `ALLOWED_NETWORKS` = no restriction
(development default; preflight warns in production). Tests: `apps/api/test/security-network.test.ts`.

## Known limitations

* **Multi-instance caches**: principal (10 s) and settings (15 s) caches are per process. Role revocations and settings
  changes are immediate on the instance that handled them and within the TTL elsewhere. Status changes (disable/lock),
  password/MFA resets and session revocations are immediate everywhere because they revoke session rows. A shared
  invalidation channel (e.g. Postgres `LISTEN/NOTIFY`) is a follow-up.
* Sessions that were created *before* a user enrolled MFA are marked MFA-verified at enrolment; there is no step-up
  re-authentication for individual sensitive admin actions yet.
* Temporary passwords do not expire on their own (they are forced to be changed at first use; `maxAgeDays` applies).
* API client (`api_clients`) administration UI/endpoints are not part of this module yet.
