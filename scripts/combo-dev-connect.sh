#!/usr/bin/env bash
# 在开发者本机建立两层回环转发；远端协调器为本会话持有共享锁与引用计数租约。
set -Eeuo pipefail

fail() { printf '[combo-dev-connect] FAIL: %s\n' "$1" >&2; exit 1; }
: "${COMBO_DEV_SSH_TARGET:?必须设置 COMBO_DEV_SSH_TARGET 为预先审核的 SSH 配置别名}"
[[ "$COMBO_DEV_SSH_TARGET" =~ ^[A-Za-z0-9._-]+$ ]] || fail 'SSH 配置别名格式不合法。'
command -v ssh >/dev/null 2>&1 || fail '缺少 ssh。'
command -v awk >/dev/null 2>&1 || fail '缺少 awk。'

SSH_ARGS=(
  -T
  -o BatchMode=yes
  -o ClearAllForwardings=no
  -o ConnectTimeout=10
  -o ExitOnForwardFailure=yes
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=3
  -L 127.0.0.1:18080:127.0.0.1:18080
  -L 127.0.0.1:19000:127.0.0.1:19000
)

# ClearAllForwardings=yes 也会清掉命令行 -L。这里先检查同一组最终参数；若
# 审核别名额外声明了任何转发，就失败而不是建立超出固定清单的隧道。
set +e
effective_forwards=$(ssh -G "${SSH_ARGS[@]}" "$COMBO_DEV_SSH_TARGET" 2>/dev/null | awk '$1 ~ /^(localforward|remoteforward|dynamicforward)$/ { print }')
resolve_rc=$?
set -e
[[ $resolve_rc == 0 ]] || fail '无法解析审核后的 SSH 别名。'
expected_forwards=$'localforward [127.0.0.1]:18080 [127.0.0.1]:18080\nlocalforward [127.0.0.1]:19000 [127.0.0.1]:19000'
[[ "$effective_forwards" == "$expected_forwards" ]] || fail 'SSH 最终配置没有且仅有两个固定回环转发。'

printf '%s\n' '[combo-dev-connect] 正在申请独立会话租约；按 Ctrl-C 只释放本会话。'
exec ssh "${SSH_ARGS[@]}" \
  "$COMBO_DEV_SSH_TARGET" \
  'sudo -- /opt/combo-dev/bin/combo-dev-forwarder-lease'
