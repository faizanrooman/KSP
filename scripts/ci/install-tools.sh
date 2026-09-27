#!/usr/bin/env bash
# Install the pinned, checksum-verified validator binaries used by scripts/ci/validate-deploy.sh and the backup
# tests into <checkout>/.local/bin (Linux x86_64):
#   hadolint · shellcheck · kustomize · kubeconform · actionlint · age (+ age-keygen) · promtool
#   scripts/ci/install-tools.sh [--dest DIR] [--force]
# Every download is checked against the SHA-256 pinned below BEFORE anything is extracted or made executable; a
# mismatch aborts. Pins were recorded 2026-09-27 and cross-checked against the upstream checksum files where the
# project publishes one (hadolint .sha256, kustomize/actionlint checksums.txt, kubeconform CHECKSUMS, prometheus
# sha256sums.txt); shellcheck and age publish no checksum file (pinned on first use over HTTPS). Idempotent: a tool
# whose installed version marker matches is skipped (--force reinstalls).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEST="$ROOT/.local/bin"; FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "usage: $0 [--dest DIR] [--force]" >&2; exit 2 ;;
  esac
done
[ "$(uname -s)-$(uname -m)" = "Linux-x86_64" ] || { echo "install-tools.sh: only Linux x86_64 is pinned (got $(uname -s)-$(uname -m))" >&2; exit 1; }
for t in curl sha256sum tar; do command -v "$t" >/dev/null || { echo "install-tools.sh: $t is required" >&2; exit 1; }; done
mkdir -p "$DEST"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
GH=https://github.com

# name | version | url | sha256 | archive member(s) -> installed as basename ("-" = the download is the binary)
TOOLS=(
  "hadolint|2.12.0|$GH/hadolint/hadolint/releases/download/v2.12.0/hadolint-Linux-x86_64|56de6d5e5ec427e17b74fa48d51271c7fc0d61244bf5c90e828aab8362d55010|-"
  "shellcheck|0.10.0|$GH/koalaman/shellcheck/releases/download/v0.10.0/shellcheck-v0.10.0.linux.x86_64.tar.xz|6c881ab0698e4e6ea235245f22832860544f17ba386442fe7e9d629f8cbedf87|shellcheck-v0.10.0/shellcheck"
  "kustomize|5.4.3|$GH/kubernetes-sigs/kustomize/releases/download/kustomize%2Fv5.4.3/kustomize_v5.4.3_linux_amd64.tar.gz|3669470b454d865c8184d6bce78df05e977c9aea31c30df3c669317d43bcc7a7|kustomize"
  "kubeconform|0.6.7|$GH/yannh/kubeconform/releases/download/v0.6.7/kubeconform-linux-amd64.tar.gz|95f14e87aa28c09d5941f11bd024c1d02fdc0303ccaa23f61cef67bc92619d73|kubeconform"
  "actionlint|1.7.7|$GH/rhysd/actionlint/releases/download/v1.7.7/actionlint_1.7.7_linux_amd64.tar.gz|023070a287cd8cccd71515fedc843f1985bf96c436b7effaecce67290e7e0757|actionlint"
  "age|1.2.1|$GH/FiloSottile/age/releases/download/v1.2.1/age-v1.2.1-linux-amd64.tar.gz|7df45a6cc87d4da11cc03a539a7470c15b1041ab2b396af088fe9990f7c79d50|age/age age/age-keygen"
  "promtool|2.53.4|$GH/prometheus/prometheus/releases/download/v2.53.4/prometheus-2.53.4.linux-amd64.tar.gz|b8b497c4610d1b93208252b60c8f20f6b2e78596ae8df43397a2e805aa53d475|prometheus-2.53.4.linux-amd64/promtool"
)

for spec in "${TOOLS[@]}"; do
  IFS='|' read -r name version url sha members <<<"$spec"
  marker="$DEST/.$name.version"
  if [ "$FORCE" = 0 ] && [ -f "$marker" ] && [ "$(cat "$marker")" = "$version $sha" ] && [ -x "$DEST/$name" ]; then
    echo "ok    $name $version (already installed)"; continue
  fi
  file="$TMP/$name.download"
  curl -fsSL --retry 3 --proto '=https' --tlsv1.2 -o "$file" "$url"
  got="$(sha256sum "$file" | cut -d' ' -f1)"
  if [ "$got" != "$sha" ]; then
    echo "FAIL  $name $version: SHA-256 $got does not match the pinned $sha — not installed" >&2
    exit 1
  fi
  if [ "$members" = "-" ]; then
    install -m 0755 "$file" "$DEST/$name"
  else
    x="$TMP/$name.x"; mkdir -p "$x"
    # shellcheck disable=SC2086  # members is a space-separated list of archive paths
    tar -xf "$file" -C "$x" $members
    for m in $members; do install -m 0755 "$x/$m" "$DEST/$(basename "$m")"; done
  fi
  echo "$version $sha" > "$marker"
  echo "inst  $name $version (sha256 verified)"
done
echo "validators installed in $DEST"
