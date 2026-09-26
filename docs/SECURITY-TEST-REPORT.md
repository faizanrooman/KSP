# Security test report (internal engineering assessment)

> **This is an internal engineering security assessment carried out by the development team's security-testing
> workstream. It is NOT a CERT-In empanelled VAPT and must not be presented as one.** A CERT-In empanelled VAPT is
> still required before production (see `docs/KNOWN-ISSUES.md`).

Date: 2026-09-25 · Branch: security testing worktree (merged with main at `3545202`) · Threat model: `docs/THREAT-MODEL.md`

## Scope & methodology

Scope: Fastify API (all routes registered by `buildApp`, including dashboards/reports/alerts/system merged from main),
pg-boss worker media pipeline, AI worker (`ksp_ai`), PostgreSQL roles/triggers, crypto helpers, web app (static review
only), dependencies and git history. Method: grey-box — code review of security-critical paths plus automated tests
that run against the real stack (PostgreSQL 16 on :5433, versitygw S3, real FFmpeg 7.0.2), no mocks of our own
services. Every fix has a regression test. Test fixtures are generated and kept small inside per-run temp dirs.

## Tools & versions

| Tool | Version | Used for | Result |
|---|---|---|---|
| Vitest (+ Fastify inject) | 3.2.x | security test suites below | see results |
| npm audit | npm 10.9.9 | dependency CVEs | `--omit=dev`: 2 moderate · full: 4 moderate · 0 high/critical |
| Semgrep | 1.178.0 (`p/nodejs p/typescript p/secrets p/owasp-top-ten`) | SAST over apps, packages, scripts, db | 5 findings: 1 true positive (fixed, SEC-05), 4 false positives |
| Gitleaks | 8.28.0 (`stdin` mode over `git log -p HEAD`, 95 commits) | secrets in history | 2 findings, both false positives; no private keys or `.env` files ever committed |
| ffprobe/ffmpeg | 7.0.2 static | malicious-media experiments | — |
| Trivy | — | container/IaC scanning | **UNVERIFIED**: download failed (network error); no Dockerfiles on main |

## Test suites added

| File | What it proves |
|---|---|
| `apps/api/test/security-routes.test.ts` | Enumerates **every** route via `app.routeRegistry` (onRoute hook): public routes equal a reviewed 15-entry allow-list; every other route → 401 unauthenticated; every POST/PUT/PATCH/DELETE → 403 `CSRF_FAILED` with cookies but no/wrong CSRF header or a hostile Origin; an API client gets 403 `API_CLIENT_ROUTE_FORBIDDEN` on every route outside `/integration/*` and `/media/download/*`; `..`/`%2e%2e`/double-slash/case URL variants do not bypass auth |
| `apps/api/test/security-ssrf.test.ts` | Integration `base_url` refuses loopback in decimal/hex/octal/short forms, IPv6 loopback/mapped/IPv4-compatible, cloud metadata (AWS/GCP/Alibaba/ECS), RFC1918, link-local, ULA, `.local`/`.internal`/localhost names, `file:`/`gopher:`/`ftp:`/`dict:`/`ldap:`/`javascript:` schemes, embedded credentials; https-only in production; connect-time DNS check refuses a name resolving to loopback |
| `apps/api/test/security-media-input.test.ts` | HLS playlists (named `.m3u8`, `.mp4`, no extension) and ffconcat scripts are rejected **without opening referenced files**; text/zero-byte/PNG payloads rejected; real mp4/mkv/avi still probe |
| `apps/api/test/security-db-privileges.test.ts` | As `ksp_app`: UPDATE/DELETE/INSERT/TRUNCATE refused on audit ledger, checkpoints, evidence delete, integrity checks, case notes, share access log, AI review events, detections, legal-hold events; registered evidence integrity columns and **jurisdiction** immutable. As `ksp_ai`: no read of evidence/users/sessions/refresh tokens/audit/api clients/shares/cases; no review-column update; no job/model tampering; no detection insert for a non-running job |
| `apps/api/test/security-headers.test.ts` | CSP (`frame-ancestors 'none'`, `object-src 'none'`, `script-src 'self'`), nosniff, CORP, no `X-Powered-By`; hostile Origin gets no CORS grant; session cookies httpOnly + SameSite=Strict; malformed JSON/unknown routes leak no stack traces or paths |
| `apps/api/test/security-crypto.test.ts` | AES-256-GCM secrets: truncated tag, modified ciphertext/IV, wrong key all refused |
| `apps/ai-worker/test/security-watchlist.test.ts` | Watchlist stills decode under the image whitelist; decode errors contain no server paths |

## Results by category

| # | Category | Result | Evidence |
|---|---|---|---|
| 1 | Route-level authz sweep | **PASS** (after review of 15 public routes) | `security-routes.test.ts` |
| 2 | IDOR / jurisdiction matrix | **PARTIAL** — per-module 404-for-other-jurisdiction tests exist (CONTRACTS §4); the single data-driven matrix across all `:id` routes was **not built** | existing module tests |
| 3 | Privilege escalation / mass assignment / SoD races | **NOT TESTED** in this assessment beyond existing admin tests (grantor rule, SoD, self-modification, last-admin) | `admin-*.test.ts`, `security-authz.test.ts` |
| 4 | Auth/session attacks | **PARTIAL** — JWT verification pinned to EdDSA + iss/aud/typ (code review); refresh reuse, lockout, idle/absolute timeouts, concurrent sessions covered by existing tests; login timing not measured | `auth.test.ts`, `security-authz.test.ts` |
| 5 | Media/token attacks | **PARTIAL** — code review of token binding (evidence, scope, ref, session/share/client re-check); SEC-03/SEC-04 fixed; a dedicated token-tampering/traversal/Range test suite was **not completed** | `media.test.ts`, code review |
| 6 | Upload / malicious files | **PARTIAL** — playlist/concat demuxer following found and fixed (SEC-01); chunk-number/size abuse, filename/RTL/CRLF, zip-slip/zip-bomb in `/exports/verify` **not tested** (download filenames are sanitised by `safeFilename`, code review) | `security-media-input.test.ts` |
| 7 | Injection | **PASS (review)** — all SQL via Kysely/`sql` tagged templates (Semgrep hits are false positives); no `dangerouslySetInnerHTML`/`innerHTML`/`eval` in `apps/web/src`; both CSV writers neutralise `= + - @ TAB CR`; PDF/log injection **not tested** | grep, Semgrep |
| 8 | SSRF | **PASS** after SEC-02 | `security-ssrf.test.ts` |
| 9 | Headers / CORS / cookies | **PASS** in test mode; HSTS + `Secure` cookies in production mode **not exercised** (config-driven: `COOKIE_SECURE`) | `security-headers.test.ts` |
| 10 | Rate limiting | **NOT TESTED** — limits exist in code but are relaxed under `NODE_ENV=test` | code review |
| 11 | DB-level controls | **PASS** after SEC-06 | `security-db-privileges.test.ts` |
| 12 | Static & supply chain | **DONE** — see tools table; moderate advisories open | — |
| 13 | Container scanning | **UNVERIFIED** | — |

## Findings

CVSS-style ratings are the assessor's estimates (CVSS v3.1 base vector reasoning), not formal scores.

| ID | Title | Severity | Component | Status | Fix / test |
|---|---|---|---|---|---|
| SEC-01 | ffprobe/ffmpeg selected the HLS demuxer for uploaded playlists and tried to open files/URLs named inside them (local file read / SSRF surface from the worker) | **High** (AV:N/PR:L, S:C; impact limited by protocol whitelist and non-video rejection) | core media, ingest inspect, worker transcode | Fixed | `67fda52` · `security-media-input.test.ts` |
| SEC-02 | Egress guard did not restrict IPv4-compatible IPv6 (`::/96`, e.g. `[::127.0.0.1]`) | Medium | integrations egress | Fixed | `67fda52` · `security-ssrf.test.ts` |
| SEC-03 | Report download accepted tokens from idle-expired sessions (checked revoked + absolute only) | Low | reports | Fixed | `c66206e` · route sweep + `reports.test.ts` |
| SEC-04 | `/media/download` accepted any USER download token regardless of `ref` (report tokens not domain-separated; not exploitable today because ids never collide) | Info (hardening) | media | Fixed | `c66206e` |
| SEC-05 | AES-256-GCM decryption accepted truncated auth tags (verified: Node 22 accepts a 4-byte tag) | Low (requires DB write access) | core crypto | Fixed | `df6e219` · `security-crypto.test.ts` |
| SEC-06 | `evidence.org_unit_id`/`org_path` writable by `ksp_app` after registration — silent jurisdiction move possible from a compromised app connection | Medium (defence in depth) | DB | Fixed (migration 0990) | `f61b035` · `security-db-privileges.test.ts` |
| SEC-07 | Watchlist `embeddingError` returned server filesystem paths to watchlist managers | Low (info disclosure) | ai-worker | Fixed | `f61b035` · `security-watchlist.test.ts` |
| SEC-08 | npm advisories: `react-router` (open redirect via backslash; SSR deserialisation — SSR not used), `vitest`/`@vitest/mocker` (dev only) | Moderate | dependencies | Open — upgrade `react-router-dom` when a fixed minor is available; vitest is dev-only | — |
| SEC-09 | Operators with `system:monitor` can trigger reprocessing of any evidence id and learn existence (202 vs 404) outside their jurisdiction | Low | media reprocess | **Fixed in round 2** — scoped to the jurisdiction of the `system:monitor` grant; out of scope = 404 | `security-media.test.ts` |

Also found and fixed during setup: HEAD at the time broke `npm ci` (`EOVERRIDE`); main has since removed the override block.

## OWASP Top 10 (2021) mapping

| OWASP | Coverage |
|---|---|
| A01 Broken Access Control | Route sweep, API-client confinement, DB privileges, SEC-03/04/06; IDOR matrix partial |
| A02 Cryptographic Failures | GCM tag pinning (SEC-05); EdDSA JWT; HMAC media tokens with timing-safe compare (review) |
| A03 Injection | Kysely parameterisation, CSV neutralisation, React escaping (review) |
| A04 Insecure Design | Threat model; SoD and 404-not-403 decisions reviewed |
| A05 Security Misconfiguration | Headers/CORS/cookies test; production HSTS not exercised |
| A06 Vulnerable Components | npm audit (SEC-08) |
| A07 Identification & Authentication Failures | Existing auth tests + JWT review; timing not measured |
| A08 Software & Data Integrity Failures | Audit ledger append-only (DB test); Object Lock (existing tests) |
| A09 Logging & Monitoring Failures | Auth/access-denied auditing (existing tests); log injection not tested |
| A10 SSRF | SSRF suite + SEC-01, SEC-02 |

## ASVS 4.0 Level 2 (selected chapters)

| ASVS | Status |
|---|---|
| V2 Authentication | Mostly met (Argon2id, lockout, MFA); timing and rate-limit triggering not verified here |
| V3 Session Management | Met for cookie flags, revocation, timeouts (tests); SEC-03 fixed |
| V4 Access Control | Met for route-level checks (sweep); object-level matrix partial |
| V5 Validation, Sanitisation & Encoding | Zod on inputs; CSV/HTML encoding reviewed; strictness (`.strict()`) against mass assignment not assessed |
| V6 Stored Cryptography | Met after SEC-05; keys not in HSM (external dependency) |
| V8 Data Protection | No-store on media; error hygiene tested |
| V12 Files & Resources | Demuxer whitelist (SEC-01); zip handling not tested |
| V13 API | CSRF + CORS tested |
| V14 Configuration | Headers tested; containers UNVERIFIED |

## Not covered (explicitly)

> Round 2 (below) closed most of this list; see "Round 2 — still not covered" for what remains.

Data-driven IDOR matrix across every `:id` route; mass assignment / Zod strictness; concurrent approval races;
JWT alg-confusion and mfa-token-as-access **as tests** (reviewed in code only); login timing measurement; rate-limit
triggering; dedicated media-token tampering / path traversal / Range abuse tests; chunk upload abuse; filename and
header injection tests; zip-slip / zip bomb on `/exports/verify`; PDF and log injection; production-mode HSTS/Secure
cookies; browser-based XSS testing; container images; load/DoS; mTLS integration path; real CCTNS endpoints.

## Residual risks

FFmpeg memory-safety bugs in allowed demuxers/decoders (run workers sandboxed, patched, without network beyond S3);
media tokens are bearer secrets for their TTL; DB owner/superuser can bypass triggers (detected by the hash chain, not
prevented); S3 Object Lock GOVERNANCE can be bypassed by privileged principals; secrets keys are not HSM-backed.

## Recommendations for the external (CERT-In empanelled) VAPT

Prioritise the items in "Not covered"; in particular object-level authorization across all resources, the upload
chunk protocol and export ZIP verification, share-portal brute force and rate limits in a production-configured
build, the media pipeline with a fuzzing corpus, and container/Kubernetes configuration once images exist.

---

## Round 2 (2026-09-26) — gap closure

Same method and caveat as above (internal, grey-box, real stack; **not** a CERT-In VAPT). Every fix has a regression
test; all API suites green (`npm test -w @ksp/api`).

### Suites added (apps/api/test)

| File | What it proves |
|---|---|
| `security-idor.test.ts` (+ `security-support.ts`) | **Data-driven IDOR matrix.** One object of every kind is created in ps_cubbonpark (evidence, snapshot derivative, upload batch + session, FIR, case + note, workspace + item + timeline event, bookmark, annotation, relation, internal share, export, AI job + detection, saved search, report run, alert + notification, disposal request, device, session, role assignment, audit seq). **Every** registered route with an id parameter (115 routes, from `app.routeRegistry`) is called with those ids by three probers — `io.arjun` (IO, other station), `fo.ravi` (FO, same station) and a supervisor-equivalent at ps_indiranagar holding ~30 permissions — with bodies generated from each route's OpenAPI schema so the call passes validation and reaches authorization. Oracle: the response for the real foreign id must equal (status + error code) the response for a random non-existent id, never 2xx, never contain the owner's marker text; the owner's GETs return 2xx (ids are real). Result: 345 probes, no 2xx, no leak, no existence oracle. Reviewed exception: `fo.ravi` on `/devices/:id*` — same-station devices are legitimately visible with `devices:read`; management answers 403 (visible non-evidence object, missing permission). |
| `security-mass-assignment.test.ts` | status / org / org_path / owner / creator / author / sha256 / review_status / permissions / is_system / approved_by / allow_original / legal_hold / storage_key / password_hash / MFA extras on evidence PATCH, case, note, workspace, annotation, saved search, tag, role and user bodies: nothing takes effect (checked in the DB). Strict bodies (exports incl. nested options, shares, uploads, upload batches, quarantine decisions, review decisions + bulk, AI jobs) reject unknown keys with 400; the same bodies without extras are accepted (web and station-client call sites checked). |
| `security-races.test.ts` | Truly concurrent requests: 4 approvals of one export by two approvers → exactly one 200, the rest 409, one EXPORT_APPROVED; approve vs reject → one decision; 6 concurrent self-approvals → all 403 SoD; disposal: 2 approvers + 1 rejecter → one decision; concurrent disposal self-approval → 403; 6 concurrent upload completes → one evidence row, all 200 (SEC-10); concurrent same-part PUTs → one part row; 6 concurrent refreshes of one refresh token → exactly one rotates, the replay revokes family + session (the winner's new tokens die too); one recovery code used concurrently → one session (SEC-12). |
| `security-auth.test.ts` | alg=none (both spellings), HS256 signed with the Ed25519 public key (algorithm confusion), expired, wrong iss, wrong aud, `typ:'mfa'` as access, missing typ, foreign sub, unknown sid, tampered payload, garbage — all 401 via Bearer and via cookie. mfaToken is not an access token (even with a real session id) and vice versa. Logout kills access + refresh; password change kills every other session immediately; disabling a user kills existing tokens and refresh. Session fixation: planted cookies (incl. an attacker-chosen CSRF cookie) are all rotated at login. MFA lockout (SEC-11), TOTP single use (SEC-12). **Login timing**: 30 interleaved attempts each, existing user median 16.5–18.3 ms vs non-existing 15.4–15.9 ms over three runs (median diff < 25 % asserted; mean diff 15–19 %, caused by the extra `failed_login_count` UPDATE for real users — argon2 verification runs in both cases via the dummy hash). |
| `security-production.test.ts` | `buildApp()` with `NODE_ENV=production` + `COOKIE_SECURE=true` (the environment is flipped; no code path is weakened): **429** after 10/min on login, MFA verify, share-portal open and password change, after 120/min on upload initiation (new limit); standard error envelope. HSTS `max-age=31536000; includeSubDomains`; `ksp_at`/`ksp_rt`/`ksp_csrf` `Secure` + `SameSite=Strict`, access/refresh `HttpOnly`, refresh path-scoped; `/api/docs*` 401 until authenticated; an internal error carrying a sensitive message renders only `{code:'INTERNAL', message:'Internal server error'}`. |
| `security-media.test.ts` | Media tokens: payload edits (eid, exp), MAC flip / truncation / missing, junk, expired → 401; token for A on B → 403; image → stream/download, stream → download/image, download → stream/image → 403; image token bound to one derivative; token dead after logout; forged USER token with another user's sid → 401. SHARE tokens: no HLS / proxy / poster / sprite for a watermarked share, no image endpoint, no original without allow_original, share X cannot read share Y, revocation kills tokens. **Path traversal** on `/media/stream/:id/*` — `../`, `%2e%2e`, `%2E%2E%2F`, double-encoded, `..%2f`, backslash and `%5c`, NUL (`%00` and raw), absolute keys, `//host`, deep paths — never escapes `evidence/<id>/`, also over a raw socket (no client normalisation). **Range**: huge, negative suffix, `-0`, inverted, multi-range, garbage, other unit, beyond size (416 + `bytes */size`), tail → never 5xx, never over-read. SEC-09 reprocess scope. |
| `security-uploads.test.ts` | Part numbers `0`, `-1`, `> total`, `> MAX_CHUNKS`, 20-digit overflow, `1.5`, `abc`, `1e3` → 4xx and nothing stored; size ±1 byte → CHUNK_SIZE_MISMATCH; wrong / missing chunk hash; wrong content type; declared size `MAX_SAFE_INTEGER` / `1e300` → 413, ≤ 0 → 400, chunkSize 1 clamped to 5 MiB; another user's session → 404 for parts / complete / abort. Filenames: `../../etc/passwd.mp4` → `passwd.mp4`, backslash traversal stripped, CR/LF/NUL removed, extension whitelist (`.exe`, `.mp4.exe` refused), > 1024 chars refused, stored ≤ 255. A real item uploaded as `evid"ence<RLO>gpj.<CRLF>X-Injected: 1;مرحبا.mp4` registers and downloads with `attachment; filename="[A-Za-z0-9._-]+"; filename*=UTF-8''…` and no injected header. SEC-13. |
| `security-export-verify.test.ts` | Zip-slip names (`../`, `a/../../`, `/etc/passwd`, backslash, nested) → 400; a 1.3 MB archive inflating to 300 MB, a 40 MB zero entry (ratio ≫ 100), 10 050 entries and a 50 000-item JSON manifest → refused fast (SEC-14); random bytes / truncated / empty / 0-byte → 4xx; flipped data byte → report `ok:false`; no stack traces. |
| `security-injection.test.ts` | Formula payloads (`=HYPERLINK`, `+cmd\|`, `-2+3+cmd`, `@SUM`, TAB, CR) in evidence title/location and in attacker-chosen login usernames (recorded as `actor_name`): report CSV and audit CSV export contain no formula-leading cell and no forged record (constant column count). PDF operator / CRLF / `/JavaScript` action text in an evidence description and a case title: custody PDF and report PDF stay valid, the text is rendered as text (pdftotext), no `/OpenAction` or `/AA`, and the only raw occurrences are inside the signed, length-delimited, JSON-escaped `custody-payload.json` attachment. Logs: pino keeps CRLF inside one JSON record; an `x-request-id` with CRLF cannot split response headers. |

### Round-2 findings (numbering continues)

| ID | Title | Severity | Component | Status | Fix / test |
|---|---|---|---|---|---|
| SEC-10 | Concurrent `POST /uploads/:id/complete`: the state check ran before the row lock, so racing requests reset `COMPLETED → COMPLETING` and hit the unique `evidence.upload_session_id` constraint — 500s and a session transiently in the wrong state (integrity held: one evidence row) | Low | uploads | Fixed — state re-checked under `FOR UPDATE`; a completed session returns the idempotent view | `1eaccfb` · `security-races.test.ts` |
| SEC-11 | `/auth/mfa/verify` ignored `locked_until`: after the lockout threshold the second factor could still be guessed for the 5-minute life of each mfaToken (TOTP brute force by a password holder, bounded only by the per-IP rate limit) | Medium | auth | Fixed — a locked account gets 423 at the MFA step | `1eaccfb` · `security-auth.test.ts` |
| SEC-12 | TOTP codes were reusable inside their ±1 step window (RFC 6238 §5.2; a phished / shoulder-surfed code replayable for ~60–90 s), and one recovery code used concurrently opened several sessions (read-modify-write) | Medium | auth | Fixed — `users.mfa_last_totp_step` (migration `0991`) with an atomic conditional update (enrolment code consumed too); recovery code removed atomically (`array_remove … WHERE code = ANY(...)`) | `1eaccfb` · `security-auth.test.ts`, `security-races.test.ts` |
| SEC-13 | Upload metadata `officerId` / `officerBadge` / `deviceSerial` resolved statewide: any uploader could attribute footage to — and via `evidence:read_own` make it visible to — any officer in the state, and enumerate badges / serials across districts | Medium | uploads | Fixed — officer must be homed inside the uploader's `evidence:upload` scope or in a unit above the target station; device must be in scope; out of scope = unknown (no oracle) | `185fc84` · `security-uploads.test.ts` |
| SEC-14 | `/exports/verify` had no inflate limits (a 1.3 MB zip inflated 300 MB per request) and looked up every manifest item in the DB (50 000 items = 5.6 s per request) — authenticated DoS for any export / audit role | Medium | exports | Fixed — ≤ 10 000 entries, ≤ 256 MiB inflated (declared sizes enforced by yauzl `validateEntrySizes`), ratio ≤ 100 for entries > 1 MiB, backslash names refused, manifests > 1 000 items / 10 000 files not looked up | `7c53d1d` · `security-export-verify.test.ts` |
| SEC-15 | Upload initiation had no per-route rate limit (only the global 1200/min/IP) although each initiation creates an S3 multipart upload | Low | uploads | Fixed — 120/min/IP in production | `185fc84` · `security-production.test.ts` |
| SEC-16 | A PostgreSQL backend dying under a checked-out connection (DB restart, crash recovery, failover, admin kill) emitted an unhandled `'error'` on the pg Client and **terminated the API process** (observed during load testing when the DB restarted). Same pool code is used by worker and AI worker | Medium (availability) | core db | Fixed — error listeners on the pool and on every client; in-flight queries still reject, the pool reconnects | `7f8be0a` · the API then survived 4 PostgreSQL crash-restarts during load runs (`docs/PERFORMANCE.md`) |
| SEC-18 | Trivy: `react-router` 6.30.6 CVE-2026-53666 / CVE-2026-53669 (MEDIUM, fixed only in 7.18.0 — a major upgrade); same package as SEC-08 | Moderate | web deps | Open — plan the react-router 7 migration (SSR not used; the open redirect needs a crafted in-app link) | — |
| — | Mass assignment | — | all bodies | **No finding** — Zod already stripped unknown keys before every handler; hardening only (`.strict()` on the security-relevant bodies) | `67cde2e` · `security-mass-assignment.test.ts` |

SEC-09 (round 1) is fixed in this round: reprocess by `system:monitor` holders is limited to the jurisdiction of that
grant (`185fc84`). SEC-17 is intentionally unused.

### Trivy 0.74.0 (release binary from GitHub, checksum verified)

`trivy fs --scanners vuln,secret,misconfig --skip-dirs node_modules --skip-dirs .local --skip-dirs .claude .` and
`trivy config deploy/`:

* **Vulnerabilities** (package-lock.json, production dependencies): 2 × MEDIUM, both `react-router` (SEC-18); 0 HIGH / CRITICAL.
* **Secrets**: none.
* **Dockerfile** (`deploy/docker/Dockerfile`): 0 misconfigurations.
* **Kubernetes** (raw base manifests, before kustomize): KSV-0013 `:latest` and KSV-0125 untrusted registry — false
  positives for the rendered output (the kustomizations pin `ghcr.io/ksp/*:1.0.0`); KSV-0110 default namespace — false
  positive (`namespace: ksp-vms` set by kustomize); KSV-0109 / KSV-01010 "ConfigMap with secrets" — `ksp-config` holds
  only TTLs, ports and `file:` paths (false positive); `ksp-ai-config` holds **inert placeholders** for settings the AI
  worker never uses (all-zero `DATA_ENCRYPTION_KEY`, placeholder `MEDIA_TOKEN_SECRET`) — accepted, but better to make
  those settings optional for the AI worker so no key-shaped value lives in a ConfigMap; KSV-0020 / KSV-0021 UID/GID
  ≤ 10000 (999 / 1000) — LOW, recommend UIDs > 10000. `deploy/` is owned by the DevOps workstream and was not changed.
* Container **images** were not scanned — Docker is not available on this host (**UNVERIFIED**).

### Round 2 — still not covered

Browser-based XSS / DOM testing; container image scanning (no Docker); fuzzing of the FFmpeg demuxers; the mTLS
integration path and real CCTNS endpoints; share-portal brute force from many IPs (per-IP limit + share lockout exist;
a distributed attacker was not simulated); Kubernetes admission / NetworkPolicy behaviour in a real cluster; DoS
beyond the load measured in `docs/PERFORMANCE.md`; HSM-backed keys and key rotation.

## Final audit (2026-09-27) — additional findings

Found while spot-checking code for the requirements traceability (not a new test campaign):

| ID | Finding | Severity | Status |
|---|---|---|---|
| FA-1 | Share portal `maxViews` check-then-increment race: concurrent opens could exceed the limit | LOW | fixed (atomic conditional UPDATE; test `maxViews: concurrent opens never exceed the limit`) |
| FA-2 | Failure counter not reset after a lockout expired → one wrong password re-locked the account (availability / DoS on users) | LOW | fixed (test `an expired lockout starts a fresh failure count`) |
| FA-3 | `restore.sh` interpolated role passwords into SQL text (`-v "app_password='…'"`) | LOW | fixed (`roles.sql` uses `:'var'`) |
| FA-4 | `audit_canonical()` omits `user_agent` from the hash | MEDIUM | open (KNOWN-ISSUES SEC-R1) |
| FA-5 | Further LOW items (MFA disable TOTP replay window, MFA re-enrol without re-auth, `/health/ready` error echo, API-client id timing, `ANY_NON_REJECTED` search gate, `ksp_ai` job status transitions, dashboard org filter) | LOW | open (KNOWN-ISSUES SEC-R5…R12) |

Still **no CERT-In empanelled VAPT** has been performed.
