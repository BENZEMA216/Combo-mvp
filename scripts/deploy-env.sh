#!/usr/bin/env bash
# deploy-env.sh — 在 tecent2 主机上部署指定环境（boundary / foundation / migrate / apps）。
# 三环境共用一套应用 overlay（in-place 命名），并连接各自独立的 foundation。
# foundation 与 migrate 持 per-foundation 锁；apps rollout 不持共享锁，按环境并行。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat >&2 <<'EOF'
usage: deploy-env.sh <boundary|foundation|migrate|apps> --environment test|preview|production
       [--manifest FILE --manifest-digest DIGEST] [--kubeconfig PATH] [--render-dir DIR] [--wait]
EOF
  exit 2
}

COMMAND="${1:-}"
shift || true

ENVIRONMENT=
MANIFEST=
MANIFEST_DIGEST=
KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"
RENDER_DIR=
WAIT=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --environment) ENVIRONMENT=$2; shift 2 ;;
    --manifest) MANIFEST=$2; shift 2 ;;
    --manifest-digest) MANIFEST_DIGEST=$2; shift 2 ;;
    --kubeconfig) KUBECONFIG=$2; shift 2 ;;
    --render-dir) RENDER_DIR=$2; shift 2 ;;
    --no-wait) WAIT=0; shift ;;
    *) usage ;;
  esac
done

[[ -n "$ENVIRONMENT" ]] || usage
case "$COMMAND" in
  boundary|foundation|migrate|apps) ;;
  *) usage ;;
esac

K=(kubectl --kubeconfig "$KUBECONFIG")

case "$ENVIRONMENT" in
  test) NAMESPACE=combo-test; FOUNDATION_SET='test'; FOUNDATION_NS=combo-test ;;
  preview) NAMESPACE=combo-preview; FOUNDATION_SET='preview'; FOUNDATION_NS=combo-preview-foundation ;;
  production) NAMESPACE=combo-prod; FOUNDATION_SET='shared'; FOUNDATION_NS=combo-foundation ;;
  *) usage ;;
esac

WORK=$(mktemp -d "$HOME/data/combo-deploy.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

fatal() {
  echo "deploy-env: $*" >&2
  exit 1
}

render_phase() {
  local phase=$1
  if [[ -n "$RENDER_DIR" ]]; then
    [[ -f "$RENDER_DIR/$phase.yaml" ]] || fatal "pre-rendered $phase.yaml not found in $RENDER_DIR"
    cp "$RENDER_DIR/$phase.yaml" "$WORK/$phase.yaml"
    return
  fi
  local args=(--environment "$ENVIRONMENT" --phase "$phase" --output "$WORK/$phase.yaml")
  if [[ "$phase" != foundation && "$phase" != boundary ]]; then
    [[ -f "$MANIFEST" ]] || fatal '--manifest is required for migrate/apps'
    [[ -n "$MANIFEST_DIGEST" ]] || fatal '--manifest-digest is required for migrate/apps'
    args+=(--manifest "$MANIFEST" --manifest-digest "$MANIFEST_DIGEST")
  fi
  node "$SCRIPT_DIR/render-env.mjs" "${args[@]}"
}

require_preview_boundary() {
  [[ "$ENVIRONMENT" != preview ]] && return 0
  "${K[@]}" -n combo-preview get networkpolicy preview-egress-boundary >/dev/null ||
    fatal 'Preview egress boundary is missing'
  "${K[@]}" -n combo-preview-foundation get networkpolicy \
    preview-foundation-ingress-boundary >/dev/null ||
    fatal 'Preview foundation ingress boundary is missing'
}

ensure_namespace() {
  local ns=$1
  if ! "${K[@]}" get namespace "$ns" >/dev/null 2>&1; then
    "${K[@]}" create namespace "$ns"
  fi
}

require_secret() {
  local ns=$1
  local name=$2
  if ! "${K[@]}" -n "$ns" get secret "$name" >/dev/null 2>&1; then
    fatal "namespace $ns is missing required secret $name; provision it before deploying"
  fi
}

foundation_lock() {
  mkdir -p "$HOME/data"
  exec 9>"$HOME/data/combo-foundation-$FOUNDATION_SET.lock"
  flock -w 900 9 || fatal "timed out waiting for the $FOUNDATION_SET foundation lock"
}

wait_ready() {
  local phase=$1
  case "$phase" in
    foundation)
      local resource
      for resource in statefulset/postgres statefulset/minio statefulset/redis-queue deployment/redis-hot; do
        "${K[@]}" -n "$FOUNDATION_NS" rollout status "$resource" --timeout=300s || {
          "${K[@]}" -n "$FOUNDATION_NS" describe "$resource" >&2 || true
          fatal "rollout of $resource failed"
        }
      done
      "${K[@]}" -n "$FOUNDATION_NS" wait \
        --for=condition=complete job/minio-init --timeout=300s || {
        "${K[@]}" -n "$FOUNDATION_NS" logs job/minio-init --tail=100 >&2 || true
        fatal 'minio-init job failed'
      }
      ;;
    migrate)
      local job
      job=$("${K[@]}" -n "$NAMESPACE" get job migrate -o jsonpath='{.metadata.name}' 2>/dev/null || true)
      if [[ -n "$job" ]]; then
        "${K[@]}" -n "$NAMESPACE" wait --for=condition=complete job/migrate --timeout=300s || {
          "${K[@]}" -n "$NAMESPACE" logs job/migrate --tail=100 >&2 || true
          fatal 'migrate job failed'
        }
      fi
      ;;
    apps)
      for deploy in api worker runtime web; do
        "${K[@]}" -n "$NAMESPACE" rollout status "deployment/$deploy" --timeout=300s || {
          "${K[@]}" -n "$NAMESPACE" describe "deployment/$deploy" >&2 || true
          fatal "rollout of $deploy failed"
        }
      done
      ;;
  esac
}

case "$COMMAND" in
  boundary)
    [[ "$ENVIRONMENT" == preview ]] || fatal 'boundary phase is Preview-only'
    ensure_namespace "$NAMESPACE"
    ensure_namespace "$FOUNDATION_NS"
    render_phase boundary
    "${K[@]}" apply -f "$WORK/boundary.yaml"
    require_preview_boundary
    ;;
  foundation)
    foundation_lock
    ensure_namespace "$FOUNDATION_NS"
    require_secret "$FOUNDATION_NS" combo-env
    render_phase foundation
    "${K[@]}" apply -f "$WORK/foundation.yaml"
    [[ "$WAIT" == 1 ]] && wait_ready foundation
    ;;
  migrate)
    require_preview_boundary
    foundation_lock
    ensure_namespace "$NAMESPACE"
    require_secret "$NAMESPACE" combo-env
    require_secret "$NAMESPACE" ghcr-pull
    render_phase migrate
    "${K[@]}" -n "$NAMESPACE" delete job migrate --ignore-not-found --wait=false >/dev/null 2>&1 || true
    "${K[@]}" apply -f "$WORK/migrate.yaml"
    [[ "$WAIT" == 1 ]] && wait_ready migrate
    ;;
  apps)
    require_preview_boundary
    ensure_namespace "$NAMESPACE"
    require_secret "$NAMESPACE" combo-env
    require_secret "$NAMESPACE" ghcr-pull
    render_phase apps
    "${K[@]}" apply -f "$WORK/apps.yaml"
    [[ "$WAIT" == 1 ]] && wait_ready apps
    ;;
esac

echo "deploy-env: $COMMAND for $ENVIRONMENT completed"
