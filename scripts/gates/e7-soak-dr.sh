#!/usr/bin/env bash
# VNext E7 Soak/DR/UAT — 骨架（fail-closed）。
# 用法: scripts/gates/e7-soak-dr.sh [soak|dr|uat]
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NOT_RUN=0

log() { printf '[E7] %s\n' "$*"; }
fail() { log "NOT_RUN: $*"; NOT_RUN=1; }

MODE="${1:-soak}"
log "== E7 ($MODE) =="

# 前置：E6 环境 + 用户授权
[ -n "${VNX_E7_API_BASE_URL:-}" ] || fail 'VNX_E7_API_BASE_URL 未设置'
[ "${VNX_E6_DEPLOY_AUTHORIZED:-}" = 'true' ] || fail '部署/执行未获用户显式授权'

if [ "$NOT_RUN" -eq 1 ]; then
  log '== E7: NOT_RUN =='
  exit 2
fi

case "$MODE" in
  soak)
    log 'Soak 十阶段（runbook §5 / 测试方案 §21.3）：'
    log '  1. 20 Consumer idle SSE'
    log '  2. 每秒创建/关闭 Conversation'
    log '  3. 3 Deployment × (1 active + 10 queued)，第 11 个拒绝'
    log '  4. 10 WSS 每 10s heartbeat'
    log '  5. Redis restart'
    log '  6. Gateway rolling restart'
    log '  7. backlog 1000 drain'
    log '  8. slow Consumer / backpressure'
    log '  9. 429 / rate-limit'
    log '  10. 持续 1h（Alpha 容量场景 §21.2）'
    log '（当前为骨架；环境就绪后在每阶段实现探针与断言）'
    ;;
  dr)
    log 'DR（T7-DR）：临时 namespace/数据库恢复 PG/MinIO/KEK/Cloud；'
    log '绝不覆盖 Test 当前实例；记录 RPO/RTO 与恢复后真实聊天。'
    ;;
  uat)
    log 'UAT：受邀真人在第二设备试用；问题分级记录。'
    ;;
  *)
    log "未知模式: $MODE" >&2
    exit 1
    ;;
esac

log '== E7 skeleton ready（NOT_RUN 状态不变）=='
