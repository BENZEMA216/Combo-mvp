#!/usr/bin/env bash
# 集成：Redis 双实例分工断言（O-05 / 70 §8.1）。两实例必须 PING 通，且驱逐/持久化策略对立——
#   redis_queue：maxmemory-policy=noeviction + appendonly=yes（队列绝不丢）
#   redis_hot  ：maxmemory-policy=allkeys-lru（热缓存可驱逐）
# 入参：REDIS_QUEUE_HOST/PORT、REDIS_HOT_HOST/PORT（默认本地 6379/6380）。需 redis-cli。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
QUEUE_HOST="${REDIS_QUEUE_HOST:-localhost}"
QUEUE_PORT="${REDIS_QUEUE_PORT:-6379}"
HOT_HOST="${REDIS_HOT_HOST:-localhost}"
HOT_PORT="${REDIS_HOT_PORT:-6380}"

log() { printf '\033[1;34m[it:redis]\033[0m %s\n' "$*"; }
fail() {
  printf '\033[1;31m[it:redis:fail]\033[0m %s\n' "$*" >&2
  exit 1
}

command -v redis-cli >/dev/null 2>&1 || fail "需要 redis-cli"
command -v pnpm >/dev/null 2>&1 || fail "需要 pnpm"

# 1) 两实例 PING
[ "$(redis-cli -h "$QUEUE_HOST" -p "$QUEUE_PORT" ping)" = "PONG" ] || fail "redis_queue 不通"
[ "$(redis-cli -h "$HOT_HOST" -p "$HOT_PORT" ping)" = "PONG" ] || fail "redis_hot 不通"
log "两实例 PING ✓"

# 2) redis_queue：noeviction + AOF
q_policy="$(redis-cli -h "$QUEUE_HOST" -p "$QUEUE_PORT" config get maxmemory-policy | tail -1)"
[ "$q_policy" = "noeviction" ] || fail "redis_queue 驱逐策略应为 noeviction，实际 ${q_policy}"
q_aof="$(redis-cli -h "$QUEUE_HOST" -p "$QUEUE_PORT" config get appendonly | tail -1)"
[ "$q_aof" = "yes" ] || fail "redis_queue 应开 AOF（appendonly yes），实际 ${q_aof}"
log "redis_queue = noeviction + AOF ✓"

# 3) redis_hot：allkeys-lru（可驱逐）
h_policy="$(redis-cli -h "$HOT_HOST" -p "$HOT_PORT" config get maxmemory-policy | tail -1)"
[ "$h_policy" = "allkeys-lru" ] || fail "redis_hot 驱逐策略应为 allkeys-lru，实际 ${h_policy}"
log "redis_hot = allkeys-lru ✓"

# 4) 策略对立性（两实例不能同策略，否则混用污染）
[ "$q_policy" != "$h_policy" ] || fail "两实例驱逐策略相同（${q_policy}），违反物理分实例意图"
log "双实例策略对立 ✓"

log "验证两个 Authoring replica 共用 redis_hot 且 Redis 故障时失败关闭 ..."
env \
  MCP_RATE_LIMIT_REDIS_URL="redis://${HOT_HOST}:${HOT_PORT}/0" \
  pnpm --dir "$ROOT_DIR/apps/authoring" exec vitest run \
    src/__tests__/external-mcp-rate-limit.integration.test.ts

log "Redis 双实例集成通过 ✓"
