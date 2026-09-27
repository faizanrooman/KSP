# Authorization

Model: **RBAC with jurisdiction scoping**. Permission codes live in `packages/shared/src/permissions.ts`. A role is a
set of permission codes; a role is **granted to a user at an org unit** (`user_roles`) and applies to that unit's whole
subtree (`org_units.path`, ltree). Grants may expire (`expires_at`); grants at inactive units do not apply.

Helpers (`apps/api/src/lib/principal.ts`, `access.ts`): `hasPermission` (anywhere), `hasPermissionAt(p, perm, path)`,
`scopePaths`, `orgScopeSql`, `evidenceVisibleSql`/`loadEvidenceFor` (evidence — see CONTRACTS §4).

## Administration endpoints

| Resource | Read | Write | Scope anchor | Out of scope |
|---|---|---|---|---|
| Users `/users` | `users:read` (or `users:manage`/`roles:manage`) | `users:manage` | user's **home** org unit | **404** |
| Role grants `/users/:id/roles` | — | `roles:manage` | the grant's org unit | 403 `OUT_OF_SCOPE` (target user out of scope → 404) |
| Roles `/roles` | `roles:read` | `roles:manage` | global definitions (see rules) | — |
| Org units `/org` | `org:read` | `org:manage` | the unit (create: the parent) | 403 (unit names are public via `/directory`) |
| Devices `/devices` | `devices:read` | `devices:manage` | device's org unit | **404** |
| Settings `/settings` | `settings:manage` | `settings:manage` | global | — |

Visible-but-not-manageable resources answer 403.

## Administration rules (decisions)

1. **Grantor rule (privilege escalation).** To grant role R at unit O the caller must hold `roles:manage` at O **and**
   either hold *every* permission of R at O, **or** hold `roles:manage` at a root (state-level) unit. Consequences:
   a station administrator cannot grant SYSTEM_ADMINISTRATOR at state level (out of scope) nor an evidence role such as
   INVESTIGATING_OFFICER at their station (they do not hold `evidence:*`); they can grant custom roles made only of
   permissions they hold there. Refusals return `403 PRIVILEGE_ESCALATION` with `details.missing`.
2. **Role definitions.** Adding a permission to a role requires holding it (unless root `roles:manage`). System roles, and
   custom roles assigned anywhere outside the editor's `roles:manage` scope, can only be edited by a state-level
   administrator. Unknown permission codes → 400. Codes and the system flag are immutable (DB trigger).
3. **No self-modification.** Nobody may change their own status, password (admin reset), MFA, sessions-in-bulk, role
   assignments, home unit, or the permissions of a role they currently hold, nor deactivate a unit where they hold a
   grant. → `403 SELF_MODIFICATION`. This forces a second administrator (four-eyes) for any change to one's own privileges.
4. **Separation of duties.** `SOD_CONFLICTS` (`evidence:dispose_request`/`dispose_approve`, `audit:read`/`roles:manage`)
   are enforced (a) within a role definition, (b) across **all** of one user's unexpired roles on grant and on user
   creation, (c) on role edits for every current holder. → `422 SOD_VIOLATION`. Runtime checks additionally stop a
   requester approving their own disposal/export (DB CHECK constraints).
5. **Lock-out protection.** After any status change, grant revocation or permission removal, at least one ACTIVE user
   must still hold `roles:manage` at a root unit, checked inside the same transaction → `409 LAST_ADMINISTRATOR`.
6. **Deleting.** System roles never (API + DB trigger); custom roles only when no assignment (even expired) references
   them. Org units are never deleted (DB trigger) — deactivate instead (children first; never the root). Devices are
   retired, never deleted.
7. **No re-parenting.** Org unit code, parent, type and path are immutable (`org_units_guard` trigger, migration 0100):
   `evidence.org_path` and other `org_path` columns are denormalised copies used for jurisdiction checks; changing a
   path would silently move evidence between jurisdictions. Restructure by creating a new unit and deactivating the old.
8. **Immediacy.** Every permission/status change calls `invalidatePrincipals(userId)` (role edits / settings / unit
   activation: all principals). Status changes also revoke sessions, which is enforced cluster-wide on the next request.

Every refusal by rules 1–5 writes an `ADMIN_ACTION_DENIED` (SECURITY) audit event; permission-check failures write
`ACCESS_DENIED`. All successful changes are audited in the same transaction (`USER_*`, `ROLE_*`, `ORG_UNIT_*`,
`DEVICE_*`, `SETTINGS_UPDATED` with old/new values).

## Feature-level permission decisions

* **Snapshot from the original (SEC-R11, decision: keep).** `POST /media/evidence/:id/snapshots` with
  `source: "original"` requires only `evidence:snapshot` (+ jurisdiction via `loadEvidenceFor`), **not**
  `evidence:download_original`. Rationale: the output is a single re-encoded PNG still (not the original bytes), it
  is stored as a derivative with its own SHA-256 and custody-audited (`EVIDENCE_SNAPSHOT_CREATED`), and exact-frame
  stills from the original are routine investigative work for roles that must not be able to exfiltrate the full
  original. Pinned by `security-residual.test.ts` (role premise) and `media.test.ts` (io.meera, without
  `download_original`, extracts an original frame). Changing this requires a DECISIONS.md entry.
* **Unreviewed AI in search (SEC-R9).** `ai.reviewStatus=ANY_NON_REJECTED` requires `ai:review` or `ai:request`
  in addition to `search:use` (403 + `ACCESS_DENIED` otherwise); the default `APPROVED` needs only `search:use`.
* **Dashboard unit filter (SEC-R12).** `orgUnitId` must lie inside one of the viewer's `dashboard:view` grant
  subtrees; otherwise 404 (identical to an unknown unit).
* **Export approval by custodians (EXT-10).** See ADMIN-GUIDE.md § Export approval policy.

## Tests

`apps/api/test/admin-{users,roles,org,devices,settings}.test.ts` and `security-authz.test.ts`: 401 / 403 / 404-other
jurisdiction / validation / happy path for every endpoint, escalation (station admin vs. state role, missing permissions,
own roles, own role definition), SoD within and across roles, last-administrator guard, DB triggers, audit chain intact.
