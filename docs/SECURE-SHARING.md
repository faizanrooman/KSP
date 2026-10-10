# Secure sharing (spec module 15)

## Shares API (`apps/api/src/modules/shares`)

| Method | Path | Who |
|---|---|---|
| POST | `/shares` | `share:create`; each item `loadEvidenceFor(…, 'evidence:play')` |
| GET | `/shares?view=mine\|received\|all&status&evidenceId&q&page&pageSize` | `all` needs `share:manage_all` (scoped) |
| GET | `/shares/:id` | creator / in-scope manager (with access log) / internal recipient (reduced) |
| POST | `/shares/:id/revoke {reason}` | creator or `share:manage_all` in scope; deletes the share's watermarked variants at once (`SHARE_WATERMARK_DELETED`) |
| POST | `/shares/:id/unlock {reason}` | same; `LOCKED` → `ACTIVE`, failed attempts reset (`SHARE_UNLOCKED`); expired → 409 (extend first) |
| POST | `/shares/:id/extend {expiresAt, reason}` | same; later than now/current and ≤ now + `maxShareDays`; an EXPIRED share becomes ACTIVE again (`SHARE_EXTENDED`) |
| POST | `/shares/:id/reissue {reason, rotateAccessCode, emailLink, emailAccessCode}` | same, EXTERNAL + ACTIVE: new link (old one stops working), optionally a new code, returned once; optionally e-mailed (`SHARE_LINK_REISSUED`) |
| GET | `/shares/options` | `share:create` / `share:manage_all`: `{emailConfigured, maxShareDays}` |

Body: `{evidenceIds[], caseId?, recipientType: INTERNAL_USER|EXTERNAL, recipientUserId? | recipientName,
recipientEmail, recipientOrg?, purpose, allowDownload=false, allowOriginal=false, allowPrint=false,
watermark=true, maxViews?, expiresAt, emailLink=false, emailAccessCode=false}`.

Rules: `expiresAt` in the future and ≤ `shareExportPolicy.maxShareDays`; `allowDownload` (and an unwatermarked
external share) require the sharer to hold `evidence:download_original` over each item (403 +
`EVIDENCE_ACCESS_DENIED`); `allowOriginal` requires `allowDownload` (DB CHECK too). `SHARE_CREATED` per item
(recipient and permissions; never the token or code).

* **INTERNAL_USER**: visibility is granted by the canonical rule in `lib/access.ts` (active, unexpired share
  targeting the user); `allow_download` lets the recipient download the original. Revocation removes access at
  once.
* **EXTERNAL**: response contains `link` (`<APP_BASE_URL>/s/<token>`), `token` and an 8-digit `accessCode`
  **once**. Stored: `token_hash = sha256(token)`, `access_code_hash = argon2id(code)`. Send link and code through
  different channels.

Cron `shares.expire` (every 5 min): ACTIVE shares past expiry → `EXPIRED` + `SHARE_EXPIRED` per item; watermarked
variants of non-active (expired / locked / revoked-but-not-yet-deleted) shares are deleted with `SHARE_WATERMARK_DELETED`
per item (`deleteShareVariants`, `packages/core/src/shares.ts`). An unlocked or extended share regenerates its
variants on demand at the next `/open`.

### E-mail delivery (SMTP, `ALERT_SMTP_URL` — see DASHBOARDS-REPORTS-ALERTS.md)
* `emailLink` sends the link to `recipientEmail` (sender name, expiry, "the access code comes separately").
  **The access code is not in that e-mail.** Default in the UI when SMTP is configured: link by e-mail, code
  communicated out-of-band (phone / SMS / in person).
* `emailAccessCode` (requires `emailLink`) additionally sends the code in a **separate** message to the same
  address. **Trade-off**: link and code were designed as two factors on two channels; e-mailing both means anyone
  who controls or reads that mailbox (compromised account, shared office inbox, mis-typed address) can open the
  share. The UI marks it "not recommended". Use only when no second channel exists and the share is short-lived,
  watermarked and limited by `maxViews`.
* Each message is audited per item as `SHARE_LINK_SENT` (`content` LINK | ACCESS_CODE, outcome FAILURE with the
  relay error); the token and code are never written to the audit trail. Relay failures do not undo the share;
  the response reports `delivery.link|accessCode = SENT | FAILED | NOT_REQUESTED`.
* The stored token and code are hashes, so a "resend" is a **re-issue**: a new link (and optionally a new code).
  Portal sessions already opened with the old link (stateless, ≤ 30 min) stay valid until they expire.
* Tested against a local SMTP sink; a real relay is **UNVERIFIED**.

### maxViews for internal shares
`maxViews` also applies to INTERNAL_USER shares (`apps/api/src/lib/share-views.ts`): when the recipient loads the
evidence detail or requests playback **and the item is visible to them only through shares**, the first such
open of the item within 30 minutes counts one view (`view_count`, `share_access_log` VIEW `internal:<userId>`,
`SHARE_ACCESSED` details `via: internal`); jurisdiction / case / own access never counts, and an unlimited share
covering the item means nothing is counted. Once `view_count ≥ max_views` and the last counted open is older than
30 minutes, the share stops granting visibility (rule 4 in `lib/access.ts`, also for share-based downloads).

### Internal recipients who already have access (2026-10-10)
A share only *adds* access; it cannot restrict access the recipient already holds through their own jurisdiction,
their own evidence or a case team. Such a share would show an expiry, a view limit and a download setting that do not
apply, so `POST /shares` refuses it: **409 `RECIPIENT_ALREADY_HAS_ACCESS`** with `details.evidenceIds` /
`evidenceNumbers` of the covered items (check: `evidenceVisibleSql(recipient, { shares: false })`). Shares created
before this rule, or whose recipient gained access later, are flagged in `GET /shares/:id`
(`items[].recipientHasOwnAccess`, managers only) and the detail page explains that the limits do not apply.
Officers without `share:create` / `share:manage_all` see a receive-only **Shared with me** entry instead of **Shares**.

## External portal (`/api/v1/share-portal`, all `config.public`)

| Method | Path | |
|---|---|---|
| POST | `/open {token, code}` | rate-limited 10/min/IP; returns a session token + share + items |
| GET | `/session` | header `X-Share-Session` |
| GET | `/items/:evidenceId/playback` | 202 `PREPARING` until the watermarked variant exists, then `{mp4Url, expiresAt}` |
| GET | `/items/:evidenceId/download-link?variant=watermarked\|original` | needs `allowDownload` (/`allowOriginal`) |
| GET | `/download/:evidenceId?t=` | SHARE media token (scope `download`, ref variant) |
| GET | `/items/:evidenceId/print?timeMs=` | needs `allowPrint`; PNG frame of the watermarked variant |

* Wrong code → 401 with `attemptsRemaining`; the 5th failure sets `LOCKED` (`SHARE_LOCKED`); a locked share
  refuses even the right code (423). Unknown link → generic 401 (timing equalised).
* Revoked/expired → 410, `maxViews` reached → 403 `SHARE_VIEW_LIMIT`. A *view* is a successful `/open`.
* Session tokens: HMAC (key derived from `MEDIA_TOKEN_SECRET`), 30 min, bound to one share id, sent in a header
  (not a cookie), re-validated against the share on every call.
* Media tokens: `typ: 'SHARE', sub: shareId, eid, scope, wm: "<name> <email> | share <id> | <timestamp>"`, TTL
  10 min. `authenticateMediaToken` re-checks the share is ACTIVE, unexpired, EXTERNAL and contains the item.
* Every access → `share_access_log` (`OPEN, STREAM, DOWNLOAD, PRINT, DENIED, CODE_FAILED`) and the audit ledger
  (`SHARE_ACCESSED`, `SHARE_DOWNLOADED`, `SHARE_PRINTED`, `SHARE_ACCESS_DENIED`, actor `EXTERNAL_RECIPIENT`,
  id = share id). Playback access is audited at most once per share+item per 10 minutes.
* No storage URL is ever returned (asserted in tests).

## Watermarked playback — approach and justification

**Chosen: a per-share watermarked proxy variant generated on demand** by the worker queue `share.watermark`
(`apps/worker/src/jobs/shares`), burned in with libass (see COURT-EXPORT.md → Watermark): recipient name, e-mail,
organisation, share id, issue date, evidence number, "COPY - NOT ORIGINAL" diagonal and a running timecode.
Stored in the derived bucket at `evidence/<evidenceId>/shares/<shareId>/watermarked.mp4`
(`evidence_derivatives.kind = WATERMARKED`, `meta.shareId`), audited `SHARE_WATERMARK_GENERATED`. `/open`
pre-queues generation for every item; playback returns 202 until ready.

Why not dynamic per-segment HLS overlay: it would re-encode on every request inside the API (CPU per viewer,
latency, and an ffmpeg process per segment), and caching per-segment output amounts to the same per-share file.
A single faststart MP4 per share+item is cheap for BWC clip lengths, cacheable, range-streamable, identical for
view/download/print, and keeps FFmpeg in the worker. Trade-off: first view waits for one encode (seconds for
short clips; roughly real-time/N for long ones).

**Media route confinement** (`apps/api/src/modules/media/index.ts`): a SHARE token on `/media/stream` can fetch
**only** the WATERMARKED derivative whose `meta.shareId` equals the token's share (or, for a share created with
watermarking disabled, the plain proxy MP4) — never HLS, posters, sprites or other shares' variants. SHARE tokens
are refused on `/media/image`; on `/media/download` (the original) they require `allow_download AND
allow_original` and `ref = 'original'`. USER tokens cannot fetch share variants.

**Download**: watermarked copy by default; the original only when the share explicitly has `allowOriginal` —
which requires the sharer to hold `download_original` over every item. **Print**: a watermarked still (PNG of
the watermarked variant at the current position), opened in a print window.

## Web

* Evidence action **Share** (`canShare`): internal user via `UserPicker` or external recipient; permissions;
  expiry; max views (internal and external); for external recipients "E-mail the link" (default on when SMTP is
  configured) and the opt-in "Also e-mail the access code". External link and code are shown once with copy buttons.
* **Shares** (Sharing & Export): shared by me / with me / all in jurisdiction; detail with permissions, items,
  access log, revoke (with reason), **Unlock** (locked shares), **Extend** and **Re-issue / Re-send link by
  e-mail** (external).
* **Public portal `/s/:token`** (`publicRoutes`, no app shell): access-code form (remaining attempts, blocking
  notices), share info (purpose, sender, expiry, views), item list, watermarked player (no download control,
  no PiP, no context menu unless downloads are allowed), download / print buttons only when permitted.
  Verified end-to-end in headless Chrome against the running API + worker (wrong code message, watermarked
  video playing, no download button, no storage URLs).

## Known limits

* Deterrence, not DRM: a recipient can still screen-record; the burned-in identity makes leaks attributable.
* Internal shares do not use watermarking (internal users use the standard player and custody audit).
