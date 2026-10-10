#!/usr/bin/env bash
# Turn on automatic deployment in the demo container (run INSIDE the container, as root):
#
#   bash deploy/proxmox/enable-autodeploy.sh --fqdn ksp.futureacad.ae [--interval 5min] [--branch main]
#   bash deploy/proxmox/enable-autodeploy.sh --disable
#
# Every <interval> the ksp-autodeploy timer runs autodeploy.sh: a new commit on <branch> is deployed once its CI run has
# passed. Status: systemctl list-timers ksp-autodeploy.timer · journalctl -u ksp-autodeploy -n 50 · /var/lib/ksp-autodeploy/
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FQDN=""; INTERVAL=5min; BRANCH=main; DISABLE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --fqdn) FQDN="$2"; shift 2 ;; --interval) INTERVAL="$2"; shift 2 ;; --branch) BRANCH="$2"; shift 2 ;;
    --disable) DISABLE=1; shift ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done

if [ "$DISABLE" = 1 ]; then
  systemctl disable --now ksp-autodeploy.timer 2>/dev/null || true
  echo "automatic deployment disabled (manual updates: bash deploy/proxmox/install-in-lxc.sh --fqdn <fqdn>)"; exit 0
fi
[ -n "$FQDN" ] || { echo "--fqdn is required (the public name, e.g. ksp.futureacad.ae)" >&2; exit 2; }
command -v jq >/dev/null || apt-get install -y -qq jq >/dev/null

cat > /etc/ksp-autodeploy.env <<ENV
KSP_DIR=$DIR
KSP_FQDN=$FQDN
KSP_BRANCH=$BRANCH
KSP_GITHUB_REPO=rooman-itsd/KSP
KSP_REQUIRED_WORKFLOW=ci
# KSP_GITHUB_TOKEN=   # optional (higher API rate limit / private repository): fine-grained token, Actions: read
# KSP_INSTALL_ARGS="--ai-legal-gates off"   # optional extra install-in-lxc.sh flags for every deployment
ENV
chmod 600 /etc/ksp-autodeploy.env

cat > /etc/systemd/system/ksp-autodeploy.service <<UNIT
[Unit]
Description=KSP VMS automatic deployment (CI-verified commits of $BRANCH)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/bash $DIR/deploy/proxmox/autodeploy.sh
TimeoutStartSec=45min
Nice=5
UNIT

cat > /etc/systemd/system/ksp-autodeploy.timer <<UNIT
[Unit]
Description=Check for new CI-verified KSP VMS commits every $INTERVAL

[Timer]
OnBootSec=2min
OnUnitActiveSec=$INTERVAL
RandomizedDelaySec=30s
Persistent=true

[Install]
WantedBy=timers.target
UNIT

mkdir -p /var/lib/ksp-autodeploy
# the currently running checkout counts as deployed; anything newer on $BRANCH will be rolled out
[ -f /var/lib/ksp-autodeploy/deployed ] || git -C "$DIR" rev-parse HEAD > /var/lib/ksp-autodeploy/deployed
systemctl daemon-reload
systemctl enable --now ksp-autodeploy.timer >/dev/null
echo "automatic deployment ON: checks $BRANCH every $INTERVAL, deploys commits whose CI passed"
echo "  deployed now : $(cut -c1-7 /var/lib/ksp-autodeploy/deployed)"
echo "  next check   : $(systemctl list-timers ksp-autodeploy.timer --no-legend | awk '{print $1, $2, $3}')"
echo "  logs         : journalctl -u ksp-autodeploy -f        last deploy: /var/lib/ksp-autodeploy/last-deploy.log"
echo "  run now      : systemctl start ksp-autodeploy         turn off   : bash $DIR/deploy/proxmox/enable-autodeploy.sh --disable"
