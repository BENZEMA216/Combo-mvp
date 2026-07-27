#!/usr/bin/env bash
# 业务迁移封装（O-05 / 技术方案 §6.6）。先确认 postgres 可达，再跑 @cb/db 的 runner（只加不减、向后兼容，脊柱 §1.1）。
# 两种模式：
#   本地（默认）   ：直接用宿主 node 跑 @cb/db migrate（需 DATABASE_URL 指向可达 PG）。
#   compose（--compose）：通过 docker compose run --rm migrate（同镜像、容器内跑）。
# 第一方认证表与业务表由同一个 runner 按文件顺序迁移。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/infra/docker-compose.yml"

log() { printf '\033[1;34m[migrate]\033[0m %s\n' "$*"; }
die() {
  printf '\033[1;31m[migrate:error]\033[0m %s\n' "$*" >&2
  exit 1
}

MODE="local"
STATUS_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --compose) MODE="compose" ;;
    --status) STATUS_ONLY=1 ;;
    *) die "未知参数：$arg（用 --compose / --status）" ;;
  esac
done

if [ "$MODE" = "compose" ]; then
  command -v docker >/dev/null 2>&1 || die "需要 docker"
  log "compose 模式：docker compose run --rm migrate ..."
  if [ "$STATUS_ONLY" -eq 1 ]; then
    docker compose -f "$COMPOSE_FILE" run --rm --entrypoint \
      "node --experimental-strip-types db/scripts/migrate.ts --status" migrate
  else
    docker compose -f "$COMPOSE_FILE" run --rm migrate
  fi
  exit 0
fi

# 本地模式
command -v pnpm >/dev/null 2>&1 || die "需要 pnpm"
: "${DATABASE_URL:?需设置 DATABASE_URL（指向可达的 PostgreSQL）}"

if [ "$STATUS_ONLY" -eq 1 ]; then
  log "迁移状态（使用已配置的 DATABASE_URL，不输出连接信息）"
  pnpm -C "$ROOT_DIR" -F @cb/db migrate:status
else
  log "执行业务迁移（使用已配置的 DATABASE_URL，不输出连接信息）"
  pnpm -C "$ROOT_DIR" -F @cb/db migrate
fi
