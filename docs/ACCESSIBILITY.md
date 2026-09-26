# Accessibility

Target: **WCAG 2.1 Level AA**. This document records what was *tested* and what is still open. It is an internal,
automated + scripted assessment — **not** a conformance certification or an audit with assistive-technology users.

## How it is tested

| Check | Where | Scope |
|---|---|---|
| axe-core 4.x (`@axe-core/playwright`), rules tagged `wcag2a, wcag2aa, wcag21a, wcag21aa` **+ best-practice** | `tests/e2e/specs/90-a11y.spec.ts` | 64 page states per run (login, share portal, dashboards for 3 roles, evidence list, evidence detail + all 9 tabs, full-page player, upload, upload history, search, cases, case detail + 6 tabs, FIRs, workspaces, workspace detail + 6 tabs, exports list/new/verify/detail, shares list/detail, notifications, profile, review queue, quarantine, disposal approvals, alerts, alert rules, reports, system health, users, user new/detail, roles, role detail, org units, devices, settings, integrations, API clients, AI models, retention policies, watchlists, audit log, ledger, access-denied page), with real data created earlier in the run. Serious/critical **WCAG** violations fail the test; best-practice results are reported. |
| Keyboard-only walkthrough (no pointer) | `91-keyboard.spec.ts` | Login (autofocus, Tab, Enter, TOTP), skip link → `main`, sidebar nav, evidence search + row (Enter), tabs (roving tabindex, arrows), player (Play button, `k`, `←/→` frame step, `]` rate, `+`/`0` zoom, `?` help + Escape), review queue (`j/k`, `h` history dialog with focus trap, `r` reason dialog focus). Every stop asserts a visible focus indicator. |
| Keyboard parts of feature specs | `03`, `04`, `06`, `09`, `10` | Evidence rows open with Enter; review shortcuts; user picker combobox (↓, Enter, focus kept on “Change”); reason dialogs focus their textarea. |
| Responsive | `92-responsive.spec.ts` | 1280 × 1000 and 768 × 1000: no horizontal page scroll on 11 main pages; below 1024 px the sidebar is behind “Open menu” (aria-expanded) and closes after navigation. Screenshots in `tests/e2e/artifacts/responsive/`. |
| Component regression tests | `apps/web/src/components/ui/ui.test.tsx` | Modal focus rules, Field label/description association, named regions, headings, ProgressBar semantics. |

Browser: Google Chrome (headless) only.

## axe results — before / after

**Before** = first crawl on the unmodified UI (WCAG rules only; most list pages were still empty at that point) plus
violations that appeared once pages had data. **After** = final runs (two consecutive full runs, both identical).

| Page | Before | After |
|---|---|---|
| Evidence list | serious `aria-prohibited-attr` (labelled `div` thumbnail without role) | 0 |
| Search | serious `color-contrast` (`text-ink-400` metadata/“Updating…”) | 0 |
| Quarantine | serious `color-contrast` (white on `emerald-600` “success” buttons, 3.8:1) | 0 |
| Workspace — Review & annotate | serious `color-contrast` (white text on region-label colour) | 0 |
| Workspace — Compare | moderate (bp) `landmark-unique` (two players both “Evidence video player”) | 0 |
| Login (and the forced password / MFA screens) | moderate (bp) `landmark-one-main`, `region` ×5 (no `<main>`) | 0 |
| Profile | minor (bp) `empty-table-header` | 0 |
| Access denied / not-found pages | moderate (bp) `page-has-heading-one` | 0 |
| All other 56 page states | 0 | 0 |
| **Total** | **4 serious, 4 moderate/minor rule groups** | **0 violations (WCAG and best-practice) on 64 page states** |

Reproduce: `npm run test:e2e -- specs/90` then `node tests/e2e/scripts/axe-summary.mjs --markdown`.

## Fixes made (beyond what axe reports)

Found by the keyboard walkthrough and scenario specs — axe cannot see these:

* **Dialog focus** (`Modal`): focus went to the Close button even when a field had `autoFocus`. Typing a rejection
  reason in the review queue therefore pressed *Close* (Space) and then fired the page's single-key shortcuts —
  a stray “a” **approved a detection**. Now: child autoFocus wins, else first field, else first control.
* **WCAG 2.1.4 character key shortcuts**: review-queue shortcuts are global single keys; added an on/off switch
  (remembered) and a polite live region announcing the current item (“Item 2 of 12: Person detection person, 87% …”).
  Player shortcuts are only active while focus is inside the player (compliant).
* **User picker** (case team, shares, reports, workspace members): not operable by keyboard (Tab closed the list on
  blur; options were buttons inside `role=option`). Now a WAI-ARIA combobox: ↓/↑ with `aria-activedescendant`,
  Enter, Escape; focus moves to “Change” after picking; the highlight survives late (debounced) results.
* **Tabs**: every tab was a Tab stop and arrows did nothing; now roving tabindex with ←/→/Home/End.
* **Skip link**: target `main` is focusable (`tabIndex=-1`), so focus actually moves.
* **Labels**: `Field` now always associates its label (generated id when the control has none) and links
  hint/error via `aria-describedby`, `aria-invalid` on error; e.g. the reason fields of every `ConfirmDialog`
  were unlabeled before. Card sections are named regions (`aria-labelledby` their heading).
* **Invalid ARIA**: `role=listbox/option` wrapping buttons (FIR/case pickers) removed; labelled `div`s given
  `role=group`/`img`.
* **Narrow screens**: header “Sign out”/profile text was `hidden` below 640 px (buttons lost their names) — now `sr-only`.
* **Progress**: the AI job progress bar received a percentage instead of a fraction, so `aria-valuenow` was always 100.
* **Contrast**: `text-ink-400` text (≈2.9:1) → `ink-500` across the app; placeholder colour; success button `emerald-700`.

## Remaining issues (open)

| Issue | WCAG | Notes |
|---|---|---|
| Region annotations can only be drawn with a pointer (drag on the frame) | 2.1.1 Keyboard | Bookmarks, notes and highlights are keyboard-operable; a numeric/arrow-key region editor is needed. |
| Timeline lanes (workspace) are a pointer position → time mapping; keyboard users have ←/→ on the lane but no announcement of the time under the cursor | 2.1.1 / 4.1.2 | Chronology list offers the same “Open” actions by keyboard. |
| Seek-bar hover previews (thumbnails) are pointer-only | — (supplementary) | Seek slider itself is keyboard operable with `aria-valuetext`. |
| Charts (dashboard) rely on text summaries for non-visual users; no data-table alternative per chart | 1.1.1 | Summaries exist; a “view as table” toggle would be better. |
| Share-portal `<video>` uses native controls; captions track is empty (no captions exist for evidence audio) | 1.2.2 | Evidence footage has no captions by nature; transcripts are out of scope. |
| Review cards: every checkbox is labelled “Select” | 2.4.6 | Context is given by the card, but unique names (e.g. “Select person at 00:04”) would be clearer. |
| Evidence list rows are clickable `tr` elements (focusable, Enter) rather than links | 4.1.2 | Works with keyboard; screen readers announce a row, not a link. |
| Toasts disappear after 4–8 s | 2.2.1 | Errors stay 8 s and every outcome is also visible on the page; a “pause on hover/focus” would help. |
| Language of Kannada content is not marked (`lang`) | 3.1.2 | UI is English; user-entered Kannada text is not tagged. |

## UNVERIFIED

* Screen readers (NVDA, JAWS, VoiceOver, TalkBack) — never run; ARIA semantics were checked with axe and
  Playwright's accessibility tree only.
* Firefox, Safari, Edge and mobile browsers; Windows High-Contrast / forced-colours mode; 200 %/400 % zoom and
  text-spacing overrides (1.4.4, 1.4.10, 1.4.12); reduced-motion preferences; speech input.
* Testing with disabled users. Automated tools find only part of WCAG failures.
