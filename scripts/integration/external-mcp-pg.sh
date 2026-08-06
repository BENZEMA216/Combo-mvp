#!/usr/bin/env bash
# 集成：远程 MCP OAuth 的真实 PostgreSQL 契约。DCR 套件会 TRUNCATE OAuth 测试表，
# 因此只允许 disposable loopback PostgreSQL；共享、Test 与生产数据库必须 fail closed。
# 入参：DATABASE_URL、POSTGRES_API_PASSWORD。不得输出派生连接串或密码。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

log() { printf '\033[1;34m[it:mcp-pg]\033[0m %s\n' "$*"; }
fail() {
  printf '\033[1;31m[it:mcp-pg:fail]\033[0m %s\n' "$*" >&2
  exit 1
}

: "${DATABASE_URL:?需设置 DATABASE_URL（指向已完成迁移的 PostgreSQL）}"
: "${POSTGRES_API_PASSWORD:?需设置 POSTGRES_API_PASSWORD}"
command -v node >/dev/null 2>&1 || fail "需要 Node.js"
command -v pnpm >/dev/null 2>&1 || fail "需要 pnpm"

bash "${SCRIPT_DIR}/assert-disposable-postgres.sh"

# 仅在内存中把 owner URL 改写为最小权限 API 角色 URL。解析失败只输出稳定错误，
# 不得把原始 URL 或密码写入日志、文件或测试参数。
api_database_url="$(
  DATABASE_URL="$DATABASE_URL" POSTGRES_API_PASSWORD="$POSTGRES_API_PASSWORD" \
    node --input-type=module -e '
      let url;
      try {
        url = new URL(process.env.DATABASE_URL ?? "");
      } catch {
        process.stderr.write("[it:mcp-pg:fail] DATABASE_URL 配置不合法\n");
        process.exit(2);
      }
      if (!new Set(["postgres:", "postgresql:"]).has(url.protocol)) {
        process.stderr.write("[it:mcp-pg:fail] DATABASE_URL 协议不合法\n");
        process.exit(2);
      }
      const password = process.env.POSTGRES_API_PASSWORD;
      if (!password) process.exit(2);
      url.username = "combo_api";
      url.password = password;
      process.stdout.write(url.href);
    '
)"
trap 'api_database_url=""; unset api_database_url' EXIT

log "验证 refresh family 并发与重放关闭 ..."
env \
  MCP_OAUTH_PG_TEST=1 \
  DATABASE_URL="$DATABASE_URL" \
  pnpm --dir "$ROOT_DIR/apps/authoring" exec vitest run \
    src/__tests__/external-mcp-refresh.pg.test.ts

log "验证 DCR 去重、容量、索引、最小权限与 touch 竞态 ..."
env \
  MCP_OAUTH_PG_TEST=1 \
  DATABASE_URL="$DATABASE_URL" \
  MCP_OAUTH_API_DATABASE_URL="$api_database_url" \
  pnpm --dir "$ROOT_DIR/apps/authoring" exec vitest run \
    src/__tests__/external-mcp-dcr.pg.test.ts

log "远程 MCP OAuth PostgreSQL 集成通过 ✓"
