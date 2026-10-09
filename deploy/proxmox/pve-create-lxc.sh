#!/usr/bin/env bash
# Run ON THE PROXMOX VE HOST (as root, e.g. via the PVE shell at https://192.168.1.50:8006 → node → Shell).
# Creates an unprivileged Debian 12 LXC with Docker support and installs the KSP VMS demo stack in it.
#
#   bash pve-create-lxc.sh --hostname ksp-vms --fqdn ksp.lan [--ctid 120] [--bridge vmbr0] [--ip dhcp|192.168.1.60/24,gw=192.168.1.1]
#                         [--storage local-lvm] [--disk 80] [--cores 4] [--memory 8192]
#                         [--ghcr-token <PAT with read:packages>]   # pull images; without it they are BUILT from source
#                         [--no-ai]                                   # skip the AI worker + model download (~300 MB)
#
# Afterwards point your reverse proxy (TLS!) at http://<container-ip>:8080 — see reverse-proxy-nginx.conf / README.md.
set -euo pipefail
HOSTNAME_=ksp-vms; FQDN=""; CTID=""; BRIDGE=vmbr0; IP=dhcp; STORAGE=local-lvm; DISK=80; CORES=4; MEMORY=8192; TOKEN=""; AI=1
while [ $# -gt 0 ]; do
  case "$1" in
    --hostname) HOSTNAME_="$2"; shift 2 ;; --fqdn) FQDN="$2"; shift 2 ;; --ctid) CTID="$2"; shift 2 ;;
    --bridge) BRIDGE="$2"; shift 2 ;; --ip) IP="$2"; shift 2 ;; --storage) STORAGE="$2"; shift 2 ;;
    --disk) DISK="$2"; shift 2 ;; --cores) CORES="$2"; shift 2 ;; --memory) MEMORY="$2"; shift 2 ;;
    --ghcr-token) TOKEN="$2"; shift 2 ;; --no-ai) AI=0; shift ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$FQDN" ] || { echo "--fqdn <name users will open, e.g. ksp.lan> is required (APP_BASE_URL = https://<fqdn>)" >&2; exit 2; }
command -v pct >/dev/null || { echo "pct not found — run this on the Proxmox host" >&2; exit 1; }
[ -n "$CTID" ] || CTID=$(pvesh get /cluster/nextid)
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== template"
pveam update >/dev/null
TPL=$(pveam available --section system | awk '/debian-12-standard/ {print $2}' | sort -V | tail -1)
[ -n "$TPL" ] || { echo "no debian-12-standard template available" >&2; exit 1; }
pveam list local | grep -q "$TPL" || pveam download local "$TPL"

echo "== container $CTID ($HOSTNAME_)"
NET="name=eth0,bridge=$BRIDGE,ip=$IP"; [[ "$IP" == dhcp ]] || NET="name=eth0,bridge=$BRIDGE,ip=$IP"
pct create "$CTID" "local:vztmpl/$TPL" --hostname "$HOSTNAME_" --unprivileged 1 --features nesting=1,keyctl=1 \
  --cores "$CORES" --memory "$MEMORY" --swap 1024 --rootfs "$STORAGE:$DISK" --net0 "$NET" --onboot 1 --start 1 \
  --description "KSP Video Evidence Management System (demo). https://github.com/faizanrooman/KSP"
for _ in $(seq 1 30); do pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 && break; sleep 2; done

echo "== installing inside the container"
pct push "$CTID" "$HERE/install-in-lxc.sh" /root/install-in-lxc.sh --perms 0755
ARGS=(--fqdn "$FQDN"); [ -n "$TOKEN" ] && ARGS+=(--ghcr-token "$TOKEN"); [ "$AI" = 1 ] || ARGS+=(--no-ai)
pct exec "$CTID" -- bash /root/install-in-lxc.sh "${ARGS[@]}"

CIP=$(pct exec "$CTID" -- hostname -I | awk '{print $1}')
cat <<EOF

KSP VMS is running in CT $CTID at http://$CIP:8080 (plain HTTP, container only).
Next: on your reverse proxy forward  https://$FQDN  →  http://$CIP:8080  with TLS (self-signed/internal CA is fine for
the demo); config in $HERE/reverse-proxy-nginx.conf (or the Nginx Proxy Manager steps in README.md). Then open
https://$FQDN — demo sign-ins and MFA notes: deploy/proxmox/README.md.
EOF
