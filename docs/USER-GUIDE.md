# User Guide

Task walkthroughs per role for the KSP Video Evidence Management web application. Menu names below are the
labels shown in the left navigation; a menu item only appears if your role grants the permission behind it
(default role matrix: `packages/shared/src/permissions.ts`, explained in [AUTHORIZATION.md](AUTHORIZATION.md)).
Your access applies to the organisation unit(s) you are assigned to **and everything below them**; evidence
outside your jurisdiction is simply not found.

> Verification: the flows marked (E2E) are exercised by the Playwright suite (`tests/e2e/specs`, Chrome only).
> Others are covered by API tests and manual agent runs but not driven in a browser.

## Common to everyone

* **Sign in** — username + password. Supervisors, administrators, auditors and custodians must enrol two-step
  verification on first sign-in: scan the QR code with an authenticator app, enter the 6-digit code, and store
  the recovery codes shown once. Five consecutive failures lock the account for 15 minutes (defaults; the administrator can change them
  in **System settings**). (E2E `01-auth`)
* **My profile** — change password (history and complexity policy apply), view/enable two-step verification,
  sign out other sessions.
* **Dashboard** — KPIs and charts scoped to your jurisdiction; each chart has a text summary for screen readers.
* **Notifications** — alerts routed to you.
* **Language** — the **EN / ಕನ್ನಡ** switch in the top bar (and on the sign-in page) changes every screen, date and
  number format immediately and is remembered on this browser. Evidence numbers, usernames and codes stay as stored.
* Every view, play, download, snapshot and change you make on evidence is recorded in the chain of custody.

## Field officer (`FIELD_OFFICER`)

1. **Upload evidence** → choose files (or a folder), pick the station, optionally a title/category, **Upload**.
   Uploads are chunked and resumable: **Pause**/**Resume all** or reload the page and re-select the same files
   to continue. (E2E `02-upload`)
2. Watch the status move *Uploading → Validating → Registered* (or *Quarantined* with a reason, e.g. corrupt
   or duplicate file). **Upload history → My uploads** lists everything you sent.
3. **Evidence** shows only evidence you uploaded or recorded (`evidence:read_own`); open an item to play it.

## Station upload operator (`STATION_OPERATOR`)

1. For bulk ingestion from a station terminal use the station CLI (`tools/station-client`, see
   [INGESTION.md](INGESTION.md)) or **Upload evidence → Choose folder** in the browser.
2. **Upload history → All uploads in my jurisdiction** to follow a batch; failed items can be retried.
3. Operators can see evidence records of their station but not play media (no `evidence:play`).

## Investigating officer (`INVESTIGATING_OFFICER`)

* **Search** — free text plus filters (station, officer/device, time range, map radius/bbox, tags, case/FIR,
  storage tier, approved AI labels such as plate/colour). Filters live in the URL, so a search can be
  bookmarked; save searches for reuse. (E2E `05-search`)
* **Evidence → open item** — tabs: *Overview*, *Playback* (HLS player, frame stepping, **Print current frame**),
  *Snapshots* (exact-frame stills), *Integrity*, *Lifecycle*, *AI analysis*, *Chain of custody*,
  *Bookmarks & annotations*, *Related evidence*. Actions: **Verify** (re-hash), **Link to case**,
  **Add to workspace**, **Export for court**, **Share**. (E2E `03-evidence`)
* **AI analysis tab** — choose tasks and run; results appear as *Pending review* until a reviewer approves them.
* **Face search** (Analysis menu) — upload a photograph of a suspect; every face found in any analysed footage you
  are allowed to see is compared and the closest matches are listed with a link to the exact frame. Available only
  where face recognition is enabled and legally approved; every search is audited.
* **Cases** → **New case** / open a case: link evidence, write the append-only case diary, see the timeline,
  change status. **FIRs** → **Register FIR** or **Import from CCTNS** (fixture adapter only — UNVERIFIED against
  real CCTNS). (E2E `06-cases`)
* **Workspaces** — create a workspace, add team members and evidence, align several videos with sync offsets
  for synchronised multi-camera playback, add bookmarks, region annotations and an incident timeline. Region
  drawing is pointer-only (see [ACCESSIBILITY.md](ACCESSIBILITY.md)). (E2E `07-workspace`)
* **Court exports → New export** (or **Export case evidence** on a case) → select items, reason →
  **Submit for approval**. After a supervisor approves, the package builds; **Download package**. (E2E `08-export`)
* **Shares → Share** from an evidence item — internal recipient, or external recipient with expiry, max views,
  watermark and access code. Revoke at any time. (E2E `09-share`)

## Supervisor (`SUPERVISOR`)

Everything an IO can do, plus:
* **Court exports → Awaiting my approval** — **Approve** / **Reject** with a note; you cannot approve your own
  request.
* **Disposal approvals** — approve (**Approve and dispose**) or reject disposal requests raised by custodians;
  legal holds block disposal.
* **Legal hold** action on evidence (reason required).
* **Upload history → Quarantine** — inspect quarantined uploads and **Release** or **Reject** them.
* **AI review queue** (as reviewer, see forensic analyst), **Alerts** (acknowledge/resolve, **Alert rules**),
  **Reports**, **Shares** (all shares within jurisdiction; revoke).

## Forensic analyst (`FORENSIC_ANALYST`)

1. **AI review queue** — keyboard: `j`/`k` next/previous, `a` approve, `r` reject (reason), `s` request a second
   review, `x` select for bulk, `h` history. Correct a wrong label with **Correct label**. Face-recognition
   matches need approvals from **two different reviewers**. (E2E `04-ai`)
2. Approved classification labels become evidence tags and are searchable.
3. **Watchlists** — create face/vehicle watchlists for your jurisdiction and add reference entries.
4. Snapshots, integrity verification, workspaces as for an IO (no case management, no exports).

## Evidence custodian (`EVIDENCE_CUSTODIAN`)

* **Retention policies** — **New policy** (retention period by category, *Archive after*, *Long-term after*).
* On an evidence item: **Request disposal** (reason required) — a supervisor must approve; **Legal hold**;
  **Verify** integrity; review the *Lifecycle* and *Integrity* tabs (tier, retain-until, object-lock-until,
  last fixity result).
* **Reports** — storage, retention, integrity reports.
* Custodians do **not** approve court exports in the default role matrix (open product decision, see
  [KNOWN-ISSUES.md](KNOWN-ISSUES.md)).

## Compliance auditor (`AUDITOR`)

* **Audit log** — filter by user, action, resource, time; export (CSV/JSON; the export itself is audited).
* **Ledger verification** — verifies the hash chain and the signed hourly checkpoints; any break is reported
  with the sequence number.
* **Chain of custody** tab on evidence and the signed custody PDF.
* **Court exports → Verify package** — upload a package's manifest + signature to check it offline-style.
* Auditors cannot administer roles (separation of duties).

## System administrator (`SYSTEM_ADMINISTRATOR`)

See [ADMIN-GUIDE.md](ADMIN-GUIDE.md): users, roles & permissions, organisation units, devices, system settings,
integrations, API clients, AI models, retention policies, alert rules, system health. Administrators have no
evidence media access by default.

## External share recipient (no account)

Open the link (`/s/<token>`), enter the access code received separately. Too many wrong codes lock the share
(the sender must revoke and re-share). Media is watermarked with the recipient's identity; downloads only if
the sender allowed them; access stops at expiry or after the maximum number of views. (E2E `09-share`)
