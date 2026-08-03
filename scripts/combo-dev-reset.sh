#!/usr/bin/env bash
# 破坏性重置固定的 combo-preview 数据面。确认串、命名空间、工作负载和三个 PVC 都不可参数化。
set -Eeuo pipefail
umask 077
export PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

readonly NAMESPACE='combo-preview'
readonly PRODUCTION_NAMESPACE='combo'
readonly CONFIRMATION='DESTROY-COMBO-PREVIEW-DATA'
readonly INSTALL_ROOT='/opt/combo-dev'
readonly RELEASES_DIR='/opt/combo-dev/releases'
readonly INCOMING_DIR='/opt/combo-dev/incoming'
readonly CONTROL_STATE='/opt/combo-dev/state'
readonly CONTROL_STATE_PARENT='/var/lib/combo-host-data'
readonly CONTROL_STATE_IMAGE='/var/lib/combo-host-data/control-state.img'
readonly DATA_ANCHOR_CHECK='/opt/combo-dev/bin/combo-host-data-mount-check'
readonly CONTROL_STATE_SENTINEL='/opt/combo-dev/state/.combo-dev-control-state'
readonly CONTROL_STATE_SENTINEL_VALUE='combo-dev-control-state=v1'
readonly CONTROL_STATE_BYTES=4294967296
readonly CONTROL_STATE_LABEL='combo-dev-state'
readonly CONTROL_INCOMING='/opt/combo-dev/state/incoming'
readonly CONTROL_RELEASES='/opt/combo-dev/state/releases'
readonly CONTROL_STAGING='/opt/combo-dev/state/releases/.staging'
readonly CONTROL_WORK='/opt/combo-dev/state/work'
readonly CONTROL_EVIDENCE='/opt/combo-dev/state/evidence'
readonly CONTROL_STATE_MIN_BYTES=$((3584 * 1024 * 1024))
readonly CONTROL_STATE_MAX_BYTES=$((4 * 1024 * 1024 * 1024))
readonly CONTROL_STATE_MIN_FREE_BYTES=$((1024 * 1024 * 1024))
readonly CONTROL_STATE_MIN_FREE_INODES=4096
# 512 MiB log capture budget plus 128 MiB for extraction, smoke metadata, and work files.
readonly CONTROL_WORK_MARGIN_BYTES=$((640 * 1024 * 1024))
readonly ARCHIVE_MAX_BYTES=$((512 * 1024 * 1024))
readonly DATA_MOUNT='/home/xingzheng/data'
readonly STORAGE_POOL='/home/xingzheng/data/combo-dev'
readonly STORAGE_CLASS='combo-dev-bounded'
readonly POSTGRES_STORAGE_PATH='/home/xingzheng/data/combo-dev/postgres/data'
readonly REDIS_QUEUE_STORAGE_PATH='/home/xingzheng/data/combo-dev/redis-queue/data'
readonly MINIO_STORAGE_PATH='/home/xingzheng/data/combo-dev/minio/data'
readonly STORAGE_LOW_MARKER='/run/combo-dev-storage-low'
readonly KUBECONFIG_PATH='/etc/combo-dev/dispatcher.kubeconfig'
readonly PRODUCTION_KUBECONFIG='/etc/combo-dev/production-observer.kubeconfig'
readonly CLUSTER_PLATFORM_CONTRACT='/etc/combo-dev/cluster-platform.canonical.json'
readonly LOCK_FILE='/run/lock/combo-dev.lock'
readonly FENCE_LOCK_FILE='/run/lock/combo-dev-fence.lock'
readonly FAILURE_FENCE_MARKER='/var/lib/combo-dev/writers-fenced'
readonly FAILURE_FENCE_VALUE='combo-dev-writers=fenced'
readonly SAFE_IDLE_FENCE_VALUE='combo-dev-writers=safe-idle-v1'
readonly EXTERNAL_FENCE_MARKER='/var/lib/combo-dev/external-fence'
readonly ACCEPTANCE_PENDING_MARKER='/var/lib/combo-dev/acceptance-pending'
readonly RESET_PROOF_ROOT='/var/lib/combo-dev'
readonly ACCEPTANCE_PENDING_SECONDS=7200
readonly HOST_SYSLOG_POLICY='/etc/logrotate.d/combo-host-syslog'
readonly HOST_SYSLOG_POLICY_SHA256='aad4fc3b67504ff6dbec2a05b7230c8c78bb57e3465d5d6b75a3ef8e3d6eae94'
RESET_PROOF=''
readonly DISPATCHER_FENCE_BEFORE_SECONDS=$((7 * 24 * 60 * 60))
readonly BOOTSTRAP_FOUNDATION='/opt/combo-dev/bootstrap-overlay/foundation'
readonly APPS=(api worker runtime web)
readonly FOUNDATION_STATEFUL=(postgres redis-queue minio)
K=(kubectl --request-timeout=30s --kubeconfig "$KUBECONFIG_PATH")
PK=(kubectl --request-timeout=30s --kubeconfig "$PRODUCTION_KUBECONFIG")
WORK=''
FOUNDATION=''
MUTATING=0
SUCCESS=0
RECOVERED_FROM_ATTEMPT=''
RECOVERY_REVISION=''
RECOVERY_RUN_ID=''
RECOVERY_RUN_ATTEMPT=''
ATTEMPT_REVISION=''
ATTEMPT_RUN_ID=''
ATTEMPT_RUN_ATTEMPT=''

status() { printf '[combo-dev-reset] %s\n' "$1"; }
fail() { printf '[combo-dev-reset] FAIL: %s\n' "$1" >&2; exit 1; }
blocked() { printf '[combo-dev-reset] BLOCKED: %s\n' "$1" >&2; exit 2; }

storage_guard_timer_ready() {
  local next
  [[ $(timeout 10 systemctl is-enabled combo-dev-storage-guard.timer 2>/dev/null || true) == enabled ]] || return 1
  [[ $(timeout 10 systemctl is-active combo-dev-storage-guard.timer 2>/dev/null || true) == active ]] || return 1
  next=$(timeout 10 systemctl show combo-dev-storage-guard.timer -p NextElapseUSecMonotonic --value 2>/dev/null) || return 1
  [[ -n "$next" && "$next" != 0 && "$next" != infinity ]]
}
cleanup() {
  local rc=$? proof_cleanup_ok=1 convergence_ok=1
  set +e
  if (( MUTATING == 1 && SUCCESS == 0 )); then
    mark_failure_fence >/dev/null 2>&1 || true
    remove_all_reset_proofs >/dev/null 2>&1 || proof_cleanup_ok=0
    stop_forwarders >/dev/null 2>&1 || convergence_ok=0
    fence_all_writers >/dev/null 2>&1 || convergence_ok=0
    verify_complete_writer_inventory_zero >/dev/null 2>&1 || convergence_ok=0
    if (( convergence_ok == 1 )); then
      if (( proof_cleanup_ok == 0 )); then
        status '失败收敛已验证，但 reset proof inventory 无法清空；需要主机所有者介入。'
      elif record_failed_attempt_capability >/dev/null 2>&1; then
        status '失败收敛已验证；当前 attempt 已记录，下一次手工 Test 部署可从 reset 安全重试。'
      else
        status '失败收敛已验证，但 attempt 恢复能力无法安全提交；需要主机所有者介入。'
      fi
    else
      status '失败收敛无法验证；阻断标记已保留并需要主机所有者介入。'
    fi
  fi
  [[ -z "$WORK" ]] || rm -rf --one-file-system -- "$WORK"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

trusted_foundation_tree() {
  python3 - "$1" <<'PY'
import os, stat, sys
for current,dirs,files in os.walk(sys.argv[1],followlinks=False):
    for path in [current]+[os.path.join(current,x) for x in dirs+files]:
        s=os.lstat(path)
        if s.st_uid != 0 or stat.S_ISLNK(s.st_mode) or (s.st_mode & 0o022): raise SystemExit(2)
PY
}

root_owned_not_writable() {
  local mode owner
  [[ -e "$1" && ! -L "$1" ]] || return 1
  mode=$(stat -c '%a' "$1" 2>/dev/null) || return 1
  owner=$(stat -c '%u' "$1" 2>/dev/null) || return 1
  [[ "$owner" == 0 && "$mode" =~ ^[0-7]{3,4}$ && $((8#$mode & 8#022)) == 0 ]]
}

private_file() {
  local mode owner
  [[ -f "$1" && ! -L "$1" ]] || return 1
  mode=$(stat -c '%a' "$1" 2>/dev/null) || return 1
  owner=$(stat -c '%u' "$1" 2>/dev/null) || return 1
  [[ "$owner" == 0 && ( "$mode" == 600 || "$mode" == 400 ) ]]
}

free_bytes() {
  df -PB1 -- "$1" | awk 'NR == 2 {print $4}'
}

free_inodes() {
  df -Pi -- "$1" | awk 'NR == 2 {print $4}'
}

verify_control_state() {
  local canonical target source root_source data_source options total backing path fsroot fstype data_target root_device data_device
  [[ -x "$DATA_ANCHOR_CHECK" && ! -L "$DATA_ANCHOR_CHECK" &&
    $(stat -c '%u:%g:%a' "$DATA_ANCHOR_CHECK" 2>/dev/null) == '0:0:755' ]] || return 1
  "$DATA_ANCHOR_CHECK" >/dev/null 2>&1 || return 1
  [[ -d "$CONTROL_STATE" && ! -L "$CONTROL_STATE" ]] || return 1
  canonical=$(readlink -f -- "$CONTROL_STATE" 2>/dev/null) || return 1
  [[ "$canonical" == "$CONTROL_STATE" ]] || return 1
  [[ $(stat -c '%u:%g:%a' "$CONTROL_STATE" 2>/dev/null) == '0:0:700' ]] || return 1
  [[ -f "$CONTROL_STATE_SENTINEL" && ! -L "$CONTROL_STATE_SENTINEL" ]] || return 1
  [[ $(stat -c '%u:%g:%a' "$CONTROL_STATE_SENTINEL" 2>/dev/null) == '0:0:400' ]] || return 1
  [[ $(cat "$CONTROL_STATE_SENTINEL" 2>/dev/null || true) == "$CONTROL_STATE_SENTINEL_VALUE" ]] || return 1
  [[ -d "$CONTROL_STATE_PARENT" && ! -L "$CONTROL_STATE_PARENT" ]] || return 1
  [[ $(stat -c '%u:%g:%a' "$CONTROL_STATE_PARENT" 2>/dev/null) == '0:0:700' ]] || return 1
  [[ $(readlink -f -- "$CONTROL_STATE_PARENT" 2>/dev/null) == "$CONTROL_STATE_PARENT" ]] || return 1
  [[ -f "$CONTROL_STATE_IMAGE" && ! -L "$CONTROL_STATE_IMAGE" ]] || return 1
  [[ $(stat -c '%u:%g:%a' "$CONTROL_STATE_IMAGE" 2>/dev/null) == '0:0:600' ]] || return 1
  [[ $(readlink -f -- "$CONTROL_STATE_IMAGE" 2>/dev/null) == "$CONTROL_STATE_IMAGE" ]] || return 1
  [[ $(stat -c '%s' "$CONTROL_STATE_IMAGE" 2>/dev/null) == "$CONTROL_STATE_BYTES" ]] || return 1
  data_target=$(findmnt -rn -T "$CONTROL_STATE_IMAGE" -o TARGET 2>/dev/null) || return 1
  [[ "$data_target" == "$CONTROL_STATE_PARENT" ]] || return 1
  [[ $(stat -c '%d' "$CONTROL_STATE_IMAGE" 2>/dev/null) == $(stat -c '%d' "$DATA_MOUNT" 2>/dev/null) ]] || return 1
  target=$(findmnt -rn -M "$CONTROL_STATE" -o TARGET 2>/dev/null) || return 1
  [[ "$target" == "$CONTROL_STATE" ]] || return 1
  source=$(findmnt -rn -M "$CONTROL_STATE" -o SOURCE 2>/dev/null) || return 1
  root_source=$(findmnt -rn -M / -o SOURCE 2>/dev/null) || return 1
  data_source=$(findmnt -rn -M "$DATA_MOUNT" -o SOURCE 2>/dev/null) || return 1
  data_target=$(findmnt -rn -M "$DATA_MOUNT" -o TARGET 2>/dev/null) || return 1
  [[ "$data_target" == "$DATA_MOUNT" ]] || return 1
  root_device=$(stat -c '%d' / 2>/dev/null) || return 1
  data_device=$(stat -c '%d' "$DATA_MOUNT" 2>/dev/null) || return 1
  [[ "$data_device" != "$root_device" ]] || return 1
  [[ "$data_source" != "$root_source" ]] || return 1
  [[ "$source" =~ ^/dev/loop[0-9]+$ && "$source" != "$root_source" && "$source" != "$data_source" ]] || return 1
  backing=$(losetup -n -O BACK-FILE -- "$source" 2>/dev/null | awk '{$1=$1; print}') || return 1
  [[ "$backing" == "$CONTROL_STATE_IMAGE" ]] || return 1
  [[ $(blockdev --getsize64 "$source" 2>/dev/null) == "$CONTROL_STATE_BYTES" ]] || return 1
  fstype=$(findmnt -rn -M "$CONTROL_STATE" -o FSTYPE 2>/dev/null) || return 1
  [[ "$fstype" == ext4 ]] || return 1
  [[ $(blkid -s LABEL -o value "$source" 2>/dev/null) == "$CONTROL_STATE_LABEL" ]] || return 1
  options=$(findmnt -rn -M "$CONTROL_STATE" -o OPTIONS 2>/dev/null) || return 1
  [[ ",$options," == *,rw,* && ",$options," == *,nodev,* && ",$options," == *,nosuid,* && ",$options," == *,noexec,* ]] || return 1
  total=$(df -B1 --output=size "$CONTROL_STATE" 2>/dev/null | awk 'NR==2 {print $1}') || return 1
  [[ "$total" =~ ^[0-9]+$ ]] || return 1
  (( total >= CONTROL_STATE_MIN_BYTES && total <= CONTROL_STATE_MAX_BYTES )) || return 1
  for path in "$CONTROL_INCOMING" "$CONTROL_RELEASES" "$CONTROL_STAGING" "$CONTROL_WORK" "$CONTROL_EVIDENCE"; do
    [[ -d "$path" && ! -L "$path" ]] || return 1
    [[ $(findmnt -rn -T "$path" -o TARGET 2>/dev/null) == "$CONTROL_STATE" ]] || return 1
  done
  [[ $(stat -c '%u:%g:%a' "$CONTROL_INCOMING" 2>/dev/null) == '0:0:1733' ]] || return 1
  [[ $(stat -c '%u:%g:%a' "$CONTROL_RELEASES" 2>/dev/null) == '0:0:755' ]] || return 1
  [[ $(stat -c '%u:%g:%a' "$CONTROL_EVIDENCE" 2>/dev/null) == '0:0:755' ]] || return 1
  for path in "$CONTROL_STAGING" "$CONTROL_WORK"; do
    [[ $(stat -c '%u:%g:%a' "$path" 2>/dev/null) == '0:0:700' ]] || return 1
  done
  for path in "$INCOMING_DIR" "$RELEASES_DIR" /var/lib/combo-dev/evidence; do
    [[ -d "$path" && ! -L "$path" ]] || return 1
    [[ $(findmnt -rn -M "$path" -o TARGET 2>/dev/null) == "$path" ]] || return 1
    options=$(findmnt -rn -M "$path" -o OPTIONS 2>/dev/null) || return 1
    [[ ",$options," == *,rw,* && ",$options," == *,nodev,* && ",$options," == *,nosuid,* && ",$options," == *,noexec,* ]] || return 1
  done
  fsroot=$(findmnt -rn -M "$INCOMING_DIR" -o FSROOT 2>/dev/null) || return 1
  [[ "$fsroot" == '/incoming' ]] || return 1
  fsroot=$(findmnt -rn -M "$RELEASES_DIR" -o FSROOT 2>/dev/null) || return 1
  [[ "$fsroot" == '/releases' ]] || return 1
  fsroot=$(findmnt -rn -M /var/lib/combo-dev/evidence -o FSROOT 2>/dev/null) || return 1
  [[ "$fsroot" == '/evidence' ]] || return 1
  [[ $(stat -c '%d:%i' "$INCOMING_DIR" 2>/dev/null) == $(stat -c '%d:%i' "$CONTROL_INCOMING" 2>/dev/null) ]] || return 1
  [[ $(stat -c '%d:%i' "$RELEASES_DIR" 2>/dev/null) == $(stat -c '%d:%i' "$CONTROL_RELEASES" 2>/dev/null) ]] || return 1
  [[ $(stat -c '%d:%i' /var/lib/combo-dev/evidence 2>/dev/null) == $(stat -c '%d:%i' "$CONTROL_EVIDENCE" 2>/dev/null) ]] || return 1
}

host_syslog_policy_valid() {
  local digest
  [[ $(stat -c '%u:%g:%a' /etc/logrotate.d 2>/dev/null || true) == '0:0:755' ]] || return 1
  root_owned_not_writable "$HOST_SYSLOG_POLICY" || return 1
  [[ -f "$HOST_SYSLOG_POLICY" ]] || return 1
  [[ $(stat -c '%u:%g:%a' "$HOST_SYSLOG_POLICY" 2>/dev/null || true) == '0:0:644' ]] || return 1
  digest=$(sha256sum "$HOST_SYSLOG_POLICY" 2>/dev/null | awk '{print $1}') || return 1
  [[ "$digest" == "$HOST_SYSLOG_POLICY_SHA256" ]]
}

assert_capacity_ready() {
  local incoming_bytes=${1:-0} free inodes required
  host_syslog_policy_valid || blocked '受控主机 syslog 轮转策略缺失、可写或内容漂移；必须重新 bootstrap。'
  findmnt -rn -M "$DATA_MOUNT" >/dev/null 2>&1 || blocked '固定数据盘没有挂载。'
  [[ "$incoming_bytes" =~ ^[0-9]+$ ]] || blocked 'incoming 容量参数不合法。'
  (( incoming_bytes <= ARCHIVE_MAX_BYTES )) || blocked 'incoming 容量参数超过 512 MiB。'
  verify_control_state || blocked 'control-state 挂载、backing file、目录或兼容 bind 契约失效。'
  free=$(free_bytes "$CONTROL_STATE") || blocked '无法读取 control-state 容量。'
  inodes=$(free_inodes "$CONTROL_STATE") || blocked '无法读取 control-state inode。'
  [[ "$free" =~ ^[0-9]+$ && "$inodes" =~ ^[0-9]+$ ]] || blocked 'control-state 容量指标格式不合法。'
  # The workflow uploads one copy into incoming, then deploy copies it into
  # the private work tree. Reserve both copies plus bounded logging,
  # extraction, and smoke work before any Test mutation.
  required=$((CONTROL_STATE_MIN_FREE_BYTES + 2 * incoming_bytes + CONTROL_WORK_MARGIN_BYTES))
  (( free >= required && inodes >= CONTROL_STATE_MIN_FREE_INODES )) ||
    blocked 'control-state 不足以保留基础水位和本次上传包。'
  "$INSTALL_ROOT/bin/combo-dev-storage-guard" --check-only >/dev/null 2>&1 ||
    blocked '业务存储池、父数据盘或根盘 OS 健康检查未通过。'
}

assert_release_tree_unmounted() {
  local mounts target
  mounts=$(findmnt -rn -o TARGET) || blocked '无法读取主机挂载表；拒绝清理旧 Test release。'
  while IFS= read -r target; do
    [[ "$target" == "$RELEASES_DIR" || "$target" == "$CONTROL_STATE" ]] && continue
    [[ "$target" == "$RELEASES_DIR"/* || "$target" == "$CONTROL_RELEASES"/* ]] || continue
    blocked 'Test release 树内存在挂载点；拒绝越过挂载边界执行容量清理。'
  done <<<"$mounts"
}

plan_stale_test_cleanup() {
  local release_plan=$1 incoming_plan=$2
  python3 - "$INSTALL_ROOT" "$RELEASES_DIR" "$INCOMING_DIR" \
    "$INSTALL_ROOT/current" "$release_plan" "$incoming_plan" <<'PY'
import os
import re
import stat
import sys
import time

install_root, releases_dir, incoming_dir, current_link, release_plan, incoming_plan = sys.argv[1:]
sha = re.compile(r'^[0-9a-f]{40}$')

def safe_root_directory(path):
    value = os.lstat(path)
    if not stat.S_ISDIR(value.st_mode) or stat.S_ISLNK(value.st_mode):
        raise SystemExit(2)
    if value.st_uid != 0 or value.st_mode & 0o022:
        raise SystemExit(2)

def safe_release_tree(path, expected_device):
    for current, dirs, files in os.walk(path, followlinks=False):
        for entry in [current] + [os.path.join(current, name) for name in dirs + files]:
            value = os.lstat(entry)
            if value.st_dev != expected_device or value.st_uid != 0 or value.st_mode & 0o022:
                raise SystemExit(2)
            if stat.S_ISLNK(value.st_mode):
                raise SystemExit(2)
            if not (stat.S_ISDIR(value.st_mode) or stat.S_ISREG(value.st_mode)):
                raise SystemExit(2)

for path in (install_root, releases_dir):
    safe_root_directory(path)
releases_device = os.lstat(releases_dir).st_dev
staging = os.path.join(releases_dir, '.staging')
safe_root_directory(staging)
if stat.S_IMODE(os.lstat(staging).st_mode) != 0o700:
    raise SystemExit(2)

incoming = os.lstat(incoming_dir)
if not stat.S_ISDIR(incoming.st_mode) or stat.S_ISLNK(incoming.st_mode):
    raise SystemExit(2)
if incoming.st_uid != 0 or stat.S_IMODE(incoming.st_mode) != 0o1733:
    raise SystemExit(2)

current = None
if os.path.lexists(current_link):
    if not os.path.islink(current_link):
        raise SystemExit(2)
    current = os.path.realpath(current_link)
    if os.path.dirname(current) != os.path.realpath(releases_dir):
        raise SystemExit(2)
    if not sha.fullmatch(os.path.basename(current)):
        raise SystemExit(2)
    safe_root_directory(current)
    safe_release_tree(current, releases_device)

releases = []
for name in os.listdir(releases_dir):
    if name == '.staging':
        continue
    path = os.path.join(releases_dir, name)
    if not sha.fullmatch(name):
        raise SystemExit(2)
    safe_root_directory(path)
    safe_release_tree(path, releases_device)
    releases.append((os.lstat(path).st_mtime_ns, name, path))

releases.sort(key=lambda item: (-item[0], item[1]))
keep = set()
if current is not None:
    keep.add(current)
for _, _, path in releases:
    if len(keep) >= 3:
        break
    keep.add(path)

with open(release_plan, 'wb') as output:
    for _, _, path in releases:
        if path not in keep:
            output.write(os.fsencode(path) + b'\0')

incoming_name = re.compile(
    r'^(?:[0-9a-f]{40}(?:\.acceptance)?\.[1-9][0-9]*\.[1-9][0-9]*\.tar\.gz|'
    r'\.[0-9a-f]{40}(?:\.acceptance)?\.[1-9][0-9]*\.[1-9][0-9]*\.upload)$'
)
cutoff = time.time() - (2 * 24 * 60 * 60)
with open(incoming_plan, 'wb') as output:
    for name in os.listdir(incoming_dir):
        path = os.path.join(incoming_dir, name)
        value = os.lstat(path)
        if (not incoming_name.fullmatch(name) or not stat.S_ISREG(value.st_mode)
                or stat.S_ISLNK(value.st_mode)):
            raise SystemExit(2)
        if value.st_mtime < cutoff:
            output.write(os.fsencode(path) + b'\0')
PY
}

clean_stale_test_artifacts() {
  local release_plan="$WORK/stale-releases.nul" incoming_plan="$WORK/stale-incoming.nul"
  local path release_count=0 incoming_count=0
  local -a stale_releases=() stale_incoming=()
  assert_release_tree_unmounted
  plan_stale_test_cleanup "$release_plan" "$incoming_plan" ||
    blocked 'Test releases 或 incoming 目录包含不受信任的条目；未执行容量清理。'
  mapfile -d '' -t stale_releases <"$release_plan"
  mapfile -d '' -t stale_incoming <"$incoming_plan"
  for path in "${stale_releases[@]}"; do
    [[ "$path" =~ ^/opt/combo-dev/releases/[0-9a-f]{40}$ ]] ||
      blocked '旧 Test release 清理计划越过固定目录。'
    assert_release_tree_unmounted
    rm -rf --one-file-system -- "$path" || blocked '旧 Test release 无法安全删除。'
    [[ ! -e "$path" && ! -L "$path" ]] || blocked '旧 Test release 删除后仍然存在。'
    ((release_count += 1))
  done
  for path in "${stale_incoming[@]}"; do
    [[ "$path" == "$INCOMING_DIR"/* && "$path" != "$INCOMING_DIR"/*/* ]] ||
      blocked '旧 incoming 文件清理计划越过固定目录。'
    rm -f -- "$path" || blocked '旧 Test incoming 文件无法安全删除。'
    [[ ! -e "$path" && ! -L "$path" ]] || blocked '旧 Test incoming 文件删除后仍然存在。'
    ((incoming_count += 1))
  done
  status "capacity cleanup releases=$release_count incoming=$incoming_count"
}

prepare_capacity() {
  local incoming_bytes=$1
  [[ $(id -u) -eq 0 ]] || blocked '容量准备必须由受限 sudo 规则以 root 启动。'
  local cmd active timer_active root_before root_after data_before data_after state_before state_after
  for cmd in python3 sha256sum flock findmnt df systemctl timeout stat rm logrotate awk mktemp losetup blockdev blkid; do
    command -v "$cmd" >/dev/null 2>&1 || blocked "缺少容量准备工具：$cmd"
  done
  root_owned_not_writable "${BASH_SOURCE[0]}" || blocked '当前 reset 调度器可被非 root 修改。'
  host_syslog_policy_valid || blocked '受控主机 syslog 轮转策略缺失、可写或内容漂移；必须重新 bootstrap。'
  active=$(timeout 10 systemctl is-active rsyslog.service 2>/dev/null || true)
  [[ "$active" == active ]] || blocked 'rsyslog 未运行，拒绝在无法 HUP 写入者时轮转主机日志。'
  timer_active=$(timeout 10 systemctl is-active systemd-tmpfiles-clean.timer 2>/dev/null || true)
  [[ "$timer_active" == active ]] || blocked 'systemd-tmpfiles-clean.timer 未运行，拒绝绕过原生临时文件保留策略。'
  timeout 30 logrotate --debug "$HOST_SYSLOG_POLICY" >/dev/null 2>&1 ||
    blocked '主机 syslog 轮转策略未通过 logrotate 校验。'
  findmnt -rn -M "$DATA_MOUNT" >/dev/null 2>&1 || blocked '固定数据盘没有挂载。'
  verify_control_state || blocked '容量准备前 control-state 固定契约失效。'
  root_before=$(free_bytes /) || blocked '无法读取容量准备前根盘容量。'
  data_before=$(free_bytes "$DATA_MOUNT") || blocked '无法读取容量准备前数据盘容量。'
  state_before=$(free_bytes "$CONTROL_STATE") || blocked '无法读取容量准备前 control-state 容量。'
  [[ "$root_before" =~ ^[0-9]+$ && "$data_before" =~ ^[0-9]+$ && "$state_before" =~ ^[0-9]+$ ]] ||
    blocked '容量准备前磁盘指标格式不合法。'
  WORK=$(mktemp -d "$CONTROL_WORK/capacity.XXXXXX") || blocked '无法在 control-state 创建容量准备工作区。'
  timeout 600 systemctl start systemd-tmpfiles-clean.service >/dev/null 2>&1 ||
    blocked '原生 systemd-tmpfiles-clean.service 清理失败或超时；未直接删除 /tmp。'
  timer_active=$(timeout 10 systemctl is-active systemd-tmpfiles-clean.timer 2>/dev/null || true)
  [[ "$timer_active" == active ]] || blocked '原生临时文件清理后 timer 未保持运行。'
  clean_stale_test_artifacts
  timeout 900 logrotate "$HOST_SYSLOG_POLICY" >/dev/null 2>&1 ||
    blocked '主机 syslog 轮转失败；破坏性重置未开始。'
  root_after=$(free_bytes /) || blocked '无法读取容量准备后根盘容量。'
  data_after=$(free_bytes "$DATA_MOUNT") || blocked '无法读取容量准备后数据盘容量。'
  state_after=$(free_bytes "$CONTROL_STATE") || blocked '无法读取容量准备后 control-state 容量。'
  [[ "$root_after" =~ ^[0-9]+$ && "$data_after" =~ ^[0-9]+$ && "$state_after" =~ ^[0-9]+$ ]] ||
    blocked '容量准备后磁盘指标格式不合法。'
  status "capacity bytes root_before=$root_before root_after=$root_after data_before=$data_before data_after=$data_after state_before=$state_before state_after=$state_after incoming=$incoming_bytes"
  assert_capacity_ready "$incoming_bytes"
  status 'PASS prepare-capacity control-state=ready workload-pool=ready parent-data=healthy root-os=healthy-or-warning'
}

verify_k3s_mount_dependencies() {
  local mounts
  mounts=$(timeout 15 systemctl show k3s.service -p RequiresMountsFor --value 2>/dev/null) || return 1
  printf '%s\n' "$mounts" | /opt/combo-dev/bin/combo-dev-production-safety \
    validate-mount-dependencies --input /dev/stdin --data-mount "$DATA_MOUNT" --storage-pool "$STORAGE_POOL" \
    >/dev/null 2>&1
}

can_i_exact() {
  local expected=$1 verb=$2 resource=$3 namespace=${4:-} out rc
  local args=(auth can-i "$verb" "$resource")
  [[ -z "$namespace" ]] || args+=(-n "$namespace")
  set +e
  out=$("${K[@]}" "${args[@]}" 2>/dev/null)
  rc=$?
  set -e
  if [[ "$expected" == yes ]]; then
    [[ $rc == 0 && "$out" == yes ]] || blocked '重置凭据缺少预期权限。'
  else
    [[ $rc == 1 && "$out" == no* ]] || blocked '重置凭据拥有禁止权限或权限探针失败。'
  fi
}

fence_jobs_quick() {
  local failed=0 name
  for name in minio-init migrate combo-dev-network-canary; do
    "${K[@]}" -n "$NAMESPACE" delete "job/$name" --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
    "${K[@]}" -n "$NAMESPACE" delete pods -l "job-name=$name" --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
  done
  return "$failed"
}

resource_exists() {
  local kind=$1 name=$2 out
  out=$("${K[@]}" -n "$NAMESPACE" get "$kind/$name" --ignore-not-found -o name 2>/dev/null) || return 2
  [[ -z "$out" ]] && return 1
  [[ ${out##*/} == "$name" && "$out" != *$'\n'* ]] || return 2
}

apply_app_replicas() {
  local name=$1 replicas=$2
  cat <<EOF | "${K[@]}" apply --server-side --field-manager=combo-dev-replicas --force-conflicts -f - >/dev/null 2>&1
apiVersion: apps/v1
kind: Deployment
metadata:
  name: $name
  namespace: $NAMESPACE
spec:
  replicas: $replicas
EOF
}

write_writers_fence() {
  local value=$1 candidate
  install -d -o root -g root -m 0711 /var/lib/combo-dev
  candidate=$(mktemp /var/lib/combo-dev/.writers-fenced.XXXXXX) || return 1
  if ! printf '%s\n' "$value" >"$candidate" ||
    ! chown root:root "$candidate" || ! chmod 0600 "$candidate" ||
    ! mv -Tf -- "$candidate" "$FAILURE_FENCE_MARKER"; then
    rm -f -- "$candidate"
    return 1
  fi
}

mark_failure_fence() {
  write_writers_fence "$FAILURE_FENCE_VALUE"
}

writers_fence_has_value() {
  local expected=$1 expected_bytes
  expected_bytes=$((${#expected} + 1))
  [[ -f "$FAILURE_FENCE_MARKER" && ! -L "$FAILURE_FENCE_MARKER" ]] || return 1
  [[ $(stat -c '%u:%g:%a:%s' "$FAILURE_FENCE_MARKER" 2>/dev/null) == \
    "0:0:600:$expected_bytes" ]] || return 1
  [[ $(<"$FAILURE_FENCE_MARKER") == "$expected" ]]
}

mark_safe_idle_fence() {
  writers_fence_has_value "$FAILURE_FENCE_VALUE" || return 1
  write_writers_fence "$SAFE_IDLE_FENCE_VALUE"
}

forwarders_stopped() {
  local unit active
  for unit in combo-dev-web-forward.service combo-dev-s3-forward.service; do
    active=$(timeout 10 systemctl is-active "$unit" 2>/dev/null || true)
    [[ "$active" == inactive || "$active" == failed ]] || return 1
  done
}

stop_forwarders() {
  rm -rf -- /run/combo-dev-forwarders
  timeout 30 systemctl stop combo-dev-web-forward.service combo-dev-s3-forward.service >/dev/null 2>&1 || true
  forwarders_stopped
}

exact_private_marker() {
  [[ -f "$1" && ! -L "$1" && $(stat -c '%u:%g:%a' "$1" 2>/dev/null) == '0:0:600' ]]
}

exact_private_marker_value() {
  local path=$1 expected=$2 expected_bytes
  expected_bytes=$((${#expected} + 1))
  [[ -f "$path" && ! -L "$path" &&
    $(stat -c '%u:%g:%a:%s' "$path" 2>/dev/null) == "0:0:600:$expected_bytes" &&
    $(<"$path") == "$expected" ]]
}

remove_all_reset_proofs() {
  local inventory remaining path name invalid=0 failed=0
  [[ -n "$WORK" && -d "$WORK" && ! -L "$WORK" ]] || return 1
  inventory=$(mktemp "$WORK/reset-proof-inventory.XXXXXX") || return 1
  remaining=$(mktemp "$WORK/reset-proof-remaining.XXXXXX") || {
    rm -f -- "$inventory"
    return 1
  }
  chmod 0600 "$inventory" "$remaining" || {
    rm -f -- "$inventory" "$remaining"
    return 1
  }
  if ! find "$RESET_PROOF_ROOT" -mindepth 1 -maxdepth 1 -name 'reset-proof*' -print0 >"$inventory"; then
    rm -f -- "$inventory" "$remaining"
    return 1
  fi
  while IFS= read -r -d '' path; do
    name=${path##*/}
    [[ "${path%/*}" == "$RESET_PROOF_ROOT" ]] || invalid=1
    [[ "$name" =~ ^reset-proof\.[0-9a-f]{40}\.[1-9][0-9]*\.[1-9][0-9]*(\.consumed)?\.json$ ]] || invalid=1
    [[ -f "$path" && ! -L "$path" ]] || invalid=1
    [[ $(stat -c '%u:%g:%a:%h' "$path" 2>/dev/null) == '0:0:600:1' ]] || invalid=1
  done <"$inventory"
  if (( invalid != 0 )); then
    rm -f -- "$inventory" "$remaining"
    return 1
  fi
  while IFS= read -r -d '' path; do
    rm -f -- "$path" || failed=1
  done <"$inventory"
  find "$RESET_PROOF_ROOT" -mindepth 1 -maxdepth 1 -name 'reset-proof*' -print0 >"$remaining" || failed=1
  [[ ! -s "$remaining" ]] || failed=1
  rm -f -- "$inventory" "$remaining" || failed=1
  return "$failed"
}

write_private_attempt_marker() {
  local path=$1 value=$2 candidate
  [[ "$path" == "$EXTERNAL_FENCE_MARKER" || "$path" == "$ACCEPTANCE_PENDING_MARKER" ]] ||
    return 1
  candidate=$(mktemp /var/lib/combo-dev/.attempt-marker.XXXXXX) || return 1
  if ! printf '%s\n' "$value" >"$candidate" ||
    ! chown root:root "$candidate" || ! chmod 0600 "$candidate" ||
    ! mv -Tf -- "$candidate" "$path"; then
    rm -f -- "$candidate"
    return 1
  fi
}

pending_marker_matches_attempt() {
  local revision=$1 run_id=$2 run_attempt=$3 value deadline
  [[ -f "$ACCEPTANCE_PENDING_MARKER" && ! -L "$ACCEPTANCE_PENDING_MARKER" ]] || return 1
  value=$(<"$ACCEPTANCE_PENDING_MARKER") || return 1
  exact_private_marker_value "$ACCEPTANCE_PENDING_MARKER" "$value" || return 1
  [[ "$value" =~ ^([0-9a-f]{40})\ ([1-9][0-9]*)\ ([1-9][0-9]*)\ ([1-9][0-9]*)$ ]] ||
    return 1
  [[ ${BASH_REMATCH[1]} == "$revision" && ${BASH_REMATCH[2]} == "$run_id" &&
    ${BASH_REMATCH[3]} == "$run_attempt" ]] || return 1
  deadline=${BASH_REMATCH[4]}
  [[ "$deadline" =~ ^[1-9][0-9]*$ ]]
}

record_failed_attempt_capability() {
  local identity now deadline pending rc=0
  [[ "$ATTEMPT_REVISION" =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ "$ATTEMPT_RUN_ID" =~ ^[1-9][0-9]*$ &&
    "$ATTEMPT_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]] || return 1
  identity="attempt $ATTEMPT_REVISION $ATTEMPT_RUN_ID $ATTEMPT_RUN_ATTEMPT"
  now=$(date +%s 2>/dev/null) || return 1
  [[ "$now" =~ ^[1-9][0-9]*$ ]] || return 1
  deadline=$((now + ACCEPTANCE_PENDING_SECONDS))
  pending="$ATTEMPT_REVISION $ATTEMPT_RUN_ID $ATTEMPT_RUN_ATTEMPT $deadline"
  exec 8>"$FENCE_LOCK_FILE"
  flock -w 300 8 || rc=1
  if (( rc == 0 )); then
    writers_fence_has_value "$FAILURE_FENCE_VALUE" || rc=1
  fi
  if (( rc == 0 )) &&
    [[ -e "$ACCEPTANCE_PENDING_MARKER" || -L "$ACCEPTANCE_PENDING_MARKER" ]]; then
    pending_marker_matches_attempt \
      "$ATTEMPT_REVISION" "$ATTEMPT_RUN_ID" "$ATTEMPT_RUN_ATTEMPT" || rc=1
  elif (( rc == 0 )); then
    write_private_attempt_marker "$ACCEPTANCE_PENDING_MARKER" "$pending" || rc=1
  fi
  if (( rc == 0 )) &&
    [[ -e "$EXTERNAL_FENCE_MARKER" || -L "$EXTERNAL_FENCE_MARKER" ]]; then
    exact_private_marker_value "$EXTERNAL_FENCE_MARKER" "$identity" || rc=1
  elif (( rc == 0 )); then
    write_private_attempt_marker "$EXTERNAL_FENCE_MARKER" "$identity" || rc=1
  fi
  flock -u 8 >/dev/null 2>&1 || rc=1
  exec 8>&-
  return "$rc"
}

recoverable_attempt_fence() {
  local current_revision=$1 current_run_id=$2 current_run_attempt=$3
  local external pending old_revision old_run_id old_run_attempt deadline
  exact_private_marker "$EXTERNAL_FENCE_MARKER" || return 1
  exact_private_marker "$ACCEPTANCE_PENDING_MARKER" || return 1
  external=$(<"$EXTERNAL_FENCE_MARKER") || return 1
  pending=$(<"$ACCEPTANCE_PENDING_MARKER") || return 1
  exact_private_marker_value "$EXTERNAL_FENCE_MARKER" "$external" || return 1
  exact_private_marker_value "$ACCEPTANCE_PENDING_MARKER" "$pending" || return 1
  [[ "$external" =~ ^attempt\ ([0-9a-f]{40})\ ([1-9][0-9]*)\ ([1-9][0-9]*)$ ]] || return 1
  old_revision=${BASH_REMATCH[1]}
  old_run_id=${BASH_REMATCH[2]}
  old_run_attempt=${BASH_REMATCH[3]}
  [[ "$pending" =~ ^([0-9a-f]{40})\ ([1-9][0-9]*)\ ([1-9][0-9]*)\ ([1-9][0-9]*)$ ]] || return 1
  [[ ${BASH_REMATCH[1]} == "$old_revision" && ${BASH_REMATCH[2]} == "$old_run_id" &&
    ${BASH_REMATCH[3]} == "$old_run_attempt" ]] || return 1
  deadline=${BASH_REMATCH[4]}
  [[ "$deadline" =~ ^[1-9][0-9]*$ ]] || return 1
  [[ "$old_revision $old_run_id $old_run_attempt" != \
    "$current_revision $current_run_id $current_run_attempt" ]] || return 1
  RECOVERY_REVISION=$old_revision
  RECOVERY_RUN_ID=$old_run_id
  RECOVERY_RUN_ATTEMPT=$old_run_attempt
}

verify_complete_writer_inventory_zero() {
  local snapshot="$WORK/writer-inventory.$RANDOM.json" rc=0
  if ! timeout 20 "${K[@]}" -n "$NAMESPACE" get \
    deployments.apps,statefulsets.apps,daemonsets.apps,replicasets.apps,replicationcontrollers,horizontalpodautoscalers.autoscaling,jobs.batch,cronjobs.batch,pods \
    -o json >"$snapshot" 2>/dev/null; then
    rm -f -- "$snapshot"
    return 1
  fi
  chmod 0600 "$snapshot" || { rm -f -- "$snapshot"; return 1; }
  jq -e '
    all(.items[];
      if .kind == "Deployment" or .kind == "StatefulSet"
          or .kind == "ReplicaSet" or .kind == "ReplicationController" then
        (.spec.replicas // 1) == 0
        and (.status.replicas // 0) == 0
        and (.status.readyReplicas // 0) == 0
        and (.status.availableReplicas // 0) == 0
      elif .kind == "Pod" then
        (.status.phase == "Succeeded" or .status.phase == "Failed")
        and all((.status.containerStatuses // [])[]; .state.running == null)
      else
        false
      end
    )
  ' "$snapshot" >/dev/null 2>&1 || rc=1
  rm -f -- "$snapshot"
  return "$rc"
}

begin_reset_mutation_fence() {
  local current_revision=$1 current_run_id=$2 current_run_attempt=$3
  local rc=0 recovery=0
  RECOVERED_FROM_ATTEMPT=''
  RECOVERY_REVISION=''
  RECOVERY_RUN_ID=''
  RECOVERY_RUN_ATTEMPT=''
  if [[ -e "$EXTERNAL_FENCE_MARKER" || -L "$EXTERNAL_FENCE_MARKER" ||
    -e "$ACCEPTANCE_PENDING_MARKER" || -L "$ACCEPTANCE_PENDING_MARKER" ]]; then
    writers_fence_has_value "$FAILURE_FENCE_VALUE" || return 1
    recoverable_attempt_fence "$current_revision" "$current_run_id" "$current_run_attempt" || return 1
    forwarders_stopped || return 1
    verify_complete_writer_inventory_zero || return 1
    recovery=1
  fi
  exec 8>"$FENCE_LOCK_FILE"
  flock -w 300 8 || rc=1
  if (( rc == 0 )); then
    if (( recovery == 1 )); then
      writers_fence_has_value "$FAILURE_FENCE_VALUE" || rc=1
      recoverable_attempt_fence "$current_revision" "$current_run_id" "$current_run_attempt" || rc=1
      forwarders_stopped || rc=1
      verify_complete_writer_inventory_zero || rc=1
    else
      if [[ -e "$FAILURE_FENCE_MARKER" || -L "$FAILURE_FENCE_MARKER" ]]; then
        writers_fence_has_value "$SAFE_IDLE_FENCE_VALUE" || rc=1
      fi
      [[ ! -e "$EXTERNAL_FENCE_MARKER" && ! -L "$EXTERNAL_FENCE_MARKER" &&
        ! -e "$ACCEPTANCE_PENDING_MARKER" && ! -L "$ACCEPTANCE_PENDING_MARKER" ]] || rc=1
    fi
  fi
  if (( rc == 0 )); then
    # Make the EXIT/TERM trap responsible before replacing an absent or safe
    # capability. An interruption from here cannot escape failure fencing.
    MUTATING=1
    mark_failure_fence || rc=1
  fi
  if (( rc == 0 && recovery == 1 )); then
    RECOVERED_FROM_ATTEMPT="$RECOVERY_REVISION $RECOVERY_RUN_ID $RECOVERY_RUN_ATTEMPT"
    rm -f -- "$EXTERNAL_FENCE_MARKER" || rc=1
    rm -f -- "$ACCEPTANCE_PENDING_MARKER" || rc=1
  fi
  flock -u 8 >/dev/null 2>&1 || rc=1
  exec 8>&-
  return "$rc"
}

finish_reset_safe_idle_fence() {
  local rc=0
  # The operation lock is still held and the generic marker prevents every
  # forwarder lease, so these potentially slow Kubernetes checks are stable
  # without holding the short failure-fence lock.
  forwarders_stopped || return 1
  verify_all_writers_zero || return 1
  verify_complete_writer_inventory_zero || return 1
  exec 8>"$FENCE_LOCK_FILE"
  flock -w 300 8 || rc=1
  if (( rc == 0 )); then
    writers_fence_has_value "$FAILURE_FENCE_VALUE" || rc=1
    [[ ! -e "$EXTERNAL_FENCE_MARKER" && ! -L "$EXTERNAL_FENCE_MARKER" &&
      ! -e "$ACCEPTANCE_PENDING_MARKER" && ! -L "$ACCEPTANCE_PENDING_MARKER" ]] || rc=1
  fi
  if (( rc == 0 )); then mark_safe_idle_fence || rc=1; fi
  flock -u 8 >/dev/null 2>&1 || rc=1
  exec 8>&-
  return "$rc"
}

apply_foundation_replicas() {
  local kind=$1 name=$2 replicas=$3 api_kind
  case "$kind" in deployment) api_kind=Deployment ;; statefulset) api_kind=StatefulSet ;; *) return 2 ;; esac
  cat <<EOF | "${K[@]}" apply --server-side --field-manager=combo-dev-failure-fence --force-conflicts -f - >/dev/null 2>&1
apiVersion: apps/v1
kind: $api_kind
metadata:
  name: $name
  namespace: $NAMESPACE
spec:
  replicas: $replicas
EOF
}

controller_scaled_zero() {
  local kind=$1 name=$2 desired current rc
  if resource_exists "$kind" "$name"; then
    timeout 180 "${K[@]}" --request-timeout=0 -n "$NAMESPACE" rollout status "$kind/$name" --timeout=170s >/dev/null 2>&1 || return 1
    desired=$("${K[@]}" -n "$NAMESPACE" get "$kind/$name" -o jsonpath='{.spec.replicas}' 2>/dev/null) || return 1
    current=$("${K[@]}" -n "$NAMESPACE" get "$kind/$name" -o jsonpath='{.status.replicas}' 2>/dev/null) || return 1
    [[ "$desired" == 0 && ( -z "$current" || "$current" == 0 ) ]]
  else
    rc=$?; (( rc == 1 ))
  fi
}

verify_all_writers_zero() {
  local name rc pods
  for name in "${APPS[@]}" redis-hot; do controller_scaled_zero deployment "$name" || return 1; done
  for name in "${FOUNDATION_STATEFUL[@]}"; do controller_scaled_zero statefulset "$name" || return 1; done
  for name in minio-init migrate combo-dev-network-canary; do
    if resource_exists job "$name"; then return 1; else rc=$?; (( rc == 1 )) || return 1; fi
    pods=$("${K[@]}" -n "$NAMESPACE" get pods -l "job-name=$name" -o name 2>/dev/null) || return 1
    [[ -z "$pods" ]] || return 1
  done
}

fence_all_writers() {
  local failed=0 name rc pods
  fence_jobs_quick || failed=1
  for name in "${APPS[@]}"; do
    if resource_exists deployment "$name"; then apply_app_replicas "$name" 0 || failed=1; else rc=$?; (( rc == 1 )) || failed=1; fi
  done
  if resource_exists deployment redis-hot; then apply_foundation_replicas deployment redis-hot 0 || failed=1; else rc=$?; (( rc == 1 )) || failed=1; fi
  for name in "${FOUNDATION_STATEFUL[@]}"; do
    if resource_exists statefulset "$name"; then apply_foundation_replicas statefulset "$name" 0 || failed=1; else rc=$?; (( rc == 1 )) || failed=1; fi
  done
  for name in "${APPS[@]}"; do controller_scaled_zero deployment "$name" || failed=1; done
  controller_scaled_zero deployment redis-hot || failed=1
  for name in "${FOUNDATION_STATEFUL[@]}"; do controller_scaled_zero statefulset "$name" || failed=1; done
  for name in minio-init migrate combo-dev-network-canary; do
    pods=$("${K[@]}" -n "$NAMESPACE" get pods -l "job-name=$name" -o name 2>/dev/null) || { failed=1; continue; }
    [[ -z "$pods" ]] || failed=1
  done
  return "$failed"
}

dispatcher_certificate_valid_for() {
  local minimum_seconds=$1 certificate rc
  certificate=$(mktemp "$WORK/dispatcher-cert.XXXXXX") || return 1
  if ! kubectl --kubeconfig "$KUBECONFIG_PATH" config view --raw --flatten --minify \
      -o jsonpath='{.users[0].user.client-certificate-data}' 2>/dev/null | base64 -d >"$certificate" 2>/dev/null; then
    rm -f -- "$certificate"
    return 1
  fi
  chmod 600 "$certificate"
  set +e
  openssl x509 -in "$certificate" -noout -checkend "$minimum_seconds" >/dev/null 2>&1
  rc=$?
  set -e
  rm -f -- "$certificate"
  return "$rc"
}

production_fingerprint() {
  local raw="$WORK/prod.$RANDOM.json" canonical="$WORK/prod.$RANDOM.canonical"
  "${PK[@]}" -n "$PRODUCTION_NAMESPACE" get deployments.apps,statefulsets.apps,services,persistentvolumeclaims,pods -o json >"$raw" 2>/dev/null || blocked '生产指纹读取失败。'
  python3 /opt/combo-dev/bin/combo-dev-production-safety canonicalize-production \
    --input "$raw" --output "$canonical" >/dev/null 2>&1 || blocked '生产指纹规范化失败。'
  sha256sum "$canonical" | awk '{print $1}'
}

preflight() {
  [[ $(id -u) -eq 0 ]] || blocked 'reset 必须由受限 sudo 规则以 root 启动。'
  local cmd
  for cmd in kubectl jq python3 openssl base64 sha256sum flock findmnt systemctl timeout stat dirname readlink df awk install find chown chmod rm mv mktemp date losetup blockdev blkid; do command -v "$cmd" >/dev/null 2>&1 || blocked "缺少主机工具：$cmd"; done
  root_owned_not_writable /opt/combo-dev/bin || blocked '调度器目录可被非 root 修改。'
  if ! root_owned_not_writable /opt/combo-dev/bin/combo-dev-production-safety || [[ ! -x /opt/combo-dev/bin/combo-dev-production-safety ]]; then
    blocked '共享生产安全检查器不可用。'
  fi
  root_owned_not_writable /var/lib/combo-dev || blocked '持久失败收敛目录可被非 root 修改。'
  root_owned_not_writable "${BASH_SOURCE[0]}" || blocked '当前 reset 调度器可被非 root 修改。'
  if ! private_file "$KUBECONFIG_PATH" || ! private_file "$PRODUCTION_KUBECONFIG"; then blocked '缺少 owner-only 的调度或生产只读凭据。'; fi
  private_file "$CLUSTER_PLATFORM_CONTRACT" || blocked '规范化集群平台契约不是 owner-only 文件。'
  [[ -d "$BOOTSTRAP_FOUNDATION" ]] || blocked '没有 bootstrap 审核快照可用于重建。'
  FOUNDATION=$BOOTSTRAP_FOUNDATION
  trusted_foundation_tree "$FOUNDATION" || blocked '基础清单可被非 root 修改。'
  [[ $(cat /etc/combo-dev/preview-takeover.approved 2>/dev/null || true) == 'combo-preview=canonical-and-disposable' ]] || blocked 'preview 数据未获可丢弃批准。'
  findmnt -rn -M "$DATA_MOUNT" >/dev/null 2>&1 || blocked '固定数据盘没有挂载。'
  verify_k3s_mount_dependencies || blocked 'k3s 必须只依赖生产父数据盘，不能依赖开发挂载或其任何子路径。'
  /opt/combo-dev/bin/combo-dev-storage-guard --check-only >/dev/null 2>&1 || blocked '独立挂载、静态卷路径、标记、所有权或安全水位不符合固定契约。'
  timeout 180 systemctl start combo-dev-storage-guard.service >/dev/null 2>&1 || blocked '持续守卫无法证明两套凭据与失败收敛路径健康。'
  storage_guard_timer_ready || blocked '持续存储守卫未启用、未激活或没有下一次检查。'
  can_i_exact yes get persistentvolumes/combo-dev-postgres
  can_i_exact yes get persistentvolumes/combo-dev-redis-queue
  can_i_exact yes get persistentvolumes/combo-dev-minio
  can_i_exact yes list namespaces
  can_i_exact yes list roles.rbac.authorization.k8s.io "$NAMESPACE"
  can_i_exact yes list rolebindings.rbac.authorization.k8s.io "$NAMESPACE"
  can_i_exact yes list deployments.apps "$NAMESPACE"
  can_i_exact yes list statefulsets.apps "$NAMESPACE"
  can_i_exact yes list daemonsets.apps "$NAMESPACE"
  can_i_exact yes list replicasets.apps "$NAMESPACE"
  can_i_exact yes list replicationcontrollers "$NAMESPACE"
  can_i_exact yes list jobs.batch "$NAMESPACE"
  can_i_exact yes list cronjobs.batch "$NAMESPACE"
  can_i_exact yes list horizontalpodautoscalers.autoscaling "$NAMESPACE"
  can_i_exact yes delete daemonsets.apps "$NAMESPACE"
  can_i_exact yes delete replicasets.apps "$NAMESPACE"
  can_i_exact yes delete replicationcontrollers "$NAMESPACE"
  can_i_exact yes delete cronjobs.batch "$NAMESPACE"
  can_i_exact yes delete horizontalpodautoscalers.autoscaling "$NAMESPACE"
  can_i_exact yes list pods "$NAMESPACE"
  can_i_exact yes list clusterroles.rbac.authorization.k8s.io
  can_i_exact yes list clusterrolebindings.rbac.authorization.k8s.io
  can_i_exact no delete persistentvolumeclaims/data-postgres-0 "$NAMESPACE"
  can_i_exact no patch deployments.apps "$PRODUCTION_NAMESPACE"
  can_i_exact no get secrets "$NAMESPACE"
  can_i_exact no list secrets "$NAMESPACE"
  can_i_exact no delete secrets/combo-dev-env "$NAMESPACE"
  can_i_exact no patch secrets/combo-dev-env "$NAMESPACE"
  dispatcher_certificate_valid_for "$DISPATCHER_FENCE_BEFORE_SECONDS" || blocked '调度证书已进入预到期失败收敛窗口，必须重新 bootstrap。'
  python3 /opt/combo-dev/bin/combo-dev-production-safety verify-observer \
    --audit-kubeconfig "$KUBECONFIG_PATH" \
    --observer-kubeconfig "$PRODUCTION_KUBECONFIG" \
    --production-namespace "$PRODUCTION_NAMESPACE" \
    --work-dir "$WORK/observer-audit" >/dev/null 2>&1 || blocked '生产观察身份不符合精确只读边界。'
  validate_static_storage_live
  "${K[@]}" apply --server-side --dry-run=server --field-manager=combo-dev-dispatcher --force-conflicts -k "$FOUNDATION" >/dev/null 2>&1 || blocked '基础清单未通过清空数据前服务端校验。'
}

validate_static_storage_live() {
  local live="$WORK/cluster-platform.live.json" parts="$WORK/cluster-platform.live.parts" pvc="$WORK/static-pvc.json" resource
  : >"$parts"
  for resource in \
    "namespace/$NAMESPACE" \
    clusterrole/combo-dev-control-auditor \
    clusterrolebinding/combo-dev-control-auditor \
    "storageclass/$STORAGE_CLASS" \
    persistentvolume/combo-dev-postgres \
    persistentvolume/combo-dev-redis-queue \
    persistentvolume/combo-dev-minio; do
    "${K[@]}" get "$resource" -o json >>"$parts" 2>/dev/null || blocked '集群级平台对象不可读。'
  done
  jq -s '{apiVersion:"v1",kind:"List",items:.}' "$parts" >"$live" 2>/dev/null || blocked '集群级平台对象无法聚合。'
  chmod 0600 "$live"
  /opt/combo-dev/bin/combo-dev-production-safety compare-platform \
    --expected "$CLUSTER_PLATFORM_CONTRACT" --live "$live" >/dev/null 2>&1 ||
    blocked 'Namespace、ClusterRole、ClusterRoleBinding、StorageClass 或静态 PV 发生漂移。'
  jq -s -e 'all(.[]; if .kind == "PersistentVolume" then .status.phase == "Bound" and (.metadata.deletionTimestamp == null) else true end)' \
    "$parts" >/dev/null 2>&1 || blocked '静态 PV 没有保持绑定终态。'
  "${K[@]}" -n "$NAMESPACE" get persistentvolumeclaims -o json >"$pvc" 2>/dev/null || blocked '静态 PVC 清单不可读。'
  jq -e '
    def expected: {
      "data-postgres-0": {volume:"combo-dev-postgres", size:"8Gi"},
      "data-redis-queue-0": {volume:"combo-dev-redis-queue", size:"2Gi"},
      "data-minio-0": {volume:"combo-dev-minio", size:"6Gi"}
    };
    ([.items[].metadata.name] | sort) == ([expected | keys[]] | sort)
    and all(.items[];
      .metadata.name as $name | expected[$name] as $want |
      .metadata.deletionTimestamp == null
      and .status.phase == "Bound"
      and .spec.accessModes == ["ReadWriteOnce"]
      and (.spec.volumeMode // "Filesystem") == "Filesystem"
      and .spec.storageClassName == "combo-dev-bounded"
      and .spec.volumeName == $want.volume
      and .spec.resources.requests.storage == $want.size
      and all((.metadata.annotations // {}) | keys[]; contains("storage-provisioner") | not)
    )
  ' "$pvc" >/dev/null 2>&1 || blocked '静态 PVC 清单、预绑定或终态发生漂移。'
}

stop_and_delete_inventory() {
  local failed=0 resource
  timeout 30 systemctl stop combo-dev-web-forward.service >/dev/null 2>&1 || failed=1
  timeout 30 systemctl stop combo-dev-s3-forward.service >/dev/null 2>&1 || failed=1
  fence_all_writers || failed=1
  for resource in \
    horizontalpodautoscalers.autoscaling cronjobs.batch daemonsets.apps jobs.batch \
    deployments.apps statefulsets.apps replicationcontrollers replicasets.apps pods; do
    "${K[@]}" -n "$NAMESPACE" delete "$resource" --all --ignore-not-found \
      --wait=true --timeout=180s >/dev/null 2>&1 || failed=1
  done
  (( failed == 0 )) || return 1
  verify_complete_writer_inventory_zero
}

wipe_static_volume_data() {
  local key path uid gid target canonical
  /opt/combo-dev/bin/combo-dev-storage-guard --check-only >/dev/null 2>&1 || blocked '清空前静态卷主机契约失效。'
  validate_static_storage_live
  for key in postgres redis-queue minio; do
    case "$key" in
      postgres) path=$POSTGRES_STORAGE_PATH; uid=70; gid=70 ;;
      redis-queue) path=$REDIS_QUEUE_STORAGE_PATH; uid=999; gid=1000 ;;
      minio) path=$MINIO_STORAGE_PATH; uid=1000; gid=1000 ;;
    esac
    canonical=$(readlink -f -- "$path" 2>/dev/null) || blocked '静态卷路径不可解析。'
    [[ "$canonical" == "$path" ]] || blocked '静态卷路径不是固定规范路径。'
    target=$(findmnt -rn -T "$path" -o TARGET 2>/dev/null) || blocked '静态卷路径没有位于独立挂载。'
    [[ "$target" == "$STORAGE_POOL" ]] || blocked '静态卷路径回退到了独立挂载之外。'
    find "$path" -xdev -mindepth 1 -depth -delete >/dev/null 2>&1 || blocked '静态卷数据无法完整清空。'
    chown "$uid:$gid" "$path" || blocked '静态卷根目录所有权无法恢复。'
    chmod 0700 "$path" || blocked '静态卷根目录权限无法恢复。'
  done
  /opt/combo-dev/bin/combo-dev-storage-guard --check-only >/dev/null 2>&1 || blocked '清空后静态卷路径、标记或所有权失效。'
}

recreate_foundation() {
  "${K[@]}" apply --server-side --field-manager=combo-dev-dispatcher --force-conflicts -k "$FOUNDATION" >/dev/null 2>&1 || blocked '空数据基础服务无法重建。'
  local name
  for name in postgres redis-queue minio; do
    timeout 360 "${K[@]}" --request-timeout=0 -n "$NAMESPACE" rollout status "statefulset/$name" --timeout=350s >/dev/null 2>&1 || blocked '重建后的有状态服务未就绪。'
  done
  timeout 240 "${K[@]}" --request-timeout=0 -n "$NAMESPACE" rollout status deployment/redis-hot --timeout=230s >/dev/null 2>&1 || blocked '重建后的热 Redis 未就绪。'
}

assert_static_volume_data_empty() {
  local path found
  for path in "$POSTGRES_STORAGE_PATH" "$REDIS_QUEUE_STORAGE_PATH" "$MINIO_STORAGE_PATH"; do
    [[ -d "$path" && ! -L "$path" ]] || return 1
    found=$(find "$path" -xdev -mindepth 1 -print -quit 2>/dev/null) || return 1
    [[ -z "$found" ]] || return 1
  done
}

capture_rebuilt_foundation() {
  local reset_started=$1 output=$2 pods="$WORK/reset-foundation.pods.json"
  "${K[@]}" -n "$NAMESPACE" get pods -l combo.dev/environment=combo-dev -o json >"$pods" 2>/dev/null ||
    return 1
  python3 - "$pods" "$reset_started" "$output" <<'PY'
import datetime as dt
import json
import re
import sys

pods_path, reset_started_raw, output_path = sys.argv[1:]
expected = {'postgres', 'redis-queue', 'redis-hot', 'minio'}

def timestamp(value):
    if not isinstance(value, str):
        raise SystemExit(2)
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        raise SystemExit(2)
    if parsed.tzinfo is None:
        raise SystemExit(2)
    return parsed.astimezone(dt.timezone.utc)

reset_started = timestamp(reset_started_raw)
with open(pods_path, encoding='utf-8') as handle:
    payload = json.load(handle)

foundation = []
seen = set()
for pod in payload.get('items', []):
    metadata = pod.get('metadata', {})
    labels = metadata.get('labels', {})
    plane = labels.get('app')
    if plane not in expected or metadata.get('deletionTimestamp') is not None:
        continue
    if plane in seen:
        raise SystemExit(2)
    seen.add(plane)
    if metadata.get('namespace') != 'combo-preview':
        raise SystemExit(2)
    uid = metadata.get('uid')
    created_at = metadata.get('creationTimestamp')
    started_at = pod.get('status', {}).get('startTime')
    statuses = pod.get('status', {}).get('containerStatuses', [])
    if (
        not isinstance(uid, str)
        or not re.fullmatch(
            r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
            uid,
        )
        or timestamp(created_at) < reset_started
        or timestamp(started_at) < reset_started
        or pod.get('status', {}).get('phase') != 'Running'
        or not statuses
        or not all(status.get('ready') is True for status in statuses)
    ):
        raise SystemExit(2)
    foundation.append({
        'plane': plane,
        'podUid': uid,
        'createdAt': created_at,
        'startedAt': started_at,
        'ready': True,
    })

if seen != expected:
    raise SystemExit(2)
with open(output_path, 'w', encoding='utf-8') as handle:
    json.dump(sorted(foundation, key=lambda item: item['plane']), handle, separators=(',', ':'))
    handle.write('\n')
PY
  chmod 0600 "$output"
}

write_reset_proof() {
  local revision=$1 workflow_run_id=$2 workflow_run_attempt=$3
  local reset_started=$4 storage_cleared_at=$5 foundation=$6
  local candidate="$WORK/reset-proof.json"
  python3 - \
    "$revision" "$workflow_run_id" "$workflow_run_attempt" \
    "$reset_started" "$storage_cleared_at" \
    "$foundation" "$candidate" <<'PY'
import datetime as dt
import json
import re
import sys

(
    revision, workflow_run_id, workflow_run_attempt,
    started_at, cleared_at, foundation_path, output_path,
) = sys.argv[1:]
if (
    not re.fullmatch(r'[0-9a-f]{40}', revision)
    or not re.fullmatch(r'[1-9][0-9]*', workflow_run_id)
    or not re.fullmatch(r'[1-9][0-9]*', workflow_run_attempt)
):
    raise SystemExit(2)
foundation = json.load(open(foundation_path, encoding='utf-8'))
payload = {
    'schemaVersion': 1,
    'namespace': 'combo-preview',
    'sourceSha': revision,
    'workflowRunId': workflow_run_id,
    'workflowRunAttempt': workflow_run_attempt,
    'startedAt': started_at,
    'storageClearedAt': cleared_at,
    'completedAt': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'storage': {
        'postgres': {'clearedBeforeRebuild': True},
        'redisQueue': {'clearedBeforeRebuild': True},
        'minio': {'clearedBeforeRebuild': True},
    },
    'foundation': foundation,
    'storageSmokePassed': True,
    'writersFenced': True,
    'productionFingerprintUnchanged': True,
}
with open(output_path, 'w', encoding='utf-8') as handle:
    json.dump(payload, handle, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    handle.write('\n')
PY
  install -o root -g root -m 0600 "$candidate" "$RESET_PROOF"
}

main() {
  local revision='' workflow_run_id='' workflow_run_attempt='' incoming_bytes='' confirmed=0 prepare=0 arg
  while (($#)); do
    arg=$1
    shift
    case "$arg" in
      --prepare-capacity) prepare=$((prepare + 1)) ;;
      --incoming-bytes) incoming_bytes=${1:?}; shift ;;
      "--confirm=$CONFIRMATION") confirmed=1 ;;
      --revision) revision=${1:?}; shift ;;
      --workflow-run-id) workflow_run_id=${1:?}; shift ;;
      --workflow-run-attempt) workflow_run_attempt=${1:?}; shift ;;
      *) blocked '未知 reset 参数。' ;;
    esac
  done
  (( prepare <= 1 )) || blocked '容量准备参数只能出现一次。'
  if (( prepare == 1 )); then
    if (( confirmed != 0 )) ||
      [[ -n "$revision" || -n "$workflow_run_id" || -n "$workflow_run_attempt" ]]; then
      blocked '容量准备模式不能与破坏性 reset 参数组合。'
    fi
    [[ "$incoming_bytes" =~ ^[1-9][0-9]*$ ]] || blocked '容量准备必须提供正整数 --incoming-bytes。'
    (( incoming_bytes <= ARCHIVE_MAX_BYTES )) || blocked '容量准备的 incoming 包不能超过 512 MiB。'
    exec 9>"$LOCK_FILE"
    flock -w 300 9 || blocked '另一个 combo-dev 操作长时间持有主机锁。'
    prepare_capacity "$incoming_bytes"
    SUCCESS=1
    return
  fi
  [[ -z "$incoming_bytes" ]] || blocked '--incoming-bytes 只能与 --prepare-capacity 一起使用。'
  (( confirmed == 1 )) || blocked '必须提供完全匹配的破坏性确认串。'
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || blocked 'reset revision 不是完整提交 SHA。'
  [[ "$workflow_run_id" =~ ^[1-9][0-9]*$ ]] || blocked 'reset workflow run ID 不合法。'
  [[ "$workflow_run_attempt" =~ ^[1-9][0-9]*$ ]] ||
    blocked 'reset workflow run attempt 不合法。'
  ATTEMPT_REVISION=$revision
  ATTEMPT_RUN_ID=$workflow_run_id
  ATTEMPT_RUN_ATTEMPT=$workflow_run_attempt
  RESET_PROOF="/var/lib/combo-dev/reset-proof.${revision}.${workflow_run_id}.${workflow_run_attempt}.json"
  exec 9>"$LOCK_FILE"
  flock -w 300 9 || blocked '另一个 combo-dev 操作长时间持有主机锁。'
  assert_capacity_ready
  WORK=$(mktemp -d "$CONTROL_WORK/reset.XXXXXX") || blocked '无法在 control-state 创建 reset 工作区。'
  preflight
  local before after reset_started storage_cleared_at foundation_proof="$WORK/reset-foundation.json"
  reset_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  before=$(production_fingerprint)
  begin_reset_mutation_fence "$revision" "$workflow_run_id" "$workflow_run_attempt" ||
    blocked 'Test 不是可安全重置的已部署、安全空闲或精确旧 attempt 阻断状态。'
  if [[ -n "$RECOVERED_FROM_ATTEMPT" ]]; then
    status "recoveredFromAttempt=$RECOVERED_FROM_ATTEMPT"
  fi
  remove_all_reset_proofs || blocked 'reset 无法清理旧 reset proof inventory。'
  stop_forwarders || blocked 'reset 前无法关闭并验证回环转发器。'
  stop_and_delete_inventory || blocked '固定工作负载未能全部停止并删除。'
  wipe_static_volume_data
  assert_static_volume_data_empty || blocked '三个 Test 数据目录未能证明在重建前为空。'
  storage_cleared_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  recreate_foundation
  timeout 180 /opt/combo-dev/bin/combo-dev-smoke --storage-only >/dev/null 2>&1 || blocked '重置后的固定 PVC 未通过静态路径与冷启动校验。'
  capture_rebuilt_foundation "$reset_started" "$foundation_proof" ||
    blocked '重建后的四个基础工作负载身份不可验证。'
  rm -f -- "$STORAGE_LOW_MARKER"
  fence_all_writers || blocked '重置后全部写入者未保持关闭。'
  after=$(production_fingerprint)
  [[ "$before" == "$after" ]] || fail '重置期间生产指纹发生变化。'
  remove_all_reset_proofs || blocked '写入新 reset proof 前 inventory 无法保持为空。'
  write_reset_proof \
    "$revision" "$workflow_run_id" "$workflow_run_attempt" \
    "$reset_started" "$storage_cleared_at" "$foundation_proof" ||
    blocked '无法保存本次空数据重建证据。'
  forwarders_stopped || blocked 'reset 后回环转发器没有保持关闭。'
  finish_reset_safe_idle_fence || blocked 'reset 无法提交安全空闲写入阻断状态。'
  SUCCESS=1
  status 'PASS namespace=combo-preview pvc=retained data=cleared writers=safe-idle'
}

main "$@"
