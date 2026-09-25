#!/usr/bin/env bash
# Local development services without Docker: PostgreSQL 16 cluster + versitygw S3 gateway.
# Usage: scripts/dev/services.sh start|stop|status
set -euo pipefail
source "$(dirname "$0")/env.sh"
PGDATA="$KSP_DATA/pg"; PGPORT="${PGPORT:-5433}"
S3DIR="$KSP_DATA/s3"; S3PORT="${S3PORT:-7480}"
S3_ACCESS="${S3_ACCESS_KEY:-kspdevaccess}"; S3_SECRET="${S3_SECRET_KEY:-kspdevsecret-change-me}"
mkdir -p "$KSP_DATA" "$S3DIR/buckets" "$S3DIR/versions" "$S3DIR/sidecar" "$KSP_DATA/logs"

start_pg() {
  if [ ! -f "$PGDATA/PG_VERSION" ]; then
    initdb -D "$PGDATA" -U ksp --auth=trust -E UTF8 >/dev/null
    echo "listen_addresses='127.0.0.1'" >> "$PGDATA/postgresql.conf"
    echo "port=$PGPORT" >> "$PGDATA/postgresql.conf"
    echo "unix_socket_directories='$PGDATA'" >> "$PGDATA/postgresql.conf"
  fi
  if ! pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
    pg_ctl -D "$PGDATA" -l "$KSP_DATA/logs/postgres.log" -w start >/dev/null
  fi
  for db in ksp ksp_test; do
    psql -h 127.0.0.1 -p "$PGPORT" -U ksp -d postgres -tAc "select 1 from pg_database where datname='$db'" | grep -q 1 \
      || createdb -h 127.0.0.1 -p "$PGPORT" -U ksp "$db"
  done
  echo "postgres: 127.0.0.1:$PGPORT"
}
start_s3() {
  if [ -f "$KSP_DATA/s3.pid" ] && kill -0 "$(cat "$KSP_DATA/s3.pid")" 2>/dev/null; then echo "s3: running :$S3PORT"; return; fi
  ROOT_ACCESS_KEY="$S3_ACCESS" ROOT_SECRET_KEY="$S3_SECRET" nohup versitygw --port "127.0.0.1:$S3PORT" posix \
    --versioning-dir "$S3DIR/versions" --sidecar "$S3DIR/sidecar" "$S3DIR/buckets" \
    > "$KSP_DATA/logs/s3.log" 2>&1 &
  echo $! > "$KSP_DATA/s3.pid"; sleep 1
  kill -0 "$(cat "$KSP_DATA/s3.pid")" && echo "s3: 127.0.0.1:$S3PORT"
}
case "${1:-start}" in
  start) start_pg; start_s3 ;;
  stop) pg_ctl -D "$PGDATA" stop -m fast || true; [ -f "$KSP_DATA/s3.pid" ] && kill "$(cat "$KSP_DATA/s3.pid")" 2>/dev/null || true; rm -f "$KSP_DATA/s3.pid" ;;
  status) pg_ctl -D "$PGDATA" status || true; [ -f "$KSP_DATA/s3.pid" ] && kill -0 "$(cat "$KSP_DATA/s3.pid")" && echo s3 running || echo s3 stopped ;;
esac
