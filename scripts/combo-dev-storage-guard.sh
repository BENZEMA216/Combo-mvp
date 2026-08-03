#!/usr/bin/env bash
# 持续守护有界存储与两套调度凭据；失败时只用独立最小凭据关闭写入者，绝不自动恢复。
set -Eeuo pipefail
umask 077
export PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

readonly NAMESPACE='combo-preview'
readonly PRODUCTION_NAMESPACE='combo'
readonly DATA_MOUNT='/home/xingzheng/data'
readonly STORAGE_POOL='/home/xingzheng/data/combo-dev'
readonly STORAGE_SENTINEL='/home/xingzheng/data/combo-dev/.combo-dev-mounted'
readonly STORAGE_SENTINEL_STATE='combo-dev-storage-mount=v1'
readonly POSTGRES_STORAGE_PATH='/home/xingzheng/data/combo-dev/postgres/data'
readonly REDIS_QUEUE_STORAGE_PATH='/home/xingzheng/data/combo-dev/redis-queue/data'
readonly MINIO_STORAGE_PATH='/home/xingzheng/data/combo-dev/minio/data'
readonly STORAGE_MIN_BYTES=$((16 * 1024 * 1024 * 1024))
readonly STORAGE_MAX_BYTES=$((18 * 1024 * 1024 * 1024))
readonly MIN_FREE_BYTES=$((1024 * 1024 * 1024))
readonly MIN_FREE_INODES=4096
readonly CONTROL_STATE='/opt/combo-dev/state'
readonly CONTROL_STATE_PARENT='/var/lib/combo-host-data'
readonly CONTROL_STATE_IMAGE='/var/lib/combo-host-data/control-state.img'
readonly DATA_ANCHOR_CHECK='/opt/combo-dev/bin/combo-host-data-mount-check'
readonly CONTROL_STATE_SENTINEL='/opt/combo-dev/state/.combo-dev-control-state'
readonly CONTROL_STATE_SENTINEL_VALUE='combo-dev-control-state=v1'
readonly CONTROL_STATE_BYTES=4294967296
readonly CONTROL_STATE_LABEL='combo-dev-control-state'
readonly CONTROL_STATE_MIN_BYTES=$((3584 * 1024 * 1024))
readonly CONTROL_STATE_MAX_BYTES=$((4 * 1024 * 1024 * 1024))
readonly CONTROL_STATE_MIN_FREE_BYTES=$((1024 * 1024 * 1024))
readonly CONTROL_STATE_MIN_FREE_INODES=4096
readonly GUARD_RUNTIME='/run/combo-dev-storage-guard'
readonly ROOT_WARNING_MIN_BYTES=$((20 * 1024 * 1024 * 1024))
readonly ROOT_CRITICAL_MIN_BYTES=$((10 * 1024 * 1024 * 1024))
readonly DATA_WARNING_MIN_BYTES=$((30 * 1024 * 1024 * 1024))
readonly DATA_CRITICAL_MIN_BYTES=$((20 * 1024 * 1024 * 1024))
readonly ROOT_CRITICAL_MARKER='/var/lib/combo-dev/root-capacity-critical'
readonly ROOT_RECOVERY_MARKER='/var/lib/combo-dev/root-capacity-recovery-since'
readonly ROOT_RECOVERY_SECONDS=900
readonly DISPATCHER_KUBECONFIG='/etc/combo-dev/dispatcher.kubeconfig'
readonly FENCER_KUBECONFIG='/etc/combo-dev/fencer.kubeconfig'
readonly LOW_MARKER='/run/combo-dev-storage-low'
readonly FAILURE_FENCE_MARKER='/var/lib/combo-dev/writers-fenced'
readonly EXTERNAL_FENCE_MARKER='/var/lib/combo-dev/external-fence'
readonly MAINTENANCE_FENCE_MARKER='/var/lib/combo-dev/storage-maintenance-fenced'
readonly MAINTENANCE_FENCE_VALUE='combo-dev-storage-maintenance=fenced-v1'
readonly ACCEPTANCE_PENDING_MARKER='/var/lib/combo-dev/acceptance-pending'
readonly OPERATION_LOCK_FILE='/run/lock/combo-dev.lock'
readonly FENCE_LOCK_FILE='/run/lock/combo-dev-fence.lock'
readonly FORWARDER_LOCK_FILE='/run/lock/combo-dev-forwarders.lock'
readonly FORWARDER_LEASE_DIR='/run/combo-dev-forwarders'
readonly DISPATCHER_FENCE_BEFORE_SECONDS=$((7 * 24 * 60 * 60))
readonly FENCER_RENEW_BEFORE_SECONDS=$((30 * 24 * 60 * 60))
readonly FENCER_OPERATION_MIN_SECONDS=$((10 * 60))
readonly APPS=(api worker runtime web)
readonly FOUNDATION_STATEFUL=(postgres redis-queue minio)
readonly JOBS=(minio-init migrate combo-dev-network-canary)
readonly FORWARDER_UNITS=(combo-dev-web-forward.service combo-dev-s3-forward.service)
ROOT_CAPACITY_WARNING=0
ROOT_CAPACITY_CRITICAL=0
DATA_CAPACITY_WARNING=0
DATA_CAPACITY_CRITICAL=0
PENDING_REVISION=''
PENDING_RUN_ID=''
PENDING_RUN_ATTEMPT=''

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
if [[ -f "$SCRIPT_DIR/combo-dev-production-safety" ]]; then
  readonly SAFETY_TOOL="$SCRIPT_DIR/combo-dev-production-safety"
else
  readonly SAFETY_TOOL="$SCRIPT_DIR/combo-dev-production-safety.py"
fi
declare -ar FK=(kubectl --cache-dir="$GUARD_RUNTIME/kubectl-cache" --request-timeout=30s --kubeconfig "$FENCER_KUBECONFIG")
declare -ar DK=(kubectl --cache-dir="$GUARD_RUNTIME/kubectl-cache" --request-timeout=30s --kubeconfig "$DISPATCHER_KUBECONFIG")

status() { printf '[combo-dev-storage-guard] %s\n' "$1"; }
fail() { printf '[combo-dev-storage-guard] FAIL: %s\n' "$1" >&2; exit 1; }
require_command() { command -v "$1" >/dev/null 2>&1 || fail "缺少主机工具：$1"; }

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

max_threshold() {
  local total=$1 absolute=$2 percent=$3 proportional
  proportional=$((total * percent / 100))
  if (( proportional > absolute )); then printf '%s\n' "$proportional"; else printf '%s\n' "$absolute"; fi
}

verify_control_state() {
  local target source root_source data_source options total backing path fsroot fstype data_target root_device data_device
  [[ -x "$DATA_ANCHOR_CHECK" && ! -L "$DATA_ANCHOR_CHECK" &&
    $(stat -c '%u:%g:%a' "$DATA_ANCHOR_CHECK" 2>/dev/null) == '0:0:755' ]] || return 1
  "$DATA_ANCHOR_CHECK" >/dev/null 2>&1 || return 1
  [[ -d "$CONTROL_STATE" && ! -L "$CONTROL_STATE" &&
    $(readlink -f -- "$CONTROL_STATE" 2>/dev/null) == "$CONTROL_STATE" &&
    $(stat -c '%u:%g:%a' "$CONTROL_STATE" 2>/dev/null) == '0:0:700' ]] || return 1
  [[ -f "$CONTROL_STATE_SENTINEL" && ! -L "$CONTROL_STATE_SENTINEL" &&
    $(stat -c '%u:%g:%a' "$CONTROL_STATE_SENTINEL" 2>/dev/null) == '0:0:400' &&
    $(cat "$CONTROL_STATE_SENTINEL" 2>/dev/null || true) == "$CONTROL_STATE_SENTINEL_VALUE" ]] || return 1
  [[ -d "$CONTROL_STATE_PARENT" && ! -L "$CONTROL_STATE_PARENT" &&
    $(stat -c '%u:%g:%a' "$CONTROL_STATE_PARENT" 2>/dev/null) == '0:0:700' ]] || return 1
  [[ $(readlink -f -- "$CONTROL_STATE_PARENT" 2>/dev/null) == "$CONTROL_STATE_PARENT" ]] || return 1
  [[ -f "$CONTROL_STATE_IMAGE" && ! -L "$CONTROL_STATE_IMAGE" &&
    $(stat -c '%u:%g:%a' "$CONTROL_STATE_IMAGE" 2>/dev/null) == '0:0:600' ]] || return 1
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
  for path in incoming releases releases/.staging work evidence; do
    [[ -d "$CONTROL_STATE/$path" && ! -L "$CONTROL_STATE/$path" ]] || return 1
    [[ $(findmnt -rn -T "$CONTROL_STATE/$path" -o TARGET 2>/dev/null) == "$CONTROL_STATE" ]] || return 1
  done
  [[ $(stat -c '%u:%g:%a' "$CONTROL_STATE/incoming" 2>/dev/null) == '0:0:1733' ]] || return 1
  [[ $(stat -c '%u:%g:%a' "$CONTROL_STATE/releases" 2>/dev/null) == '0:0:755' ]] || return 1
  [[ $(stat -c '%u:%g:%a' "$CONTROL_STATE/releases/.staging" 2>/dev/null) == '0:0:700' ]] || return 1
  [[ $(stat -c '%u:%g:%a' "$CONTROL_STATE/work" 2>/dev/null) == '0:0:700' ]] || return 1
  [[ $(stat -c '%u:%g:%a' "$CONTROL_STATE/evidence" 2>/dev/null) == '0:0:755' ]] || return 1
  for path in /opt/combo-dev/incoming /opt/combo-dev/releases /var/lib/combo-dev/evidence; do
    [[ -d "$path" && ! -L "$path" && $(findmnt -rn -M "$path" -o TARGET 2>/dev/null) == "$path" ]] || return 1
    options=$(findmnt -rn -M "$path" -o OPTIONS 2>/dev/null) || return 1
    [[ ",$options," == *,rw,* && ",$options," == *,nodev,* && ",$options," == *,nosuid,* && ",$options," == *,noexec,* ]] || return 1
  done
  fsroot=$(findmnt -rn -M /opt/combo-dev/incoming -o FSROOT 2>/dev/null) || return 1
  [[ "$fsroot" == '/incoming' ]] || return 1
  fsroot=$(findmnt -rn -M /opt/combo-dev/releases -o FSROOT 2>/dev/null) || return 1
  [[ "$fsroot" == '/releases' ]] || return 1
  fsroot=$(findmnt -rn -M /var/lib/combo-dev/evidence -o FSROOT 2>/dev/null) || return 1
  [[ "$fsroot" == '/evidence' ]] || return 1
  [[ $(stat -c '%d:%i' /opt/combo-dev/incoming) == $(stat -c '%d:%i' "$CONTROL_STATE/incoming") ]] || return 1
  [[ $(stat -c '%d:%i' /opt/combo-dev/releases) == $(stat -c '%d:%i' "$CONTROL_STATE/releases") ]] || return 1
  [[ $(stat -c '%d:%i' /var/lib/combo-dev/evidence) == $(stat -c '%d:%i' "$CONTROL_STATE/evidence") ]] || return 1
}

control_headroom_ok() {
  local free inodes
  free=$(df -B1 --output=avail "$CONTROL_STATE" 2>/dev/null | awk 'NR==2 {print $1}') || return 1
  inodes=$(df --output=iavail "$CONTROL_STATE" 2>/dev/null | awk 'NR==2 {print $1}') || return 1
  [[ "$free" =~ ^[0-9]+$ && "$inodes" =~ ^[0-9]+$ ]] || return 1
  (( free >= CONTROL_STATE_MIN_FREE_BYTES && inodes >= CONTROL_STATE_MIN_FREE_INODES ))
}

classify_host_capacity() {
  local rf rt ri rit dfree dt di dit rw rc riw ric dw dc diw dic
  rf=$(df -B1 --output=avail / 2>/dev/null | awk 'NR==2 {print $1}') || return 1
  rt=$(df -B1 --output=size / 2>/dev/null | awk 'NR==2 {print $1}') || return 1
  ri=$(df --output=iavail / 2>/dev/null | awk 'NR==2 {print $1}') || return 1
  rit=$(df --output=inodes / 2>/dev/null | awk 'NR==2 {print $1}') || return 1
  dfree=$(df -B1 --output=avail "$DATA_MOUNT" 2>/dev/null | awk 'NR==2 {print $1}') || return 1
  dt=$(df -B1 --output=size "$DATA_MOUNT" 2>/dev/null | awk 'NR==2 {print $1}') || return 1
  di=$(df --output=iavail "$DATA_MOUNT" 2>/dev/null | awk 'NR==2 {print $1}') || return 1
  dit=$(df --output=inodes "$DATA_MOUNT" 2>/dev/null | awk 'NR==2 {print $1}') || return 1
  [[ "$rf" =~ ^[0-9]+$ && "$rt" =~ ^[0-9]+$ && "$ri" =~ ^[0-9]+$ && "$rit" =~ ^[0-9]+$ &&
    "$dfree" =~ ^[0-9]+$ && "$dt" =~ ^[0-9]+$ && "$di" =~ ^[0-9]+$ && "$dit" =~ ^[0-9]+$ ]] || return 1
  rw=$(max_threshold "$rt" "$ROOT_WARNING_MIN_BYTES" 15); rc=$(max_threshold "$rt" "$ROOT_CRITICAL_MIN_BYTES" 10)
  riw=$((rit * 15 / 100)); ric=$((rit * 10 / 100))
  dw=$(max_threshold "$dt" "$DATA_WARNING_MIN_BYTES" 15); dc=$(max_threshold "$dt" "$DATA_CRITICAL_MIN_BYTES" 10)
  diw=$((dit * 15 / 100)); dic=$((dit * 10 / 100))
  ROOT_CAPACITY_CRITICAL=0; ROOT_CAPACITY_WARNING=0; DATA_CAPACITY_CRITICAL=0; DATA_CAPACITY_WARNING=0
  (( rf < rc || ri < ric )) && ROOT_CAPACITY_CRITICAL=1
  (( rf < rw || ri < riw )) && ROOT_CAPACITY_WARNING=1
  (( dfree < dc || di < dic )) && DATA_CAPACITY_CRITICAL=1
  (( dfree < dw || di < diw )) && DATA_CAPACITY_WARNING=1
  return 0
}

verify_bounded_pool() {
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

verify_static_paths() {
  local key path uid gid marker_state parent marker canonical target metadata
  verify_bounded_pool || return 1
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

verify_k3s_mount_dependencies() {
  local mounts
  [[ -f "$SAFETY_TOOL" ]] || return 1
  mounts=$(timeout 15 systemctl show k3s.service -p RequiresMountsFor --value 2>/dev/null) || return 1
  printf '%s\n' "$mounts" | python3 "$SAFETY_TOOL" validate-mount-dependencies \
    --input /dev/stdin --data-mount "$DATA_MOUNT" --storage-pool "$STORAGE_POOL" >/dev/null 2>&1
}

headroom_ok() {
  local free inodes
  free=$(df -B1 --output=avail "$STORAGE_POOL" 2>/dev/null | awk 'NR==2 {print $1}') || return 1
  inodes=$(df --output=iavail "$STORAGE_POOL" 2>/dev/null | awk 'NR==2 {print $1}') || return 1
  [[ "$free" =~ ^[0-9]+$ && "$inodes" =~ ^[0-9]+$ ]] || return 1
  (( free >= MIN_FREE_BYTES && inodes >= MIN_FREE_INODES ))
}

credential_certificate_valid_for() {
  local kubeconfig=$1 username=$2 minimum_seconds=$3 work config certificate subject rc
  private_file "$kubeconfig" || return 1
  work=$(mktemp -d "$GUARD_RUNTIME/guard-credential.XXXXXX") || return 1
  config="$work/config.json"
  certificate="$work/client.crt"
  if ! kubectl --kubeconfig "$kubeconfig" config view --raw --flatten --minify -o json >"$config" 2>/dev/null; then
    rm -rf -- "$work"
    return 1
  fi
  chmod 600 "$config"
  if ! jq -e --arg user "$username" '
      (.clusters | length) == 1 and (.users | length) == 1 and (.contexts | length) == 1
      and .users[0].name == $user
      and (.users[0].user | keys | sort) == ["client-certificate-data","client-key-data"]
      and (.users[0].user."client-certificate-data" | type) == "string"
      and (.users[0].user."client-key-data" | type) == "string"
      and (.clusters[0].cluster.server | startswith("https://"))
      and (.clusters[0].cluster."certificate-authority-data" | type) == "string"
    ' "$config" >/dev/null 2>&1; then
    rm -rf -- "$work"
    return 1
  fi
  if ! jq -r '.users[0].user."client-certificate-data"' "$config" | base64 -d >"$certificate" 2>/dev/null; then
    rm -rf -- "$work"
    return 1
  fi
  chmod 600 "$certificate"
  set +e
  openssl x509 -in "$certificate" -noout -checkend "$minimum_seconds" >/dev/null 2>&1
  rc=$?
  subject=$(openssl x509 -in "$certificate" -noout -subject -nameopt RFC2253 2>/dev/null)
  set -e
  rm -rf -- "$work"
  [[ $rc == 0 && "$subject" == "subject=CN=$username" ]]
}

can_i() {
  local credential_name=$1 expected=$2 verb=$3 resource=$4 namespace=$5 subresource=${6:-} rc
  local credential=()
  local args=(auth can-i -q "$verb" "$resource" -n "$namespace")
  case "$credential_name" in
    DK) credential=("${DK[@]}") ;;
    FK) credential=("${FK[@]}") ;;
    *) return 2 ;;
  esac
  [[ -z "$subresource" ]] || args+=(--subresource="$subresource")
  set +e
  "${credential[@]}" "${args[@]}" >/dev/null 2>&1
  rc=$?
  set -e
  if [[ "$expected" == yes ]]; then [[ $rc == 0 ]]; else [[ $rc == 1 ]]; fi
}

dispatcher_access_valid() {
  can_i DK yes patch deployments.apps/api "$NAMESPACE" || return 1
  can_i DK yes delete jobs.batch/migrate "$NAMESPACE" || return 1
  can_i DK no get secrets "$NAMESPACE" || return 1
  can_i DK no patch deployments.apps "$PRODUCTION_NAMESPACE" || return 1
}

fencer_access_valid() {
  local name
  for name in "${APPS[@]}" redis-hot; do
    can_i FK yes get "deployments.apps/$name" "$NAMESPACE" || return 1
    can_i FK yes patch "deployments.apps/$name" "$NAMESPACE" scale || return 1
  done
  for name in "${FOUNDATION_STATEFUL[@]}"; do
    can_i FK yes get "statefulsets.apps/$name" "$NAMESPACE" || return 1
    can_i FK yes patch "statefulsets.apps/$name" "$NAMESPACE" scale || return 1
  done
  can_i FK yes delete jobs.batch/migrate "$NAMESPACE" || return 1
  can_i FK yes list pods "$NAMESPACE" || return 1
  can_i FK yes delete pods "$NAMESPACE" || return 1
  can_i FK no list deployments.apps "$NAMESPACE" || return 1
  can_i FK no patch deployments.apps/api "$NAMESPACE" || return 1
  can_i FK no update deployments.apps/api "$NAMESPACE" scale || return 1
  can_i FK no create deployments.apps "$NAMESPACE" || return 1
  can_i FK no get secrets "$NAMESPACE" || return 1
  can_i FK no patch deployments.apps/api "$PRODUCTION_NAMESPACE" scale || return 1
}

mark_failure_fence() {
  install -d -o root -g root -m 0711 /var/lib/combo-dev
  printf '%s\n' 'combo-dev-writers=fenced' >"$FAILURE_FENCE_MARKER"
  chmod 0600 "$FAILURE_FENCE_MARKER"
}

mark_external_fence() {
  local identity=$1
  if [[ "$identity" == system ]]; then
    printf '%s\n' 'system' >"$EXTERNAL_FENCE_MARKER"
  else
    [[ "$identity" =~ ^attempt\ [0-9a-f]{40}\ [1-9][0-9]*\ [1-9][0-9]*$ ]] ||
      return 1
    printf '%s\n' "$identity" >"$EXTERNAL_FENCE_MARKER"
  fi
  chmod 0600 "$EXTERNAL_FENCE_MARKER"
}

mark_maintenance_fence_complete() {
  local candidate
  [[ ! -e "$MAINTENANCE_FENCE_MARKER" && ! -L "$MAINTENANCE_FENCE_MARKER" ]] ||
    fail '主机存储维护完成标记已存在；必须先审计并完成或撤销上一轮维护。'
  candidate=$(mktemp "$GUARD_RUNTIME/storage-maintenance-fenced.XXXXXX") ||
    fail '无法创建主机存储维护完成标记。'
  printf '%s\n' "$MAINTENANCE_FENCE_VALUE" >"$candidate"
  chmod 0600 "$candidate"
  install -o root -g root -m 0600 "$candidate" "$MAINTENANCE_FENCE_MARKER" ||
    fail '无法持久化主机存储维护完成标记。'
  rm -f -- "$candidate"
}

existing_attempt_fence_identity() {
  local identity
  private_file "$EXTERNAL_FENCE_MARKER" || return 1
  identity=$(<"$EXTERNAL_FENCE_MARKER")
  [[ "$identity" =~ ^attempt\ [0-9a-f]{40}\ [1-9][0-9]*\ [1-9][0-9]*$ ]] || return 1
  printf '%s\n' "$identity"
}

stop_forwarders() {
  local failed=0 unit active
  exec 7>"$FORWARDER_LOCK_FILE"
  flock -w 30 7 || failed=1
  rm -rf -- "$FORWARDER_LEASE_DIR" || failed=1
  timeout 30 systemctl stop "${FORWARDER_UNITS[@]}" >/dev/null 2>&1 || failed=1
  for unit in "${FORWARDER_UNITS[@]}"; do
    active=$(timeout 10 systemctl is-active "$unit" 2>/dev/null || true)
    [[ "$active" == inactive || "$active" == failed ]] || failed=1
  done
  flock -u 7 >/dev/null 2>&1 || true
  return "$failed"
}

fencer_resource_exists() {
  local kind=$1 name=$2 out
  out=$("${FK[@]}" -n "$NAMESPACE" get "$kind/$name" --ignore-not-found -o name 2>/dev/null) || return 2
  [[ -z "$out" ]] && return 1
  [[ ${out##*/} == "$name" && "$out" != *$'\n'* ]] || return 2
}

scale_if_present() {
  local kind=$1 name=$2 rc
  if fencer_resource_exists "$kind" "$name"; then
    "${FK[@]}" -n "$NAMESPACE" scale "$kind/$name" --replicas=0 >/dev/null 2>&1
  else
    rc=$?
    (( rc == 1 ))
  fi
}

delete_jobs_and_pods() {
  local failed=0 name pods pod
  for name in "${JOBS[@]}"; do
    "${FK[@]}" -n "$NAMESPACE" delete "job/$name" --ignore-not-found --wait=false \
      >/dev/null 2>&1 || failed=1
    pods=$("${FK[@]}" -n "$NAMESPACE" get pods -l "job-name=$name" -o name 2>/dev/null) || {
      failed=1
      continue
    }
    while IFS= read -r pod; do
      [[ -n "$pod" && "$pod" =~ ^pod/[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]] || {
        [[ -z "$pod" ]] || failed=1
        continue
      }
      "${FK[@]}" -n "$NAMESPACE" delete "$pod" --wait=true --timeout=60s >/dev/null 2>&1 || failed=1
    done <<<"$pods"
  done
  return "$failed"
}

controller_zero_or_absent() {
  local kind=$1 name=$2 out rc
  out=$("${FK[@]}" -n "$NAMESPACE" get "$kind/$name" --ignore-not-found \
    -o jsonpath='{.metadata.name}:{.spec.replicas}:{.status.replicas}' 2>/dev/null) || return 1
  [[ -z "$out" ]] && return 0
  [[ "$out" == "$name:0:" || "$out" == "$name:0:0" ]] || return 1
  if fencer_resource_exists "$kind" "$name"; then return 0; else rc=$?; (( rc == 1 )); fi
}

jobs_and_pods_absent() {
  local name job pods
  for name in "${JOBS[@]}"; do
    job=$("${FK[@]}" -n "$NAMESPACE" get "job/$name" --ignore-not-found -o name 2>/dev/null) || return 1
    pods=$("${FK[@]}" -n "$NAMESPACE" get pods -l "job-name=$name" -o name 2>/dev/null) || return 1
    [[ -z "$job" && -z "$pods" ]] || return 1
  done
}

verify_writers_fenced() {
  local name
  for name in "${APPS[@]}" redis-hot; do controller_zero_or_absent deployment "$name" || return 1; done
  for name in "${FOUNDATION_STATEFUL[@]}"; do controller_zero_or_absent statefulset "$name" || return 1; done
  jobs_and_pods_absent
}

fence_writers_with_minimal_credential() {
  local failed=0 name
  delete_jobs_and_pods || failed=1
  for name in "${APPS[@]}" redis-hot; do scale_if_present deployment "$name" || failed=1; done
  for name in "${FOUNDATION_STATEFUL[@]}"; do scale_if_present statefulset "$name" || failed=1; done
  for _ in $(seq 1 60); do
    if verify_writers_fenced; then return "$failed"; fi
    sleep 2
  done
  return 1
}

fence_now_locked() {
  local reason=$1 low=${2:-0} terminal=${3:-1} identity=${4:-system} failed=0
  # 这两步不读取任何 Kubernetes 凭据，必须先于所有集群收敛动作。
  stop_forwarders || failed=1
  mark_failure_fence || fail "$reason，且持久阻断标记无法写入。"
  mark_external_fence "$identity" || fail "$reason，且外部阻断标记无法写入。"
  if (( low == 1 )); then install -o root -g root -m 0600 /dev/null "$LOW_MARKER" || failed=1; fi

  if ! credential_certificate_valid_for "$FENCER_KUBECONFIG" combo-dev-fencer "$FENCER_OPERATION_MIN_SECONDS"; then
    failed=1
  elif ! fencer_access_valid; then
    failed=1
  elif ! fence_writers_with_minimal_credential; then
    failed=1
  fi

  if (( failed != 0 )); then
    fail "$reason；回环入口已关闭且持久阻断已写入，但最小失败收敛无法完整验证。"
  fi
  if (( terminal == 1 )); then
    fail "$reason；回环入口与全部写入者已关闭，必须由主机所有者修复后重新 bootstrap。"
  fi
  status 'PASS writers=fenced forwarders=inactive'
}

fence_now() {
  local reason=$1 low=${2:-0} terminal=${3:-1} identity=${4:-system} existing_identity
  exec 8>"$FENCE_LOCK_FILE"
  flock -w 300 8 || fail "$reason，且无法取得失败收敛锁。"
  if [[ "$identity" == preserve-attempt ]]; then
    identity=system
    if existing_identity=$(existing_attempt_fence_identity); then
      identity=$existing_identity
    fi
  fi
  fence_now_locked "$reason" "$low" "$terminal" "$identity"
}

pending_acceptance_state() {
  local revision run_id run_attempt deadline extra now
  private_file "$ACCEPTANCE_PENDING_MARKER" || return 2
  IFS=' ' read -r revision run_id run_attempt deadline extra <"$ACCEPTANCE_PENDING_MARKER" ||
    return 2
  [[ -z "$extra" && "$revision" =~ ^[0-9a-f]{40}$ ]] || return 2
  [[ "$run_id" =~ ^[1-9][0-9]*$ && "$run_attempt" =~ ^[1-9][0-9]*$ ]] || return 2
  [[ "$deadline" =~ ^[1-9][0-9]*$ ]] || return 2
  now=$(date +%s 2>/dev/null) || return 2
  [[ "$now" =~ ^[1-9][0-9]*$ ]] || return 2
  PENDING_REVISION=$revision
  PENDING_RUN_ID=$run_id
  PENDING_RUN_ATTEMPT=$run_attempt
  (( now <= deadline ))
}

complete_acceptance() {
  local revision=$1 run_id=$2 run_attempt=$3
  local marker_revision marker_run_id marker_run_attempt deadline extra now
  [[ "$revision" =~ ^[0-9a-f]{40}$ ]] || fail '验收完成 revision 不合法。'
  [[ "$run_id" =~ ^[1-9][0-9]*$ && "$run_attempt" =~ ^[1-9][0-9]*$ ]] ||
    fail '验收完成 workflow identity 不合法。'
  exec 8>"$FENCE_LOCK_FILE"
  flock -w 300 8 || fail '无法取得验收完成锁。'
  private_file "$ACCEPTANCE_PENDING_MARKER" || fail '不存在 owner-only 的待验收标记。'
  IFS=' ' read -r marker_revision marker_run_id marker_run_attempt deadline extra \
    <"$ACCEPTANCE_PENDING_MARKER" || fail '待验收标记不可读。'
  [[ -z "$extra" && "$marker_revision" == "$revision" ]] ||
    fail '待验收标记 revision 不匹配。'
  [[ "$marker_run_id" == "$run_id" && "$marker_run_attempt" == "$run_attempt" ]] ||
    fail '待验收标记 workflow identity 不匹配。'
  [[ "$deadline" =~ ^[1-9][0-9]*$ ]] || fail '待验收标记期限不合法。'
  now=$(date +%s 2>/dev/null) || fail '验收完成时钟不可读。'
  (( now <= deadline )) || fail '待验收标记已经过期。'
  [[ ! -e "$FAILURE_FENCE_MARKER" && ! -L "$FAILURE_FENCE_MARKER" &&
    ! -e "$EXTERNAL_FENCE_MARKER" && ! -L "$EXTERNAL_FENCE_MARKER" ]] ||
    fail 'Test 已处于失败阻断状态。'
  rm -f -- "$ACCEPTANCE_PENDING_MARKER" || fail '无法原子完成 Test 验收。'
  status 'PASS acceptance=complete'
}

manage_root_health_recovery() {
  local now since
  if (( ROOT_CAPACITY_CRITICAL == 1 )); then
    install -o root -g root -m 0600 /dev/null "$ROOT_CRITICAL_MARKER" || return 2
    rm -f -- "$ROOT_RECOVERY_MARKER" || return 2
    return 1
  fi
  [[ -e "$ROOT_CRITICAL_MARKER" || -L "$ROOT_CRITICAL_MARKER" ]] || return 0
  [[ -f "$ROOT_CRITICAL_MARKER" && ! -L "$ROOT_CRITICAL_MARKER" &&
    $(stat -c '%u:%g:%a' "$ROOT_CRITICAL_MARKER" 2>/dev/null) == '0:0:600' ]] || return 2
  if (( ROOT_CAPACITY_WARNING == 1 )); then
    rm -f -- "$ROOT_RECOVERY_MARKER" || return 2
    return 1
  fi
  now=$(date +%s 2>/dev/null) || return 2
  [[ "$now" =~ ^[1-9][0-9]*$ ]] || return 2
  if [[ ! -e "$ROOT_RECOVERY_MARKER" && ! -L "$ROOT_RECOVERY_MARKER" ]]; then
    printf '%s\n' "$now" >"$ROOT_RECOVERY_MARKER" || return 2
    chmod 0600 "$ROOT_RECOVERY_MARKER" || return 2
    return 1
  fi
  private_file "$ROOT_RECOVERY_MARKER" || return 2
  since=$(<"$ROOT_RECOVERY_MARKER")
  [[ "$since" =~ ^[1-9][0-9]*$ && "$since" -le "$now" ]] || return 2
  if (( now - since < ROOT_RECOVERY_SECONDS )); then return 1; fi
  rm -f -- "$ROOT_CRITICAL_MARKER" "$ROOT_RECOVERY_MARKER" || return 2
  status 'root OS 容量已连续 15 分钟高于 warning 水位；仅解除健康标记，不自动恢复工作负载。'
}

main() {
  local check_only=0 fence_only=0 maintenance_fence=0 complete_only=0
  local fence_identity='system'
  local complete_revision='' complete_run_id='' complete_run_attempt='' cmd pending_rc
  case $# in
    0) ;;
    1)
      case $1 in
        --check-only) check_only=1 ;;
        --fence-only) fence_only=1 ;;
        --fence-host-maintenance) fence_only=1; maintenance_fence=1 ;;
        *) fail '参数不合法。' ;;
      esac
      ;;
    4)
      case $1 in
        --fence-attempt)
          [[ "$2" =~ ^[0-9a-f]{40}$ ]] || fail '失败收敛 revision 不合法。'
          [[ "$3" =~ ^[1-9][0-9]*$ && "$4" =~ ^[1-9][0-9]*$ ]] ||
            fail '失败收敛 workflow identity 不合法。'
          fence_only=1
          fence_identity="attempt $2 $3 $4"
          ;;
        --complete-acceptance)
          complete_only=1
          complete_revision=$2
          complete_run_id=$3
          complete_run_attempt=$4
          ;;
        *) fail '参数不合法。' ;;
      esac
      ;;
    *) fail '参数不合法。' ;;
  esac
  for cmd in findmnt readlink df awk dirname stat systemctl timeout python3 losetup blockdev blkid; do require_command "$cmd"; done
  [[ -f "$SAFETY_TOOL" ]] || fail '共享安全检查器不存在。'
  if (( check_only == 0 )); then
    [[ $(id -u) -eq 0 ]] || fail '存储收敛必须由 root 执行。'
    for cmd in kubectl install openssl base64 mktemp flock jq seq sleep rm date; do require_command "$cmd"; done
    install -d -o root -g root -m 0700 "$GUARD_RUNTIME"
    [[ -d "$GUARD_RUNTIME" && ! -L "$GUARD_RUNTIME" &&
      $(stat -c '%u:%g:%a' "$GUARD_RUNTIME") == '0:0:700' ]] ||
      fail '独立 storage guard 运行目录不可信。'
  fi
  if (( fence_only == 1 )); then
    if (( maintenance_fence == 1 )); then
      fence_now '受控 Test 主机存储维护' 0 0 system
      mark_maintenance_fence_complete
      status 'PASS storage-maintenance-fence=verified'
    else
      fence_now '受控 Test 后置验收未完成' 0 0 "$fence_identity"
    fi
    return
  fi
  if (( complete_only == 1 )); then
    complete_acceptance "$complete_revision" "$complete_run_id" "$complete_run_attempt"
    return
  fi

  if ! verify_control_state || ! verify_static_paths || ! verify_k3s_mount_dependencies; then
    (( check_only == 1 )) && fail 'control-state、业务存储、静态卷身份或 k3s 依赖不符合固定契约。'
    fence_now 'control-state、业务存储或 k3s 依赖失效' 1
  fi
  if ! control_headroom_ok; then
    (( check_only == 1 )) && fail 'control-state 低于字节或 inode 安全水位。'
    fence_now 'control-state 低于字节或 inode 安全水位' 1
  fi
  if ! headroom_ok; then
    (( check_only == 1 )) && fail '独立存储池低于字节或 inode 安全水位。'
    fence_now '独立存储池低于字节或 inode 安全水位' 1
  fi
  if ! classify_host_capacity; then
    (( check_only == 1 )) && fail '主机容量指标不可读。'
    fence_now '主机容量指标不可读'
  fi
  if (( DATA_CAPACITY_CRITICAL == 1 )); then
    (( check_only == 1 )) && fail '父数据盘低于 critical 字节或 inode 水位。'
    fence_now '父数据盘低于 critical 字节或 inode 水位' 1
  fi
  if (( ROOT_CAPACITY_CRITICAL == 1 )); then
    (( check_only == 1 )) && fail '根盘低于 OS critical 字节或 inode 水位。'
    manage_root_health_recovery >/dev/null 2>&1 || true
    fence_now '根盘低于 OS critical 字节或 inode 水位'
  fi
  if (( ROOT_CAPACITY_WARNING == 1 )); then status 'WARN root-os-headroom'; fi
  if (( DATA_CAPACITY_WARNING == 1 )); then status 'WARN parent-data-headroom'; fi
  if (( check_only == 1 )); then
    [[ ! -e "$ROOT_CRITICAL_MARKER" && ! -L "$ROOT_CRITICAL_MARKER" ]] ||
      fail '根盘 OS critical 健康标记仍在 15 分钟恢复观察期。'
    status 'PASS storage=data-backed headroom=available mount-dependency=canonical root-os=healthy-or-warning'
    return
  fi

  local root_recovery_rc
  set +e
  manage_root_health_recovery
  root_recovery_rc=$?
  set -e
  (( root_recovery_rc != 2 )) || fence_now '根盘 OS 健康恢复标记损坏'
  if (( root_recovery_rc == 1 )); then
    fence_now '根盘 OS 健康标记仍在 15 分钟恢复观察期' 0 0 preserve-attempt
    return
  fi

  credential_certificate_valid_for "$FENCER_KUBECONFIG" combo-dev-fencer "$FENCER_OPERATION_MIN_SECONDS" ||
    fence_now '独立最小失败收敛凭据缺失、损坏或已过期'
  fencer_access_valid || fence_now '独立最小失败收敛凭据无权关闭固定写入者'
  credential_certificate_valid_for "$FENCER_KUBECONFIG" combo-dev-fencer "$FENCER_RENEW_BEFORE_SECONDS" ||
    fence_now '独立最小失败收敛凭据进入预到期窗口'

  credential_certificate_valid_for "$DISPATCHER_KUBECONFIG" combo-dev-dispatcher "$DISPATCHER_FENCE_BEFORE_SECONDS" ||
    fence_now '调度凭据缺失、损坏或进入预到期窗口'
  dispatcher_access_valid || fence_now '调度凭据已失效或权限发生漂移'
  rm -f -- "$LOW_MARKER"

  if [[ -e "$FAILURE_FENCE_MARKER" ]]; then
    exec 9>"$OPERATION_LOCK_FILE"
    if flock -n 9; then
      fence_now '持久失败阻断标记仍然存在' 0 0 preserve-attempt
      return
    fi
    status 'PASS storage=bounded credentials=healthy operation=active'
    return
  fi
  if [[ -e "$ACCEPTANCE_PENDING_MARKER" || -L "$ACCEPTANCE_PENDING_MARKER" ]]; then
    exec 8>"$FENCE_LOCK_FILE"
    flock -w 300 8 || fail '无法取得待验收期限判定锁。'
    if [[ ! -e "$ACCEPTANCE_PENDING_MARKER" && ! -L "$ACCEPTANCE_PENDING_MARKER" ]]; then
      status 'PASS storage=static-local headroom=available credentials=healthy'
      return
    fi
    if pending_acceptance_state; then
      status 'PASS storage=bounded credentials=healthy acceptance=pending'
      return
    else
      pending_rc=$?
    fi
    if (( pending_rc == 1 )); then
      fence_now_locked 'Test 后置验收超过固定期限' 0 1 \
        "attempt $PENDING_REVISION $PENDING_RUN_ID $PENDING_RUN_ATTEMPT"
    else
      fence_now_locked 'Test 待验收标记损坏'
    fi
  fi
  status 'PASS storage=static-local headroom=available credentials=healthy'
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
