# Agent Orchestration

The system is built by an orchestrator plus workstream agents. Each agent works on its own git branch
in its own worktree, with private databases (`ksp_<name>`, `ksp_test_<name>`), buckets and ports
(`scripts/dev/agent-env.sh`). Agents own disjoint directories (see `docs/CONTRACTS.md` §3 migration
number blocks and the ownership table below). The orchestrator reviews each branch, runs the full
suite, and merges only green branches into `main`.

## Foundation (orchestrator, on `main`)
Schema contract (migrations 0001–0006), shared contracts (`@ksp/shared`), platform core (`@ksp/core`),
API core (auth plugin, access rules, sessions, errors, health, metrics, module autoload), full auth
module (login, MFA, refresh rotation, password policy, sessions), worker skeleton, web shell + UI kit +
extension points, directory lookups, dev tooling. Verified: 13 auth security tests green; audit-ledger
tamper detection; S3 Object Lock enforcement on versitygw.

## Workstreams

| Wave | Workstream | Owns | Status |
|---|---|---|---|
| 1 | Ingestion (agent 06) | `modules/uploads`, `jobs/ingest`, `modules/upload` (web), `tools/station-client`, migrations 02xx | in progress |
| 1 | Evidence registry & lifecycle (agents 04/05/06) | `modules/evidence`, `modules/retention`, `jobs/lifecycle`, `modules/evidence` (web), 03xx | in progress |
| 1 | Video (agent 07) | `jobs/media`, `modules/media`, `modules/video` (web), 04xx | in progress |
| 1b | Identity & admin (agents 02/03) | `modules/{users,roles,org,devices,settings}`, `modules/admin` (web), 01xx | queued (first attempt stopped by API session limit before any changes) |
| 1b | AI & human review (agents 08/09) | `apps/ai-worker`, `modules/{ai,review}`, `modules/ai` (web), 05xx | queued (same) |
| 1b | Cases/FIR & integrations (agent 12, 16) | `modules/{cases,firs,integrations,api-clients}`, `modules/cases` (web), 07xx | queued |
| 2 | Search & investigation (10/11) | `modules/{search,workspaces}`, 06xx | queued — needs video player merged |
| 2 | Custody, audit, export, sharing (13–16) | `modules/{custody,audit,exports,shares}`, 08xx | queued |
| 2 | Dashboards, reports, alerts, monitoring (17/19) | `modules/{dashboard,reports,alerts,system}`, 09xx | queued |
| 2 | DevOps & DR (17/18) | `deploy/`, `.github/`, `scripts/backup` | queued |
| 3 | Security testing, QA E2E, performance, accessibility, docs, final audit | tests, docs | queued |

## Operational notes
* 2026-09-25: the first wave-1 launch (4 agents) stopped at the API session limit during setup; no
  changes were lost (worktrees had no commits). Relaunched with 3 concurrent agents to stay within limits.
* Agents are instructed to commit early/often so interruptions do not lose work.
