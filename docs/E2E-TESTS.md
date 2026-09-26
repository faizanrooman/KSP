# End-to-end browser tests (Playwright)

Real browser (Google Chrome, headless) against the **real stack of one checkout**: Fastify API, pg-boss worker,
ONNX ai-worker, React web UI, PostgreSQL, S3 (versitygw), FFmpeg. No mocks. Test media is generated with FFmpeg
per run; AI footage is built from the public-domain images the ai-worker tests cache (see AI-MODEL-LIFECYCLE.md).

## Running

```bash
source scripts/dev/env.sh && scripts/dev/services.sh start      # Postgres :5433, S3 :7480 (shared)
scripts/dev/agent-env.sh e2e 120                                 # worktree: private DBs/buckets/ports (.env)
npm ci && npm run build -w @ksp/shared -w @ksp/core
npm run db:migrate && npm run db:seed
npm run fetch-models -w @ksp/ai-worker                           # registers + activates the pinned ONNX models
tests/e2e/scripts/stack.sh start [--dev-web]                     # api/worker/ai + web (build+preview, or Vite dev)
npm run test:e2e                                                 # whole suite
npm run test:e2e -- specs/03                                     # one file (E2E_REUSE=1 keeps MFA secrets/state)
npm run typecheck:e2e
tests/e2e/scripts/stack.sh stop
node tests/e2e/scripts/axe-summary.mjs [--rules] [--markdown]    # per-page axe summary of the last run
```

* Chrome: `/opt/google/chrome/chrome` (override with `E2E_CHROME`) — no browser download needed.
* The API runs with `NODE_ENV=test` semantics against the checkout's `.env` (`KSP_ENV_FILE`). The only
  behavioural difference is relaxed rate limits (login 10/min/IP in development would throttle ~60 logins per run).
  Account lockout, the IP failed-login throttle, CSRF, MFA and every authorization rule are unchanged.
* Artifacts (never committed): `tests/e2e/artifacts/` — `results/` (traces, failure screenshots),
  `report/` (HTML report), `results.json`, `a11y/*.json` (axe per page), `responsive/*.png` (1280/768 screenshots).
* Shared state between files: `tests/e2e/.state/` (MFA secrets, run id, created ids). One worker, file order.

## Global setup (`tests/e2e/global-setup.ts`)

Checks API + web are up, then (schema-owner connection, E2E database only) resets per-run **auth fixtures**:
MFA enrolment of the four MFA-mandatory dev users (so forced enrolment is exercised every run), lockout counters,
failed login attempts from localhost, and two disposable users (`e2e.lockout`, `e2e.pwchange`). Evidence, audit and
custody data are never touched — they are append-only and simply grow with each run (names carry a run id).

## Runtime guard (every test, every browser context)

`tests/e2e/lib/guard.ts` fails a test on: uncaught page errors; `console.error`; any `/api/` response ≥ 400 or
network failure that the test did not declare with `guard.expectFailure(url, status)`; and any storage reference —
`X-Amz-`, `AWSAccessKeyId`, a configured bucket name or the S3 endpoint — in any API/HLS response body, `Location`
header, or the final DOM of each page. (It found physical bucket names in the dashboard/system-health API.)

## Specs

| File | Scenario |
|---|---|
| `00-setup` | Forced MFA enrolment via UI for admin, sup.kavya, aud.suresh, ec.latha (wrong code refused; QR; recovery codes) |
| `01-auth` | Bad password (generic message, no enumeration), lockout message, forced password change (mismatch/policy errors), TOTP wrong/right, single-use recovery code, logout, session expiry → login → return to page |
| `02-upload` | Station operator: drag-and-drop + file input, per-file metadata, progress, 3× Registered, fake `.mp4` → Quarantined, `.txt` refused client-side, upload history |
| `03-evidence` | List search/status filters/sort (aria-sort)/pagination/keyboard row open; Overview edit + tags; Playback (HLS via MSE, tokenised URLs, play/pause, exact frame step, rate, zoom, snapshot → PNG download); Integrity verify (worker) ; Lifecycle; Chain of custody + signed PDF |
| `04-ai` | FACE watchlist with reference image (embedding READY); analysis job on real ONNX worker; detections listed; review queue keyboard shortcuts (toggle off/on, A approve, J/K, R reject with reason); approved tag on evidence; face match two-person rule (0/2 → 1/2 “You already reviewed this” → second approver) |
| `05-search` | Text, `-exclusion`, tag filter, saved search; approved-AI label filter → jump-to-moment opens playback at *t* |
| `06-cases` | Register FIR, open case on it, link evidence, add member from another station (keyboard combobox), diary, timeline; member sees linked evidence; after removal → not-found page |
| `07-workspace` | Create, add 2 items, SyncPlayer, offset +200 ms persists (API + reload), play all, bookmark, region annotation (mouse drag), timeline lanes/chronology |
| `08-export` | IO requests watermarked export (no approve for own request); custodian has no export:approve (access denied); supervisor approves; worker builds; download ZIP; Verify page validates signature/hashes |
| `09-share` | Internal share to another officer (visible in “Shared with me”); external share → fresh context `/s/:token` → wrong code (attempts left) → right code → watermarked playback, `nodownload`, no download button; access log |
| `10-admin` | Create user → one-time password shown once → first login forced change → grant role → disable → login refused; roles matrix; org unit; device; settings change + restore; alerts acknowledge; report run + CSV download; system health (roles, not bucket names); dashboards |
| `11-authz` | Other-station IO: evidence URL → not-found (404, never 403), not in search; field-officer nav; direct admin URLs → access denied; unknown route → not found |
| `90-a11y` | axe-core WCAG 2.1 A/AA (+ best-practice, reported only) on ~50 page states incl. every evidence/case/workspace tab and the share portal; fails on serious/critical WCAG violations |
| `91-keyboard` | Keyboard-only: login, skip link, nav, list row, tabs (arrows), player controls/shortcuts, review queue shortcuts, dialog focus trap/restore, typing reasons does not fire shortcuts |
| `92-responsive` | 1280 px and 768 px: no horizontal page scroll on 11 main pages, menu button below 1024 px, screenshots |

## Results

See the final section of `docs/ACCESSIBILITY.md` for axe numbers; run history is recorded in
`docs/PROJECT-STATUS.md`. The development host is shared and was heavily loaded during these runs (load average
10–30, repeated PostgreSQL/Node segmentation faults — see KNOWN-ISSUES); a failure there is first re-run in
isolation before being treated as a product bug.

## Writing new specs

* Use `test`/`expect` from `../lib/fixtures`; sign in with `as('io.meera')` (UI login, TOTP handled), `anon()` for
  public pages. Declare intentional failures with `guard.expectFailure(/regex/, status)`.
* Locate by role/label (`getByRole('region', { name: 'Fixity' })` works because `Card` titles name their section).
* Wait on the product (status toasts, polling UI), not on timeouts. Use `apiGet` only to *read* state.
* Unique names: include `runId()`; never depend on data a previous run left behind.
