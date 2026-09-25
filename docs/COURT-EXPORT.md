# Court evidence export (spec module 14)

Controlled export with two-person approval, integrity re-verification, watermarked copies, per-item custody
reports, a Fact Sheet, a signed manifest and offline verification instructions.

## Flow

1. **Request** — `POST /api/v1/exports` (`export:create`):
   `{evidenceIds[], caseId?, purpose, courtName?, courtCaseNumber?, recipient?, options: {includeOriginal=true,
   includeWatermarked=false, includeCustodyReport=true, includeFactSheet=true, watermarkText?}}`.
   Each item goes through `loadEvidenceFor` with `evidence:download_original` if originals are included, else
   `evidence:play` (404 outside jurisdiction, 403 without the permission). Status `PENDING_APPROVAL`;
   `EXPORT_REQUESTED` custody event per item. Export number `EXP-<yyyy>-<seq>`. The export's org unit is the
   case's (if given) or the first item's.
2. **Approve / reject** — `POST /exports/:id/approve {note?}` / `reject {note}` (`export:approve`, in scope of
   the export's org unit). Approver ≠ requester (API 403 `SEPARATION_OF_DUTIES` + DB `CHECK`); the approver must
   be able to see **every** item (403 `ITEMS_NOT_VISIBLE`). Approve enqueues `EXPORT_BUILD`.
3. **Build** — worker `apps/worker/src/jobs/exports/build.ts` (see below) → `READY` or `FAILED`.
4. **Download** — `GET /exports/:id/download` (`export:download`; requester, approver or in-scope approver) →
   `{url, expiresAt, filename, sha256, sizeBytes}`; `url` = `/api/v1/exports/:id/package?t=<token>`
   (USER media token, scope `export`, bound to the export id and the session, TTL 120 s). The package route
   streams from the exports bucket with Range; the first byte-0 request increments `download_count` and writes
   `EXPORT_DOWNLOADED` per item.
5. **Revoke** — `POST /exports/:id/revoke {reason}` (requester or in-scope approver): `REVOKED`, package deleted,
   `EXPORT_REVOKED` per item. A build finishing after revocation deletes its own output.
6. **Expiry** — cron `exports.expire` (hourly): READY packages past `expires_at`
   (= completion + `shareExportPolicy.exportRetentionDays`) are deleted → `EXPIRED`, `EXPORT_EXPIRED` per item.

Lists: `GET /exports?view=mine|pending|all&status&caseId&q&page&pageSize&sort`; detail `GET /exports/:id`
includes items with registered / verified SHA-256 and SHA-512.

## Build (worker)

1. For every item stream the stored original (tier bucket/key/version) and recompute SHA-256 + SHA-512 + size.
   Any mismatch with the registered hashes (or the hash captured at request time) or a missing object ⇒ export
   `FAILED`, `export_items.verified_ok=false`, `integrity_checks` row, `EVIDENCE_INTEGRITY_FAILED` +
   `EXPORT_FAILED` custody events and a CRITICAL `INTEGRITY_FAILURE` alert. **Nothing is shipped.**
   Success writes `EVIDENCE_INTEGRITY_VERIFIED` (trigger `EXPORT`) and updates `last_verified_at`.
2. Generate artefacts, then the manifest, sign it, and stream a ZIP (yazl) directly into the exports bucket
   (multipart upload; no full buffering; originals stored, text compressed). Originals are re-hashed while being
   zipped; a difference aborts the upload.
3. `READY` with package SHA-256/size, manifest SHA-256, signature, algorithm, key id, certificate fingerprint,
   sealed ledger head; `EXPORT_GENERATED` per item.

### Package layout

```
originals/<evidenceNumber>_<original filename>   byte-identical originals (if includeOriginal)
watermarked/<evidenceNumber>.mp4                 viewing copy from the PROXY (if includeWatermarked)
metadata/<evidenceNumber>.json                   full metadata: identity, hashes, device, officer, uploader,
                                                 unit, GPS, recording times, probe summary, linked cases
custody/<evidenceNumber>_custody.pdf             signed chain-of-custody report (see CHAIN-OF-CUSTODY.md)
FACT_SHEET.pdf                                   fact sheet + Section 63 BSA certificate TEMPLATE
signing-cert.pem                                 signing certificate
VERIFY.txt                                       offline verification commands
SHA256SUMS                                       sha256sum -c format, every file above
manifest.json                                    every file (path, role, size, SHA-256), items, export metadata,
                                                 ledger head {seq, hash}, signing info; sorted keys
manifest.sig                                     detached signature over manifest.json (raw bytes)
```

`SHA256SUMS` is itself listed in `manifest.json`, so the chain signature → manifest → SHA256SUMS → files is closed.

### Offline verification (VERIFY.txt)

```sh
openssl x509 -in signing-cert.pem -pubkey -noout > signing-pubkey.pem
openssl dgst -sha256 -verify signing-pubkey.pem -signature manifest.sig manifest.json   # Verified OK
openssl x509 -in signing-cert.pem -noout -fingerprint -sha256                           # compare with published
sha256sum SHA256SUMS                                                                    # == manifest entry
sha256sum -c SHA256SUMS                                                                 # every file: OK
```

(Ed25519 keys get an `openssl pkeyutl -verify -rawin` line instead.) `apps/api/test/exports.test.ts` extracts
these lines from the generated VERIFY.txt and runs them **verbatim** in the unzipped package, and checks that a
modified manifest fails.

### Online verification

`POST /exports/verify` (`export:create|approve|download` or `audit:verify`): body either a ZIP
(`application/octet-stream`, ≤ 100 MiB) or JSON `{manifest, signature(base64)}`. Report: signature valid against
**our** certificate (a certificate inside the package is compared, never trusted), package certificate matches,
export known + manifest equals the recorded one, each item's hash present in the evidence register, sealed
ledger head exists, per-file hash check (ZIP mode), list of problems. Audited `EXPORT_VERIFIED`.

### Watermark

`burnWatermark()` (`packages/core/src/custody/watermark.ts`) renders an ASS subtitle script with libass (the
FFmpeg build has libass/fontconfig but **no `drawtext`**): info box bottom-left (export number, evidence number,
recipient, date, optional text), a large diagonal "COPY - NOT ORIGINAL", and a per-second timecode top-right
(`T+hh:mm:ss` and wall-clock `REC` time from `recorded_at`). Output H.264/AAC MP4 (faststart). Requires fonts
(DejaVu) installed in the worker image.

## Fact Sheet

Case/FIR details (case number, title, status, IO, FIR number/year/station, acts & sections, place, brief facts),
item table (evidence number, recording time, duration, officer/device, verified SHA-256), per-item detail
(registered vs verified SHA-256, SHA-512, files in package), export purpose/court/recipient, requesting and
approving officers (rank, name, badge, designation, time), generation time, a statement of integrity, and an
annex: a **pre-filled template** of the certificate under **Section 63(4) Bharatiya Sakshya Adhiniyam, 2023**
(formerly Section 65B(4) Indian Evidence Act), Part A (device list + hash values pre-filled, blanks for name,
designation, place, date, signature) and Part B (expert). The template explicitly says it is an aid, not a
certificate; **the system does not claim legal compliance** — the prosecuting authority must confirm the form.

## Digital signature architecture

`Signer` interface (`packages/core/src/signing.ts`): `sign(data) → {algorithm, keyId, signature, certificatePem,
certificateFingerprint256}`, `verify(data, sig, cert?)`. Today `PemSigner` (PEM key + X.509 from config).
Integration points — all **UNVERIFIED** (no HSM/DSC available here):

* **HSM / PKCS#11**: implement `Signer` with a PKCS#11 session (e.g. `pkcs11js` or `graphene-pk11`), key handle by
  label, `CKM_SHA256_RSA_PKCS` / `CKM_ECDSA_SHA256`; certificate read from the token. Swap in `evidenceSigner()`.
* **Indian DSC (Class 3, USB token)**: same PKCS#11 path with the token vendor's module (ePass/Watchdata/…); the
  signing officer's certificate chains to a CCA-licensed CA. For per-officer signing the signer must run where
  the token is (desktop agent) — the manifest bytes would be sent there and the signature returned.
* **eSign (CCA Aadhaar/eKYC-based online signing)**: an ESP integration returns a PKCS#7 signature over a hash;
  would be stored alongside `manifest.sig` as `manifest.p7s` and verified with `openssl cms -verify`.
* For PDF-embedded (PAdES) signatures of the fact sheet a PDF signing library would be needed; today the PDF is
  covered by the manifest signature only.

## Decisions

* The spec's `download_original` requirement for original exports means seeded IOs (no `download_original`)
  can only request watermarked-only exports; the wizard defaults accordingly. Give court-liaison roles
  `export:create` + `evidence:download_original` where originals must be requested.
* Build errors mark the export `FAILED` (no pg-boss retry): re-request after fixing the cause.
* Packages expire; expiry deletes the object from the exports bucket (not WORM).
