# UI/UX audit A — dashboard, evidence, upload, search, workspaces, AI, profile

Scope: Dashboard, Evidence list + detail (all 9 tabs, all header actions), full-page player, Upload, Upload history,
Quarantine, Search (filters, facets, saved searches), Workspaces list + workspace (6 tabs), AI review queue, AI models,
Watchlists, Notifications, My profile — plus the shared shell and `@/components/ui` primitives they use.
Audit B covers the remaining screens (see `docs/UI-AUDIT-B.md` if present).

## Method

Real stack of one checkout (API, worker, ai-worker, `vite build` + `vite preview`, PostgreSQL, S3), populated by one
full E2E run plus three extra uploads (1280×720 clip with a 90-character file name, 720×1280 portrait clip with a
Kannada file name, 3-minute clip). Google Chrome (headless) through Playwright.

| Tool (kept as a regression aid, not part of `npm run test:e2e`) | What it does |
|---|---|
| `tests/e2e/audit/crawl.audit.ts` | 32 page states × 4 viewports (1920×1080, 1366×768, 1024×768, 768×1024): full-page + scrolled-bottom screenshots, generic checks (horizontal page scroll, content escaping the viewport, truncated text without a tooltip, text overflowing its box, unnamed controls, links to routes that do not exist, sidebar/header stay pinned when scrolled), console errors, failed API requests. |
| `tests/e2e/audit/interact.audit.ts` | Evidence-detail dialogs (open, body scroll lock, Esc / backdrop / Close, focus return), tab URL state across reload, tabs visible at 1024 px, list pagination + browser back/forward, notification popover, full-page player fits 3 viewports, 768 px drawer (open, scroll, Esc, lock), new-workspace dialog validation, upload with long/Kannada names, per-file Details dialog (focus while typing, fits viewport), throttled upload pause → resume → cancel → registered. |
| `tests/e2e/audit/interact-b.audit.ts` | Search advanced filters (invalid input, clear, toggle), Save search with Enter + reopening a saved search, review queue at 768 px + History dialog, legal-hold reason validation (custodian), New watchlist validation, AI model Edit dialog at 1024 px. |
| `tests/e2e/audit/debug.audit.ts` | Probe: lists the elements sticking out of the viewport on one page (found UXA-09). |

```bash
npx playwright test -c tests/e2e/audit/audit.config.ts crawl      # AUDIT_SUITE=name AUDIT_ONLY=regex AUDIT_VP=1366,768
npx playwright test -c tests/e2e/audit/audit.config.ts interact   # both interaction files
```

Output (not committed): `.local/ui-audit/<suite>/` — `*.png`, `findings.json`, `interact.json`, `interact-b.json`.
Screenshots referenced below: `before/` = unmodified UI, `after1/` = interaction run on the unmodified build
(the first `interact` run in `before/`), `after/`, `after2/` = fixed UI.

Result: crawl findings **36 → 0** (28 of the 36 were noise of the first version of the checks — the pre-sign-in session probe and a sidebar check that ran on the hidden desktop sidebar at 768 px — since fixed; the 8 real ones are UXA-09 and UXA-17);
interaction checks: **12 of 22 failing** on the unmodified UI (2 of those were faults in the checks themselves, since corrected) → **all passing** after the fixes (see the final numbers in the last section).

## Findings

Severity: **High** = feature broken or data entered wrongly · **Medium** = clearly visible defect / blocks a task at
some viewport · **Low** = polish.

| ID | Screen | Viewport | Sev. | Issue | Screenshot | Status |
|---|---|---|---|---|---|---|
| UXA-01 | Upload → Details dialog (every `Modal` whose form state lives in the parent) | all | High | After the first keystroke in any field but the first, focus jumped back to the first field, so the rest of the text went into **Title** (the audit upload literally got the title “ATROL” and category “P”). Cause: the focus effect depended on the inline `onClose`, re-ran on every parent render and re-focused the first field. | `before/interact.json`, `after/search-results-768-full.png` (item 000006 “ATROL”) | Fixed — `onClose` kept in a ref, effect runs on open only. Component test + `94-ux-audit-a` |
| UXA-02 | All dialogs | all | Medium | No body scroll lock: the wheel over the backdrop scrolled the page behind (434 px on evidence detail). | `before/dialog-*.png` | Fixed — `Modal` locks `body` (stacked, restored on last close); `overscroll-contain`. Tests |
| UXA-03 | Dialogs with an `autoFocus` child (Link to case, Save search, New workspace …) | all | Medium | Focus was not returned to the opener on close (focus fell to `body`): the opener was read after the child had already taken focus. | — | Fixed — opener captured during render. Tests |
| UXA-04 | Nested dialogs | all | Low | Escape closed every open dialog at once and Tab trapping ran in all of them. | — | Fixed — only the top-most dialog reacts. Component test |
| UXA-05 | Evidence detail tabs | ≤1024 | Medium | 9 tabs in a sideways-scrolling strip without a cue: Chain of custody, Integrity, Lifecycle invisible at 1024/768 px (also when opened from a URL). | `before/evidence-integrity-1024-full.png` → `after/evidence-overview-1024-full.png` | Fixed — `Tabs` wrap (shared). Tests |
| UXA-06 | Full-page player | 1366×768, 1920×1080 | Medium | Play/transport controls below the fold on the “full-page” player (page 875 px tall at 768). | `before/player-1366-full.png` → `after2/player-1366.png` | Fixed — stage height `calc(100vh − 18.5rem)` (min 15rem). Tests |
| UXA-07 | Everywhere `titleCase` is used (custody events, tag sources, AI tasks) | all | Low | Acronyms mangled: “Ai Results Viewed”, “(Ai Approved)”, “Anpr”. | `before/evidence-custody-1366-full.png` | Fixed — acronyms kept (AI, ANPR, FIR, HLS, GPS, PDF, CCTNS, …). Component test |
| UXA-08 | Mobile drawer (shell) | <1024 | Medium | Escape did not close it, the page behind scrolled, focus did not move into the drawer or back to the menu button, and it stayed open when the window grew to desktop width. | — | Fixed (`AppShell`). Tests |
| UXA-09 | AI models (and any `DataTable` with an `sr-only` header) | 1024, 768 | Medium | Whole page scrolled sideways (1224 px at 1024): the absolutely positioned `sr-only` “Actions” header escaped the non-positioned table scroller. | `before/ai-models-1024-full.png` | Fixed — table scroller is `relative` (shared). Tests |
| UXA-10 | Evidence list | 1366 | Medium | Table 175 px wider than its card at 1366: last column (Received) hidden behind a sideways scroll; officer names wrapped to 4 lines. | `before/evidence-list-1366-full.png` → `after2/evidence-list-1366.png` | Fixed — Tier folded into the Status cell, column minimums tuned, long titles wrap. Interaction check |
| UXA-11 | Search results (and every flex/grid page) | 1024 | Medium | A 90-character file name without spaces widened the results column and the page (scrollWidth 1113 at 1024). | `after/` crawl (first pass) | Fixed — `minmax(0,1fr)` columns, `overflow-wrap:anywhere` on titles, global `body { overflow-wrap: break-word }` safety net |
| UXA-12 | Evidence detail header | all | Low | The page `<h1>` (evidence number) rendered at 12 px (`.mono` forces `text-xs`) — smaller than its subtitle. Header actions mixed two button sizes. | `before/evidence-overview-1366-full.png` → `after/evidence-overview-1920-full.png` | Fixed — `font-mono` keeps heading size; all actions `size="sm"` |
| UXA-13 | Evidence header, hashes | ≤1366 | Low | “Copy SHA-512” wrapped onto two lines. `CopyButton` threw an unhandled rejection when the clipboard is unavailable. | `before/evidence-integrity-1024-full.png` | Fixed (shared `CopyButton`) |
| UXA-14 | Evidence detail / search result | all | Low | “recorded —” / “· recorded — · —” when the recording time is unknown. | `before/search-results-1366-full.png` | Fixed — “recording time unknown”; empty duration omitted |
| UXA-15 | Search → Filters | all | Medium | Validation message appeared next to “Apply filters”, far below the offending field (e.g. FIR number), which was neither marked nor focused. | `after/search-filters-invalid.png` | Fixed — field gets the error (`aria-invalid`) and focus. Tests |
| UXA-16 | Search → Save search | all | Low | Enter in the name field did nothing (no form). | — | Fixed — Enter saves. Interaction check |
| UXA-17 | Search facets | ≥1024 | Low | Long facet values truncated without a tooltip. | crawl `truncated-no-title` | Fixed — `title` |
| UXA-18 | Search | 768 | Low | Five facet cards stacked full-width pushed results ~1050 px down. | `before/search-results-768-full.png` → `after/search-results-768-full.png` | Fixed — facets in two columns below 1024 px |
| UXA-19 | Dashboard | ≥1280 | Low | Fixed 3-column row left an empty third column when the role has no storage card. | `before/dashboard-1366-full.png` → `after/dashboard-1366-bottom.png` | Fixed — column count follows visible cards |
| UXA-20 | Workspaces list | all | Low | Filters and table floated on the page background (no card, unlike every other list); the table showed “No workspaces” while loading (rows defaulted to `[]`). | `before/workspaces-1366-full.png` | Fixed |
| UXA-21 | Workspace → Compare (SyncPlayer) | 1366 | Low | Offset controls wrapped mid-group (“+1f +100ms” on a second line, value separated from its buttons). Labels were then truncated to an identical prefix (“KSP-PSC…”). | `before/workspace-compare-1366-full.png` → `after/workspace-compare-1366-full.png` | Fixed — label/time and the offset group wrap as units; label wraps instead of truncating |
| UXA-22 | Workspace → Timeline | 1024 | Low | Lane labels truncated to the same “KSP-PSCUBBONPARK-2026…” prefix for every lane; chronology timestamps wrapped (“10:15 pm / IST”). | `before/workspace-timeline-1024-full.png` | Fixed — wider label column, wider time column |
| UXA-23 | Upload history | 1024 | Low | Station wrapped to 4 lines, evidence numbers broken over 3 lines, file names broke at every character. | `before/upload-history-1024-full.png` → `after/upload-history-1024-full.png` | Fixed — column minimums, evidence number `nowrap`, names wrap only when needed |
| UXA-24 | Bookmarks & annotations, Snapshots, Watchlist plate | all | Low | Time/plate inputs used `.mono` (12 px) and were shorter than the inputs beside them (misaligned row). | `before/evidence-notes-1024-full.png` | Fixed — `font-mono` |
| UXA-25 | My profile → sessions | 1366 | Low | Raw user-agent strings as device names; “This session” badge and dates wrapped. | `before/profile-1366-full.png` | Fixed — “Chrome on Linux” (full string as tooltip), `nowrap`; `StatusBadge` never wraps (shared) |
| UXA-26 | AI analysis tab | — | Low | Lint warning: detections array recreated every render (memo dependency). | — | Fixed |
| UXA-27 | Upload | 1366×768 | Low | The drop zone (“3. Files”) starts below the fold: the optional “Default details” card (9 fields) comes first. | `before/upload-1366-full.png` | **Deferred** — the order is deliberate (defaults apply to files as they are added; “Apply to all” exists for later changes) and the E2E flow depends on it; a collapsible defaults card is a product decision |
| UXA-28 | AI review queue cards | ≤1366 | Low | Six actions per card wrap; “History” sits alone on a second row. | `before/review-queue-1366-full.png` | **Deferred** — cosmetic; shortcuts (`h`) cover it; needs a design decision (overflow menu) |
| UXA-29 | Date/time inputs | all | Low | Native pickers show `mm/dd/yyyy` (browser locale), not the app's Indian format. | `before/evidence-list-1366-full.png` | **Deferred** — browser-controlled; a custom date picker is out of scope |
| UXA-30 | Dashboard KPI tiles | ≥1280 | Low | 11 tiles in a 6-column grid leave one empty slot. | `before/dashboard-1366-full.png` | **Deferred** — cosmetic; the count varies by role |
| UXA-31 | Evidence → Playback tab, workspace Review | 1366×768 | Low | With the page header above it the in-page player's control bar needs a short scroll; at mid widths the control bar wraps to two rows. | `before/evidence-playback-1366-full.png` | **Deferred** — “Open full-page player” (UXA-06, fixed) is the viewport-fitting view |
| UXA-32 | Lifecycle tab | all | Low | Empty states inconsistent (plain sentence for legal holds vs. large `EmptyState` for disposal requests). | `before/evidence-lifecycle-1366-full.png` | **Deferred** — cosmetic |

No dead links, unnamed controls, console errors or failed API requests were found on these screens at any viewport
(the only 401s are the expected session probe before sign-in).

## Shared components changed

`components/ui/index.tsx` — `Modal` (UXA-01…04), `Tabs` (wrap, UXA-05), `DataTable` (`relative` scroller, UXA-09),
`CopyButton` (UXA-13), `StatusBadge` (`nowrap`). `components/AppShell.tsx` — drawer (UXA-08). `lib/format.ts` —
`titleCase` (UXA-07). `index.css` — `body { overflow-wrap: break-word }` (UXA-11).

## Regression tests

* `apps/web/src/components/ui/modal.test.tsx` — UXA-01, 02, 03, 04, 07.
* `tests/e2e/specs/94-ux-audit-a.spec.ts` — UXA-01, 02, 03, 05, 06, 08, 09, 15 against the real stack.
* The audit scripts above (manual, screenshot-producing).
