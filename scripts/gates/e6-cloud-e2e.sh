#!/usr/bin/env bash
# VNext E6 Real Cloud E2E — Golden Path 编排骨架（fail-closed）。
# 仅在环境齐备且获得部署授权后执行；任何前置缺失即 NOT_RUN 退出。
# 用法: scripts/gates/e6-cloud-e2e.sh [golden-path|two-creator|version-update|remote-fault|gateway-rollout|nat-sleep-wake]
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EVIDENCE_DIR="${VNX_E6_EVIDENCE_DIR:-$ROOT_DIR/evidence/e6}"
NOT_RUN=0

log() { printf '[E6] %s\n' "$*"; }
fail() { log "NOT_RUN: $*"; NOT_RUN=1; }

SCENARIO="${1:-golden-path}"
log "== E6 Real Cloud E2E ($SCENARIO) =="

# 环境与授权门（全部强制）
[ -n "${VNX_E6_API_BASE_URL:-}" ] || fail 'VNX_E6_API_BASE_URL 未设置（Test 云 API 端点）'
[ -n "${VNX_E6_GATEWAY_WS_URL:-}" ] || fail 'VNX_E6_GATEWAY_WS_URL 未设置（Gateway WSS 端点）'
[ -n "${VNX_E6_CREATOR_MAC_TOKEN:-}" ] || fail 'VNX_E6_CREATOR_MAC_TOKEN 未设置（Creator Mac 会话令牌）'
[ -n "${VNX_E6_SECOND_NETWORK_CONSUMER:-}" ] || fail 'VNX_E6_SECOND_NETWORK_CONSUMER 未设置（第二网络 Consumer 设备端点）'
[ "${VNX_E6_DEPLOY_AUTHORIZED:-}" = 'true' ] || fail 'VNX_E6_DEPLOY_AUTHORIZED != true（用户未显式授权部署/push）'

if [ "$NOT_RUN" -eq 1 ]; then
  log '== E6: NOT_RUN（见上方阻塞项；授权与部署未获用户显式同意前禁止执行）=='
  exit 2
fi

mkdir -p "$EVIDENCE_DIR/junit" "$EVIDENCE_DIR/digests"
log "evidence dir: $EVIDENCE_DIR"

# Golden Path 断言钩子（环境就绪后按 runbook §4 逐项实现）：
# - Mac 无公网 listener（lsof -iTCP -sTCP:LISTEN 白名单比对）
# - WSS outbound 会话建立（heartbeat/lease 链）
# - 三轮 real model turn（记录首 token/完成时间）
# - 版本/隔离/Journal digest 全链一致（PG source_fact_digest == SQLite terminal_fact_digest）
# - Project 零变化（snapshot digest 前后比对）
# - 无敏感日志（privacy-scan 钩子）
# Remote Fault 场景：20 个 failpoint 逐项真机执行（FLT-001..020，§12.2 golden decision table），
# 每次记录 Cloud PG / Worker SQLite / Host counter / Consumer final count / 恢复时间。

case "$SCENARIO" in
  golden-path|two-creator|version-update|remote-fault|gateway-rollout|nat-sleep-wake)
    log "scenario $SCENARIO 已选择；环境就绪后在此实现断言钩子（当前为机制骨架，未执行真机步骤）"
    ;;
  *)
    log "未知场景: $SCENARIO" >&2
    exit 1
    ;;
esac

log '== E6 skeleton ready（真机步骤未执行；NOT_RUN 状态不变）=='
