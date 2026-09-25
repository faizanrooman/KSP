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

## Known limitations

* **Multi-instance caches**: principal (10 s) and settings (15 s) caches are per process. Role revocations and settings
  changes are immediate on the instance that handled them and within the TTL elsewhere. Status changes (disable/lock),
  password/MFA resets and session revocations are immediate everywhere because they revoke session rows. A shared
  invalidation channel (e.g. Postgres `LISTEN/NOTIFY`) is a follow-up.
* Sessions that were created *before* a user enrolled MFA are marked MFA-verified at enrolment; there is no step-up
  re-authentication for individual sensitive admin actions yet.
* Temporary passwords do not expire on their own (they are forced to be changed at first use; `maxAgeDays` applies).
* API client (`api_clients`) administration UI/endpoints are not part of this module yet.
