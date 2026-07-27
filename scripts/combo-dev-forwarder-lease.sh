#!/usr/bin/env bash
# 为交互连接持有共享操作锁和引用计数租约；部署与重置持有同一把排他锁。
set -Eeuo pipefail
umask 077
export PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

readonly OPERATION_LOCK='/run/lock/combo-dev.lock'
readonly STATE_LOCK='/run/lock/combo-dev-forwarders.lock'
readonly LEASE_DIR='/run/combo-dev-forwarders'
readonly FAILURE_FENCE_MARKER='/var/lib/combo-dev/writers-fenced'
readonly UNITS=(combo-dev-web-forward.service combo-dev-s3-forward.service)
LEASE=''

status() { printf '[combo-dev-forwarder-lease] %s\n' "$1"; }
fail() { printf '[combo-dev-forwarder-lease] BLOCKED: %s\n' "$1" >&2; exit 2; }

process_start() {
  local pid=$1
  [[ "$pid" =~ ^[1-9][0-9]*$ && -r "/proc/$pid/stat" ]] || return 1
  sed -E 's/^[0-9]+ \(.*\) //' "/proc/$pid/stat" 2>/dev/null | awk '{print $20}'
}

purge_stale_leases() {
  local file pid expected actual
  shopt -s nullglob
  for file in "$LEASE_DIR"/*; do
    [[ -f "$file" && ! -L "$file" ]] || { rm -f -- "$file"; continue; }
    pid=${file##*/}
    expected=$(cat "$file" 2>/dev/null || true)
    actual=$(process_start "$pid" 2>/dev/null || true)
    [[ -n "$actual" && "$actual" == "$expected" ]] || rm -f -- "$file"
  done
  shopt -u nullglob
}

lease_count() {
  find "$LEASE_DIR" -mindepth 1 -maxdepth 1 -type f -printf . 2>/dev/null | wc -c | tr -d ' '
}

release_lease() {
  local rc=$?
  set +e
  if [[ -n "$LEASE" ]]; then
    flock 8
    rm -f -- "$LEASE"
    purge_stale_leases
    if [[ $(lease_count) == 0 ]]; then
      timeout 30 systemctl stop "${UNITS[@]}" >/dev/null 2>&1 || true
    fi
    flock -u 8
  fi
  exit "$rc"
}
trap release_lease EXIT
trap 'exit 130' INT TERM

main() {
  local cmd start active unit
  [[ $# == 0 ]] || fail '不接受参数。'
  [[ $(id -u) -eq 0 ]] || fail '租约协调器必须通过受限 sudo 以 root 启动。'
  for cmd in flock systemctl timeout install find wc awk sed stat; do
    command -v "$cmd" >/dev/null 2>&1 || fail "缺少主机工具：$cmd"
  done
  exec 9>"$OPERATION_LOCK"
  flock -s -n 9 || fail '部署、重置或 bootstrap 正在持有排他锁。'
  [[ ! -e "$FAILURE_FENCE_MARKER" ]] || fail '持久失败阻断仍然存在，不能启动回环转发器。'
  install -d -o root -g root -m 0700 "$LEASE_DIR"
  exec 8>"$STATE_LOCK"
  flock 8
  [[ ! -e "$FAILURE_FENCE_MARKER" ]] || fail '持久失败阻断仍然存在，不能建立转发租约。'
  purge_stale_leases
  start=$(process_start $$) || fail '无法建立进程身份。'
  LEASE="$LEASE_DIR/$$"
  printf '%s\n' "$start" >"$LEASE"
  chmod 0600 "$LEASE"
  timeout 30 systemctl start "${UNITS[@]}" >/dev/null 2>&1 || {
    rm -f -- "$LEASE"
    LEASE=''
    timeout 30 systemctl stop "${UNITS[@]}" >/dev/null 2>&1 || true
    fail '回环转发器无法启动。'
  }
  for unit in "${UNITS[@]}"; do
    active=$(timeout 10 systemctl is-active "$unit" 2>/dev/null || true)
    [[ "$active" == active ]] || fail '回环转发器没有全部进入运行态。'
  done
  flock -u 8
  status 'PASS lease=active；关闭连接会只释放本会话租约。'
  cat >/dev/null
}

main "$@"
