#!/usr/bin/env bash
# VNext INV-010/016 T1-SERVICE-CI fault-injection preflight（fail-closed）。
# 环境缺失时非零退出并打印阻塞原因；E1 矩阵一致性检查真实运行。
# 当前没有远端 20 场景 runner/Evidence Bundle，因此永不返回 T1 Gate PASS。
# 用法: scripts/gates/t1-fault-injection.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FAILPOINT_CONTROLLER="${VNX_T1_FAILPOINT_CONTROLLER:-$ROOT_DIR/scripts/fault/failpoint-controller}"
NOT_RUN=0

log() { printf '[T1] %s\n' "$*"; }
fail() { log "NOT_RUN: $*"; NOT_RUN=1; }

log '== INV-010/016 T1 fault-injection preflight =='

# 1) T1 服务拓扑环境门（全部强制；无则 NOT_RUN）
[ -n "${VNX_T1_API_BASE_URL:-}" ] || fail 'VNX_T1_API_BASE_URL 未设置（T1 API 端点）'
[ -n "${VNX_T1_PG_URL:-}" ] || fail 'VNX_T1_PG_URL 未设置（T1 PostgreSQL）'
[ -n "${VNX_T1_REDIS_URL:-}" ] || fail 'VNX_T1_REDIS_URL 未设置（T1 Redis）'
[ -n "${VNX_T1_MINIO_URL:-}" ] || fail 'VNX_T1_MINIO_URL 未设置（T1 MinIO）'
[ "${VNX_T1_DEPLOY_AUTHORIZED:-}" = 'true' ] || fail 'VNX_T1_DEPLOY_AUTHORIZED != true（部署/执行未获用户显式授权）'

# 2) failpoint controller（§12.2：arm/submit/restart/replay + golden decision table）
if [ ! -x "$FAILPOINT_CONTROLLER" ]; then
  fail 'failpoint controller 未交付（scripts/fault/failpoint-controller；arm → submit → restart → replay）'
else
  log "failpoint controller present: $FAILPOINT_CONTROLLER"
fi
if [ ! -f "$ROOT_DIR/tests/vnext/golden-decision-table.yaml" ]; then
  fail 'golden decision table 未交付（tests/vnext/golden-decision-table.yaml；每个 failpoint 引用唯一 golden row）'
else
  if ! (cd "$ROOT_DIR" && node --test scripts/vnext-golden-decision-table.test.mjs >/dev/null 2>&1); then
    fail 'golden decision table 契约测试未通过（scripts/vnext-golden-decision-table.test.mjs）'
  else
    log 'golden decision table contract OK (20 rows)'
  fi
fi

# 3) E1 矩阵一致性（本地真实运行：20 failpoint 分类 + 9 个重建序列，无重复副作用）
if [ -d "$ROOT_DIR/packages/creator-agent-broker-journal" ]; then
  log 'running E1 fault-model matrix locally (real)...'
  if ! (cd "$ROOT_DIR/packages/creator-agent-broker-journal" && pnpm exec vitest run src/fault-model.test.ts >/dev/null 2>&1); then
    fail 'E1 fault-model matrix 检查未通过（先修复本地矩阵再进 T1）'
  else
    log 'E1 fault-model matrix OK (13/13)'
  fi
else
  fail 'creator-agent-broker-journal 包缺失'
fi

if [ "$NOT_RUN" -eq 1 ]; then
  log '== T1 preflight: NOT_RUN（见上方阻塞项）=='
  exit 2
fi
log 'PRECHECK_READY: local matrix and prerequisites satisfied'
log 'NOT_RUN: 20 个远端 failpoint 场景与逐项 Evidence Bundle 生成/验证尚未实现'
log '== T1 Gate: NOT_RUN =='
exit 2
