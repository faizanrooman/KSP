#!/usr/bin/env bash
# Start the versitygw S3 gateway for CI (same server/version as development; versioning + Object Lock).
# The posix backend needs its gateway, versioning and sidecar directories to EXIST before start — a bare --tmpfs mount
# has none, so the container exits silently and every later step fails with ECONNREFUSED :7070. Use a bind mount with
# the directories pre-created and wait until the port answers.
#   env: VERSITYGW_IMAGE S3_ACCESS_KEY S3_SECRET_KEY (S3_PORT=7070)
set -euo pipefail
PORT="${S3_PORT:-7070}"
DATA="${RUNNER_TEMP:-/tmp}/ksp-s3"; mkdir -p "$DATA/b" "$DATA/v" "$DATA/s"; chmod -R 777 "$DATA"
docker rm -f s3 >/dev/null 2>&1 || true
docker run -d --name s3 -p "$PORT:$PORT" -e ROOT_ACCESS_KEY="$S3_ACCESS_KEY" -e ROOT_SECRET_KEY="$S3_SECRET_KEY" \
  -v "$DATA:/data" "$VERSITYGW_IMAGE" --port ":$PORT" posix --versioning-dir /data/v --sidecar /data/s /data/b
for _ in $(seq 1 30); do
  # unauthenticated request → 403 from the gateway; connection refused → not up yet
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$PORT/" || true)
  if [ "$code" != "000" ]; then echo "versitygw ready on :$PORT (HTTP $code)"; docker logs s3 2>&1 | tail -5; exit 0; fi
  sleep 1
done
echo "versitygw did not come up on :$PORT"; docker logs s3 2>&1 | tail -40; docker ps -a | grep s3 || true
exit 1
