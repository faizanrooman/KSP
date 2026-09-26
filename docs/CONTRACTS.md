# Engineering Contracts & Conventions

This is the binding contract for everyone (human or agent) working on the KSP VMS codebase. Read it
before changing code. If you need to break a contract, record the decision in `docs/DECISIONS.md` first.

## 1. Repository layout

| Path | Package | Purpose |
|---|---|---|
| `packages/shared` | `@ksp/shared` | Framework-free contracts: permissions + default roles, audit actions, domain enums, settings, queue names/payloads, API constants. Used by API, workers **and** web. |
| `packages/core` | `@ksp/core` | Server-side platform: config, logger, crypto, Kysely DB + generated types, migration runner, S3 storage, pg-boss queue, audit ledger writer, FFmpeg wrappers, evidence signer, dev seed. |
| `apps/api` | `@ksp/api` | Fastify 5 REST API (`/api/v1`). Feature modules in `src/modules/<name>/index.ts` are auto-mounted. |
| `apps/worker` | `@ksp/worker` | pg-boss consumers + cron. Job modules in `src/jobs/<name>/index.ts` are auto-registered. |
| `apps/ai-worker` | `@ksp/ai-worker` | Isolated AI worker (DB role `ksp_ai`, derived bucket only). |
| `apps/web` | `@ksp/web` | React 18 + Vite + TanStack Query + Tailwind. Feature modules in `src/modules/<name>/module.tsx` are auto-discovered. |
| `db/migrations` | — | Numbered SQL migrations (source of truth for schema). |
| `db/bootstrap/roles.sql` | — | Cluster roles (`ksp_app`, `ksp_ai`) — run once per cluster. |
| `scripts/dev` | — | Local services without Docker, env/secrets generation. |
| `deploy/` | — | Docker, compose, Kubernetes, monitoring, backup. |
| `docs/` | — | All documentation. |

## 2. Local environment

```bash
source scripts/dev/env.sh            # Node 22, ffmpeg, versitygw on PATH (from .local/ of the main checkout)
scripts/dev/services.sh start        # PostgreSQL 16 on :5433, S3 (versitygw) on :7480
scripts/dev/init-env.sh              # main checkout only: secrets + .env/.env.test
scripts/dev/agent-env.sh <name> <n>  # in a worktree: private DBs ksp_<name>/ksp_test_<name>, buckets, ports
npm ci                               # in a fresh worktree
npm run db:migrate && npm run db:seed && npm run db:codegen
npm run fetch-models -w @ksp/ai-worker   # downloads + SHA-256-verifies + registers AI models (required for AI tasks/E2E)
```

Docker is **not** available on the development host (no socket permission). Docker/compose/k8s artefacts
are authored but must be marked **UNVERIFIED** until run somewhere with Docker.

Dev users (seeded): `admin`, `fo.ravi`, `op.cubbon`, `io.meera`, `io.arjun`, `sup.kavya`, `fa.naveen`,
`ec.latha`, `aud.suresh`, `io.mysuru` — password `Ksp@Dev-Passw0rd!`. `sup.kavya`, `admin`, `aud.suresh`,
`ec.latha` must enrol MFA on first login (role policy).

## 3. Database

* Schema changes **only** via a new file `db/migrations/NNNN_<module>_<what>.sql`. Never edit an applied
  migration (the runner rejects checksum changes). Number blocks per workstream to avoid collisions:
  `01xx` identity/admin · `02xx` ingestion · `03xx` evidence/lifecycle · `04xx` video · `05xx` AI/review ·
  `06xx` search/investigation · `07xx` cases/integrations · `08xx` custody/export/sharing · `09xx` ops/alerts.
* After adding a migration: `npm run db:migrate && npm run db:codegen` (regenerates `packages/core/src/db/types.ts`).
* The app connects as `ksp_app` (DML only). New tables are automatically granted to `ksp_app` via default
  privileges; add explicit `REVOKE UPDATE, DELETE` for append-only tables. `ksp_ai` gets **explicit** grants only.
* Evidence integrity is enforced **in the database**: `evidence_guard` trigger (immutable columns after
  registration, no DELETE, legal hold blocks disposal), `audit_events` append-only + hash chain.
* Use Kysely (`app.db`) with the generated `DB` types. Raw SQL via `sql\`\`` tagged templates only (parameterised).
* Multi-step changes use `db.transaction().execute(async (tx) => …)` and write the audit event **in the same tx**.

## 4. Authorization (MUST)

* Every route is authenticated unless `config: { public: true }`.
* Coarse permission check: `preHandler: app.authorize('perm:a', 'perm:b')` (ALL required).
* Jurisdiction: role grants apply to an org unit **subtree** (`org_path` ltree). Use helpers in
  `apps/api/src/lib/principal.ts` (`hasPermissionAt`, `scopePaths`) and `apps/api/src/lib/access.ts`.
* **Evidence**: every list/search/join returning evidence MUST add `.where(evidenceVisibleSql(p, '<alias>'))`.
  Every single-evidence operation MUST call `loadEvidenceFor(db, p, id, '<permission>', req.actor())`.
  Out-of-scope → **404** (never 403) to prevent IDOR/existence leaks.
* Other org-scoped resources (cases, FIRs, devices, users, shares…) filter with `orgScopeSql(p, perm, 'org_path')`
  or `hasPermissionAt`.
* Separation of duties: requester ≠ approver for disposals and exports (also enforced by DB CHECK constraints).
* Write a security test for every new endpoint: unauthenticated → 401, missing permission → 403, other
  jurisdiction → 404.

## 5. Audit & chain of custody (MUST)

* Use `appendAudit(dbOrTx, req.actor(), { action, resourceType, resourceId, evidenceId, caseId, orgUnitId, details })`.
* Action codes come from `packages/shared/src/audit.ts`. Add new codes there (category + `custody` flag).
* Every evidence touch (view, play, download, snapshot, analysis, review, annotation, link, share, export,
  hold, disposal, tier change, integrity check) writes a custody event with `evidenceId` set.
* Never log secrets, tokens, passwords or access codes in `details`.
* If the audit write fails, the operation fails.

## 6. Storage

* Use `app.storage` / `storage()` (`packages/core/src/storage.ts`). Buckets by role: `staging`, `evidence`,
  `archive`, `longterm` (originals, versioned + Object Lock), `derived`, `exports`, `reports`.
* Originals are written with `{ lock: true, ifNoneMatch: true }` — never overwritten, never mutated.
* Object keys: originals `originals/<yyyy>/<mm>/<evidenceId>/<sha256>` ; derived `evidence/<evidenceId>/<kind>/…`.
* **Never** return a storage URL to a client. Media is streamed by the API; browser media elements use
  short-lived HMAC tokens (`signMediaToken`/`verifyMediaToken` in core) on `?t=` query parameters.

## 7. Queues & workers

* Queue names/payloads: `packages/shared/src/queues.ts`. Enqueue with `enqueue(QUEUES.X, payload, { singletonKey })`.
* Worker job module: `apps/worker/src/jobs/<name>/index.ts` default-exports `async (ctx: WorkerContext) => {…}`
  that calls `ctx.boss.work(QUEUES.X, { localConcurrency }, handler)` and/or `ctx.boss.schedule(name, cron)`
  (+ `ctx.boss.work(name, …)` for the scheduled queue; create the queue with `ctx.boss.createQueue(name)` first).
* Track user-visible progress with `ProcessingTracker` (`apps/worker/src/lib/processing.ts`).
* Handlers must be idempotent (pg-boss retries with backoff; exhausted jobs go to `<queue>.dead`).
* FFmpeg/ffprobe only through `@ksp/core` `ffmpeg()` / `probe()` (argument arrays; no shell).

## 8. API conventions

* Module file: `apps/api/src/modules/<name>/index.ts` → `export const prefix = '/<name>'` + default plugin.
  Use `fastify.withTypeProvider<ZodTypeProvider>()` and Zod schemas for `params`, `querystring`, `body`
  (validation + OpenAPI generation). Add `tags` and `summary`.
* Errors: throw helpers from `apps/api/src/lib/errors.ts`; the global handler renders
  `{ error: { code, message, details?, requestId } }`.
* Lists: `?page=1&pageSize=25&sort=-created_at` → `{ items, total, page, pageSize }` (pageSize ≤ 200).
  Sort keys must be whitelisted.
* JSON field naming in responses: **camelCase**. Map DB snake_case rows explicitly (do not leak internal
  columns like `storage_key`, `password_hash`, `mfa_secret_enc`, `token_hash`).
* Rate-limit sensitive endpoints with `config: { rateLimit: { max, timeWindow } }` (skip in test via NODE_ENV).

## 9. Web conventions

* Module: `apps/web/src/modules/<name>/module.tsx` default-exports `WebModule` (`routes`, `nav`, optional
  `publicRoutes`). Contribute evidence-page tabs/actions via `evidence-tabs.tsx` / `evidence-actions.tsx`,
  case tabs via `case-tabs.tsx` (see `src/lib/extensions.ts`).
* Data: TanStack Query + `api` from `@/lib/api`. Permissions: `useAuth().can(...)` / `canAny(...)`.
* UI: use `@/components/ui` (Button, Field, Input, Select, DataTable, Pagination, Modal, ConfirmDialog,
  Tabs, StatusBadge, EmptyState, ErrorState, Spinner, Alert, KeyValue, Stat, ProgressBar, useToast).
  Every screen handles loading, error (with retry), empty, and success/confirmation states.
* Filters/pagination live in the URL (`useUrlState`). Consequential actions use `ConfirmDialog`
  (with `requireReason` where the audit trail needs a justification).
* Accessibility: labelled inputs, keyboard-operable controls, visible focus, no colour-only meaning.

## 10. Tests

* API tests: `apps/api/test/*.test.ts` (Vitest). Global setup rebuilds `ksp_test*` from migrations + seed.
  Helpers: `login(username)`, `createUser({ role, org })`, `Agent.get/post/…` (cookies + CSRF automatic).
* Real Postgres + real S3 + real FFmpeg in tests. No mocks of our own services. Test media is generated
  with FFmpeg (`testsrc2`, `sine`) in fixtures.
* Run before committing: `npm run typecheck` (root), the affected package's tests, `npx vite build` for web.

## 11. Definition of done (per feature)

Implemented end-to-end (DB → API → worker → UI) · authorised · audited · tests for happy path + authz
+ failure modes · typecheck/build green · docs updated (`docs/…` for the module, `docs/PROJECT-STATUS.md`,
`docs/KNOWN-ISSUES.md` for anything not done). Anything not verified is written down as **UNVERIFIED**.
