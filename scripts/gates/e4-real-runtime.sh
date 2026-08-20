#!/usr/bin/env bash
# VNext E4 Real Runtime — prerequisite preflight（机制骨架，fail-closed）。
# 本脚本不执行真实模型 turn，也不生成 E4 Evidence Bundle，因此永不返回 Gate PASS。
# 用法: scripts/gates/e4-real-runtime.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROTOCOL_ENTRYPOINT="${VNX_E4_PROTOCOL_ENTRYPOINT:-$ROOT_DIR/packages/creator-agent-protocol/dist/index.js}"
NOT_RUN=0

log() { printf '[E4] %s\n' "$*"; }
fail() { log "NOT_RUN: $*"; NOT_RUN=1; }

log '== E4 Real Runtime preflight =='

# 1) 真实 Codex 运行时（本地可查部分：二进制存在 + 版本）
if command -v codex >/dev/null 2>&1; then
  CODEX_VERSION="$(codex --version 2>/dev/null | head -1 || true)"
  log "codex present: ${CODEX_VERSION:-unknown}"
else
  fail 'codex CLI 不可用（真实运行时缺失）'
fi

# 2) 运行时制品 digest 与策略对照（RUNTIME_DIGEST 从 worker 注册能力读取）
EXPECTED_RUNTIME_DIGEST="${VNX_E4_RUNTIME_DIGEST:-}"
if [ -z "$EXPECTED_RUNTIME_DIGEST" ]; then
  fail 'VNX_E4_RUNTIME_DIGEST 未设置（须等于 worker_installations.capabilities.codexRuntimeArtifacts[0]）'
elif [[ ! "$EXPECTED_RUNTIME_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  fail 'VNX_E4_RUNTIME_DIGEST 不是 canonical sha256 digest'
fi

# 3) 模型代理可达性（真实模型凭据经 Model Credential Proxy，无长期凭据落盘）
MODEL_PROXY_URL="${VNX_E4_MODEL_PROXY_URL:-}"
if [ -z "$MODEL_PROXY_URL" ]; then
  fail 'VNX_E4_MODEL_PROXY_URL 未设置（Model Credential Proxy 端点）'
elif command -v curl >/dev/null 2>&1; then
  if ! curl -fsS -m 3 "$MODEL_PROXY_URL/healthz" >/dev/null 2>&1; then
    fail "模型代理不可达: $MODEL_PROXY_URL"
  else
    log 'model proxy reachable'
  fi
else
  fail 'curl 不可用（无法验证 Model Credential Proxy）'
fi

# 4) 自动化会话（Codex Desktop 登录态；此前 API 401 中断过，需用户重新登录）
if [ "${VNX_E4_AUTOMATION_READY:-}" != 'true' ]; then
  fail 'VNX_E4_AUTOMATION_READY != true（自动化 Codex 会话需用户确认已重新登录）'
fi

# 5) Journal digest 交叉核对工具就绪（TS 侧 canonical digest 可用）
if [ ! -f "$PROTOCOL_ENTRYPOINT" ]; then
  fail 'creator-agent-protocol 未构建（digest 交叉核对不可用）'
fi

if [ "$NOT_RUN" -eq 1 ]; then
  log '== E4 preflight: NOT_RUN（见上方阻塞项）=='
  exit 2
fi
log 'PRECHECK_READY: prerequisites satisfied; real Codex/model turn and Evidence Bundle were not executed'
log '== E4 Gate: NOT_RUN =='
exit 2
