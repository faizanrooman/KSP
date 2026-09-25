#!/usr/bin/env bash
# Ordered Kubernetes rollout: (1) migrate Job to completion, (2) workloads, (3) wait for rollouts.
#   scripts/ops/k8s-deploy.sh <staging|production> <image-tag> [image-prefix=ghcr.io/ksp]
# Rolls back nothing automatically: a failed migration stops the deploy before any new pod starts (old pods keep
# serving); a failed rollout is reported and can be undone with `kubectl rollout undo` (docs/OPERATIONS.md).
set -euo pipefail
ENV="${1:?environment}"; TAG="${2:?image tag}"; PREFIX="${3:-ghcr.io/ksp}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
case "$ENV" in staging) NS=ksp-vms-staging ;; production) NS=ksp-vms ;; *) echo "unknown env $ENV" >&2; exit 2 ;; esac
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
cp -r "$ROOT/deploy/k8s" "$W/k8s"
for d in "$W/k8s/overlays/$ENV" "$W/k8s/overlays/$ENV/jobs"; do
  (cd "$d" && for i in api worker ai-worker web backup; do
     grep -q "ksp/$i" kustomization.yaml && kustomize edit set image "ksp/$i=$PREFIX/$i:$TAG"; done; true)
done
echo "== migrate ($NS, $TAG)"
kubectl -n "$NS" delete job ksp-migrate --ignore-not-found --wait=true
kustomize build "$W/k8s/overlays/$ENV/jobs" | kubectl apply -f - --selector app.kubernetes.io/name=ksp-migrate
kubectl -n "$NS" wait --for=condition=complete job/ksp-migrate --timeout=30m || {
  kubectl -n "$NS" logs job/ksp-migrate --tail=200 || true
  echo "migration failed — deploy stopped (running pods untouched)" >&2; exit 1; }
echo "== workloads"
kustomize build "$W/k8s/overlays/$ENV" | kubectl apply -f -
for d in ksp-api ksp-worker ksp-ai-worker ksp-web; do kubectl -n "$NS" rollout status "deployment/$d" --timeout=15m; done
echo "deployed $TAG to $ENV"
