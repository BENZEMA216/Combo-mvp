#!/bin/bash
# k3s 停机式部署：先预检，再停止旧业务面，单独完成迁移，最后逐个部署同一 SHA 的业务镜像。
# 只允许部署已经具备第一方认证 schema 的兼容镜像；数据库问题只能前滚修复。
set -Eeuo pipefail

SHA="${SHA:?SHA 必填（完整提交 SHA，三镜像必须已在 GHCR）}"
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config}"
SRC="${K8S_SOURCE_DIR:-/opt/combo/infra/k8s}"
WORK="${K8S_WORK_DIR:-$HOME/combo-k8s-deploy}"
DEPLOYMENTS=(api worker runtime web)
PREVIOUS_REPLICAS=()
PREVIOUS_REVISIONS=()
PREVIOUS_IMAGES=()
PREVIOUS_EXISTS=()
TOUCHED_DEPLOYMENTS=()
ROLLBACK_ARMED=0
MIGRATION_JOB_MAY_RUN=0
AUTH_MIGRATION_WAS_APPLIED=f

log() { printf '[deploy-k8s] %s\n' "$*"; }

pg_scalar() {
  local sql="$1"
  # 变量由 PostgreSQL 容器内的 sh 展开，宿主不得读取 Secret 值。
  # shellcheck disable=SC2016
  kubectl -n combo exec statefulset/postgres -- sh -ceu \
    'psql -X -qAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"' \
    sh "$sql"
}

deployment_images() {
  local deployment="$1"
  kubectl -n combo get "deployment/$deployment" \
    -o jsonpath='{range .spec.template.spec.containers[*]}{.name}={.image}{"\n"}{end}' | sort
}

terminate_migration_job() {
  log '终止迁移 Job，并等待 Job 与所属 Pod 全部消失。'
  kubectl -n combo delete job migrate --ignore-not-found \
    --cascade=foreground --wait=true --timeout=180s >/dev/null
  if kubectl -n combo get job/migrate >/dev/null 2>&1; then
    log '迁移 Job 删除后仍然存在，拒绝恢复旧工作负载。' >&2
    return 1
  fi

  local deadline=$((SECONDS + 180))
  while [[ -n "$(kubectl -n combo get pods -l job-name=migrate -o name 2>/dev/null)" ]]; do
    if ((SECONDS >= deadline)); then
      log '迁移 Pod 未在超时内退出，拒绝恢复旧工作负载。' >&2
      return 1
    fi
    sleep 1
  done
}

quiesce_business_workloads() {
  local deployment
  for deployment in "${DEPLOYMENTS[@]}"; do
    if kubectl -n combo get "deployment/$deployment" >/dev/null 2>&1; then
      kubectl -n combo scale "deployment/$deployment" --replicas=0 >/dev/null
    fi
  done
  for deployment in "${DEPLOYMENTS[@]}"; do
    if kubectl -n combo get "deployment/$deployment" >/dev/null 2>&1; then
      kubectl -n combo rollout status "deployment/$deployment" --timeout=300s
    fi
  done
}

restore_previous_workloads() {
  local index deployment current_revision current_images
  log 'schema 仍兼容旧版本；先清空新 Pod，再恢复旧 Deployment revision、镜像和副本数。'
  quiesce_business_workloads

  for index in "${!DEPLOYMENTS[@]}"; do
    deployment="${DEPLOYMENTS[$index]}"
    if [[ "${PREVIOUS_EXISTS[$index]:-0}" == 1 ]]; then
      if [[ "${TOUCHED_DEPLOYMENTS[$index]:-0}" == 1 ]]; then
        current_revision="$(
          kubectl -n combo get "deployment/$deployment" \
            -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}'
        )"
        current_images="$(deployment_images "$deployment")"
        if [[ "$current_revision" != "${PREVIOUS_REVISIONS[$index]}" || \
          "$current_images" != "${PREVIOUS_IMAGES[$index]}" ]]; then
          kubectl -n combo rollout undo "deployment/$deployment" \
            --to-revision="${PREVIOUS_REVISIONS[$index]}" >/dev/null
        fi
      fi
    elif [[ "${TOUCHED_DEPLOYMENTS[$index]:-0}" == 1 ]]; then
      kubectl -n combo delete "deployment/$deployment" --wait=true --timeout=180s >/dev/null
    fi
  done

  for index in "${!DEPLOYMENTS[@]}"; do
    deployment="${DEPLOYMENTS[$index]}"
    if [[ "${PREVIOUS_EXISTS[$index]:-0}" == 1 ]]; then
      kubectl -n combo scale "deployment/$deployment" \
        --replicas="${PREVIOUS_REPLICAS[$index]}" >/dev/null
    fi
  done
  for index in "${!DEPLOYMENTS[@]}"; do
    deployment="${DEPLOYMENTS[$index]}"
    if [[ "${PREVIOUS_EXISTS[$index]:-0}" == 1 && \
      "${PREVIOUS_REPLICAS[$index]}" != 0 ]]; then
      kubectl -n combo rollout status "deployment/$deployment" --timeout=300s
    fi
  done

  for index in "${!DEPLOYMENTS[@]}"; do
    deployment="${DEPLOYMENTS[$index]}"
    if [[ "${PREVIOUS_EXISTS[$index]:-0}" != 1 ]]; then
      continue
    fi
    current_images="$(deployment_images "$deployment")"
    if [[ "$current_images" != "${PREVIOUS_IMAGES[$index]}" ]]; then
      log "deployment/$deployment 未恢复到先前镜像，保持部署失败状态。" >&2
      return 1
    fi
  done
}

cleanup_on_error() {
  local status=$?
  trap - EXIT
  if [[ "$status" -ne 0 && "$ROLLBACK_ARMED" -eq 1 ]]; then
    if [[ "$MIGRATION_JOB_MAY_RUN" -eq 1 ]]; then
      if ! terminate_migration_job; then
        log '无法证明迁移 Job 已停止；不检查 schema，也不恢复任何旧 Pod。' >&2
        exit "$status"
      fi
      MIGRATION_JOB_MAY_RUN=0
    fi

    local current_auth_migration='unknown'
    current_auth_migration="$(
      pg_scalar "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = '0007_first_party_email_auth.sql');" \
        2>/dev/null || printf unknown
    )"
    if [[ "$AUTH_MIGRATION_WAS_APPLIED" == t || "$current_auth_migration" == f ]]; then
      if ! restore_previous_workloads; then
        log '旧工作负载回滚未完成，部署保持失败。' >&2
        status=1
      fi
    else
      log '认证 schema 已切换或状态未知，旧镜像保持停止；必须以前滚修复恢复服务。' >&2
    fi
  fi
  exit "$status"
}
trap cleanup_on_error EXIT

rsync -a --delete "$SRC/" "$WORK/"

# 在修改任何 Deployment 之前确认 0007 已执行，或旧 users 表仍为空。
schema_migrations_exists="$(pg_scalar "SELECT to_regclass('public.schema_migrations') IS NOT NULL;")"
if [[ "$schema_migrations_exists" == t ]]; then
  AUTH_MIGRATION_WAS_APPLIED="$(
    pg_scalar "SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = '0007_first_party_email_auth.sql');"
  )"
fi
if [[ "$AUTH_MIGRATION_WAS_APPLIED" != t ]]; then
  users_exists="$(pg_scalar "SELECT to_regclass('public.users') IS NOT NULL;")"
  if [[ "$users_exists" == t ]]; then
    users_empty="$(pg_scalar 'SELECT NOT EXISTS (SELECT 1 FROM users);')"
    [[ "$users_empty" == t ]] || {
      log 'users 非空，第一方认证迁移预检失败；未修改任何 Deployment。' >&2
      exit 1
    }
  fi
fi
log '第一方认证迁移预检通过。'

for index in "${!DEPLOYMENTS[@]}"; do
  deployment="${DEPLOYMENTS[$index]}"
  if kubectl -n combo get "deployment/$deployment" >/dev/null 2>&1; then
    PREVIOUS_EXISTS[index]=1
    PREVIOUS_REPLICAS[index]="$(
      kubectl -n combo get "deployment/$deployment" -o jsonpath='{.spec.replicas}'
    )"
    PREVIOUS_REPLICAS[index]="${PREVIOUS_REPLICAS[$index]:-1}"
    PREVIOUS_REVISIONS[index]="$(
      kubectl -n combo get "deployment/$deployment" \
        -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}'
    )"
    PREVIOUS_IMAGES[index]="$(deployment_images "$deployment")"
    if [[ -z "${PREVIOUS_REVISIONS[$index]}" || -z "${PREVIOUS_IMAGES[$index]}" ]]; then
      log "deployment/$deployment 缺少可回滚 revision 或镜像，未修改任何工作负载。" >&2
      exit 1
    fi
  else
    PREVIOUS_EXISTS[index]=0
  fi
done

# 必须先武装 EXIT 回滚，再执行第一次 scale-down，避免中途信号留下部分停机状态。
ROLLBACK_ARMED=1
log '停止当前命名空间的旧业务工作负载。'
quiesce_business_workloads

log '单独创建并等待 SHA 固定的迁移 Job。'
MIGRATION_JOB_MAY_RUN=1
terminate_migration_job
MIGRATION_MANIFEST="$WORK/job-migrate.pinned.yaml"
sed "s#ghcr.io/dangdang-tech/combo-api:latest#ghcr.io/dangdang-tech/combo-api:$SHA#g" \
  "$WORK/job-migrate.yaml" >"$MIGRATION_MANIFEST"
grep -Fq "ghcr.io/dangdang-tech/combo-api:$SHA" "$MIGRATION_MANIFEST"
if grep -Fq 'ghcr.io/dangdang-tech/combo-api:latest' "$MIGRATION_MANIFEST"; then
  log '迁移 Job 仍引用 latest，拒绝部署。' >&2
  exit 1
fi
kubectl -n combo apply -f "$MIGRATION_MANIFEST"
kubectl -n combo wait --for=condition=complete job/migrate --timeout=300s
MIGRATION_JOB_MAY_RUN=0

log '迁移完成后逐个部署并等待同一 SHA 的四个业务面。'
for index in "${!DEPLOYMENTS[@]}"; do
  deployment="${DEPLOYMENTS[$index]}"
  pinned="$WORK/${deployment}.pinned.yaml"
  sed \
    -e "s#ghcr.io/dangdang-tech/combo-api:latest#ghcr.io/dangdang-tech/combo-api:$SHA#g" \
    -e "s#ghcr.io/dangdang-tech/combo-runtime:latest#ghcr.io/dangdang-tech/combo-runtime:$SHA#g" \
    -e "s#ghcr.io/dangdang-tech/combo-web:latest#ghcr.io/dangdang-tech/combo-web:$SHA#g" \
    "$WORK/${deployment}.yaml" >"$pinned"
  if grep -Eq 'ghcr\.io/dangdang-tech/combo-(api|runtime|web):latest' "$pinned"; then
    log "${deployment} 清单仍引用 latest，拒绝部署。" >&2
    exit 1
  fi
  TOUCHED_DEPLOYMENTS[index]=1
  kubectl -n combo apply -f "$pinned"
  kubectl -n combo rollout status "deployment/$deployment" --timeout=300s
done

ROLLBACK_ARMED=0
trap - EXIT
log "已部署 $SHA"
