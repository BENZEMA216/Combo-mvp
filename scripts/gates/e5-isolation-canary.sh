#!/usr/bin/env bash
# VNext E5 Real Isolation — preflight（机制骨架，fail-closed）。
# 环境缺失时非零退出并打印阻塞原因；绝不伪造通过。
# 用法: scripts/gates/e5-isolation-canary.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NOT_RUN=0

log() { printf '[E5] %s\n' "$*"; }
fail() { log "NOT_RUN: $*"; NOT_RUN=1; }

log '== E5 Real Isolation preflight =='

# 1) 隔离运行时：Apple container 或 Lima（本机检查）
ISOLATION_RUNTIME=''
if command -v lima >/dev/null 2>&1; then ISOLATION_RUNTIME='lima'; fi
if [ -z "$ISOLATION_RUNTIME" ]; then
  fail 'Apple container / lima 均不可用（真实隔离运行时缺失）'
else
  log "isolation runtime: $ISOLATION_RUNTIME"
fi

# 2) Linux 隔离镜像（containerd/lima VM 镜像；版本需固定并记录）
if [ -z "${VNX_E5_IMAGE:-}" ]; then
  fail 'VNX_E5_IMAGE 未设置（隔离镜像引用；patch/minor 升级策略见 runbook §3）'
else
  log "isolation image: $VNX_E5_IMAGE"
fi

# 3) canary 清单（syscall/network canary 二进制随镜像交付）
if [ ! -f "$ROOT_DIR/scripts/integration/isolation-canary/syscall-canary" ] \
    && [ ! -f "$ROOT_DIR/scripts/integration/isolation-canary/network-canary" ]; then
  fail '隔离 canary 二进制缺失（scripts/integration/isolation-canary/ 需随镜像构建交付）'
fi

# 4) 网络策略断言材料（model-proxy-only；hostMounts forbidden）
if [ -z "${VNX_E5_MODEL_PROXY_URL:-}" ]; then
  fail 'VNX_E5_MODEL_PROXY_URL 未设置（canary 网络白名单端点）'
fi

if [ "$NOT_RUN" -eq 1 ]; then
  log '== E5 preflight: NOT_RUN（见上方阻塞项）=='
  exit 2
fi
log '== E5 preflight: READY（真机执行步骤见 runbook §3：syscall/network/cross-conversation canary）=='
