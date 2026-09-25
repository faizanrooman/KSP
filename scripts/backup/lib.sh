#!/usr/bin/env bash
# Shared functions for verify-backup.sh / restore.sh (sourced, not executed).
# shellcheck disable=SC2034  # variables are consumed by the sourcing scripts

BACKUP_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${KSP_REPO_ROOT:-$(cd "$BACKUP_LIB_DIR/../.." && pwd)}"

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "FAIL: $*"; exit 1; }

# json <file> <js-expression over `m`>
json() { node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const v=(new Function("m","return "+process.argv[2]))(m); console.log(v ?? "")' "$1" "$2"; }

# fetch_backup <source> <workdir>  -> sets MANIFEST, ENC_FILE
#   source: s3://<bucket>/<manifest-key> | latest (BACKUP_S3_BUCKET + BACKUP_S3_PREFIX) | /path/to/manifest.json
fetch_backup() {
  local src="$1" work="$2" bucket key
  mkdir -p "$work"
  if [ "$src" = latest ]; then
    bucket="${BACKUP_S3_BUCKET:?}"
    key=$(node "$BACKUP_LIB_DIR/s3.ts" list "$bucket" "${BACKUP_S3_PREFIX:-pg/}" \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const k=s.split("\n").filter(Boolean).map(l=>JSON.parse(l).key).filter(k=>k.endsWith("/manifest.json")).sort();console.log(k.pop()??"")})')
    [ -n "$key" ] || die "no backup manifest found in s3://$bucket/${BACKUP_S3_PREFIX:-pg/}"
    src="s3://$bucket/$key"
  fi
  if [[ "$src" == s3://* ]]; then
    bucket="${src#s3://}"; bucket="${bucket%%/*}"; key="${src#s3://"$bucket"/}"
    log "fetching s3://$bucket/$key"
    node "$BACKUP_LIB_DIR/s3.ts" get "$bucket" "$key" "$work/manifest.json" || die "cannot download manifest"
    MANIFEST="$work/manifest.json"
    local obj; obj=$(json "$MANIFEST" m.object)
    ENC_FILE="$work/$(basename "$obj")"
    node "$BACKUP_LIB_DIR/s3.ts" get "$bucket" "$obj" "$ENC_FILE" || die "cannot download $obj"
  else
    [ -f "$src" ] || die "manifest $src not found"
    MANIFEST="$src"
    ENC_FILE="$(dirname "$src")/$(basename "$(json "$MANIFEST" m.object)")"
    [ -f "$ENC_FILE" ] || die "encrypted dump $ENC_FILE not found next to the manifest"
  fi
  BACKUP_SOURCE="$src"
}

# decrypt_verify <out-dump>  (uses MANIFEST, ENC_FILE, BACKUP_AGE_IDENTITY_FILE)
decrypt_verify() {
  local out="$1" got
  : "${BACKUP_AGE_IDENTITY_FILE:?BACKUP_AGE_IDENTITY_FILE (age private key) is required to decrypt}"
  [ "$(json "$MANIFEST" m.format)" = "ksp-pg-backup/v1" ] || die "unknown manifest format"
  got=$(sha256sum "$ENC_FILE" | cut -d' ' -f1)
  [ "$got" = "$(json "$MANIFEST" m.encryptedSha256)" ] || die "ciphertext SHA-256 mismatch ($got) — backup object corrupted or tampered"
  age --decrypt --identity "$BACKUP_AGE_IDENTITY_FILE" --output "$out" "$ENC_FILE" || die "age decryption failed (wrong key or corrupted ciphertext)"
  got=$(sha256sum "$out" | cut -d' ' -f1)
  [ "$got" = "$(json "$MANIFEST" m.plainSha256)" ] || die "decrypted dump SHA-256 mismatch ($got)"
  pg_restore --list "$out" > /dev/null || die "pg_restore cannot read the decrypted dump"
  log "backup integrity OK (ciphertext + plaintext SHA-256 match the manifest)"
}

# restore_dump <dump> <db-url> [jobs]
restore_dump() {
  local jobs="${3:-4}"
  pg_restore --exit-on-error --no-password --jobs="$jobs" --dbname="$2" "$1" || die "pg_restore failed"
}

# apply_db_settings <admin-url> <db>: re-apply ALTER DATABASE ... SET values recorded in the manifest.
apply_db_settings() {
  local kv name val
  while IFS= read -r kv; do
    [ -n "$kv" ] || continue
    name="${kv%%=*}"; val="${kv#*=}"
    [[ "$name" =~ ^[a-z_.]+$ ]] || die "unexpected database setting name $name in manifest"
    psql "$1" -qX -v ON_ERROR_STOP=1 -v v="$val" <<<"ALTER DATABASE \"$2\" SET $name = :'v'" >/dev/null || die "cannot apply setting $name"
    log "database setting re-applied: $name=$val"
  done < <(json "$MANIFEST" '(m.databaseSettings ?? []).join("\n")')
}

# post_checks <db-url> [--strict]   (uses MANIFEST when set)
#   - schema_migrations: every applied migration exists in db/migrations with the same checksum
#   - audit_verify(): whole chain recomputes, no broken row, and the manifest's head row still has its hash
#   - row counts >= manifest (evidence/audit are append-only, so a restore can never have fewer)
post_checks() {
  local url="$1" strict="${2:-}" q
  q() { psql "$url" -qtAX -v ON_ERROR_STOP=1 -c "$1"; }
  local bad=0 pending=0 f v sum dbsum
  declare -A applied=()
  while IFS='|' read -r v dbsum; do [ -n "$v" ] && applied[$v]="$dbsum"; done < <(q "SELECT version, checksum FROM schema_migrations")
  for f in "$REPO_ROOT"/db/migrations/[0-9][0-9][0-9][0-9]_*.sql; do
    v=$(basename "$f"); sum=$(sha256sum "$f" | cut -d' ' -f1)
    if [ -z "${applied[$v]:-}" ]; then pending=$((pending + 1)); continue; fi
    [ "${applied[$v]}" = "$sum" ] || { log "migration $v checksum differs from repository"; bad=1; }
    unset "applied[$v]"
  done
  for v in "${!applied[@]}"; do log "migration $v applied in DB but missing from repository"; bad=1; done
  [ "$bad" = 0 ] || die "schema_migrations does not match the repository"
  if [ "$pending" -gt 0 ]; then
    [ "$strict" = --strict ] && die "$pending repository migration(s) not applied in the restored database"
    log "note: $pending newer repository migration(s) not in this backup (run migrate after restore)"
  fi
  log "schema_migrations OK ($(q "SELECT count(*) FROM schema_migrations") applied, all checksums match)"

  local res checked first_bad head
  res=$(q "SELECT checked, coalesce(first_bad_seq::text,''), coalesce(head_seq,0) FROM audit_verify()")
  IFS='|' read -r checked first_bad head <<<"$res"
  [ -z "$first_bad" ] || die "audit chain BROKEN at seq $first_bad"
  [ "$checked" = "$head" ] || die "audit_verify checked $checked rows but head is $head"
  log "audit chain OK ($checked events recomputed, head $head)"

  if [ -n "${MANIFEST:-}" ]; then
    local mh mhash rh ev us
    mh=$(json "$MANIFEST" m.audit.headSeq); mhash=$(json "$MANIFEST" m.audit.headHash)
    if [ "$mh" -gt 0 ]; then
      rh=$(q "SELECT hash FROM audit_events WHERE seq = $mh")
      [ "$rh" = "$mhash" ] || die "audit row $mh hash differs from the manifest (history rewritten?)"
    fi
    [ "$head" -ge "$mh" ] || die "restored audit head $head < manifest head $mh"
    ev=$(q "SELECT count(*) FROM evidence"); us=$(q "SELECT count(*) FROM users")
    [ "$ev" -ge "$(json "$MANIFEST" m.rowCounts.evidence)" ] || die "evidence rows $ev < manifest"
    [ "$us" -ge "$(json "$MANIFEST" m.rowCounts.users)" ] || die "user rows $us < manifest"
    log "manifest facts OK (audit head row $mh hash matches; evidence $ev, users $us)"
  fi
}
