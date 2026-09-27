#!/usr/bin/env bash
# Reproduce the minikube production-artefact verification environment end to end (docs/DEPLOYMENT.md "minikube").
#
#   scripts/ops/minikube-up.sh [--skip-build] [--from <step>] [--only <step>]
#   steps: cluster operator build secrets infra iam migrate models seed workloads status
#
# What it does (no host Docker permission needed — the kvm2 VM has its own Docker daemon):
#   cluster    minikube (kvm2, Calico CNI so NetworkPolicies are ENFORCED, ingress + metrics-server addons)
#   operator   CloudNativePG operator (pinned release manifest, SHA-256 checked)
#   build      all Dockerfile targets (api worker ai-worker web backup) built INSIDE the VM -> ksp/<target>:dev
#   secrets    scripts/ops/generate-secrets.sh --format k8s into $KSP_MK_SECRETS (outside the repo, 0700) + MinIO
#              root, CNPG scratch superuser, self-signed TLS for ksp.local; applied as Secrets (never committed)
#   infra      namespace/config/NetworkPolicies/CNPG clusters/MinIO from deploy/k8s/overlays/minikube
#   iam        MinIO IAM users + policies from deploy/s3/policies/*.json, DR-side buckets (Object Lock)
#   migrate    the migrate Job (schema as owner + bucket provisioning) — must complete before workloads
#   models     the AI models Job (download + SHA-256 verify + register)
#   seed       DEV SEED (test users with the published dev password) — TEST ENVIRONMENT ONLY
#   workloads  api (2) / worker / ai-worker / web / CronJobs / HPAs / PDBs / Ingress; waits for rollouts
# Requires: minikube, python3 + PyYAML, openssl, age-keygen (for backup keys), curl; kubectl/kustomize/docker are
# taken from minikube / .local/bin when not on PATH.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NS=ksp-vms-staging
OVERLAY="$ROOT/deploy/k8s/overlays/minikube"
SECRETS="${KSP_MK_SECRETS:-$HOME/.ksp-minikube-secrets}"
CNPG_VERSION=1.30.1
CNPG_SHA256=${CNPG_SHA256:-}   # optional pin of the release manifest; printed on first download
MC_IMAGE=cgr.dev/chainguard/minio-client@sha256:f0dd93b48af1f8a641edcd3c64661c8dbe05189bd2ef2f8cea216eb18af10bf8
MK_CPUS=${MK_CPUS:-4} MK_MEMORY=${MK_MEMORY:-6g} MK_DISK=${MK_DISK:-40g}
SKIP_BUILD=0; FROM=""; ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift ;;
    --from) FROM="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    -h|--help) sed -n 2,24p "$0"; exit 0 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
STEPS=(cluster operator build secrets infra iam migrate models seed workloads status)
run_step() {
  local s="$1"
  if [ -n "$ONLY" ]; then [ "$ONLY" = "$s" ]; return; fi
  if [ -n "$FROM" ]; then
    for x in "${STEPS[@]}"; do [ "$x" = "$FROM" ] && break; [ "$x" = "$s" ] && return 1; done
  fi
  return 0
}
log() { printf '\n== %s\n' "$*"; }

# --- tools -------------------------------------------------------------------------------------------------------
TOOLS="$(mktemp -d)"; trap 'rm -rf "$TOOLS"' EXIT
export PATH="$TOOLS:$ROOT/.local/bin:$PATH"
if ! command -v kubectl >/dev/null; then
  printf '#!/bin/sh\nexec minikube kubectl -- "$@"\n' > "$TOOLS/kubectl"; chmod +x "$TOOLS/kubectl"
fi
command -v kustomize >/dev/null || { echo "kustomize missing: run scripts/ci/install-tools.sh" >&2; exit 1; }
python3 -c 'import yaml' 2>/dev/null || { echo "python3 with PyYAML is required" >&2; exit 1; }
docker_env() {
  # shellcheck disable=SC2046  # minikube prints export lines
  eval "$(minikube docker-env --shell bash)"
}

# Render an overlay and keep only the documents selected by a python predicate on (kind, name).
select_docs() { # $1 = kustomize dir, $2 = python expression over k (kind) and n (name)
  kustomize build "$1" | python3 -c '
import sys, yaml
expr = sys.argv[1]
docs = [d for d in yaml.safe_load_all(sys.stdin) if d]
out = [d for d in docs if eval(expr, {}, {"k": d["kind"], "n": d["metadata"]["name"]})]
yaml.safe_dump_all(out, sys.stdout, sort_keys=False)' "$2"
}
INFRA_KINDS='k in ("Namespace","ServiceAccount","ConfigMap","NetworkPolicy","Cluster","ScheduledBackup","PersistentVolumeClaim") or n.startswith("ksp-minio")'

# --- steps -------------------------------------------------------------------------------------------------------
if run_step cluster; then
  log "minikube cluster (kvm2, Calico, ingress, metrics-server)"
  if ! minikube status >/dev/null 2>&1; then
    minikube start --driver=kvm2 --cpus="$MK_CPUS" --memory="$MK_MEMORY" --disk-size="$MK_DISK" --cni=calico \
      --addons=ingress --addons=metrics-server
  else
    minikube start --addons=ingress --addons=metrics-server
  fi
  kubectl -n ingress-nginx rollout status deployment/ingress-nginx-controller --timeout=10m
fi

if run_step operator; then
  log "CloudNativePG operator $CNPG_VERSION"
  f="$TOOLS/cnpg.yaml"
  curl -fsSL --retry 3 -o "$f" "https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/release-${CNPG_VERSION%.*}/releases/cnpg-${CNPG_VERSION}.yaml"
  got=$(sha256sum "$f" | cut -d' ' -f1)
  if [ -n "$CNPG_SHA256" ] && [ "$got" != "$CNPG_SHA256" ]; then echo "CNPG manifest SHA-256 $got != pinned $CNPG_SHA256" >&2; exit 1; fi
  echo "cnpg-${CNPG_VERSION}.yaml sha256=$got"
  kubectl apply --server-side --force-conflicts -f "$f" >/dev/null
  kubectl -n cnpg-system rollout status deployment/cnpg-controller-manager --timeout=10m
fi

if run_step build && [ "$SKIP_BUILD" = 0 ]; then
  log "images (built inside the minikube VM)"
  docker_env
  for t in api worker ai-worker web backup; do
    docker build -f "$ROOT/deploy/docker/Dockerfile" --target "$t" -t "ksp/$t:dev" "$ROOT"
  done
  docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | grep '^ksp/'
fi

if run_step secrets; then
  log "secrets -> $SECRETS (never commit; delete with the cluster)"
  VERIFY_PW_FILE="$SECRETS/ksp_verify_superuser_password"
  mkdir -p "$SECRETS"; chmod 700 "$SECRETS"
  [ -s "$VERIFY_PW_FILE" ] || (umask 077; openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 32 > "$VERIFY_PW_FILE")
  "$ROOT/scripts/ops/generate-secrets.sh" --out "$SECRETS" --format k8s --env-name minikube --namespace "$NS" \
    --verify-admin-url "postgres://postgres:$(cat "$VERIFY_PW_FILE")@ksp-verify-rw:5432/postgres?sslmode=require" >/dev/null
  kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  kubectl apply -f "$SECRETS/k8s-secrets.yaml"
  kubectl -n "$NS" create secret generic ksp-minio-root --dry-run=client -o yaml \
    --from-file=MINIO_ROOT_USER="$SECRETS/s3_root_access_key" --from-file=MINIO_ROOT_PASSWORD="$SECRETS/s3_root_secret_key" | kubectl apply -f -
  kubectl -n "$NS" create secret generic ksp-verify-superuser --type=kubernetes.io/basic-auth --dry-run=client -o yaml \
    --from-literal=username=postgres --from-file=password="$VERIFY_PW_FILE" | kubectl apply -f -
  if [ ! -s "$SECRETS/tls.crt" ]; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=ksp.local" -addext "subjectAltName=DNS:ksp.local" \
      -keyout "$SECRETS/tls.key" -out "$SECRETS/tls.crt" 2>/dev/null
  fi
  kubectl -n "$NS" create secret tls ksp-vms-tls --cert="$SECRETS/tls.crt" --key="$SECRETS/tls.key" --dry-run=client -o yaml | kubectl apply -f -
fi

if run_step infra; then
  log "infrastructure (namespace, config, NetworkPolicies, PostgreSQL clusters, MinIO)"
  select_docs "$OVERLAY" "$INFRA_KINDS" | kubectl apply -f -
  kubectl -n "$NS" rollout status deployment/ksp-minio --timeout=10m
  kubectl -n "$NS" wait --for=condition=Ready cluster/ksp-db cluster/ksp-verify --timeout=15m
fi

if run_step iam; then
  log "MinIO IAM (deploy/s3/policies) + DR-side buckets"
  kubectl -n "$NS" create configmap ksp-s3-policies --from-file="$ROOT/deploy/s3/policies" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  keys=(s3_access_key s3_secret_key s3_ai_access_key s3_ai_secret_key backup_s3_access_key backup_s3_secret_key
        s3_replica_read_access_key s3_replica_read_secret_key dr_s3_access_key dr_s3_secret_key wal_s3_access_key
        wal_s3_secret_key s3_provision_access_key s3_provision_secret_key s3_root_access_key s3_root_secret_key)
  args=(); for k in "${keys[@]}"; do args+=("--from-file=$k=$SECRETS/$k"); done
  kubectl -n "$NS" create secret generic ksp-minio-iam "${args[@]}" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  kubectl -n "$NS" delete job ksp-minio-iam --ignore-not-found --wait=true >/dev/null
  cat <<YAML | kubectl apply -f -
apiVersion: batch/v1
kind: Job
metadata: { name: ksp-minio-iam, namespace: $NS }
spec:
  backoffLimit: 2
  ttlSecondsAfterFinished: 3600
  template:
    metadata: { labels: { ksp.police/s3-client: "true" } }
    spec:
      restartPolicy: Never
      automountServiceAccountToken: false
      securityContext: { runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532, seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: mc
          image: $MC_IMAGE
          command: ["sh", "-ec"]
          args:
            - |
              export MC_CONFIG_DIR=/tmp/.mc MC_HOST_ksp="http://\$(cat /k/s3_root_access_key):\$(cat /k/s3_root_secret_key)@ksp-minio:9000"
              for p in app ai backup replicate wal provision; do mc admin policy create ksp "ksp-\$p" "/p/\$p.json"; done
              u() { mc admin user add ksp "\$(cat /k/\$1)" "\$(cat /k/\$2)"; mc admin policy attach ksp "ksp-\$3" --user "\$(cat /k/\$1)" || true; }
              u s3_access_key s3_secret_key app
              u s3_ai_access_key s3_ai_secret_key ai
              u backup_s3_access_key backup_s3_secret_key backup
              u s3_replica_read_access_key s3_replica_read_secret_key replicate
              u dr_s3_access_key dr_s3_secret_key replicate
              u wal_s3_access_key wal_s3_secret_key wal
              u s3_provision_access_key s3_provision_secret_key provision
              # DR-site buckets (created by the storage team in production): backups WORM, WAL archive versioned.
              mc mb --ignore-existing --with-lock ksp/ksp-db-backups
              mc mb --ignore-existing ksp/ksp-pg-wal
              mc admin user list ksp
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
          resources: { requests: { cpu: 50m, memory: 64Mi }, limits: { cpu: 500m, memory: 256Mi } }
          volumeMounts: [{ name: k, mountPath: /k, readOnly: true }, { name: p, mountPath: /p, readOnly: true }, { name: tmp, mountPath: /tmp }]
      volumes:
        - { name: k, secret: { secretName: ksp-minio-iam } }
        - { name: p, configMap: { name: ksp-s3-policies } }
        - { name: tmp, emptyDir: { sizeLimit: 16Mi } }
YAML
  kubectl -n "$NS" wait --for=condition=complete job/ksp-minio-iam --timeout=5m || { kubectl -n "$NS" logs job/ksp-minio-iam; exit 1; }
  kubectl -n "$NS" logs job/ksp-minio-iam | tail -12
fi

if run_step migrate; then
  log "migrate Job"
  kubectl -n "$NS" delete job ksp-migrate --ignore-not-found --wait=true >/dev/null
  select_docs "$OVERLAY/jobs" 'n == "ksp-migrate"' | kubectl apply -f -
  kubectl -n "$NS" wait --for=condition=complete job/ksp-migrate --timeout=30m || { kubectl -n "$NS" logs job/ksp-migrate --tail=100; exit 1; }
  kubectl -n "$NS" logs job/ksp-migrate --tail=15
fi

if run_step models; then
  log "AI models Job (download + SHA-256 verify + register)"
  select_docs "$OVERLAY" 'k == "PersistentVolumeClaim"' | kubectl apply -f - >/dev/null
  kubectl -n "$NS" delete job ksp-ai-models --ignore-not-found --wait=true >/dev/null
  select_docs "$OVERLAY/jobs" 'n == "ksp-ai-models"' | kubectl apply -f -
  kubectl -n "$NS" wait --for=condition=complete job/ksp-ai-models --timeout=30m || { kubectl -n "$NS" logs job/ksp-ai-models --tail=100; exit 1; }
  kubectl -n "$NS" logs job/ksp-ai-models --tail=15
fi

if run_step seed; then
  log "DEV SEED (test-only users, published dev password) — never run this against staging/production"
  kubectl -n "$NS" delete job ksp-seed-dev --ignore-not-found --wait=true >/dev/null
  select_docs "$OVERLAY/jobs" 'n == "ksp-migrate"' | python3 -c '
import sys, yaml
d = yaml.safe_load(sys.stdin)
d["metadata"]["name"] = "ksp-seed-dev"; d["metadata"]["labels"]["app.kubernetes.io/name"] = "ksp-seed-dev"
t = d["spec"]["template"]; t["metadata"]["labels"] = {"app.kubernetes.io/name": "ksp-seed-dev", "ksp.police/db-client": "true"}
c = t["spec"]["containers"][0]; c["name"] = "seed"; c["command"] = ["node", "packages/core/dist/bin/seed.js"]
c["env"] = [{"name": "KSP_SEED_CLI", "value": "1"}]
c["envFrom"] = [e for e in c["envFrom"] if e.get("secretRef", {}).get("name") != "ksp-migrate"]
yaml.safe_dump(d, sys.stdout, sort_keys=False)' | kubectl apply -f -
  kubectl -n "$NS" wait --for=condition=complete job/ksp-seed-dev --timeout=10m || { kubectl -n "$NS" logs job/ksp-seed-dev --tail=50; exit 1; }
  kubectl -n "$NS" logs job/ksp-seed-dev --tail=3
fi

if run_step workloads; then
  log "workloads"
  kustomize build "$OVERLAY" | kubectl apply -f -
  for d in ksp-api ksp-worker ksp-ai-worker ksp-web; do kubectl -n "$NS" rollout status "deployment/$d" --timeout=15m; done
fi

if run_step status; then
  log "status"
  kubectl -n "$NS" get pods -o wide
  kubectl -n "$NS" get hpa,pdb,ingress,cluster 2>/dev/null || true
  echo; echo "Add to /etc/hosts:  $(minikube ip) ksp.local    then open https://ksp.local (self-signed certificate)"
  echo "DEV users (seeded): password Ksp@Dev-Passw0rd! — this environment is for verification only."
fi
