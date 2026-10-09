---
target: evidence detail page
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/home/punith/Downloads/KSP/apps/web/src/modules/evidence/EvidenceDetailPage.tsx"
target_fingerprint: "sha256:94ed2ff4641b483ff71a25b432d04aa20d458993ceded3e19e918528ee3dbc11"
target_path: /home/punith/Downloads/KSP/apps/web/src/modules/evidence/EvidenceDetailPage.tsx
timestamp: 2026-10-09T10-49-21Z
slug: src-modules-evidence-evidencedetailpage-tsx
---
# Re-critique: Evidence detail page (after PR #35)
Method: dual-agent (A: design review · B: detector + browser overlay)

## Design Health Score: 26/40 (Acceptable; was 25)
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | Verdict chips state results; custody count grows silently with each view |
| 2 | Match system / real world | 3 | Raw values remain ("READY", "Container Tag") |
| 3 | User control and freedom | 3 | Cancel, confirm dialogs, Escape on the menu |
| 4 | Consistency and standards | 2 | Title ×3, "Play footage" ×3, hashes ×3; More panel is bordered buttons, not a menu |
| 5 | Error prevention | 3 | Reasons required; two-person disposal |
| 6 | Recognition rather than recall | 3 | Results above the tabs; custody count on the tab |
| 7 | Flexibility and efficiency | 2 | No tab shortcuts, no custody actor/action filter, no copy on evidence number |
| 8 | Aesthetic and minimalist design | 2 | Repetition; custody wall of views; AI empty state dominates |
| 9 | Error recovery | 3 | Broken-chain / fixity-failure alerts are actionable |
| 10 | Help and documentation | 2 | Only the player has shortcut help |

## Design specificity
Mostly authored now: the header states fixity and custody results with words and links to proof; footage first; custody consequences on every consequential action. Generic remainder: Overview/Lifecycle card grids, table-only Integrity tab, Custody as a raw log. Detector: CLI clean on evidence/custody/video/ai; in-page overlay clean on overview (menu closed and open), AI, custody and integrity; AI tab 1,283 px tall (was 5,195); no text below 11 px; no horizontal overflow at 1440/390.

## Priority issues
- [P1, FIXED in #35] "re-verified" overstated the registration-time hash as a re-check. The chip now reads "Hash recorded at ingest · no later re-check yet" until a later check exists, then "re-checked <date> (<trigger>)". Verified on demo data before/after a real on-request check.
- [P1] Chain of custody buries milestones under repeated "Evidence Viewed" rows. Fix: milestones first, collapse view runs ("viewed 14× 3:37–3:53"), "All events" as a filter, signed PDF primary. Command: distill.
- [P1] AI tab is a dead end for non-reviewers and shows nothing provisional. Fix: provisional "Unreviewed — not on record" crops behind a toggle, hide filters until something is approved, fold the advisory banner into the card subtitle. Command: clarify / onboard.
- [P2] Redundancy and header overload (title, Play, hashes repeated; 6 header actions for IO; More panel should be role="menu" with arrow keys). Command: layout.
- [P2] Nine flat tabs; tabs lack aria-controls, tabpanel lacks aria-labelledby; count read as "Chain of custody90". Command: adapt.

## Persona red flags
- Alex: no tab shortcuts; custody unfilterable by actor/action; no copy on evidence number; detections jump to Playback.
- Sam: AI timeline marks and custody rows each a tab stop (hundreds); More menu lacks arrow keys; chip names run label+detail together; custody sentence assembled from fragments.
- Tender evaluator: header lands well; then AI "0 approved" and a custody wall of views; "Active tier" jargon.

## Minor observations
Toasts and Lifecycle values still English in Kannada ("Metadata saved", "Analysis queued", "Indefinitely", "Never", "{n} days"); "Location" both as text field and GPS card; case status badge looks like a button; empty Min confidence input; AI summary column alignment differs by role.

## Questions to consider
- Should a routine view carry the same weight in the custody record as a transfer or export?
- Should the page open on a one-glance "Court readiness" summary (re-checked, chain intact, AI reviewed, FIR-linked, exportable)?
