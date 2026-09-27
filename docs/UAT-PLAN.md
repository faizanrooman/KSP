# User Acceptance Test plan

Scope: the 20 specification modules (traceability: [REQUIREMENTS-TRACEABILITY.md](REQUIREMENTS-TRACEABILITY.md)),
executed by KSP users per role on **staging** before go-live (gate E4 in [GO-LIVE-CHECKLIST.md](GO-LIVE-CHECKLIST.md)).

## Ground rules

* Environment: staging (`KSP_ENVIRONMENT=staging`). The signing key may be a test key — every export / custody PDF is
  then stamped **"NON-EVIDENTIARY – TEST KEY"**; the Fact Sheet shows **"TEMPLATE – PENDING LEGAL APPROVAL"** until
  the legal approval is recorded. Neither stamp is a defect in UAT.
* Footage: synthetic or **consented** recordings only. Face recognition and ANPR stay disabled unless legal has
  approved them for UAT and the approval reference is recorded in Settings → Legal approvals (EXT-4/EXT-5).
* Integrations: the fixture CCTNS adapter may be used on staging only; it is labelled FIXTURE and is refused by the
  production preflight.
* Accounts: one named tester per role (below), created with `ops:bootstrap-org`; MFA enrolment where the role requires
  it. After UAT the staging database is either rebuilt or cleaned with `npm run ops:purge-demo-data` (dry run first).
* Defects: logged with role, script id, steps, expected vs actual, screenshot, request id from the error panel.
  Severity: S1 blocks go-live, S2 must be fixed or accepted by the product owner, S3 cosmetic.

## Roles and test accounts

| Role (code) | Tester | Home unit | MFA |
|---|---|---|---|
| Field officer (FIELD_OFFICER) | | station | no |
| Station operator (STATION_OPERATOR) | | station | no |
| Investigating officer (INVESTIGATING_OFFICER) | | station | no |
| Supervisor (SUPERVISOR) | | division | yes |
| Forensic analyst (FORENSIC_ANALYST) | | commissionerate | no |
| Evidence custodian (EVIDENCE_CUSTODIAN) | | commissionerate | yes |
| Auditor (AUDITOR) | | state | yes |
| System administrator (SYSTEM_ADMINISTRATOR) | | state | yes |

## Test scripts

Each script lists the spec module(s) it covers. Acceptance criterion for every script: all steps behave as expected,
every consequential action appears in the audit trail (Compliance → Audit) with the tester as actor, and nothing
outside the tester's jurisdiction is visible (out-of-scope items answer "not found").

### Field officer / station operator
| ID | Module | Steps | Expected |
|---|---|---|---|
| FO-1 | 1 Authentication | Log in, change the one-time password, log out; 5 wrong passwords | Password policy enforced; lockout after the configured attempts; events audited |
| FO-2 | 4 Evidence registry, 5 Integrity | Upload a 1 GB recording (resumable: interrupt the network mid-way and resume) with device, recorded time, GPS | Upload resumes; item REGISTERED with SHA-256/SHA-512; duplicate upload detected |
| FO-3 | 7 Video | Open the item; play, seek, frame-step, zoom, snapshot | Proxy/HLS playback; "Preparing adaptive stream…" only if `MEDIA_PROFILE=on-demand-hls` |
| OP-1 | 4, 16 | Station upload on behalf of an officer; bulk upload of 10 files | Uploader and officer recorded separately |

### Investigating officer
| ID | Module | Steps | Expected |
|---|---|---|---|
| IO-1 | 12 Cases/FIR | Create a case, link an FIR (fixture on staging), link 3 evidence items | Links and custody events recorded |
| IO-2 | 8 AI, 9 Review | Request person/object detection on an item | Job completes; results PENDING; disabled tasks are explained, not offered |
| IO-3 | 10 Search | Search by officer, time range, map area, tag, AI label (approved only) | Only own-jurisdiction results; saved search works |
| IO-4 | 11 Workspace | Create a workspace, add items, timeline events, notes, sync-play two recordings | Timeline ordered; sync offset persisted |
| IO-5 | 14 Court export | Request an export for a case (originals + custody report + fact sheet) | Needs a different approver; package downloadable after approval |
| IO-6 | 15 Sharing | Share an item externally with expiry, max views and watermark; open the portal link with the access code | Watermarked copy; view count; expiry/revocation honoured |

### Supervisor
| ID | Module | Steps | Expected |
|---|---|---|---|
| SU-1 | 1 | First login with MFA enrolment; recovery codes | MFA mandatory |
| SU-2 | 14 | Approve IO-5's export; try to approve an export you requested yourself | Own request refused (separation of duties) |
| SU-3 | 9 | Review AI results: approve, reject, correct label, escalate | Status history per detection |
| SU-4 | 17 Dashboards/alerts | Open the division dashboard; acknowledge an alert | Figures limited to the division |

### Forensic analyst
| ID | Module | Steps | Expected |
|---|---|---|---|
| FA-1 | 7, 13 | Download the original (reason required); verify its hash offline | Hash matches; custody event with reason |
| FA-2 | 14 | Verify an export package offline with VERIFY.txt (OpenSSL) and with Export → Verify | "Verified OK"; tampered file detected |

### Evidence custodian
| ID | Module | Steps | Expected |
|---|---|---|---|
| EC-1 | 6 Retention | Place and release a legal hold; request disposal of a held item | Disposal refused while held |
| EC-2 | 6 | Disposal request → approval by another custodian → execution | Original removed only after approval; custody trail retained |
| EC-3 | 5 | Run an integrity check on an item; review the fixity dashboard | Result recorded |
| EC-4 | 13 Custody | Generate a signed chain-of-custody report; verify it offline | Signature verifies; all events listed |

### Auditor
| ID | Module | Steps | Expected |
|---|---|---|---|
| AU-1 | 18 Audit | Filter the audit trail by user and evidence; export it | Export file hash recorded |
| AU-2 | 18 | Verify the ledger; create a checkpoint; export checkpoints | Chain OK; checkpoint signature valid |
| AU-3 | 3 RBAC | Attempt to change evidence or settings | Refused (read-only role) |

### System administrator
| ID | Module | Steps | Expected |
|---|---|---|---|
| AD-1 | 2 Users/roles | Create a user, grant a role at a unit, disable the user | Sessions revoked on disable |
| AD-2 | 2 | Edit a role's permissions; create an org unit and a device | Audited with old/new values |
| AD-3 | Settings | Change a policy and restore defaults; record and withdraw a legal approval | `SETTINGS_UPDATED` / `LEGAL_APPROVAL_RECORDED` / `LEGAL_APPROVAL_REVOKED` audited |
| AD-4 | 16 Integrations | Configure an integration system (fixture on staging), run the connection test, create an API client | Fixture never shows "Verified" |
| AD-5 | 19 Monitoring | Open System health; check queues, workers, storage | All components healthy |
| AD-6 | 20 Backup/DR | Observe (with DevOps) a restore drill on staging | RTO recorded |

## Non-functional acceptance
Playback start < 3 s for a 30-min item on the staging network; search results < 2 s; UI usable at 360 px width and
with keyboard only; Kannada text renders in PDFs; accessibility spot checks (screen reader labels on upload/player).

## Sign-off sheet

| Role | Scripts passed | Open S1 | Open S2 (accepted?) | Tester (name, rank) | Signature | Date |
|---|---|---|---|---|---|---|
| Field officer / operator | FO-1..3, OP-1 | | | | | |
| Investigating officer | IO-1..6 | | | | | |
| Supervisor | SU-1..4 | | | | | |
| Forensic analyst | FA-1..2 | | | | | |
| Evidence custodian | EC-1..4 | | | | | |
| Auditor | AU-1..3 | | | | | |
| System administrator | AD-1..6 | | | | | |

UAT accepted for go-live: Product owner ____________________  Date ________  (all S1 closed, S2 fixed or accepted).
