# Advanced Search & Discovery (spec module 10)

API module `apps/api/src/modules/search/` (prefix `/api/v1/search`), web module `apps/web/src/modules/search/`
(nav Evidence → **Search**, route `/search`). Permission: `search:use`.

## Authorization model

* Every search predicate list starts with `evidenceVisibleSql(principal, 'e')` (`criteria.ts#buildConditions`),
  so results, totals, facets, snippets and AI matches are computed **only over evidence the caller can see**
  (jurisdiction, own, case membership, internal share). An identical query by two users in different stations
  returns different result sets (tested: `io.meera` vs `io.arjun`).
* Case / FIR filters only match cases the caller may read (`caseVisibleSql`: `cases:read` in scope, or IO /
  supervisor / member) — a user cannot probe which visible evidence is linked to a case outside their scope.
* `GET /search/evidence/:id/related` first calls `loadEvidenceFor(..., 'evidence:read')` (out of scope → 404);
  every candidate query is again filtered by `evidenceVisibleSql`.
* Route guard runs in `preValidation`, so a caller without `search:use` gets 403 before any body validation.

## `POST /search/evidence`

Body (all optional, combinable — all criteria are ANDed):

| Field | Meaning |
|---|---|
| `text` | Full text: `search_text @@ (websearch_to_tsquery('english') ∥ websearch_to_tsquery('simple'))` OR trigram word match on title (`<<%`) OR `ILIKE` on evidence number / original filename. Supports `"phrases"`, `or`, `-exclude`. |
| `evidenceNumber` | prefix, case-insensitive |
| `orgUnitIds[]` | jurisdiction subtree(s) (`org_path <@`) |
| `officerIds[]`, `officerBadge` | recording officer (badge case-insensitive) |
| `deviceIds[]`, `deviceSerial` | capture device |
| `uploadedBy` | uploader user id |
| `recordedFrom/To`, `createdFrom/To` | ISO timestamps |
| `location {lat, lon, radiusKm≤500}` | bounding-box prefilter on the `(gps_latitude, gps_longitude)` btree, then haversine ≤ radius |
| `bbox {minLat,maxLat,minLon,maxLon}` | box (mutually exclusive with `location`) |
| `tags[]` + `tagMode any/all` | manual / approved tags |
| `categories[]`, `statuses[]`, `mediaStatuses[]` (processing state), `storageTiers[]`, `legalHold` | lifecycle |
| `caseIds[]`, `caseNumber` (prefix) | linked (active link) to a readable case |
| `firNumber` (+ `firYear`, `firOrgUnitId` station subtree) | via cases → firs |
| `ai { tasks[], labels[], colors[], plateText, watchlistEntryIds[], minConfidence, reviewStatus }` | `EXISTS` on `ai_detections`; **one detection must satisfy all AI criteria** (e.g. a *red car*). Labels use the reviewer-corrected label when present. Plates are normalised (A–Z0–9, upper) and prefix-matched. |
| `sort` | `relevance` (default when `text`), `-recorded_at` (default otherwise), `recorded_at`, `-created_at`, `created_at` |
| `page`, `pageSize ≤ 200`, `includeFacets` (default true) | |

### AI review policy

`ai.reviewStatus` defaults to **`APPROVED`**: only human-approved detections match. `ANY_NON_REJECTED` must be
requested explicitly (UI: "Include unreviewed AI results") and adds `PENDING` / `NEEDS_SECOND_REVIEW` output;
`REJECTED` detections never match. Every AI match in the response carries `reviewStatus` and `unreviewed: true|false`,
and the response carries `includesUnreviewedAi`. The AI-label facet follows the same policy.

### Response

```jsonc
{
  "items": [ /* evidence list item (same mapper as GET /evidence) + */ {
    "matches": {
      "score": 0.61,                                    // relevance (text searches), else null
      "snippet": [{ "text": "Two suspects on a ", "hit": false }, { "text": "motorcycle", "hit": true }],
      "ai": [{ "detectionId": "…", "task": "OBJECT_DETECTION", "label": "car", "confidence": 0.9, "frameTimeMs": 5000,
               "reviewStatus": "APPROVED", "unreviewed": false, "colorName": "Red", "plateText": "KA 01 AB 1234", "watchlistEntryId": null }],
      "aiTotal": 1                                      // matching detections for this item (top 5 returned)
    } }],
  "total": 2, "page": 1, "pageSize": 25, "sort": "relevance",
  "facets": { "station": [{ "key": "<orgUnitId>", "label": "Cubbon Park Police Station", "count": 2 }], "status": [], "storageTier": [], "tag": [], "aiLabel": [] },
  "facetsTruncated": false, "includesUnreviewedAi": false, "tookMs": 23
}
```

Snippets come from `ts_headline` with control-character delimiters and are returned as **segments** (never HTML),
so user-entered text cannot inject markup. `frameTimeMs` powers "jump to moment":
`/evidence/:id?tab=playback&t=<ms>`.

Facets (station, status, storage tier, tag, approved AI label) are computed over the *visible, filtered* result set,
at most 10 000 rows (`facetsTruncated` when more) and 20 buckets per facet.

### Audit

Each search writes `SEARCH_PERFORMED` (category SEARCH) with `details = { criteria (sanitised, text ≤ 200 chars,
dates ISO), resultCount, page, pageSize, sort, unreviewedAi }` — never the result list. Related lookups write
`SEARCH_PERFORMED` with `{ kind: 'related', sourceEvidenceId, resultCount }`. Saved-search changes write
`SAVED_SEARCH_CHANGED`.

## Saved searches

`GET /search/saved` (mine) · `POST /search/saved {name, criteria}` (criteria validated exactly like the search body;
409 on duplicate name) · `DELETE /search/saved/:id` (own only, else 404). Table `saved_searches` (0600). Only
criteria are stored; results are always re-evaluated against the caller's current access.

## Related evidence — `GET /search/evidence/:id/related`

Reasons (weighted, merged per item, top 100): `RELATION` (explicit `evidence_relations`), `SAME_CASE` (readable case),
`SHARED_WATCHLIST` / `SHARED_PLATE` (APPROVED detections only), `NEARBY` (GPS ≤ 200 m **and** recording ranges
overlap), `SAME_DEVICE` / `SAME_OFFICER` (recorded within ±1 h of the source recording). Items: evidence list item
+ `reasons[{kind, detail, relationId?, relation?}]` + `score`.

## Federated search across repositories / storage tiers

The search index is the evidence metadata in PostgreSQL (`evidence.search_text` tsvector, columns, tags,
`ai_detections`), which is **independent of where the original object lives**. Evidence in `ACTIVE`, `ARCHIVE` and
`LONG_TERM` tiers is therefore always searchable without touching object storage; `storageTiers[]` is an
index-backed filter (`evidence_storage_tier`). Retrieval of archived media is a separate (lifecycle) concern.
External digital-evidence repositories (integration systems) are **not** federated live: their contracts are not
defined in the specification (see `integration_systems` — UNVERIFIED); items imported from them become searchable
like any other evidence.

## Indexes (migration `0600_search_investigation.sql`)

Pre-existing (0003): `evidence_org_path` (gist), `evidence_status`, `evidence_recorded`, `evidence_created`,
`evidence_officer`, `evidence_device`, `evidence_uploaded_by`, `evidence_geo (lat, lon)`, `evidence_search` (gin),
`evidence_title_trgm`, `evidence_tags_tag`, `ai_detections_evidence`, `ai_detections_attrs` (gin jsonb_path_ops).
Added: `evidence_storage_tier (storage_tier, created_at)`, `evidence_media_status`, `evidence_category`,
`evidence_legal_hold` (partial), `evidence_number_trgm`, `evidence_filename_trgm`, `evidence_officer_recorded`,
`evidence_device_recorded`, `evidence_org_unit`, `ai_detections_eff_label (lower(coalesce(corrected_label,label)),
review_status)`, `ai_detections_color`, `ai_detections_plate (ksp_plate_norm(attributes->>'plateText')
text_pattern_ops)`, `ai_detections_watchlist`, `ai_detections_evidence_review`, `cases_fir`, `firs_number`,
`case_members_user`. Function `ksp_plate_norm(text)` (IMMUTABLE).

## Performance (measured locally, `apps/api/test/search.test.ts`)

6 000+ synthetic evidence rows (two stations, three tiers, GPS grid), after `ANALYZE`, as `io.meera`
(`EXPLAIN (ANALYZE)` of the main page query incl. the visibility predicate):

| Query shape | Plan uses | Execution |
|---|---|---|
| text (rare token), relevance sort | `evidence_search` / trigram indexes (BitmapOr) | ≈ 10 ms |
| location radius 2 km | `evidence_geo` | ≈ 0.4 ms |
| storage tier + evidence-number prefix | `evidence_number_trgm` / `evidence_storage_tier` | ≈ 4–6 ms |
| end-to-end API (text + facets + hydration + audit) | — | ≈ 25–30 ms |

The test asserts index usage and < 300 ms per query. Broad queries matching a large share of rows (e.g. a word in
every title) legitimately use sequential scans; `count(*) OVER ()` costs O(matches). For multi-million-row
deployments consider keyset pagination and an approximate total (not implemented).

## Web UI

Query bar (websearch syntax) · Filters panel with every criterion above (map-free lat/lon/radius inputs, AI filters,
explicit **Include unreviewed AI results** toggle with a warning banner) · facet sidebar (click to refine) · result
cards with thumbnail, highlighted snippet, AI moment chips (click → playback at that moment; unreviewed chips are
amber and labelled "Unreviewed AI") · sort · pagination · saved searches (save / load / delete). State lives in the
URL (`?c=<criteria JSON>&page=&sort=`), so searches are shareable and survive reload.
