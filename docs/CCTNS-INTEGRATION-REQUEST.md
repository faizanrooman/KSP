# Information request: CCTNS / FIR / case-diary integration

To: CCTNS project (State Crime Records Bureau / NCRB) and State IT · From: KSP VMS integration owner · Gate D1 / EXT-2.

The KSP Video Evidence Management System has an adapter framework (`apps/api/src/integrations/`) with an HTTP JSON
adapter built against an **assumed** contract (`ksp-cctns-json-v0`, [INTEGRATIONS.md](INTEGRATIONS.md)). To finish it
we need the following. Only `contract.ts` (schemas + field mapping) and the adapter configuration change once these
are known; the rest (retries, timeouts, audit, SSRF protection, error taxonomy) is in place.

## 1. Interface contract
1. API specification (OpenAPI / WSDL / document) for: FIR lookup by police-station code + year + FIR number; FIR
   search (station, date range, text); case details and status; case-diary entries (read, and append if permitted);
   pushing an evidence reference to a case/FIR.
2. Transport: REST/JSON, SOAP/XML or file exchange? Base URLs for **test** and **production**; API versioning policy.
3. Field dictionary: station codes (the list and its mapping to our org units), FIR number format, act/section codes,
   dates/time zones, character encoding (Kannada), case status values, null/absent conventions.
4. Error model: codes for not found, unauthorized, validation, rate limit, maintenance; retry guidance.
5. Limits: rate limits, maximum page size, payload size, availability window / maintenance schedule.

## 2. Security and connectivity
6. Authentication: mTLS (client certificate profile, issuing CA, renewal), OAuth2 client credentials, API key or
   username/password; one credential per district or state-wide?
7. Network path: NIC/SWAN connectivity, IP allow-listing (we will provide our egress IPs), VPN if required.
8. Data classification and any logging/retention obligations on our side for data fetched from CCTNS.

## 3. Evidence reference push (what we send)
9. Confirm the payload CCTNS accepts. We propose: our evidence id and evidence number, SHA-256 hash, recorded time,
   title, officer badge, and a link resolvable only inside the police network — **never** the media itself.
10. Whether CCTNS returns its own reference id that we must store, and whether updates/withdrawals are supported.

## 4. Testing and acceptance
11. A test endpoint with synthetic FIRs/cases (at least 3 stations, including Kannada text), test credentials, and a
    contact for defects.
12. Acceptance procedure: which scenarios CCTNS must see succeed before production credentials are issued.
13. Production credentials handover process and go-live date constraints.

## 5. Governance
14. MoU / data-sharing agreement or approval order required; who signs.
15. Change-notification process for contract changes (lead time).

When received, the integration owner: updates `contract.ts`, configures the system in Admin → Integrations with
`adapter=http-json`, stores credentials as `KSP_SECRET_<NAME>` / mTLS files, adds the host to `INTEGRATION_EGRESS_ALLOW`
if private, and runs `POST /api/v1/integrations/systems/:id/test` with a real probe FIR — the system is marked
**verified** only when that live contract call succeeds. The production preflight refuses enabled `fixture` systems.
