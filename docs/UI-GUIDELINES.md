# UI Guidelines (web)

Binding for every screen in `apps/web`. Complements `docs/CONTRACTS.md` §9 and `docs/ACCESSIBILITY.md`.
The E2E suite (`tests/e2e`, see `docs/E2E-TESTS.md`) relies on these conventions — breaking them breaks tests.

## Building blocks (`@/components/ui`)

| Need | Use | Notes |
|---|---|---|
| Labelled control | `Field` + `Input`/`Select`/`Textarea` | `Field` always associates its label: via `htmlFor`, or it gives the single child control a generated id. Hint/error are linked with `aria-describedby`; an error sets `aria-invalid`. Do not render bare `<input>` without a label. |
| Section | `Card title="…"` | A string title renders an `<h2>` and makes the card a named `region` (`getByRole('region', { name })`). |
| Page title | `PageHeader` | Exactly one `<h1>` per page. Status/empty pages that replace a page use `EmptyState heading="h1"`. |
| Dialog | `Modal` / `ConfirmDialog` | Focus moves into the dialog (child `autoFocus` wins, else the first field, else the first control), Tab is trapped, Escape closes (only the top-most of nested dialogs), focus returns to the opener, the page behind does not scroll; header and footer stay visible and only the body scrolls. Pass `onClose` freely as an inline function — it does not re-run the focus logic. Consequential actions use `ConfirmDialog` with `requireReason` when the audit trail needs a justification. |
| Tabs | `Tabs` | One Tab stop (roving tabindex); ←/→/Home/End move and activate. The panel is `role="tabpanel"`. Tabs wrap onto a second row rather than scrolling sideways (hidden tabs were undiscoverable). |
| Tables | `DataTable caption="…"` | Caption is required (screen-reader name, and how tests find the table). Clickable rows are focusable and open with Enter; keep a real link in a cell when possible. Icon-only/blank column headers use `<span className="sr-only">…</span>`. |
| Progress | `ProgressBar value={0..1}` | **Fraction, not percent.** Put the numeric percentage next to it as text. |
| Status | `StatusBadge` / `Badge` | Always text, never colour alone. |
| Feedback | `useToast()` | Success = `role=status`, error = `role=alert`. Keep messages specific (“Alert acknowledged”, not “Done”). |
| Pickers | `UserPicker`, `OrgUnitSelect` | `UserPicker` is a WAI-ARIA combobox (↓/↑, Enter, Escape). Do not put buttons inside `role="option"`; for static pick lists use a plain `<ul>` of buttons with `aria-pressed`. |

## Rules

1. **Every state**: loading (`Spinner` — its text starts with “Loading…”), error with Retry (`ErrorState`), empty (`EmptyState`), success.
2. **Keyboard**: everything reachable and operable with Tab/Enter/Space/arrows; visible focus (global `:focus-visible` ring — do not remove outlines without a replacement). Single-character shortcuts must be switchable off or only active while the owning widget has focus (WCAG 2.1.4) — see the review queue toggle and the player (shortcuts only while focus is inside it).
3. **Colour**: text ≥ 4.5:1. On white, use `text-ink-500` or darker for text (`ink-400`/`ink-300` only for decorative icons/borders). White text needs `*-700` backgrounds (e.g. the `success` button is `emerald-700`).
4. **Names**: icon-only buttons need `aria-label`; labelled `div`s need a role (`role="group"`, `role="img"`), otherwise `aria-label` is ignored (axe: aria-prohibited-attr). Keep button text visible or `sr-only` at small widths (never `hidden`).
5. **Landmarks**: the shell provides `nav[aria-label=Main]`, `header`, `main#main` (skip-link target). Stand-alone screens (login, share portal) render their own `<main>`.
6. **Overlays inside the player** inherit `pointer-events: none`; an interactive overlay must set `pointer-events-auto` itself.
7. **Data freshness**: after a mutation, invalidate every query that shows the changed data (including queries in sibling components — e.g. AI detections when a job finishes).
8. **Never** render storage URLs, bucket names or presigned links; media uses API URLs with short-lived `?t=` tokens. The E2E guard fails any test that sees `X-Amz-`, a bucket name or the S3 endpoint in a response or the DOM.
9. **Layout**: must not scroll horizontally at 768 px (tablet) or 1280 px; wide tables scroll inside their card (`overflow-x-auto`). The sidebar collapses behind “Open menu” below 1024 px. Flex/grid columns holding user text use `min-w-0` / `minmax(0,1fr)`; titles and file names that may lack spaces use `[overflow-wrap:anywhere]` (body has `overflow-wrap: break-word`). Inputs use `font-mono`, not `.mono` (which also forces 12 px). Audit tooling: `tests/e2e/audit/` (docs/UI-AUDIT-A.md).
10. **Test hooks**: prefer roles/labels (what users perceive). `data-testid` only for values without a natural accessible name (e.g. `mfa-secret`, `rq-current`).

## Brand assets

`apps/web/public/brand/` holds the Karnataka State Police emblem (`ksp-emblem.png`, official insignia — see the
README there for the usage notice) and five WebP photographs from Wikimedia Commons (CC BY-SA 4.0 / CC BY 3.0 / CC0,
attributed in `public/brand/README.md` and in the sign-in page footer). Where they are used: sign-in page hero
(desktop) and faint backdrop (mobile), the sidebar and share-portal headers (emblem), and the dashboard welcome banner.
Photographs are decorative (`alt=""`); all headings stay in the form/content column so heading order is unchanged;
text over photographs sits on a brand-950 gradient to keep WCAG AA contrast. Do not add new third-party images without
recording their licence in that README.
