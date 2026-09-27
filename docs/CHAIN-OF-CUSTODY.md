# Chain of custody (spec module 13)

The chain of custody of an evidence item is the set of audit-ledger rows with `audit_events.evidence_id = <id>`
(see [AUDIT.md](AUDIT.md) for the ledger itself). Every evidence touch (registration, view, play, download,
snapshot, share, export, integrity check, hold, disposal, …) writes such a row via `appendAudit` in the same
transaction as the change. Actions flagged `custody: true` in `packages/shared/src/audit.ts` are the "custody
events"; the view also shows other evidence-linked events.

## API

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/v1/custody/evidence/:id` | `custody:read` + visibility (`loadEvidenceFor(…, 'custody:read')`) | 404 outside jurisdiction |
| GET | `/api/v1/custody/evidence/:id/report.pdf` | same | signed PDF; audits `CUSTODY_REPORT_GENERATED` |

Response of the timeline:

```json
{ "evidence": { "id", "evidenceNumber", "sha256", "sha512", "status", … },
  "events": [{ "seq", "eventId", "occurredAt", "action", "category", "custody", "outcome",
               "actor": { "type", "id", "username", "name" }, "ip", "resourceType", "resourceId",
               "caseId", "details", "prevHash", "hash", "verified" }],
  "verification": { "chainIntact", "eventsChecked", "brokenSeqs", "ledgerHead": { "seq", "hash" }, "verifiedAt" } }
```

**Per-event verification** (`packages/core/src/custody/ledger.ts`) is done in SQL for every row:
`hash = sha256(prev_hash || '|' || audit_canonical(row))` (content unchanged) and
`prev_hash = hash of ledger row seq-1` (linkage unchanged). `chainIntact` is true only if every row passes.
Details are sanitised (keys that look like secrets are redacted) before display.

## Signed Chain-of-Custody report

`buildCustodyReport()` builds a canonical JSON payload (sorted keys) of: evidence identity + SHA-256/512,
registration details (unit, uploader, officer, device, recording times, GPS, linked cases), every event, and the
verification result. The payload is signed with `evidenceSigner()` (detached signature). The PDF (pdfkit, A4)
prints sections 1–5, the payload SHA-256, algorithm, key id, certificate fingerprint and the signature, a
verification QR code (evidence number, evidence SHA-256, payload SHA-256, key id, fingerprint, signature), and
**embeds three attachments**: `custody-payload.json`, `custody-payload.sig` (raw signature bytes),
`signing-cert.pem`. The PDF is written uncompressed so attachments are also extractable with plain tools.

Offline verification (tested in `apps/api/test/custody.test.ts` with the openssl CLI):

```sh
openssl x509 -in signing-cert.pem -pubkey -noout > signing-pubkey.pem
openssl dgst -sha256 -verify signing-pubkey.pem -signature custody-payload.sig custody-payload.json   # Verified OK
```

Response headers: `X-Payload-SHA256`, `X-Signature-Algorithm`, `X-Signing-Key-Id`, `X-Certificate-Fingerprint`.

The report states that it is a record of system events and **not** itself a certificate under Section 63 of the
Bharatiya Sakshya Adhiniyam, 2023.

## Web

Evidence tab **Chain of custody** (order 60, `modules/custody/evidence-tabs.tsx`): chain-intact / broken banner,
timeline (custody events or all linked events) with actor, time, IP, seq and hash, an event drawer showing
hash / previous hash / details, and **Signed report (PDF)**.

## Decisions / limits

* Viewing the custody timeline is not itself audited (it would append to the very chain being viewed on every
  refresh); generating the signed report is audited.
* Timeline is capped at 20 000 events per item.
* PDF text (custody report, export Fact Sheet, report PDFs) uses the bundled **Noto Sans** and **Noto Sans
  Kannada** (SIL OFL 1.1; `packages/core/assets/fonts/`, licence files alongside, SHA-256 pinned in `fonts.json`
  and checked every time the fonts are loaded; `node packages/core/scripts/fetch-fonts.mjs --check` re-verifies,
  without `--check` it re-downloads from the pinned upstream commit). Kannada runs are shaped with **HarfBuzz**
  (`harfbuzzjs`) because pdfkit's fontkit shaper picks one script per line and misses Indic ligatures (e.g. ಜ್ಞಾ);
  each Kannada word carries `/ActualText`, so copy/paste and `pdftotext` return the original Unicode. Mixed
  Latin/Kannada lines are laid out by `packages/core/src/custody/pdf-text.ts` (script runs, shared baseline,
  word wrap). Hashes/identifiers stay in Courier. Characters of other scripts (Devanagari, CJK, …) print as `?`
  — add the matching Noto face to extend coverage. Tests: `packages/core/test/pdf-kannada.test.ts` (glyph runs
  identical to HarfBuzz for a conjunct corpus, pdftotext round-trip, embedded subset fonts, 300 dpi raster vs an
  outline reference), plus Kannada assertions in `apps/api/test/custody.test.ts` and `apps/worker/test/reports.test.ts`.
  Images ship the fonts (`deploy/docker/Dockerfile` copies `packages/core/assets`; override with `PDF_FONTS_DIR`).
