# syntax=docker/dockerfile:1.7
# KSP VMS — one multi-stage Dockerfile, one target per deployable:
#   docker build -f deploy/docker/Dockerfile --target api       -t ksp/api .
#   docker build -f deploy/docker/Dockerfile --target worker    -t ksp/worker .
#   docker build -f deploy/docker/Dockerfile --target ai-worker -t ksp/ai-worker .
#   docker build -f deploy/docker/Dockerfile --target web       -t ksp/web .
#   docker build -f deploy/docker/Dockerfile --target backup    -t ksp/backup .
# The migrate job and the model-fetch init job reuse the `api` / `ai-worker` images with a different command.
#
# Base images are pinned by digest (resolved 2026-09-25 from Docker Hub; refresh with scripts/ci/pin-images.sh).
# STATUS: UNVERIFIED — Docker is not available on the development host; the file layout of the runtime stages was
# reproduced and executed locally by scripts/ci/simulate-image.sh (see docs/DEPLOYMENT.md).

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.28-alpine@sha256:7377697a821c131a924a7105fafbe7414db4e9fcc77a6f08f776f33f141ec3f8
ARG POSTGRES_IMAGE=postgres:16-bookworm@sha256:efedf3595f1d6f415c08568ba171029bf54052e754cc9f030e3f2412b21f3d67
# Static FFmpeg 7.1.1 (GPL build: libx264, libx265, libvpx, libaom, libdav1d, libopus, libmp3lame, …) — decodes every
# codec body-worn cameras produce (H.264/H.265/MJPEG/MPEG-4 in MP4/MOV/AVI/MKV/TS) and encodes H.264 proxies/HLS.
ARG FFMPEG_IMAGE=mwader/static-ffmpeg:7.1.1@sha256:11a44711684c0b9f754c047dcd64235b8b52deab251bd0e0a86f22faa160749c

# ---------------------------------------------------------------------------------------------------------------
# deps: full dependency install (dev deps needed for tsc/vite). Only manifests are copied so this layer caches.
FROM ${NODE_IMAGE} AS deps
WORKDIR /src
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
COPY package.json package-lock.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/ai-worker/package.json apps/ai-worker/
COPY apps/web/package.json apps/web/
COPY tools/station-client/package.json tools/station-client/
RUN --mount=type=cache,target=/root/.npm npm ci

# build: TypeScript -> dist for every package, Vite production bundle for the web app.
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
COPY tools tools
RUN npm run build

# prod-manifests + prod-deps-<app>: production-only node_modules for exactly the workspaces an image runs.
FROM ${NODE_IMAGE} AS prod-manifests
WORKDIR /app
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
COPY --from=deps /src/package.json /src/package-lock.json /src/.npmrc ./
COPY --from=deps /src/packages/shared/package.json packages/shared/
COPY --from=deps /src/packages/core/package.json packages/core/
COPY --from=deps /src/apps/api/package.json apps/api/
COPY --from=deps /src/apps/worker/package.json apps/worker/
COPY --from=deps /src/apps/ai-worker/package.json apps/ai-worker/
COPY --from=deps /src/apps/web/package.json apps/web/
COPY --from=deps /src/tools/station-client/package.json tools/station-client/

FROM prod-manifests AS prod-deps-api
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev -w @ksp/shared -w @ksp/core -w @ksp/api

FROM prod-manifests AS prod-deps-worker
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev -w @ksp/shared -w @ksp/core -w @ksp/worker

FROM prod-manifests AS prod-deps-ai
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev -w @ksp/shared -w @ksp/core -w @ksp/ai-worker

# runtime-base: slim Node runtime, tini as PID 1, non-root uid 1000 (the image's `node` user), no secrets.
FROM ${NODE_IMAGE} AS runtime-base
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    API_HOST=0.0.0.0 \
    METRICS_HOST=0.0.0.0 \
    WORK_DIR=/work \
    LOG_LEVEL=info
WORKDIR /app
# db/migrations is shipped in every image: the migration runner reads it and config.repoRoot() anchors on it.
COPY --chown=root:root db/migrations db/migrations
COPY --chown=root:root package.json ./
COPY --from=build --chown=root:root /src/packages/shared/package.json packages/shared/package.json
COPY --from=build --chown=root:root /src/packages/shared/dist packages/shared/dist
COPY --from=build --chown=root:root /src/packages/core/package.json packages/core/package.json
COPY --from=build --chown=root:root /src/packages/core/dist packages/core/dist
# PDF fonts (Noto Sans + Noto Sans Kannada, OFL-1.1; SHA-256 pinned in fonts.json, checked at load)
COPY --from=build --chown=root:root /src/packages/core/assets packages/core/assets
# /work is the only writable path the apps need (mount an emptyDir/tmpfs there with a read-only root FS).
RUN mkdir -p /work && chown 1000:1000 /work
USER 1000:1000
ENTRYPOINT ["/usr/bin/tini", "--"]

# ---------------------------------------------------------------------------------------------------------------
FROM runtime-base AS api
COPY --from=prod-deps-api --chown=root:root /app/node_modules node_modules
COPY --from=build --chown=root:root /src/apps/api/package.json apps/api/package.json
COPY --from=build --chown=root:root /src/apps/api/dist apps/api/dist
COPY --chown=root:root scripts/ops/ensure-buckets.mjs scripts/ops/ensure-buckets.mjs
ENV KSP_SERVICE=ksp-api API_PORT=4000 METRICS_PORT=9464
EXPOSE 4000 9464
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# Alternative commands (same image):  migrate job -> node packages/core/dist/bin/migrate.js
#                                     buckets     -> node scripts/ops/ensure-buckets.mjs
#                                     first seed  -> env KSP_SEED_CLI=1 node packages/core/dist/bin/seed.js --production
CMD ["node", "apps/api/dist/server.js"]

# ---------------------------------------------------------------------------------------------------------------
FROM ${FFMPEG_IMAGE} AS ffmpeg

FROM runtime-base AS worker
USER root
# Fonts + fontconfig for libass (watermark burn-in of shared media renders an ASS overlay).
RUN apt-get update \
 && apt-get install -y --no-install-recommends fontconfig fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/* && fc-cache -f
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /ffprobe /usr/local/bin/ffprobe
COPY --chown=root:root scripts/ops/check-ffmpeg.sh /usr/local/bin/ksp-check-ffmpeg
# Fail the image build if this FFmpeg lacks libass / libx264 / the camera decoders the pipeline relies on.
RUN /usr/local/bin/ksp-check-ffmpeg /usr/local/bin/ffmpeg
USER 1000:1000
# fontconfig writes its cache under XDG_CACHE_HOME; keep it on the writable tmpfs (read-only root FS).
ENV XDG_CACHE_HOME=/tmp
COPY --from=prod-deps-worker --chown=root:root /app/node_modules node_modules
COPY --from=build --chown=root:root /src/apps/worker/package.json apps/worker/package.json
COPY --from=build --chown=root:root /src/apps/worker/dist apps/worker/dist
ENV KSP_SERVICE=ksp-worker FFMPEG_PATH=/usr/local/bin/ffmpeg FFPROBE_PATH=/usr/local/bin/ffprobe METRICS_PORT=9464
# The worker exposes Prometheus metrics on METRICS_PORT+1.
EXPOSE 9465
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(Number(process.env.METRICS_PORT||9464)+1)+'/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/worker/dist/main.js"]

# ---------------------------------------------------------------------------------------------------------------
FROM runtime-base AS ai-worker
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /ffprobe /usr/local/bin/ffprobe
COPY --from=prod-deps-ai --chown=root:root /app/node_modules node_modules
COPY --from=build --chown=root:root /src/apps/ai-worker/package.json apps/ai-worker/package.json
COPY --from=build --chown=root:root /src/apps/ai-worker/dist apps/ai-worker/dist
COPY --chown=root:root scripts/ops/fetch-models.mjs scripts/ops/fetch-models.mjs
# Models are NOT baked into the image: they are mounted read-only at /models after the init job
# (node scripts/ops/fetch-models.mjs) downloaded and SHA-256-verified them against the pinned manifest.
ENV KSP_SERVICE=ksp-ai-worker AI_MODELS_DIR=/models FFMPEG_PATH=/usr/local/bin/ffmpeg FFPROBE_PATH=/usr/local/bin/ffprobe
# No HTTP surface on purpose (smallest attack surface); the process exits non-zero on fatal errors and is restarted.
CMD ["node", "apps/ai-worker/dist/main.js"]

# ---------------------------------------------------------------------------------------------------------------
# backup: PostgreSQL 16 client tools (pg_dump/pg_restore/psql must match the server major) + Node (S3 via the
# repo's @aws-sdk) + age (encryption). Used by the backup / verify / replicate CronJobs and restore.sh.
FROM ${NODE_IMAGE} AS node-bin

FROM ${POSTGRES_IMAGE} AS age
ARG AGE_VERSION=v1.2.1
ARG AGE_SHA256_AMD64=7df45a6cc87d4da11cc03a539a7470c15b1041ab2b396af088fe9990f7c79d50
ARG AGE_SHA256_ARM64=57fd79a7ece5fe501f351b9dd51a82fbee1ea8db65a8839db17f5c080245e99f
ARG TARGETARCH=amd64
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/* \
 && sum="$AGE_SHA256_AMD64"; [ "$TARGETARCH" = arm64 ] && sum="$AGE_SHA256_ARM64"; \
    curl -fsSL -o /tmp/age.tgz "https://github.com/FiloSottile/age/releases/download/${AGE_VERSION}/age-${AGE_VERSION}-linux-${TARGETARCH}.tar.gz" \
 && echo "${sum}  /tmp/age.tgz" | sha256sum -c - \
 && tar -xzf /tmp/age.tgz -C /usr/local/bin --strip-components=1 age/age age/age-keygen && rm /tmp/age.tgz

FROM ${POSTGRES_IMAGE} AS backup
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=node-bin /usr/local/bin/node /usr/local/bin/node
COPY --from=age /usr/local/bin/age /usr/local/bin/age-keygen /usr/local/bin/
WORKDIR /app
COPY --from=prod-deps-api --chown=root:root /app/node_modules node_modules
COPY --chown=root:root package.json ./
COPY --from=build --chown=root:root /src/packages/shared/package.json packages/shared/package.json
COPY --from=build --chown=root:root /src/packages/shared/dist packages/shared/dist
COPY --from=build --chown=root:root /src/packages/core/package.json packages/core/package.json
COPY --from=build --chown=root:root /src/packages/core/dist packages/core/dist
# PDF fonts (Noto Sans + Noto Sans Kannada, OFL-1.1; SHA-256 pinned in fonts.json, checked at load)
COPY --from=build --chown=root:root /src/packages/core/assets packages/core/assets
COPY --chown=root:root db db
COPY --chown=root:root scripts/package.json scripts/package.json
COPY --chown=root:root scripts/backup scripts/backup
COPY --chown=root:root scripts/ops scripts/ops
ENV BACKUP_WORK_DIR=/work NODE_ENV=production
RUN mkdir -p /work && chown 999:999 /work
# uid 999 = the image's `postgres` user (non-root).
USER 999:999
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["scripts/backup/pg-backup.sh"]

# ---------------------------------------------------------------------------------------------------------------
# web: static SPA served by unprivileged nginx (uid 101, port 8080) with the same CSP as the API; /api proxied.
FROM ${NGINX_IMAGE} AS web
COPY --chown=root:root deploy/docker/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --chown=root:root deploy/docker/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build --chown=root:root /src/apps/web/dist /usr/share/nginx/html
ENV API_UPSTREAM_HOSTPORT=api:4000 NGINX_ENVSUBST_FILTER=API_UPSTREAM
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD ["wget", "-qO-", "http://127.0.0.1:8080/healthz"]
