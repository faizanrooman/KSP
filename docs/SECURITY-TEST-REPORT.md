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
| SEC-09 | Operators with `system:monitor` can trigger reprocessing of any evidence id and learn existence (202 vs 404) outside their jurisdiction | Low (by design, documented in code) | media reprocess | Open — accept or scope to jurisdiction | — |

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
