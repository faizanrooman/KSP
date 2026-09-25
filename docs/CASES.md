# Cases, FIRs and evidence linking (spec module 12)

Code: `apps/api/src/modules/{cases,firs}/`, web `apps/web/src/modules/cases/`, migration `db/migrations/0700_cases_integrations.sql`
(tables from `0005`). Tests: `apps/api/test/{cases,firs}.test.ts`.

## Access rules (`apps/api/src/modules/cases/access.ts`)

| Operation | Rule |
|---|---|
| Read a case | `cases:read` via a grant covering `cases.org_path`, **or** (holding `cases:read` anywhere) being the case IO, supervisor or a member |
| Manage (edit, status, team) | `cases:manage` covering the case, **or** IO/supervisor holding `cases:manage` |
| Link / unlink evidence | `cases:link_evidence` covering the case, **or** case team holding `cases:link_evidence`; each item must pass `loadEvidenceFor(…, 'evidence:read')` |
| Diary entry | case team, or anyone who may manage the case |
| FIRs | `cases:read`/`cases:manage` covering `firs.org_path`; FIRs of cases the user can read are also readable |

Out of scope is always **404**. Missing coarse permission is 403 (via `app.authorize`).

**Case-based evidence visibility** (rule 3 in `lib/access.ts`): the IO, supervisor and members of a non-archived case
can see every evidence item actively linked to it, even from other stations. Adding a member grants this immediately;
removing the member or unlinking the evidence revokes it immediately (visibility is evaluated in SQL per request).

### IO / supervisor / member rules (decision)
* IO and supervisor must be ACTIVE users whose **home unit is the case station, inside it, or an ancestor of it**
  (e.g. a district supervisor), and must hold `cases:read`; the IO must also hold `cases:manage`. → 422 otherwise.
* The IO defaults to the creator when the creator holds `cases:manage`.
* Members may come from **any** unit (cross-station assistance is the purpose) but must be ACTIVE and hold `cases:read`.

## Case numbers
`CASE-<STATION>-<YYYY>-<NNNN>`: station = org code without `ps_`, upper-cased; counter per (station, year) in
`case_number_counters` (upsert inside the create transaction — gapless per station/year under concurrency).

## Status workflow (`packages/shared/src/integrations.ts` `CASE_TRANSITIONS`)
`OPEN → UNDER_INVESTIGATION → PENDING_TRIAL → IN_TRIAL → CLOSED → ARCHIVED`; any active status may go to `CLOSED`;
reopen = `CLOSED|ARCHIVED → UNDER_INVESTIGATION`. Close, archive and reopen require a reason (≥ 5 chars). `closed_at`
is set on close and cleared on reopen. Archived cases are read-only (no edits, links, notes). Each change writes
`CASE_STATUS_CHANGED {from,to,reason,reopen}`. Optimistic concurrency: the update is conditional on the old status.

FIR statuses follow `FIR_TRANSITIONS` (reason required for every change).

## Endpoints (`/api/v1`)
| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/cases` | cases:read | `q, status(csv), priority(csv), orgUnitId, ioId, supervisorId, firId, openedFrom, openedTo, mine, sort, page, pageSize` |
| GET | `/cases/stats/summary` | cases:read | counts by status |
| GET | `/cases/:id` | cases:read | detail + `members`, `evidenceCount`, `hiddenEvidenceCount`, `permissions`, `allowedTransitions` |
| POST | `/cases` | cases:manage | `{title, description?, orgUnitId?, firId?, priority?, investigatingOfficerId?, supervisorId?, court*, external*}` → 201 |
| PATCH | `/cases/:id` | cases:manage | partial update (IO/supervisor/FIR re-validated) |
| POST | `/cases/:id/status` | cases:manage | `{status, reason?}` |
| POST | `/cases/:id/members` | cases:manage | `{userId, role}` → 201; 409 duplicate |
| DELETE | `/cases/:id/members/:userId` | cases:manage | `{reason?}` |
| POST | `/cases/:id/evidence` | cases:link_evidence | `{evidenceIds[≤100], note?}` → `{results:[{evidenceId,status: LINKED|ALREADY_LINKED|NOT_FOUND|NOT_LINKABLE}], linked}` |
| DELETE | `/cases/:id/evidence/:evidenceId` | cases:link_evidence | `{reason}`; soft unlink (`unlinked_at/by/reason`) |
| GET | `/cases/:id/evidence` | cases:read | visible links only + `hiddenCount`; `includeUnlinked=true` for history |
| POST/GET | `/cases/:id/notes` | cases:read | append-only diary (PATCH → 405; DB revokes UPDATE/DELETE) |
| GET | `/cases/:id/timeline` | cases:read | `limit, includeViews` → `{items:[{at,type,category,actor,outcome,summary,evidenceId}], includesEvidenceCustody}` |
| GET/POST/PATCH | `/firs`, `/firs/:id` | cases:read / cases:manage | `(station, year, number)` unique → 409 |
| POST | `/firs/:id/status` | cases:manage | `{status, reason}` |
| POST | `/firs/import` | cases:manage | see `docs/INTEGRATIONS.md` |

Linking: out-of-scope and non-existent ids both return `NOT_FOUND` (no existence leak); only `REGISTERED` and
`DISPOSAL_PENDING` evidence is linkable; closed/archived cases refuse new links. Every link/unlink writes a custody
event (`EVIDENCE_LINKED_TO_CASE` / `EVIDENCE_UNLINKED_FROM_CASE`, category CUSTODY) with **both** `evidence_id` and `case_id`.
`case_evidence` rows can never be deleted (`REVOKE DELETE`).

## Timeline
Merged, newest-first: audit events with `case_id` = the case (case created/updated/status/team/link/unlink), diary
entries (from `case_notes`, with body), and — only for users holding `custody:read` — custody events of linked
evidence that occurred **inside the link window** (`linked_at … unlinked_at|now`) and only for evidence the caller can
see. Views/plays are omitted unless `includeViews=true`. Evidence ids/numbers of evidence the caller cannot see are
never included.

## UI
`/cases` (filters in URL, create dialog), `/cases/:id` tabs Overview (edit, status change with reason), Evidence
(thumbnails, link via evidence search, unlink with reason), Team (UserPicker, remove with reason), Case diary, Timeline,
plus any `CASE_TABS` contributed by other modules (`src/modules/<m>/case-tabs.tsx`). `/firs`, `/firs/:id`, "Import from
CCTNS" dialog. Evidence page action "Link to case" (`evidence-actions.tsx`, gated by `canLinkCase`).
