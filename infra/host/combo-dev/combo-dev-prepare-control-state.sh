#!/usr/bin/env bash
set -Eeuo pipefail

readonly PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export PATH
readonly CONFIRM='--confirm=PREPARE-COMBO-DEV-CONTROL-STATE'
readonly DATA_ROOT='/home/xingzheng/data'
readonly CONTROL_PARENT='/var/lib/combo-host-data'
readonly BACKING_FILE='/var/lib/combo-host-data/control-state.img'
readonly DATA_ANCHOR_CHECK='/opt/combo-dev/bin/combo-host-data-mount-check'
readonly BACKING_BYTES=4294967296
readonly FILESYSTEM_LABEL='combo-dev-state'
readonly DATA_CRITICAL_MIN_BYTES=$((20 * 1024 * 1024 * 1024))
readonly STATE_MIN_FREE_BYTES=$((1024 * 1024 * 1024))
readonly STATE_MIN_FREE_INODES=4096
readonly STATE_ROOT='/opt/combo-dev/state'
readonly SENTINEL='/opt/combo-dev/state/.combo-dev-control-state'
readonly SENTINEL_VALUE='combo-dev-control-state=v1'
readonly INCOMING_ROOT='/opt/combo-dev/incoming'
readonly RELEASES_ROOT='/opt/combo-dev/releases'
readonly EVIDENCE_ROOT='/var/lib/combo-dev/evidence'
readonly STATE_UNIT='opt-combo\x2ddev-state.mount'
readonly INCOMING_UNIT='opt-combo\x2ddev-incoming.mount'
readonly RELEASES_UNIT='opt-combo\x2ddev-releases.mount'
readonly EVIDENCE_UNIT='var-lib-combo\x2ddev-evidence.mount'
readonly WRITERS_FENCED='/var/lib/combo-dev/writers-fenced'
readonly EXTERNAL_FENCE='/var/lib/combo-dev/external-fence'
readonly MAINTENANCE_FENCE='/var/lib/combo-dev/storage-maintenance-fenced'
readonly MAINTENANCE_FENCE_VALUE='combo-dev-storage-maintenance=fenced-v1'
readonly OPERATION_LOCK='/run/lock/combo-dev.lock'
readonly FENCE_LOCK='/run/lock/combo-dev-fence.lock'
MOUNTED_BY_SCRIPT=0
CUTOVER_BACKUP=''
CUTOVER_COMPLETE=0
INCOMING_MOVED=0
RELEASES_MOVED=0
EVIDENCE_MOVED=0
INCOMING_FROZEN=0
ROLLBACK_MANIFEST_DIR=''

status() { printf '[combo-dev-prepare-control-state] %s\n' "$1"; }
fail() { printf '[combo-dev-prepare-control-state] FAIL: %s\n' "$1" >&2; exit 1; }

cleanup() {
  local rc=$?
  local target backup moved unit active enabled rollback_safe=1 manifest
  trap - EXIT
  if ((MOUNTED_BY_SCRIPT == 1)); then
    if findmnt -rn --mountpoint "$STATE_ROOT" >/dev/null 2>&1 &&
      ! umount "$STATE_ROOT" >/dev/null 2>&1; then
      rc=1
      printf '[combo-dev-prepare-control-state] ROLLBACK REQUIRED: 临时 control-state 无法卸载。\n' >&2
    fi
  fi
  if [[ -n "$CUTOVER_BACKUP" && $CUTOVER_COMPLETE -eq 0 ]]; then
    systemctl stop "$INCOMING_UNIT" "$RELEASES_UNIT" "$EVIDENCE_UNIT" "$STATE_UNIT" >/dev/null 2>&1 || rollback_safe=0
    systemctl disable "$INCOMING_UNIT" "$RELEASES_UNIT" "$EVIDENCE_UNIT" "$STATE_UNIT" >/dev/null 2>&1 || rollback_safe=0
    for target in "$INCOMING_ROOT" "$RELEASES_ROOT" "$EVIDENCE_ROOT" "$STATE_ROOT"; do
      if findmnt -rn --mountpoint "$target" >/dev/null 2>&1; then
        rollback_safe=0
        printf '[combo-dev-prepare-control-state] ROLLBACK REQUIRED: %s 仍为挂载点。\n' "$target" >&2
      fi
    done
    for unit in "$INCOMING_UNIT" "$RELEASES_UNIT" "$EVIDENCE_UNIT" "$STATE_UNIT"; do
      active=$(systemctl is-active "$unit" 2>/dev/null || true)
      enabled=$(systemctl is-enabled "$unit" 2>/dev/null || true)
      [[ "$active" == inactive || "$active" == failed || "$active" == unknown ]] || rollback_safe=0
      [[ "$enabled" == disabled || "$enabled" == static || "$enabled" == not-found ]] || rollback_safe=0
    done
    if ((rollback_safe == 1)); then
      while IFS='|' read -r moved target backup manifest; do
        ((moved == 1)) || continue
        if [[ -d "$backup" && ! -L "$backup" ]]; then
          if [[ -d "$target" && ! -L "$target" && -z $(find "$target" -mindepth 1 -maxdepth 1 -print -quit) ]]; then
            rmdir "$target" >/dev/null 2>&1 || rollback_safe=0
          fi
          if [[ ! -e "$target" && ! -L "$target" ]]; then
            mv -T -- "$backup" "$target" >/dev/null 2>&1 || rollback_safe=0
          else
            rollback_safe=0
          fi
        elif [[ ! -e "$backup" && ! -L "$backup" && -d "$target" && ! -L "$target" ]]; then
          # The move was armed but had not committed when the signal arrived.
          :
        else
          rollback_safe=0
        fi
        if [[ ! -d "$target" || -L "$target" || -e "$backup" ]]; then
          rollback_safe=0
        elif [[ -n "$ROLLBACK_MANIFEST_DIR" && -f "$ROLLBACK_MANIFEST_DIR/$manifest" ]]; then
          tree_manifest "$target" "$ROLLBACK_MANIFEST_DIR/$manifest.restored" >/dev/null 2>&1 || rollback_safe=0
          cmp -s "$ROLLBACK_MANIFEST_DIR/$manifest" "$ROLLBACK_MANIFEST_DIR/$manifest.restored" || rollback_safe=0
        else
          rollback_safe=0
        fi
      done <<EOF
$INCOMING_MOVED|$INCOMING_ROOT|$CUTOVER_BACKUP/incoming|incoming.json
$RELEASES_MOVED|$RELEASES_ROOT|$CUTOVER_BACKUP/releases|releases.json
$EVIDENCE_MOVED|$EVIDENCE_ROOT|$CUTOVER_BACKUP/evidence|evidence.json
EOF
      if ((rollback_safe == 1)) && [[ -d "$CUTOVER_BACKUP/.manifests" && ! -L "$CUTOVER_BACKUP/.manifests" ]]; then
        rm -f -- "$CUTOVER_BACKUP/.manifests"/*.json >/dev/null 2>&1 || rollback_safe=0
        rmdir "$CUTOVER_BACKUP/.manifests" >/dev/null 2>&1 || rollback_safe=0
      fi
      ((rollback_safe == 0)) || rmdir "$CUTOVER_BACKUP" >/dev/null 2>&1 || rollback_safe=0
    fi
    if ((rollback_safe == 0)); then
      rc=1
      printf '[combo-dev-prepare-control-state] ROLLBACK REQUIRED: 自动恢复未能被完整证明；旧树与摘要均已保留。\n' >&2
    fi
  fi
  if ((INCOMING_FROZEN == 1)) && [[ -d "$INCOMING_ROOT" && ! -L "$INCOMING_ROOT" ]] &&
    ! findmnt -rn --mountpoint "$INCOMING_ROOT" >/dev/null 2>&1; then
    if ! chmod 1733 "$INCOMING_ROOT" >/dev/null 2>&1; then
      rc=1
      printf '[combo-dev-prepare-control-state] ROLLBACK REQUIRED: 无法恢复旧 incoming 权限。\n' >&2
    fi
  fi
  if [[ -n "$ROLLBACK_MANIFEST_DIR" && -d "$ROLLBACK_MANIFEST_DIR" && ! -L "$ROLLBACK_MANIFEST_DIR" &&
    ( -z "$CUTOVER_BACKUP" || $CUTOVER_COMPLETE -eq 1 || $rollback_safe -eq 1 ) ]]; then
    rm -rf --one-file-system -- "$ROLLBACK_MANIFEST_DIR" >/dev/null 2>&1 || rc=1
  fi
  exit "$rc"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "缺少命令：$1"
}

mount_has_option() {
  local options=$1 expected=$2
  [[ ",$options," == *",$expected,"* ]]
}

max_threshold() {
  local total=$1 absolute=$2 percent=$3 proportional
  proportional=$((total * percent / 100))
  if (( proportional > absolute )); then printf '%s\n' "$proportional"; else printf '%s\n' "$absolute"; fi
}

assert_parent_capacity() {
  local extra_bytes=$1 extra_inodes=$2 free total inodes inode_total critical critical_inodes
  free=$(df -B1 --output=avail "$DATA_ROOT" | awk 'NR==2 {print $1}') || fail '无法读取父数据盘可用空间。'
  total=$(df -B1 --output=size "$DATA_ROOT" | awk 'NR==2 {print $1}') || fail '无法读取父数据盘总量。'
  inodes=$(df --output=iavail "$DATA_ROOT" | awk 'NR==2 {print $1}') || fail '无法读取父数据盘可用 inode。'
  inode_total=$(df --output=itotal "$DATA_ROOT" | awk 'NR==2 {print $1}') || fail '无法读取父数据盘 inode 总量。'
  [[ "$free" =~ ^[0-9]+$ && "$total" =~ ^[0-9]+$ && "$inodes" =~ ^[0-9]+$ && "$inode_total" =~ ^[0-9]+$ ]] ||
    fail '父数据盘容量指标格式不合法。'
  critical=$(max_threshold "$total" "$DATA_CRITICAL_MIN_BYTES" 10)
  critical_inodes=$((inode_total * 10 / 100))
  (( free >= critical + extra_bytes && inodes >= critical_inodes + extra_inodes )) ||
    fail '创建 control-state 后将低于父数据盘 critical 字节或 inode 水位。'
}

tree_manifest() {
  python3 - "$1" "$2" <<'PY'
import hashlib
import json
import os
import stat
import sys

root, output = sys.argv[1:]
root_value = os.lstat(root)
if not stat.S_ISDIR(root_value.st_mode) or stat.S_ISLNK(root_value.st_mode):
    raise SystemExit(2)
root_device = root_value.st_dev
records = []
for current, dirs, files in os.walk(root, topdown=True, followlinks=False):
    dirs.sort()
    files.sort()
    for name in dirs + files:
        path = os.path.join(current, name)
        value = os.lstat(path)
        if value.st_dev != root_device or stat.S_ISLNK(value.st_mode):
            raise SystemExit(2)
        relative = os.path.relpath(path, root)
        if stat.S_ISDIR(value.st_mode):
            kind, digest = 'directory', None
        elif stat.S_ISREG(value.st_mode):
            kind = 'file'
            hasher = hashlib.sha256()
            with open(path, 'rb', buffering=0) as handle:
                while block := handle.read(1024 * 1024):
                    hasher.update(block)
            digest = hasher.hexdigest()
        else:
            raise SystemExit(2)
        records.append({
            'path': relative,
            'kind': kind,
            'mode': stat.S_IMODE(value.st_mode),
            'uid': value.st_uid,
            'gid': value.st_gid,
            'size': value.st_size if kind == 'file' else None,
            'mtimeNs': value.st_mtime_ns,
            'sha256': digest,
        })
with open(output, 'w', encoding='utf-8') as handle:
    json.dump(records, handle, separators=(',', ':'), sort_keys=True)
    handle.write('\n')
PY
}

verify_installed_units() {
  local unit
  for unit in "$STATE_UNIT" "$INCOMING_UNIT" "$RELEASES_UNIT" "$EVIDENCE_UNIT"; do
    [[ -f "/etc/systemd/system/$unit" && ! -L "/etc/systemd/system/$unit" ]] ||
      fail "受信 bootstrap 尚未安装 $unit。"
    [[ $(stat -c '%u:%g:%a' "/etc/systemd/system/$unit") == '0:0:644' ]] ||
      fail "$unit 所有者或权限漂移。"
  done
}

verify_source_roots() {
  local mounts target path
  [[ $(stat -c '%u:%g:%a:%F' "$INCOMING_ROOT" 2>/dev/null) == '0:0:1733:directory' ]] ||
    fail '旧 incoming 根目录契约漂移。'
  [[ $(stat -c '%u:%g:%a:%F' "$RELEASES_ROOT" 2>/dev/null) == '0:0:755:directory' ]] ||
    fail '旧 releases 根目录契约漂移。'
  [[ $(stat -c '%u:%g:%a:%F' "$EVIDENCE_ROOT" 2>/dev/null) == '0:0:755:directory' ]] ||
    fail '旧 evidence 根目录契约漂移。'
  mounts=$(findmnt -rn -o TARGET) || fail '无法读取挂载表。'
  for path in "$INCOMING_ROOT" "$RELEASES_ROOT" "$EVIDENCE_ROOT"; do
    findmnt -rn --mountpoint "$path" >/dev/null 2>&1 && fail "$path 已经是挂载点；拒绝重复迁移。"
    while IFS= read -r target; do
      [[ "$target" == "$path"/* ]] && fail "$path 内存在嵌套挂载；拒绝迁移。"
    done <<<"$mounts"
  done
  return 0
}

assert_no_open_incoming() {
  local rc
  set +e
  lsof +D "$INCOMING_ROOT" >/dev/null 2>&1
  rc=$?
  set -e
  case "$rc" in
    0) fail '旧 incoming 仍有打开的文件；拒绝迁移。' ;;
    1) return 0 ;;
    *) fail '无法可靠检查旧 incoming 打开文件。' ;;
  esac
}

consume_verified_maintenance_fence() {
  [[ -f "$WRITERS_FENCED" && ! -L "$WRITERS_FENCED" &&
    $(stat -c '%u:%g:%a' "$WRITERS_FENCED") == '0:0:600' &&
    $(<"$WRITERS_FENCED") == 'combo-dev-writers=fenced' ]] ||
    fail 'Test 持久写入阻断不是受信完成状态。'
  [[ -f "$EXTERNAL_FENCE" && ! -L "$EXTERNAL_FENCE" &&
    $(stat -c '%u:%g:%a' "$EXTERNAL_FENCE") == '0:0:600' &&
    $(<"$EXTERNAL_FENCE") == system ]] ||
    fail 'Test 外部维护 fence 身份不匹配。'
  [[ -f "$MAINTENANCE_FENCE" && ! -L "$MAINTENANCE_FENCE" &&
    $(stat -c '%u:%g:%a' "$MAINTENANCE_FENCE") == '0:0:600' &&
    $(<"$MAINTENANCE_FENCE") == "$MAINTENANCE_FENCE_VALUE" ]] ||
    fail '缺少已验证 Kubernetes 终态的主机存储维护完成标记。'
  rm -f -- "$MAINTENANCE_FENCE" || fail '无法原子消费主机存储维护完成标记。'
  [[ ! -e "$MAINTENANCE_FENCE" && ! -L "$MAINTENANCE_FENCE" ]] ||
    fail '主机存储维护完成标记消费失败。'
}

verify_control_state_mount() {
  local source backing options root_device data_device image_target fstype
  [[ -d "$CONTROL_PARENT" && ! -L "$CONTROL_PARENT" &&
    $(readlink -f -- "$CONTROL_PARENT") == "$CONTROL_PARENT" &&
    $(stat -c '%u:%g:%a' "$CONTROL_PARENT") == '0:0:700' ]] ||
    fail 'control-state 专用父目录不可信。'
  [[ -f "$BACKING_FILE" && ! -L "$BACKING_FILE" &&
    $(readlink -f -- "$BACKING_FILE") == "$BACKING_FILE" &&
    $(stat -c '%u:%g:%a:%s' "$BACKING_FILE") == "0:0:600:$BACKING_BYTES" ]] ||
    fail 'control-state backing 身份或精确容量漂移。'
  image_target=$(findmnt -rn -T "$BACKING_FILE" -o TARGET) || fail '无法定位 control-state backing。'
  [[ "$image_target" == "$CONTROL_PARENT" &&
    $(stat -c '%d' "$BACKING_FILE") == $(stat -c '%d' "$DATA_ROOT") ]] ||
    fail 'control-state backing 不在固定父数据盘。'
  [[ $(findmnt -rn -o TARGET --mountpoint "$STATE_ROOT" 2>/dev/null) == "$STATE_ROOT" ]] ||
    fail 'control-state 主挂载未生效。'
  source=$(findmnt -rn -o SOURCE --mountpoint "$STATE_ROOT") || fail '无法读取 control-state loop 设备。'
  [[ "$source" == /dev/loop[0-9]* ]] || fail 'control-state 不是 loop 设备。'
  backing=$(losetup -n -O BACK-FILE -- "$source" 2>/dev/null | sed -n '1p') ||
    fail '无法读取 control-state backing file。'
  [[ $(readlink -f -- "$backing") == "$BACKING_FILE" ]] || fail 'control-state backing file 漂移。'
  [[ $(blockdev --getsize64 "$source") == "$BACKING_BYTES" ]] || fail 'control-state 容量不是精确 4 GiB。'
  fstype=$(findmnt -rn -o FSTYPE --mountpoint "$STATE_ROOT") || fail '无法读取 control-state 文件系统类型。'
  [[ "$fstype" == ext4 ]] || fail 'control-state 不是 ext4。'
  [[ $(blkid -s LABEL -o value "$source" 2>/dev/null) == "$FILESYSTEM_LABEL" ]] ||
    fail 'control-state filesystem label 漂移。'
  options=$(findmnt -rn -o OPTIONS --mountpoint "$STATE_ROOT") || fail '无法读取 control-state 挂载选项。'
  for option in rw nodev nosuid noexec; do
    mount_has_option "$options" "$option" || fail "control-state 挂载缺少 $option。"
  done
  root_device=$(stat -c '%d' /) || fail '无法读取根盘设备。'
  data_device=$(stat -c '%d' "$DATA_ROOT") || fail '无法读取父数据盘设备。'
  [[ "$root_device" != "$data_device" ]] || fail '父数据盘回退到了根盘。'
  [[ $(stat -c '%u:%g:%a' "$STATE_ROOT") == '0:0:700' ]] || fail 'control-state 根目录权限漂移。'
  [[ -f "$SENTINEL" && ! -L "$SENTINEL" ]] || fail 'control-state sentinel 缺失。'
  [[ $(stat -c '%u:%g:%a' "$SENTINEL") == '0:0:400' ]] || fail 'control-state sentinel 权限漂移。'
  [[ $(<"$SENTINEL") == "$SENTINEL_VALUE" ]] || fail 'control-state sentinel 内容漂移。'
  [[ $(stat -c '%u:%g:%a' "$STATE_ROOT/incoming") == '0:0:1733' ]] || fail 'state/incoming 权限漂移。'
  [[ $(stat -c '%u:%g:%a' "$STATE_ROOT/releases") == '0:0:755' ]] || fail 'state/releases 权限漂移。'
  [[ $(stat -c '%u:%g:%a' "$STATE_ROOT/releases/.staging") == '0:0:700' ]] || fail 'release staging 权限漂移。'
  [[ $(stat -c '%u:%g:%a' "$STATE_ROOT/work") == '0:0:700' ]] || fail 'state/work 权限漂移。'
  [[ $(stat -c '%u:%g:%a' "$STATE_ROOT/evidence") == '0:0:755' ]] || fail 'state/evidence 权限漂移。'
}

main() {
  local data_target data_device root_device image_created=0 state_free state_inodes
  local work timestamp backup root_parent_device var_parent_device path options source_root
  [[ $# -eq 1 && $1 == "$CONFIRM" ]] || fail "必须传入固定确认参数：$CONFIRM"
  [[ $EUID -eq 0 ]] || fail '必须以 root 运行。'
  umask 0077
  for command in awk blkid blockdev chmod chown cmp cp date df fallocate find findmnt flock install ionice losetup lsof nice \
    mkdir mkfs.ext4 mount mktemp mv python3 readlink rm rmdir sed stat sync systemctl umount; do
    require_command "$command"
  done
  exec 9>"$OPERATION_LOCK"
  flock -n 9 || fail '另一个 Test 部署、重置或迁移仍持有排他锁。'
  exec 8>"$FENCE_LOCK"
  flock -n 8 || fail '独立失败收敛仍在运行。'
  trap cleanup EXIT
  trap 'exit 130' INT TERM
  [[ $(systemctl is-active combo-dev-web-forward.service 2>/dev/null || true) == inactive ]] ||
    fail 'Web 转发器仍在运行。'
  [[ $(systemctl is-active combo-dev-s3-forward.service 2>/dev/null || true) == inactive ]] ||
    fail 'S3 转发器仍在运行。'

  data_target=$(findmnt -rn -o TARGET --mountpoint "$DATA_ROOT" 2>/dev/null) ||
    fail '父数据盘不是独立挂载。'
  [[ "$data_target" == "$DATA_ROOT" ]] || fail '父数据盘 mount target 漂移。'
  options=$(findmnt -rn -o OPTIONS --mountpoint "$DATA_ROOT") || fail '无法读取父数据盘挂载选项。'
  mount_has_option "$options" rw || fail '父数据盘不是可写挂载。'
  root_device=$(stat -c '%d' /) || fail '无法读取根盘设备。'
  data_device=$(stat -c '%d' "$DATA_ROOT") || fail '无法读取父数据盘设备。'
  [[ "$data_device" != "$root_device" ]] || fail '父数据盘回退到了根盘。'
  [[ -x "$DATA_ANCHOR_CHECK" && ! -L "$DATA_ANCHOR_CHECK" &&
    $(stat -c '%u:%g:%a' "$DATA_ANCHOR_CHECK") == '0:0:755' ]] ||
    fail 'canonical data-anchor checker 尚未受信安装。'
  "$DATA_ANCHOR_CHECK" || fail 'canonical data anchor 验证失败。'
  [[ -d "$CONTROL_PARENT" && ! -L "$CONTROL_PARENT" &&
    $(readlink -f -- "$CONTROL_PARENT") == "$CONTROL_PARENT" &&
    $(stat -c '%u:%g:%a' "$CONTROL_PARENT") == '0:0:700' &&
    $(findmnt -rn -M "$CONTROL_PARENT" -o TARGET) == "$CONTROL_PARENT" &&
    $(stat -c '%d' "$CONTROL_PARENT") == "$data_device" ]] ||
    fail 'control-state 专用父目录不在父数据盘或权限漂移。'
  verify_installed_units
  verify_source_roots
  INCOMING_FROZEN=1
  chmod 0000 "$INCOMING_ROOT"
  assert_no_open_incoming
  [[ ! -e "$STATE_ROOT" || (! -L "$STATE_ROOT" && -d "$STATE_ROOT" && -z $(find "$STATE_ROOT" -mindepth 1 -maxdepth 1 -print -quit)) ]] ||
    fail 'control-state mountpoint 已存在且非空。'
  findmnt -rn --mountpoint "$STATE_ROOT" >/dev/null 2>&1 && fail 'control-state 已经挂载；拒绝重复迁移。'
  consume_verified_maintenance_fence

  if [[ ! -e "$BACKING_FILE" && ! -L "$BACKING_FILE" ]]; then
    assert_parent_capacity "$BACKING_BYTES" 1
    fallocate -l "$BACKING_BYTES" "$BACKING_FILE"
    chown root:root "$BACKING_FILE"
    chmod 0600 "$BACKING_FILE"
    mkfs.ext4 -q -F -m 0 -L "$FILESYSTEM_LABEL" "$BACKING_FILE"
    image_created=1
  fi
  [[ -f "$BACKING_FILE" && ! -L "$BACKING_FILE" ]] || fail 'control-state backing 不是普通文件。'
  [[ $(stat -c '%u:%g:%a:%s' "$BACKING_FILE") == "0:0:600:$BACKING_BYTES" ]] ||
    fail 'control-state backing 所有者、权限或容量漂移。'
  [[ $(blkid -s TYPE -o value "$BACKING_FILE" 2>/dev/null) == ext4 ]] || fail 'control-state backing 不是 ext4。'
  [[ $(blkid -s LABEL -o value "$BACKING_FILE" 2>/dev/null) == "$FILESYSTEM_LABEL" ]] ||
    fail 'control-state filesystem label 漂移。'
  [[ $(findmnt -rn -T "$BACKING_FILE" -o TARGET) == "$CONTROL_PARENT" &&
    $(stat -c '%d' "$BACKING_FILE") == "$data_device" ]] ||
    fail 'control-state backing 未物理落在父数据盘。'
  assert_parent_capacity 0 0
  ((image_created == 1)) || fail '已存在未挂载的 backing；拒绝猜测中断状态，请人工审核。'

  install -d -o root -g root -m 0700 "$STATE_ROOT"
  MOUNTED_BY_SCRIPT=1
  mount -o loop,rw,nodev,nosuid,noexec -- "$BACKING_FILE" "$STATE_ROOT"
  if [[ -d "$STATE_ROOT/lost+found" && ! -L "$STATE_ROOT/lost+found" ]]; then
    rmdir "$STATE_ROOT/lost+found" || fail '新 control-state 的 lost+found 非空。'
  fi
  chmod 0700 "$STATE_ROOT"
  install -d -o root -g root -m 1733 "$STATE_ROOT/incoming"
  install -d -o root -g root -m 0755 "$STATE_ROOT/releases" "$STATE_ROOT/evidence"
  install -d -o root -g root -m 0700 "$STATE_ROOT/work"
  printf '%s\n' "$SENTINEL_VALUE" >"$SENTINEL"
  chown root:root "$SENTINEL"
  chmod 0400 "$SENTINEL"

  work="$STATE_ROOT/work/prepare.$$"
  install -d -o root -g root -m 0700 "$work"
  for path in incoming releases evidence; do
    case "$path" in
      incoming) source_root=$INCOMING_ROOT ;;
      releases) source_root=$RELEASES_ROOT ;;
      evidence) source_root=$EVIDENCE_ROOT ;;
    esac
    tree_manifest "$source_root" "$work/$path.before.json" || fail "$path 源树包含链接、特殊文件或嵌套设备。"
    ionice -c 3 nice -n 19 cp -a --one-file-system -- "$source_root/." "$STATE_ROOT/$path/"
    tree_manifest "$source_root" "$work/$path.after.json" || fail "$path 源树在复制后发生漂移。"
    tree_manifest "$STATE_ROOT/$path" "$work/$path.destination.json" || fail "$path 目标树校验失败。"
    cmp -s "$work/$path.before.json" "$work/$path.after.json" || fail "$path 在离线复制期间发生变化。"
    cmp -s "$work/$path.before.json" "$work/$path.destination.json" || fail "$path 复制摘要不一致。"
  done
  # cp -a source/. destination/ preserves the source root metadata too. The
  # old incoming tree is deliberately frozen at 0000 during the copy, so
  # restore every destination root to its canonical post-cutover contract.
  chmod 1733 "$STATE_ROOT/incoming"
  chmod 0755 "$STATE_ROOT/releases" "$STATE_ROOT/evidence"
  chmod 0700 "$STATE_ROOT/work"
  tree_manifest "$INCOMING_ROOT" "$work/incoming.final.json" || fail '旧 incoming 在最终切换前发生漂移。'
  cmp -s "$work/incoming.before.json" "$work/incoming.final.json" ||
    fail '旧 incoming 在复制校验后发生变化。'
  install -d -o root -g root -m 0700 "$STATE_ROOT/releases/.staging"
  state_free=$(df -B1 --output=avail "$STATE_ROOT" | awk 'NR==2 {print $1}') || fail '无法读取新 control-state 容量。'
  state_inodes=$(df --output=iavail "$STATE_ROOT" | awk 'NR==2 {print $1}') || fail '无法读取新 control-state inode。'
  [[ "$state_free" =~ ^[0-9]+$ && "$state_inodes" =~ ^[0-9]+$ ]] || fail '新 control-state 容量格式不合法。'
  (( state_free >= STATE_MIN_FREE_BYTES && state_inodes >= STATE_MIN_FREE_INODES )) ||
    fail '迁移数据后 control-state 低于 1 GiB 或 4096 inode 安全水位。'
  assert_parent_capacity 0 0
  ROLLBACK_MANIFEST_DIR=$(mktemp -d /run/combo-dev-control-state-manifest.XXXXXX) ||
    fail '无法创建 root-only 回滚摘要目录。'
  chmod 0700 "$ROLLBACK_MANIFEST_DIR"
  for path in incoming releases evidence; do
    cp -- "$work/$path.before.json" "$ROLLBACK_MANIFEST_DIR/$path.json"
    chmod 0600 "$ROLLBACK_MANIFEST_DIR/$path.json"
  done
  rm -f -- "$work"/*.json
  rmdir "$work"
  sync -f "$STATE_ROOT"
  umount "$STATE_ROOT"
  MOUNTED_BY_SCRIPT=0
  chmod 0000 "$STATE_ROOT"

  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  backup="/opt/combo-dev/root-backup-control-state.$timestamp"
  [[ ! -e "$backup" && ! -L "$backup" ]] || fail 'control-state 备份路径已存在。'
  root_parent_device=$(stat -c '%d' /opt/combo-dev)
  var_parent_device=$(stat -c '%d' /var/lib/combo-dev)
  [[ "$root_parent_device" == "$var_parent_device" ]] || fail '旧目录不在同一根盘，无法原子保留备份。'
  install -d -o root -g root -m 0700 "$backup"
  CUTOVER_BACKUP=$backup
  install -d -o root -g root -m 0700 "$backup/.manifests"
  for path in incoming releases evidence; do
    case "$path" in
      incoming) source_root=$INCOMING_ROOT ;;
      releases) source_root=$RELEASES_ROOT ;;
      evidence) source_root=$EVIDENCE_ROOT ;;
    esac
    tree_manifest "$source_root" "$ROLLBACK_MANIFEST_DIR/$path.final.json" ||
      fail "$path 在最终切换前不可验证。"
    cmp -s "$ROLLBACK_MANIFEST_DIR/$path.json" "$ROLLBACK_MANIFEST_DIR/$path.final.json" ||
      fail "$path 在最终切换前发生变化。"
    install -o root -g root -m 0400 "$ROLLBACK_MANIFEST_DIR/$path.json" "$backup/.manifests/$path.json"
    install -o root -g root -m 0400 "$ROLLBACK_MANIFEST_DIR/$path.final.json" "$backup/.manifests/$path.final.json"
  done
  INCOMING_MOVED=1
  mv -T -- "$INCOMING_ROOT" "$backup/incoming"
  chmod 1733 "$backup/incoming"
  INCOMING_FROZEN=0
  RELEASES_MOVED=1
  mv -T -- "$RELEASES_ROOT" "$backup/releases"
  EVIDENCE_MOVED=1
  mv -T -- "$EVIDENCE_ROOT" "$backup/evidence"
  install -d -o root -g root -m 0000 "$INCOMING_ROOT" "$RELEASES_ROOT" "$EVIDENCE_ROOT"

  systemctl daemon-reload
  systemctl enable "$STATE_UNIT" "$INCOMING_UNIT" "$RELEASES_UNIT" "$EVIDENCE_UNIT"
  systemctl start "$STATE_UNIT"
  systemctl start "$INCOMING_UNIT" "$RELEASES_UNIT" "$EVIDENCE_UNIT"
  verify_control_state_mount
  for path in "$INCOMING_ROOT" "$RELEASES_ROOT" "$EVIDENCE_ROOT"; do
    [[ $(findmnt -rn -o TARGET --mountpoint "$path") == "$path" ]] || fail "$path compatibility bind 未生效。"
  done
  CUTOVER_COMPLETE=1
  status "PASS backing=$BACKING_FILE bytes=$BACKING_BYTES backup=$backup"
  status '旧根盘备份不会自动删除；请在 24–72 小时观察及另行审核后处理。'
  rm -rf --one-file-system -- "$ROLLBACK_MANIFEST_DIR"
  ROLLBACK_MANIFEST_DIR=''
  trap - EXIT
}

main "$@"
