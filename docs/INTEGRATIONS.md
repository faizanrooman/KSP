# External integrations & integration REST API (spec modules 12, 16)

> **Status: UNVERIFIED against every real external system.** The specification names CCTNS, FIR systems, case
> diaries and digital evidence repositories but does **not** define their API contracts. No real endpoint,
> credential or contract document was available. What exists is an adapter framework, a *fixture* adapter with
> synthetic data, and an `http-json` adapter implementing an **assumed** contract (`ksp-cctns-json-v0`), tested only
> against a local stub server that serves our own contract fixtures.

Code: `apps/api/src/integrations/` (adapters), `apps/api/src/modules/integrations/` (systems admin),
`apps/api/src/modules/firs/` (`POST /firs/import`), `apps/api/src/modules/api-clients/`,
`apps/api/src/modules/integration-api/` (`/api/v1/integration/*`). Tests: `apps/api/test/{integrations,api-clients,integration-api}.test.ts`,
fixtures `apps/api/test/fixtures/cctns/`.

## Adapter interfaces (`apps/api/src/integrations/types.ts`)
```ts
CctnsAdapter { fetchFir(stationCode, year, firNumber): Promise<FirRecord|null>; searchFirs(q): Promise<FirRecord[]>;
               pushEvidenceReference(caseRef, evidenceRef): Promise<PushResult>; healthCheck(): Promise<HealthResult> }
CaseDiaryAdapter { fetchEntries(caseRef, since?); pushEntry(caseRef, entry); healthCheck() }
EvidenceRepositoryAdapter { lookup(externalRef); pushReference(ref); healthCheck() }
```
Error taxonomy `IntegrationError.code`: `NOT_CONFIGURED, UNAUTHORIZED, NOT_FOUND, UPSTREAM_ERROR, CONTRACT_MISMATCH,
BLOCKED_DESTINATION, TIMEOUT` → API error code `INTEGRATION_<CODE>` (404 / 422 / 502 / 504).

Evidence references pushed out contain ids, evidence number, SHA-256, recorded time and title — never storage locations.
`pushEvidenceReference`/diary/repository operations are implemented in the adapters but **not yet wired to any
endpoint or job** (no contract to push to).

## Assumed wire contract (`contract.ts`) — UNVERIFIED
`GET /health`, `GET /firs/{psCode}/{year}/{firNo}`, `GET /firs?psCode&year&q&limit`, `POST /cases/{caseRef}/evidence-references`,
`GET|POST /case-diaries/{caseRef}/entries`, `GET /evidence/{ref}`, `POST /evidence-references`. Every response is
validated with Zod; a mismatch is `CONTRACT_MISMATCH` (never silently accepted). When the real contract is known,
change **only** `contract.ts` (schemas + mappers) and re-run a live contract test.

## Adapters
* `fixture` — synthetic records (`fixture-data.ts`, labelled `[FIXTURE]`) passed through the same schemas/mappers.
  `config.fixtureMode` = `normal|down|unauthorized|mismatch` simulates failures. Always shown as **FIXTURE**; never verified.
* `http-json` — base URL, `config.authType` `none|bearer|basic|mtls`, `timeoutMs` (200–60000), `retries` (0–5, exponential
  backoff; retried on network errors, timeouts, 429 and 5xx only), 5 MB response limit, redirects never followed.
  Credentials: `credentials_ref = NAME`; secrets are read from the environment at call time — `KSP_SECRET_<NAME>`
  (bearer token, or `user:password` for basic), mTLS: `KSP_SECRET_<NAME>_CERT/_KEY/_CA` (PEM file paths). Secrets are
  never stored in the DB or returned by the API (`credentialsPresent` boolean only).
* `config.stationCodeMap` maps upstream station codes to our org-unit codes (default: identical).

## Verification
`integration_systems.verified` becomes true **only** when `POST /integrations/systems/:id/test` with a `probe`
(FIR / caseRef / evidenceRef) succeeds end-to-end (health + contract call parsed) for an `http-json` system. A health
check alone never verifies. Changing adapter, base URL, credentials or config resets verification. DB CHECK: verified ⇒
`verified_at` set. `INTEGRATION_VERIFIED` / `INTEGRATION_TESTED` audit events; every test, import and failure is
recorded in the append-only `integration_sync_log`.

## SSRF protection (`egress.ts`)
* Production: `https` only; elsewhere `http` allowed for local stubs. No credentials in URLs.
* Denied: loopback, RFC1918, CGNAT, link-local, multicast, reserved/documentation, IPv6 ULA/link-local/mapped/NAT64,
  `localhost`, `*.local`, `*.internal`, metadata hostnames — unless allow-listed by **deployment config**
  `INTEGRATION_EGRESS_ALLOW` (comma-separated hostnames / CIDRs; not editable via API).
* Cloud metadata IPs (`169.254.169.254`, `169.254.170.2`, `fd00:ec2::254`, `100.100.100.200`) are denied even if allow-listed.
* Checked on create/update and before every request; resolved addresses are re-checked at connect time via a custom
  DNS `lookup` (DNS-rebinding safe).

## Admin endpoints (`integrations:manage`)
`GET/POST /integrations/systems`, `GET/PATCH /integrations/systems/:id`, `POST /…/:id/enable|disable`,
`POST /…/:id/test {probe?}`, `GET /…/:id/log`. `GET /integrations/systems/fir-sources` (cases:manage) lists enabled
CCTNS/FIR systems for the import dialog. Systems are created **disabled**.

## FIR import
`POST /firs/import {systemId, stationCode, year, firNumber}` (cases:manage covering the mapped station; system enabled)
→ adapter `fetchFir` → create or refresh the local FIR (`source=CCTNS|FIR_SYSTEM`, `external_ref`), `INTEGRATION_SYNC` +
`FIR_CREATED/UPDATED` audit, sync log. Response `{fir, created, systemVerified, adapter}`; the UI shows an
UNVERIFIED / Fixture warning when the system is not verified.

## Integration REST API (`/api/v1/integration`, OpenAPI tag `integration`)
Authentication: HTTP Basic `client_id:secret` (API clients) or a normal user session. API clients may call **only**
`/api/v1/integration/*` and tokenised `/api/v1/media/download/*` (other routes → 403 `API_CLIENT_ROUTE_FORBIDDEN`).
Every call is audited (`INTEGRATION_API_REQUEST`, fail-closed) and API clients are rate limited per client
(`rate_limit_per_minute`, fixed one-minute windows in `api_client_rate_windows`; 429 + `RATE_LIMITED` audit).

| Method | Path | Scope | Result |
|---|---|---|---|
| GET | `/integration/evidence` | evidence:read | search: `firStation+firYear+firNumber`, `caseNumber`, `station`, `officerBadge`, `deviceSerial`, `evidenceNumber`, `recordedFrom/To`, `page`, `pageSize≤100`; registered evidence visible to the principal (`evidenceVisibleSql`) |
| GET | `/integration/evidence/:id` | evidence:read | metadata + SHA-256/SHA-512, linked (visible) cases; `EVIDENCE_VIEWED` custody event |
| GET | `/integration/evidence/:id/download` | evidence:read + evidence:download_original | `{url, expiresAt, filename, sha256, sizeBytes}`; `EVIDENCE_DOWNLOAD_LINK_ISSUED` custody event |
| GET | `/integration/cases/:caseNumber` | cases:read | case summary, FIR, visible linked evidence + `hiddenEvidenceCount` |

Download tokens for API clients are media tokens `typ: 'API_CLIENT'` (scope `download`, TTL 300 s); on use the media
module re-checks that the client is not revoked/expired and the IP allow-list, then streams the original and writes
`EVIDENCE_DOWNLOADED {via: 'api_client'}` with actor API_CLIENT. Storage locations are never returned.

## API clients (`/api/v1/api-clients`, integrations:manage)
Create `{name, description?, scopes ⊆ [evidence:read, evidence:download_original, cases:read], orgUnitId, allowedIps[], expiresAt?, rateLimitPerMinute}`
→ `{client, clientId, clientSecret}` (secret shown **once**, `Cache-Control: no-store`; argon2id hash stored). List,
detail, PATCH (scopes, IPs, expiry, rate), `POST /:id/revoke {reason}`, `POST /:id/rotate-secret` (new secret once).
Jurisdiction = the client's org unit subtree. IPv4 CIDRs must have zero host bits; IPv6 exact addresses only
(auth plugin limitation). Audit: `API_CLIENT_CREATED/UPDATED/REVOKED/SECRET_ROTATED`.

## Dev setup
Create a fixture system in the UI (Administration → Integrations → Add system, adapter `fixture`, type CCTNS),
enable it, then FIRs → Import from CCTNS with station `ps_cubbonpark`, year 2026, FIR `0142`/`0143`
(or `ps_nazarbad` / `0007`).
