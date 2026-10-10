---
name: KSP Video Evidence Management
description: Sealed, labelled and accountable. An evidence room for body-worn-camera footage, built for the station desk.
colors:
  brand-950: "#0f1b45"
  brand-900: "#1e338a"
  brand-800: "#1e35af"
  brand-700: "#1d3ed8"
  brand-600: "#2550eb"
  brand-500: "#3b6cf6"
  brand-200: "#bfd3fe"
  brand-100: "#dbe6fe"
  brand-50: "#eef4ff"
  ink-950: "#0c0f14"
  ink-900: "#161a22"
  ink-800: "#262b36"
  ink-700: "#3d4453"
  ink-600: "#4f586a"
  ink-500: "#687285"
  ink-300: "#c2c8d3"
  ink-200: "#dde1e8"
  ink-100: "#eef0f4"
  ink-50: "#f7f8fa"
  white: "#ffffff"
  danger: "#dc2626"
  danger-deep: "#b91c1c"
  success: "#047857"
  warning-text: "#92400e"
  warning-icon: "#b87900"
  chart-blue: "#2a78d6"
  chart-orange: "#eb6834"
  chart-aqua: "#1baf7a"
  status-good: "#0ca30c"
  status-warning: "#fab219"
  status-serious: "#ec835a"
  status-critical: "#d03b3b"
  chart-grid: "#e5e4e0"
  chart-axis: "#52514e"
  chart-label: "#0b0b0b"
  annotation-red: "#ef4444"
  annotation-amber: "#f59e0b"
  annotation-green: "#10b981"
  annotation-blue: "#3b82f6"
  annotation-violet: "#a855f7"
typography:
  headline:
    fontFamily: "Noto Sans Variable, Noto Sans Kannada Variable, Segoe UI, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.4
  title:
    fontFamily: "Noto Sans Variable, Noto Sans Kannada Variable, Segoe UI, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.5
  stat:
    fontFamily: "Noto Sans Variable, Noto Sans Kannada Variable, Segoe UI, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.33
  body:
    fontFamily: "Noto Sans Variable, Noto Sans Kannada Variable, Segoe UI, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  label:
    fontFamily: "Noto Sans Variable, Noto Sans Kannada Variable, Segoe UI, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.33
    letterSpacing: "0.025em"
  caption:
    fontFamily: "Noto Sans Variable, Noto Sans Kannada Variable, Segoe UI, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 600
    lineHeight: 1.45
    letterSpacing: "0.05em"
  micro:
    fontFamily: "Noto Sans Variable, Noto Sans Kannada Variable, Segoe UI, system-ui, sans-serif"
    fontSize: "0.625rem"
    fontWeight: 500
    lineHeight: 1.4
  mono:
    fontFamily: "JetBrains Mono Variable, ui-monospace, Consolas, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.33
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.brand-700}"
    textColor: "{colors.white}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  button-primary-hover:
    backgroundColor: "{colors.brand-800}"
  button-secondary:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink-800}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  button-secondary-hover:
    backgroundColor: "{colors.ink-50}"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.white}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  button-success:
    backgroundColor: "{colors.success}"
    textColor: "{colors.white}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-700}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  button-sm:
    padding: "4px 10px"
    typography: "{typography.label}"
  input:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink-900}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  card:
    backgroundColor: "{colors.white}"
    rounded: "{rounded.lg}"
    padding: "16px"
  badge:
    rounded: "{rounded.sm}"
    padding: "2px 6px"
    typography: "{typography.label}"
  nav-item:
    textColor: "{colors.brand-100}"
    rounded: "{rounded.md}"
    padding: "6px 8px"
  nav-item-active:
    backgroundColor: "{colors.brand-800}"
    textColor: "{colors.white}"
  sidebar:
    backgroundColor: "{colors.brand-950}"
    width: "240px"
  topbar:
    backgroundColor: "{colors.white}"
    height: "56px"
---

# Design System: KSP Video Evidence Management

## Overview

**Creative North Star: "The Evidence Room"**

The interface is a well-run evidence room. Every item has a label, a place and a record of who touched it,
and nothing is there for decoration. A deep navy frame (the sidebar, the sign-in page, the dashboard
welcome banner) carries the department's authority and the KSP emblem. Inside it, the working surface is
plain white cards on a cool grey floor, where evidence, hashes, statuses and custody entries sit in tidy,
labelled rows. Integrity is shown plainly, never dramatised: a verified hash is text in a badge, not a glowing shield.

The system is **crisp and efficient**. It is compact and dense enough for long shifts on shared station
desktop PCs, keyboard-complete, and quick to scan. Most UI text is 14px, labels are small uppercase captions, and
identifiers are set in monospace so they can be read and compared character by character. One blue does all
the interactive work; colour otherwise only reports status, and status is always written in words as well.

Photography appears only at the edges (the sign-in hero and the dashboard banner), always under a navy
gradient, and always decorative. Work screens show evidence, not atmosphere.

**Key Characteristics:**
- Navy frame, white working surface, cool grey floor.
- One interactive blue; status colours only for status, always with text.
- Dense 14px body, small uppercase labels, monospace identifiers.
- Thin borders and small shadows; flat and orderly rather than lifted.
- The official emblem appears exactly where the department's authority belongs and is never altered.

## Colors

A disciplined two-ramp palette: a royal-to-midnight blue (`brand`) for authority and action, and a cool
slate grey (`ink`) for everything else, plus four semantic hues reserved for status.

### Primary
- **Midnight Duty Navy** (brand-950): the authority frame. Sidebar, mobile menu drawer, sign-in background,
  dashboard banner gradient, browser theme colour.
- **Service Blue** (brand-700): the single action colour. Primary buttons, checked checkboxes, the active
  tab underline, copy-to-clipboard links. White text on it passes AA.
- **Deep Service Blue** (brand-800): primary hover, the active sidebar item, active tab text.
- **Signal Blue** (brand-500): the focus ring and input focus border. Never used for text.
- **Bar Blue** (brand-600): progress bar fill.
- **Pale Duty Blue** (brand-50 / brand-100 / brand-200): blue badge background, row hover tint at 40%,
  sidebar text and captions on navy (brand-100 / brand-200).

### Neutral
- **Case-File Black** (ink-900): headings and primary text.
- **Graphite** (ink-800 / ink-700): table cell text, labels, secondary button text.
- **Slate** (ink-600 / ink-500): meta text, hints, table headers, empty-state copy. ink-500 is the lightest
  grey allowed for text on white.
- **Rule Grey** (ink-300 / ink-200 / ink-100): input borders, card borders, dividers, tab track, neutral badges.
- **Station Floor** (ink-50): the page background behind every card.
- **Night Overlay** (ink-950 at 50%): modal and drawer scrim.

### Status hues (semantic only)
- **Seal Red** (danger / danger-deep and the red-50…900 ramp): destructive buttons, errors, quarantine,
  error toasts, red stats.
- **Cleared Green** (success, emerald-700): success buttons and toasts, verified/green badges. It is
  emerald-700 rather than 600 so white text passes AA.
- **Caution Amber** (warning-text, amber-800 on amber-50): warnings, pending states.
- **Review Violet** (violet-800 on violet-50): the purple badge tone, used sparingly for AI and review states.

### Data visualisation & annotation (inside charts and video only)
- **Chart series** (chart-blue, chart-orange, chart-aqua): the validated categorical slots for recharts series, in that
  order (see `docs/DASHBOARDS-REPORTS-ALERTS.md` §Charts). Every chart also has a text summary and a data-table view.
- **Chart status** (status-good, status-warning, status-serious, status-critical): bar and meter fills for health and
  severity. They are fills, not text colours. The warning *icon* uses the darker warning-icon (#b87900) to stay legible on white.
- **Chart chrome** (chart-grid, chart-axis, chart-label): gridlines, 11px axis ticks and value labels.
- **Annotation markers** (annotation-red/amber/green/blue/violet): the five colours an investigator can give a bookmark or
  region on the video timeline. They are user data, stored with the annotation. Amber is the bookmark default, blue the
  annotation default.

### Named Rules
**The One Blue Rule.** Interactive means blue: brand-700 for actions, brand-500 for focus. No second accent
colour is ever introduced for buttons, links or selection.

**The Words-First Status Rule.** Status colour never stands alone. Every red, green, amber or violet carries its
status as visible text (`StatusBadge`, `Badge`, `Stat`), so the meaning survives greyscale printing and colour blindness.

**The Ink-500 Floor.** On white, text is ink-500 or darker (≥ 4.5:1). ink-400 and ink-300 are only for decorative
icons and borders.

## Typography

**Body Font:** Noto Sans (variable, 100–900; self-hosted via `@fontsource-variable/noto-sans`), falling back to
Segoe UI / system-ui.
**Kannada:** Noto Sans Kannada (variable, self-hosted), second in every stack. Kannada glyphs reach it through
`unicode-range` in both UI languages, so officers' Kannada free text renders properly even in the English UI.
**Mono Font:** JetBrains Mono (variable, self-hosted) for identifiers, chosen for its clearly distinct 0/O and 1/l/I.

**Character:** Neutral, legible and administrative, and the same family as every generated PDF (custody reports,
court-export fact sheets, reports), so what an officer sees on screen is what the court receives on paper. The type
never performs; hierarchy comes from weight and size steps, not from a display face.

### Hierarchy
- **Headline** (600, 20px / 1.25rem): the page title, rendered by `PageHeader`. Exactly one `<h1>` per page.
- **Title** (600, 16px / 1rem): `<h2>` card and section titles.
- **Stat** (600, 24px / 1.5rem): KPI values in `Stat` tiles, tinted red, amber or green only when they carry status.
- **Body** (400, 14px / 0.875rem): almost all UI text, including tables, forms, dialogs and toasts.
- **Label** (500–600, 12px / 0.75rem, uppercase, 0.025em tracking): table headers, key/value labels, stat labels.
- **Caption** (600, 11px, uppercase, 0.05em tracking): sidebar section captions, the dashboard banner kicker line, chart axis ticks.
- **Micro** (500, 10px): only for counts inside tiny badges (notification bell, timeline markers) and chart threshold labels.
- **Mono** (400, 12px): hashes, evidence numbers, ids and other identifiers, shown with `break-all`. Editable
  inputs use `font-mono` alone, never `.mono`, which also forces 12px.

### Named Rules
**The Identifier Rule.** Anything a person might compare character by character (hash, evidence number,
device id, token) is monospace, and it stays English in every UI language.

**The Screen-Equals-Paper Rule.** UI and PDFs share Noto Sans / Noto Sans Kannada. Never introduce a UI face the
PDF renderer (`packages/core/assets/fonts`) does not also embed.

**The No-Display Rule.** There is no display face and no type above 24px inside the app. Emphasis is weight,
not size.

## Layout

App shell: a sticky 240px navy sidebar on the left (from 1024px up), and a sticky 56px white top bar with
breadcrumbs, language switch and user menu. Content sits in `main` with 16px padding (24px from 1024px), centred
at a maximum width of 1600px. Below 1024px the sidebar becomes a 256px drawer behind "Open menu", over a 50%
ink-950 scrim.

Pages are a vertical stack: `PageHeader` (title, optional description, actions aligned right, wrapping), then
cards. Spacing follows Tailwind's 4px grid, mostly 8 / 12 / 16 / 24px. Card headers are 16×12px, card bodies 16px,
table cells 12×8px, and key/value grids have 24px column and 12px row gaps (1, 2 or 3 columns from 640px).

Responsive guarantees (E2E-tested): no horizontal page scroll at 768px or 1280px. Wide tables scroll inside their
card. Flex/grid children holding user text use `min-w-0` / `minmax(0,1fr)`. Unbroken strings wrap with
`overflow-wrap: anywhere`. Tabs wrap onto a second row instead of scrolling sideways.

## Elevation & Depth

Flat and orderly. Depth comes from tonal layering (grey floor, white card, navy frame) plus hairline borders.
Shadows are small and structural, never atmospheric.

### Shadow Vocabulary
- **Resting** (`shadow-sm`: `0 1px 2px 0 rgb(0 0 0 / 0.05)`): cards, inputs, buttons.
- **Floating** (`shadow-lg`: `0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)`): toasts.
- **Overlay** (`shadow-xl`: `0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)`): modal dialogs.

### Named Rules
**The Hairline-First Rule.** Separation comes from a 1px ink-200 / ink-100 border before any shadow. A shadow
larger than `shadow-sm` means the element floats above the page (a toast or a dialog).

## Shapes

Gently squared. Corners are small and consistent: 4px for badges, chips and small icon buttons, 6px for buttons,
inputs and sidebar items, and 8px for cards and dialogs. Fully round only for avatars and dots. Borders are always
1px and grey; the only thick line is the 2px brand-700 underline on the active tab.

## Components

### Buttons
Compact and dependable.
- **Shape:** gently squared (6px), medium weight, 6px gap between icon and label.
- **Primary:** Service Blue with white text, 8×14px padding, 14px text, small resting shadow; Deep Service Blue on hover.
- **Secondary:** white with a 1px ink-300 border and ink-800 text; ink-50 on hover.
- **Danger / Success:** red-600 / emerald-700 with white text, used only for destructive and approving actions,
  usually inside a `ConfirmDialog`.
- **Ghost:** no fill, ink-700 text, ink-100 on hover. Used in toolbars and table rows.
- **Small:** 4×10px padding, 12px text.
- **Focus:** the global 2px brand-500 ring with a 1px offset on `:focus-visible`. **Loading:** spinner and `aria-busy`, disabled.

### Badges (status chips)
- **Style:** 4px corners, 2×6px padding, 12px medium text, tinted 50 background, 800 text, 200 inset ring.
- **Tones:** gray, blue, green, amber, red, purple. `StatusBadge` maps every evidence and workflow status to a tone and
  always shows the translated status word.

### Cards / Containers
- **Corner Style:** 8px.
- **Background:** white on the ink-50 floor.
- **Shadow Strategy:** resting `shadow-sm` (see Elevation).
- **Border:** 1px ink-200. The card header is separated by a 1px ink-100 rule.
- **Internal Padding:** 16px. A titled card renders an `<h2>` and becomes a named region.

### Inputs / Fields
- **Style:** white, 1px ink-300 border, 6px corners, 8×12px padding, 14px text, ink-500 placeholder.
- **Focus:** the border turns brand-500 with a 1px brand-500 ring.
- **Error / Disabled:** red-700 hint text linked by `aria-describedby` plus `aria-invalid`. Disabled is an ink-100 fill with ink-500 text.
- **Labels:** 14px medium ink-700 above the control, always associated through `Field`.

### Navigation
- **Sidebar:** Midnight Duty Navy, emblem and product name at the top, sections captioned in 11px uppercase brand-300.
  Items are 14px brand-100 with a 16px icon; hover is brand-900 with white text, and the active item is filled
  brand-800 with white text.
- **Top bar:** white, 56px, bottom hairline, breadcrumb in ink-600, and ghost-style controls.
- **Tabs:** a row of 14px medium labels over an ink-200 hairline. The active tab has a 2px brand-700 underline and
  brand-800 text. Count pills are ink-100. Tabs use a roving tabindex and wrap onto a second row.

### Data Table (signature component)
The working heart of the system. A required caption, 12px uppercase ink-600 headers, 14px ink-800 cells with
12×8px padding, ink-100 row dividers, a brand-50/40 hover tint on clickable rows (opened with Enter), sortable
headers with `aria-sort`, and a pager under a hairline. It scrolls horizontally inside its card, never the page.

### Stat Tile
A card with a 12px uppercase label, a 24px semibold value and an optional 12px sub-line. The value turns red,
amber or green only when it reports a status.

### Toasts and Dialogs
- **Toasts:** bottom-right, 320px wide, 6px corners, white text on emerald-700 (success), red-700 (error) or ink-800 (info), floating shadow.
- **Dialogs:** a white 8px panel with the overlay shadow over an ink-950/50 scrim, pinned header and footer with
  only the body scrolling, and focus trapped. Consequential actions require a reason.

## Do's and Don'ts

### Do:
- **Do** use the shared primitives in `@/components/ui` (`Button`, `Field`, `Card`, `DataTable`, `StatusBadge`,
  `Modal`/`ConfirmDialog`, `Tabs`, `Stat`) rather than restyling raw elements.
- **Do** keep every action in Service Blue (brand-700) and every focus state in the brand-500 ring.
- **Do** load fonts only from the bundled `@fontsource-variable` packages (no CDN: station networks and the CSP are `'self'`-only).
- **Do** set hashes, evidence numbers and ids in monospace and let them wrap (`break-all`).
- **Do** keep photography decorative (`alt=""`) and under a brand-950 gradient so overlaid text keeps AA contrast.
- **Do** design every state: loading ("Loading…" spinner), error with Retry, empty, and success.
- **Do** check layouts at 768px and 1280px for horizontal scroll.

### Don't:
- **Don't** use ink-400 or ink-300 for text on white. They fall below 4.5:1.
- **Don't** put white text on emerald-600 or any `*-600` fill other than red-600. Use the `*-700` fill.
- **Don't** signal status by colour alone. Always write the word.
- **Don't** introduce a second accent colour, gradient buttons or decorative glows on work screens.
- **Don't** alter, recolour, crop or animate the KSP emblem, and don't use it outside the shell headers, sign-in page,
  share portal and dashboard banner.
- **Don't** add third-party imagery without recording its licence in `public/brand/README.md`.
- **Don't** render storage URLs, bucket names or presigned links anywhere in the UI.
