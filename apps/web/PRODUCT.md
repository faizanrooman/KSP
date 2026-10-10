# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Every role is a first-class user; no single role outranks the others in design decisions (confirmed). Each
person sees only the menus their permissions grant and only evidence inside their organisation unit and the
units below it:

- **Field officer**: uploads body-worn-camera footage at the station and sees only their own evidence.
- **Station upload operator**: bulk-ingests evidence from a station terminal and follows batches, but cannot play media.
- **Investigating officer**: search, playback, AI analysis, face search, cases/FIRs, workspaces, court export, sharing.
- **Supervisor**: dashboards, alerts, approvals and oversight across a jurisdiction.
- **Forensic analyst**: AI review queue, frame-exact analysis, annotations.
- **Evidence custodian**: legal hold, retention, disposal (two-person), export approval.
- **System administrator**: users, roles, org units, devices, settings, integrations, API clients.
- **Auditor**: audit log, tamper-evident ledger verification, custody reports.

Near-term audience: **tender evaluators and senior Karnataka State Police officials** judging the system in a
live demo (tender KSP/2026-27/IND0597/CALL-3). Winning that demo is the current top priority (confirmed);
nothing done for the demo may weaken daily operational use afterwards.

## Product Purpose

A video evidence management system for Karnataka State Police body-worn-camera footage: tamper-evident
ingestion and storage, playback, human-reviewed AI analysis, search, investigation workspaces, case/FIR linking,
chain of custody, court export, secure sharing, dashboards/alerts and audit. Success means that evidence
captured in the field stays legally admissible from upload to courtroom, and that officers can find and use it
quickly.

## Positioning

Evidence integrity that a court can check for itself: WORM storage for originals, SHA-256/512 hashing,
a hash-chained, append-only audit ledger, a custody event for every view/play/download/snapshot, signed
custody PDFs, and court export packages with dual approval, re-hashing, a signed manifest, a BSA s.63 fact sheet
and offline VERIFY.txt. AI never asserts anything on its own; every detection stays pending until a human
approves it, and face matches need two people.

## Operating Context

- Used mainly on **shared station desktop PCs** (confirmed). Layouts are also tested at 768 px (tablet) and 1280 px.
- Officers switch between English and Kannada; the choice is per browser.
- Work is jurisdiction-scoped; evidence outside a user's scope is simply "not found" (404), never "forbidden".
- Supervisors, administrators, auditors and custodians must use TOTP two-step verification.
- Bulk station ingestion also happens through a separate CLI (`tools/station-client`), not only the web uploader.
- The demo server runs the real API with demo content (body-worn-camera videos, FIRs, cases, AI analyses,
  workspace, export) loaded by `scripts/demo/load-demo-content.mjs`.

## Capabilities and Constraints

- Binding conventions: `docs/CONTRACTS.md` (§9 UI) and `docs/UI-GUIDELINES.md`. The E2E suite depends on them.
- Never render storage URLs, bucket names or presigned links. Media goes only through API URLs with short-lived tokens.
- Every evidence touch writes a custody audit event; UI must not invent ways to view evidence that bypass this.
- Never present anything as verified that was not actually run. The same honesty applies to UI copy
  (e.g. CCTNS import runs against a fixture adapter only).
- AI results are labelled pending until a human reviews them. Face recognition and ANPR sit behind legal
  approval gates.
- Consequential actions (disposal, legal hold, export approval, role changes) use confirm dialogs and require a
  reason when the audit trail needs one.
- Stack in place: React 18, react-router 7, TanStack Query, Tailwind 3, lucide-react, recharts, hls.js; route-level code splitting.
- Terminology: evidence number, FIR, case diary, chain of custody, legal hold, quarantine, org unit / jurisdiction,
  station, body-worn camera (BWC).
- Identifiers stay English in every language: evidence numbers, usernames, codes, hashes, file names, ledger entries.

## Brand Commitments

- Karnataka State Police emblem (`public/brand/ksp-emblem.png`, the State Emblem of Karnataka): official insignia,
  used only to present this system to KSP. It is not ours to alter or reuse elsewhere.
- Licensed photographs in `public/brand/` (Wikimedia Commons, CC BY-SA 4.0 / CC BY 3.0 / CC0) need attribution;
  new third-party images must have their licence recorded in `public/brand/README.md`.
- Kannada uses Western digits (KSP convention, matching the PDF reports); Noto Sans Kannada is bundled.

## Evidence on Hand

- Demo dataset: body-worn-camera videos, FIRs, cases, AI analyses, a workspace and an export (`scripts/demo/`).
- Verification records: `docs/PROJECT-STATUS.md`, `docs/FINAL-AUDIT.md`, `docs/REQUIREMENTS-TRACEABILITY.md`,
  `docs/TENDER-COMPLIANCE.md`, `docs/SECURITY-TEST-REPORT.md`, `docs/ACCESSIBILITY.md`, `docs/PERFORMANCE.md`.
- Absent and must not be fabricated: customer testimonials, real KSP deployment claims, CERT-In VAPT results,
  AI accuracy on real KSP footage or Indian plates, production-scale availability figures, real CCTNS integration.

## Product Principles

1. **Integrity is visible.** Hashes, custody, approvals and verification status are shown plainly, because legal
   credibility is the product.
2. **Every role gets a complete, uncluttered tool.** Permission-scoped menus mean each person sees only their job,
   done well.
3. **Humans decide; AI suggests.** Machine output always looks provisional until a person approves it.
4. **Honest under scrutiny.** The UI never claims more than the system has proven. That matters most in front of evaluators.
5. **Built for the station desk, in two languages.** Shared desktop PCs, English and Kannada, keyboard-complete.

## Accessibility & Inclusion

WCAG 2.1 AA (internal automated and scripted testing: axe on 64 page states, keyboard-only walkthrough, 768/1280
responsive checks). Text ≥ 4.5:1; status never by colour alone; single-key shortcuts scoped or switchable; full
Kannada UI. Details: `docs/ACCESSIBILITY.md`, `docs/I18N.md`.
