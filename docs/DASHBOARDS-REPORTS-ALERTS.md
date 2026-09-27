# Dashboards, Reports & Alerts (spec module 17)

Status: implemented and tested (API + worker + web). Items marked **UNVERIFIED** were not exercised.

## Components

| Layer | Location |
|---|---|
| Migrations | `db/migrations/0900_ops_alerts_monitoring.sql`, `0901_ops_disable_jit.sql` |
| Shared contracts | `packages/shared/src/reports.ts` (report catalogue), audit codes `REPORT_REQUESTED/FAILED/DOWNLOADED` |
| Alert helper | `packages/core/src/alerts.ts` (`raiseAlert`, `autoResolveAlerts`, `alertRecipients`, `dispatchPendingAlerts`, webhook/e-mail channels) |
| API | `apps/api/src/modules/{dashboard,alerts,reports,system}` |
| Worker | `apps/worker/src/jobs/{alerts,reports,storage}` |
| Web | `apps/web/src/modules/{dashboard,alerts,reports,system}` |

## Dashboard — `GET /api/v1/dashboard/summary?from&to&orgUnitId` (`dashboard:view`)

Defaults to the last 30 days (max 366). Web route `/` (nav "Dashboard", Overview, order 0); filters live in
the URL; auto-refresh every 60 s.

Scoping (no number is computed from data outside the viewer's scope):

* evidence — `evidenceVisibleSql` (jurisdiction, own, case, share); `orgUnitId` further narrows to a subtree
  (filtering to a unit outside the viewer's scope simply yields zeros);
* upload sessions — `evidence:read` jurisdiction over the session's unit, or the viewer's own sessions
  (field officers therefore see only their own uploads);
* AI jobs / review queue / review outcomes — joined through visible evidence;
* alerts — same scoping as `GET /alerts`;
* `storage` and `system` sections — only for `system:monitor`; sections a role may not see are `null`.

Response: `meta {from,to,orgUnit,scope: JURISDICTION|OWN|RELATIONSHIP, sections, timingsMs}`, `uploads
{total, byStatus, failed, inProgress, perDay[]}`, `evidence {total, totalBytes, registeredInPeriod,
pendingMediaProcessing, mediaFailed, quarantined, legalHolds, disposalPending, retentionOverdue,
disposedInPeriod, perDay[], byStation[], byCategory[]}`, `analytics {jobs, reviewQueue, reviewOutcomes}`,
`alerts {open, bySeverity, recent[]}`, `recentFailures[]` (links to items), `storage`, `system`.

Measured timings (dev host, `meta.timingsMs.total`): test data (a few dozen rows) 3–28 ms per role;
50 000 evidence + 20 000 upload sessions, station IO seeing 12 500 items: **75–82 ms** (was ~1.3 s before
`0901` disabled JIT — see MONITORING.md §Database). State-wide viewers over 50k rows were not timed via the
API (the MFA-mandatory roles cannot log in non-interactively) — UNVERIFIED at larger scale.

### Charts (web)
recharts, validated palette slots 1–3 (`#2a78d6`, `#eb6834`, `#1baf7a`; dataviz validator: all checks pass
on white, aqua < 3:1 contrast → every chart has a text summary + a "Show data table" view), status colours
reserved for severities/threshold meter and always paired with an icon/text. One y-axis per chart.

## Alerts

### Raising (`raiseAlert`)
* Disabled rule → nothing written (`suppressed`).
* Severity: explicit severity (level-based producers, e.g. storage WARNING/CRITICAL) else the rule's
  configured severity. Repeats never lower severity; an escalation clears `notified_at` (re-notify).
* De-duplication: one non-resolved alert per `dedupe_key` (`occurrences++`, `last_seen_at`, message).
  `onlyIfNew` (one-alert-per-event producers) skips when ANY alert ever existed for the key.
* The ingest and lifecycle workers' former direct `INSERT INTO alerts` helpers now delegate to it
  (`apps/worker/src/jobs/ingest/handlers.ts`, `apps/worker/src/jobs/lifecycle/common.ts`; covered by their
  existing tests, which pass).

### Evaluator — cron `alerts.evaluate` (every minute)
Each rule runs in its own transaction with its `alert_cursors` row locked (`watermark` = upper bound of the
last evaluated window, DB-time with microseconds). Disabled rules only advance the cursor. First run looks
back 60 min.

| Rule | Condition | Dedupe key | Clears |
|---|---|---|---|
| UPLOAD_FAILED | upload_sessions FAILED; evidence QUARANTINED (window re-scanned with 10 min overlap) | `UPLOAD_FAILED:<session>` (same key as the ingest worker) / `UPLOAD_QUARANTINED:<evidence>`, onlyIfNew | manual |
| PROCESSING_FAILED | processing_jobs FAILED | `PROCESSING_FAILED:<job>`, onlyIfNew | **auto** when the job later COMPLETED |
| AI_FAILURE | ai_jobs FAILED | `AI_FAILURE:<job>`, onlyIfNew | manual |
| INTEGRITY_FAILURE | integrity_checks `ok=false` (skipped while an open INTEGRITY_FAILURE alert exists for the item — fixity/tier workers raise their own) | `INTEGRITY_CHECK:<check>` | manual |
| STORAGE_THRESHOLD | latest snapshot per bucket (≤ 1 day): total vs `capacityBytes` (rule config → settings `storagePolicy`); per-bucket if `capacity_bytes` set; WARNING ≥ warn %, CRITICAL ≥ critical %; only bumps on a new snapshot | `STORAGE_THRESHOLD:TOTAL` / `:<bucket>` | **auto** below warn % (with note). No alert when capacity is undeclared |
| QUEUE_BACKLOG | per non-dead queue: waiting > `maxQueued` (500) or oldest due job > `maxAgeMinutes` (60) | `QUEUE_BACKLOG:<queue>` | **auto** when drained |
| EXCESSIVE_DOWNLOADS | EVIDENCE/EXPORT/SHARE_DOWNLOADED per actor in the last hour > `perHour` (rule config → settings `excessiveDownloadsPerHour`, 20), and the actor had activity after the watermark | `EXCESSIVE_DOWNLOADS:<actorType>:<actorId>` | manual |
| AUTH_BRUTE_FORCE | failed login_attempts in 15 min > `failuresPer15Min` (20) per IP and per account name | `AUTH_BRUTE_FORCE:ip:<ip>` / `:user:<name>` | manual |
| POLICY_VIOLATION | EVIDENCE_ACCESS_DENIED + ACCESS_DENIED per actor in 15 min > `deniedPer15Min` (10) | `POLICY_VIOLATION:<actorId>` | manual |
| AUDIT_CHAIN_BROKEN | `audit_verify(last_seq+1)` incrementally every minute; full `audit_verify(1)` every `fullVerifyEveryHours` (24). On failure the cursor stays before the bad record so it is re-detected until investigated | `AUDIT_CHAIN_BROKEN` (CRITICAL) | manual |

Thresholds are "more than N". Org unit of actor-based alerts = the user's home unit (routing/scoping).

### Notifications & channels
`dispatchPendingAlerts` (same cron) claims OPEN alerts with `notified_at IS NULL`: WARNING/CRITICAL →
`notifications` rows for ACTIVE users holding `alerts:manage` through a grant covering the alert's unit (root
units for system-wide alerts), plus outbound channels; INFO → marked notified, no fan-out. Every attempt is
logged in `alert_deliveries` (IN_APP / WEBHOOK / EMAIL; SENT / RETRYING / FAILED / SKIPPED; `attempt`,
`next_attempt_at`). The table is append-only: every attempt is its own row.

* **Webhook** (`ALERT_WEBHOOK_URL`, optional `ALERT_WEBHOOK_SECRET` → `x-ksp-signature: sha256=<HMAC>`,
  `ALERT_WEBHOOK_TIMEOUT_MS`): implemented; tested against a local HTTP server (success, HMAC, HTTP 500
  failure + retries). Against a real receiver: **UNVERIFIED**.
* **E-mail** (SMTP via `nodemailer`, `packages/core/src/mailer.ts`): `ALERT_SMTP_URL`
  (`smtp://user:pass@relay:587` or `smtps://relay:465`), `ALERT_EMAIL_FROM`, `ALERT_SMTP_TIMEOUT_MS`,
  `ALERT_SMTP_TLS_REJECT_UNAUTHORIZED=false` (dev relays only). Recipients = e-mail addresses (`users.email`) of
  the in-scope `alerts:manage` holders (setting `alertDeliveryPolicy.emailAlertManagers`) + the rule's
  `emailRecipients` (Alert rules page) + `alertDeliveryPolicy.warningRecipients` (WARNING and CRITICAL) +
  `criticalRecipients` (CRITICAL only). Plain-text message: severity, title, message, rule, occurrences,
  first/last seen, resource id and a sign-in link `APP_BASE_URL/alerts/<id>` — no evidence content, storage
  keys or credentials. No recipients → SKIPPED. Tested against a local SMTP sink (`smtp-server`) started by the
  worker test, asserting envelope, recipients and body. **A real SMTP relay is UNVERIFIED.**
* **Retries**: the first external attempt runs in the dispatcher; a failure is recorded RETRYING and the next
  attempt is enqueued on `alerts.deliver` with `startAfter = baseDelaySeconds · 2^(attempt-1)` (capped at 24 h)
  until `alertDeliveryPolicy.maxAttempts` (default 5, first retry after 60 s); the last failure is FAILED
  "(after N attempts)". A retry for an alert resolved in the meantime is SKIPPED. The alert detail page shows
  each attempt and the next scheduled attempt.

### API
| Method & path | Permission | Notes |
|---|---|---|
| `GET /alerts?status&severity&rule&from&to&orgUnitId&q&sort&page&pageSize` | alerts:read | scoped: org alerts under the reader's `alerts:read` grants; system-wide alerts only for root-level readers or `system:monitor` |
| `GET /alerts/summary` | alerts:read | open/acknowledged by severity |
| `GET /alerts/:id` | alerts:read | out of scope → 404; includes `deliveries[]` |
| `POST /alerts/:id/acknowledge {note?}` | alerts:manage at the alert unit (root for system-wide) | 403 if visible but not manageable; 409 if already acknowledged/resolved; audit `ALERT_ACKNOWLEDGED` |
| `POST /alerts/:id/resolve {note ≥ 5 chars}` | same | audit `ALERT_RESOLVED` |
| `GET /alerts/rules` | alerts:manage | `canEdit` true only with a root-level grant |
| `PUT /alerts/rules/:code {enabled?, severity?, config?}` | alerts:manage at a root unit | per-rule config schema (strict), audit `ALERT_RULE_UPDATED` (before/after) |
| `GET /notifications?unread&page` · `POST /notifications/:id/read` · `POST /notifications/read-all` | authenticated (own only) | others' ids → 404 |

### Web
`/alerts` (filters in URL), `/alerts/:id` (acknowledge / resolve via `ConfirmDialog`, resolution note
required), `/alerts/rules` (thresholds), `/notifications`.

**NotificationBell** (the shell header is orchestrator-owned; not mounted by this workstream):

```tsx
// apps/web/src/components/AppShell.tsx, inside <header> next to the user menu
import { NotificationBell } from '@/modules/alerts/NotificationBell';
<NotificationBell />
```
It polls `GET /notifications?unread=true&pageSize=8` every 60 s, exposes the unread count in its accessible
name, and closes on Escape/outside click.

## Reports

`reports:generate` plus per-type permission, scope = org paths where the requester holds **all** of them
(frozen into `report_runs.params.scopePaths` at request time; `orgUnitId` must lie inside → else 404).
Relationship-based (case/share) visibility is never included in reports.

| Type | Extra permission | Content |
|---|---|---|
| EVIDENCE_INVENTORY | evidence:read | per station: items, bytes, tier counts, holds, quarantined, disposal pending, disposed (registered in period) |
| UPLOAD_ACTIVITY | evidence:read | per day × uploader × device × station: sessions, completed, failed, aborted/expired, bytes, registered, quarantined, reasons |
| CHAIN_OF_CUSTODY_SUMMARY | custody:read | per item: views, plays, downloads, export/share events, denials, total custody events, distinct actors, last event |
| ACCESS_AUDIT | audit:read | every evidence access event (seq, time, actor, action, outcome, item, station, IP); optional `actorId` |
| RETENTION_COMPLIANCE | evidence:read | overdue retention, legal holds, disposals pending/approved/executed |
| AI_REVIEW | evidence:read | per task/model/version outcomes + approval rate; per-reviewer throughput |
| INTEGRITY | evidence:read | every fixity check with expected/actual hash |
| USER_ACCESS_REVIEW | users:read | users in scope (by home unit), active grants, last login, MFA, flags NEVER_LOGGED_IN / INACTIVE_nD / NO_MFA / DISABLED_WITH_GRANTS; `inactiveDays` (90) |
| EXPORT_SHARE_ACTIVITY | evidence:read | exports and shares created in the period |

Flow: `POST /reports/runs {reportType, format CSV|PDF|JSON, from?, to?, orgUnitId?, actorId?, inactiveDays?}`
→ 201 `QUEUED` (audit `REPORT_REQUESTED`) → worker `report.build` → `COMPLETED` with `sha256` (object),
`content_sha256` (canonical CSV of all rows), `row_count`, `size_bytes` (audit `REPORT_GENERATED`, system
actor). `GET /reports/runs` / `GET /reports/runs/:id` — own runs only. `POST /reports/runs/:id/download-link`
→ `{url, expiresAt}` (HMAC token, 5 min, bound to user + session + run) → `GET /reports/runs/:id/download?t=`
streams the object (`x-content-sha256`, `cache-control: no-store`), re-checks the session is live, audits
`REPORT_DOWNLOADED`. Objects: reports bucket `reports/<yyyy>/<mm>/<runId>.<ext>`; storage URLs never exposed.

Rendering: CSV/JSON streamed to S3 (multipart) while hashing; CSV cells starting with `= + - @ tab CR` are
prefixed with `'` (formula-injection). PDF (pdfkit, A4, landscape for wide tables): header (force, title,
type, run id, generated-by, generated-at, parameters incl. jurisdiction, row count), paginated table with
repeated header, footer on every page with "Page X of Y" and the content SHA-256; capped at 5 000 rows (banner
says so; CSV has everything). Failures mark the run FAILED (audit `REPORT_FAILED`), not retried.
Scheduled reports: not implemented (could be a cron that inserts runs for a service account — design note only).

## Storage snapshots — cron `storage.snapshot` (every 15 min)
Per bucket role (tier label STAGING/ACTIVE/ARCHIVE/LONG_TERM/DERIVED/EXPORTS/REPORTS): the DB catalogue is
summed for every bucket (evidence originals by current bucket, derivatives, live exports, reports, in-flight
staging). Buckets the catalogue says hold ≤ `STORAGE_SNAPSHOT_LIST_LIMIT` (50 000) objects are also listed in
S3 (`source S3_LIST`, authoritative); larger buckets use the DB sums (`DB_SUM`) and are cross-checked by a
full listing every 24 h. Both figures are stored (`db_object_count/db_total_bytes`) so drift is visible on the
System health page. Listing counts current versions only (noncurrent WORM versions excluded). Retention: full
resolution 7 days, then one per bucket per day, deleted after 400 days.

## Tests
API: `dashboard.test.ts` (5), `alerts.test.ts` (6), `reports.test.ts` (5), `system.test.ts` (6).
Worker: `alerts.test.ts` (13), `reports.test.ts` (9), `storage.test.ts` (5). Web: `dashboard.test.ts` (3).

## Known gaps
E-mail against a real SMTP relay and webhook against a real receiver UNVERIFIED; PDF row cap
5 000; dashboard at > 50k visible rows for state-wide roles not measured; alert list `q` search is ILIKE on
title (no index).
