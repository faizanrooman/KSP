# Deployment

**Status:** container images, compose and Kubernetes manifests are authored and statically validated
(`scripts/ci/validate-deploy.sh`: hadolint, shellcheck, kustomize + kubeconform, actionlint, `docker compose
config`). They have **never been built or run** (no Docker access on the development host) — UNVERIFIED.
What *is* verified: `npm run build` and every production entrypoint (`node …/dist/…`) running from a reproduction
of the image file layout with production-only dependencies (`scripts/ci/simulate-image.sh`), in `NODE_ENV=production`,
including a full DR drill (docs/DISASTER-RECOVERY.md).

## Artefacts

| Path | What |
|---|---|
| `deploy/docker/Dockerfile` | one multi-stage file; targets `api`, `worker`, `ai-worker`, `web`, `backup` |
| `deploy/docker/nginx/` | web tier config (SPA fallback, `/api` proxy, CSP mirroring the API) |
| `deploy/compose/` | single-host / staging stack (`docker-compose.yml`, `.env.example`, postgres init) |
| `deploy/k8s/base`, `overlays/{staging,production}`, `jobs/`, `components/` | Kubernetes (kustomize) |
| `deploy/monitoring/` | Prometheus scrape + rules, Alertmanager, Grafana provisioning + dashboards |
| `deploy/s3/policies/` | IAM policies: app, ai (derived only), backup, replicate |
| `.github/workflows/ci.yml`, `release.yml` | CI (lint/typecheck/build/tests/security) and CD (images, staging, approved production) |

## Images

Base `node:22-bookworm-slim` pinned by digest; non-root uid/gid 10001 (`web` 10101, `backup` 10002; all > 10000 — OPS-9); `tini` as PID 1;
`npm ci --omit=dev -w <app>` (only the workspaces the image runs); no secrets or models in layers; HEALTHCHECKs;
read-only-root friendly (only `/work` and `/tmp` writable). Worker/ai-worker FFmpeg: pinned
`mwader/static-ffmpeg:7.1.1` (GPL static build — libx264/x265/vpx/aom/dav1d/opus/libass…); the worker image build
runs `scripts/ops/check-ffmpeg.sh` (libass for watermark burn-in, libx264, H.264/HEVC/MJPEG/MPEG-4 decoders,
MP4/MOV/MKV/AVI/TS demuxers) and installs fontconfig + DejaVu fonts. AI models are **not** baked in: the models
Job downloads and SHA-256-verifies them (`scripts/ops/fetch-models.mjs`) and the AI worker's init container
refuses to start unless every file matches its pin (`--verify-only`).

```bash
docker build -f deploy/docker/Dockerfile --target api -t ksp/api .      # likewise worker, ai-worker, web, backup
```

## First installation (Kubernetes)

1. **Cluster prerequisites**: ingress-nginx (`allow-snippet-annotations: false`), cert-manager, CloudNativePG
   operator, External Secrets Operator (or Sealed Secrets), Prometheus Operator, a RWX storage class for AI models,
   an S3 store with Object Lock (MinIO/Ceph/StorageGRID/AWS) at the primary and at the DR site.
2. **Secrets**: `scripts/ops/generate-secrets.sh --out /secure/ksp-prod --env-name production`. Import the files
   into the secrets manager under `ksp/production/{app,migrate,ai,backup,backup-verify,replicate}` (key names =
   file names). Move `backup_age_identity` **offline**; submit `signing.csr` to the CA/DSC provider and replace
   `signing_certificate` with the issued certificate. Shred the directory. Details: [SECRETS.md](SECRETS.md).
3. **Object storage**: create IAM identities from `deploy/s3/policies/*.json`. Buckets are created by the migrate
   Job (`ensure-buckets.mjs`: versioning + Object Lock on `evidence`/`archive`/`longterm`; it fails if an existing
   WORM bucket lacks Object Lock). Create `ksp-db-backups` and `ksp-pg-wal` at the DR site with Object Lock. Configure
   native replication primary → DR for all `ksp-*` buckets (preserves version IDs).
4. **Database**: the CNPG component bootstraps `ksp` owned by `ksp_owner` and creates `ksp_app`, `ksp_ai`,
   `ksp_backup` (pg_read_all_data). For an external cluster run `db/bootstrap/roles.sql` + the extra statements in
   `deploy/compose/postgres/10-ksp-roles.sh`. Migrations run as the DB owner — **not** a superuser (verified: all
   migrations apply as a NOSUPERUSER owner).
5. **Deploy**: `scripts/ops/k8s-deploy.sh production <tag> ghcr.io/<org>/ksp` — applies the migrate Job, waits for
   completion (failure stops the deploy before new pods start), then workloads, then waits for rollouts. Then run
   the models Job once: `kustomize build deploy/k8s/overlays/production/jobs | kubectl apply -l app.kubernetes.io/name=ksp-ai-models -f -`.
6. **First administrator**: `kubectl -n ksp-vms run seed --rm -it --image=<api image> --env KSP_SEED_CLI=1 -- node packages/core/dist/bin/seed.js --production`
   (with the ksp-app env) prints a one-time password for `admin`; log in over HTTPS, change it, enrol MFA (mandatory).
7. **TLS**: Ingress uses cert-manager (`ksp-internal-ca` ClusterIssuer) or a pre-created `ksp-vms-tls` Secret;
   HSTS is sent by the API/web when `COOKIE_SECURE=true` (enforced in production).
8. **Verify**: `/health/ready`, Grafana dashboards, run `ksp-backup-verify` once manually, run a DR drill on staging.

## Single host (compose)

```bash
scripts/ops/generate-secrets.sh --out deploy/compose/secrets --format compose
cp deploy/compose/.env.example deploy/compose/.env && cat deploy/compose/secrets/secrets.env >> deploy/compose/.env   # then edit URLs
docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env up -d
docker compose -f deploy/compose/docker-compose.yml --env-file deploy/compose/.env --profile ai up -d models ai-worker
```

Network zones: `backend`/`ai`/`monitoring` are internal (no internet); the AI worker sits only on `ai` with Postgres
and S3 and holds only the `ksp_ai` + derived-bucket identities. The bundled versitygw runs single-account unless its
IAM users are created — use a real IAM-capable store for per-service credential isolation (KNOWN-ISSUES).

## Upgrades

Same as first deploy step 5. Migrations are forward-only; roll back code only to a version compatible with the
new schema (`kubectl rollout undo`); never edit applied migrations (checksum-enforced).
