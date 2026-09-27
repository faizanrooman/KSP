# Investigation Workspace (spec module 11)

API module `apps/api/src/modules/workspaces/` (prefix `/api/v1/workspaces`), web module
`apps/web/src/modules/investigation/` (nav Investigation → **Workspaces**, routes `/workspaces`, `/workspaces/:id`).
Permission: `workspace:use` (guard in `preValidation` → 403 before validation).

## Access rules (`access.ts`)

* A workspace is visible **only to its members**; non-members get **404**. Roles: `OWNER` (one per workspace,
  the creator) · `EDITOR` (add/remove items, offsets, notes, bookmarks, annotations, timeline events, title) ·
  `VIEWER` (read). The owner manages members, the case link and archive state.
* **A workspace never grants evidence access.** Item lists, timelines, bookmarks, annotations and relations are
  filtered with `evidenceVisibleSql` / `loadEvidenceFor` for the *calling* user. Items a member cannot see are
  returned as `{ id, restricted: true, sortOrder, addedAt }` — no evidence id, number, title, notes or thumbnail.
  Manual timeline events that point at such evidence are shown with `restricted: true, evidenceId: null, timeMs: null`.
* Adding an item requires `loadEvidenceFor(..., 'evidence:read')` for each item (all-or-nothing, 404 if any is
  out of scope). New members must be ACTIVE users holding `workspace:use` somewhere (422 otherwise).
* `caseId` (create / patch) must be a case the caller can read (`cases:read` scope or IO/supervisor/member), else 404.
  Members who cannot read the case see `case: null, caseRestricted: true`.
* Workspace `org_unit_id` = creator's home unit. ARCHIVED workspaces are read-only (409) until the owner re-activates.

## Endpoints

| Method & path | Role | Notes |
|---|---|---|
| `GET /workspaces?scope=all\|mine\|shared&status=ACTIVE\|ARCHIVED\|ANY&q&caseId&page&pageSize` | member | `{items:[{id,title,description,status,case,caseRestricted,owner,myRole,itemCount,memberCount,…}], total, page, pageSize}` |
| `POST /workspaces {title, description?, caseId?}` | — | 201 detail; audit `WORKSPACE_CREATED` |
| `GET /workspaces/:id` | viewer | detail incl. `members[]`, `myRole`, `orgUnit`, `case` |
| `PATCH /workspaces/:id {title?, description?, caseId?, status?}` | editor (title/description), owner (case/status) | `WORKSPACE_UPDATED` |
| `POST /workspaces/:id/members {userId, role: EDITOR\|VIEWER}` · `PATCH …/members/:userId {role}` · `DELETE …/members/:userId` | owner (self may leave) | `WORKSPACE_MEMBER_CHANGED`; owner cannot be removed (409) |
| `GET /workspaces/:id/items` | viewer | visible items carry `evidence` (list item + `recordedEndAt`, `frameRate`, GPS), `syncOffsetMs`, `notes` |
| `POST /workspaces/:id/items {evidenceIds[≤50], notes?}` | editor | custody `WORKSPACE_EVIDENCE_ADDED` per item |
| `PATCH /workspaces/:id/items/:itemId {syncOffsetMs?, sortOrder?, notes?}` · `PUT /workspaces/:id/items/offsets {items:[{itemId, syncOffsetMs}]}` | editor | `WORKSPACE_ITEM_UPDATED` (with evidenceId); offsets ±7 days |
| `DELETE /workspaces/:id/items/:itemId` | editor | custody `WORKSPACE_EVIDENCE_REMOVED` |
| `GET /workspaces/bookmarks?evidenceId&workspaceId?` · `POST /workspaces/bookmarks {evidenceId, workspaceId?, timeMs, label}` · `DELETE /workspaces/bookmarks/:id` | evidence:read (+ editor in the workspace) | custody `BOOKMARK_CREATED/DELETED` |
| `GET /workspaces/annotations?evidenceId&workspaceId?&includeDeleted` · `POST /workspaces/annotations {evidenceId, workspaceId?, kind, startMs, endMs?, body?, region?, color?}` · `PATCH /workspaces/annotations/:id` · `DELETE /workspaces/annotations/:id {reason?}` | evidence:read (+ editor) | custody `ANNOTATION_CREATED/UPDATED(before/after)/DELETED` |
| `GET /workspaces/:id/timeline` | viewer | reconstruction (below) |
| `POST /workspaces/:id/timeline/events {title, description?, occurredAt, evidenceId?, timeMs?}` · `PATCH …/events/:eventId` · `DELETE …/events/:eventId` | editor | `TIMELINE_EVENT_CHANGED` (evidenceId when linked); linked evidence must be readable and an item; DELETE is a **soft delete** (`deleted_at`/`deleted_by`, row kept; DELETE revoked from `ksp_app`, migration 1057) |
| `GET /workspaces/relations?evidenceId` · `POST /workspaces/relations {evidenceA, evidenceB, relation, note?}` · `DELETE /workspaces/relations/:id` | both items readable | custody `EVIDENCE_RELATION_CHANGED` on **both** items |

Related-evidence suggestions are served by the search module: `GET /search/evidence/:id/related` (see SEARCH.md).

### Bookmarks & annotations visibility

* Bookmark without workspace → personal (creator only). With workspace → that workspace's members. Delete: creator
  or workspace owner.
* Annotation without workspace → shared analytical note visible to everyone who can read the evidence. With
  workspace → its members. Edit / delete: author or workspace owner (and editor role while attached to a workspace).
* Writes attached to a workspace require the evidence to be an item of that workspace (422).
* Times are validated against `duration_ms`. `REGION` requires `region {x,y,w,h}` normalised to the frame
  (0..1, inside the frame — also enforced by a DB CHECK); `NOTE` requires a body.
* Annotations are **soft-deleted** (`deleted_at`, `deleted_by`, DB CHECK that deleted rows name the deleter);
  `DELETE` is revoked from `ksp_app` on `annotations` (0600). Deleted annotations remain listable with
  `includeDeleted=true` and in the custody trail. Annotations never modify the original evidence.

## Timeline reconstruction (`timeline.ts`)

`GET /workspaces/:id/timeline` returns
`{ range, lanes[], entries[], overlaps[], unplaced[], unplacedItems[] }`:

* **lanes** — one per visible item with a `recorded_at`: `start`, `end` (= `recorded_end_at`, else
  `recorded_at + duration_ms`), `syncOffsetMs` (stored), `suggestedOffsetMs` (= start − earliest start: aligns all
  videos by wall-clock on the SyncPlayer master timeline).
* **entries** (chronological, wall-clock) — `RECORDING` spans, manual `EVENT`s, workspace `BOOKMARK`s and non-deleted
  `ANNOTATION`s placed at `evidence.recorded_at + time_ms`.
* **overlaps** — every pair of recordings whose spans intersect ("same moment, different angle"):
  `{a, b, start, end, durationMs, aTimeMs, bTimeMs}` where `aTimeMs/bTimeMs` are the local playback times at which
  the overlap starts in each video.
* Items without `recorded_at` are listed in `unplacedItems`; their bookmarks/annotations in `unplaced`.

## Web UI

* **Workspaces list** — scope/status/title filters, create.
* **Workspace page** tabs (tab/item/time in the URL):
  * *Evidence* — grid with thumbnails, notes, remove (confirm), **Add evidence** picker (permission-aware search);
    restricted items are counted and explained, never shown.
  * *Compare* — choose up to 4 videos → `SyncPlayer`; offset changes (`onOffsetsChange`) are debounced and
    persisted with `PUT …/items/offsets` (editors; read-only otherwise); "Align by recording time".
  * *Review & annotate* — `EvidencePlayer` with bookmarks/annotations as `markers`, REGION annotations drawn via
    `overlays` in percentage coordinates (follow zoom/pan); create bookmark at the current time; Note/Highlight/Region
    at the current time — Region: pause and drag a box on the frame; edit / soft-delete; click to seek.
  * *Timeline* — lanes per video + events row (click a lane position → open that video at that moment), overlap list
    with "Compare aligned" (applies suggested offsets), chronology list, add/delete manual events.
  * *Related* — explicit relations (create/remove) and suggestions.
  * *Members* — add (user picker), change role, remove, leave.
* **Evidence detail contributions** — tabs "Bookmarks & annotations" (order 40, `workspace:use`: personal
  bookmarks + shared notes by time input, all visible bookmarks/annotations incl. deleted toggle, click → playback at
  time) and "Related evidence" (order 50, `search:use`); action "Add to workspace" (`workspace:use`).
