# KSP Video Evidence Management System

Read `docs/CONTRACTS.md` before changing anything — it defines layout, authorization, audit, storage,
queue, API and UI conventions that are mandatory. Project state: `docs/PROJECT-STATUS.md`.

Quick start: `source scripts/dev/env.sh && scripts/dev/services.sh start` then `npm run dev:api`,
`npm run dev:worker`, `npm run dev:web`. Tests: `npm test -w @ksp/api`.

Hard rules: schema changes only via new migrations; every evidence query uses `evidenceVisibleSql` /
`loadEvidenceFor`; every evidence touch writes a custody audit event; never expose storage URLs; never
mark anything verified that wasn't actually run.
