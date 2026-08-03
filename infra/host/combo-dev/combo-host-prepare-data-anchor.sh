#!/usr/bin/env bash
set -Eeuo pipefail

readonly PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export PATH
readonly CONFIRM='--confirm=PREPARE-COMBO-HOST-DATA-ANCHOR'
readonly DATA_MOUNT='/home/xingzheng/data'
readonly SOURCE_ROOT='/home/xingzheng/data/combo-host'
readonly ANCHOR_ROOT='/var/lib/combo-host-data'
readonly IDENTITY_FILE='/etc/combo-dev/data-mount.identity'
readonly SENTINEL_SOURCE='/home/xingzheng/data/combo-host/.combo-host-data-root'
readonly SENTINEL_VALUE='combo-host-data-root=v1'
readonly CHECKER_INSTALLED='/opt/combo-dev/bin/combo-host-data-mount-check'
readonly MOUNT_UNIT='var-lib-combo\x2dhost\x2ddata.mount'
readonly CHECK_UNIT='combo-host-data-mount-check.service'
readonly LOCK_FILE='/run/lock/combo-host-data-anchor.lock'
MOUNT_STARTED=0

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
readonly SELF_ASSET="$SCRIPT_DIR/combo-host-prepare-data-anchor.sh"
readonly CHECKER_ASSET="$SCRIPT_DIR/combo-host-data-mount-check.sh"
readonly MOUNT_ASSET="$SCRIPT_DIR/var-lib-combo\x2dhost\x2ddata.mount"
readonly CHECK_ASSET="$SCRIPT_DIR/combo-host-data-mount-check.service"

status() { printf '[combo-host-prepare-data-anchor] %s\n' "$1"; }
fail() { printf '[combo-host-prepare-data-anchor] FAIL: %s\n' "$1" >&2; exit 1; }

cleanup() {
  local rc=$?
  trap - EXIT
  if ((rc != 0 && MOUNT_STARTED == 1)); then
    systemctl stop "$CHECK_UNIT" "$MOUNT_UNIT" >/dev/null 2>&1 || true
    systemctl disable "$CHECK_UNIT" "$MOUNT_UNIT" >/dev/null 2>&1 || true
    if findmnt -rn -M "$ANCHOR_ROOT" >/dev/null 2>&1; then
      printf '[combo-host-prepare-data-anchor] ROLLBACK REQUIRED: canonical anchor 仍已挂载。\n' >&2
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

trusted_asset() {
  [[ -f "$1" && ! -L "$1" && $(stat -c '%u' "$1") == 0 && $((8#$(stat -c '%a' "$1") & 8#022)) == 0 ]]
}

trusted_asset_ancestry() {
  local path=$SCRIPT_DIR parent mode
  while :; do
    [[ -d "$path" && ! -L "$path" && $(readlink -f -- "$path") == "$path" &&
      $(stat -c '%u' "$path") == 0 ]] || return 1
    mode=$(stat -c '%a' "$path") || return 1
    [[ "$mode" =~ ^[0-7]{3,4}$ && $((8#$mode & 8#022)) == 0 ]] || return 1
    [[ "$path" == / ]] && return 0
    parent=$(dirname -- "$path") || return 1
    [[ "$parent" != "$path" ]] || return 1
    path=$parent
  done
}

main() {
  local command data_target data_uuid data_device root_device before_identity after_identity existing
  [[ $# -eq 1 && $1 == "$CONFIRM" ]] || fail "必须传入固定确认参数：$CONFIRM"
  [[ $EUID -eq 0 ]] || fail '必须以 root 运行。'
  umask 0077
  for command in chmod chown dirname find findmnt flock install mkdir readlink stat systemctl; do
    command -v "$command" >/dev/null 2>&1 || fail "缺少命令：$command"
  done
  trusted_asset_ancestry || fail 'anchor 资产祖先目录不是 root-owned 且不可被非 root 修改。'
  for existing in "$SELF_ASSET" "$CHECKER_ASSET" "$MOUNT_ASSET" "$CHECK_ASSET"; do
    trusted_asset "$existing" || fail 'anchor 资产不是 root-owned 且不可被非 root 修改的普通文件。'
  done
  install -d -o root -g root -m 0755 /run/lock
  exec 9>"$LOCK_FILE"
  flock -n 9 || fail '另一个 data-anchor 操作仍在运行。'
  data_target=$(findmnt -rn -M "$DATA_MOUNT" -o TARGET 2>/dev/null) || fail '父数据盘不是独立挂载。'
  [[ "$data_target" == "$DATA_MOUNT" ]] || fail '父数据盘 mount target 漂移。'
  data_uuid=$(findmnt -rn -M "$DATA_MOUNT" -o UUID 2>/dev/null) || fail '父数据盘 UUID 不可读。'
  [[ "$data_uuid" =~ ^[A-Za-z0-9._:-]{8,128}$ ]] || fail '父数据盘没有稳定、合法的 UUID。'
  data_device=$(stat -c '%d' "$DATA_MOUNT") || fail '父数据盘设备不可读。'
  root_device=$(stat -c '%d' /) || fail '根盘设备不可读。'
  [[ "$data_device" != "$root_device" ]] || fail '父数据盘回退到了根盘。'
  install -d -o root -g root -m 0700 /etc/combo-dev /opt/combo-dev/bin /var/lib
  if [[ -e "$IDENTITY_FILE" || -L "$IDENTITY_FILE" ]]; then
    [[ -f "$IDENTITY_FILE" && ! -L "$IDENTITY_FILE" &&
      $(stat -c '%u:%g:%a' "$IDENTITY_FILE") == '0:0:600' ]] || fail '既有父数据盘身份文件不可信。'
    [[ $(<"$IDENTITY_FILE") == "combo-host-data-uuid=$data_uuid" ]] || fail '既有父数据盘身份与当前挂载不一致。'
  else
    printf 'combo-host-data-uuid=%s\n' "$data_uuid" | install -o root -g root -m 0600 /dev/stdin "$IDENTITY_FILE"
  fi
  if [[ ! -e "$SOURCE_ROOT" && ! -L "$SOURCE_ROOT" ]]; then
    mkdir -- "$SOURCE_ROOT"
    chown root:root "$SOURCE_ROOT"
    chmod 0700 "$SOURCE_ROOT"
  fi
  [[ -d "$SOURCE_ROOT" && ! -L "$SOURCE_ROOT" &&
    $(readlink -f -- "$SOURCE_ROOT") == "$SOURCE_ROOT" &&
    $(stat -c '%u:%g:%a' "$SOURCE_ROOT") == '0:0:700' &&
    $(stat -c '%d' "$SOURCE_ROOT") == "$data_device" ]] || fail 'source root 不可信或不在父数据盘。'
  if [[ ! -e "$SENTINEL_SOURCE" && ! -L "$SENTINEL_SOURCE" ]]; then
    printf '%s\n' "$SENTINEL_VALUE" | install -o root -g root -m 0400 /dev/stdin "$SENTINEL_SOURCE"
  fi
  [[ -f "$SENTINEL_SOURCE" && ! -L "$SENTINEL_SOURCE" &&
    $(stat -c '%u:%g:%a' "$SENTINEL_SOURCE") == '0:0:400' &&
    $(<"$SENTINEL_SOURCE") == "$SENTINEL_VALUE" ]] || fail 'source sentinel 不可信。'
  before_identity=$(stat -c '%d:%i' "$SOURCE_ROOT")

  if [[ ! -e "$ANCHOR_ROOT" && ! -L "$ANCHOR_ROOT" ]]; then
    mkdir -- "$ANCHOR_ROOT"
    chown root:root "$ANCHOR_ROOT"
    chmod 0700 "$ANCHOR_ROOT"
  fi
  [[ -d "$ANCHOR_ROOT" && ! -L "$ANCHOR_ROOT" &&
    $(readlink -f -- "$ANCHOR_ROOT") == "$ANCHOR_ROOT" &&
    $(stat -c '%u:%g:%a' "$ANCHOR_ROOT") == '0:0:700' &&
    -z $(find "$ANCHOR_ROOT" -mindepth 1 -maxdepth 1 -print -quit) ]] || fail 'canonical anchor mountpoint 不可信或非空。'
  findmnt -rn -M "$ANCHOR_ROOT" >/dev/null 2>&1 && fail 'canonical anchor 已挂载；请改用 checker 验证。'

  install -o root -g root -m 0755 "$CHECKER_ASSET" "$CHECKER_INSTALLED"
  install -o root -g root -m 0644 "$MOUNT_ASSET" "/etc/systemd/system/$MOUNT_UNIT"
  install -o root -g root -m 0644 "$CHECK_ASSET" "/etc/systemd/system/$CHECK_UNIT"
  systemctl daemon-reload
  MOUNT_STARTED=1
  systemctl enable --now "$MOUNT_UNIT"
  systemctl enable --now "$CHECK_UNIT"
  "$CHECKER_INSTALLED"
  after_identity=$(stat -c '%d:%i' "$SOURCE_ROOT")
  [[ "$before_identity" == "$after_identity" &&
    "$after_identity" == $(stat -c '%d:%i' "$ANCHOR_ROOT") ]] || fail 'source 在 bind cutover 期间被替换。'
  MOUNT_STARTED=0
  status 'PASS: root-owned canonical data anchor 已固定并通过 UUID、inode 与 sentinel 校验。'
}

main "$@"
