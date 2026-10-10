---
target: evidence detail page
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:/home/punith/Downloads/KSP/apps/web/src/modules/evidence/EvidenceDetailPage.tsx"
target_fingerprint: "sha256:38d38a210428281b55312a9cad7492e1de3b490f0652ae87cb0bb076265e4b33"
target_path: /home/punith/Downloads/KSP/apps/web/src/modules/evidence/EvidenceDetailPage.tsx
timestamp: 2026-10-09T10-29-46Z
slug: src-modules-evidence-evidencedetailpage-tsx
---
# Critique: Evidence detail page (src/modules/evidence/EvidenceDetailPage.tsx)
Method: dual-agent (A: design review · B: detector + browser overlay)

## Design Health Score: 25/40 (Acceptable)
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 2 | Header hash strip shows an always-green shield and "last verified …" but never the result |
| 2 | Match system / real world | 3 | Raw system strings: container "mov,mp4,m4a,3gp,3g2,mj2", "Validate Register" |
| 3 | User control and freedom | 3 | URL tab state, Cancel on edit; AI run has no cost/duration preview |
| 4 | Consistency and standards | 2 | Duplicate Verify button; hash full vs truncated in integrity history; mono evidence number missing on /player |
| 5 | Error prevention | 3 | Reprocess sits beside Share as a peer action |
| 6 | Recognition rather than recall | 2 | Nine tabs without counts; "98 pending" and "chain intact" invisible until opened |
| 7 | Flexibility and efficiency | 3 | Good tab keyboarding and frame stepping; no tab-jump shortcuts |
| 8 | Aesthetic and minimalist design | 2 | AI tab is a 5,195 px wall of 98 cards; title repeated three times |
| 9 | Error recovery | 3 | Good "Chain BROKEN" / integrity alerts, but only inside their tabs |
| 10 | Help and documentation | 2 | "Active tier", "Object lock until", "ledger head seq" unexplained |

## Design specificity
Partly authored: mono evidence numbers, both hashes in the header, chain-intact banner, per-event ledger seq/hash, advisory AI banner. But the frame is a generic admin template (header, six equal outline buttons, nine tabs, key/value cards), and the two strongest trust verdicts (custody "Chain intact", fixity "Match") are on tabs 7 and 8. Detector: CLI clean; in-page overlay found 8 on the AI tab — 2× undersized-ui-text (10px timeline labels, AiTab.tsx:282, real) and 6× nested-cards (task checkbox tiles, AiTab.tsx:87, likely false positive). No horizontal overflow at 1440/390.

## Priority issues
- [P1] Header integrity strip claims trust without a verdict (always-green ShieldCheck, EvidenceDetailPage.tsx:112). Fix: verdict row "Fixity: Match · re-verified … · Custody chain: intact (46 events)", tone from lastResult, links to tabs. Command: clarify → harden.
- [P1] Too many equal-weight choices: 6–9 outline action buttons with no primary; 9 tabs. Fix: one primary (Export for court or Play), secondary Link/Workspace/Share, rest in "More"; group tabs with counts. Command: distill → layout.
- [P1] Overview has no footage; first view is a metadata form. Fix: poster/inline player on Overview, technical metadata behind disclosure. Command: layout.
- [P2] AI tab unbounded and task-order inverted (request form before results, no review actions on cards, 10px timeline labels). Fix: results first, per-task summary with "Review N pending →", cap cards, 11px+ labels. Command: distill → onboard.
- [P3] Consistency/i18n: 'Never re-verified'/'None'/'System' untranslated (fixed in this pass), truncated hash in history, duplicate Verify, raw strings. Command: polish.

## Persona red flags
- Alex: no tab shortcuts; cannot approve/reject detections where shown; custody filter limited to two options.
- Sam: ~22 tab stops before content; tabs lack aria-controls, tabpanel uses aria-label; 98 "Pending review" announcements.
- Tender evaluator: no story in six identical buttons and nine tabs; "chain intact"/"match" never on first screen; unreviewed-AI wall reads as backlog; raw strings look unfinished.

## Minor observations
Same green check for all 46 custody events; Tags "Add" button height mismatch; Lifecycle empty block ~200px; mobile tab row wraps to four lines (content ~625px down); Playback technical card repeats Overview metadata.

## Questions to consider
- Should a five-second glance tell an evaluator "this footage is untouched and every touch is recorded"?
- Does every role need nine tabs, or should the default tab follow the role?
- Should 98 unreviewed detections appear on the evidence record before any human approval?
