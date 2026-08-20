#!/usr/bin/env bash
# VNext E5 Real Isolation — prerequisite preflight（机制骨架，fail-closed）。
# 本脚本不启动隔离 VM，也不执行 canary，因此永不返回 Gate PASS。
# 用法: scripts/gates/e5-isolation-canary.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CANARY_DIR="${VNX_E5_CANARY_DIR:-$ROOT_DIR/scripts/integration/isolation-canary}"
NOT_RUN=0

log() { printf '[E5] %s\n' "$*"; }
fail() { log "NOT_RUN: $*"; NOT_RUN=1; }

log '== E5 Real Isolation preflight =='

# 1) 隔离运行时：Apple container 或 Lima（本机检查）
ISOLATION_RUNTIME=''
if command -v container >/dev/null 2>&1; then
  ISOLATION_RUNTIME='container'
elif command -v limactl >/dev/null 2>&1; then
  ISOLATION_RUNTIME='limactl'
fi
if [ -z "$ISOLATION_RUNTIME" ]; then
  fail 'Apple container / limactl 均不可用（真实隔离运行时缺失）'
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
if [ ! -x "$CANARY_DIR/syscall-canary" ] || [ ! -x "$CANARY_DIR/network-canary" ]; then
  fail "两个隔离 canary 都必须存在且可执行: $CANARY_DIR"
fi

# 4) 网络策略断言材料（model-proxy-only；hostMounts forbidden）
if [ -z "${VNX_E5_MODEL_PROXY_URL:-}" ]; then
  fail 'VNX_E5_MODEL_PROXY_URL 未设置（canary 网络白名单端点）'
fi

if [ "$NOT_RUN" -eq 1 ]; then
  log '== E5 preflight: NOT_RUN（见上方阻塞项）=='
  exit 2
fi
log 'PRECHECK_READY: prerequisites satisfied; isolation VM and canaries were not executed'
log '== E5 Gate: NOT_RUN =='
exit 2
