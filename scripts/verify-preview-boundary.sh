#!/usr/bin/env bash
# Runtime proof that the Preview NetworkPolicy blocks Production and permits Preview foundation.
set -euo pipefail

usage() {
  printf 'usage: %s <--negative-production|--positive-preview>\n' "${0##*/}" >&2
  exit 2
}

MODE=${1:-}
case "$MODE" in
  --negative-production | --positive-preview) ;;
  *) usage ;;
esac

command -v kubectl >/dev/null 2>&1 || {
  printf 'kubectl is required\n' >&2
  exit 1
}

namespace=combo-preview
probe_image='busybox@sha256:b7f3d86d6e84fc17718c48bcde1450807faa2d56704205c697b4bd5df7b9e29f'
case "$MODE" in
  --negative-production)
    probe_name=preview-boundary-negative
    probe_script=$(cat <<'EOF'
set -eu
for target in \
  postgres.combo-foundation.svc.cluster.local:5432 \
  redis-queue.combo-foundation.svc.cluster.local:6379 \
  redis-hot.combo-foundation.svc.cluster.local:6379 \
  minio.combo-foundation.svc.cluster.local:9000; do
  host=${target%:*}
  port=${target##*:}
  nslookup "$host" >/dev/null
  if nc -z -w 3 "$host" "$port"; then
    echo "Preview boundary failure: Production target is reachable: $target" >&2
    exit 1
  fi
done
EOF
)
    ;;
  --positive-preview)
    probe_name=preview-boundary-positive
    probe_script=$(cat <<'EOF'
set -eu
for target in \
  postgres.combo-preview-foundation.svc.cluster.local:5432 \
  redis-queue.combo-preview-foundation.svc.cluster.local:6379 \
  redis-hot.combo-preview-foundation.svc.cluster.local:6379 \
  minio.combo-preview-foundation.svc.cluster.local:9000; do
  host=${target%:*}
  port=${target##*:}
  nslookup "$host" >/dev/null
  nc -z -w 5 "$host" "$port"
done
EOF
)
    ;;
esac

kubectl -n "$namespace" get networkpolicy preview-egress-boundary >/dev/null
kubectl -n "$namespace" delete pod "$probe_name" --ignore-not-found --wait=true >/dev/null
cleanup() {
  kubectl -n "$namespace" delete pod "$probe_name" --ignore-not-found --wait=false \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT

probe_manifest=$(kubectl -n "$namespace" run "$probe_name" \
  --image="$probe_image" \
  --image-pull-policy=IfNotPresent \
  --restart=Never \
  --dry-run=client \
  -o json \
  --command -- sh -ec "$probe_script")

printf '%s' "$probe_manifest" | python3 -c '
import json
import sys

manifest = json.load(sys.stdin)
spec = manifest["spec"]
spec["automountServiceAccountToken"] = False
spec["enableServiceLinks"] = False
spec["securityContext"] = {
    "runAsNonRoot": True,
    "runAsUser": 65532,
    "runAsGroup": 65532,
    "seccompProfile": {"type": "RuntimeDefault"},
}
container = spec["containers"][0]
container["securityContext"] = {
    "allowPrivilegeEscalation": False,
    "readOnlyRootFilesystem": True,
    "capabilities": {"drop": ["ALL"]},
}
container["resources"] = {
    "requests": {"cpu": "5m", "memory": "8Mi"},
    "limits": {"cpu": "50m", "memory": "32Mi"},
}
json.dump(manifest, sys.stdout)
' | kubectl create -f - >/dev/null

phase=
for _ in $(seq 1 120); do
  phase=$(kubectl -n "$namespace" get pod "$probe_name" -o jsonpath='{.status.phase}')
  case "$phase" in
    Succeeded | Failed) break ;;
  esac
  sleep 1
done
kubectl -n "$namespace" logs "$probe_name" || true
if [[ "$phase" != Succeeded ]]; then
  printf 'Preview boundary probe failed: mode=%s phase=%s\n' "$MODE" "${phase:-unknown}" >&2
  exit 1
fi

printf 'preview_boundary_verified mode=%s\n' "${MODE#--}"
