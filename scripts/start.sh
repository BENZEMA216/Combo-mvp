#!/usr/bin/env bash
# 全栈起栈（O-05）。固定启动顺序（硬性）：
#   基础设施 → 0000–0014 业务迁移与应用角色配置 → API/Worker/Runtime/Web。
# 业务迁移失败即止、不起业务容器。任一步失败立刻退出（set -e + pipefail）。
#
# 本期【无 Docker】：脚本只写不跑；逻辑/顺序经评审，留作后续 compose up。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/infra/docker-compose.yml"
ENV_FILE="${ROOT_DIR}/.env"
COMPOSE=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")

log() { printf '\033[1;34m[start]\033[0m %s\n' "$*"; }
die() {
  printf '\033[1;31m[start:error]\033[0m %s\n' "$*" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || die "需要 docker（本期无 Docker，留作后续运行）"

# 0) 生产无默认密钥守卫（Codex#13 + r5）：本编排即生产栈（业务容器 NODE_ENV=production）。
#    compose 的 ${VAR:?} 已拦「未设/空」，但示例密钥（combo/agora/minioadmin…）会满足 :? = 绕过
#    「无默认密钥」。故起栈前在此显式拒绝空值与已知弱默认值，与 Authoring 环境 schema 的生产守卫双保险。
#    从 .env（compose 自动加载）取值校验；未提供 .env 时这些变量也为空，照样被拦。
if [[ -f "${ENV_FILE}" ]]; then
  # 仅取本守卫关心的密钥行，避免 source 整文件带来副作用（注释/特殊字符）。
  set -a
  # shellcheck disable=SC1090  # 指令须紧贴被抑制的 source 行（原先在 set -a 上方 → 落空，未抑制到本行）。
  . "${ENV_FILE}"
  set +a
fi

# 已知弱默认值黑名单（大小写不敏感比较）。命中即拒绝起栈。
WEAK_DEFAULTS=("combo" "agora" "minioadmin" "postgres" "password" "admin" "root" "changeme" "secret" "test")

is_weak() {
  # $1 = 待校验值。空 → 弱；命中黑名单 → 弱。
  local val="${1:-}"
  [[ -z "${val}" ]] && return 0
  local lower
  lower="$(printf '%s' "${val}" | tr '[:upper:]' '[:lower:]')"
  local w
  for w in "${WEAK_DEFAULTS[@]}"; do
    [[ "${lower}" == "${w}" ]] && return 0
  done
  return 1
}

# 生产必填且禁弱默认的密钥项（与 .env.compose.example / compose ${VAR:?} 对齐）。
# LLM key 允许空（degraded 不计 /ready），不在此列表。
REQUIRED_SECRETS=(
  POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB
  POSTGRES_API_PASSWORD POSTGRES_WORKER_PASSWORD POSTGRES_RUNTIME_PASSWORD
  S3_ACCESS_KEY S3_SECRET_KEY
  RESEND_API_KEY OTP_HMAC_SECRET
  GRAFANA_ADMIN_PASSWORD
)
REQUIRED_CONFIG=(PUBLIC_APP_ORIGINS EXTERNAL_MCP_PUBLIC_ORIGIN)

GUARD_FAILED=0
for key in "${REQUIRED_CONFIG[@]}"; do
  val="${!key:-}"
  if [[ -z "${val}" ]]; then
    printf '\033[1;31m[start:guard]\033[0m %s 未设（生产必填配置）\n' "${key}" >&2
    GUARD_FAILED=1
  fi
done
for key in "${REQUIRED_SECRETS[@]}"; do
  val="${!key:-}"
  if [[ -z "${val}" ]]; then
    printf '\033[1;31m[start:guard]\033[0m %s 未设（生产禁空密钥）\n' "${key}" >&2
    GUARD_FAILED=1
  elif is_weak "${val}"; then
    printf '\033[1;31m[start:guard]\033[0m %s = 已知弱默认值（combo/agora/minioadmin 等）禁上生产\n' "${key}" >&2
    GUARD_FAILED=1
  fi
done
if [[ "${GUARD_FAILED}" -ne 0 ]]; then
  die "弱默认/空密钥守卫拒绝起栈：请在 .env（参 .env.compose.example）填强随机密钥后重试。"
fi
log "0/6 密钥守卫通过（无空值、无已知弱默认）。"

# Compose 不删除已经从清单移除的服务。只删除当前项目带精确服务标签的旧
# Logto 容器；不触碰卷、数据服务或其他 Compose 项目。
COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-infra}"
OBSOLETE_SERVICES=(logto logto_db_seed logto_alteration)
remove_obsolete_project_containers() {
  local service container_id
  local -a obsolete_ids=()
  for service in "${OBSOLETE_SERVICES[@]}"; do
    while IFS= read -r container_id; do
      [[ -n "${container_id}" ]] && obsolete_ids+=("${container_id}")
    done < <(
      docker ps -aq \
        --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" \
        --filter "label=com.docker.compose.service=${service}"
    )
  done
  if ((${#obsolete_ids[@]} > 0)); then
    docker rm -f "${obsolete_ids[@]}" >/dev/null
  fi
  for service in "${OBSOLETE_SERVICES[@]}"; do
    if [[ -n "$(
      docker ps -aq \
        --filter "label=com.docker.compose.project=${COMPOSE_PROJECT}" \
        --filter "label=com.docker.compose.service=${service}"
    )" ]]; then
      die "当前 Compose 项目的废弃 ${service} 容器仍存在，拒绝执行迁移"
    fi
  done
}

log "1/6 删除并确认当前 Compose 项目的废弃身份服务容器 ..."
remove_obsolete_project_containers

# 第一方认证迁移是停机式切换，旧应用容器不能与迁移并行。
log "2/6 停止并确认当前项目的旧业务容器已经退出 ..."
"${COMPOSE[@]}" stop --timeout 60 api worker runtime web
if [[ -n "$("${COMPOSE[@]}" ps --status running -q api worker runtime web)" ]]; then
  die "旧业务容器仍在运行，拒绝执行停机式认证迁移"
fi

log "3/6 起 postgres / redis_queue / redis_hot / minio / observability，并等待 healthy ..."
"${COMPOSE[@]}" up -d --wait postgres redis_queue redis_hot minio loki tempo otel-collector grafana

log "4/6 建 MinIO 四桶 ..."
"${COMPOSE[@]}" up --no-deps --abort-on-container-exit --exit-code-from minio_mc minio_mc \
  || die "对象存储桶初始化失败，数据库迁移与业务容器保持停止"

log "5/6 业务迁移与固定应用角色配置（db/scripts/migrate.ts）..."
"${COMPOSE[@]}" up --no-deps --abort-on-container-exit --exit-code-from migrate migrate \
  || die "业务迁移失败，已中止；业务容器未启动"

log "6/6 起 api / worker / runtime / web ..."
"${COMPOSE[@]}" up -d --wait api worker runtime web

log "全栈已启动。健康检查："
log "  - API   : http://localhost:3000/ready"
log "  - Web   : http://localhost/"
log "  - MinIO : http://localhost:9001 (console)"
log "  - Grafana: http://localhost:3003/d/combo-trace-debug/trace-debug"
