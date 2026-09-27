#!/usr/bin/env bash
# Negative + positive tests for verify-backup.sh. Every corrupted/tampered backup MUST be rejected.
#
#   scripts/backup/test/verify-backup.test.sh
#
# Needs: a migrated KSP database to back up (PG* env, default = this checkout's dev DB on 127.0.0.1:5433), a role
# with CREATEDB (VERIFY_ADMIN_URL, default postgres://ksp@127.0.0.1:5433/postgres), age, pg tools, node.
# Uses local-only backups (no object storage). Creates and drops its own scratch databases.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
B="$HERE/.."
export PGHOST="${PGHOST:-127.0.0.1}" PGPORT="${PGPORT:-5433}" PGUSER="${PGUSER:-ksp}" PGDATABASE="${PGDATABASE:?PGDATABASE (source db) is required}"
export VERIFY_ADMIN_URL="${VERIFY_ADMIN_URL:-postgres://$PGUSER@$PGHOST:$PGPORT/postgres}"
T="$(mktemp -d "${TMPDIR:-/tmp}/ksp-verify-test.XXXXXX")"
TMPDB="ksp_vtest_$$"
cleanup() { psql "$VERIFY_ADMIN_URL" -qtAX -c "DROP DATABASE IF EXISTS \"$TMPDB\" WITH (FORCE)" >/dev/null 2>&1 || true; rm -rf "$T"; }
trap cleanup EXIT
unset BACKUP_RECORD_URL
export PGOPTIONS="-c client_min_messages=warning"
export BACKUP_WORK_DIR="$T/work"; mkdir -p "$BACKUP_WORK_DIR"

age-keygen -o "$T/id" 2>/dev/null; age-keygen -y "$T/id" > "$T/id.pub"
age-keygen -o "$T/wrong" 2>/dev/null
export BACKUP_AGE_RECIPIENTS_FILE="$T/id.pub" BACKUP_AGE_IDENTITY_FILE="$T/id"
# Manifest signing key (OPS-8) + an unrelated key for the forged-signature case.
openssl genpkey -algorithm ed25519 -out "$T/sign.key" 2>/dev/null; openssl pkey -in "$T/sign.key" -pubout -out "$T/sign.pub"
openssl genpkey -algorithm ed25519 -out "$T/other.key" 2>/dev/null
export BACKUP_SIGNING_KEY_FILE="$T/sign.key" BACKUP_SIGNING_PUBKEY_FILE="$T/sign.pub"
resign() { openssl pkeyutl -sign -inkey "${2:-$T/sign.key}" -rawin -in "$1" -out "$1.sig"; }

pass=0; failures=0
expect() { # expect <ok|fail> <name> <manifest> [identity]
  local want="$1" name="$2" m="$3" id="${4:-$T/id}" rc=0
  BACKUP_AGE_IDENTITY_FILE="$id" bash "$B/verify-backup.sh" "$m" > "$T/$name.log" 2>&1 || rc=$?
  if { [ "$want" = ok ] && [ "$rc" = 0 ]; } || { [ "$want" = fail ] && [ "$rc" != 0 ]; }; then
    pass=$((pass + 1)); echo "PASS $name (exit $rc: $(grep -m1 -E 'FAIL:|VERIFY_OK' "$T/$name.log" | cut -c10-110))"
  else
    failures=$((failures + 1)); echo "FAIL $name (expected $want, exit $rc)"; sed 's/^/    /' "$T/$name.log"
  fi
}
# copy_backup <name> -> dir with manifest.json + dump.age copies of the pristine backup
copy_backup() { mkdir -p "$T/$1"; cp "$BASE_DIR"/* "$T/$1/"; echo "$T/$1/manifest.json"; }
# reseal <dir> <plain-dump>: re-encrypt a modified dump and rewrite the manifest hashes, i.e. an attacker who
# holds the PUBLIC age key forges a self-consistent backup. It is re-signed with the real signing key (worst case:
# signing key compromised too), so only the semantic checks can catch this.
reseal() {
  local dir="$1" plain="$2" enc; enc="$dir/$(basename "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).object)' "$dir/manifest.json")")"
  age -e -R "$T/id.pub" -o "$enc" "$plain"
  node -e 'const fs=require("fs"),c=require("crypto");const [m,p,e]=process.argv.slice(1);const j=JSON.parse(fs.readFileSync(m));const h=f=>c.createHash("sha256").update(fs.readFileSync(f)).digest("hex");j.plainSha256=h(p);j.encryptedSha256=h(e);j.plainSizeBytes=fs.statSync(p).size;j.encryptedSizeBytes=fs.statSync(e).size;fs.writeFileSync(m,JSON.stringify(j,null,2))' "$dir/manifest.json" "$plain" "$enc"
  resign "$dir/manifest.json"
}
# edit_manifest <manifest> <js statement over j>
edit_manifest() { node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1]));(new Function("j",process.argv[2]))(j);fs.writeFileSync(process.argv[1],JSON.stringify(j,null,2))' "$1" "$2"; }
tampered_dump() { # tampered_dump <sql> <out>: restore pristine dump, run SQL as superuser, dump again
  psql "$VERIFY_ADMIN_URL" -qtAX -c "DROP DATABASE IF EXISTS \"$TMPDB\" WITH (FORCE)" -c "CREATE DATABASE \"$TMPDB\"" >/dev/null
  pg_restore --exit-on-error -d "$TMPDB" "$T/pristine.dump"
  psql -d "$TMPDB" -qtAX -v ON_ERROR_STOP=1 -c "$1" >/dev/null
  pg_dump -Fc -d "$TMPDB" -f "$2"
}

# --- pristine backup
OUT=$(bash "$B/pg-backup.sh" --local-only "$T/backups" | tail -1)
BASE_DIR="$(dirname "${OUT#BACKUP_OK file:}")"
M0="$BASE_DIR/manifest.json"
ENC0="$BASE_DIR/$(basename "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).object)' "$M0")")"
age -d -i "$T/id" -o "$T/pristine.dump" "$ENC0"

expect ok pristine "$M0"
[ -s "$M0.sig" ] || { echo "FAIL pg-backup.sh did not write manifest.json.sig"; exit 1; }

# --- manifest signature (OPS-8)
m=$(copy_backup forged-manifest); edit_manifest "$m" 'j.rowCounts.evidence = 0; j.createdAt = "2000-01-01T00:00:00Z"'
expect fail manifest-modified-signature-kept "$m"

m=$(copy_backup other-key); edit_manifest "$m" 'j.rowCounts.users = 0'; resign "$m" "$T/other.key"
expect fail manifest-signed-by-other-key "$m"

m=$(copy_backup unsigned); rm -f "$m.sig"
expect fail manifest-signature-missing "$m"

m=$(copy_backup legacy-unsigned-no-pubkey); rm -f "$m.sig"
BACKUP_SIGNING_PUBKEY_FILE='' expect ok legacy-unsigned-without-pubkey "$m"
BACKUP_SIGNING_PUBKEY_FILE='' BACKUP_REQUIRE_SIGNATURE=1 expect fail unsigned-with-require-signature "$m"

m=$(copy_backup headseq-injection); edit_manifest "$m" 'j.audit.headSeq = "1; DROP TABLE evidence; --"'; resign "$m"
expect fail manifest-headseq-not-integer "$m"

m=$(copy_backup bitflip); f=$(ls "$(dirname "$m")"/*.age)
printf '\xff' | dd of="$f" bs=1 seek=$(( $(stat -c %s "$f") / 2 )) conv=notrunc status=none
expect fail ciphertext-bitflip "$m"

m=$(copy_backup truncated); f=$(ls "$(dirname "$m")"/*.age); truncate -s $(( $(stat -c %s "$f") - 4096 )) "$f"
expect fail ciphertext-truncated "$m"

m=$(copy_backup wrongkey)
expect fail wrong-identity "$m" "$T/wrong"

m=$(copy_backup truncated-dump-resealed); head -c $(( $(stat -c %s "$T/pristine.dump") / 2 )) "$T/pristine.dump" > "$T/half.dump"
reseal "$(dirname "$m")" "$T/half.dump"
expect fail plaintext-truncated-resealed "$m"

m=$(copy_backup audit-tamper-resealed)
tampered_dump "ALTER TABLE audit_events DISABLE TRIGGER USER; UPDATE audit_events SET details = details || '{\"tampered\":true}'::jsonb WHERE seq = (SELECT max(seq) FROM audit_events) - 1; ALTER TABLE audit_events ENABLE TRIGGER USER;" "$T/audit.dump"
reseal "$(dirname "$m")" "$T/audit.dump"
expect fail audit-ledger-tampered-resealed "$m"

m=$(copy_backup migration-checksum-resealed)
tampered_dump "UPDATE schema_migrations SET checksum = repeat('0', 64) WHERE version = (SELECT min(version) FROM schema_migrations)" "$T/mig.dump"
reseal "$(dirname "$m")" "$T/mig.dump"
expect fail migration-checksum-resealed "$m"

m=$(copy_backup audit-rows-deleted-resealed)
tampered_dump "ALTER TABLE audit_events DISABLE TRIGGER USER; DELETE FROM audit_events WHERE seq >= (SELECT max(seq) FROM audit_events) - 1; ALTER TABLE audit_events ENABLE TRIGGER USER;" "$T/trunc.dump"
reseal "$(dirname "$m")" "$T/trunc.dump"
expect fail audit-tail-deleted-resealed "$m"

echo "verify-backup tests: $pass passed, $failures failed"
[ "$failures" = 0 ]
