#!/usr/bin/env bash
set -Eeuo pipefail

readonly PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export PATH
readonly DATA_MOUNT='/home/xingzheng/data'
readonly SOURCE_ROOT='/home/xingzheng/data/combo-host'
readonly ANCHOR_ROOT='/var/lib/combo-host-data'
readonly IDENTITY_FILE='/etc/combo-dev/data-mount.identity'
readonly SENTINEL='/var/lib/combo-host-data/.combo-host-data-root'
readonly SENTINEL_VALUE='combo-host-data-root=v1'

fail() { printf '[combo-host-data-mount-check] FAIL: %s\n' "$1" >&2; exit 1; }

mount_has_option() {
  local options=$1 expected=$2
  [[ ",$options," == *",$expected,"* ]]
}

main() {
  local expected_uuid actual_uuid root_device data_device target vfs_options fs_options fsroot
  local data_source anchor_source source_identity anchor_identity
  (($# == 0)) || fail '参数不合法。'
  [[ $EUID -eq 0 ]] || fail 'checker 必须以 root 运行。'
  for command in findmnt readlink stat; do
    command -v "$command" >/dev/null 2>&1 || fail "缺少命令：$command"
  done

  [[ -f "$IDENTITY_FILE" && ! -L "$IDENTITY_FILE" &&
    $(stat -c '%u:%g:%a' "$IDENTITY_FILE" 2>/dev/null) == '0:0:600' ]] ||
    fail '父数据盘身份文件缺失或不可信。'
  IFS= read -r expected_uuid <"$IDENTITY_FILE" || fail '父数据盘身份文件不可读。'
  [[ "$expected_uuid" =~ ^combo-host-data-uuid=([A-Za-z0-9._:-]{8,128})$ ]] ||
    fail '父数据盘身份文件格式不合法。'
  expected_uuid=${BASH_REMATCH[1]}

  # consumer 可能运行在 ProtectHome 生成的私有 mount namespace 中，父路径会被呈现为只读。
  # 固定读取 PID 1 的宿主 mount namespace，并继续对宿主 rw 状态 fail closed。
  target=$(findmnt --task 1 -rn -M "$DATA_MOUNT" -o TARGET 2>/dev/null) || fail '父数据盘不是独立挂载。'
  [[ "$target" == "$DATA_MOUNT" ]] || fail '父数据盘 mount target 漂移。'
  actual_uuid=$(findmnt --task 1 -rn -M "$DATA_MOUNT" -o UUID 2>/dev/null) || fail '父数据盘 UUID 不可读。'
  [[ "$actual_uuid" == "$expected_uuid" ]] || fail '父数据盘 UUID 与批准身份不一致。'
  vfs_options=$(findmnt --task 1 -rn -M "$DATA_MOUNT" -o VFS-OPTIONS 2>/dev/null) ||
    fail '父数据盘 VFS 挂载选项不可读。'
  fs_options=$(findmnt --task 1 -rn -M "$DATA_MOUNT" -o FS-OPTIONS 2>/dev/null) ||
    fail '父数据盘文件系统挂载选项不可读。'
  mount_has_option "$vfs_options" rw || fail '父数据盘 VFS 不是 rw。'
  mount_has_option "$fs_options" rw || fail '父数据盘文件系统不是 rw。'
  root_device=$(stat -c '%d' / 2>/dev/null) || fail '根盘设备不可读。'
  data_device=$(stat -c '%d' "$DATA_MOUNT" 2>/dev/null) || fail '父数据盘设备不可读。'
  [[ "$data_device" != "$root_device" ]] || fail '父数据盘回退到了根盘。'

  [[ -d "$SOURCE_ROOT" && ! -L "$SOURCE_ROOT" &&
    $(readlink -f -- "$SOURCE_ROOT" 2>/dev/null) == "$SOURCE_ROOT" &&
    $(stat -c '%u:%g:%a' "$SOURCE_ROOT" 2>/dev/null) == '0:0:700' &&
    $(stat -c '%d' "$SOURCE_ROOT" 2>/dev/null) == "$data_device" ]] ||
    fail '数据盘 source root 身份或权限漂移。'
  [[ -d "$ANCHOR_ROOT" && ! -L "$ANCHOR_ROOT" &&
    $(readlink -f -- "$ANCHOR_ROOT" 2>/dev/null) == "$ANCHOR_ROOT" &&
    $(stat -c '%u:%g:%a' "$ANCHOR_ROOT" 2>/dev/null) == '0:0:700' ]] ||
    fail 'root-owned canonical anchor 身份或权限漂移。'
  target=$(findmnt --task 1 -rn -M "$ANCHOR_ROOT" -o TARGET 2>/dev/null) || fail 'canonical anchor 未挂载。'
  [[ "$target" == "$ANCHOR_ROOT" ]] || fail 'canonical anchor mount target 漂移。'
  fsroot=$(findmnt --task 1 -rn -M "$ANCHOR_ROOT" -o FSROOT 2>/dev/null) || fail 'canonical anchor FSROOT 不可读。'
  [[ "$fsroot" == '/combo-host' ]] || fail 'canonical anchor 没有绑定精确 source root。'
  data_source=$(findmnt --task 1 -rn -M "$DATA_MOUNT" -o SOURCE 2>/dev/null) || fail '父数据盘 source 不可读。'
  anchor_source=$(findmnt --task 1 -rn -M "$ANCHOR_ROOT" -o SOURCE 2>/dev/null) || fail 'canonical anchor source 不可读。'
  [[ "$anchor_source" == "$data_source" || "$anchor_source" == "$data_source"'[/combo-host]' ]] ||
    fail 'canonical anchor 不是批准父数据盘的 bind。'
  vfs_options=$(findmnt --task 1 -rn -M "$ANCHOR_ROOT" -o VFS-OPTIONS 2>/dev/null) ||
    fail 'canonical anchor VFS 挂载选项不可读。'
  fs_options=$(findmnt --task 1 -rn -M "$ANCHOR_ROOT" -o FS-OPTIONS 2>/dev/null) ||
    fail 'canonical anchor 文件系统挂载选项不可读。'
  mount_has_option "$vfs_options" rw || fail 'canonical anchor VFS 不是 rw。'
  mount_has_option "$fs_options" rw || fail 'canonical anchor 文件系统不是 rw。'
  source_identity=$(stat -c '%d:%i' "$SOURCE_ROOT" 2>/dev/null) || fail 'source root inode 不可读。'
  anchor_identity=$(stat -c '%d:%i' "$ANCHOR_ROOT" 2>/dev/null) || fail 'anchor inode 不可读。'
  [[ "$source_identity" == "$anchor_identity" &&
    $(stat -c '%d' "$ANCHOR_ROOT" 2>/dev/null) == "$data_device" ]] ||
    fail 'canonical anchor 与当前 source root 不是同一个数据盘 inode。'
  [[ -f "$SENTINEL" && ! -L "$SENTINEL" &&
    $(stat -c '%u:%g:%a' "$SENTINEL" 2>/dev/null) == '0:0:400' &&
    $(<"$SENTINEL") == "$SENTINEL_VALUE" ]] || fail 'canonical anchor sentinel 漂移。'
}

main "$@"
