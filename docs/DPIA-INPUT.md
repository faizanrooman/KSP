# DPIA input (technical description for the legal team)

**This is a factual description of what the software does, prepared as input to a Data Protection Impact Assessment
under the Digital Personal Data Protection Act, 2023 and applicable police regulations. It is not a legal opinion and
does not conclude on lawfulness, necessity or proportionality — that is the DPO's and legal department's assessment.**
Related gates: A1/A2 in [GO-LIVE-CHECKLIST.md](GO-LIVE-CHECKLIST.md) (EXT-4, EXT-5).

## 1. Purpose of processing (as designed)
Storage, integrity preservation, review and court production of video recorded by police body-worn cameras and other
devices; investigation support (search, timelines, case linking); optional machine analysis to help officers find
relevant segments. No automated decision about a person is taken: every AI result is a suggestion that stays
PENDING until a human reviewer approves it.

## 2. Data inventory

| Category | Data | Subjects | Where stored |
|---|---|---|---|
| Evidence media | Video/audio originals (faces, voices, vehicles, locations, possibly children, victims, bystanders) | Public, suspects, victims, witnesses, officers | Object store buckets `evidence` → `archive` → `longterm` (versioned, Object Lock) |
| Derived media | Playback proxy, HLS segments, posters, thumbnails, sprite sheets, snapshots, watermarked share copies | as above | `derived` bucket |
| Evidence metadata | Recorded time, GPS, device, uploading/recording officer, title, tags, notes, case/FIR links | as above, officers | PostgreSQL |
| AI outputs | Detections (label, confidence, bounding box, frame time), crops (JPEG), plate text, face **embeddings** of detected faces during a recognition job, watchlist matches | as above | PostgreSQL `ai_detections`, `derived` bucket |
| Watchlists | FACE: reference photograph + face embedding (biometric template); VEHICLE: plate number | Persons of interest | `derived/ai/watchlists/*`, `ai_watchlist_entries` |
| User data | Name, badge, rank, e-mail, unit, roles, password hash (argon2id), MFA secret (AES-256-GCM encrypted), sessions, IP, user agent | Officers / staff | PostgreSQL |
| Audit trail | Every access and action on evidence (who, when, IP, reason) — append-only hash chain | Officers, share recipients | PostgreSQL `audit_events` |
| External shares | Recipient name/e-mail, access code hash, views | External recipients | PostgreSQL |

## 3. Data flows
Camera/dock → HTTPS resumable upload (API) → staging bucket → hash + validation → immutable evidence bucket →
media worker (derivatives) → optional isolated AI worker (reads only the derived proxy; own DB role and S3 identity;
no internet) → reviewers (web UI) → court export package (signed ZIP, approval by a second officer) / external share
(watermarked, expiring, access code) / CCTNS reference push (identifiers and hashes only, never media). Backups:
encrypted (age) database dumps and replicated buckets at the DR site. No data leaves the deployment except via
export, share, integration push or backup, each audited.

## 4. Biometric processing (face detection / recognition)
* **Face detection** (YuNet) locates faces in sampled frames of the proxy; no identity is inferred.
* **Face recognition** (SFace) computes a 128-dimension embedding for each detected face and compares it (cosine
  similarity, configurable threshold) with embeddings of FACE watchlist entries whose unit covers the evidence
  jurisdiction. Only matches above the threshold are stored; **unmatched faces are not stored as recognitions**.
  A match needs **two approvals by different reviewers** before it is treated as confirmed.
* Watchlist entries are created by users with `ai:watchlist_manage` in their jurisdiction; reference images are
  stored in the derived bucket; embeddings are never returned by the API.
* **Legal gate (implemented):** in production FACE_DETECTION, FACE_RECOGNITION and ANPR are not in the default
  `AI_TASKS_ENABLED` list, and even when listed they are refused by the API, hidden in the UI and refused by the AI
  worker until an administrator records the legal approval (approving authority, reference, date) in Settings →
  Legal approvals. Recording/withdrawing is audited; withdrawal stops queued jobs.
* ANPR reads plate text and compares it with VEHICLE watchlists; the plate model's licence is under review (EXT-4).
* Accuracy on KSP footage (lighting, skin tones, motion blur) has **not** been measured; false matches are possible
  and are the reason for mandatory human review.

## 5. Retention
Retention policies per category (default 7 years, non-evidentiary 1 year, serious crime until court disposal order;
configurable by the custodian). Disposal requires a request + approval by a different person and is blocked by a legal
hold; the evidence row, its hashes and the custody trail are kept after disposal (media removed). Object Lock
retention (`OBJECT_LOCK_DAYS`) prevents early deletion of originals. Derived data and AI results follow the evidence;
exports expire after `exportRetentionDays` (default 30); shares expire (max `maxShareDays`, default 30). The audit
trail is append-only and not deleted. **For the DPO to decide:** retention of AI detections/crops for rejected
results, of watchlist entries, and of face embeddings computed during jobs.

## 6. Safeguards implemented
Role- and jurisdiction-based access (unit subtree), 404 for out-of-scope items; MFA mandatory for privileged roles;
separation of duties for export and disposal; every view/play/download/export/share audited with custody events;
tamper-evident hash-chained audit ledger with signed checkpoints; Object Lock + DB triggers for immutability;
TLS in transit, encryption at rest by the object store and database (deployment), MFA secrets encrypted with a
versioned key; short-lived media tokens (no storage URLs exposed); watermarked external copies; AI isolation (own DB
role, derived bucket only, no network); human review of all AI output, dual approval for face matches; production
preflight preventing test keys, dev accounts and fixture integrations; data minimisation in API responses.

## 7. Points for the DPIA owner
Lawful basis and necessity for face recognition and ANPR; watchlist governance (who may add persons, review period,
removal); information to data principals and exemptions relied on; handling of bystanders (redaction is **not**
implemented); access requests / corrections; cross-border transfer (none by design; confirm hosting); breach
notification procedure; retention periods in §5.
