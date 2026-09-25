# Troubleshooting (errors actually seen in this project)

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot find module …/node_modules/@ksp/shared/dist/index.js` when running `npm run db:migrate` or a dist entrypoint | `@ksp/*` packages resolve to `dist` unless the `ksp-src` export condition is used (dev scripts pass `--conditions=ksp-src`); `dist` not built yet | `npm run build` (root build now builds shared → core → apps in order) |
| Worker/API fail with `permission denied for schema pgboss` / table | pg-boss schema installed by another role, or grants missing | run `migrate` (installs pg-boss as the schema owner and grants `ksp_app`); the app runs pg-boss with `migrate:false` by design |
| `Migration NNNN was modified after being applied (checksum mismatch)` | an applied migration file was edited (or a worktree applied an older version) | never edit applied migrations; add a new one. Dev: rebuild the private DB (`dropdb` + migrate + seed) |
| `npm error EOVERRIDE Override for react@… conflicts with direct dependency` | root `overrides` duplicating a direct dependency | main pins React at the root without `overrides` |
| `npm ci` hangs/fails downloading CUDA for onnxruntime-node | optional GPU download | `.npmrc` has `onnxruntime-node-install=skip` (CPU binaries are bundled) |
| versitygw: CopyObject result not Object-Locked; conditional write to a tombstoned key refused | gateway quirks | code uses multipart copy and never reuses keys (docs/STORAGE.md) |
| versitygw: `NotImplemented` for PutBucketLifecycleConfiguration | not supported | configure staging lifecycle on the production store (ensure-buckets reports it) |
| Restored API cannot play/download originals from the DR store (`NoSuchVersion`) | object copies made by `s3-replicate.ts` get new version IDs; the DB stores the primary's | `node scripts/backup/s3-replicate.ts --repoint` (native replication keeps version IDs) |
| Restored DB slower than before | database-level settings (`jit=off`, migration 0901) are not part of a single-DB dump | `restore.sh` re-applies `databaseSettings` from the manifest; for manual restores run `ALTER DATABASE ksp SET jit = off` |
| Prometheus cannot scrape api/worker in containers | metrics bound to 127.0.0.1 | set `METRICS_HOST=0.0.0.0` (images do) |
| `COOKIE_SECURE must be true in production` / `OBJECT_LOCK_MODE=NONE is not permitted in production` | production guards in config | set correctly; never disable in production |
| `DATABASE_AI_URL (role ksp_ai) is required` / `S3_AI_ACCESS_KEY… required in production` | AI worker isolation guards | provide the ksp-ai secret |
| Random `Segmentation fault (core dumped)` from node/tsc/eslint on the dev host under heavy parallel load | host issue (not reproducible in isolation; exit 139) | re-run; `npm run lint` uses `--concurrency=auto` (single-threaded eslint over the whole repo crashed reliably) |
| Watermarked share videos fail / render without text | FFmpeg without libass or no fonts | worker image: static FFmpeg with libass + fontconfig + DejaVu; `scripts/ops/check-ffmpeg.sh` |
| Docker commands fail with `permission denied … docker.sock` on the dev host | user not in docker group | by design; images are validated statically (`scripts/ci/validate-deploy.sh`) and the layout via `simulate-image.sh` |
