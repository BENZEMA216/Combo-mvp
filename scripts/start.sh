#!/usr/bin/env bash
# 全栈起栈（O-05 / 技术方案 §6.2）。固定启动顺序（硬性）：
#   postgres → logto_db_seed → logto_alteration → logto → migrate(业务迁移) → 业务容器(api/worker/runtime/web)
# Logto OSS 不自跑迁移：先 CLI db seed 建表，再把 alteration 作为单实例一次性 job 跑，跑完才起 logto 运行态。
# 业务迁移失败即止、不起业务容器。任一步失败立刻退出（set -e + pipefail）。
#
# 本期【无 Docker】：脚本只写不跑；逻辑/顺序经评审，留作后续 compose up。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/infra/docker-compose.yml"
COMPOSE=(docker compose -f "${COMPOSE_FILE}")

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
ENV_FILE="${ROOT_DIR}/.env"
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
# LOGTO_AUDIENCE/ANTHROPIC_API_KEY 不在此列：aud 由 compose :? 兜（非弱默认语义）；LLM key 允许空（degraded 不计 /ready）。
REQUIRED_SECRETS=(
  POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB
  S3_ACCESS_KEY S3_SECRET_KEY
  LOGTO_APP_ID LOGTO_APP_SECRET
  GRAFANA_ADMIN_PASSWORD
)

GUARD_FAILED=0
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

# 1) 起数据与中间件，等其 healthy（depends_on condition 已 gate，--wait 再兜底）
log "1/6 起 postgres / redis_queue / redis_hot / minio / observability，并等待 healthy ..."
"${COMPOSE[@]}" up -d --wait postgres redis_queue redis_hot minio loki tempo otel-collector grafana

# 1b) 建 ObjectStore 四桶（一次性容器，跑完退出）
log "1b 建 MinIO 四桶 ..."
"${COMPOSE[@]}" run --rm minio_mc

# 2) Logto 建表（一次性，幂等可重入）
log "2/6 logto_db_seed（CLI db seed，建表 + 初始数据）..."
"${COMPOSE[@]}" run --rm logto_db_seed

# 3) Logto schema alteration（一次性、单实例 job；CI=true 非交互）
log "3/6 logto_alteration（CLI db alteration deploy，单实例）..."
"${COMPOSE[@]}" run --rm logto_alteration

# 4) 起 Logto 运行态，等其 healthy（健康检查断言 OIDC discovery issuer/jwks_uri）
log "4/6 起 logto 运行态并等待 OIDC discovery 就绪 ..."
"${COMPOSE[@]}" up -d --wait logto

# 5) 业务迁移（一次性，失败即止、不起业务容器）
log "5/6 业务迁移（db/scripts/migrate.ts）..."
"${COMPOSE[@]}" run --rm migrate || die "业务迁移失败，已中止；业务容器未启动"

# 6) 起业务容器（api/worker/runtime/web），等 healthy
log "6/6 起 api / worker / runtime / web ..."
"${COMPOSE[@]}" up -d --wait api worker runtime web

log "全栈已启动。健康检查："
log "  - API   : http://localhost:3000/ready"
log "  - Web   : http://localhost/"
log "  - Logto : http://localhost:3001/oidc/.well-known/openid-configuration"
log "  - MinIO : http://localhost:9001 (console)"
log "  - Grafana: http://localhost:3003/d/combo-trace-debug/trace-debug"
