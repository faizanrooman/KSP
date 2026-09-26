# Performance measurements

Single-host, development-laptop measurements of the real stack (Fastify API, pg-boss worker, PostgreSQL 16,
versitygw S3, FFmpeg 7). Every number below was measured; nothing is extrapolated. What they do and do not imply for
production is in the last section. Scripts: `tests/perf/**`; raw results: `tests/perf/results/*.jsonl`.

## Host and environment

| | |
|---|---|
| CPU | Intel Core i5-1145G7 (4 cores / 8 threads, 2.6 GHz base, 4.4 GHz turbo), laptop power management |
| RAM | 15 GiB (≈ 6–8 GiB available during runs) |
| Disk | WD PC SN730 256 GB NVMe (one disk for PostgreSQL, S3 objects, OS) |
| OS | Ubuntu 24.04, Linux 7.0 |
| PostgreSQL | 16.15, **default config**: `shared_buffers=128MB`, `work_mem=4MB`, `max_connections=100`; API pool `DATABASE_POOL_MAX=20` |
| S3 | versitygw (posix backend) on the same NVMe |
| API / worker | 1 Node 22 process each (`NODE_ENV=development`, `LOG_LEVEL=warn`, `TRUST_PROXY=true` so the load generator can spread requests over many client IPs; every other control — auth, CSRF, audit writes, rate limits — on) |
| Load generator | autocannon 8 on the same host (it competes for the same CPUs) |

**Environment caveats (important).** (1) The host was **not quiet**: a parallel QA agent ran Playwright/Chrome E2E
suites during most runs (load average 15–30 on 8 threads at times), so absolute numbers under concurrency are noisy
and pessimistic. (2) The host showed **hardware-level instability** during this work: 12+ PostgreSQL backend
`SIGSEGV`s (mostly on CPU core 3, also seen for ffprobe/node/tsc on previous boots), `invalid memory alloc request`
errors, non-reproducible SHA-256 mismatches of uploaded chunks and of a stored 1 GB original, and one audit row whose
`actor_name` changed from `perf.state` to `peYf.state` after it was written. This looks like faulty RAM/CPU, not
software: the application's integrity controls **detected every instance** (chunk hash check → client retry;
stored-original hash check → item QUARANTINED, never registered; `audit_verify()` → chain break reported at seq
1 024 318; the audit checkpoint job refused to sign past it). Runs affected by a PostgreSQL crash-restart are marked;
the before/after comparison below was repeated on a run with 0 crashes. **Recommendation: run memtest on this host;
do not use it for any production-like data.**

## Dataset (perf database `ksp_perf`)

Seeded with `tests/perf/seed/seed.sql`, `audit.sql`, `perf-users.sql` (≈ 40 s + 2 min):

| Table | Rows | Notes |
|---|---|---|
| org_units | 328 | 30 perf districts × 9 stations + seed hierarchy |
| users | 2 930 | ~10 officers per station (90 % FO, 10 % IO) + personas |
| evidence | 100 007 | REGISTERED, 2 years of recording dates, GPS near the station, 6 categories, tiers; ps_cubbonpark weighted (5 129 items) |
| evidence_tags | 140 657 | 0–3 per item |
| ai_jobs / ai_detections | 50 k / **500 000** | 10 labels, 5 review states, plates on 10 % |
| audit_events | **≈ 1.14 M** | appended through `audit_append()` — the hash chain is real; one "hot" item with 1 000 custody events |
| DB size | 1.7 GB | audit_events 1.2 GB (incl. indexes) |

Personas: station IO `io.meera` (ps_cubbonpark), district supervisor `perf.sup` (blr_central, SUPERVISOR permissions),
state-level auditor `perf.state` (ksp, AUDITOR permissions + search).

## How to reproduce

```bash
scripts/dev/agent-env.sh perf 130 && npm run db:migrate && npm run db:seed        # perf DB ksp_perf, API :4130
psql "$DATABASE_MIGRATION_URL" -f tests/perf/seed/seed.sql                         # 100k evidence, 500k detections
psql "$DATABASE_MIGRATION_URL" -v batch=100000 -f tests/perf/seed/audit.sql        # 1M audit events via audit_append
psql "$DATABASE_MIGRATION_URL" -f tests/perf/seed/perf-users.sql
TRUST_PROXY=true scripts/dev/run.sh start api && scripts/dev/run.sh start worker
node tests/perf/api-load.mjs --levels 10,50,100 --out tests/perf/results/x.jsonl   # HTTP scenarios (autocannon, 10 s each)
node tests/perf/single.mjs 5                                                       # sequential single-request medians
node tests/perf/db-bench.mjs verify ; node tests/perf/db-bench.mjs append 1,10,50  # audit_verify / audit_append
node tests/perf/upload-stream.mjs upload --files a.mp4,b.mp4 --concurrency 4 --no-media
node tests/perf/upload-stream.mjs process --file clip10m.mp4 --user perf.u00001    # upload + media pipeline timing
node tests/perf/upload-stream.mjs stream --evidence <id> --user perf.u00001        # HLS / Range readers
node tests/perf/report.mjs tests/perf/results/before.jsonl tests/perf/results/after3.jsonl
```

"Concurrency" = autocannon connections (each a user session hammering without think time; 100 connections ≈ far more
than 100 interactive users).

## Bottlenecks found and fixed (before → after)

No new index was needed: `db/migrations/0995_perf_indexes.sql` was **not** created, because every hot query already
had a suitable index — the problems were query shapes that prevented their use.

1. **Evidence visibility filter could not use the org_path GiST index.** `evidenceVisibleSql` / `orgScopeSql` used
   `org_path <@ $paths::ltree[]` (the `ltree <@ ltree[]` operator), which GiST cannot index, so every evidence
   list/aggregate for a station or district user sequentially scanned all 100 k rows (≈ 50 ms). Rewritten as
   `org_path <@ ANY($paths)` — identical semantics, GiST bitmap scan (station: 5 129 rows in ≈ 2 ms of index time).
   For plain lists and dashboard aggregates the case/share relationship branches are additionally written as
   uncorrelated InitPlans (`id = ANY(ARRAY(SELECT …))`, option `relationships: 'initplan'`) so the planner can
   BitmapOr them. That form was also tried as the default and **reverted for search**: combined with the AI
   detection semi-join it made the planner choose a 100 k-row parallel nested loop (AI search 487 → 0–3 rps); the
   default remains correlated EXISTS. (`apps/api/src/lib/access.ts`)
2. **`GET /evidence` evaluated per-row subqueries for every visible row.** The page query selected the joins plus the
   tags/thumbnail subqueries together with `count(*) OVER ()`, so they ran for all visible rows (100 k for a state
   user) before `LIMIT 25`. Now: page ids + total over `evidence` alone, then hydrate only the 25 rows (the pattern
   search already used). (`apps/api/src/modules/evidence/queries.ts`)
3. **API process crashed when PostgreSQL restarted** (SEC-16): an unhandled `'error'` on a checked-out pg client.
   Found during the load runs (PostgreSQL crash-recovery killed all backends); error listeners added in
   `packages/core/src/db/index.ts`. After the fix the API survived 4 further PostgreSQL crash-restarts during runs.

Single-request medians (5 sequential calls, host relatively quiet, `node tests/perf/single.mjs 5`):

| Request | Before | After |
|---|---|---|
| `GET /evidence` station IO | 84 ms | 14 ms |
| `GET /evidence` district supervisor | 105 ms | 16 ms |
| `GET /evidence` state auditor | 393 ms | 57 ms |
| `GET /dashboard/summary` station IO | 306 ms | 33 ms |
| `GET /dashboard/summary` district | 287 ms | 35 ms |
| `GET /dashboard/summary` state | 179 ms | 79 ms |
| `POST /search/evidence` text, state | 311 ms | 207 ms (not changed; noise) |
| `POST /search/evidence` text, station | 212 ms | 137 ms |
| `POST /search/evidence` facets, state | 399 ms | 266 ms |

Under load (autocannon, 10 s per cell, same host, back-to-back runs with the pre-fix code from `5404025` and the
final code; 0 PostgreSQL crashes during either run; host load average ≈ 20 from the parallel E2E agent — absolute
values are pessimistic, compare the columns). `0 / 0 / 0 / 0` = no request completed inside the 10 s window.

| Scenario | Conc. | Before: rps / p50 / p95 / p99 ms | After: rps / p50 / p95 / p99 ms |
|---|---|---|---|
| evidence-list:station | 10 | 55 / 174 / 263.7 / 292 | 220 / 43 / 62.3 / 76 |
| evidence-list:station | 50 | 60 / 806 / 1031.7 / 1082 | 240 / 204 / 267 / 298 |
| evidence-list:station | 100 | 52 / 1810 / 2177.3 / 2257 | 234 / 409 / 586 / 1247 |
| evidence-list:district | 10 | 28 / 265 / 1417.7 / 2134 | 179 / 53 / 73 / 87 |
| evidence-list:district | 50 | 38 / 1272 / 1664.7 / 1850 | 182 / 262 / 369.7 / 424 |
| evidence-list:district | 100 | 36 / 2524 / 3222 / 3424 | 176 / 520 / 969.3 / 1509 |
| evidence-list:state | 10 | 7 / 1039 / 3536.7 / 3819 | 26 / 355 / 625.7 / 711 |
| evidence-list:state | 50 | 8 / 4863 / 7746.7 / 8288 | 28 / 1759 / 2266.7 / 2926 |
| evidence-list:state | 100 | 4 / 7767 / 9770.7 / 9983 | 20 / 4098 / 4512.3 / 4530 |
| evidence-list:state-filters | 10 | 0 / 0 / 0 / 0 | 28 / 295 / 1010.7 / 1220 |
| evidence-list:state-filters | 50 | 19 / 1137 / 5362.3 / 6479 | 31 / 1176 / 3403.7 / 4032 |
| evidence-list:state-filters | 100 | 33 / 1513 / 4297.3 / 5072 | 28 / 3787 / 5600 / 5650 |
| search:text | 10 | 0 / 0 / 0 / 0 | 7 / 886 / 4382.3 / 4585 |
| search:text | 50 | 9 / 4318 / 5690 / 6001 | 11 / 3430 / 6218 / 6392 |
| search:text | 100 | 7 / 9915 / 10031.3 / 10046 | 10 / 9112 / 9357.7 / 9444 |
| search:ai | 10 | 487 / 18 / 32 / 40 | 213 / 16 / 36.7 / 84 |
| search:ai | 50 | 524 / 80 / 159.7 / 190 | 640 / 73 / 115 / 135 |
| search:ai | 100 | 567 / 170 / 250.3 / 270 | 570 / 166 / 260.7 / 283 |
| search:plate | 10 | 472 / 19 / 40 / 51 | 668 / 14 / 21.3 / 26 |
| search:plate | 50 | 589 / 81 / 122.7 / 136 | 680 / 70 / 101 / 115 |
| search:plate | 100 | 674 / 127 / 239 / 332 | 655 / 146 / 207 / 240 |
| search:radius | 10 | 29 / 336 / 447.7 / 480 | 32 / 302 / 387.3 / 423 |
| search:radius | 50 | 23 / 1798 / 3023.3 / 3238 | 31 / 1442 / 2140 / 2273 |
| search:radius | 100 | 29 / 3069 / 3454 / 3473 | 20 / 3850 / 3940.3 / 3977 |
| search:facets | 10 | 6 / 1290 / 3278 / 3315 | 7 / 1211 / 2068.7 / 2113 |
| search:facets | 50 | 5 / 5703 / 7921.7 / 8027 | 6 / 5334 / 7407 / 7414 |
| search:facets | 100 | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| search:station-facets | 10 | 9 / 758 / 3940.3 / 4058 | 8 / 891 / 3660.3 / 3782 |
| search:station-facets | 50 | 9 / 4433 / 5972.3 / 6975 | 9 / 4125 / 5457.7 / 6380 |
| search:station-facets | 100 | 5 / 9977 / 10047.3 / 10052 | 0 / 0 / 0 / 0 |
| dashboard:station | 10 | 5 / 1805 / 2838.3 / 3147 | 31 / 267 / 1205.3 / 1645 |
| dashboard:station | 50 | 5 / 8666 / 9543 / 9863 | 40 / 1178 / 1399 / 1449 |
| dashboard:station | 100 | 0 / 0 / 0 / 0 | 38 / 2317 / 3407 / 3539 |
| dashboard:district | 10 | 0 / 0 / 0 / 0 | 24 / 319 / 1737 / 2523 |
| dashboard:district | 50 | 0 / 0 / 0 / 0 | 31 / 1542 / 2057.3 / 2261 |
| dashboard:district | 100 | 0 / 0 / 0 / 0 | 20 / 4156 / 4922.3 / 4929 |
| dashboard:state | 10 | 0 / 0 / 0 / 0 | 8 / 879 / 4019.7 / 4597 |
| dashboard:state | 50 | 6 / 6036 / 8792.7 / 9173 | 12 / 3846 / 4452.3 / 4605 |
| dashboard:state | 100 | 6 / 7316 / 9869 / 10031 | 8 / 6984 / 9606.3 / 9721 |

## Other measurements (final code)

### Authentication

| Scenario | 10 conn | 50 conn | 100 conn |
|---|---|---|---|
| `POST /auth/login` (argon2id m=19 MiB, t=2; 2 900 distinct users) rps / p50 / p95 / p99 ms | 87 / 113 / 141 / 158 | 84 / 576 / 689 / 760 | 83 / 1 138 / 1 604 / 1 915 |

Throughput is flat at ≈ 80–87 logins/s: argon2 verification is CPU-bound and runs on the libuv threadpool
(default 4 threads) — **bottleneck by design** (password hashing cost). More throughput = more API replicas (or a
larger `UV_THREADPOOL_SIZE`, not measured). A login storm of 1 000 officers at shift change would queue ≈ 12 s on one
process.

### Evidence detail, audit, custody (pre-fix baseline run; these paths were not changed)

| Scenario | 10 conn | 50 conn | 100 conn |
|---|---|---|---|
| `GET /evidence/:id` (writes an EVIDENCE_VIEWED custody event per call) | 323 / 26 / 51 / 75 | 402 / 120 / 149 / 158 | 355 / 267 / 375 / 567 |
| `GET /audit/events?limit=50` (page 1, 1.1 M events) | 552 / 15 / 38 / 89 ¹ | 806 / 59 / 87 / 105 | 694 / 135 / 210 / 261 |
| `GET /audit/events?before=<random seq>` keyset paging | 741 / 13 / 17 / 22 | 801 / 60 / 80 / 94 | 748 / 130 / 165 / 187 |
| `GET /audit/events?evidenceId=…` | 748 / 12 / 18 / 22 | 858 / 57 / 71 / 79 | 765 / 123 / 185 / 212 |
| `GET /custody/evidence/:id` (item with 1 000 events, ≈ 0.6 MB JSON) | 57 / 170 / 247 / 288 | 56 / 821 / 1 612 / 2 546 | 54 / 1 754 / 4 749 / 6 261 |

(rps / p50 / p95 / p99 ms.) ¹ one 8.8 s outlier in that cell (PostgreSQL crash-recovery on this host). Keyset paging
is flat at any depth of the 1.1 M-row ledger. The custody view is bound by payload size (≈ 32 MB/s of JSON): it
returns every event unpaginated — **not fixed** (API contract used by the web and the signed custody PDF);
recommendation: paginate the JSON view, keep the PDF complete.

### Audit ledger (`node tests/perf/db-bench.mjs`, as `ksp_app`)

| Measurement | Result |
|---|---|
| `audit_verify()` over the full ledger | **1 024 317 events in 11.6 s (≈ 88 600 events/s)** — then reported the first bad row, seq 1 024 318 (the host memory corruption described above) |
| `audit_verify()` last 100 k | stopped at the same bad row after 16 774 events, 0.27 s |
| `audit_append()` bulk inside one transaction (seeding) | 100 000 events in 8.7 s (≈ 11 500/s) |
| `audit_append()`, 1 session, 1 event per transaction | 651 events/s, p50 1.5 ms, p99 2.2 ms |
| 10 concurrent sessions | 893 events/s, p50 12.2 ms, p99 16.2 ms |
| 50 concurrent sessions | 1 192 events/s, p50 40.3 ms, p99 74.0 ms |

The global advisory lock serialises appenders: throughput grows only with group commit, and latency grows linearly
with concurrency (≈ 0.8 ms of lock hold per event). ≈ 1 200 custody events/s is the single-primary ceiling on this
hardware; every evidence view/play/download writes one, so this is the **first hard write bottleneck** at state-wide
scale (see below).

### Ingestion (API + worker, `upload-stream.mjs`, 16 MiB chunks, 4 parallel part PUTs per file)

| Run | Result |
|---|---|
| 1 × 1.06 GB file (2 min 720p30, high bitrate) | upload 5.2 s (**203 MB/s**), complete 0.5 s, finalize (hash + probe + immutable copy + register) 11.8 s → REGISTERED **17.6 s** after the first byte (60 MB/s end-to-end) |
| 4 × 1.06 GB concurrently (4 users) | aggregate upload **81 MB/s** (≈ 20 MB/s each), complete 28–33 s each (S3 multipart assembly under contention), finalize 52–140 s (WORKER_CONCURRENCY=2 ⇒ two at a time) → 4.25 GB REGISTERED in 226 s (**18.8 MB/s** aggregate end-to-end) |
| 1 × 1.07 GB (sequential run) | QUARANTINED `PROCESSING_FAILED: stored original hash mismatch` — the host corruption; the integrity check did its job, the item never became evidence |
| 10-min 1080p30 H.264 clip (272 MB, generated with FFmpeg `testsrc2`+`sine`) | upload 2.5 s, finalize 4.9 s, **media pipeline (proxy MP4 + HLS ladder + poster/sprite) 390 s = 0.65 × real time** on 2 worker slots of this laptop (6 of 18 chunks needed a resend after a server-side CHUNK_HASH_MISMATCH — host corruption) |

Bottlenecks: one NVMe shared by S3 (versitygw), PostgreSQL and FFmpeg; finalize parallelism = `WORKER_CONCURRENCY`;
transcoding is CPU-bound (≈ 1.5 × real time per 1080p stream of CPU on this 4-core laptop).

### Media streaming (`upload-stream.mjs stream`, the 10-min clip: 105 MB proxy MP4, 360p HLS segment)

| Scenario | 10 conn | 50 conn | 100 conn |
|---|---|---|---|
| HLS segment (token-checked, Range-capable proxy through the API) rps / p50 / p99 ms / MB/s | 341 / 25 / 56 / 71 | 319 / 162 / 327 / 67 | 376 / 323 / 577 / 79 |
| proxy MP4, 1 MiB range from byte 0 | 115 / 83 / 174 / 115 | 120 / 455 / 1 159 / 120 | 165 / 847 / 3 108 / 165 |
| proxy MP4, random 256 KiB ranges | 269 / 33 / 71 / 68 | 243 / 209 / 418 / 61 | 298 / 423 / 703 / 75 |

Every request re-validates the media token and its session row and reads from S3 through the API (no storage URLs are
ever exposed). ≈ 70–165 MB/s through one API process ≈ 250–600 concurrent 2 Mbit/s viewers per process on this host;
0 errors at 100 connections.

## What these numbers do and do not imply

* They are **one laptop running everything** (API, worker, DB, S3, load generator, plus another agent's browser
  tests) with default PostgreSQL settings and a 128 MB buffer cache on a 1.7 GB database. A production deployment
  separates these tiers; the absolute numbers are a floor, not a forecast.
* **Relative** findings are solid: the visibility filter and list hydration fixes remove O(visible rows) work from the
  hottest read paths (4–7 × single-request, 4–6 × throughput under load); keyset audit paging, detail, AI/plate search
  are flat with data size; custody view, text search counting/ranking and facets still scale with match-set size.
* **Not** measured and not implied: multi-node API scaling, PostgreSQL replicas/partitioning, object storage at
  petabyte scale, 10⁸ evidence rows / 10⁹ audit events, GPU transcoding, network-bound streaming, long soak tests.
* Capacity arithmetic from these numbers (clearly an estimate, not a measurement): at ≈ 1 200 audit appends/s the
  single ledger supports ≈ 100 M custody events/day at 100 % utilisation — sufficient for state-wide view/play
  auditing only with headroom planning; the global lock means scaling the API does **not** scale custody writes.
  Transcoding at 0.65 × real time per two worker slots on 4 cores ⇒ CPU transcoding of state-wide BWC volume needs
  a large worker fleet or GPU encoding (already recorded in KNOWN-ISSUES / INFRASTRUCTURE.md).

## Recommendations (not done here)

1. Paginate `GET /custody/evidence/:id` (JSON), keep the PDF complete.
2. Text search / facets: cap the exact count (e.g. "10 000+"), compute facets on a sample or a materialised summary
   for state-wide scopes; consider `pg_trgm` threshold tuning.
3. Tune PostgreSQL for the host (`shared_buffers` ≈ 25 % RAM, `work_mem` for facets, `effective_io_concurrency`).
4. Run API with ≥ 2 replicas and consider `UV_THREADPOOL_SIZE` = cores for argon2-heavy login peaks.
5. Plan the audit ledger for scale: batch custody events per request, or partition the chain (per-district chains
   with a signed root) if > 1 000 events/s sustained is required.
6. Re-run this suite on production-like hardware (no co-tenants, separate DB/S3 hosts) before sizing.

