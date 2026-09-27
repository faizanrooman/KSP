# UI/UX audit B — auth, shell, cases, sharing, export, compliance, administration

Scope: login / forced password change / MFA enrolment + verify / recovery code; app shell (header, notification
bell, sign out, sidebar at every width incl. the off-canvas menu); cases, FIRs, CCTNS import; court exports
(wizard, lists, approval, detail, verify); shares (dialog, list, detail, manage actions) and the public share portal
`/s/:token`; audit log, ledger; reports + schedules; alerts, alert rules, notifications; system health;
administration (users, roles, org units, devices, settings, integrations, API clients, retention, disposals).
Evidence/upload/search/workspace/AI/profile screens are covered by audit A.

Method: the E2E suite was run once against this checkout's stack to populate data, plus ~40 users (Kannada and very
long names/e-mails), 32 cases (long and Kannada titles, long unbroken descriptions), 35 alerts and 45 notifications
inserted into the dev database. `tests/e2e/audit/b-crawl.ts` screenshotted every page (full page) at
1920×1080, 1366×768, 1024×768 and 768×1024 as admin, sup.kavya and aud.suresh (plus 390 px for public pages) and
measured horizontal overflow, console errors and failed requests; `b-explore.ts` opened every dialog / dropdown and
recorded its geometry and the body scroll state; `b-probe.ts` ran ad-hoc DOM probes. Screenshots are under
`.local/ui-audit-b/{before,after,explore,anon}/<width>/` (not committed) and
`tests/e2e/artifacts/ui-audit-b/` (portal, written by spec 93).

Severity: **High** = broken behaviour / data loss; **Medium** = clearly wrong layout or misleading UI;
**Low** = polish / consistency.

| ID | Screen | Viewport | Sev | Finding | Evidence | Status |
|---|---|---|---|---|---|---|
| UI-B-01 | Every Modal whose parent owns the form state (Change case status, Extend share, Re-issue link, …) | all | High | Typing into any field but the first jumped focus to the first field after one character: the focus effect depended on `onClose`, callers pass inline arrows, so each keystroke re-ran it (restore focus to the opener, then focus the first field). | unit test `ui.test.tsx` "keeps focus in the field being typed into…" (failed before) | Fixed (`onClose` kept in a ref) |
| UI-B-02 | Reports, API clients (any DataTable with an sr-only header) | ≤1024 | Medium | Page scrolled horizontally by 80–104 px: the absolutely positioned sr-only "Actions" header was positioned against the page, not the table scroller. | `before/1024/reports.png`, `before/768/api-clients.png` | Fixed (scroller is `relative`) |
| UI-B-03 | Off-canvas menu | <1024 | Medium | No Esc, no close control inside the panel (the header X was under the overlay), page behind kept scrolling, focus stayed on the page, no dialog semantics. | explore `768/x-menu.png` | Fixed |
| UI-B-04 | All dialogs | all | Medium | The page behind a dialog scrolled with the wheel/touch; Esc closed every stacked dialog at once. | explore geometry log (`bodyOverflow`) | Fixed (ref-counted body scroll lock; only the top-most dialog handles Esc) |
| UI-B-05 | Diary, timeline, detail values, notifications | all | Low | Long unbroken strings (pasted text, e-mails, hashes) overflowed their boxes. | seeded long descriptions | Fixed (global `overflow-wrap: break-word`) |
| UI-B-06 | Settings | all | Low | Switches interleaved with number inputs left ragged gaps (orphan "Require a symbol", floating "E-mail alert managers"). | `before/1366/settings.png` → `after/1366/settings.png` | Fixed (switches grouped per card) |
| UI-B-07 | Settings | all | High | Saving one group replaced the whole settings query data, which reset every other group's form — unsaved edits elsewhere were silently discarded. | spec 93 "UI-B-07" | Fixed (re-sync on the group's own saved JSON) |
| UI-B-08 | Every dialog opened from a page | all | Medium | A 16 px strip at the top of the screen was not covered by the backdrop: the fixed overlay was rendered inside `space-y-*` containers and inherited the sibling margin. | explore `1366/x-new-case-fir.png`, probe (overlay rect top = 16) | Fixed (Modal portalled to `<body>`; unit test) |
| UI-B-09 | Roles → role detail | all | Low | Save button only at the very end of a ~2000 px permission matrix; checkbox squares shrank next to long labels (misaligned column). | `before/1366/role-detail.png` | Fixed (sticky save bar with "Unsaved changes"; Checkbox `shrink-0`) |
| UI-B-10 | New user | all | Medium | Role rows with no role/unit selected were dropped silently on submit (user created without the intended role). | code review | Fixed (submit blocked with a hint) |
| UI-B-11 | Integrations, audit log, many badges/selects | all | Low | `titleCase` mangled acronyms: "Cctns", "Mfa Challenge Passed", "Ai Results Viewed", "Fir Import". | `explore/1366/x-integration-new.png` | Fixed (acronym list; unit test) |
| UI-B-12 | System health | all | Low | "Slowest routes" chart clipped the route labels (fixed 120 px category axis). | `explore/768/x-health.png` | Fixed (axis sized to labels, ellipsis for very long ones) |
| UI-B-13 | Alerts (and Workspaces) | all | High | Choosing "Any" status was impossible: `useUrlState` dropped `''` from the URL and the non-empty default (OPEN) came straight back. | unit test `hooks.test.tsx` | Fixed |
| UI-B-14 | Share portal, locked share | 390+ | Low | Message read "…locked; contact the sender Contact the officer who shared it with you." | `tests/e2e/artifacts/ui-audit-b/390-locked.png` | Fixed (unit + spec 93) |
| UI-B-15 | Share portal (public), login | all | Medium | Every signed-out load made two concurrent `/auth/me` calls plus a refresh (3 console errors); on the public portal an external recipient's browser probed the staff session. | probe (resource timing) | Fixed (no probe on `/s/*`; concurrent probes deduplicated; spec 93 asserts no `/auth/` call) |
| UI-B-16 | Shares, Court exports | all | Low | Search issued one request per keystroke (and replaced the URL each time). | spec 93 | Fixed (300 ms debounce) |
| UI-B-17 | FIRs | all | Medium | Typing a year sent `year=2`, `20`, `202` before `2026` (partial years). | code review | Fixed (only 4-digit years are sent) |
| UI-B-18 | Case, export, device, FIR detail | all | Low | The `mono` utility (text-xs) inside `<h1>` shrank case/export/FIR numbers to 12 px in the page title. | `before/1366/export-detail.png` | Fixed (`font-mono`) |
| UI-B-19 | Shared: PageHeader, Card, Badge | all | Low | Long page titles were truncated with no way to read them; card header actions could overflow; status badges wrapped onto two lines ("Under / Investigation"). | `before/1366/cases.png` | Fixed (titles wrap, headers wrap, badges `nowrap`) |
| UI-B-20 | Cases list | all | Low | Very long case titles made rows 5 lines tall. | `before/1366/cases.png` | Fixed (2-line clamp with `title`) |
| UI-B-21 | Shares / Court exports lists | all | Low | Pagination wrapped in an extra bordered/padded box (double border, misaligned with other lists). | code review | Fixed |
| UI-B-22 | API clients | all | Low | Status shown as raw "REVOKED" red badge instead of the shared StatusBadge ("Revoked"). | `before/768/api-clients.png` | Fixed |
| UI-B-23 | Share detail access log | ≤1024 | Low | Evidence numbers broke at hyphens; user agent column unbounded. | `before/768/share-ext.png` | Fixed |
| UI-B-24 | Share extend / re-issue / create | all | Low | Required reason/purpose disabled the button with no hint of the 5-character minimum. | explore `x-share-reissue.png` | Fixed (hint text) |
| UI-B-25 | Login (MFA step) | all | Low | Switching between authenticator/recovery code or going Back kept the typed code and a stale error; long manual MFA key could overflow the card. | code review | Fixed |
| UI-B-26 | Notification bell | <360 | Low | Popover fixed at 20 rem could overflow narrow screens. | code review | Fixed (`max-w-[calc(100vw-2rem)]`) |
| UI-B-27 | Alerts, alert rules | all | Low | Raw upper-case options/badges (OPEN, CRITICAL); rule-card Save left-aligned unlike every other form. | explore `768/x-alert-rules.png` | Fixed |
| UI-B-28 | Org units | all | Low | "1 users · 1 devices". | `after/1366/org.png` | Fixed |
| UI-B-29 | Verify package | all | Low | Unstyled native file inputs; a previous result stayed on screen after choosing another file. | `after/768/export-verify.png` | Fixed |
| UI-B-30 | Worker `share.watermark` (dashboard alerts "SHARE_WATERMARK failed for …") | — | High | Real bug, see below. | `processing_jobs` on the main dev DB | Fixed + regression test |

## Checked and left as is (with reason)

* Sidebar at 1366×768: the nav list is its own scroll container and the aside stays pinned while the page scrolls
  (probed: list `scrollHeight 888 > clientHeight 645`, aside `top 0` with the page scrolled 1630 px). The last item
  is partly hidden until the list is scrolled — standard behaviour, kept.
* Wide tables (users, sessions, access log, cases) scroll horizontally *inside* their card at 768 px; the page itself
  never scrolls sideways (crawl: `hscroll=0` on every page after the fixes).
* `useUrlState` replaces history entries (filters/tabs/pagination); Back leaves the page rather than stepping through
  filter states. This is the documented design ("shareable, survives reload"), reload keeps the state.
* Forms that disable the submit button until valid (New user, New case, Register FIR) rely on hints next to the
  fields instead of post-submit validation messages; that is the convention across the app and is kept. Server-side
  validation errors are shown in an Alert under the form.
* Login page: one `/auth/me` + one `/auth/refresh` 401 on a signed-out load is inherent to silent session
  restoration and is kept (logged by the browser as failed resources, not by the app).
* Admin has no audit-log access (separation of duties): `/compliance/audit` shows Access denied for admin, correct.

## SHARE_WATERMARK failures — root cause

The dashboard alerts came from `processing_jobs` rows of kind `SHARE_WATERMARK` with status FAILED. On the main dev
database every failure had a COMPLETED twin for the same (share, evidence) created ~10 ms earlier, and the errors
were `ENOENT … share-wm-<share>-<evidence>/watermarked.mp4` or FFmpeg `Conversion failed!`.

* The share portal enqueues `share.watermark` on every playback, stream and print request, with
  `singletonKey: "<share>:<evidence>"`. The queue uses pg-boss' default `standard` policy, where `singletonKey`
  without `singletonSeconds` does **not** deduplicate — so the first playback polls produced several jobs.
* The worker runs this queue with `localConcurrency` 2, and both jobs wrote into the same deterministic work
  directory. The first to finish uploaded the variant and removed the directory in `finally`; the other one lost its
  output file mid-encode → FAILED → `PROCESSING_FAILED` alert. It was never related to revoke/expiry (those are
  already an idempotent `SKIPPED` without a tracker row) or to missing proxies (also `SKIPPED`).

Fix (`apps/worker/src/jobs/shares/index.ts`): the job takes a session advisory lock on
`share-wm:<share>:<evidence>` on a dedicated connection (same pattern as media processing). A job that finds the
lock taken returns `SKIPPED: already in progress` without creating a processing-job row; the next one finds the
variant and returns `EXISTS`. Each run also uses its own work directory. Regression test
(`apps/worker/test/exports.test.ts`): three concurrent runs for one share item → exactly one CREATED, none FAILED, a
later run returns EXISTS. Verified that the test fails on the old code (three full concurrent burns, `CREATED` ×3;
whether the loser then hits ENOENT depends on timing — on the main dev DB it did, in the test run it did not).
Existing FAILED rows/alerts in other databases are history; they can be resolved from the Alerts page.

## Regression coverage added

* `tests/e2e/specs/93-ui-audit-b.spec.ts`: typing into a later dialog field keeps focus, body scroll locked while a
  dialog is open and restored after Esc (UI-B-01/04); no horizontal page scroll at 1024 px on Reports / API clients /
  Users (UI-B-02); off-canvas menu Esc + focus return + close button (UI-B-03); saving one settings group keeps
  another group's unsaved edit (UI-B-07); shares/exports search not per keystroke (UI-B-16); share portal lockout
  message, viewer at 390 and 768 px without horizontal scroll, no `/auth/` request on the portal (UI-B-14/15).
* Component tests: `components/ui/ui.test.tsx` (focus while typing, scroll lock, portal), `lib/hooks.test.tsx`
  (explicit empty filter), `lib/format.test.ts` (acronyms), `modules/sharing/sharing.test.ts` (lockout text).
* Worker: `apps/worker/test/exports.test.ts` (concurrent watermark jobs).
