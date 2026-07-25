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
readonly DISPATCHER_KUBECONFIG='/etc/combo-dev/dispatcher.kubeconfig'
readonly FENCER_KUBECONFIG='/etc/combo-dev/fencer.kubeconfig'
readonly LOW_MARKER='/run/combo-dev-storage-low'
readonly FAILURE_FENCE_MARKER='/var/lib/combo-dev/writers-fenced'
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

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
if [[ -f "$SCRIPT_DIR/combo-dev-production-safety" ]]; then
  readonly SAFETY_TOOL="$SCRIPT_DIR/combo-dev-production-safety"
else
  readonly SAFETY_TOOL="$SCRIPT_DIR/combo-dev-production-safety.py"
fi
declare -ar FK=(kubectl --cache-dir=/tmp/kubectl-cache --request-timeout=30s --kubeconfig "$FENCER_KUBECONFIG")
declare -ar DK=(kubectl --cache-dir=/tmp/kubectl-cache --request-timeout=30s --kubeconfig "$DISPATCHER_KUBECONFIG")

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
  work=$(mktemp -d) || return 1
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
  install -d -o root -g root -m 0700 /var/lib/combo-dev
  printf '%s\n' 'combo-dev-writers=fenced' >"$FAILURE_FENCE_MARKER"
  chmod 0600 "$FAILURE_FENCE_MARKER"
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

fence_now() {
  local reason=$1 low=${2:-0} terminal=${3:-1} failed=0
  exec 8>"$FENCE_LOCK_FILE"
  flock -w 300 8 || fail "$reason，且无法取得失败收敛锁。"

  # 这两步不读取任何 Kubernetes 凭据，必须先于所有集群收敛动作。
  stop_forwarders || failed=1
  mark_failure_fence || fail "$reason，且持久阻断标记无法写入。"
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
  status 'PASS storage=bounded credentials=healthy writers=fenced forwarders=inactive'
}

main() {
  local check_only=0 cmd
  [[ $# -le 1 ]] || fail '参数数量不合法。'
  if [[ $# == 1 ]]; then
    [[ $1 == '--check-only' ]] || fail '未知参数。'
    check_only=1
  fi
  for cmd in findmnt readlink df awk dirname stat systemctl timeout python3; do require_command "$cmd"; done
  [[ -f "$SAFETY_TOOL" ]] || fail '共享安全检查器不存在。'
  if (( check_only == 0 )); then
    [[ $(id -u) -eq 0 ]] || fail '存储收敛必须由 root 执行。'
    for cmd in kubectl install openssl base64 mktemp flock jq seq sleep rm; do require_command "$cmd"; done
  fi

  if ! verify_static_paths || ! verify_k3s_mount_dependencies; then
    (( check_only == 1 )) && fail '独立挂载、静态卷路径、身份或 k3s 依赖不符合固定契约。'
    fence_now '独立挂载、静态卷路径或 k3s 依赖失效' 1
  fi
  if ! headroom_ok; then
    (( check_only == 1 )) && fail '独立存储池低于字节或 inode 安全水位。'
    fence_now '独立存储池低于字节或 inode 安全水位' 1
  fi
  if (( check_only == 1 )); then
    status 'PASS storage=static-local headroom=available mount-dependency=canonical'
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
      fence_now '持久失败阻断标记仍然存在' 0 0
      return
    fi
    status 'PASS storage=bounded credentials=healthy operation=active'
    return
  fi
  status 'PASS storage=static-local headroom=available credentials=healthy'
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
