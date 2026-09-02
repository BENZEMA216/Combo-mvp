#!/bin/sh
# V2 验证栈一镜像三入口分叉：按 PROCESS 选择启动哪个 Node 进程入口。
# 任何无效 PROCESS 直接报错退出（不静默起错进程）。
set -eu

PROCESS="${PROCESS:-authz}"

case "$PROCESS" in
  authz)
    exec node apps/authz/dist/index.js
    ;;
  billing)
    exec node apps/billing/dist/index.js
    ;;
  llm-gateway)
    exec node apps/llm-gateway/dist/index.js
    ;;
  *)
    echo "[entrypoint] unknown PROCESS='$PROCESS' (expected authz|billing|llm-gateway)" >&2
    exit 64
    ;;
esac
