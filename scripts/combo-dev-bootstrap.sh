#!/usr/bin/env bash
# 主机所有者手工执行一次或重复执行；只建立 combo-preview 的最小调度边界，始终让应用保持关闭。
set -Eeuo pipefail
umask 077
export PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

readonly NAMESPACE='combo-preview'
readonly PRODUCTION_NAMESPACE='combo'
readonly DATA_MOUNT='/home/xingzheng/data'
readonly STORAGE_POOL='/home/xingzheng/data/combo-dev'
readonly STORAGE_SENTINEL='/home/xingzheng/data/combo-dev/.combo-dev-mounted'
readonly STORAGE_SENTINEL_STATE='combo-dev-storage-mount=v1'
readonly STORAGE_CLASS='combo-dev-bounded'
readonly POSTGRES_STORAGE_PATH='/home/xingzheng/data/combo-dev/postgres/data'
readonly REDIS_QUEUE_STORAGE_PATH='/home/xingzheng/data/combo-dev/redis-queue/data'
readonly MINIO_STORAGE_PATH='/home/xingzheng/data/combo-dev/minio/data'
readonly STATIC_PVS=(combo-dev-postgres combo-dev-redis-queue combo-dev-minio)
readonly STATIC_PVCS=(data-postgres-0 data-redis-queue-0 data-minio-0)
readonly STORAGE_MIN_BYTES=$((16 * 1024 * 1024 * 1024))
readonly STORAGE_MAX_BYTES=$((18 * 1024 * 1024 * 1024))
readonly ADMIN_KUBECONFIG_DEFAULT='/etc/rancher/k3s/k3s.yaml'
readonly K3S_DATA_DIR_FILE='/etc/combo-dev/k3s-data-dir'
readonly STORAGE_APPROVAL='/etc/combo-dev/storage-pool.approved'
readonly HOST_BOUNDARY_APPROVAL='/etc/combo-dev/host-network-boundary.approved'
readonly HOST_BOUNDARY_CHECK='/opt/combo-dev/host-boundary/check'
readonly DISPATCHER_KUBECONFIG='/etc/combo-dev/dispatcher.kubeconfig'
readonly FENCER_KUBECONFIG='/etc/combo-dev/fencer.kubeconfig'
readonly PRODUCTION_KUBECONFIG='/etc/combo-dev/production-observer.kubeconfig'
readonly CLUSTER_PLATFORM_CONTRACT='/etc/combo-dev/cluster-platform.canonical.json'
readonly CONFIG_FILE='/etc/combo-dev/combo-dev.env'
readonly REGISTRY_FILE='/etc/combo-dev/registry.json'
readonly LOCK_FILE='/run/lock/combo-dev.lock'
readonly FENCE_LOCK_FILE='/run/lock/combo-dev-fence.lock'
readonly INSTALL_ROOT='/opt/combo-dev'
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
readonly ROOT_WARNING_MIN_BYTES=$((20 * 1024 * 1024 * 1024))
readonly ROOT_CRITICAL_MIN_BYTES=$((10 * 1024 * 1024 * 1024))
readonly DATA_WARNING_MIN_BYTES=$((30 * 1024 * 1024 * 1024))
readonly DATA_CRITICAL_MIN_BYTES=$((20 * 1024 * 1024 * 1024))
readonly FAILURE_FENCE_MARKER='/var/lib/combo-dev/writers-fenced'
readonly FAILURE_FENCE_VALUE='combo-dev-writers=fenced'
readonly SAFE_IDLE_FENCE_VALUE='combo-dev-writers=safe-idle-v1'
readonly EXTERNAL_FENCE_MARKER='/var/lib/combo-dev/external-fence'
readonly ACCEPTANCE_PENDING_MARKER='/var/lib/combo-dev/acceptance-pending'
readonly RESET_PROOF_ROOT='/var/lib/combo-dev'
readonly ROOT_CRITICAL_MARKER='/var/lib/combo-dev/root-capacity-critical'
readonly DISPATCHER_RENEW_BEFORE_SECONDS=$((30 * 24 * 60 * 60))
readonly DISPATCHER_OPERATION_MIN_SECONDS=$((4 * 60 * 60))
readonly FENCER_RENEW_BEFORE_SECONDS=$((90 * 24 * 60 * 60))
readonly CONTROL_FILES=(
  scripts/combo-dev-bootstrap.sh
  scripts/combo-dev-deploy.sh
  scripts/combo-dev-smoke.sh
  scripts/combo-dev-logs.sh
  scripts/combo-dev-reset.sh
  scripts/combo-dev-forwarder-lease.sh
  scripts/combo-dev-storage-guard.sh
  scripts/combo-dev-production-safety.py
  infra/host/combo-dev/combo-dev-prepare-control-state.sh
  infra/host/combo-dev/combo-host-prepare-data-anchor.sh
  infra/host/combo-dev/combo-host-data-mount-check.sh
  infra/host/combo-dev/combo-dev-web-forward.service
  infra/host/combo-dev/combo-dev-s3-forward.service
  infra/host/combo-dev/combo-dev-storage-guard.service
  infra/host/combo-dev/combo-dev-storage-guard.timer
  'infra/host/combo-dev/var-lib-combo\x2dhost\x2ddata.mount'
  infra/host/combo-dev/combo-host-data-mount-check.service
  'infra/host/combo-dev/opt-combo\x2ddev-state.mount'
  'infra/host/combo-dev/opt-combo\x2ddev-incoming.mount'
  'infra/host/combo-dev/opt-combo\x2ddev-releases.mount'
  'infra/host/combo-dev/var-lib-combo\x2ddev-evidence.mount'
  infra/host/combo-dev/combo-host-syslog
  infra/k8s/overlays/combo-dev/kustomization.yaml
  infra/k8s/overlays/combo-dev/platform/kustomization.yaml
  infra/k8s/overlays/combo-dev/platform/limit-range.yaml
  infra/k8s/overlays/combo-dev/platform/namespace.yaml
  infra/k8s/overlays/combo-dev/platform/network-policies.yaml
  infra/k8s/overlays/combo-dev/platform/quota.yaml
  infra/k8s/overlays/combo-dev/platform/rbac.yaml
  infra/k8s/overlays/combo-dev/platform/storage-class.yaml
  infra/k8s/overlays/combo-dev/platform/storage-volumes.yaml
  infra/k8s/overlays/combo-dev/foundation/kustomization.yaml
  infra/k8s/overlays/combo-dev/foundation/postgres-entrypoint.sh
  infra/k8s/overlays/combo-dev/foundation/resources.yaml
  infra/k8s/overlays/combo-dev/init/kustomization.yaml
  infra/k8s/overlays/combo-dev/init/minio-app-policy.json
  infra/k8s/overlays/combo-dev/init/resources.yaml
  infra/k8s/overlays/combo-dev/migrate/kustomization.yaml
  infra/k8s/overlays/combo-dev/migrate/resources.yaml
  infra/k8s/overlays/combo-dev/apps/kustomization.yaml
  infra/k8s/overlays/combo-dev/apps/nginx-dev.conf
  infra/k8s/overlays/combo-dev/apps/resources.yaml
)

ROOT=''
ADMIN_KUBECONFIG=''
K3S_DATA_DIR=''
AK=()
WORK=''
NODE_HOSTNAME=''
MUTATING=0
SUCCESS=0

status() { printf '[combo-dev-bootstrap] %s\n' "$1"; }
fail() { printf '[combo-dev-bootstrap] FAIL: %s\n' "$1" >&2; exit 1; }
blocked() { printf '[combo-dev-bootstrap] BLOCKED: %s\n' "$1" >&2; exit 2; }
require_command() { command -v "$1" >/dev/null 2>&1 || blocked "缺少主机工具：$1"; }

storage_guard_timer_ready() {
  local next
  [[ $(timeout 10 systemctl is-enabled combo-dev-storage-guard.timer 2>/dev/null || true) == enabled ]] || return 1
  [[ $(timeout 10 systemctl is-active combo-dev-storage-guard.timer 2>/dev/null || true) == active ]] || return 1
  next=$(timeout 10 systemctl show combo-dev-storage-guard.timer -p NextElapseUSecMonotonic --value 2>/dev/null) || return 1
  [[ -n "$next" && "$next" != 0 && "$next" != infinity ]]
}
bootstrap_boundary() { local _boundary=$1; shift; "$@"; }

forwarders_stopped() {
  local unit active
  for unit in combo-dev-web-forward.service combo-dev-s3-forward.service; do
    active=$(timeout 10 systemctl is-active "$unit" 2>/dev/null || true)
    [[ "$active" == inactive || "$active" == failed ]] || return 1
  done
}

stop_forwarders() {
  rm -rf -- /run/combo-dev-forwarders
  # 首次 bootstrap 时这两个单元尚未安装；stop 的 not-found 可以忽略，但随后仍须验证没有活动监听者。
  timeout 30 systemctl stop combo-dev-web-forward.service combo-dev-s3-forward.service >/dev/null 2>&1 || true
  forwarders_stopped
}

cleanup() {
  local rc=$?
  set +e
  if (( MUTATING == 1 && SUCCESS == 0 )); then
    mark_failure_fence >/dev/null 2>&1 || true
    stop_forwarders >/dev/null 2>&1 || true
    if fence_all_writers_admin >/dev/null 2>&1 && forwarders_stopped >/dev/null 2>&1; then
      status '失败收敛已验证；全部写入者、任务与转发器保持关闭。'
    else
      status '失败收敛无法验证；阻断标记已保留并需要主机所有者介入。'
    fi
  fi
  [[ -z "$WORK" ]] || rm -rf --one-file-system -- "$WORK"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

private_directory() {
  local mode owner
  [[ -d "$1" && ! -L "$1" ]] || return 1
  mode=$(stat -c '%a' "$1" 2>/dev/null) || return 1
  owner=$(stat -c '%u' "$1" 2>/dev/null) || return 1
  [[ "$owner" == 0 && $((8#$mode & 8#022)) == 0 ]]
}

private_file() {
  local file=$1 mode owner
  [[ -f "$file" && ! -L "$file" ]] || return 1
  mode=$(stat -c '%a' "$file" 2>/dev/null) || return 1
  owner=$(stat -c '%u' "$file" 2>/dev/null) || return 1
  [[ "$owner" == 0 && ( "$mode" == 600 || "$mode" == 400 ) ]]
}

root_owned_not_writable() {
  local path=$1 mode owner
  [[ -e "$path" && ! -L "$path" ]] || return 1
  mode=$(stat -c '%a' "$path" 2>/dev/null) || return 1
  owner=$(stat -c '%u' "$path" 2>/dev/null) || return 1
  [[ "$owner" == 0 && "$mode" =~ ^[0-7]{3,4}$ && $((8#$mode & 8#022)) == 0 ]]
}

free_bytes() { df -PB1 "$1" 2>/dev/null | awk 'NR==2 {print $4}'; }

free_inodes() { df -Pi "$1" 2>/dev/null | awk 'NR==2 {print $4}'; }
total_bytes() { df -PB1 "$1" 2>/dev/null | awk 'NR==2 {print $2}'; }
total_inodes() { df -Pi "$1" 2>/dev/null | awk 'NR==2 {print $2}'; }

max_threshold() {
  local total=$1 absolute=$2 percent=$3 proportional
  proportional=$((total * percent / 100))
  if (( proportional > absolute )); then printf '%s\n' "$proportional"; else printf '%s\n' "$absolute"; fi
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
  for path in "$INSTALL_ROOT/incoming" "$INSTALL_ROOT/releases" /var/lib/combo-dev/evidence; do
    [[ -d "$path" && ! -L "$path" ]] || return 1
    [[ $(findmnt -rn -M "$path" -o TARGET 2>/dev/null) == "$path" ]] || return 1
    options=$(findmnt -rn -M "$path" -o OPTIONS 2>/dev/null) || return 1
    [[ ",$options," == *,rw,* && ",$options," == *,nodev,* && ",$options," == *,nosuid,* && ",$options," == *,noexec,* ]] || return 1
  done
  fsroot=$(findmnt -rn -M "$INSTALL_ROOT/incoming" -o FSROOT 2>/dev/null) || return 1
  [[ "$fsroot" == '/incoming' ]] || return 1
  fsroot=$(findmnt -rn -M "$INSTALL_ROOT/releases" -o FSROOT 2>/dev/null) || return 1
  [[ "$fsroot" == '/releases' ]] || return 1
  fsroot=$(findmnt -rn -M /var/lib/combo-dev/evidence -o FSROOT 2>/dev/null) || return 1
  [[ "$fsroot" == '/evidence' ]] || return 1
  [[ $(stat -c '%d:%i' "$INSTALL_ROOT/incoming" 2>/dev/null) == $(stat -c '%d:%i' "$CONTROL_INCOMING" 2>/dev/null) ]] || return 1
  [[ $(stat -c '%d:%i' "$INSTALL_ROOT/releases" 2>/dev/null) == $(stat -c '%d:%i' "$CONTROL_RELEASES" 2>/dev/null) ]] || return 1
  [[ $(stat -c '%d:%i' /var/lib/combo-dev/evidence 2>/dev/null) == $(stat -c '%d:%i' "$CONTROL_EVIDENCE" 2>/dev/null) ]] || return 1
}

assert_control_state_headroom() {
  local free inodes
  verify_control_state || blocked 'control-state 挂载、backing file、目录或兼容 bind 契约失效。'
  free=$(free_bytes "$CONTROL_STATE") || blocked 'control-state 可用容量不可读。'
  inodes=$(free_inodes "$CONTROL_STATE") || blocked 'control-state inode 不可读。'
  [[ "$free" =~ ^[0-9]+$ && "$inodes" =~ ^[0-9]+$ ]] || blocked 'control-state 容量指标格式不合法。'
  (( free >= CONTROL_STATE_MIN_FREE_BYTES && inodes >= CONTROL_STATE_MIN_FREE_INODES )) ||
    blocked 'control-state 低于字节或 inode 安全水位。'
}

assert_host_capacity() {
  local root_free root_total root_iavail root_itotal root_warn root_critical root_iwarn root_icritical
  local data_free data_total data_iavail data_itotal data_warn data_critical data_iwarn data_icritical
  root_free=$(free_bytes /) || blocked '根盘可用容量不可读。'
  root_total=$(total_bytes /) || blocked '根盘总容量不可读。'
  root_iavail=$(free_inodes /) || blocked '根盘可用 inode 不可读。'
  root_itotal=$(total_inodes /) || blocked '根盘总 inode 不可读。'
  data_free=$(free_bytes "$DATA_MOUNT") || blocked '父数据盘可用容量不可读。'
  data_total=$(total_bytes "$DATA_MOUNT") || blocked '父数据盘总容量不可读。'
  data_iavail=$(free_inodes "$DATA_MOUNT") || blocked '父数据盘可用 inode 不可读。'
  data_itotal=$(total_inodes "$DATA_MOUNT") || blocked '父数据盘总 inode 不可读。'
  [[ "$root_free" =~ ^[0-9]+$ && "$root_total" =~ ^[0-9]+$ &&
    "$root_iavail" =~ ^[0-9]+$ && "$root_itotal" =~ ^[0-9]+$ &&
    "$data_free" =~ ^[0-9]+$ && "$data_total" =~ ^[0-9]+$ &&
    "$data_iavail" =~ ^[0-9]+$ && "$data_itotal" =~ ^[0-9]+$ ]] ||
    blocked '主机容量指标格式不合法。'
  root_warn=$(max_threshold "$root_total" "$ROOT_WARNING_MIN_BYTES" 15)
  root_critical=$(max_threshold "$root_total" "$ROOT_CRITICAL_MIN_BYTES" 10)
  root_iwarn=$((root_itotal * 15 / 100)); root_icritical=$((root_itotal * 10 / 100))
  data_warn=$(max_threshold "$data_total" "$DATA_WARNING_MIN_BYTES" 15)
  data_critical=$(max_threshold "$data_total" "$DATA_CRITICAL_MIN_BYTES" 10)
  data_iwarn=$((data_itotal * 15 / 100)); data_icritical=$((data_itotal * 10 / 100))
  (( root_free >= root_critical && root_iavail >= root_icritical )) ||
    blocked '主机根盘低于 OS critical 安全水位；这不是部署容量门槛。'
  (( data_free >= data_critical && data_iavail >= data_icritical )) ||
    blocked '父数据盘低于 critical 字节或 inode 安全水位。'
  if (( root_free < root_warn || root_iavail < root_iwarn )); then
    status "WARN root-os-headroom bytes=$root_free inodes=$root_iavail"
  fi
  if (( data_free < data_warn || data_iavail < data_iwarn )); then
    status "WARN parent-data-headroom bytes=$data_free inodes=$data_iavail"
  fi
}

verify_bounded_storage_pool() {
  local canonical target source parent_source total options
  [[ -d "$STORAGE_POOL" && ! -L "$STORAGE_POOL" ]] || return 1
  canonical=$(readlink -f -- "$STORAGE_POOL" 2>/dev/null) || return 1
  [[ "$canonical" == "$STORAGE_POOL" ]] || return 1
  [[ -f "$STORAGE_SENTINEL" && ! -L "$STORAGE_SENTINEL" ]] || return 1
  root_owned_not_writable "$STORAGE_SENTINEL" || return 1
  [[ $(cat "$STORAGE_SENTINEL" 2>/dev/null || true) == "$STORAGE_SENTINEL_STATE" ]] || return 1
  target=$(findmnt -rn -M "$STORAGE_POOL" -o TARGET 2>/dev/null) || return 1
  [[ "$target" == "$STORAGE_POOL" ]] || return 1
  source=$(findmnt -rn -M "$STORAGE_POOL" -o SOURCE 2>/dev/null) || return 1
  parent_source=$(findmnt -rn -T "$(dirname "$STORAGE_POOL")" -o SOURCE 2>/dev/null) || return 1
  [[ -n "$source" && "$source" != "$parent_source" ]] || return 1
  options=$(findmnt -rn -M "$STORAGE_POOL" -o OPTIONS 2>/dev/null) || return 1
  [[ ",$options," == *,rw,* && ",$options," == *,nodev,* && ",$options," == *,nosuid,* ]] || return 1
  total=$(df -B1 --output=size "$STORAGE_POOL" 2>/dev/null | awk 'NR==2 {print $1}') || return 1
  [[ "$total" =~ ^[0-9]+$ ]] || return 1
  (( total >= STORAGE_MIN_BYTES && total <= STORAGE_MAX_BYTES ))
}

static_volume_contract() {
  case "$1" in
    postgres) printf '%s\n' "$POSTGRES_STORAGE_PATH 70 70 combo-dev-static-volume=postgres:v1" ;;
    redis-queue) printf '%s\n' "$REDIS_QUEUE_STORAGE_PATH 999 1000 combo-dev-static-volume=redis-queue:v1" ;;
    minio) printf '%s\n' "$MINIO_STORAGE_PATH 1000 1000 combo-dev-static-volume=minio:v1" ;;
    *) return 2 ;;
  esac
}

verify_static_storage_paths() {
  local key path uid gid marker_state parent marker canonical target metadata
  verify_bounded_storage_pool || return 1
  [[ $(stat -c '%u:%g:%a' "$STORAGE_POOL" 2>/dev/null) == '0:0:755' ]] || return 1
  for key in postgres redis-queue minio; do
    read -r path uid gid marker_state < <(static_volume_contract "$key") || return 1
    parent=$(dirname "$path")
    marker="$parent/.combo-dev-volume"
    [[ -d "$parent" && ! -L "$parent" && $(stat -c '%u:%g:%a' "$parent" 2>/dev/null) == '0:0:755' ]] || return 1
    [[ -d "$path" && ! -L "$path" ]] || return 1
    metadata=$(stat -c '%u:%g:%a' "$path" 2>/dev/null) || return 1
    [[ "$metadata" == "$uid:$gid:700" ]] || return 1
    canonical=$(readlink -f -- "$path" 2>/dev/null) || return 1
    [[ "$canonical" == "$path" ]] || return 1
    target=$(findmnt -rn -T "$path" -o TARGET 2>/dev/null) || return 1
    [[ "$target" == "$STORAGE_POOL" ]] || return 1
    [[ -f "$marker" && ! -L "$marker" && $(stat -c '%u:%g:%a' "$marker" 2>/dev/null) == '0:0:444' ]] || return 1
    [[ $(cat "$marker" 2>/dev/null || true) == "$marker_state" ]] || return 1
  done
}

prepare_static_storage_paths() {
  local key path uid gid marker_state parent marker source
  verify_bounded_storage_pool || blocked '静态卷目录创建前独立挂载校验失败。'
  chown root:root "$STORAGE_POOL" || blocked '独立挂载根目录所有权无法固定。'
  chmod 0755 "$STORAGE_POOL" || blocked '独立挂载根目录权限无法固定。'
  for key in postgres redis-queue minio; do
    read -r path uid gid marker_state < <(static_volume_contract "$key") || blocked '静态卷目录契约不完整。'
    parent=$(dirname "$path")
    marker="$parent/.combo-dev-volume"
    install -d -o root -g root -m 0755 "$parent" || blocked '静态卷父目录无法创建。'
    install -d -o "$uid" -g "$gid" -m 0700 "$path" || blocked '静态卷数据目录无法创建。'
    source="$WORK/$key.volume-marker"
    printf '%s\n' "$marker_state" >"$source"
    chmod 0444 "$source"
    install -o root -g root -m 0444 "$source" "$marker" || blocked '静态卷标记无法安装。'
  done
  verify_static_storage_paths || blocked '静态卷目录、标记或运行身份不符合固定契约。'
}

verify_k3s_mount_dependencies() {
  local mounts
  mounts=$(timeout 15 systemctl show k3s.service -p RequiresMountsFor --value 2>/dev/null) || return 1
  printf '%s\n' "$mounts" | python3 "$ROOT/scripts/combo-dev-production-safety.py" \
    validate-mount-dependencies --input /dev/stdin --data-mount "$DATA_MOUNT" --storage-pool "$STORAGE_POOL" \
    >/dev/null 2>&1
}

can_i_with_credential() {
  local kubeconfig=$1 expected=$2 verb=$3 resource=$4 namespace=${5:-} subresource=${6:-} out rc
  local args=(--request-timeout=30s --kubeconfig "$kubeconfig" auth can-i "$verb" "$resource")
  [[ -z "$namespace" ]] || args+=(-n "$namespace")
  [[ -z "$subresource" ]] || args+=(--subresource="$subresource")
  set +e
  out=$(kubectl "${args[@]}" 2>/dev/null)
  rc=$?
  set -e
  if [[ "$expected" == yes ]]; then
    [[ $rc == 0 && "$out" == yes ]]
  else
    [[ $rc == 1 && "$out" == no* ]]
  fi
}

can_i_dispatcher() { can_i_with_credential "$DISPATCHER_KUBECONFIG" "$@"; }
can_i_fencer() { can_i_with_credential "$FENCER_KUBECONFIG" "$@"; }

trusted_source_tree() {
  python3 - "$ROOT" <<'PY'
import os, stat, sys
root=sys.argv[1]
parents=[root,os.path.join(root,'scripts'),os.path.join(root,'infra'),os.path.join(root,'infra/k8s'),os.path.join(root,'infra/k8s/overlays'),os.path.join(root,'infra/host')]
for path in parents:
    s=os.lstat(path)
    if s.st_uid != 0 or stat.S_ISLNK(s.st_mode) or (s.st_mode & 0o022): raise SystemExit(2)
paths=[os.path.join(root,'infra/k8s/overlays/combo-dev'),os.path.join(root,'infra/host/combo-dev')]
paths += [os.path.join(root,'scripts',name) for name in (
 'combo-dev-bootstrap.sh','combo-dev-deploy.sh','combo-dev-smoke.sh',
 'combo-dev-connect.sh','combo-dev-logs.sh','combo-dev-reset.sh',
 'combo-dev-forwarder-lease.sh','combo-dev-storage-guard.sh',
 'combo-dev-production-safety.py')]
for base in paths:
    if not os.path.exists(base): raise SystemExit(2)
    entries=[]
    if os.path.isdir(base):
        for current,dirs,files in os.walk(base,followlinks=False):
            entries += [current]+[os.path.join(current,x) for x in dirs+files]
    else: entries=[base]
    for path in entries:
        s=os.lstat(path)
        if s.st_uid != 0 or stat.S_ISLNK(s.st_mode) or (s.st_mode & 0o022): raise SystemExit(2)
PY
}

host_preflight() {
  [[ $(id -u) -eq 0 ]] || blocked 'bootstrap 必须由主机所有者以 root 手工执行。'
  local cmd canonical
  for cmd in kubectl python3 jq openssl sha256sum flock findmnt df systemctl install stat base64 timeout chown chmod readlink dirname seq sleep find rm mv mktemp logrotate losetup blockdev blkid; do require_command "$cmd"; done
  trusted_source_tree || blocked 'bootstrap 源目录不是 root-owned 只读快照。'
  private_directory /etc/combo-dev || blocked '开发配置目录不是 root-owned 私有目录。'
  if [[ -e /etc/logrotate.d ]] && ! root_owned_not_writable /etc/logrotate.d; then
    blocked 'logrotate 配置目录不是 root-owned 安全目录。'
  fi
  if [[ -e /opt/combo-dev ]] && ! private_directory /opt/combo-dev; then blocked '安装目录不是 root-owned 安全目录。'; fi
  private_file "$ADMIN_KUBECONFIG" || blocked 'k3s 管理配置不是 root-only 文件。'
  private_file "$CONFIG_FILE" || blocked '开发配置文件必须由 root 独占读取。'
  private_file "$REGISTRY_FILE" || blocked '只读镜像仓库配置必须由 root 独占读取。'
  private_file "$PRODUCTION_KUBECONFIG" || blocked '生产只读观察凭据必须由 root 独占读取。'
  private_file "$K3S_DATA_DIR_FILE" || blocked 'k3s 数据目录配置必须由 root 独占读取。'
  canonical=$(readlink -f -- "$K3S_DATA_DIR" 2>/dev/null) || blocked 'k3s 数据目录不可解析。'
  [[ "$canonical" == "$K3S_DATA_DIR" && "$K3S_DATA_DIR" == "$DATA_MOUNT"/* ]] || blocked 'k3s 数据目录不在批准的数据盘中。'
  root_owned_not_writable "$K3S_DATA_DIR" || blocked 'k3s 数据目录所有权或权限不安全。'
  [[ $(cat /etc/combo-dev/data-mount-reboot.approved 2>/dev/null || true) == 'controlled-reboot=parent-data-mount-pass' ]] || blocked '缺少生产所需父数据盘受控重启证据。'
  [[ $(cat /etc/combo-dev/journal-retention.approved 2>/dev/null || true) == 'journald=native-retention-bounded' ]] || blocked '缺少原生日志保留上限证据。'
  timeout 30 logrotate --debug "$ROOT/infra/host/combo-dev/combo-host-syslog" >/dev/null 2>&1 ||
    blocked '受控主机 syslog 轮转策略无效。'
  [[ $(cat "$STORAGE_APPROVAL" 2>/dev/null || true) == 'combo-dev-storage=dedicated-hard-18GiB-max' ]] || blocked '缺少独立有界存储池批准。'
  [[ $(cat "$HOST_BOUNDARY_APPROVAL" 2>/dev/null || true) == 'combo-dev-host-boundary=audited-and-active' ]] || blocked '缺少 Pod 到节点的主机级隔离批准。'
  if ! root_owned_not_writable "$HOST_BOUNDARY_CHECK" || [[ ! -x "$HOST_BOUNDARY_CHECK" ]]; then
    blocked '主机级隔离检查器不可用或可被非 root 修改。'
  fi
  timeout 30 "$HOST_BOUNDARY_CHECK" --check >/dev/null 2>&1 || blocked '主机级 Pod 到节点隔离未生效。'
  findmnt -rn -M "$DATA_MOUNT" >/dev/null 2>&1 || blocked '固定数据盘尚未挂载。'
  verify_control_state || blocked 'control-state 没有使用固定数据盘 backing 的独立 3.5–4 GiB 挂载与兼容 bind。'
  verify_bounded_storage_pool || blocked 'combo-dev 没有使用独立且硬限制为 18 GiB 以内的挂载。'
  verify_k3s_mount_dependencies || blocked 'k3s 必须只依赖生产父数据盘，不能依赖开发挂载或其任何子路径。'
  assert_control_state_headroom
  assert_host_capacity
  [[ ! -e "$ROOT_CRITICAL_MARKER" && ! -L "$ROOT_CRITICAL_MARKER" ]] ||
    blocked '根盘 OS critical 健康标记仍在 15 分钟恢复观察期。'
}

validate_config_names_only() {
  local rc
  set +e
  python3 - "$CONFIG_FILE" "$REGISTRY_FILE" <<'PY'
import json, re, sys, urllib.parse
config, registry = sys.argv[1:]
values={}
for raw in open(config, encoding='utf-8'):
    line=raw.rstrip('\n')
    if not line or line.lstrip().startswith('#'): continue
    if '=' not in line: raise SystemExit(2)
    key,value=line.split('=',1)
    if not key or key in values or not value: raise SystemExit(2)
    values[key]=value
required={
 'POSTGRES_USER','POSTGRES_PASSWORD','POSTGRES_DB','MINIO_ROOT_USER','MINIO_ROOT_PASSWORD',
 'POSTGRES_API_PASSWORD','POSTGRES_WORKER_PASSWORD','POSTGRES_RUNTIME_PASSWORD',
 'S3_ACCESS_KEY','S3_SECRET_KEY','S3_PUBLIC_ENDPOINT','RESEND_API_KEY','OTP_HMAC_SECRET',
 'LLM_PROVIDER','RUNTIME_LLM_PROVIDER'
}
if not required <= set(values): raise SystemExit(2)
if any(key in values for key in (
    'DEV_SESSION_SECRET','LOGTO_ENDPOINT','LOGTO_ISSUER','LOGTO_JWKS_URI',
    'LOGTO_APP_ID','LOGTO_APP_SECRET','LOGTO_AUDIENCE','LOGTO_REDIRECT_URI',
)): raise SystemExit(2)
if values['MINIO_ROOT_USER'] == values['S3_ACCESS_KEY'] or values['MINIO_ROOT_PASSWORD'] == values['S3_SECRET_KEY']:
    raise SystemExit(2)
if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{2,63}', values['S3_ACCESS_KEY']):
    raise SystemExit(2)
if values['LLM_PROVIDER'] != values['RUNTIME_LLM_PROVIDER'] or values['LLM_PROVIDER'] not in {'anthropic','openrouter'}:
    raise SystemExit(2)
key = 'ANTHROPIC_API_KEY' if values['LLM_PROVIDER']=='anthropic' else 'OPENROUTER_API_KEY'
if not values.get(key): raise SystemExit(2)
if not re.fullmatch(r're_[A-Za-z0-9_-]{16,252}', values['RESEND_API_KEY']):
    raise SystemExit(2)
if len(values['OTP_HMAC_SECRET']) < 32: raise SystemExit(2)
for key in ('POSTGRES_API_PASSWORD','POSTGRES_WORKER_PASSWORD','POSTGRES_RUNTIME_PASSWORD'):
    if len(values[key]) < 16: raise SystemExit(2)
if len({values[key] for key in (
    'POSTGRES_PASSWORD','POSTGRES_API_PASSWORD','POSTGRES_WORKER_PASSWORD',
    'POSTGRES_RUNTIME_PASSWORD',
)}) != 4: raise SystemExit(2)
u=urllib.parse.urlsplit(values['S3_PUBLIC_ENDPOINT'])
if u.scheme not in {'http','https'} or not u.hostname or u.username or u.password:
    raise SystemExit(2)
if values.get('LLM_BASE_URL'):
    u=urllib.parse.urlsplit(values['LLM_BASE_URL'])
    if u.scheme != 'https' or not u.hostname or u.username or u.password: raise SystemExit(2)
try:
    data=json.load(open(registry, encoding='utf-8'))
except Exception:
    raise SystemExit(2)
if set(data) != {'auths'} or set(data['auths']) != {'ghcr.io'}: raise SystemExit(2)
entry=data['auths']['ghcr.io']
if not isinstance(entry,dict) or not any(entry.get(k) for k in ('auth','identitytoken')): raise SystemExit(2)
PY
  rc=$?
  set -e
  (( rc == 0 )) || blocked '开发配置、身份提供商、LLM 或只读仓库配置不完整。'
}

resolve_node_hostname_admin() {
  local nodes="$WORK/nodes.json"
  "${AK[@]}" get nodes -o json >"$nodes" 2>/dev/null || return 1
  python3 - "$nodes" <<'PY'
import json,re,sys
items=json.load(open(sys.argv[1],encoding='utf-8')).get('items',[])
ready=[]
for item in items:
    conditions={x.get('type'):x.get('status') for x in item.get('status',{}).get('conditions',[])}
    if conditions.get('Ready')=='True' and not item.get('spec',{}).get('unschedulable',False):
        ready.append(item)
if len(ready)!=1: raise SystemExit(2)
value=ready[0].get('metadata',{}).get('labels',{}).get('kubernetes.io/hostname','')
if not re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?',value): raise SystemExit(2)
print(value)
PY
}

storage_class_is_static_admin() {
  local out="$WORK/storage-class.json"
  "${AK[@]}" get "storageclass/$STORAGE_CLASS" -o json >"$out" 2>/dev/null || return 1
  jq -e '
    .provisioner == "kubernetes.io/no-provisioner"
    and ((.parameters // {}) == {})
    and .reclaimPolicy == "Retain"
    and .volumeBindingMode == "WaitForFirstConsumer"
    and .allowVolumeExpansion == false
    and (.metadata.annotations["storageclass.kubernetes.io/is-default-class"] // "false") != "true"
    and (.metadata.annotations["storageclass.beta.kubernetes.io/is-default-class"] // "false") != "true"
  ' "$out" >/dev/null 2>&1
}

ensure_static_storage_class_admin() {
  local existing
  existing=$("${AK[@]}" get "storageclass/$STORAGE_CLASS" --ignore-not-found -o name 2>/dev/null) || blocked '静态 StorageClass 状态不可读。'
  [[ -z "$existing" ]] || blocked '静态 StorageClass 必须在首次绑定前不存在。'
  bootstrap_boundary storage-class-apply "${AK[@]}" apply \
    -f "$ROOT/infra/k8s/overlays/combo-dev/platform/storage-class.yaml" >/dev/null 2>&1 ||
    blocked '静态本地卷 StorageClass 应用失败。'
  storage_class_is_static_admin || blocked '静态本地卷 StorageClass 不符合固定契约。'
}

render_static_storage_manifest() {
  local node_hostname=$1 output=$2 source="$ROOT/infra/k8s/overlays/combo-dev/platform/storage-volumes.yaml"
  python3 - "$source" "$output" "$node_hostname" <<'PY'
import sys
source,target,node=sys.argv[1:]
text=open(source,encoding='utf-8').read()
if text.count('COMBO_DEV_NODE_HOSTNAME') != 3: raise SystemExit(2)
with open(target,'w',encoding='utf-8') as stream:
    stream.write(text.replace('COMBO_DEV_NODE_HOSTNAME',node))
PY
  chmod 0600 "$output"
}

prepare_cluster_platform_contract() {
  local raw="$WORK/cluster-platform.desired.json"
  NODE_HOSTNAME=$(resolve_node_hostname_admin) || blocked '静态本地卷无法唯一绑定到就绪节点。'
  render_static_storage_manifest "$NODE_HOSTNAME" "$WORK/storage-volumes.yaml" || blocked '静态 PV/PVC 模板无法绑定固定节点。'
  "${AK[@]}" create --dry-run=client --validate=strict \
    -f "$ROOT/infra/k8s/overlays/combo-dev/platform/namespace.yaml" \
    -f "$ROOT/infra/k8s/overlays/combo-dev/platform/rbac.yaml" \
    -f "$ROOT/infra/k8s/overlays/combo-dev/platform/storage-class.yaml" \
    -f "$WORK/storage-volumes.yaml" -o json 2>/dev/null | jq -s \
      '{apiVersion:"v1",kind:"List",items:[.[] | if .kind == "List" then .items[] else . end]}' \
      >"$raw" 2>/dev/null || blocked '集群级平台契约无法完成只读规范化。'
  python3 "$ROOT/scripts/combo-dev-production-safety.py" canonicalize-platform \
    --input "$raw" --output "$WORK/cluster-platform.canonical.json" >/dev/null 2>&1 ||
    blocked '集群级平台契约不完整。'
}

collect_cluster_platform_admin() {
  local output=$1 parts="$WORK/cluster-platform.live.parts" resource
  : >"$parts"
  for resource in \
    "namespace/$NAMESPACE" \
    clusterrole/combo-dev-control-auditor \
    clusterrolebinding/combo-dev-control-auditor \
    "storageclass/$STORAGE_CLASS" \
    persistentvolume/combo-dev-postgres \
    persistentvolume/combo-dev-redis-queue \
    persistentvolume/combo-dev-minio; do
    "${AK[@]}" get "$resource" -o json >>"$parts" 2>/dev/null || return 1
  done
  jq -s '{apiVersion:"v1",kind:"List",items:.}' "$parts" >"$output" 2>/dev/null
  chmod 0600 "$output"
}

verify_cluster_platform_admin() {
  local live="$WORK/cluster-platform.live.json"
  collect_cluster_platform_admin "$live" || return 1
  python3 "$ROOT/scripts/combo-dev-production-safety.py" compare-platform \
    --expected "$WORK/cluster-platform.canonical.json" --live "$live" >/dev/null 2>&1
}

classify_preview_storage_admin() {
  local namespace_name pvc="$WORK/preflight-pvc.json" pv="$WORK/preflight-pv.json"
  local resource resource_name present=0 count
  namespace_name=$("${AK[@]}" get namespace "$NAMESPACE" --ignore-not-found -o name 2>/dev/null) || blocked 'preview 命名空间状态不可读。'
  if [[ -n "$namespace_name" ]]; then
    [[ "$namespace_name" == "namespace/$NAMESPACE" ]] || blocked 'preview 命名空间状态异常。'
    "${AK[@]}" -n "$NAMESPACE" get persistentvolumeclaims -o json >"$pvc" 2>/dev/null || blocked 'preview PVC 状态不可读。'
  else
    printf '%s\n' '{"items":[]}' >"$pvc"
  fi
  for resource in "storageclass/$STORAGE_CLASS" "${STATIC_PVS[@]/#/persistentvolume\/}"; do
    resource_name=$("${AK[@]}" get "$resource" --ignore-not-found -o name 2>/dev/null) || blocked '静态集群存储状态不可读。'
    if [[ -n "$resource_name" ]]; then present=$((present + 1)); fi
  done
  count=$(jq '.items | length' "$pvc") || blocked 'preview PVC 数量不可读。'
  if [[ "$count" == 0 && $present == 0 ]]; then
    printf '%s\n' empty >"$WORK/storage-state"
    return
  fi
  if [[ -n "$namespace_name" && $present == 4 ]] &&
      jq -e '([.items[].metadata.name] | sort) == ["data-minio-0","data-postgres-0","data-redis-queue-0"]' \
        "$pvc" >/dev/null 2>&1; then
    static_storage_is_valid_admin "$NODE_HOSTNAME" || blocked '既有静态 PV/PVC 绑定未通过只读前置检查。'
    printf '%s\n' static >"$WORK/storage-state"
    return
  fi
  [[ -n "$namespace_name" && $present == 0 ]] || blocked '只接受全空、完整静态绑定或已知可丢弃的旧 preview 存储状态。'
  "${AK[@]}" get persistentvolumes -o json >"$pv" 2>/dev/null || blocked '旧 preview PV 状态不可读。'
  python3 - "$pvc" "$pv" "$K3S_DATA_DIR" "$WORK/legacy-storage.json" <<'PY' ||
import json, os, re, sys
pvc_path, pv_path, data_dir, output = sys.argv[1:]
namespace = 'combo-preview'
expected_claims = {
    'combo-preview-postgres-data-postgres-0',
    'combo-preview-redis-queue-data-redis-queue-0',
    'combo-preview-minio-data-minio-0',
}
claims = json.load(open(pvc_path, encoding='utf-8')).get('items', [])
volumes = json.load(open(pv_path, encoding='utf-8')).get('items', [])
if not isinstance(claims, list) or not isinstance(volumes, list): raise SystemExit(2)
if {item.get('metadata', {}).get('name') for item in claims} != expected_claims: raise SystemExit(2)
bound = {
    item.get('metadata', {}).get('name'): item
    for item in volumes
    if item.get('spec', {}).get('claimRef', {}).get('namespace') == namespace
}
legacy_root = os.path.realpath(os.path.join(data_dir, 'storage'))
contract = []
for claim in claims:
    metadata = claim.get('metadata', {}); spec = claim.get('spec', {}); status = claim.get('status', {})
    name = metadata.get('name'); uid = metadata.get('uid'); volume_name = spec.get('volumeName')
    if metadata.get('deletionTimestamp') is not None or status.get('phase') != 'Bound': raise SystemExit(2)
    if not isinstance(uid, str) or not re.fullmatch(r'[0-9a-f-]{36}', uid): raise SystemExit(2)
    if volume_name != f'pvc-{uid}' or spec.get('storageClassName') != 'local-path': raise SystemExit(2)
    if spec.get('accessModes') != ['ReadWriteOnce'] or spec.get('volumeMode', 'Filesystem') != 'Filesystem': raise SystemExit(2)
    volume = bound.get(volume_name)
    if not isinstance(volume, dict): raise SystemExit(2)
    volume_metadata = volume.get('metadata', {}); volume_spec = volume.get('spec', {}); volume_status = volume.get('status', {})
    claim_ref = volume_spec.get('claimRef', {}); path = volume_spec.get('local', {}).get('path')
    if volume_metadata.get('deletionTimestamp') is not None or volume_status.get('phase') != 'Bound': raise SystemExit(2)
    if claim_ref.get('namespace') != namespace or claim_ref.get('name') != name or claim_ref.get('uid') != uid: raise SystemExit(2)
    if volume_spec.get('storageClassName') != 'local-path' or volume_spec.get('persistentVolumeReclaimPolicy') != 'Delete': raise SystemExit(2)
    if 'hostPath' in volume_spec or not isinstance(path, str) or os.path.realpath(path) != path: raise SystemExit(2)
    expected_path = os.path.join(legacy_root, f'{volume_name}_{namespace}_{name}')
    if path != expected_path or not os.path.isdir(path): raise SystemExit(2)
    contract.append({'claim': name, 'claimUid': uid, 'volume': volume_name, 'path': path})
if set(bound) != {item['volume'] for item in contract}: raise SystemExit(2)
contract.sort(key=lambda item: item['claim'])
with open(output, 'w', encoding='utf-8') as stream:
    json.dump({'claims': contract}, stream, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    stream.write('\n')
PY
    blocked '旧 preview 存储不是可安全接管的固定三卷布局。'
  chmod 0600 "$WORK/legacy-storage.json"
  printf '%s\n' legacy >"$WORK/storage-state"
}

cleanup_legacy_preview_storage_admin() {
  local state claim volume path current_uid current_volume remaining
  local claims=() volumes=() paths=()
  state=$(cat "$WORK/storage-state" 2>/dev/null || true)
  [[ "$state" == legacy ]] || return 0
  [[ -f "$WORK/legacy-storage.json" ]] || return 1
  mapfile -t claims < <(jq -r '.claims[].claim' "$WORK/legacy-storage.json")
  mapfile -t volumes < <(jq -r '.claims[].volume' "$WORK/legacy-storage.json")
  mapfile -t paths < <(jq -r '.claims[].path' "$WORK/legacy-storage.json")
  [[ ${#claims[@]} == 3 && ${#volumes[@]} == 3 && ${#paths[@]} == 3 ]] || return 1
  for claim in "${claims[@]}"; do
    current_uid=$("${AK[@]}" -n "$NAMESPACE" get "persistentvolumeclaim/$claim" -o jsonpath='{.metadata.uid}' 2>/dev/null) || return 1
    current_volume=$("${AK[@]}" -n "$NAMESPACE" get "persistentvolumeclaim/$claim" -o jsonpath='{.spec.volumeName}' 2>/dev/null) || return 1
    jq -e --arg claim "$claim" --arg uid "$current_uid" --arg volume "$current_volume" \
      '.claims[] | select(.claim == $claim and .claimUid == $uid and .volume == $volume)' \
      "$WORK/legacy-storage.json" >/dev/null 2>&1 || return 1
  done
  "${AK[@]}" -n "$NAMESPACE" delete persistentvolumeclaim "${claims[@]}" \
    --wait=true --timeout=180s >/dev/null 2>&1 || return 1
  for volume in "${volumes[@]}"; do
    timeout 180 "${AK[@]}" --request-timeout=0 wait --for=delete "persistentvolume/$volume" \
      --timeout=170s >/dev/null 2>&1 || return 1
  done
  for _ in $(seq 1 60); do
    remaining=0
    for path in "${paths[@]}"; do [[ ! -e "$path" && ! -L "$path" ]] || remaining=1; done
    (( remaining == 0 )) && break
    sleep 2
  done
  (( remaining == 0 )) || return 1
  [[ -z $("${AK[@]}" -n "$NAMESPACE" get persistentvolumeclaims -o name 2>/dev/null) ]] || return 1
  printf '%s\n' empty >"$WORK/storage-state"
}

static_storage_is_valid_admin() {
  local expected_node=$1 class="$WORK/static-class.json" pvc="$WORK/static-pvc.json" key
  "${AK[@]}" get "storageclass/$STORAGE_CLASS" -o json >"$class" 2>/dev/null || return 1
  "${AK[@]}" -n "$NAMESPACE" get persistentvolumeclaims -o json >"$pvc" 2>/dev/null || return 1
  for key in "${STATIC_PVS[@]}"; do
    "${AK[@]}" get "persistentvolume/$key" -o json >"$WORK/$key.json" 2>/dev/null || return 1
  done
  python3 - "$class" "$pvc" "$WORK/combo-dev-postgres.json" "$WORK/combo-dev-redis-queue.json" "$WORK/combo-dev-minio.json" "$STORAGE_POOL" "$expected_node" <<'PY'
import json,os,sys
class_path,pvc_path,*rest=sys.argv[1:]
pv_paths=rest[:3]; pool,node=rest[3:]
storage_class=json.load(open(class_path,encoding='utf-8'))
annotations=storage_class.get('metadata',{}).get('annotations',{})
if storage_class.get('provisioner')!='kubernetes.io/no-provisioner' or storage_class.get('parameters',{})!={}: raise SystemExit(2)
if storage_class.get('reclaimPolicy')!='Retain' or storage_class.get('volumeBindingMode')!='WaitForFirstConsumer' or storage_class.get('allowVolumeExpansion') is not False: raise SystemExit(2)
if annotations.get('storageclass.kubernetes.io/is-default-class')=='true' or annotations.get('storageclass.beta.kubernetes.io/is-default-class')=='true': raise SystemExit(2)
expected={
 'data-postgres-0':('combo-dev-postgres','8Gi',os.path.join(pool,'postgres')),
 'data-redis-queue-0':('combo-dev-redis-queue','2Gi',os.path.join(pool,'redis-queue')),
 'data-minio-0':('combo-dev-minio','6Gi',os.path.join(pool,'minio')),
}
claims=json.load(open(pvc_path,encoding='utf-8')).get('items',[])
if {x.get('metadata',{}).get('name') for x in claims}!=set(expected): raise SystemExit(2)
volumes={x['metadata']['name']:x for x in (json.load(open(path,encoding='utf-8')) for path in pv_paths)}
if set(volumes)!={value[0] for value in expected.values()}: raise SystemExit(2)
for claim in claims:
    name=claim['metadata']['name']; volume_name,size,path=expected[name]; spec=claim.get('spec',{})
    if claim.get('status',{}).get('phase')!='Bound' or claim.get('metadata',{}).get('deletionTimestamp'): raise SystemExit(2)
    if spec.get('accessModes')!=['ReadWriteOnce'] or spec.get('volumeMode','Filesystem')!='Filesystem': raise SystemExit(2)
    if spec.get('storageClassName')!='combo-dev-bounded' or spec.get('volumeName')!=volume_name or spec.get('resources',{}).get('requests',{}).get('storage')!=size: raise SystemExit(2)
    if any('storage-provisioner' in key for key in claim.get('metadata',{}).get('annotations',{})): raise SystemExit(2)
    volume=volumes[volume_name]; volume_spec=volume.get('spec',{})
    if volume.get('status',{}).get('phase')!='Bound' or volume.get('metadata',{}).get('deletionTimestamp'): raise SystemExit(2)
    if volume_spec.get('capacity',{}).get('storage')!=size or volume_spec.get('accessModes')!=['ReadWriteOnce'] or volume_spec.get('volumeMode','Filesystem')!='Filesystem': raise SystemExit(2)
    if volume_spec.get('storageClassName')!='combo-dev-bounded' or volume_spec.get('persistentVolumeReclaimPolicy')!='Retain': raise SystemExit(2)
    if volume_spec.get('claimRef',{}).get('namespace')!='combo-preview' or volume_spec['claimRef'].get('name')!=name: raise SystemExit(2)
    if 'hostPath' in volume_spec or volume_spec.get('local',{}).get('path')!=path: raise SystemExit(2)
    affinity=volume_spec.get('nodeAffinity',{}).get('required',{}).get('nodeSelectorTerms',[])
    wanted=[{'matchExpressions':[{'key':'kubernetes.io/hostname','operator':'In','values':[node]}]}]
    if affinity!=wanted or os.path.realpath(path)!=path or not os.path.isdir(path): raise SystemExit(2)
PY
}

install_static_storage_bindings_admin() {
  local state claim
  state=$(cat "$WORK/storage-state" 2>/dev/null || true)
  if [[ "$state" == static ]]; then
    static_storage_is_valid_admin "$NODE_HOSTNAME" || blocked '既有静态 PV/PVC 绑定发生漂移。'
    return
  fi
  [[ "$state" == empty ]] || blocked 'preview 存储状态不允许静态接管。'
  ensure_static_storage_class_admin
  bootstrap_boundary static-volumes-apply "${AK[@]}" apply --server-side \
    --field-manager=combo-dev-bootstrap -f "$WORK/storage-volumes.yaml" >/dev/null 2>&1 ||
    blocked '静态 PV/PVC 绑定应用失败。'
  for claim in "${STATIC_PVCS[@]}"; do
    timeout 120 "${AK[@]}" --request-timeout=0 -n "$NAMESPACE" wait --for=jsonpath='{.status.phase}'=Bound \
      "persistentvolumeclaim/$claim" --timeout=110s >/dev/null 2>&1 || blocked '静态 PVC 未在时限内绑定。'
  done
  static_storage_is_valid_admin "$NODE_HOSTNAME" || blocked '静态 PV/PVC 绑定不符合固定路径契约。'
}

namespace_exists_admin() {
  local out
  out=$("${AK[@]}" get "namespace/$NAMESPACE" --ignore-not-found -o name 2>/dev/null) || return 2
  [[ -z "$out" ]] && return 1
  [[ "$out" == "namespace/$NAMESPACE" && "$out" != *$'\n'* ]] || return 2
}

sanitize_preview_namespace() {
  local failed=0 resource listed name rc
  if namespace_exists_admin; then
    :
  else
    rc=$?
    (( rc == 1 )) && return 0
    return 1
  fi
  for resource in deployments.apps statefulsets.apps; do
    listed=$("${AK[@]}" -n "$NAMESPACE" get "$resource" -o name 2>/dev/null) || { failed=1; listed=''; }
    while IFS= read -r name; do
      if [[ -n "$name" ]]; then "${AK[@]}" -n "$NAMESPACE" scale "$name" --replicas=0 >/dev/null 2>&1 || failed=1; fi
    done <<<"$listed"
  done
  for resource in \
    deployments.apps statefulsets.apps daemonsets.apps replicasets.apps replicationcontrollers horizontalpodautoscalers.autoscaling jobs.batch cronjobs.batch pods services \
    ingresses.networking.k8s.io networkpolicies.networking.k8s.io configmaps serviceaccounts \
    roles.rbac.authorization.k8s.io rolebindings.rbac.authorization.k8s.io resourcequotas limitranges \
    leases.coordination.k8s.io; do
    "${AK[@]}" -n "$NAMESPACE" delete "$resource" --all --ignore-not-found --wait=true --timeout=180s >/dev/null 2>&1 || failed=1
  done
  (( failed == 0 )) || return 1
}

write_writers_fence() {
  local value=$1 candidate
  install -d -o root -g root -m 0711 /var/lib/combo-dev
  verify_control_state || return 1
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

fence_all_writers_admin() {
  local failed=0 controller resource listed desired current rc pods
  if namespace_exists_admin; then
    :
  else
    rc=$?
    (( rc == 1 )) && return 0
    return 1
  fi

  listed=$("${AK[@]}" -n "$NAMESPACE" get deployments.apps,statefulsets.apps -o name 2>/dev/null) || return 1
  while IFS= read -r controller; do
    [[ -z "$controller" ]] && continue
    [[ "$controller" =~ ^(deployment|statefulset)\.apps/[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]] || return 1
    "${AK[@]}" -n "$NAMESPACE" scale "$controller" --replicas=0 >/dev/null 2>&1 || failed=1
  done <<<"$listed"
  for resource in \
    horizontalpodautoscalers.autoscaling cronjobs.batch daemonsets.apps jobs.batch \
    replicationcontrollers replicasets.apps; do
    "${AK[@]}" -n "$NAMESPACE" delete "$resource" --all --ignore-not-found \
      --wait=true --timeout=180s >/dev/null 2>&1 || failed=1
  done
  "${AK[@]}" -n "$NAMESPACE" delete pods --all --ignore-not-found \
    --wait=true --timeout=180s >/dev/null 2>&1 || failed=1

  while IFS= read -r controller; do
    [[ -z "$controller" ]] && continue
    timeout 180 "${AK[@]}" --request-timeout=0 -n "$NAMESPACE" rollout status \
      "$controller" --timeout=170s >/dev/null 2>&1 || failed=1
    desired=$("${AK[@]}" -n "$NAMESPACE" get "$controller" -o jsonpath='{.spec.replicas}' 2>/dev/null) || { failed=1; continue; }
    current=$("${AK[@]}" -n "$NAMESPACE" get "$controller" -o jsonpath='{.status.replicas}' 2>/dev/null) || { failed=1; continue; }
    [[ "$desired" == 0 && ( -z "$current" || "$current" == 0 ) ]] || failed=1
  done <<<"$listed"
  pods=$("${AK[@]}" -n "$NAMESPACE" get pods -o name 2>/dev/null) || failed=1
  [[ -z "$pods" ]] || failed=1
  return "$failed"
}

credential_certificate_valid_for() {
  local kubeconfig=$1 minimum_seconds=$2 certificate rc
  private_file "$kubeconfig" || return 1
  certificate=$(mktemp "$WORK/client-cert.XXXXXX") || return 1
  if ! kubectl --kubeconfig "$kubeconfig" config view --raw --flatten --minify \
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

dispatcher_certificate_valid_for() { credential_certificate_valid_for "$DISPATCHER_KUBECONFIG" "$1"; }
fencer_certificate_valid_for() { credential_certificate_valid_for "$FENCER_KUBECONFIG" "$1"; }

dispatcher_credential_valid() {
  local minimum_seconds=${1:-$DISPATCHER_OPERATION_MIN_SECONDS}
  dispatcher_certificate_valid_for "$minimum_seconds" || return 1
  can_i_dispatcher yes patch deployments.apps "$NAMESPACE" || return 1
  can_i_dispatcher yes patch jobs.batch "$NAMESPACE" || return 1
  can_i_dispatcher yes get "storageclasses.storage.k8s.io/$STORAGE_CLASS" || return 1
  can_i_dispatcher yes list namespaces || return 1
  can_i_dispatcher yes list roles.rbac.authorization.k8s.io "$NAMESPACE" || return 1
  can_i_dispatcher yes list rolebindings.rbac.authorization.k8s.io "$NAMESPACE" || return 1
  can_i_dispatcher yes list daemonsets.apps "$NAMESPACE" || return 1
  can_i_dispatcher yes list replicasets.apps "$NAMESPACE" || return 1
  can_i_dispatcher yes list replicationcontrollers "$NAMESPACE" || return 1
  can_i_dispatcher yes list cronjobs.batch "$NAMESPACE" || return 1
  can_i_dispatcher yes list ingresses.networking.k8s.io "$NAMESPACE" || return 1
  can_i_dispatcher yes list horizontalpodautoscalers.autoscaling "$NAMESPACE" || return 1
  can_i_dispatcher yes delete daemonsets.apps "$NAMESPACE" || return 1
  can_i_dispatcher yes delete replicasets.apps "$NAMESPACE" || return 1
  can_i_dispatcher yes delete replicationcontrollers "$NAMESPACE" || return 1
  can_i_dispatcher yes delete cronjobs.batch "$NAMESPACE" || return 1
  can_i_dispatcher yes delete horizontalpodautoscalers.autoscaling "$NAMESPACE" || return 1
  can_i_dispatcher yes list serviceaccounts "$NAMESPACE" || return 1
  can_i_dispatcher yes list resourcequotas "$NAMESPACE" || return 1
  can_i_dispatcher yes list limitranges "$NAMESPACE" || return 1
  can_i_dispatcher yes list clusterroles.rbac.authorization.k8s.io || return 1
  can_i_dispatcher yes list clusterrolebindings.rbac.authorization.k8s.io || return 1
  can_i_dispatcher yes get persistentvolumes/combo-dev-postgres || return 1
  can_i_dispatcher yes get persistentvolumes/combo-dev-redis-queue || return 1
  can_i_dispatcher yes get persistentvolumes/combo-dev-minio || return 1
  can_i_dispatcher no list persistentvolumes || return 1
  can_i_dispatcher no patch deployments.apps "$PRODUCTION_NAMESPACE" || return 1
  can_i_dispatcher no get secrets "$NAMESPACE" || return 1
  can_i_dispatcher no list secrets "$NAMESPACE" || return 1
  can_i_dispatcher no delete secrets/combo-dev-env "$NAMESPACE" || return 1
  can_i_dispatcher no patch secrets/combo-dev-env "$NAMESPACE" || return 1
  can_i_dispatcher no create pods "$NAMESPACE" || return 1
}

fencer_credential_valid() {
  local minimum_seconds=${1:-$DISPATCHER_OPERATION_MIN_SECONDS} name
  fencer_certificate_valid_for "$minimum_seconds" || return 1
  for name in api worker runtime web redis-hot; do
    can_i_fencer yes get "deployments.apps/$name" "$NAMESPACE" || return 1
    can_i_fencer yes patch "deployments.apps/$name" "$NAMESPACE" scale || return 1
  done
  for name in postgres redis-queue minio; do
    can_i_fencer yes get "statefulsets.apps/$name" "$NAMESPACE" || return 1
    can_i_fencer yes patch "statefulsets.apps/$name" "$NAMESPACE" scale || return 1
  done
  can_i_fencer yes delete jobs.batch/migrate "$NAMESPACE" || return 1
  can_i_fencer yes list pods "$NAMESPACE" || return 1
  can_i_fencer yes delete pods "$NAMESPACE" || return 1
  can_i_fencer no list deployments.apps "$NAMESPACE" || return 1
  can_i_fencer no patch deployments.apps/api "$NAMESPACE" || return 1
  can_i_fencer no update deployments.apps/api "$NAMESPACE" scale || return 1
  can_i_fencer no create deployments.apps "$NAMESPACE" || return 1
  can_i_fencer no get secrets "$NAMESPACE" || return 1
  can_i_fencer no patch deployments.apps/api "$PRODUCTION_NAMESPACE" scale || return 1
}

issue_client_credential() {
  local username=$1 days=$2 output=$3
  local tls="$K3S_DATA_DIR/server/tls" temp server server_ca_data cert_path key_path cert_data key_data serial out
  [[ "$username" == combo-dev-dispatcher || "$username" == combo-dev-fencer ]] || return 1
  [[ "$days" =~ ^[0-9]+$ ]] || return 1
  [[ -f "$tls/client-ca.crt" && -f "$tls/client-ca.key" ]] || return 1
  root_owned_not_writable "$tls/client-ca.crt" || return 1
  private_file "$tls/client-ca.key" || return 1
  openssl x509 -in "$tls/client-ca.crt" -noout >/dev/null 2>&1 || return 1
  temp=$(mktemp -d "$WORK/credential.XXXXXX") || return 1
  key_path="$temp/client.key"; cert_path="$temp/client.crt"
  openssl genrsa -out "$key_path" 3072 >/dev/null 2>&1 || return 1
  openssl req -new -key "$key_path" -subj "/CN=$username" -out "$temp/client.csr" >/dev/null 2>&1 || return 1
  serial="0x$(openssl rand -hex 16)"
  openssl x509 -req -in "$temp/client.csr" -CA "$tls/client-ca.crt" -CAkey "$tls/client-ca.key" \
    -set_serial "$serial" -days "$days" -sha256 -out "$cert_path" >/dev/null 2>&1 || return 1
  server=$("${AK[@]}" config view --raw --flatten --minify -o jsonpath='{.clusters[0].cluster.server}' 2>/dev/null) || return 1
  [[ "$server" == https://* ]] || return 1
  server_ca_data=$("${AK[@]}" config view --raw --flatten --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' 2>/dev/null) || return 1
  [[ "$server_ca_data" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || return 1
  printf '%s' "$server_ca_data" | base64 -d >"$temp/server-ca.crt" 2>/dev/null || return 1
  openssl x509 -in "$temp/server-ca.crt" -noout >/dev/null 2>&1 || return 1
  cert_data=$(base64 -w0 <"$cert_path")
  key_data=$(base64 -w0 <"$key_path")
  out="$WORK/$username.kubeconfig"
  cat >"$out" <<EOF
apiVersion: v1
kind: Config
clusters:
  - name: k3s
    cluster:
      server: $server
      certificate-authority-data: $server_ca_data
users:
  - name: $username
    user:
      client-certificate-data: $cert_data
      client-key-data: $key_data
contexts:
  - name: combo-dev
    context:
      cluster: k3s
      user: $username
      namespace: combo-preview
current-context: combo-dev
EOF
  chmod 600 "$out"
  install -m 0600 "$out" "$output" || return 1
  rm -rf -- "$temp"
}

provision_dispatcher_credential() {
  dispatcher_credential_valid "$DISPATCHER_RENEW_BEFORE_SECONDS" && return
  issue_client_credential combo-dev-dispatcher 90 "$DISPATCHER_KUBECONFIG" || return 1
  dispatcher_credential_valid
}

provision_fencer_credential() {
  fencer_credential_valid "$FENCER_RENEW_BEFORE_SECONDS" && return
  issue_client_credential combo-dev-fencer 365 "$FENCER_KUBECONFIG" || return 1
  fencer_credential_valid
}

apply_secret_without_output() {
  local name=$1 type=$2 source_arg=$3
  local args=(create secret generic "$name")
  [[ -z "$type" ]] || args+=("$type")
  args+=("$source_arg" --dry-run=client -o yaml)
  "${AK[@]}" -n "$NAMESPACE" "${args[@]}" 2>/dev/null |
    "${AK[@]}" apply --server-side --field-manager=combo-dev-bootstrap -f - >/dev/null 2>&1
}

provision_secrets() {
  bootstrap_boundary env-secret-apply apply_secret_without_output \
    combo-dev-env '' "--from-env-file=$CONFIG_FILE" || blocked '开发环境 Secret 写入失败。'
  bootstrap_boundary registry-secret-apply apply_secret_without_output \
    combo-dev-registry '--type=kubernetes.io/dockerconfigjson' \
    "--from-file=.dockerconfigjson=$REGISTRY_FILE" || blocked '只读仓库 Secret 写入失败。'
}

control_tree_digest() {
  local rel
  (
    cd "$ROOT"
    for rel in "${CONTROL_FILES[@]}"; do
      [[ -f "$rel" ]] || exit 2
      sha256sum "$rel" | awk '{print $1}'
    done
  ) | sha256sum | awk '{print $1}'
}

install_control_files() {
  [[ -f "$WORK/cluster-platform.canonical.json" ]] || blocked '缺少规范化集群平台契约。'
  verify_control_state || blocked '安装控制文件前 control-state 或兼容 bind 契约失效。'
  install -d -o root -g root -m 0755 /opt/combo-dev /opt/combo-dev/bin /opt/combo-dev/share
  install -d -o root -g root -m 0755 /etc/logrotate.d
  install -d -o root -g root -m 0711 /var/lib/combo-dev
  install -o root -g root -m 0600 "$WORK/cluster-platform.canonical.json" "$CLUSTER_PLATFORM_CONTRACT"
  rm -rf /opt/combo-dev/bootstrap-overlay.next /opt/combo-dev/bootstrap-foundation.next /opt/combo-dev/bootstrap-platform.next
  cp -R --no-preserve=all "$ROOT/infra/k8s/overlays/combo-dev" /opt/combo-dev/bootstrap-overlay.next
  cp -R --no-preserve=all /opt/combo-dev/bootstrap-overlay.next/foundation /opt/combo-dev/bootstrap-foundation.next
  install -d -o root -g root -m 0755 /opt/combo-dev/bootstrap-platform.next
  for file in namespace.yaml rbac.yaml storage-class.yaml storage-volumes.yaml; do
    install -m 0644 "/opt/combo-dev/bootstrap-overlay.next/platform/$file" "/opt/combo-dev/bootstrap-platform.next/$file"
  done
  chown -R root:root /opt/combo-dev/bootstrap-overlay.next /opt/combo-dev/bootstrap-foundation.next /opt/combo-dev/bootstrap-platform.next
  chmod -R u=rwX,go=rX /opt/combo-dev/bootstrap-overlay.next /opt/combo-dev/bootstrap-foundation.next /opt/combo-dev/bootstrap-platform.next
  rm -rf /opt/combo-dev/bootstrap-overlay /opt/combo-dev/bootstrap-foundation /opt/combo-dev/bootstrap-platform
  mv /opt/combo-dev/bootstrap-overlay.next /opt/combo-dev/bootstrap-overlay
  mv /opt/combo-dev/bootstrap-foundation.next /opt/combo-dev/bootstrap-foundation
  mv /opt/combo-dev/bootstrap-platform.next /opt/combo-dev/bootstrap-platform
  install -m 0755 "$ROOT/scripts/combo-dev-bootstrap.sh" /opt/combo-dev/bin/combo-dev-bootstrap
  install -m 0755 "$ROOT/scripts/combo-dev-deploy.sh" /opt/combo-dev/bin/combo-dev-deploy
  install -m 0755 "$ROOT/scripts/combo-dev-smoke.sh" /opt/combo-dev/bin/combo-dev-smoke
  install -m 0755 "$ROOT/scripts/combo-dev-logs.sh" /opt/combo-dev/bin/combo-dev-logs
  install -m 0755 "$ROOT/scripts/combo-dev-reset.sh" /opt/combo-dev/bin/combo-dev-reset
  install -m 0755 "$ROOT/scripts/combo-dev-forwarder-lease.sh" /opt/combo-dev/bin/combo-dev-forwarder-lease
  install -m 0755 "$ROOT/scripts/combo-dev-storage-guard.sh" /opt/combo-dev/bin/combo-dev-storage-guard
  install -m 0755 "$ROOT/scripts/combo-dev-production-safety.py" /opt/combo-dev/bin/combo-dev-production-safety
  install -m 0755 "$ROOT/infra/host/combo-dev/combo-dev-prepare-control-state.sh" /opt/combo-dev/bin/combo-dev-prepare-control-state
  install -m 0755 "$ROOT/infra/host/combo-dev/combo-host-prepare-data-anchor.sh" /opt/combo-dev/bin/combo-host-prepare-data-anchor
  install -m 0755 "$ROOT/infra/host/combo-dev/combo-host-data-mount-check.sh" /opt/combo-dev/bin/combo-host-data-mount-check
  install -m 0644 "$ROOT/infra/host/combo-dev/combo-dev-web-forward.service" /etc/systemd/system/combo-dev-web-forward.service
  install -m 0644 "$ROOT/infra/host/combo-dev/combo-dev-s3-forward.service" /etc/systemd/system/combo-dev-s3-forward.service
  install -m 0644 "$ROOT/infra/host/combo-dev/combo-dev-storage-guard.service" /etc/systemd/system/combo-dev-storage-guard.service
  install -m 0644 "$ROOT/infra/host/combo-dev/combo-dev-storage-guard.timer" /etc/systemd/system/combo-dev-storage-guard.timer
  install -m 0644 "$ROOT/infra/host/combo-dev/var-lib-combo\x2dhost\x2ddata.mount" '/etc/systemd/system/var-lib-combo\x2dhost\x2ddata.mount'
  install -m 0644 "$ROOT/infra/host/combo-dev/combo-host-data-mount-check.service" /etc/systemd/system/combo-host-data-mount-check.service
  install -m 0644 "$ROOT/infra/host/combo-dev/opt-combo\x2ddev-state.mount" '/etc/systemd/system/opt-combo\x2ddev-state.mount'
  install -m 0644 "$ROOT/infra/host/combo-dev/opt-combo\x2ddev-incoming.mount" '/etc/systemd/system/opt-combo\x2ddev-incoming.mount'
  install -m 0644 "$ROOT/infra/host/combo-dev/opt-combo\x2ddev-releases.mount" '/etc/systemd/system/opt-combo\x2ddev-releases.mount'
  install -m 0644 "$ROOT/infra/host/combo-dev/var-lib-combo\x2ddev-evidence.mount" '/etc/systemd/system/var-lib-combo\x2ddev-evidence.mount'
  install -o root -g root -m 0644 "$ROOT/infra/host/combo-dev/combo-host-syslog" /etc/logrotate.d/combo-host-syslog
  local digest installed_digest tmp file
  local installed_files=(
    /opt/combo-dev/bin/combo-dev-bootstrap
    /opt/combo-dev/bin/combo-dev-deploy
    /opt/combo-dev/bin/combo-dev-smoke
    /opt/combo-dev/bin/combo-dev-logs
    /opt/combo-dev/bin/combo-dev-reset
    /opt/combo-dev/bin/combo-dev-forwarder-lease
    /opt/combo-dev/bin/combo-dev-storage-guard
    /opt/combo-dev/bin/combo-dev-production-safety
    /opt/combo-dev/bin/combo-dev-prepare-control-state
    /opt/combo-dev/bin/combo-host-prepare-data-anchor
    /opt/combo-dev/bin/combo-host-data-mount-check
    /etc/systemd/system/combo-dev-web-forward.service
    /etc/systemd/system/combo-dev-s3-forward.service
    /etc/systemd/system/combo-dev-storage-guard.service
    /etc/systemd/system/combo-dev-storage-guard.timer
    '/etc/systemd/system/var-lib-combo\x2dhost\x2ddata.mount'
    /etc/systemd/system/combo-host-data-mount-check.service
    '/etc/systemd/system/opt-combo\x2ddev-state.mount'
    '/etc/systemd/system/opt-combo\x2ddev-incoming.mount'
    '/etc/systemd/system/opt-combo\x2ddev-releases.mount'
    '/etc/systemd/system/var-lib-combo\x2ddev-evidence.mount'
    /etc/logrotate.d/combo-host-syslog
    /opt/combo-dev/bootstrap-overlay/kustomization.yaml
    /opt/combo-dev/bootstrap-overlay/platform/kustomization.yaml
    /opt/combo-dev/bootstrap-overlay/platform/limit-range.yaml
    /opt/combo-dev/bootstrap-overlay/platform/namespace.yaml
    /opt/combo-dev/bootstrap-overlay/platform/network-policies.yaml
    /opt/combo-dev/bootstrap-overlay/platform/quota.yaml
    /opt/combo-dev/bootstrap-overlay/platform/rbac.yaml
    /opt/combo-dev/bootstrap-overlay/platform/storage-class.yaml
    /opt/combo-dev/bootstrap-overlay/platform/storage-volumes.yaml
    /opt/combo-dev/bootstrap-overlay/foundation/kustomization.yaml
    /opt/combo-dev/bootstrap-overlay/foundation/postgres-entrypoint.sh
    /opt/combo-dev/bootstrap-overlay/foundation/resources.yaml
    /opt/combo-dev/bootstrap-overlay/init/kustomization.yaml
    /opt/combo-dev/bootstrap-overlay/init/minio-app-policy.json
    /opt/combo-dev/bootstrap-overlay/init/resources.yaml
    /opt/combo-dev/bootstrap-overlay/migrate/kustomization.yaml
    /opt/combo-dev/bootstrap-overlay/migrate/resources.yaml
    /opt/combo-dev/bootstrap-overlay/apps/kustomization.yaml
    /opt/combo-dev/bootstrap-overlay/apps/nginx-dev.conf
    /opt/combo-dev/bootstrap-overlay/apps/resources.yaml
  )
  digest=$(control_tree_digest) || blocked '控制文件清单不完整。'
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || blocked '控制文件摘要不合法。'
  installed_digest=$(for file in "${installed_files[@]}"; do sha256sum "$file" | awk '{print $1}'; done | sha256sum | awk '{print $1}')
  [[ "$installed_digest" == "$digest" ]] || blocked '安装后的控制文件摘要不一致。'
  tmp="$WORK/control-files.sha256"
  printf '%s\n' "$digest" >"$tmp"
  chmod 600 "$tmp"
  install -m 0600 "$tmp" /etc/combo-dev/control-files.sha256
  timeout 30 systemctl daemon-reload >/dev/null 2>&1 || blocked 'systemd 配置刷新失败。'
  timeout 30 systemctl disable combo-dev-web-forward.service combo-dev-s3-forward.service >/dev/null 2>&1 || true
  timeout 30 systemctl stop combo-dev-web-forward.service combo-dev-s3-forward.service >/dev/null 2>&1 || true
  # 先停用计时器并串行完成首次检查，再启动一分钟周期，避免两个 guard 并发收敛同一批凭据和写入者。
  timeout 30 systemctl disable --now combo-dev-storage-guard.timer >/dev/null 2>&1 || true
  timeout 30 systemctl reset-failed combo-dev-storage-guard.service >/dev/null 2>&1 || true
  timeout 30 systemctl start combo-dev-storage-guard.service >/dev/null 2>&1 || blocked '存储低水位守卫首次检查失败。'
  timeout 30 systemctl enable --now combo-dev-storage-guard.timer >/dev/null 2>&1 || blocked '持续存储低水位守卫无法启用。'
  local enabled active
  for unit in combo-dev-web-forward.service combo-dev-s3-forward.service; do
    enabled=$(timeout 10 systemctl is-enabled "$unit" 2>/dev/null || true)
    [[ "$enabled" == disabled || "$enabled" == static ]] || blocked '回环转发器被配置为开机启动。'
    active=$(timeout 10 systemctl is-active "$unit" 2>/dev/null || true)
    [[ "$active" == inactive || "$active" == failed ]] || blocked 'bootstrap 后回环转发器仍在运行。'
  done
  storage_guard_timer_ready || blocked '存储守卫计时器没有启用、激活或安排下一次检查。'
}

production_fingerprint() {
  local raw="$WORK/prod.$RANDOM.json" canonical="$WORK/prod.$RANDOM.canonical"
  kubectl --request-timeout=30s --kubeconfig "$PRODUCTION_KUBECONFIG" -n "$PRODUCTION_NAMESPACE" get deployments.apps,statefulsets.apps,services,persistentvolumeclaims,pods -o json >"$raw" 2>/dev/null || blocked '生产指纹读取失败。'
  python3 "$ROOT/scripts/combo-dev-production-safety.py" canonicalize-production \
    --input "$raw" --output "$canonical" >/dev/null 2>&1 || blocked '生产指纹规范化失败。'
  sha256sum "$canonical" | awk '{print $1}'
}

verify_observer_boundary() {
  python3 "$ROOT/scripts/combo-dev-production-safety.py" verify-observer \
    --audit-kubeconfig "$ADMIN_KUBECONFIG" \
    --observer-kubeconfig "$PRODUCTION_KUBECONFIG" \
    --production-namespace "$PRODUCTION_NAMESPACE" \
    --work-dir "$WORK/observer-audit" >/dev/null 2>&1 || blocked '生产观察身份不符合精确只读边界。'
}

check_static_storage_guard() {
  "$ROOT/scripts/combo-dev-storage-guard.sh" --check-only >/dev/null 2>&1
}

write_bootstrap_approvals() {
  printf '%s\n' 'combo-preview=canonical-and-disposable' > /etc/combo-dev/preview-takeover.approved
  printf '%s\n' 'combo-dev=development-identities-only' > /etc/combo-dev/credential-separation.approved
  chmod 600 /etc/combo-dev/preview-takeover.approved /etc/combo-dev/credential-separation.approved
}

bootstrap_mutations() {
  MUTATING=1
  mark_failure_fence || blocked '无法写入持久失败收敛标记。'
  stop_forwarders || blocked '无法在 bootstrap 前关闭并验证回环转发器。'
  fence_all_writers_admin || blocked '无法在 bootstrap 前关闭并验证全部写入者。'

  bootstrap_boundary sanitize-preview sanitize_preview_namespace || blocked '旧 preview 资源未能完整清理。'
  bootstrap_boundary legacy-storage-cleanup cleanup_legacy_preview_storage_admin || blocked '旧 preview 三卷数据无法安全清理。'
  bootstrap_boundary namespace-apply "${AK[@]}" apply \
    -f "$ROOT/infra/k8s/overlays/combo-dev/platform/namespace.yaml" >/dev/null 2>&1 ||
    blocked 'preview 命名空间应用失败。'
  bootstrap_boundary static-storage-paths prepare_static_storage_paths || blocked '静态卷主机目录无法建立。'
  check_static_storage_guard || blocked '静态存储路径或安全水位校验失败。'
  bootstrap_boundary static-storage-bindings install_static_storage_bindings_admin || blocked '静态 PV/PVC 绑定失败。'
  bootstrap_boundary rbac-apply "${AK[@]}" apply \
    -f "$ROOT/infra/k8s/overlays/combo-dev/platform/rbac.yaml" >/dev/null 2>&1 ||
    blocked '命名空间调度与最小失败收敛 RBAC 应用失败。'
  bootstrap_boundary fencer-credential provision_fencer_credential || blocked '独立最小失败收敛凭据无法建立。'
  bootstrap_boundary dispatcher-credential provision_dispatcher_credential || blocked '命名空间调度凭据无法建立。'
  bootstrap_boundary approval-files write_bootstrap_approvals || blocked '开发环境批准状态无法写入。'
  bootstrap_boundary platform-apply "${AK[@]}" apply --server-side \
    --field-manager=combo-dev-dispatcher --force-conflicts \
    -k "$ROOT/infra/k8s/overlays/combo-dev/platform" >/dev/null 2>&1 ||
    blocked '平台配额与网络策略应用失败。'

  dispatcher_credential_valid || blocked '清理后的命名空间调度凭据失效。'
  fencer_credential_valid || blocked '独立最小失败收敛凭据失效。'
  static_storage_is_valid_admin "$NODE_HOSTNAME" || blocked 'bootstrap 后静态 PV/PVC 绑定发生漂移。'
  verify_cluster_platform_admin || blocked 'bootstrap 后集群级平台对象不符合规范契约。'
  bootstrap_boundary development-secrets provision_secrets || blocked '开发 Secret 无法完整建立。'
  bootstrap_boundary control-files-install install_control_files || blocked 'root-owned 控制文件无法完整安装。'
}

main() {
  local approve_data=0 approve_credentials=0 arg
  while (($#)); do
    arg=$1; shift
    case "$arg" in
      --approve-disposable-preview-data) approve_data=1 ;;
      --approve-development-only-credentials) approve_credentials=1 ;;
      *) fail '未知参数。' ;;
    esac
  done
  (( approve_data == 1 )) || blocked '必须由主机所有者明确批准 preview 数据可丢弃。'
  (( approve_credentials == 1 )) || blocked '必须由主机所有者明确批准全部凭据仅供开发使用。'

  ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
  ADMIN_KUBECONFIG=${COMBO_DEV_ADMIN_KUBECONFIG:-$ADMIN_KUBECONFIG_DEFAULT}
  private_file "$K3S_DATA_DIR_FILE" || blocked 'k3s 数据目录配置必须由 root 独占读取。'
  K3S_DATA_DIR=$(cat "$K3S_DATA_DIR_FILE" 2>/dev/null || true)
  [[ -n "$K3S_DATA_DIR" && "$K3S_DATA_DIR" != *$'\n'* ]] || blocked 'k3s 数据目录配置不合法。'
  AK=(kubectl --request-timeout=30s --kubeconfig "$ADMIN_KUBECONFIG")
  exec 9>"$LOCK_FILE"
  flock -w 300 9 || blocked '另一个 combo-dev 操作长时间持有主机锁。'
  host_preflight
  WORK=$(mktemp -d "$CONTROL_WORK/bootstrap.XXXXXX") ||
    blocked '无法在 control-state 创建 bootstrap 工作区。'
  validate_config_names_only
  verify_observer_boundary
  local before after
  before=$(production_fingerprint)
  prepare_cluster_platform_contract
  classify_preview_storage_admin

  bootstrap_mutations
  fence_all_writers_admin || blocked 'bootstrap 后无法证明全部写入者保持关闭。'
  forwarders_stopped || blocked 'bootstrap 后无法证明回环转发器保持关闭。'
  after=$(production_fingerprint)
  [[ "$before" == "$after" ]] || fail 'bootstrap 期间生产指纹发生变化。'
  exec 8>"$FENCE_LOCK_FILE"
  flock -w 300 8 || blocked 'bootstrap 无法取得失败收敛锁。'
  rm -f -- "$EXTERNAL_FENCE_MARKER" "$ACCEPTANCE_PENDING_MARKER" ||
    blocked 'bootstrap 无法清理旧验收状态。'
  remove_all_reset_proofs || blocked 'bootstrap 无法清理旧 reset proof inventory。'
  mark_safe_idle_fence || blocked 'bootstrap 无法提交安全空闲写入阻断状态。'

  rm -rf --one-file-system -- "$WORK"
  WORK=''
  SUCCESS=1
  status 'PASS namespace=combo-preview forwarders=inactive writers=safe-idle'
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
