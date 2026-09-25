# Authentication

Code: `apps/api/src/modules/auth/index.ts`, `apps/api/src/lib/session.ts`, `apps/api/src/plugins/auth.ts`,
`apps/api/src/lib/load-principal.ts`. Settings: `packages/shared/src/settings.ts` (editable via `PUT /settings/:key`).

## Credentials

| Item | Implementation |
|---|---|
| Password hashing | Argon2id (m=19 MiB, t=2, p=1), `@ksp/core` `hashSecret` |
| Password policy | `passwordPolicy`: min length (10–128, default 12), character classes, history (last N rejected), max age (forced change) |
| Must-change | `users.must_change_password` — set for every new account and every administrative reset; all routes except `/auth/*` answer `403 PASSWORD_CHANGE_REQUIRED` until changed |
| Temporary passwords | Generated server-side (`generateTemporaryPassword`, CSPRNG, ≥16 chars, all classes, no ambiguous characters). Returned **once** in the create/reset response; never logged, never audited, never retrievable |
| Unknown user timing | Password verified against a dummy hash so unknown and wrong-password logins take the same time and return the same generic error |

## Login flow

1. `POST /auth/login {username, password, tokenMode}` — per-IP failed-attempt throttle (`lockoutPolicy.ipMaxFailedPerWindow`
   per `windowMinutes` → 429), per-account lockout after `maxFailedAttempts` (→ 423 for `lockoutMinutes`), status check
   (`LOCKED`/`DISABLED`/`PENDING` → 403 `ACCOUNT_DISABLED`). Every attempt is stored in `login_attempts` and audited.
2. If MFA is enrolled: a 5-minute `mfa` JWT is returned; `POST /auth/mfa/verify` with a TOTP code (RFC 6238, ±1 step) or a
   one-time recovery code (argon2-hashed, consumed on use). Failed codes count toward the account lockout.
3. A session row is created; the oldest sessions beyond `sessionPolicy.maxConcurrentSessions` are revoked
   (`revoke_reason = CONCURRENT_LIMIT`).

## Tokens & sessions

* **Access token**: EdDSA JWT (15 min) `{sub, sid, typ:'access'}` in an httpOnly `SameSite=Strict` cookie (browser) or
  returned in the body (`tokenMode: 'bearer'`, station client / scripts).
* **Refresh token**: opaque 256-bit, stored only as SHA-256, single use, rotated on each refresh. Presenting a consumed
  token revokes the whole token family and the session (`TOKEN_REUSE_DETECTED`).
* **Every request re-reads the session row**: revocation, idle timeout (`idle_expires_at`, sliding, capped at the
  absolute expiry) and absolute timeout take effect on the next request. The principal (roles/permissions) is cached
  per session for 10 s and invalidated in-process on every administrative change (`invalidatePrincipals`).
* **CSRF**: cookie-authenticated unsafe requests need the double-submit header `x-csrf-token` equal to the
  `ksp_csrf` cookie, and an allowed `Origin`.

## MFA

* TOTP enrolment: `POST /auth/mfa/setup` (secret + QR) → `POST /auth/mfa/confirm` (returns 10 recovery codes once).
  Secrets are AES-256-GCM encrypted at rest (`DATA_ENCRYPTION_KEY`).
* **Mandatory** for roles in `sessionPolicy.requireMfaForRoles` (default: SYSTEM_ADMINISTRATOR, SUPERVISOR, AUDITOR,
  EVIDENCE_CUSTODIAN). Until enrolled, every non-auth route answers `403 MFA_ENROLLMENT_REQUIRED`; MFA cannot be
  self-disabled while mandatory. Changing the list takes effect on live sessions immediately (principals invalidated).
* Administrative **MFA reset** (`POST /users/:id/reset-mfa`, reason required) clears the secret and recovery codes and
  revokes all sessions; the user re-enrols at next sign-in if mandatory.

## Administrative credential actions

All require `users:manage` at the account's home org unit, a reason (audited), and are refused for your own account:

| Endpoint | Effect |
|---|---|
| `POST /users/:id/reset-password` | new one-time password (returned once), must-change, lockout cleared, **all sessions revoked** |
| `POST /users/:id/reset-mfa` | MFA removed, **all sessions revoked** |
| `POST /users/:id/status` `DISABLED`/`LOCKED` | account blocked, **all sessions revoked**; `ACTIVE` re-enables and clears counters |
| `POST /users/:id/unlock` | clears failed-login lockout (and administrative `LOCKED`) |
| `DELETE /users/:id/sessions/:sid`, `POST /users/:id/sessions/revoke-all` | revoke sessions (and their refresh tokens) |

## Tests

`apps/api/test/auth.test.ts` (login, lockout, CSRF, refresh rotation/reuse, forced change, MFA, mandatory MFA) and
`apps/api/test/security-authz.test.ts` (idle + absolute timeout, sliding idle window, concurrent-session limit,
disabled user's session dies on the next request, role revocation/expiry effective immediately, admin MFA enforcement).
Admin tests enrol MFA through the real API (`apps/api/test/admin-helpers.ts`) — no policy is relaxed.
