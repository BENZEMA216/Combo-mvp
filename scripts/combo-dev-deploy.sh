#!/usr/bin/env bash
# combo-dev 的受信任主机调度器。它只接收受保护流水线产生的固定清单包，且只操作 combo-preview。
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
readonly STORAGE_MIN_BYTES=$((16 * 1024 * 1024 * 1024))
readonly STORAGE_MAX_BYTES=$((18 * 1024 * 1024 * 1024))
readonly DEPLOY_KUBECONFIG='/etc/combo-dev/dispatcher.kubeconfig'
readonly PRODUCTION_KUBECONFIG='/etc/combo-dev/production-observer.kubeconfig'
readonly TAKEOVER_APPROVAL='/etc/combo-dev/preview-takeover.approved'
readonly REBOOT_APPROVAL='/etc/combo-dev/data-mount-reboot.approved'
readonly CREDENTIAL_APPROVAL='/etc/combo-dev/credential-separation.approved'
readonly JOURNAL_APPROVAL='/etc/combo-dev/journal-retention.approved'
readonly STORAGE_APPROVAL='/etc/combo-dev/storage-pool.approved'
readonly HOST_BOUNDARY_APPROVAL='/etc/combo-dev/host-network-boundary.approved'
readonly HOST_BOUNDARY_CHECK='/opt/combo-dev/host-boundary/check'
readonly CONTROL_DIGEST='/etc/combo-dev/control-files.sha256'
readonly CLUSTER_PLATFORM_CONTRACT='/etc/combo-dev/cluster-platform.canonical.json'
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
readonly LEGACY_EVIDENCE='/var/lib/combo-dev/evidence'
readonly CONTROL_STATE_MIN_BYTES=$((3584 * 1024 * 1024))
readonly CONTROL_STATE_MAX_BYTES=$((4 * 1024 * 1024 * 1024))
readonly CONTROL_STATE_MIN_FREE_BYTES=$((1024 * 1024 * 1024))
readonly CONTROL_STATE_MIN_FREE_INODES=4096
# 512 MiB log capture budget plus 128 MiB for extraction, smoke metadata, and work files.
readonly CONTROL_WORK_MARGIN_BYTES=$((640 * 1024 * 1024))
readonly ARCHIVE_MAX_BYTES=$((512 * 1024 * 1024))
readonly LOCK_FILE='/run/lock/combo-dev.lock'
readonly FENCE_LOCK_FILE='/run/lock/combo-dev-fence.lock'
readonly ROOT_WARNING_MIN_BYTES=$((20 * 1024 * 1024 * 1024))
readonly ROOT_CRITICAL_MIN_BYTES=$((10 * 1024 * 1024 * 1024))
readonly DATA_WARNING_MIN_BYTES=$((30 * 1024 * 1024 * 1024))
readonly DATA_CRITICAL_MIN_BYTES=$((20 * 1024 * 1024 * 1024))
readonly SHA_RE='^[0-9a-f]{40}$'
readonly DIGEST_RE='^sha256:[0-9a-f]{64}$'
readonly JOB_PREFLIGHT_IMAGE='busybox@sha256:9532d8c39891ca2ecde4d30d7710e01fb739c87a8b9299685c63704296b16028'
readonly STORAGE_LOW_MARKER='/run/combo-dev-storage-low'
readonly FAILURE_FENCE_MARKER='/var/lib/combo-dev/writers-fenced'
readonly FAILURE_FENCE_VALUE='combo-dev-writers=fenced'
readonly SAFE_IDLE_FENCE_VALUE='combo-dev-writers=safe-idle-v1'
readonly EXTERNAL_FENCE_MARKER='/var/lib/combo-dev/external-fence'
readonly ACCEPTANCE_PENDING_MARKER='/var/lib/combo-dev/acceptance-pending'
readonly PUBLICATION_MARKER='/var/lib/combo-dev/publication'
readonly PUBLIC_NGINX_TARGET='/etc/nginx/conf.d/combo-dev-test.conf'
readonly CERTBOT_DEPLOY_HOOK='/etc/letsencrypt/renewal-hooks/deploy/combo-dev-nginx-reload'
readonly ACCEPTANCE_PENDING_SECONDS=7200
RESET_PROOF=''
CONSUMED_RESET_PROOF=''
readonly RESET_PROOF_MAX_AGE_SECONDS=900
readonly MIGRATION_HEAD='0009_billing.sql'
readonly DISPATCHER_FENCE_BEFORE_SECONDS=$((7 * 24 * 60 * 60))
readonly DISPATCHER_OPERATION_MIN_SECONDS=$((4 * 60 * 60))
readonly APP_NAMES=(api worker runtime web)
readonly FOUNDATION_NAMES=(postgres redis-queue minio)
readonly LOCAL_FORWARDER_UNITS=(combo-dev-web-forward.service combo-dev-s3-forward.service)
readonly PUBLIC_FORWARDER_UNITS=(combo-dev-public-web-forward.service combo-dev-public-s3-forward.service)
readonly ALL_FORWARDER_UNITS=("${LOCAL_FORWARDER_UNITS[@]}" "${PUBLIC_FORWARDER_UNITS[@]}")
readonly CONTROL_FILES=(
  scripts/combo-dev-bootstrap.sh
  scripts/combo-dev-deploy.sh
  scripts/combo-dev-smoke.sh
  scripts/combo-dev-logs.sh
  scripts/combo-dev-reset.sh
  scripts/combo-dev-forwarder-lease.sh
  scripts/combo-dev-publication.sh
  scripts/combo-dev-public-s3-smoke.py
  scripts/combo-dev-storage-guard.sh
  scripts/combo-dev-production-safety.py
  infra/host/combo-dev/combo-dev-prepare-control-state.sh
  infra/host/combo-dev/combo-host-prepare-data-anchor.sh
  infra/host/combo-dev/combo-host-data-mount-check.sh
  infra/host/combo-dev/combo-dev-prepare-public-domain.sh
  infra/host/combo-dev/combo-dev-certbot-deploy-hook.sh
  infra/host/combo-dev/combo-dev-public-nginx.conf
  infra/host/combo-dev/combo-dev-public-acme-nginx.conf
  infra/host/combo-dev/combo-dev-web-forward.service
  infra/host/combo-dev/combo-dev-s3-forward.service
  infra/host/combo-dev/combo-dev-public-web-forward.service
  infra/host/combo-dev/combo-dev-public-s3-forward.service
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

K=(kubectl --request-timeout=30s --kubeconfig "$DEPLOY_KUBECONFIG")
PK=(kubectl --request-timeout=30s --kubeconfig "$PRODUCTION_KUBECONFIG")
WORK=''
RELEASE_DIR=''
INCOMING_BUNDLE=''
RESET_PROOF_IN_USE=''
CANDIDATE_RELEASE=''
RELEASE_CREATED=0
MUTATING=0
SUCCESS=0
ATTEMPT_REVISION=''
ATTEMPT_RUN_ID=''
ATTEMPT_RUN_ATTEMPT=''

status() { printf '[combo-dev] %s\n' "$1"; }
fail() { printf '[combo-dev] FAIL: %s\n' "$1" >&2; exit 1; }
blocked() { printf '[combo-dev] BLOCKED: %s\n' "$1" >&2; exit 2; }
require_command() { command -v "$1" >/dev/null 2>&1 || blocked "缺少主机工具：$1"; }

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
  [[ -z "$INCOMING_BUNDLE" ]] || rm -f -- "$INCOMING_BUNDLE"
  if (( MUTATING == 1 && SUCCESS == 0 )); then
    remove_current_attempt_reset_proofs >/dev/null 2>&1 || proof_cleanup_ok=0
  elif [[ -n "$RESET_PROOF_IN_USE" ]]; then
    remove_consumed_reset_proof >/dev/null 2>&1 || proof_cleanup_ok=0
  fi
  if (( MUTATING == 1 && SUCCESS == 0 )); then
    mark_failure_fence >/dev/null 2>&1 || true
    stop_forwarders_for_failure >/dev/null 2>&1 || convergence_ok=0
    fence_all_writers_cleanup >/dev/null 2>&1 || convergence_ok=0
    verify_complete_writer_inventory_zero >/dev/null 2>&1 || convergence_ok=0
    if (( convergence_ok == 1 )); then
      if (( proof_cleanup_ok == 0 )); then
        status '失败收敛已验证，但已消费 reset proof 无法删除；需要主机所有者介入。'
      elif record_failed_attempt_capability >/dev/null 2>&1; then
        status '失败收敛已验证；当前 attempt 已记录，下一次手工 Test 部署可从 reset 安全重试。'
      else
        status '失败收敛已验证，但 attempt 恢复能力无法安全提交；需要主机所有者介入。'
      fi
    else
      status '失败收敛无法验证；阻断标记已保留并需要主机所有者介入。'
    fi
  fi
  if [[ -n "$CANDIDATE_RELEASE" && "$CANDIDATE_RELEASE" =~ ^/opt/combo-dev/state/releases/\.staging/[0-9a-f]{40}\.[1-9][0-9]*\.[1-9][0-9]*\.[A-Za-z0-9]+$ &&
    -d "$CANDIDATE_RELEASE" && ! -L "$CANDIDATE_RELEASE" ]]; then
    rm -rf --one-file-system -- "$CANDIDATE_RELEASE"
  fi
  [[ -z "$WORK" ]] || rm -rf --one-file-system -- "$WORK"
  if (( SUCCESS == 0 && RELEASE_CREATED == 1 )) &&
    [[ "$RELEASE_DIR" =~ ^/opt/combo-dev/releases/[0-9a-f]{40}$ && -d "$RELEASE_DIR" && ! -L "$RELEASE_DIR" ]]; then
    rm -rf --one-file-system -- "$RELEASE_DIR"
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

root_owned_not_writable() {
  local mode owner
  [[ -e "$1" && ! -L "$1" ]] || return 1
  mode=$(stat -c '%a' "$1" 2>/dev/null) || return 1
  owner=$(stat -c '%u' "$1" 2>/dev/null) || return 1
  [[ "$owner" == 0 && "$mode" =~ ^[0-7]{3,4}$ && $((8#$mode & 8#022)) == 0 ]]
}

file_mode_is_private() {
  local mode owner
  [[ -f "$1" && ! -L "$1" ]] || return 1
  mode=$(stat -c '%a' "$1" 2>/dev/null) || return 1
  owner=$(stat -c '%u' "$1" 2>/dev/null) || return 1
  [[ "$owner" == 0 && ( "$mode" == '600' || "$mode" == '400' ) ]]
}

publication_marker_is_strict() {
  local revision run_id run_attempt extra value expected_bytes
  [[ -f "$PUBLICATION_MARKER" && ! -L "$PUBLICATION_MARKER" ]] || return 1
  IFS=' ' read -r revision run_id run_attempt extra <"$PUBLICATION_MARKER" || return 1
  [[ -z "$extra" && "$revision" =~ ^[0-9a-f]{40}$ &&
    "$run_id" =~ ^[1-9][0-9]*$ && "$run_attempt" =~ ^[1-9][0-9]*$ ]] || return 1
  value="$revision $run_id $run_attempt"
  expected_bytes=$((${#value} + 1))
  [[ $(stat -c '%u:%g:%a:%h:%s' "$PUBLICATION_MARKER" 2>/dev/null) == \
    "0:0:600:1:$expected_bytes" && $(<"$PUBLICATION_MARKER") == "$value" ]]
}

strict_remove_publication_marker() {
  [[ -e "$PUBLICATION_MARKER" || -L "$PUBLICATION_MARKER" ]] || return 0
  publication_marker_is_strict || return 1
  rm -f -- "$PUBLICATION_MARKER" || return 1
  [[ ! -e "$PUBLICATION_MARKER" && ! -L "$PUBLICATION_MARKER" ]]
}

free_bytes() {
  df -PB1 "$1" 2>/dev/null | awk 'NR==2 {print $4}'
}

free_inodes() {
  df -Pi "$1" 2>/dev/null | awk 'NR==2 {print $4}'
}

total_bytes() {
  df -PB1 "$1" 2>/dev/null | awk 'NR==2 {print $2}'
}

total_inodes() {
  df -Pi "$1" 2>/dev/null | awk 'NR==2 {print $2}'
}

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
  for path in "$CONTROL_STAGING" "$CONTROL_WORK"; do
    [[ $(stat -c '%u:%g:%a' "$path" 2>/dev/null) == '0:0:700' ]] || return 1
  done
  [[ $(stat -c '%u:%g:%a' "$CONTROL_EVIDENCE" 2>/dev/null) == '0:0:755' ]] || return 1

  for path in "$INSTALL_ROOT/incoming" "$INSTALL_ROOT/releases" "$LEGACY_EVIDENCE"; do
    [[ -d "$path" && ! -L "$path" ]] || return 1
    [[ $(findmnt -rn -M "$path" -o TARGET 2>/dev/null) == "$path" ]] || return 1
    options=$(findmnt -rn -M "$path" -o OPTIONS 2>/dev/null) || return 1
    [[ ",$options," == *,rw,* && ",$options," == *,nodev,* && ",$options," == *,nosuid,* && ",$options," == *,noexec,* ]] || return 1
  done
  fsroot=$(findmnt -rn -M "$INSTALL_ROOT/incoming" -o FSROOT 2>/dev/null) || return 1
  [[ "$fsroot" == '/incoming' ]] || return 1
  fsroot=$(findmnt -rn -M "$INSTALL_ROOT/releases" -o FSROOT 2>/dev/null) || return 1
  [[ "$fsroot" == '/releases' ]] || return 1
  fsroot=$(findmnt -rn -M "$LEGACY_EVIDENCE" -o FSROOT 2>/dev/null) || return 1
  [[ "$fsroot" == '/evidence' ]] || return 1
  [[ $(stat -c '%d:%i' "$INSTALL_ROOT/incoming" 2>/dev/null) == $(stat -c '%d:%i' "$CONTROL_INCOMING" 2>/dev/null) ]] || return 1
  [[ $(stat -c '%d:%i' "$INSTALL_ROOT/releases" 2>/dev/null) == $(stat -c '%d:%i' "$CONTROL_RELEASES" 2>/dev/null) ]] || return 1
  [[ $(stat -c '%d:%i' "$LEGACY_EVIDENCE" 2>/dev/null) == $(stat -c '%d:%i' "$CONTROL_EVIDENCE" 2>/dev/null) ]] || return 1
  [[ $(stat -c '%u:%g:%a' "$INSTALL_ROOT/incoming" 2>/dev/null) == '0:0:1733' ]] || return 1
  [[ $(stat -c '%u:%g:%a' "$INSTALL_ROOT/releases" 2>/dev/null) == '0:0:755' ]] || return 1
}

assert_control_state_headroom() {
  local required_extra=${1:-0} free inodes required
  [[ "$required_extra" =~ ^[0-9]+$ ]] || blocked 'control-state 额外容量参数不合法。'
  verify_control_state || blocked 'control-state 挂载、backing file、目录或兼容 bind 契约失效。'
  free=$(free_bytes "$CONTROL_STATE") || blocked 'control-state 可用容量不可读。'
  inodes=$(free_inodes "$CONTROL_STATE") || blocked 'control-state inode 不可读。'
  [[ "$free" =~ ^[0-9]+$ && "$inodes" =~ ^[0-9]+$ ]] || blocked 'control-state 容量指标格式不合法。'
  required=$((CONTROL_STATE_MIN_FREE_BYTES + required_extra + CONTROL_WORK_MARGIN_BYTES))
  (( free >= required && inodes >= CONTROL_STATE_MIN_FREE_INODES )) ||
    blocked 'control-state 低于部署所需字节或 inode 安全水位。'
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
  root_iwarn=$((root_itotal * 15 / 100))
  root_icritical=$((root_itotal * 10 / 100))
  data_warn=$(max_threshold "$data_total" "$DATA_WARNING_MIN_BYTES" 15)
  data_critical=$(max_threshold "$data_total" "$DATA_CRITICAL_MIN_BYTES" 10)
  data_iwarn=$((data_itotal * 15 / 100))
  data_icritical=$((data_itotal * 10 / 100))
  if (( root_free < root_critical || root_iavail < root_icritical )); then
    blocked '主机根盘低于 OS critical 安全水位；这不是部署容量门槛。'
  fi
  if (( data_free < data_critical || data_iavail < data_icritical )); then
    blocked '父数据盘低于 critical 字节或 inode 安全水位。'
  fi
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

verify_k3s_mount_dependencies() {
  local mounts
  mounts=$(timeout 15 systemctl show k3s.service -p RequiresMountsFor --value 2>/dev/null) || return 1
  printf '%s\n' "$mounts" | "$INSTALL_ROOT/bin/combo-dev-production-safety" \
    validate-mount-dependencies --input /dev/stdin --data-mount "$DATA_MOUNT" --storage-pool "$STORAGE_POOL" \
    >/dev/null 2>&1
}

assert_storage_headroom() {
  verify_bounded_storage_pool || blocked '独立有界存储池不符合固定挂载契约。'
  [[ ! -e "$STORAGE_LOW_MARKER" ]] || blocked '持续存储守卫已关闭写入者，必须先人工释放容量。'
  "$INSTALL_ROOT/bin/combo-dev-storage-guard" --check-only >/dev/null 2>&1 || blocked '独立存储池低于字节或 inode 安全水位。'
}

dispatcher_certificate_valid_for() {
  local minimum_seconds=$1 certificate rc
  certificate=$(mktemp "$WORK/dispatcher-cert.XXXXXX") || return 1
  if ! kubectl --kubeconfig "$DEPLOY_KUBECONFIG" config view --raw --flatten --minify \
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

stop_forwarders_for_failure() {
  local unit active failed=0
  rm -rf -- /run/combo-dev-forwarders || failed=1
  strict_remove_publication_marker || failed=1
  timeout 30 systemctl stop "${ALL_FORWARDER_UNITS[@]}" >/dev/null 2>&1 || failed=1
  for unit in "${ALL_FORWARDER_UNITS[@]}"; do
    active=$(timeout 10 systemctl is-active "$unit" 2>/dev/null || true)
    [[ "$active" == inactive || "$active" == failed ]] || failed=1
  done
  return "$failed"
}

claim_forwarders_for_deploy() {
  local unit active
  rm -rf -- /run/combo-dev-forwarders
  [[ ! -e "$PUBLICATION_MARKER" && ! -L "$PUBLICATION_MARKER" ]] ||
    blocked '安全空闲状态仍带有公网发布标记。'
  timeout 30 systemctl stop "${ALL_FORWARDER_UNITS[@]}" >/dev/null 2>&1 || blocked '无法取得转发器排他所有权。'
  for unit in "${ALL_FORWARDER_UNITS[@]}"; do
    active=$(timeout 10 systemctl is-active "$unit" 2>/dev/null || true)
    [[ "$active" == inactive || "$active" == failed ]] || blocked '回环转发器仍由其他会话持有。'
  done
}

host_preflight() {
  [[ $(id -u) -eq 0 ]] || blocked '调度器必须由受限 sudo 规则以 root 启动。'
  for cmd in kubectl python3 jq curl sha256sum flock findmnt df systemctl ss timeout readlink install diff mv mktemp stat dirname openssl base64 date chown chmod rm losetup blockdev blkid; do require_command "$cmd"; done
  root_owned_not_writable /etc/combo-dev || blocked '开发配置目录可被非 root 修改。'
  root_owned_not_writable "$INSTALL_ROOT" || blocked '安装根目录可被非 root 修改。'
  root_owned_not_writable "$INSTALL_ROOT/bin" || blocked '调度器目录可被非 root 修改。'
  if ! root_owned_not_writable "$INSTALL_ROOT/bin/combo-dev-production-safety" || [[ ! -x "$INSTALL_ROOT/bin/combo-dev-production-safety" ]]; then
    blocked '共享生产安全检查器不可用。'
  fi
  root_owned_not_writable /var/lib/combo-dev || blocked '持久失败收敛目录可被非 root 修改。'
  root_owned_not_writable "$INSTALL_ROOT/releases" || blocked '发布目录可被非 root 修改。'
  root_owned_not_writable "${BASH_SOURCE[0]}" || blocked '当前调度器可被非 root 修改。'
  [[ $(stat -c '%u:%a' "$INSTALL_ROOT/incoming" 2>/dev/null) == '0:1733' ]] || blocked 'incoming 投递目录权限不符合固定边界。'
  file_mode_is_private "$CONTROL_DIGEST" || blocked '控制文件摘要不是 owner-only 文件。'
  file_mode_is_private "$CLUSTER_PLATFORM_CONTRACT" || blocked '规范化集群平台契约不是 owner-only 文件。'
  if [[ ! -f "$DEPLOY_KUBECONFIG" ]] || ! file_mode_is_private "$DEPLOY_KUBECONFIG"; then blocked '缺少 owner-only 的命名空间调度凭据。'; fi
  if [[ ! -f "$PRODUCTION_KUBECONFIG" ]] || ! file_mode_is_private "$PRODUCTION_KUBECONFIG"; then blocked '缺少 owner-only 的生产只读凭据。'; fi
  [[ $(cat "$TAKEOVER_APPROVAL" 2>/dev/null || true) == 'combo-preview=canonical-and-disposable' ]] || blocked '缺少 preview 接管与数据可丢弃批准。'
  [[ $(cat "$CREDENTIAL_APPROVAL" 2>/dev/null || true) == 'combo-dev=development-identities-only' ]] || blocked '缺少开发专用凭据批准。'
  [[ $(cat "$REBOOT_APPROVAL" 2>/dev/null || true) == 'controlled-reboot=parent-data-mount-pass' ]] || blocked '缺少生产所需父数据盘受控重启证据。'
  [[ $(cat "$JOURNAL_APPROVAL" 2>/dev/null || true) == 'journald=native-retention-bounded' ]] || blocked '缺少原生日志保留上限证据。'
  [[ $(cat "$STORAGE_APPROVAL" 2>/dev/null || true) == 'combo-dev-storage=dedicated-hard-18GiB-max' ]] || blocked '缺少独立有界存储池批准。'
  [[ $(cat "$HOST_BOUNDARY_APPROVAL" 2>/dev/null || true) == 'combo-dev-host-boundary=audited-and-active' ]] || blocked '缺少 Pod 到节点的主机级隔离批准。'
  if ! root_owned_not_writable "$HOST_BOUNDARY_CHECK" || [[ ! -x "$HOST_BOUNDARY_CHECK" ]]; then
    blocked '主机级隔离检查器不可用或可被非 root 修改。'
  fi
  timeout 30 "$HOST_BOUNDARY_CHECK" --check >/dev/null 2>&1 || blocked '主机级 Pod 到节点隔离未生效。'
  findmnt -rn -M "$DATA_MOUNT" >/dev/null 2>&1 || blocked '数据盘没有挂载在固定路径。'
  verify_control_state || blocked 'control-state 没有使用固定数据盘 backing 的独立 3.5–4 GiB 挂载与兼容 bind。'
  verify_bounded_storage_pool || blocked 'combo-dev 没有使用独立且硬限制为 18 GiB 以内的挂载。'
  verify_k3s_mount_dependencies || blocked 'k3s 必须只依赖生产父数据盘，不能依赖开发挂载或其任何子路径。'
  dispatcher_certificate_valid_for "$DISPATCHER_OPERATION_MIN_SECONDS" || blocked '调度证书不足以覆盖最长部署操作。'
  dispatcher_certificate_valid_for "$DISPATCHER_FENCE_BEFORE_SECONDS" || blocked '调度证书已进入预到期失败收敛窗口，必须重新 bootstrap。'
  timeout 180 systemctl start combo-dev-storage-guard.service >/dev/null 2>&1 || blocked '持续守卫无法证明两套凭据与失败收敛路径健康。'
  storage_guard_timer_ready || blocked '持续存储守卫未启用、未激活或没有下一次检查。'
  assert_storage_headroom
  assert_control_state_headroom
  assert_host_capacity
}

can_i_exact() {
  local expected=$1 verb=$2 resource=$3 namespace=${4:-} subresource=${5:-} out rc
  local args=(auth can-i "$verb" "$resource")
  [[ -z "$namespace" ]] || args+=(-n "$namespace")
  [[ -z "$subresource" ]] || args+=(--subresource="$subresource")
  set +e
  out=$("${K[@]}" "${args[@]}" 2>/dev/null)
  rc=$?
  set -e
  if [[ "$expected" == yes ]]; then
    [[ $rc == 0 && "$out" == yes ]] || blocked '调度凭据缺少预期权限。'
  else
    [[ $rc == 1 && "$out" == no* ]] || blocked '调度凭据拥有禁止权限或权限探针失败。'
  fi
}

rbac_preflight() {
  can_i_exact yes patch deployments.apps "$NAMESPACE"
  can_i_exact yes create jobs.batch "$NAMESPACE"
  can_i_exact yes patch jobs.batch "$NAMESPACE"
  can_i_exact yes get pods "$NAMESPACE" log
  can_i_exact yes create pods "$NAMESPACE" portforward
  can_i_exact yes get "storageclasses.storage.k8s.io/$STORAGE_CLASS"
  can_i_exact yes get persistentvolumes/combo-dev-postgres
  can_i_exact yes get persistentvolumes/combo-dev-redis-queue
  can_i_exact yes get persistentvolumes/combo-dev-minio
  can_i_exact yes list namespaces
  can_i_exact yes list roles.rbac.authorization.k8s.io "$NAMESPACE"
  can_i_exact yes list rolebindings.rbac.authorization.k8s.io "$NAMESPACE"
  can_i_exact yes list daemonsets.apps "$NAMESPACE"
  can_i_exact yes list replicasets.apps "$NAMESPACE"
  can_i_exact yes list replicationcontrollers "$NAMESPACE"
  can_i_exact yes list cronjobs.batch "$NAMESPACE"
  can_i_exact yes list ingresses.networking.k8s.io "$NAMESPACE"
  can_i_exact yes list endpointslices.discovery.k8s.io "$NAMESPACE"
  can_i_exact yes list horizontalpodautoscalers.autoscaling "$NAMESPACE"
  can_i_exact yes delete daemonsets.apps "$NAMESPACE"
  can_i_exact yes delete replicasets.apps "$NAMESPACE"
  can_i_exact yes delete replicationcontrollers "$NAMESPACE"
  can_i_exact yes delete cronjobs.batch "$NAMESPACE"
  can_i_exact yes delete horizontalpodautoscalers.autoscaling "$NAMESPACE"
  can_i_exact yes list serviceaccounts "$NAMESPACE"
  can_i_exact yes list resourcequotas "$NAMESPACE"
  can_i_exact yes list limitranges "$NAMESPACE"
  can_i_exact yes list clusterroles.rbac.authorization.k8s.io
  can_i_exact yes list clusterrolebindings.rbac.authorization.k8s.io
  can_i_exact no list persistentvolumes
  can_i_exact no create pods "$NAMESPACE"
  can_i_exact no get secrets "$NAMESPACE"
  can_i_exact no list secrets "$NAMESPACE"
  can_i_exact no delete secrets/combo-dev-env "$NAMESPACE"
  can_i_exact no patch secrets/combo-dev-env "$NAMESPACE"
  can_i_exact no patch deployments.apps "$PRODUCTION_NAMESPACE"
  can_i_exact no create jobs.batch "$PRODUCTION_NAMESPACE"

  python3 "$INSTALL_ROOT/bin/combo-dev-production-safety" verify-observer \
    --audit-kubeconfig "$DEPLOY_KUBECONFIG" \
    --observer-kubeconfig "$PRODUCTION_KUBECONFIG" \
    --production-namespace "$PRODUCTION_NAMESPACE" \
    --work-dir "$WORK/observer-audit" >/dev/null 2>&1 || blocked '生产观察身份不符合精确只读边界。'

  validate_cluster_platform_live
}

consume_reset_proof() {
  local revision=$1 workflow_run_id=$2 workflow_run_attempt=$3
  exec 8>"$FENCE_LOCK_FILE"
  flock -w 300 8 || blocked '消费 reset proof 前无法取得失败收敛锁。'
  writers_fence_has_value "$FAILURE_FENCE_VALUE" ||
    blocked '部署认领状态在消费 reset proof 前发生变化。'
  [[ ! -e "$EXTERNAL_FENCE_MARKER" && ! -L "$EXTERNAL_FENCE_MARKER" &&
    ! -e "$ACCEPTANCE_PENDING_MARKER" && ! -L "$ACCEPTANCE_PENDING_MARKER" ]] ||
    blocked '外部失败收敛或旧验收状态已阻止 reset proof 消费。'
  [[ -z "$RESET_PROOF_IN_USE" ]] || blocked 'reset proof 已在本次部署中消费。'
  file_mode_is_private "$RESET_PROOF" || blocked '缺少 owner-only 的单次 reset proof。'
  [[ ! -e "$CONSUMED_RESET_PROOF" && ! -L "$CONSUMED_RESET_PROOF" ]] ||
    blocked '存在未清理的已消费 reset proof。'
  mv -T -- "$RESET_PROOF" "$CONSUMED_RESET_PROOF" ||
    blocked 'reset proof 无法原子消费。'
  RESET_PROOF_IN_USE=$CONSUMED_RESET_PROOF
  file_mode_is_private "$RESET_PROOF_IN_USE" || blocked '已消费 reset proof 权限异常。'

  python3 - \
    "$RESET_PROOF_IN_USE" "$revision" "$workflow_run_id" "$workflow_run_attempt" \
    "$RESET_PROOF_MAX_AGE_SECONDS" <<'PY'
import datetime as dt
import json
import re
import sys

path, revision, workflow_run_id, workflow_run_attempt, max_age_raw = sys.argv[1:]
sha = re.compile(r'[0-9a-f]{40}')
run_id = re.compile(r'[1-9][0-9]*')
uuid = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')

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

try:
    proof = json.load(open(path, encoding='utf-8'))
    max_age = int(max_age_raw)
except (OSError, ValueError, json.JSONDecodeError):
    raise SystemExit(2)

expected_keys = {
    'schemaVersion', 'namespace', 'sourceSha', 'workflowRunId',
    'workflowRunAttempt', 'startedAt', 'storageClearedAt', 'completedAt',
    'storage', 'foundation',
    'storageSmokePassed', 'writersFenced', 'productionFingerprintUnchanged',
}
if (
    not isinstance(proof, dict)
    or set(proof) != expected_keys
    or proof['schemaVersion'] != 1
    or proof['namespace'] != 'combo-preview'
    or proof['sourceSha'] != revision
    or proof['workflowRunId'] != workflow_run_id
    or proof['workflowRunAttempt'] != workflow_run_attempt
    or not sha.fullmatch(proof['sourceSha'])
    or not run_id.fullmatch(proof['workflowRunId'])
    or not run_id.fullmatch(proof['workflowRunAttempt'])
):
    raise SystemExit(2)

started = timestamp(proof['startedAt'])
cleared = timestamp(proof['storageClearedAt'])
completed = timestamp(proof['completedAt'])
now = dt.datetime.now(dt.timezone.utc)
if not (started <= cleared <= completed <= now + dt.timedelta(seconds=60)):
    raise SystemExit(2)
age = (now - completed).total_seconds()
if age < -60 or age > max_age:
    raise SystemExit(2)

expected_storage = {
    'postgres': {'clearedBeforeRebuild': True},
    'redisQueue': {'clearedBeforeRebuild': True},
    'minio': {'clearedBeforeRebuild': True},
}
if proof['storage'] != expected_storage:
    raise SystemExit(2)
for key in ('storageSmokePassed', 'writersFenced', 'productionFingerprintUnchanged'):
    if proof[key] is not True:
        raise SystemExit(2)

foundation = proof['foundation']
if not isinstance(foundation, list) or len(foundation) != 4:
    raise SystemExit(2)
expected_planes = {'minio', 'postgres', 'redis-hot', 'redis-queue'}
if {item.get('plane') for item in foundation if isinstance(item, dict)} != expected_planes:
    raise SystemExit(2)
uids = set()
for item in foundation:
    if (
        not isinstance(item, dict)
        or set(item) != {'plane', 'podUid', 'createdAt', 'startedAt', 'ready'}
    ):
        raise SystemExit(2)
    if (
        item['ready'] is not True
        or not isinstance(item['podUid'], str)
        or not uuid.fullmatch(item['podUid'])
    ):
        raise SystemExit(2)
    if item['podUid'] in uids:
        raise SystemExit(2)
    uids.add(item['podUid'])
    created_at = timestamp(item['createdAt'])
    started_at = timestamp(item['startedAt'])
    if not (started <= created_at <= started_at <= completed):
        raise SystemExit(2)
PY
  flock -u 8 || blocked '消费 reset proof 后无法释放失败收敛锁。'
  exec 8>&-
}

validate_cluster_platform_live() {
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
  "$INSTALL_ROOT/bin/combo-dev-production-safety" compare-platform \
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
  "$INSTALL_ROOT/bin/combo-dev-storage-guard" --check-only >/dev/null 2>&1 || blocked '静态卷主机路径、标记、所有权或挂载边界发生漂移。'
}

resource_exists() {
  local kind=$1 name=$2 out
  out=$("${K[@]}" -n "$NAMESPACE" get "$kind/$name" --ignore-not-found -o name 2>/dev/null) || return 2
  [[ -z "$out" ]] && return 1
  [[ ${out##*/} == "$name" && "$out" != *$'\n'* ]] || return 2
  return 0
}

resource_exists_quick() {
  local kind=$1 name=$2 out
  out=$(timeout 10 "${K[@]}" -n "$NAMESPACE" get "$kind/$name" --ignore-not-found -o name 2>/dev/null) || return 2
  [[ -z "$out" ]] && return 1
  [[ ${out##*/} == "$name" && "$out" != *$'\n'* ]] || return 2
}

apply_app_replicas() {
  local name=$1 replicas=$2 seconds=${3:-0}
  local command=("${K[@]}")
  (( seconds == 0 )) || command=(timeout "$seconds" "${K[@]}")
  cat <<EOF | "${command[@]}" apply --server-side --field-manager=combo-dev-replicas --force-conflicts -f - >/dev/null 2>&1
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

exact_private_marker_value() {
  local path=$1 expected=$2 expected_bytes
  expected_bytes=$((${#expected} + 1))
  [[ -f "$path" && ! -L "$path" &&
    $(stat -c '%u:%g:%a:%s' "$path" 2>/dev/null) == "0:0:600:$expected_bytes" &&
    $(<"$path") == "$expected" ]]
}

remove_consumed_reset_proof() {
  local expected
  [[ "$ATTEMPT_REVISION" =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ "$ATTEMPT_RUN_ID" =~ ^[1-9][0-9]*$ &&
    "$ATTEMPT_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]] || return 1
  expected="/var/lib/combo-dev/reset-proof.${ATTEMPT_REVISION}.${ATTEMPT_RUN_ID}.${ATTEMPT_RUN_ATTEMPT}.consumed.json"
  [[ "$RESET_PROOF_IN_USE" == "$expected" ]] || return 1
  rm -f -- "$RESET_PROOF_IN_USE" || return 1
  [[ ! -e "$RESET_PROOF_IN_USE" && ! -L "$RESET_PROOF_IN_USE" ]]
}

remove_current_attempt_reset_proofs() {
  local expected_reset expected_consumed
  [[ "$ATTEMPT_REVISION" =~ ^[0-9a-f]{40}$ ]] || return 1
  [[ "$ATTEMPT_RUN_ID" =~ ^[1-9][0-9]*$ &&
    "$ATTEMPT_RUN_ATTEMPT" =~ ^[1-9][0-9]*$ ]] || return 1
  expected_reset="/var/lib/combo-dev/reset-proof.${ATTEMPT_REVISION}.${ATTEMPT_RUN_ID}.${ATTEMPT_RUN_ATTEMPT}.json"
  expected_consumed="/var/lib/combo-dev/reset-proof.${ATTEMPT_REVISION}.${ATTEMPT_RUN_ID}.${ATTEMPT_RUN_ATTEMPT}.consumed.json"
  [[ "$RESET_PROOF" == "$expected_reset" &&
    "$CONSUMED_RESET_PROOF" == "$expected_consumed" ]] || return 1
  [[ -z "$RESET_PROOF_IN_USE" || "$RESET_PROOF_IN_USE" == "$expected_consumed" ]] || return 1
  rm -f -- "$expected_reset" "$expected_consumed" || return 1
  [[ ! -e "$expected_reset" && ! -L "$expected_reset" &&
    ! -e "$expected_consumed" && ! -L "$expected_consumed" ]] || return 1
  RESET_PROOF_IN_USE=''
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

write_acceptance_pending() {
  local revision=$1 workflow_run_id=$2 workflow_run_attempt=$3
  local now deadline value
  now=$(date +%s 2>/dev/null) || return 1
  [[ "$now" =~ ^[1-9][0-9]*$ ]] || return 1
  deadline=$((now + ACCEPTANCE_PENDING_SECONDS))
  value="$revision $workflow_run_id $workflow_run_attempt $deadline"
  write_private_attempt_marker "$ACCEPTANCE_PENDING_MARKER" "$value"
}

claim_safe_idle_fence() {
  local rc=0
  exec 8>"$FENCE_LOCK_FILE"
  flock -w 300 8 || rc=1
  if (( rc == 0 )); then
    writers_fence_has_value "$SAFE_IDLE_FENCE_VALUE" || rc=1
    [[ ! -e "$EXTERNAL_FENCE_MARKER" && ! -L "$EXTERNAL_FENCE_MARKER" &&
      ! -e "$ACCEPTANCE_PENDING_MARKER" && ! -L "$ACCEPTANCE_PENDING_MARKER" &&
      ! -e "$PUBLICATION_MARKER" && ! -L "$PUBLICATION_MARKER" ]] || rc=1
  fi
  if (( rc == 0 )); then
    # The global flag must become visible to EXIT/TERM cleanup before the
    # deployable capability is atomically replaced.
    MUTATING=1
    mark_failure_fence || rc=1
  fi
  flock -u 8 >/dev/null 2>&1 || rc=1
  exec 8>&-
  return "$rc"
}

apply_foundation_replicas() {
  local kind=$1 name=$2 replicas=$3 seconds=${4:-0} api_kind
  local command=("${K[@]}")
  (( seconds == 0 )) || command=(timeout "$seconds" "${K[@]}")
  case "$kind" in deployment) api_kind=Deployment ;; statefulset) api_kind=StatefulSet ;; *) return 2 ;; esac
  cat <<EOF | "${command[@]}" apply --server-side --field-manager=combo-dev-failure-fence --force-conflicts -f - >/dev/null 2>&1
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
  local kind=$1 name=$2 quick=${3:-0} desired current rc
  if (( quick == 1 )); then
    if resource_exists_quick "$kind" "$name"; then :; else rc=$?; (( rc == 1 )) && return 0; return 1; fi
    desired=$(timeout 10 "${K[@]}" -n "$NAMESPACE" get "$kind/$name" -o jsonpath='{.spec.replicas}' 2>/dev/null) || return 1
    current=$(timeout 10 "${K[@]}" -n "$NAMESPACE" get "$kind/$name" -o jsonpath='{.status.replicas}' 2>/dev/null) || return 1
  else
    if resource_exists "$kind" "$name"; then :; else rc=$?; (( rc == 1 )) && return 0; return 1; fi
    timeout 180 "${K[@]}" --request-timeout=0 -n "$NAMESPACE" rollout status "$kind/$name" --timeout=170s >/dev/null 2>&1 || return 1
    desired=$("${K[@]}" -n "$NAMESPACE" get "$kind/$name" -o jsonpath='{.spec.replicas}' 2>/dev/null) || return 1
    current=$("${K[@]}" -n "$NAMESPACE" get "$kind/$name" -o jsonpath='{.status.replicas}' 2>/dev/null) || return 1
  fi
  [[ "$desired" == 0 && ( -z "$current" || "$current" == 0 ) ]]
}

fence_jobs_cleanup() {
  local failed=0 name rc pods
  for name in minio-init migrate combo-dev-network-canary; do
    timeout 35 "${K[@]}" -n "$NAMESPACE" delete "job/$name" --ignore-not-found --wait=true --timeout=30s >/dev/null 2>&1 || failed=1
    timeout 35 "${K[@]}" -n "$NAMESPACE" delete pods -l "job-name=$name" --ignore-not-found --wait=true --timeout=30s >/dev/null 2>&1 || failed=1
  done
  sleep 5
  for name in minio-init migrate combo-dev-network-canary; do
    if resource_exists_quick job "$name"; then failed=1; else rc=$?; (( rc == 1 )) || failed=1; fi
    pods=$(timeout 10 "${K[@]}" -n "$NAMESPACE" get pods -l "job-name=$name" -o name 2>/dev/null) || { failed=1; continue; }
    [[ -z "$pods" ]] || failed=1
  done
  return "$failed"
}

scale_all_writers() {
  local quick=${1:-0} failed=0 name rc seconds=0
  (( quick == 0 )) || seconds=10
  for name in "${APP_NAMES[@]}"; do
    if (( quick == 1 )); then
      if resource_exists_quick deployment "$name"; then rc=0; else rc=$?; fi
    else
      if resource_exists deployment "$name"; then rc=0; else rc=$?; fi
    fi
    if (( rc == 0 )); then apply_app_replicas "$name" 0 "$seconds" || failed=1; elif (( rc != 1 )); then failed=1; fi
  done
  if (( quick == 1 )); then
    if resource_exists_quick deployment redis-hot; then rc=0; else rc=$?; fi
  else
    if resource_exists deployment redis-hot; then rc=0; else rc=$?; fi
  fi
  if (( rc == 0 )); then apply_foundation_replicas deployment redis-hot 0 "$seconds" || failed=1; elif (( rc != 1 )); then failed=1; fi
  for name in "${FOUNDATION_NAMES[@]}"; do
    if (( quick == 1 )); then
      if resource_exists_quick statefulset "$name"; then rc=0; else rc=$?; fi
    else
      if resource_exists statefulset "$name"; then rc=0; else rc=$?; fi
    fi
    if (( rc == 0 )); then apply_foundation_replicas statefulset "$name" 0 "$seconds" || failed=1; elif (( rc != 1 )); then failed=1; fi
  done
  return "$failed"
}

verify_all_writers_zero() {
  local quick=${1:-0} failed=0 name
  for name in "${APP_NAMES[@]}"; do controller_scaled_zero deployment "$name" "$quick" || failed=1; done
  controller_scaled_zero deployment redis-hot "$quick" || failed=1
  for name in "${FOUNDATION_NAMES[@]}"; do controller_scaled_zero statefulset "$name" "$quick" || failed=1; done
  return "$failed"
}

fence_all_writers_cleanup() {
  local failed=0
  fence_jobs_cleanup || failed=1
  scale_all_writers 1 || failed=1
  sleep 10
  verify_all_writers_zero 1 || failed=1
  return "$failed"
}

fence_all_writers() {
  local failed=0
  fence_jobs || failed=1
  scale_all_writers 0 || failed=1
  verify_all_writers_zero 0 || failed=1
  return "$failed"
}

delete_job_strict() {
  local name=$1 rc
  if resource_exists job "$name"; then
    "${K[@]}" -n "$NAMESPACE" delete "job/$name" --wait=true --timeout=90s >/dev/null 2>&1 || return 1
  else
    rc=$?
    (( rc == 1 )) || return 1
  fi
}

fence_jobs() {
  local failed=0 name
  for name in minio-init migrate combo-dev-network-canary; do
    delete_job_strict "$name" || failed=1
  done
  return "$failed"
}

production_fingerprint() {
  local raw canonical
  raw=$(mktemp "$WORK/prod.raw.XXXXXX")
  canonical=$(mktemp "$WORK/prod.canonical.XXXXXX")
  "${PK[@]}" -n "$PRODUCTION_NAMESPACE" get deployments.apps,statefulsets.apps,services,persistentvolumeclaims,pods -o json >"$raw" 2>/dev/null || blocked '生产指纹读取失败。'
  python3 "$INSTALL_ROOT/bin/combo-dev-production-safety" canonicalize-production \
    --input "$raw" --output "$canonical" >/dev/null 2>&1 || blocked '生产指纹规范化失败。'
  sha256sum "$canonical" | awk '{print $1}'
}

validate_bundle() {
  local archive=$1 destination=$2
  python3 - "$archive" "$destination" <<'PY'
import os, pathlib, stat, sys, tarfile
archive, destination = sys.argv[1:]
allowed_files = {
    'metadata/revision', 'metadata/image-digests.txt',
    'metadata/release.json', 'metadata/release-manifest-digest.txt',
    'scripts/combo-dev-bootstrap.sh', 'scripts/combo-dev-deploy.sh',
    'scripts/combo-dev-smoke.sh', 'scripts/combo-dev-connect.sh',
    'scripts/combo-dev-logs.sh', 'scripts/combo-dev-reset.sh',
    'scripts/combo-dev-forwarder-lease.sh', 'scripts/combo-dev-publication.sh',
    'scripts/combo-dev-public-s3-smoke.py',
    'scripts/combo-dev-storage-guard.sh',
    'scripts/combo-dev-production-safety.py',
    'infra/host/combo-dev/README.md',
    'infra/host/combo-dev/combo-dev-prepare-control-state.sh',
    'infra/host/combo-dev/combo-host-prepare-data-anchor.sh',
    'infra/host/combo-dev/combo-host-data-mount-check.sh',
    'infra/host/combo-dev/combo-dev-prepare-public-domain.sh',
    'infra/host/combo-dev/combo-dev-certbot-deploy-hook.sh',
    'infra/host/combo-dev/combo-dev-public-nginx.conf',
    'infra/host/combo-dev/combo-dev-public-acme-nginx.conf',
    'infra/host/combo-dev/combo-dev-web-forward.service',
    'infra/host/combo-dev/combo-dev-s3-forward.service',
    'infra/host/combo-dev/combo-dev-public-web-forward.service',
    'infra/host/combo-dev/combo-dev-public-s3-forward.service',
    'infra/host/combo-dev/combo-dev-storage-guard.service',
    'infra/host/combo-dev/combo-dev-storage-guard.timer',
    r'infra/host/combo-dev/var-lib-combo\x2dhost\x2ddata.mount',
    'infra/host/combo-dev/combo-host-data-mount-check.service',
    r'infra/host/combo-dev/opt-combo\x2ddev-state.mount',
    r'infra/host/combo-dev/opt-combo\x2ddev-incoming.mount',
    r'infra/host/combo-dev/opt-combo\x2ddev-releases.mount',
    r'infra/host/combo-dev/var-lib-combo\x2ddev-evidence.mount',
    'infra/host/combo-dev/combo-host-syslog',
    'infra/k8s/overlays/combo-dev/kustomization.yaml',
    'infra/k8s/overlays/combo-dev/platform/kustomization.yaml',
    'infra/k8s/overlays/combo-dev/platform/limit-range.yaml',
    'infra/k8s/overlays/combo-dev/platform/namespace.yaml',
    'infra/k8s/overlays/combo-dev/platform/network-policies.yaml',
    'infra/k8s/overlays/combo-dev/platform/quota.yaml',
    'infra/k8s/overlays/combo-dev/platform/rbac.yaml',
    'infra/k8s/overlays/combo-dev/platform/storage-class.yaml',
    'infra/k8s/overlays/combo-dev/platform/storage-volumes.yaml',
    'infra/k8s/overlays/combo-dev/foundation/kustomization.yaml',
    'infra/k8s/overlays/combo-dev/foundation/postgres-entrypoint.sh',
    'infra/k8s/overlays/combo-dev/foundation/resources.yaml',
    'infra/k8s/overlays/combo-dev/init/kustomization.yaml',
    'infra/k8s/overlays/combo-dev/init/minio-app-policy.json',
    'infra/k8s/overlays/combo-dev/init/resources.yaml',
    'infra/k8s/overlays/combo-dev/migrate/kustomization.yaml',
    'infra/k8s/overlays/combo-dev/migrate/resources.yaml',
    'infra/k8s/overlays/combo-dev/apps/kustomization.yaml',
    'infra/k8s/overlays/combo-dev/apps/nginx-dev.conf',
    'infra/k8s/overlays/combo-dev/apps/resources.yaml',
}
total = 0
seen = set()
with tarfile.open(archive, 'r:gz') as tf:
    members = tf.getmembers()
    if not members:
        raise SystemExit(2)
    for m in members:
        p = pathlib.PurePosixPath(m.name)
        if p.is_absolute() or '..' in p.parts:
            raise SystemExit(2)
        name = str(p).rstrip('/')
        if m.isdir():
            continue
        if not m.isfile() or name not in allowed_files or name in seen:
            raise SystemExit(2)
        seen.add(name)
        if m.mode & 0o7002:
            raise SystemExit(2)
        if m.size > 2 * 1024 * 1024:
            raise SystemExit(2)
        total += m.size
    if total > 20 * 1024 * 1024 or seen != allowed_files:
        raise SystemExit(2)
    value = os.lstat(destination)
    if (not stat.S_ISDIR(value.st_mode) or stat.S_ISLNK(value.st_mode)
            or value.st_uid != 0 or value.st_gid != 0
            or stat.S_IMODE(value.st_mode) != 0o700 or os.listdir(destination)):
        raise SystemExit(2)
    tf.extractall(destination)
for root, dirs, files in os.walk(destination):
    os.chown(root, 0, 0)
    os.chmod(root, 0o755)
    for name in files:
        path=os.path.join(root,name)
        os.chown(path, 0, 0)
        relative=os.path.relpath(path,destination)
        if ((relative.startswith('scripts/combo-dev-') or
             relative.startswith('infra/host/combo-dev/')) and relative.endswith('.sh')):
            os.chmod(path,0o755)
        elif relative.startswith('metadata/'):
            os.chmod(path,0o600)
        else:
            os.chmod(path,0o644)
PY
}

installed_control_digest() {
  local file
  local files=(
    "$INSTALL_ROOT/bin/combo-dev-bootstrap"
    "$INSTALL_ROOT/bin/combo-dev-deploy"
    "$INSTALL_ROOT/bin/combo-dev-smoke"
    "$INSTALL_ROOT/bin/combo-dev-logs"
    "$INSTALL_ROOT/bin/combo-dev-reset"
    "$INSTALL_ROOT/bin/combo-dev-forwarder-lease"
    "$INSTALL_ROOT/bin/combo-dev-publication"
    "$INSTALL_ROOT/bin/combo-dev-public-s3-smoke"
    "$INSTALL_ROOT/bin/combo-dev-storage-guard"
    "$INSTALL_ROOT/bin/combo-dev-production-safety"
    "$INSTALL_ROOT/bin/combo-dev-prepare-control-state"
    "$INSTALL_ROOT/bin/combo-host-prepare-data-anchor"
    "$INSTALL_ROOT/bin/combo-host-data-mount-check"
    "$INSTALL_ROOT/bin/combo-dev-prepare-public-domain"
    "$CERTBOT_DEPLOY_HOOK"
    "$PUBLIC_NGINX_TARGET"
    "$INSTALL_ROOT/share/combo-dev-public-acme-nginx.conf"
    /etc/systemd/system/combo-dev-web-forward.service
    /etc/systemd/system/combo-dev-s3-forward.service
    /etc/systemd/system/combo-dev-public-web-forward.service
    /etc/systemd/system/combo-dev-public-s3-forward.service
    /etc/systemd/system/combo-dev-storage-guard.service
    /etc/systemd/system/combo-dev-storage-guard.timer
    '/etc/systemd/system/var-lib-combo\x2dhost\x2ddata.mount'
    /etc/systemd/system/combo-host-data-mount-check.service
    '/etc/systemd/system/opt-combo\x2ddev-state.mount'
    '/etc/systemd/system/opt-combo\x2ddev-incoming.mount'
    '/etc/systemd/system/opt-combo\x2ddev-releases.mount'
    '/etc/systemd/system/var-lib-combo\x2ddev-evidence.mount'
    /etc/logrotate.d/combo-host-syslog
    "$INSTALL_ROOT/bootstrap-overlay/kustomization.yaml"
    "$INSTALL_ROOT/bootstrap-overlay/platform/kustomization.yaml"
    "$INSTALL_ROOT/bootstrap-overlay/platform/limit-range.yaml"
    "$INSTALL_ROOT/bootstrap-overlay/platform/namespace.yaml"
    "$INSTALL_ROOT/bootstrap-overlay/platform/network-policies.yaml"
    "$INSTALL_ROOT/bootstrap-overlay/platform/quota.yaml"
    "$INSTALL_ROOT/bootstrap-overlay/platform/rbac.yaml"
    "$INSTALL_ROOT/bootstrap-overlay/platform/storage-class.yaml"
    "$INSTALL_ROOT/bootstrap-overlay/platform/storage-volumes.yaml"
    "$INSTALL_ROOT/bootstrap-overlay/foundation/kustomization.yaml"
    "$INSTALL_ROOT/bootstrap-overlay/foundation/postgres-entrypoint.sh"
    "$INSTALL_ROOT/bootstrap-overlay/foundation/resources.yaml"
    "$INSTALL_ROOT/bootstrap-overlay/init/kustomization.yaml"
    "$INSTALL_ROOT/bootstrap-overlay/init/minio-app-policy.json"
    "$INSTALL_ROOT/bootstrap-overlay/init/resources.yaml"
    "$INSTALL_ROOT/bootstrap-overlay/migrate/kustomization.yaml"
    "$INSTALL_ROOT/bootstrap-overlay/migrate/resources.yaml"
    "$INSTALL_ROOT/bootstrap-overlay/apps/kustomization.yaml"
    "$INSTALL_ROOT/bootstrap-overlay/apps/nginx-dev.conf"
    "$INSTALL_ROOT/bootstrap-overlay/apps/resources.yaml"
  )
  for file in "${files[@]}"; do
    root_owned_not_writable "$file" || return 2
  done
  for file in "${files[@]}"; do sha256sum "$file" | awk '{print $1}'; done | sha256sum | awk '{print $1}'
}

verify_release_tree() {
  python3 - "$1" <<'PY'
import os, stat, sys
root=sys.argv[1]
root_device=os.lstat(root).st_dev
for current, dirs, files in os.walk(root, followlinks=False):
    entries=[current]+[os.path.join(current,x) for x in dirs+files]
    for path in entries:
        s=os.lstat(path)
        if s.st_dev != root_device or s.st_uid != 0 or stat.S_ISLNK(s.st_mode) or (s.st_mode & 0o022):
            raise SystemExit(2)
PY
}

assert_release_tree_unmounted() {
  local mounts target
  mounts=$(findmnt -rn -o TARGET) || blocked '无法读取挂载表；拒绝读取 release。'
  while IFS= read -r target; do
    [[ "$target" == "$INSTALL_ROOT/releases" || "$target" == "$CONTROL_STATE" ]] && continue
    [[ "$target" == "$INSTALL_ROOT/releases"/* || "$target" == "$CONTROL_RELEASES"/* ]] || continue
    blocked 'release 树内存在非固定挂载点；拒绝读取或清理。'
  done <<<"$mounts"
}

read_metadata_value() {
  local file=$1 key=$2 count value
  count=$(awk -F= -v k="$key" '$1 == k {n++} END {print n+0}' "$file")
  [[ "$count" == 1 ]] || blocked '镜像元数据缺失或重复。'
  value=$(awk -F= -v k="$key" '$1 == k {sub(/^[^=]*=/, ""); print}' "$file")
  printf '%s' "$value"
}

control_tree_digest() {
  local root=$1 rel
  (
    cd "$root"
    for rel in "${CONTROL_FILES[@]}"; do
      [[ -f "$rel" ]] || exit 2
      sha256sum "$rel" | awk '{print $1}'
    done
  ) | sha256sum | awk '{print $1}'
}

validate_image_ref() {
  local ref=$1 expected=$2 digest
  [[ "$ref" == "$expected"@sha256:* ]] || blocked '镜像仓库不符合固定清单。'
  digest=${ref#*@}
  [[ "$digest" =~ $DIGEST_RE ]] || blocked '镜像没有使用精确 OCI 摘要。'
}

validate_release_manifest() {
  local manifest=$1 digest_file=$2 revision=$3 api=$4 runtime=$5 web=$6
  python3 - "$manifest" "$digest_file" "$revision" "$api" "$runtime" "$web" <<'PY'
import datetime
import hashlib
import json
import os
import re
import stat
import sys

manifest_path, digest_path, revision, api, runtime, web = sys.argv[1:]

def regular_file(path, maximum):
    value = os.lstat(path)
    if not stat.S_ISREG(value.st_mode) or stat.S_ISLNK(value.st_mode) or value.st_size > maximum:
        raise SystemExit(2)

regular_file(manifest_path, 64 * 1024)
regular_file(digest_path, 128)
source = open(manifest_path, 'rb').read()
try:
    value = json.loads(source)
except (UnicodeDecodeError, json.JSONDecodeError):
    raise SystemExit(2)

root_keys = [
    'schemaVersion', 'sourceSha', 'releaseId', 'images',
    'migrationHead', 'builtAt', 'webAssetManifest',
]
if not isinstance(value, dict) or list(value) != root_keys:
    raise SystemExit(2)
if (
    type(value.get('schemaVersion')) is not int
    or value.get('schemaVersion') != 1
    or value.get('sourceSha') != revision
):
    raise SystemExit(2)
if not re.fullmatch(r'[0-9a-f]{40}', revision) or value.get('releaseId') != f'release-{revision}':
    raise SystemExit(2)
images = value.get('images')
if not isinstance(images, dict) or list(images) != ['api', 'runtime', 'web']:
    raise SystemExit(2)
if images != {'api': api, 'runtime': runtime, 'web': web}:
    raise SystemExit(2)
if not re.fullmatch(r'[0-9]{4}_[a-z0-9_]+\.sql', value.get('migrationHead', '')):
    raise SystemExit(2)
built_at = value.get('builtAt')
if not isinstance(built_at, str) or not re.fullmatch(
    r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z',
    built_at,
):
    raise SystemExit(2)
try:
    parsed = datetime.datetime.strptime(built_at, '%Y-%m-%dT%H:%M:%S.%fZ')
except ValueError:
    raise SystemExit(2)
if parsed.strftime('%Y-%m-%dT%H:%M:%S.') + f'{parsed.microsecond // 1000:03d}Z' != built_at:
    raise SystemExit(2)
web_assets = value.get('webAssetManifest')
if not isinstance(web_assets, str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', web_assets):
    raise SystemExit(2)

canonical = (json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode()
if source != canonical:
    raise SystemExit(2)
recorded = open(digest_path, encoding='ascii').read()
actual = f"sha256:{hashlib.sha256(canonical).hexdigest()}\n"
if recorded != actual:
    raise SystemExit(2)
PY
}

inject_images() {
  local overlay=$1 api=$2 runtime=$3 web=$4
  local api_digest=${api#*@} runtime_digest=${runtime#*@} web_digest=${web#*@}
  cat >>"$overlay/apps/kustomization.yaml" <<EOF
images:
  - name: ghcr.io/dangdang-tech/combo-api
    newName: ghcr.io/dangdang-tech/combo-api
    digest: $api_digest
  - name: ghcr.io/dangdang-tech/combo-runtime
    newName: ghcr.io/dangdang-tech/combo-runtime
    digest: $runtime_digest
  - name: ghcr.io/dangdang-tech/combo-web
    newName: ghcr.io/dangdang-tech/combo-web
    digest: $web_digest
EOF
  cat >>"$overlay/migrate/kustomization.yaml" <<EOF
images:
  - name: ghcr.io/dangdang-tech/combo-api
    newName: ghcr.io/dangdang-tech/combo-api
    digest: $api_digest
EOF
}

inject_release_metadata() {
  local overlay=$1 revision=$2 built_at=$3 manifest_digest=$4 web_asset_manifest=$5
  local name="combo-release-meta-${revision:0:12}"
  cat >"$overlay/apps/release-metadata.yaml" <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  labels:
    combo.dev/environment: combo-dev
  name: $name
  namespace: $NAMESPACE
immutable: true
data:
  COMBO_ENVIRONMENT: 'test'
  COMBO_SOURCE_SHA: '$revision'
  COMBO_RELEASE_ID: 'release-$revision'
  COMBO_BUILT_AT: '$built_at'
  COMBO_RELEASE_MANIFEST_DIGEST: '$manifest_digest'
  COMBO_WEB_ASSET_MANIFEST: '$web_asset_manifest'
EOF
  cat >"$overlay/apps/release-metadata.patch.yaml" <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: $NAMESPACE
spec:
  template:
    spec:
      containers:
        - name: api
          envFrom:
            - configMapRef:
                name: $name
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: runtime
  namespace: $NAMESPACE
spec:
  template:
    spec:
      containers:
        - name: runtime
          envFrom:
            - configMapRef:
                name: $name
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: $NAMESPACE
spec:
  template:
    spec:
      containers:
        - name: web
          envFrom:
            - configMapRef:
                name: $name
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker
  namespace: $NAMESPACE
spec:
  template:
    spec:
      containers:
        - name: worker
          envFrom:
            - configMapRef:
                name: $name
EOF
  python3 - "$overlay/apps/kustomization.yaml" <<'PY'
import sys
path = sys.argv[1]
source = open(path, encoding='utf-8').read()
needle = 'resources:\n  - resources.yaml\n'
if source.count(needle) != 1 or '\npatches:' in source:
    raise SystemExit(2)
source = source.replace(needle, needle + '  - release-metadata.yaml\n')
source += 'patches:\n  - path: release-metadata.patch.yaml\n'
with open(path, 'w', encoding='utf-8') as stream:
    stream.write(source)
PY
}

render_guard() {
  local render_dir=$1
  python3 - "$render_dir" <<'PY'
import collections, hashlib, os, re, sys
root=sys.argv[1]
stages=('platform','foundation','init','migrate','apps')
stage_text={name:open(os.path.join(root,name+'.yaml'),encoding='utf-8').read() for name in stages}
text=open(os.path.join(root,'all.yaml'),encoding='utf-8').read()
expected_all='\n---\n'.join(stage_text[name].rstrip('\n') for name in stages)+'\n'
if text != expected_all: raise SystemExit('guard:aggregate-bytes')
stage_docs={name:[d for d in re.split(r'^---\s*$',stage_text[name],flags=re.M) if d.strip()] for name in stages}
docs=[doc for name in stages for doc in stage_docs[name]]
forbidden=[
 r'^kind: Secret$',r'^kind: Ingress$',r'type: (?:NodePort|LoadBalancer)',
 r'^\s*hostPath:',r'hostNetwork:\s*true',r'hostPID:\s*true',r'hostIPC:\s*true',r'hostPort:',
 r'privileged:\s*true',r'allowPrivilegeEscalation:\s*true',r'namespace:\s*combo$',
 r'\.combo\.svc',r'observability\.svc',r'\b(?:30080|30900)\b',
 r'OTEL_EXPORTER_OTLP_ENDPOINT',r'name:\s*ghcr-pull',r'name:\s*combo-env$',
 r'REPLACE|PLACEHOLDER|CHANGEME|TODO',r'^\s*serviceAccountName:',
 r'^\s*priorityClassName:',r'^\s*secret:',r'^\s+add:',r'procMount:',
 r'type:\s*(?:Unconfined|Localhost)',r'^\s*-\s*secretRef:',
]
for pattern in forbidden:
    if re.search(pattern,text,re.M|re.I): raise SystemExit('guard:forbidden')

def meta(doc):
    kind=re.search(r'^kind:\s*(\S+)',doc,re.M)
    name=re.search(r'^metadata:\n(?:^(?:  .*)?\n)*?^  name:\s*(\S+)',doc,re.M)
    return (kind.group(1),name.group(1)) if kind and name else (None,None)

def doc_for(kind,name):
    found=[doc for doc in docs if meta(doc)==(kind,name)]
    if len(found)!=1: raise SystemExit('guard:document-identity')
    return found[0]

def sequence(doc,key):
    match=re.search(rf'^(?:      - |        ){key}:\n((?:^        - .*\n)+)',doc,re.M)
    if not match: return None
    return [line.split('-',1)[1].strip().strip("'\"") for line in match.group(1).splitlines()]

def cpu(value): return float(value[:-1]) if value.endswith('m') else float(value)*1000

def bytes_mi(value):
    match=re.fullmatch(r'([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti)',value)
    if not match: raise SystemExit('guard:quantity')
    return float(match.group(1))*{'Ki':1/1024,'Mi':1,'Gi':1024,'Ti':1024*1024}[match.group(2)]

stage_expected={
 'platform':{
   'ResourceQuota':{'combo-dev-ceiling'},'LimitRange':{'combo-dev-defaults'},
   'NetworkPolicy':{'default-deny','allow-dns','web-to-apps','app-ingress-from-web',
     'postgres-ingress','redis-queue-ingress','redis-hot-ingress','minio-ingress',
     'authoring-internal-egress','runtime-internal-egress','migrate-egress',
     'minio-init-egress','approved-public-https','network-canary-dns-only'}},
 'foundation':{
   'ConfigMap':{'redis-hot-config','redis-queue-config','combo-dev-postgres-entrypoint'},
   'Service':{'minio','postgres','redis-hot','redis-queue'},
   'Deployment':{'redis-hot'},'StatefulSet':{'minio','postgres','redis-queue'}},
 'init':{'ConfigMap':{'combo-dev-minio-config','minio-init-script'},'Job':{'minio-init'}},
 'migrate':{'Job':{'migrate'}},
 'apps':{'Service':{'api','runtime','web'},'Deployment':{'api','runtime','web','worker'}},
}
seen=set()
inventory={}
release_metadata_name=None
for stage in stages:
    actual={}
    for doc in stage_docs[stage]:
        kind,name=meta(doc)
        if not kind or not name or (kind,name) in seen: raise SystemExit('guard:metadata')
        seen.add((kind,name)); actual.setdefault(kind,set()).add(name); inventory.setdefault(kind,set()).add(name)
        if re.findall(r'^  namespace:\s*(\S+)',doc,re.M)!=['combo-preview']: raise SystemExit('guard:namespace')
    if stage=='apps':
        configs=actual.pop('ConfigMap',set())
        nginx_configs={name for name in configs if re.fullmatch(r'combo-dev-nginx-[a-z0-9]+',name)}
        release_configs={name for name in configs if re.fullmatch(r'combo-release-meta-[0-9a-f]{12}',name)}
        if len(configs)!=2 or len(nginx_configs)!=1 or len(release_configs)!=1:
            raise SystemExit('guard:apps-configmap')
        release_metadata_name=next(iter(release_configs))
    if actual!=stage_expected[stage]: raise SystemExit('guard:stage-inventory:'+stage)

steady={'api','worker','runtime','web','postgres','redis-queue','redis-hot','minio'}
app_names={'api','worker','runtime','web'}
workloads={name:doc_for(kind,name) for kind,names in (
 ('Deployment',{'api','worker','runtime','web','redis-hot'}),
 ('StatefulSet',{'postgres','redis-queue','minio'}),('Job',{'migrate','minio-init'})) for name in names}
requests={'cpu':0.0,'memory':0.0,'ephemeral-storage':0.0}
limits={'cpu':0.0,'memory':0.0,'ephemeral-storage':0.0}
for name,doc in workloads.items():
    kind,_=meta(doc)
    if doc.count('automountServiceAccountToken: false')!=1 or doc.count('runAsNonRoot: true')!=1 or doc.count('type: RuntimeDefault')!=1:
        raise SystemExit('guard:pod-security')
    if doc.count('readOnlyRootFilesystem: true')!=1 or doc.count('allowPrivilegeEscalation: false')!=1:
        raise SystemExit('guard:container-security')
    if not re.search(r'^          capabilities:\n            drop:\n            - ALL$',doc,re.M):
        raise SystemExit('guard:capabilities')
    if 'hostPath:' in doc:
        raise SystemExit('guard:workload-hostpath')
    if kind in ('Deployment','StatefulSet'):
        replicas=re.findall(r'^  replicas:\s*(\d+)$',doc,re.M)
        if name not in steady: raise SystemExit('guard:steady-controller')
        if name in app_names:
            if replicas or not re.search(r'^  strategy:\n    type: Recreate$',doc,re.M): raise SystemExit('guard:app-replicas')
        elif replicas!=['1']: raise SystemExit('guard:steady-replicas')
    images=re.findall(r'^        image:\s*(\S+)$',doc,re.M)
    if len(images)!=1 or not re.fullmatch(r'[^\s@]+@sha256:[0-9a-f]{64}',images[0]): raise SystemExit('guard:image')
    blocks=re.findall(r'^        resources:\n((?:^          .*\n|^            .*\n)+)',doc,re.M)
    if len(blocks)!=1: raise SystemExit('guard:resource-block')
    for group,target in (('requests',requests),('limits',limits)):
        section=re.search(rf'^          {group}:\n((?:^            .*\n)+)',blocks[0],re.M)
        if not section: raise SystemExit('guard:resource-section')
        values=dict(re.findall(r'^            (cpu|memory|ephemeral-storage):\s*(\S+)',section.group(1),re.M))
        if set(values)!={'cpu','memory','ephemeral-storage'}: raise SystemExit('guard:resource-fields')
        if kind in ('Deployment','StatefulSet'):
            target['cpu']+=cpu(values['cpu']); target['memory']+=bytes_mi(values['memory']); target['ephemeral-storage']+=bytes_mi(values['ephemeral-storage'])

if 'hostPath:' in text: raise SystemExit('guard:workload-hostpath')
if any(requests[key]>value for key,value in {'cpu':1500,'memory':4096,'ephemeral-storage':4096}.items()): raise SystemExit('guard:steady-requests')
if any(limits[key]>value for key,value in {'cpu':3000,'memory':6144,'ephemeral-storage':8192}.items()): raise SystemExit('guard:steady-limits')

expected_repositories={
 'api':'ghcr.io/dangdang-tech/combo-api','worker':'ghcr.io/dangdang-tech/combo-api',
 'migrate':'ghcr.io/dangdang-tech/combo-api','runtime':'ghcr.io/dangdang-tech/combo-runtime',
 'web':'ghcr.io/dangdang-tech/combo-web','redis-hot':'redis','redis-queue':'redis',
 'minio':'minio/minio','minio-init':'minio/mc','postgres':'postgres'}
refs={name:re.search(r'^        image:\s*(\S+)$',doc,re.M).group(1) for name,doc in workloads.items()}
for name,repository in expected_repositories.items():
    if refs[name].split('@',1)[0]!=repository: raise SystemExit('guard:image-repository')
if not (refs['api']==refs['worker']==refs['migrate'] and refs['redis-hot']==refs['redis-queue']):
    raise SystemExit('guard:image-consistency')

if release_metadata_name is None:
    raise SystemExit('guard:release-metadata-name')
release_doc=doc_for('ConfigMap',release_metadata_name)
if re.findall(r'^immutable:\s*(\S+)$',release_doc,re.M)!=['true']:
    raise SystemExit('guard:release-metadata-immutable')
release_data={}
data_block=re.search(r'^data:\n((?:^  .+\n)+)',release_doc,re.M)
if data_block is None:
    raise SystemExit('guard:release-metadata-fields')
release_pairs=re.findall(r'^  (COMBO_[A-Z_]+):\s*(.+)$',data_block.group(1),re.M)
if len(release_pairs)!=6 or len(data_block.group(1).splitlines())!=6:
    raise SystemExit('guard:release-metadata-fields')
for key,raw in release_pairs:
    value=raw.strip()
    if len(value)>=2 and value[0]==value[-1] and value[0] in "'\"":
        value=value[1:-1]
    release_data[key]=value
release_keys={
 'COMBO_ENVIRONMENT','COMBO_SOURCE_SHA','COMBO_RELEASE_ID','COMBO_BUILT_AT',
 'COMBO_RELEASE_MANIFEST_DIGEST','COMBO_WEB_ASSET_MANIFEST'}
if set(release_data)!=release_keys or release_data['COMBO_ENVIRONMENT']!='test':
    raise SystemExit('guard:release-metadata-fields')
source_sha=release_data['COMBO_SOURCE_SHA']
if not re.fullmatch(r'[0-9a-f]{40}',source_sha) or source_sha=='0'*40:
    raise SystemExit('guard:release-metadata-source')
if release_metadata_name!=f'combo-release-meta-{source_sha[:12]}' or release_data['COMBO_RELEASE_ID']!=f'release-{source_sha}':
    raise SystemExit('guard:release-metadata-identity')
if not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z',release_data['COMBO_BUILT_AT']):
    raise SystemExit('guard:release-metadata-time')
for key in ('COMBO_RELEASE_MANIFEST_DIGEST','COMBO_WEB_ASSET_MANIFEST'):
    if not re.fullmatch(r'sha256:[0-9a-f]{64}',release_data[key]) or release_data[key]=='sha256:'+'0'*64:
        raise SystemExit('guard:release-metadata-digest')

expected_commands={
 'api':None,'runtime':None,'web':None,'worker':None,
 'redis-hot':['redis-server','/usr/local/etc/redis/redis.conf'],
 'redis-queue':['/bin/sh','-ec'],
 'postgres':['bash','/opt/combo-dev/postgres-entrypoint.sh'],
 'minio':['/bin/sh','-ec'],'minio-init':['/bin/sh','/scripts/init-buckets.sh'],
 'migrate':['node','--experimental-strip-types','db/scripts/migrate.ts']}
for name,expected in expected_commands.items():
    if sequence(workloads[name],'command')!=expected: raise SystemExit('guard:command')
for name in ('minio','redis-queue'):
    if sequence(workloads[name],'args')!=['|']: raise SystemExit('guard:storage-wrapper-args')
for name in set(workloads)-{'minio','redis-queue'}:
    if sequence(workloads[name],'args') is not None: raise SystemExit('guard:unexpected-args')
if 'exec /usr/bin/docker-entrypoint.sh server /data' not in workloads['minio']:
    raise SystemExit('guard:minio-command')
if 'exec redis-server /usr/local/etc/redis/redis.conf' not in workloads['redis-queue']:
    raise SystemExit('guard:redis-queue-command')

service_expected={
 'api':('http','3000','3000','api'),'runtime':('http','3100','3100','runtime'),
 'web':('http','80','8080','web'),'minio':('api','9000','9000','minio'),
 'postgres':('postgres','5432','5432','postgres'),
 'redis-hot':('redis','6379','6379','redis-hot'),
 'redis-queue':('redis','6379','6379','redis-queue')}
for name,expected in service_expected.items():
    doc=doc_for('Service',name)
    ports=re.findall(r'^  - name:\s*(\S+)\n    port:\s*(\d+)\n    targetPort:\s*(\d+)$',doc,re.M)
    selector=re.findall(r'^  selector:\n    app:\s*(\S+)$',doc,re.M)
    types=re.findall(r'^  type:\s*(\S+)$',doc,re.M)
    if ports!=[expected[:3]] or selector!=[expected[3]] or any(value!='ClusterIP' for value in types):
        raise SystemExit('guard:service-shape')
    if re.search(r'nodePort:|externalIPs:|externalName:|loadBalancer|healthCheckNodePort:|allocateLoadBalancerNodePorts:',doc,re.I):
        raise SystemExit('guard:service-exposure')

policies=inventory.get('NetworkPolicy',set())
if policies!=stage_expected['platform']['NetworkPolicy']: raise SystemExit('guard:network-policy-inventory')
policy_docs={name:doc_for('NetworkPolicy',name) for name in policies}
if sum(doc.count('ipBlock:') for doc in policy_docs.values())!=1:
    raise SystemExit('guard:network-ipblock')
public=policy_docs['approved-public-https']
for value in ('cidr: 0.0.0.0/0','port: 443','- 10.0.0.0/8','- 172.16.0.0/12','- 192.168.0.0/16'):
    if value not in public: raise SystemExit('guard:network-public-https')
for name,doc in policy_docs.items():
    if 'namespaceSelector:' in doc and name not in {'allow-dns','network-canary-dns-only'}:
        raise SystemExit('guard:network-namespace-selector')
    if 'namespaceSelector:' in doc and 'kubernetes.io/metadata.name: kube-system' not in doc:
        raise SystemExit('guard:network-dns-namespace')
    if 'endPort:' in doc or not re.search(r'^  policyTypes:',doc,re.M): raise SystemExit('guard:network-shape')
if not all(value in policy_docs['default-deny'] for value in ('podSelector: {}','policyTypes:','- Egress','- Ingress')):
    raise SystemExit('guard:default-deny')

allowed_secret_names={'combo-dev-env'}
expected_secret_keys={
 'minio':{'MINIO_ROOT_USER','MINIO_ROOT_PASSWORD'},
 'postgres':{'POSTGRES_USER','POSTGRES_PASSWORD','POSTGRES_DB'},
 'redis-hot':set(),'redis-queue':set(),
 'minio-init':{'MINIO_ROOT_USER','MINIO_ROOT_PASSWORD','S3_ACCESS_KEY','S3_SECRET_KEY'},
 'migrate':{'POSTGRES_USER','POSTGRES_PASSWORD','POSTGRES_DB','POSTGRES_API_PASSWORD','POSTGRES_WORKER_PASSWORD','POSTGRES_RUNTIME_PASSWORD'},
 'api':{'POSTGRES_DB','POSTGRES_API_PASSWORD','S3_ACCESS_KEY','S3_SECRET_KEY','RESEND_API_KEY','OTP_HMAC_SECRET','ANTHROPIC_API_KEY','OPENROUTER_API_KEY','LLM_PROVIDER','LLM_BASE_URL','LLM_MODEL','BILLING_RECHARGE_PACKAGES_JSON','LESHOUYING_ENABLED','LESHOUYING_ENVIRONMENT','LESHOUYING_PRODUCTION_ENABLED','LESHOUYING_INSTITUTION_NO','LESHOUYING_MERCHANT_NO','LESHOUYING_INSTITUTION_KEY','LESHOUYING_NOTIFY_URL','LESHOUYING_FRONT_URL'},
 'runtime':{'POSTGRES_DB','POSTGRES_RUNTIME_PASSWORD','S3_ACCESS_KEY','S3_SECRET_KEY','ANTHROPIC_API_KEY','OPENROUTER_API_KEY','RUNTIME_LLM_PROVIDER','RUNTIME_LLM_MODEL'},
 'worker':{'POSTGRES_DB','POSTGRES_WORKER_PASSWORD','S3_ACCESS_KEY','S3_SECRET_KEY','ANTHROPIC_API_KEY','OPENROUTER_API_KEY','LLM_PROVIDER','LLM_BASE_URL','LLM_MODEL'},
 'web':set()}
for name,doc in workloads.items():
    env_from=re.findall(
        r'^        envFrom:\n((?:^        - .*\n|^          .*\n|^            .*\n)+)',
        doc,re.M)
    if name in app_names:
        expected=f'        - configMapRef:\n            name: {release_metadata_name}\n'
        if env_from!=[expected] or doc.count('envFrom:')!=1 or doc.count('configMapRef:')!=1:
            raise SystemExit('guard:release-metadata-reference')
    elif env_from or 'envFrom:' in doc or 'configMapRef:' in doc:
        raise SystemExit('guard:unexpected-env-from')
    refs_found=re.findall(r'secretKeyRef:\n\s+key:\s*(\S+)\n\s+name:\s*(\S+)',doc)
    if len(refs_found)!=doc.count('secretKeyRef:'): raise SystemExit('guard:secret-reference-shape')
    if {key for key,_ in refs_found}!=expected_secret_keys[name] or any(secret not in allowed_secret_names for _,secret in refs_found):
        raise SystemExit('guard:secret-reference')
    if any(secret != 'combo-dev-env' for _,secret in refs_found):
        raise SystemExit('guard:secret-reference-name')
    pull_refs=re.findall(r'^      imagePullSecrets:\n      - name:\s*(\S+)$',doc,re.M)
    expected_pull=['combo-dev-registry'] if name in {'api','runtime','web','worker','migrate'} else []
    if pull_refs!=expected_pull: raise SystemExit('guard:image-pull-secret')

if 'volumeClaimTemplates:' in text or 'persistentVolumeClaimRetentionPolicy:' in text:
    raise SystemExit('guard:dynamic-pvc-template')
expected_claim={'postgres':'data-postgres-0','redis-queue':'data-redis-queue-0','minio':'data-minio-0'}
expected_marker={
 'postgres':'combo-dev-static-volume=postgres:v1',
 'redis-queue':'combo-dev-static-volume=redis-queue:v1',
 'minio':'combo-dev-static-volume=minio:v1'}
for name,claim in expected_claim.items():
    workload=workloads[name]
    if not re.search(rf'^      - name: data\n        persistentVolumeClaim:\n          claimName: {re.escape(claim)}$',workload,re.M):
        raise SystemExit('guard:static-pvc-mount')
    if not re.search(r'^        - mountPath: /combo-dev-volume-marker\n          name: data\n          readOnly: true\n          subPath: \.combo-dev-volume$',workload,re.M):
        raise SystemExit('guard:static-marker-mount')
    if not re.search(r'^        - mountPath: (?:/data|/var/lib/postgresql/data)\n          name: data\n          subPath: data$',workload,re.M):
        raise SystemExit('guard:static-data-subpath')
    if expected_marker[name] not in workload: raise SystemExit('guard:static-marker-state')
if text.count('persistentVolumeClaim:')!=3: raise SystemExit('guard:static-pvc-count')
if len(re.findall(r'^      - emptyDir:',text,re.M))!=len(re.findall(r'^          sizeLimit:',text,re.M)): raise SystemExit('guard:emptydir')
for config_name,workload_name in (('redis-hot-config','redis-hot'),('redis-queue-config','redis-queue')):
    config_doc=doc_for('ConfigMap',config_name); workload_doc=workloads[workload_name]; lines=config_doc.splitlines()
    try: start=next(index for index,line in enumerate(lines) if line=='  redis.conf: |')+1
    except StopIteration: raise SystemExit('guard:redis-config')
    body=[]
    for line in lines[start:]:
        if line.startswith('    '): body.append(line[4:])
        else: break
    digest=hashlib.sha256(('\n'.join(body)+'\n').encode()).hexdigest()
    if f'combo.dev/config-sha256: {digest}' not in workload_doc: raise SystemExit('guard:redis-config-checksum')
if 'https://test.43-160-242-46.sslip.io' not in text or 'https://test-s3.43-160-242-46.sslip.io' not in text: raise SystemExit('guard:origins')
if 'access_log off;' not in text or 'OTEL_SDK_DISABLED' not in text: raise SystemExit('guard:logging')
for endpoint,file in (
 ('/runtime-config.json','runtime-config.json'),
 ('/version.json','version.json'),
 ('/try/runtime-config.json','try-runtime-config.json')):
    if f'location = {endpoint} {{' not in text or f'alias /var/run/combo-web/{file};' not in text:
        raise SystemExit('guard:web-runtime-metadata')
if 'alias /usr/share/nginx/html/try/;' not in text or 'alias /usr/share/nginx/try/;' in text:
    raise SystemExit('guard:web-try-root')
telemetry=re.findall(r'location = /api/v1/client-events \{([\s\S]*?)^\s*\}',text,re.M)
if len(telemetry)!=1: raise SystemExit('guard:telemetry-boundary')
if 'return 204;' not in telemetry[0] or 'access_log off;' not in telemetry[0] or 'proxy_pass' in telemetry[0]:
    raise SystemExit('guard:telemetry-boundary')
PY
}

prepare_render() {
  local overlay_source=$1 destination=$2 api=$3 runtime=$4 web=$5
  local revision=$6 built_at=$7 manifest_digest=$8 web_asset_manifest=$9
  mkdir -p "$destination/overlay" "$destination/render"
  cp -a "$overlay_source/." "$destination/overlay/"
  inject_images "$destination/overlay" "$api" "$runtime" "$web"
  inject_release_metadata \
    "$destination/overlay" "$revision" "$built_at" "$manifest_digest" "$web_asset_manifest"
  local stage
  for stage in platform foundation init migrate apps; do
    kubectl kustomize "$destination/overlay/$stage" >"$destination/render/$stage.yaml" 2>/dev/null || fail "${stage} 清单渲染失败。"
  done
  python3 - "$destination/render" <<'PY'
import os, sys
root=sys.argv[1]
stages=('platform','foundation','init','migrate','apps')
parts=[]
for stage in stages:
    with open(os.path.join(root,stage+'.yaml'),'r',encoding='utf-8') as stream:
        value=stream.read().rstrip('\n')
    if not value: raise SystemExit(2)
    parts.append(value)
with open(os.path.join(root,'all.yaml'),'w',encoding='utf-8') as stream:
    stream.write('\n---\n'.join(parts)+'\n')
PY
  render_guard "$destination/render" || fail '逐阶段渲染安全守卫失败。'
  (
    cd "$destination/render"
    sha256sum platform.yaml foundation.yaml init.yaml migrate.yaml apps.yaml all.yaml >validated.sha256
  ) || fail '已验证清单摘要无法生成。'
  chmod 0600 "$destination/render/validated.sha256"
}

assert_validated_render() {
  local render=$1
  (cd "$render" && sha256sum -c validated.sha256 >/dev/null 2>&1) || blocked '已验证阶段清单在应用前发生变化。'
}

server_preflight() {
  local render=$1 stage rc job_probe="$WORK/job-rbac-preflight.yaml"
  assert_validated_render "$render"
  for stage in platform foundation apps; do
    if [[ "$stage" == foundation ]]; then
      "${K[@]}" apply --server-side --dry-run=server --field-manager=combo-dev-dispatcher --force-conflicts -f "$render/$stage.yaml" >/dev/null 2>&1 || blocked "${stage} 服务端 dry-run 失败。"
    else
      "${K[@]}" apply --server-side --dry-run=server --field-manager=combo-dev-dispatcher -f "$render/$stage.yaml" >/dev/null 2>&1 || blocked "${stage} 服务端 dry-run 失败。"
    fi
    set +e
    "${K[@]}" diff -f "$render/$stage.yaml" >/dev/null 2>&1
    rc=$?
    set -e
    (( rc == 0 || rc == 1 )) || blocked "${stage} 差异读取失败。"
  done
  for stage in init migrate; do
    "${K[@]}" create --dry-run=client --validate=strict -f "$render/$stage.yaml" >/dev/null 2>&1 || blocked "${stage} 客户端校验失败。"
  done
  cat >"$job_probe" <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: combo-dev-job-rbac-preflight
  namespace: combo-preview
spec:
  backoffLimit: 0
  template:
    metadata:
      labels:
        app: combo-dev-job-rbac-preflight
        combo.dev/environment: acceptance-canary
    spec:
      automountServiceAccountToken: false
      restartPolicy: Never
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        runAsGroup: 65534
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: probe
          image: $JOB_PREFLIGHT_IMAGE
          command: ["true"]
          resources:
            requests: { cpu: 10m, memory: 16Mi, ephemeral-storage: 16Mi }
            limits: { cpu: 20m, memory: 24Mi, ephemeral-storage: 24Mi }
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
EOF
  "${K[@]}" apply --server-side --dry-run=server --field-manager=combo-dev-dispatcher -f "$job_probe" >/dev/null 2>&1 || blocked 'Job 的服务端 apply 与 patch 权限预检失败。'
  assert_validated_render "$render"
}

apply_and_wait_foundation() {
  local render=$1 name
  assert_storage_headroom
  assert_validated_render "$render"
  "${K[@]}" apply --server-side --field-manager=combo-dev-dispatcher -f "$render/platform.yaml" >/dev/null 2>&1 || fail '平台约束应用失败。'
  assert_validated_render "$render"
  "${K[@]}" apply --server-side --field-manager=combo-dev-dispatcher --force-conflicts -f "$render/foundation.yaml" >/dev/null 2>&1 || fail '基础服务应用失败。'
  for name in "${FOUNDATION_NAMES[@]}"; do
    timeout 360 "${K[@]}" --request-timeout=0 -n "$NAMESPACE" rollout status "statefulset/$name" --timeout=350s >/dev/null 2>&1 || fail '有状态基础服务未在时限内就绪。'
  done
  timeout 240 "${K[@]}" --request-timeout=0 -n "$NAMESPACE" rollout status deployment/redis-hot --timeout=230s >/dev/null 2>&1 || fail '热 Redis 未在时限内就绪。'
}

run_pre_app_storage() {
  local rc
  set +e
  timeout 180 "$INSTALL_ROOT/bin/combo-dev-smoke" --storage-only >/dev/null 2>&1
  rc=$?
  set -e
  (( rc == 0 )) && return
  (( rc == 1 )) && fail '绑定 PV、独立挂载或硬容量上限不符合契约。'
  blocked '应用启动前的独立存储证据不可用。'
}

run_pre_app_isolation() {
  local rc
  set +e
  timeout 180 "$INSTALL_ROOT/bin/combo-dev-smoke" --network-canary-only >/dev/null 2>&1
  rc=$?
  set -e
  (( rc == 0 )) && return
  (( rc == 1 )) && fail '应用启动前网络 canary 到达了禁止目标。'
  blocked '应用启动前的网络隔离证据不可用。'
}

run_job() {
  local name=$1 manifest=$2 seconds=$3 render
  render=$(dirname "$manifest")
  assert_storage_headroom
  assert_validated_render "$render"
  delete_job_strict "$name" || fail '旧的一次性任务无法安全删除。'
  assert_validated_render "$render"
  "${K[@]}" apply --server-side --field-manager=combo-dev-dispatcher -f "$manifest" >/dev/null 2>&1 || fail '一次性任务创建失败。'
  timeout "$seconds" "${K[@]}" --request-timeout=0 -n "$NAMESPACE" wait --for=condition=complete "job/$name" --timeout="$((seconds - 10))s" >/dev/null 2>&1 || fail '一次性任务失败或超时。'
}

capture_migration_proof() {
  local revision=$1 workflow_run_id=$2 workflow_run_attempt=$3
  local expected_image=$4 output=$5
  local job="$WORK/migration.job.json"
  local pods="$WORK/migration.pods.json"
  local logs="$WORK/migration.log"
  local candidate="${output}.next"
  local pod_name log_bytes

  "${K[@]}" -n "$NAMESPACE" get job/migrate -o json >"$job" 2>/dev/null ||
    blocked '迁移完成后无法立即读取 Job。'
  "${K[@]}" -n "$NAMESPACE" get pods -l job-name=migrate -o json >"$pods" 2>/dev/null ||
    blocked '迁移完成后无法立即读取 Pod。'
  pod_name=$(jq -er '
    [.items[] | select(.metadata.deletionTimestamp == null) | .metadata.name]
    | if length == 1 then .[0] else error("migration-pod-count") end
  ' "$pods" 2>/dev/null) || blocked '迁移 Pod 数量不是精确的一个。'
  [[ "$pod_name" =~ ^migrate-[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] ||
    blocked '迁移 Pod 名称不符合固定 Job 生成规则。'
  "${K[@]}" -n "$NAMESPACE" logs "pod/$pod_name" -c migrate >"$logs" 2>/dev/null ||
    blocked '迁移完成后无法立即读取日志。'
  chmod 0600 "$job" "$pods" "$logs"
  log_bytes=$(stat -c '%s' "$logs" 2>/dev/null) || blocked '迁移日志大小不可读。'
  [[ "$log_bytes" =~ ^[0-9]+$ && "$log_bytes" -gt 0 && "$log_bytes" -le 65536 ]] ||
    blocked '迁移日志为空或超过 64 KiB。'

  if python3 - \
    "$revision" "$workflow_run_id" "$workflow_run_attempt" \
    "$expected_image" "$MIGRATION_HEAD" \
    "$job" "$pods" "$logs" "$candidate" <<'PY'
import datetime as dt
import hashlib
import json
import re
import sys

(
    revision, workflow_run_id, workflow_run_attempt, expected_image, expected_head,
    job_path, pods_path, log_path, output_path,
) = sys.argv[1:]
if (
    not re.fullmatch(r'[0-9a-f]{40}', revision)
    or not re.fullmatch(r'[1-9][0-9]*', workflow_run_id)
    or not re.fullmatch(r'[1-9][0-9]*', workflow_run_attempt)
):
    raise SystemExit(2)
expected_migrations = [
    '0000_baseline_schema.sql',
    '0001_expired_upload_reconciliation.sql',
    '0002_drop_stream_events.sql',
    '0003_turns.sql',
    '0004_studio_sessions.sql',
    '0005_capability_current_ui.sql',
    '0006_one_running_turn_per_session.sql',
    '0007_first_party_email_auth.sql',
    '0008_application_database_roles.sql',
    '0009_billing.sql',
]
uuid = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')

def timestamp(value):
    if not isinstance(value, str):
        raise SystemExit(2)
    try:
        return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(
            dt.timezone.utc,
        )
    except ValueError:
        raise SystemExit(2)

def one_container(value, name):
    matches = [item for item in value if item.get('name') == name]
    if len(matches) != 1:
        raise SystemExit(2)
    return matches[0]

with open(job_path, encoding='utf-8') as handle:
    job = json.load(handle)
with open(pods_path, encoding='utf-8') as handle:
    pod_items = json.load(handle).get('items', [])
with open(log_path, 'rb') as handle:
    raw_logs = handle.read()

metadata = job.get('metadata', {})
spec = job.get('spec', {})
status = job.get('status', {})
if (
    metadata.get('name') != 'migrate'
    or metadata.get('namespace') != 'combo-preview'
    or metadata.get('deletionTimestamp') is not None
    or not isinstance(metadata.get('uid'), str)
    or not uuid.fullmatch(metadata['uid'])
    or metadata.get('labels', {}).get('app') != 'migrate'
    or spec.get('backoffLimit') != 0
    or spec.get('activeDeadlineSeconds') != 600
    or spec.get('ttlSecondsAfterFinished') != 7200
    or status.get('succeeded') != 1
    or status.get('active', 0) != 0
    or status.get('failed', 0) != 0
):
    raise SystemExit(2)
conditions = status.get('conditions', [])
if not any(
    item.get('type') == 'Complete' and item.get('status') == 'True'
    for item in conditions
) or any(
    item.get('type') == 'Failed' and item.get('status') == 'True'
    for item in conditions
):
    raise SystemExit(2)

job_container = one_container(
    spec.get('template', {}).get('spec', {}).get('containers', []),
    'migrate',
)
if (
    job_container.get('image') != expected_image
    or job_container.get('command') != [
        'node', '--experimental-strip-types', 'db/scripts/migrate.ts',
    ]
):
    raise SystemExit(2)
literal_env = {
    item.get('name'): item.get('value')
    for item in job_container.get('env', [])
    if set(item) == {'name', 'value'}
}
if literal_env.get('EXPECTED_MIGRATION_HEAD') != expected_head:
    raise SystemExit(2)
if literal_env.get('MIGRATION_RUNS') != '2':
    raise SystemExit(2)

pods = [
    item for item in pod_items
    if item.get('metadata', {}).get('deletionTimestamp') is None
]
if len(pods) != 1:
    raise SystemExit(2)
pod = pods[0]
pod_meta = pod.get('metadata', {})
pod_status = pod.get('status', {})
owners = pod_meta.get('ownerReferences', [])
if (
    pod_meta.get('namespace') != 'combo-preview'
    or not isinstance(pod_meta.get('uid'), str)
    or not uuid.fullmatch(pod_meta['uid'])
    or pod_meta.get('labels', {}).get('job-name') != 'migrate'
    or len(owners) != 1
    or owners[0].get('kind') != 'Job'
    or owners[0].get('name') != 'migrate'
    or owners[0].get('uid') != metadata['uid']
    or owners[0].get('controller') is not True
    or pod_status.get('phase') != 'Succeeded'
):
    raise SystemExit(2)
pod_container = one_container(pod.get('spec', {}).get('containers', []), 'migrate')
container_status = one_container(pod_status.get('containerStatuses', []), 'migrate')
terminated = container_status.get('state', {}).get('terminated', {})
image_id = container_status.get('imageID')
expected_digest = expected_image.split('@', 1)[1]
if (
    pod_container.get('image') != expected_image
    or not isinstance(image_id, str)
    or not image_id.endswith(expected_digest)
    or terminated.get('exitCode') != 0
    or terminated.get('reason') != 'Completed'
):
    raise SystemExit(2)

created_at = timestamp(metadata.get('creationTimestamp'))
started_at = timestamp(status.get('startTime'))
completed_at = timestamp(status.get('completionTime'))
pod_started_at = timestamp(terminated.get('startedAt'))
pod_finished_at = timestamp(terminated.get('finishedAt'))
if not (
    created_at <= started_at <= pod_started_at <= pod_finished_at <= completed_at
):
    raise SystemExit(2)

try:
    text = raw_logs.decode('utf-8')
except UnicodeDecodeError:
    raise SystemExit(2)
lines = [line for line in text.splitlines() if line]
expected_lines = (
    [f'applying {name} ...' for name in expected_migrations]
    + [
        f'migration pass 1/2 up to date at {expected_head}.',
        f'migration pass 2/2 up to date at {expected_head}.',
        'application database roles ready.',
    ]
)
if lines != expected_lines:
    raise SystemExit(2)
if re.search(r'(?:0017_|0018_|ledger mismatch|migration head mismatch|error|failed)', text, re.I):
    raise SystemExit(2)

proof = {
    'schemaVersion': 1,
    'namespace': 'combo-preview',
    'sourceSha': revision,
    'workflowRunId': workflow_run_id,
    'workflowRunAttempt': workflow_run_attempt,
    'capturedAt': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'head': expected_head,
    'runs': 2,
    'appliedMigrations': expected_migrations,
    'passes': [
        {'run': 1, 'head': expected_head},
        {'run': 2, 'head': expected_head},
    ],
    'job': {
        'name': 'migrate',
        'uid': metadata['uid'],
        'createdAt': metadata['creationTimestamp'],
        'startedAt': status['startTime'],
        'completedAt': status['completionTime'],
        'succeeded': status['succeeded'],
        'ttlSecondsAfterFinished': spec['ttlSecondsAfterFinished'],
    },
    'pod': {
        'name': pod_meta['name'],
        'uid': pod_meta['uid'],
        'startedAt': terminated['startedAt'],
        'finishedAt': terminated['finishedAt'],
        'image': expected_image,
        'imageID': image_id,
        'exitCode': terminated['exitCode'],
    },
    'logSha256': f"sha256:{hashlib.sha256(raw_logs).hexdigest()}",
}
with open(output_path, 'w', encoding='utf-8') as handle:
    json.dump(proof, handle, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    handle.write('\n')
PY
  then
    [[ -f "$candidate" && ! -L "$candidate" ]] || return 1
    chmod 0600 "$candidate" || return 1
    mv -T -- "$candidate" "$output" || return 1
  else
    return 1
  fi
}

wait_apps() {
  local render=$1 name
  assert_storage_headroom
  assert_validated_render "$render"
  "${K[@]}" apply --server-side --field-manager=combo-dev-dispatcher -f "$render/apps.yaml" >/dev/null 2>&1 || fail '应用清单应用失败。'
  for name in "${APP_NAMES[@]}"; do
    apply_app_replicas "$name" 1 || fail '应用副本所有权无法恢复。'
  done
  for name in "${APP_NAMES[@]}"; do
    timeout 420 "${K[@]}" --request-timeout=0 -n "$NAMESPACE" rollout status "deployment/$name" --timeout=410s >/dev/null 2>&1 || fail '应用未在时限内就绪。'
  done
}

verify_writers_restored() {
  local kind name desired current ready updated
  for name in "${APP_NAMES[@]}" redis-hot; do
    kind=deployment
    desired=$("${K[@]}" -n "$NAMESPACE" get "$kind/$name" -o jsonpath='{.spec.replicas}' 2>/dev/null) || return 1
    current=$("${K[@]}" -n "$NAMESPACE" get "$kind/$name" -o jsonpath='{.status.replicas}' 2>/dev/null) || return 1
    ready=$("${K[@]}" -n "$NAMESPACE" get "$kind/$name" -o jsonpath='{.status.readyReplicas}' 2>/dev/null) || return 1
    updated=$("${K[@]}" -n "$NAMESPACE" get "$kind/$name" -o jsonpath='{.status.updatedReplicas}' 2>/dev/null) || return 1
    [[ "$desired" == 1 && "$current" == 1 && "$ready" == 1 && "$updated" == 1 ]] || return 1
  done
  for name in "${FOUNDATION_NAMES[@]}"; do
    kind=statefulset
    desired=$("${K[@]}" -n "$NAMESPACE" get "$kind/$name" -o jsonpath='{.spec.replicas}' 2>/dev/null) || return 1
    current=$("${K[@]}" -n "$NAMESPACE" get "$kind/$name" -o jsonpath='{.status.currentReplicas}' 2>/dev/null) || return 1
    ready=$("${K[@]}" -n "$NAMESPACE" get "$kind/$name" -o jsonpath='{.status.readyReplicas}' 2>/dev/null) || return 1
    updated=$("${K[@]}" -n "$NAMESPACE" get "$kind/$name" -o jsonpath='{.status.updatedReplicas}' 2>/dev/null) || return 1
    [[ "$desired" == 1 && "$current" == 1 && "$ready" == 1 && "$updated" == 1 ]] || return 1
  done
}

write_test_evidence() {
  local revision=$1 workflow_run_id=$2 workflow_run_attempt=$3
  local manifest=$4 digest_file=$5 reset_proof=$6 migration_proof=$7
  local evidence_dir='/var/lib/combo-dev/evidence'
  local output="$evidence_dir/${revision}.${workflow_run_id}.${workflow_run_attempt}.json"
  local candidate="$WORK/test-evidence.json"
  local inventory="$WORK/evidence.inventory.json"
  local runtime_config="$WORK/evidence.runtime-config.json"
  local version="$WORK/evidence.version.json"
  local try_config="$WORK/evidence.try-runtime-config.json"
  local missing_web missing_try

  "${K[@]}" -n "$NAMESPACE" get \
    deployments.apps,statefulsets.apps,daemonsets.apps,jobs.batch,cronjobs.batch,services,pods,configmaps,serviceaccounts,networkpolicies.networking.k8s.io,ingresses.networking.k8s.io,horizontalpodautoscalers.autoscaling,roles.rbac.authorization.k8s.io,rolebindings.rbac.authorization.k8s.io,resourcequotas,limitranges,persistentvolumeclaims \
    -o json >"$inventory" 2>/dev/null ||
    blocked 'Test evidence 无法读取不含 Secret 的完整资源清单。'

  curl --silent --show-error --fail --max-time 15 --max-filesize 1048576 \
    'http://127.0.0.1:18080/runtime-config.json' >"$runtime_config" 2>/dev/null ||
    blocked 'Test evidence 无法读取 runtime-config.json。'
  curl --silent --show-error --fail --max-time 15 --max-filesize 1048576 \
    'http://127.0.0.1:18080/version.json' >"$version" 2>/dev/null ||
    blocked 'Test evidence 无法读取 version.json。'
  curl --silent --show-error --fail --max-time 15 --max-filesize 1048576 \
    'http://127.0.0.1:18080/try/runtime-config.json' >"$try_config" 2>/dev/null ||
    blocked 'Test evidence 无法读取 try/runtime-config.json。'
  missing_web=$(curl --silent --max-time 15 --output /dev/null --write-out '%{http_code}' \
    'http://127.0.0.1:18080/assets/goal-b-missing-deadbeef.js' 2>/dev/null) ||
    blocked 'Test evidence 无法验证 Web 缺失哈希资源。'
  missing_try=$(curl --silent --max-time 15 --output /dev/null --write-out '%{http_code}' \
    'http://127.0.0.1:18080/try/assets/goal-b-missing-deadbeef.js' 2>/dev/null) ||
    blocked 'Test evidence 无法验证 Runtime Web 缺失哈希资源。'

  python3 - \
    "$revision" "$workflow_run_id" "$workflow_run_attempt" \
    "$manifest" "$digest_file" "$reset_proof" "$migration_proof" "$inventory" \
    "$runtime_config" "$version" "$try_config" "$missing_web" "$missing_try" \
    "$candidate" <<'PY'
import datetime as dt
import json
import re
import sys

(
    revision, workflow_run_id, workflow_run_attempt,
    manifest_path, digest_path, reset_path, migration_path, inventory_path,
    runtime_config_path, version_path, try_config_path, missing_web, missing_try,
    output_path,
) = sys.argv[1:]

def load(path):
    with open(path, encoding='utf-8') as handle:
        return json.load(handle)

def digest_matches(image_id, image):
    return (
        isinstance(image_id, str)
        and isinstance(image, str)
        and '@sha256:' in image
        and image_id.endswith(image.split('@', 1)[1])
    )

manifest = load(manifest_path)
reset = load(reset_path)
migration = load(migration_path)
items = load(inventory_path).get('items', [])
configs = {
    'runtimeConfig': load(runtime_config_path),
    'version': load(version_path),
    'tryRuntimeConfig': load(try_config_path),
}
manifest_digest = open(digest_path, encoding='utf-8').read().strip()

if (
    not re.fullmatch(r'[1-9][0-9]*', workflow_run_id)
    or not re.fullmatch(r'[1-9][0-9]*', workflow_run_attempt)
    or manifest.get('sourceSha') != revision
    or manifest.get('releaseId') != f'release-{revision}'
    or manifest.get('migrationHead') != '0009_billing.sql'
):
    raise SystemExit(2)
if not re.fullmatch(r'sha256:[0-9a-f]{64}', manifest_digest):
    raise SystemExit(2)
metadata_fields = (
    'environment', 'sourceSha', 'releaseId', 'builtAt',
    'releaseManifestDigest', 'webAssetManifest',
)
expected_metadata = {
    'environment': 'test',
    'sourceSha': revision,
    'releaseId': manifest['releaseId'],
    'builtAt': manifest['builtAt'],
    'releaseManifestDigest': manifest_digest,
    'webAssetManifest': manifest['webAssetManifest'],
}
for value in configs.values():
    if {key: value.get(key) for key in metadata_fields} != expected_metadata:
        raise SystemExit(2)
if missing_web != '404' or missing_try != '404':
    raise SystemExit(2)

if (
    reset.get('schemaVersion') != 1
    or reset.get('namespace') != 'combo-preview'
    or reset.get('sourceSha') != revision
    or reset.get('workflowRunId') != workflow_run_id
    or reset.get('workflowRunAttempt') != workflow_run_attempt
    or reset.get('storage') != {
        'postgres': {'clearedBeforeRebuild': True},
        'redisQueue': {'clearedBeforeRebuild': True},
        'minio': {'clearedBeforeRebuild': True},
    }
    or {entry.get('plane') for entry in reset.get('foundation', [])}
       != {'minio', 'postgres', 'redis-hot', 'redis-queue'}
):
    raise SystemExit(2)

expected_migrations = [
    '0000_baseline_schema.sql',
    '0001_expired_upload_reconciliation.sql',
    '0002_drop_stream_events.sql',
    '0003_turns.sql',
    '0004_studio_sessions.sql',
    '0005_capability_current_ui.sql',
    '0006_one_running_turn_per_session.sql',
    '0007_first_party_email_auth.sql',
    '0008_application_database_roles.sql',
    '0009_billing.sql',
]
expected_passes = [
    {'run': 1, 'head': '0009_billing.sql'},
    {'run': 2, 'head': '0009_billing.sql'},
]
if (
    migration.get('schemaVersion') != 1
    or migration.get('namespace') != 'combo-preview'
    or migration.get('sourceSha') != revision
    or migration.get('workflowRunId') != workflow_run_id
    or migration.get('workflowRunAttempt') != workflow_run_attempt
    or migration.get('head') != manifest['migrationHead']
    or migration.get('runs') != 2
    or migration.get('appliedMigrations') != expected_migrations
    or migration.get('passes') != expected_passes
    or migration.get('job', {}).get('succeeded') != 1
    or migration.get('job', {}).get('ttlSecondsAfterFinished') != 7200
    or migration.get('pod', {}).get('exitCode') != 0
    or migration.get('pod', {}).get('image') != manifest['images']['api']
    or not digest_matches(
        migration.get('pod', {}).get('imageID'),
        manifest['images']['api'],
    )
    or not re.fullmatch(r'sha256:[0-9a-f]{64}', migration.get('logSha256', ''))
):
    raise SystemExit(2)

expected_names = {
    'Deployment': {'api', 'redis-hot', 'runtime', 'web', 'worker'},
    'StatefulSet': {'minio', 'postgres', 'redis-queue'},
    'DaemonSet': set(),
    'Job': {'migrate'},
    'CronJob': set(),
    'Service': {'api', 'minio', 'postgres', 'redis-hot', 'redis-queue', 'runtime', 'web'},
    'ServiceAccount': {'default'},
    'NetworkPolicy': {
        'allow-dns', 'app-ingress-from-web', 'approved-public-https',
        'authoring-internal-egress', 'default-deny', 'migrate-egress',
        'minio-ingress', 'minio-init-egress', 'network-canary-dns-only',
        'postgres-ingress', 'redis-hot-ingress', 'redis-queue-ingress',
        'runtime-internal-egress', 'web-to-apps',
    },
    'Ingress': set(),
    'HorizontalPodAutoscaler': set(),
    'Role': {'combo-dev-dispatcher', 'combo-dev-fencer'},
    'RoleBinding': {'combo-dev-dispatcher', 'combo-dev-fencer'},
    'ResourceQuota': {'combo-dev-ceiling'},
    'LimitRange': {'combo-dev-defaults'},
    'PersistentVolumeClaim': {
        'data-minio-0', 'data-postgres-0', 'data-redis-queue-0',
    },
}
allowed_kinds = set(expected_names) | {'ConfigMap', 'Pod'}
by_kind = {kind: [] for kind in allowed_kinds}
for item in items:
    kind = item.get('kind')
    metadata = item.get('metadata', {})
    if (
        kind not in allowed_kinds
        or metadata.get('namespace') != 'combo-preview'
        or metadata.get('deletionTimestamp') is not None
        or not isinstance(metadata.get('name'), str)
    ):
        raise SystemExit(2)
    by_kind[kind].append(item)
for kind, expected in expected_names.items():
    actual = [item['metadata']['name'] for item in by_kind[kind]]
    if len(actual) != len(set(actual)) or set(actual) != expected:
        raise SystemExit(2)

config_names = {item['metadata']['name'] for item in by_kind['ConfigMap']}
static_configs = {
    'combo-dev-minio-config', 'combo-dev-postgres-entrypoint',
    'kube-root-ca.crt', 'minio-init-script', 'redis-hot-config',
    'redis-queue-config', f'combo-release-meta-{revision[:12]}',
}
nginx_configs = {
    name for name in config_names
    if re.fullmatch(r'combo-dev-nginx-[a-z0-9]+', name)
}
if len(config_names) != 8 or config_names - nginx_configs != static_configs or len(nginx_configs) != 1:
    raise SystemExit(2)

for service in by_kind['Service']:
    spec = service.get('spec', {})
    if (
        spec.get('type', 'ClusterIP') != 'ClusterIP'
        or spec.get('externalName') is not None
        or spec.get('externalIPs') not in (None, [])
        or spec.get('loadBalancerIP') is not None
        or spec.get('loadBalancerClass') is not None
        or any(port.get('nodePort') is not None for port in spec.get('ports', []))
    ):
        raise SystemExit(2)

pvc_contract = {
    'data-postgres-0': ('combo-dev-postgres', '8Gi'),
    'data-redis-queue-0': ('combo-dev-redis-queue', '2Gi'),
    'data-minio-0': ('combo-dev-minio', '6Gi'),
}
for pvc in by_kind['PersistentVolumeClaim']:
    name = pvc['metadata']['name']
    volume, size = pvc_contract[name]
    spec = pvc.get('spec', {})
    if (
        pvc.get('status', {}).get('phase') != 'Bound'
        or spec.get('volumeName') != volume
        or spec.get('storageClassName') != 'combo-dev-bounded'
        or spec.get('resources', {}).get('requests', {}).get('storage') != size
    ):
        raise SystemExit(2)

expected_pod_planes = {
    'api', 'minio', 'postgres', 'redis-hot', 'redis-queue',
    'runtime', 'web', 'worker', 'migrate',
}
pods_by_plane = {}
pod_inventory = []
for pod in by_kind['Pod']:
    metadata = pod['metadata']
    plane = metadata.get('labels', {}).get('app')
    if plane not in expected_pod_planes or plane in pods_by_plane:
        raise SystemExit(2)
    phase = pod.get('status', {}).get('phase')
    statuses = pod.get('status', {}).get('containerStatuses', [])
    if plane == 'migrate':
        healthy = (
            phase == 'Succeeded'
            and metadata.get('uid') == migration['pod']['uid']
            and metadata.get('name') == migration['pod']['name']
        )
    else:
        healthy = phase == 'Running' and bool(statuses) and all(
            status.get('ready') is True for status in statuses
        )
    if not healthy:
        raise SystemExit(2)
    pods_by_plane[plane] = pod
    pod_inventory.append({
        'name': metadata['name'],
        'plane': plane,
        'podUid': metadata.get('uid'),
        'phase': phase,
        'healthy': True,
    })
if set(pods_by_plane) != expected_pod_planes:
    raise SystemExit(2)

expected_images = {
    'api': manifest['images']['api'],
    'worker': manifest['images']['api'],
    'runtime': manifest['images']['runtime'],
    'web': manifest['images']['web'],
}
live = []
deployments = {item['metadata']['name']: item for item in by_kind['Deployment']}
for plane, expected_image in expected_images.items():
    deployment = deployments[plane]
    pod = pods_by_plane[plane]
    containers = [
        item for item in pod.get('spec', {}).get('containers', [])
        if item.get('name') == plane
    ]
    statuses = [
        item for item in pod.get('status', {}).get('containerStatuses', [])
        if item.get('name') == plane
    ]
    deployment_status = deployment.get('status', {})
    if (
        len(containers) != 1
        or len(statuses) != 1
        or containers[0].get('image') != expected_image
        or statuses[0].get('ready') is not True
        or not digest_matches(statuses[0].get('imageID'), expected_image)
        or deployment_status.get('readyReplicas') != 1
        or deployment_status.get('updatedReplicas') != 1
        or deployment_status.get('unavailableReplicas', 0) != 0
    ):
        raise SystemExit(2)
    live.append({
        'plane': plane,
        'image': expected_image,
        'imageID': statuses[0]['imageID'],
        'podUid': pod['metadata']['uid'],
        'ready': True,
    })

inventory_keys = {
    'Deployment': 'deployments',
    'StatefulSet': 'statefulSets',
    'DaemonSet': 'daemonSets',
    'Job': 'jobs',
    'CronJob': 'cronJobs',
    'Service': 'services',
    'ConfigMap': 'configMaps',
    'ServiceAccount': 'serviceAccounts',
    'NetworkPolicy': 'networkPolicies',
    'Ingress': 'ingresses',
    'HorizontalPodAutoscaler': 'horizontalPodAutoscalers',
    'Role': 'roles',
    'RoleBinding': 'roleBindings',
    'ResourceQuota': 'resourceQuotas',
    'LimitRange': 'limitRanges',
    'PersistentVolumeClaim': 'persistentVolumeClaims',
}
resource_inventory = {
    key: sorted(item['metadata']['name'] for item in by_kind[kind])
    for kind, key in inventory_keys.items()
}
resource_inventory['pods'] = sorted(pod_inventory, key=lambda item: item['plane'])
resource_inventory['excludedKinds'] = ['Secret']

legacy_pattern = re.compile(
    r'(?:consumer|sweeper|outbox|cloud-review|rt[-_](?:chat|studio))',
    re.I,
)
legacy_findings = sorted({
    f"{kind}/{item['metadata']['name']}"
    for kind, values in by_kind.items()
    for item in values
    if legacy_pattern.search(item['metadata']['name'])
})
if legacy_findings:
    raise SystemExit(2)

result = {
    'schemaVersion': 1,
    'createdAt': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'workflowRunId': workflow_run_id,
    'workflowRunAttempt': workflow_run_attempt,
    'sourceSha': revision,
    'releaseId': manifest['releaseId'],
    'releaseManifestDigest': manifest_digest,
    'reset': reset,
    'migration': migration,
    'webAssetManifest': manifest['webAssetManifest'],
    'images': manifest['images'],
    'livePlanes': sorted(live, key=lambda item: item['plane']),
    'releaseMetadata': configs,
    'missingHashedAssets': {'web': 404, 'runtimeWeb': 404},
    'resourceInventory': resource_inventory,
    'legacyFindings': legacy_findings,
    'legacyObjectsAbsent': len(legacy_findings) == 0,
}
with open(output_path, 'w', encoding='utf-8') as handle:
    json.dump(result, handle, ensure_ascii=False, sort_keys=True, indent=2)
    handle.write('\n')
PY

  [[ $(stat -c '%u:%g:%a' "$evidence_dir" 2>/dev/null) == '0:0:755' ]] ||
    blocked 'Test evidence 目录不符合 control-state 固定权限。'
  rm -f -- "$output"
  install -o root -g root -m 0644 "$candidate" "$output" ||
    blocked 'Test evidence 无法写入受保护目录。'
}
prune_stale_configs() {
  local deployments live_refs live_web live_release listed stale_json stale_names name failed=0
  deployments=$("${K[@]}" -n "$NAMESPACE" get deployment "${APP_NAMES[@]}" -o json 2>/dev/null) ||
    blocked '应用配置引用清单不可读。'
  live_refs=$(
    printf '%s' "$deployments" |
      jq -cer '
        def release_ref:
          .metadata.name as $app
          | [.spec.template.spec.containers[] | select(.name == $app)] as $containers
          | if ($containers | length) != 1 then error("container") else $containers[0] end
          | .envFrom as $sources
          | if ($sources | type) != "array" or ($sources | length) != 1
              then error("envFrom")
            else $sources[0]
            end
          | if (keys != ["configMapRef"]) or ((.configMapRef | keys) != ["name"])
              then error("configMapRef")
            else .configMapRef.name
            end;
        .items
        | if length != 4 or ([.[].metadata.name] | sort) != ["api", "runtime", "web", "worker"]
            then error("inventory")
          else .
          end
        | . as $apps
        | [$apps[] | release_ref] as $release_refs
        | [
            $apps[]
            | select(.metadata.name == "web")
            | .spec.template.spec.volumes[]?
            | select(.name == "nginx-template")
            | .configMap.name
          ] as $web_refs
        | if
            ($release_refs | length) != 4
            or ($release_refs | unique | length) != 1
            or ($release_refs[0] | test("^combo-release-meta-[0-9a-f]{12}$")) != true
            or ($web_refs | length) != 1
            or ($web_refs[0] | test("^combo-dev-nginx-[a-z0-9]+$")) != true
          then error("references")
          else {release: $release_refs[0], web: $web_refs[0]}
          end
      '
  ) || blocked '应用没有共享唯一且带摘要的 Test 配置引用。'
  live_release=$(jq -er '.release' <<<"$live_refs") || blocked '应用发布身份引用不可读。'
  live_web=$(jq -er '.web' <<<"$live_refs") || blocked 'Web 配置引用不可读。'

  listed=$("${K[@]}" -n "$NAMESPACE" get configmaps -l combo.dev/environment=combo-dev -o json 2>/dev/null) ||
    blocked 'Test 配置清单不可读。'
  stale_json=$(
    printf '%s' "$listed" |
      jq -cer --arg release "$live_release" --arg web "$live_web" '
        [
          .items[].metadata.name
          | select(
              (test("^combo-dev-nginx-[a-z0-9]+$") and . != $web)
              or (test("^combo-release-meta-[0-9a-f]{12}$") and . != $release)
            )
        ] | sort
      '
  ) || blocked '旧 Test 配置清单无法安全归类。'
  stale_names=$(jq -r '.[]' <<<"$stale_json") || blocked '旧 Test 配置名不可读。'
  [[ -z "$stale_names" ]] && return
  while IFS= read -r name; do
    if [[ "$name" =~ ^combo-dev-nginx-[a-z0-9]+$ && "$name" != "$live_web" ]]; then
      :
    elif [[ "$name" =~ ^combo-release-meta-[0-9a-f]{12}$ && "$name" != "$live_release" ]]; then
      :
    else
      blocked '旧 Test 配置名不在严格删除白名单内。'
    fi
    "${K[@]}" -n "$NAMESPACE" delete "configmap/$name" --wait=false >/dev/null 2>&1 || failed=1
  done <<<"$stale_names"
  (( failed == 0 )) || fail '旧 Web 或发布身份配置无法清理。'
}

check_loopback_listeners_once() {
  local sockets="$WORK/listeners.txt" web_pid s3_pid
  ss -H -ltnp >"$sockets" 2>/dev/null || return 2
  web_pid=$(timeout 10 systemctl show combo-dev-web-forward.service -p MainPID --value 2>/dev/null) || return 2
  s3_pid=$(timeout 10 systemctl show combo-dev-s3-forward.service -p MainPID --value 2>/dev/null) || return 2
  [[ "$web_pid" =~ ^[1-9][0-9]*$ && "$s3_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  "$INSTALL_ROOT/bin/combo-dev-production-safety" validate-listeners \
    --input "$sockets" --web-pid "$web_pid" --s3-pid "$s3_pid" >/dev/null 2>&1 || return 1
}

wait_loopback_listeners() {
  local attempt rc
  for ((attempt = 1; attempt <= 30; attempt++)); do
    if check_loopback_listeners_once; then return 0; else rc=$?; fi
    (( rc == 1 )) || blocked '无法读取主机监听状态或转发器进程身份。'
    sleep 1
  done
  fail '开发端口完整监听集合不是两个固定回环转发器。'
}

post_capacity() {
  assert_storage_headroom
  assert_control_state_headroom
  assert_host_capacity
}

prune_releases() {
  local release_plan="$WORK/prune-releases.nul" incoming_plan="$WORK/prune-incoming.nul"
  local path mounts target
  local -a stale_releases=() stale_incoming=()
  mounts=$(findmnt -rn -o TARGET) || blocked '无法读取挂载表；拒绝清理 release。'
  while IFS= read -r target; do
    [[ "$target" == "$INSTALL_ROOT/releases" || "$target" == "$CONTROL_STATE" ]] && continue
    [[ "$target" == "$INSTALL_ROOT/releases"/* || "$target" == "$CONTROL_RELEASES"/* ]] || continue
    blocked 'release 树内存在非固定挂载点；拒绝清理。'
  done <<<"$mounts"
  python3 - "$INSTALL_ROOT/releases" "$INSTALL_ROOT/incoming" "$INSTALL_ROOT/current" \
    "$release_plan" "$incoming_plan" <<'PY' || blocked 'release 或 incoming 包含不受信任的条目；未执行清理。'
import os
import re
import stat
import sys
import time

releases_dir, incoming_dir, current_link, release_plan, incoming_plan = sys.argv[1:]
sha = re.compile(r'^[0-9a-f]{40}$')

def safe_dir(path, mode=None):
    value = os.lstat(path)
    if not stat.S_ISDIR(value.st_mode) or stat.S_ISLNK(value.st_mode):
        raise SystemExit(2)
    if value.st_uid != 0 or value.st_gid != 0 or value.st_mode & 0o022:
        raise SystemExit(2)
    if mode is not None and stat.S_IMODE(value.st_mode) != mode:
        raise SystemExit(2)

def safe_tree(path, expected_device):
    for current, dirs, files in os.walk(path, followlinks=False):
        for entry in [current] + [os.path.join(current, name) for name in dirs + files]:
            value = os.lstat(entry)
            if (value.st_dev != expected_device or value.st_uid != 0
                    or value.st_mode & 0o022 or stat.S_ISLNK(value.st_mode)):
                raise SystemExit(2)
            if not (stat.S_ISDIR(value.st_mode) or stat.S_ISREG(value.st_mode)):
                raise SystemExit(2)

safe_dir(releases_dir, 0o755)
safe_dir(os.path.join(releases_dir, '.staging'), 0o700)
device = os.lstat(releases_dir).st_dev
current = None
if os.path.lexists(current_link):
    if not os.path.islink(current_link):
        raise SystemExit(2)
    current = os.path.realpath(current_link)
    if os.path.dirname(current) != os.path.realpath(releases_dir) or not sha.fullmatch(os.path.basename(current)):
        raise SystemExit(2)
    safe_dir(current)
    safe_tree(current, device)

releases = []
for name in os.listdir(releases_dir):
    if name == '.staging':
        continue
    if not sha.fullmatch(name):
        raise SystemExit(2)
    path = os.path.join(releases_dir, name)
    safe_dir(path)
    safe_tree(path, device)
    releases.append((os.lstat(path).st_mtime_ns, name, path))
releases.sort(key=lambda item: (-item[0], item[1]))
keep = {current} if current is not None else set()
for _, _, path in releases:
    if len(keep) >= 3:
        break
    keep.add(path)
with open(release_plan, 'wb') as output:
    for _, _, path in releases:
        if path not in keep:
            output.write(os.fsencode(path) + b'\0')

incoming = os.lstat(incoming_dir)
if (not stat.S_ISDIR(incoming.st_mode) or stat.S_ISLNK(incoming.st_mode)
        or incoming.st_uid != 0 or incoming.st_gid != 0
        or stat.S_IMODE(incoming.st_mode) != 0o1733):
    raise SystemExit(2)
allowed = re.compile(
    r'^(?:[0-9a-f]{40}(?:\.acceptance)?\.[1-9][0-9]*\.[1-9][0-9]*\.tar\.gz|'
    r'\.[0-9a-f]{40}(?:\.acceptance)?\.[1-9][0-9]*\.[1-9][0-9]*\.upload)$'
)
cutoff = time.time() - (2 * 24 * 60 * 60)
with open(incoming_plan, 'wb') as output:
    for name in os.listdir(incoming_dir):
        path = os.path.join(incoming_dir, name)
        value = os.lstat(path)
        if (not allowed.fullmatch(name) or not stat.S_ISREG(value.st_mode)
                or stat.S_ISLNK(value.st_mode)):
            raise SystemExit(2)
        if value.st_mtime < cutoff:
            output.write(os.fsencode(path) + b'\0')
PY
  mapfile -d '' -t stale_releases <"$release_plan"
  mapfile -d '' -t stale_incoming <"$incoming_plan"
  for path in "${stale_releases[@]}"; do
    [[ "$path" =~ ^/opt/combo-dev/releases/[0-9a-f]{40}$ ]] ||
      blocked 'release 清理计划越过固定目录。'
    rm -rf --one-file-system -- "$path" || blocked '旧 release 无法安全删除。'
    [[ ! -e "$path" && ! -L "$path" ]] || blocked '旧 release 删除后仍然存在。'
  done
  for path in "${stale_incoming[@]}"; do
    [[ "$path" == "$INSTALL_ROOT/incoming"/* && "$path" != "$INSTALL_ROOT/incoming"/*/* ]] ||
      blocked 'incoming 清理计划越过固定目录。'
    rm -f -- "$path" || blocked '旧 incoming 文件无法安全删除。'
    [[ ! -e "$path" && ! -L "$path" ]] || blocked '旧 incoming 文件删除后仍然存在。'
  done
}

render_only() {
  local output='' api='' runtime='' web='' revision='' manifest='' digest_file='' arg
  while (($#)); do
    arg=$1; shift
    case "$arg" in
      --output) output=${1:?}; shift ;;
      --api-image) api=${1:?}; shift ;;
      --runtime-image) runtime=${1:?}; shift ;;
      --web-image) web=${1:?}; shift ;;
      --revision) revision=${1:?}; shift ;;
      --release-manifest) manifest=${1:?}; shift ;;
      --release-manifest-digest-file) digest_file=${1:?}; shift ;;
      *) fail '未知 render-only 参数。' ;;
    esac
  done
  [[ -n "$output" ]] || fail 'render-only 必须指定输出文件。'
  [[ "$revision" =~ $SHA_RE ]] || fail 'render-only 必须指定完整 revision。'
  [[ -f "$manifest" && ! -L "$manifest" ]] || fail 'render-only 缺少发布清单。'
  [[ -f "$digest_file" && ! -L "$digest_file" ]] || fail 'render-only 缺少发布清单摘要。'
  validate_image_ref "$api" ghcr.io/dangdang-tech/combo-api
  validate_image_ref "$runtime" ghcr.io/dangdang-tech/combo-runtime
  validate_image_ref "$web" ghcr.io/dangdang-tech/combo-web
  validate_release_manifest "$manifest" "$digest_file" "$revision" "$api" "$runtime" "$web" ||
    fail 'render-only 发布清单校验失败。'
  local built_at manifest_digest web_asset_manifest
  built_at=$(jq -er '.builtAt' "$manifest") || fail 'render-only builtAt 不可读。'
  manifest_digest=$(<"$digest_file")
  web_asset_manifest=$(jq -er '.webAssetManifest' "$manifest") ||
    fail 'render-only Web 资源摘要不可读。'
  local script_root source
  script_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
  source="$script_root/infra/k8s/overlays/combo-dev"
  WORK=$(mktemp -d)
  prepare_render \
    "$source" "$WORK/prepared" "$api" "$runtime" "$web" \
    "$revision" "$built_at" "$manifest_digest" "$web_asset_manifest"
  install -m 0600 "$WORK/prepared/render/all.yaml" "$output"
  SUCCESS=1
  status 'render-only PASS'
}

main() {
  if [[ ${1:-} == '--render-only' ]]; then shift; render_only "$@"; return; fi
  local bundle='' revision='' workflow_run_id='' workflow_run_attempt='' arg rc bundle_bytes
  while (($#)); do
    arg=$1; shift
    case "$arg" in
      --bundle) bundle=${1:?}; shift ;;
      --revision) revision=${1:?}; shift ;;
      --workflow-run-id) workflow_run_id=${1:?}; shift ;;
      --workflow-run-attempt) workflow_run_attempt=${1:?}; shift ;;
      *) fail '未知部署参数。' ;;
    esac
  done
  [[ -f "$bundle" && ! -L "$bundle" ]] || blocked '部署包不存在或不是普通文件。'
  [[ "$revision" =~ $SHA_RE ]] || blocked '部署 revision 不是完整提交 SHA。'
  [[ "$workflow_run_id" =~ ^[1-9][0-9]*$ ]] || blocked '部署 workflow run ID 不合法。'
  [[ "$workflow_run_attempt" =~ ^[1-9][0-9]*$ ]] ||
    blocked '部署 workflow run attempt 不合法。'
  ATTEMPT_REVISION=$revision
  ATTEMPT_RUN_ID=$workflow_run_id
  ATTEMPT_RUN_ATTEMPT=$workflow_run_attempt
  [[ $(readlink -f "$bundle" 2>/dev/null || true) == \
    "$INSTALL_ROOT/incoming/${revision}.${workflow_run_id}.${workflow_run_attempt}.tar.gz" ]] ||
    blocked '部署包不在固定 attempt-scoped incoming 路径。'
  bundle_bytes=$(stat -c '%s' "$bundle" 2>/dev/null) || blocked '部署包大小不可读。'
  [[ "$bundle_bytes" =~ ^[1-9][0-9]*$ ]] || blocked '部署包大小不合法。'
  (( bundle_bytes <= ARCHIVE_MAX_BYTES )) || blocked '部署包超过 512 MiB 上传上限。'
  RESET_PROOF="/var/lib/combo-dev/reset-proof.${revision}.${workflow_run_id}.${workflow_run_attempt}.json"
  CONSUMED_RESET_PROOF="/var/lib/combo-dev/reset-proof.${revision}.${workflow_run_id}.${workflow_run_attempt}.consumed.json"
  INCOMING_BUNDLE=$bundle

  exec 9>"$LOCK_FILE"
  flock -w 300 9 || blocked '另一个 combo-dev 操作长时间持有主机锁。'
  assert_control_state_headroom "$bundle_bytes"
  WORK=$(mktemp -d "$CONTROL_WORK/deploy.XXXXXX") || blocked '无法在 control-state 创建部署工作区。'
  host_preflight
  assert_release_tree_unmounted
  rbac_preflight
  claim_safe_idle_fence || blocked 'Test 不是 bootstrap 或 reset 证明的安全空闲阻断状态。'
  claim_forwarders_for_deploy
  fence_all_writers || fail '部署认领安全空闲状态后，无法重新证明全部写入者已关闭。'
  verify_complete_writer_inventory_zero ||
    fail '部署认领安全空闲状态后，命名空间仍存在未收敛的写入控制器或 Pod。'
  consume_reset_proof "$revision" "$workflow_run_id" "$workflow_run_attempt"
  rm -f -- \
    "$LEGACY_EVIDENCE/${revision}.${workflow_run_id}.${workflow_run_attempt}.json"
  local trusted_bundle="$WORK/bundle.tar.gz"
  install -m 0600 "$bundle" "$trusted_bundle" || blocked '部署包无法复制到 root-owned 临时目录。'
  rm -f -- "$bundle" || blocked 'incoming 部署包无法在受信复制后删除。'
  INCOMING_BUNDLE=''
  local canonical_release="$CONTROL_RELEASES/$revision"
  local candidate_release="$INSTALL_ROOT/releases/$revision" candidate_extract
  candidate_extract=$(mktemp -d \
    "$CONTROL_STAGING/${revision}.${workflow_run_id}.${workflow_run_attempt}.XXXXXXXX") ||
    blocked '无法在 release staging 创建候选目录。'
  CANDIDATE_RELEASE=$candidate_extract
  validate_bundle "$trusted_bundle" "$candidate_extract" || blocked '部署包不在固定白名单内。'
  if [[ -e "$canonical_release" ]]; then
    [[ -d "$canonical_release" && ! -L "$canonical_release" ]] || blocked '既有 revision 路径不是 root-owned 发布目录。'
    diff -qr "$candidate_extract" "$canonical_release" >/dev/null 2>&1 || blocked '同一 revision 的既有发布内容不一致。'
    rm -rf --one-file-system -- "$candidate_extract"
    CANDIDATE_RELEASE=''
  else
    mv -T "$candidate_extract" "$canonical_release" ||
      blocked '候选 release 无法在 control-state 内原子提交。'
    CANDIDATE_RELEASE=''
    RELEASE_CREATED=1
  fi
  RELEASE_DIR=$candidate_release
  verify_release_tree "$RELEASE_DIR" || blocked '发布目录所有权或写权限不安全。'
  [[ $(cat "$RELEASE_DIR/metadata/revision" 2>/dev/null || true) == "$revision" ]] || blocked '部署包 revision 不匹配。'

  local actual_control expected_control meta api_image runtime_image web_image
  actual_control=$(control_tree_digest "$RELEASE_DIR") || blocked '部署包缺少受信任控制文件。'
  expected_control=$(cat "$CONTROL_DIGEST" 2>/dev/null || true)
  local installed_control
  installed_control=$(installed_control_digest) || blocked '主机上的 root-owned 控制文件不完整。'
  [[ "$actual_control" == "$expected_control" && "$installed_control" == "$expected_control" && "$expected_control" =~ ^[0-9a-f]{64}$ ]] || blocked '主机调度器与候选控制文件不一致；必须先由主机所有者重新 bootstrap。'

  meta="$RELEASE_DIR/metadata/image-digests.txt"
  [[ $(awk -F= '{print $1}' "$meta" | sort | tr '\n' ' ') == 'API_IMAGE RUNTIME_IMAGE WEB_IMAGE ' ]] || blocked '镜像元数据包含未知键。'
  api_image=$(read_metadata_value "$meta" API_IMAGE)
  runtime_image=$(read_metadata_value "$meta" RUNTIME_IMAGE)
  web_image=$(read_metadata_value "$meta" WEB_IMAGE)
  validate_image_ref "$api_image" ghcr.io/dangdang-tech/combo-api
  validate_image_ref "$runtime_image" ghcr.io/dangdang-tech/combo-runtime
  validate_image_ref "$web_image" ghcr.io/dangdang-tech/combo-web

  local manifest="$RELEASE_DIR/metadata/release.json"
  local digest_file="$RELEASE_DIR/metadata/release-manifest-digest.txt"
  validate_release_manifest \
    "$manifest" "$digest_file" "$revision" "$api_image" "$runtime_image" "$web_image" ||
    blocked '发布清单、revision 与镜像摘要不一致。'
  local built_at manifest_digest web_asset_manifest
  built_at=$(jq -er '.builtAt' "$manifest") || blocked '发布 builtAt 不可读。'
  manifest_digest=$(<"$digest_file")
  web_asset_manifest=$(jq -er '.webAssetManifest' "$manifest") ||
    blocked '发布 Web 资源摘要不可读。'

  prepare_render \
    "$RELEASE_DIR/infra/k8s/overlays/combo-dev" "$WORK/prepared" \
    "$api_image" "$runtime_image" "$web_image" \
    "$revision" "$built_at" "$manifest_digest" "$web_asset_manifest"
  server_preflight "$WORK/prepared/render"

  local before after start
  local migration_proof="$WORK/migration-proof.json"
  before=$(production_fingerprint)
  start=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  apply_and_wait_foundation "$WORK/prepared/render"
  run_pre_app_storage
  run_pre_app_isolation
  run_job minio-init "$WORK/prepared/render/init.yaml" 360
  delete_job_strict minio-init || fail 'MinIO 初始化任务无法在取证前清理。'
  run_job migrate "$WORK/prepared/render/migrate.yaml" 660
  capture_migration_proof \
    "$revision" "$workflow_run_id" "$workflow_run_attempt" \
    "$api_image" "$migration_proof" ||
    blocked '迁移 Job、Pod、镜像或日志证据不完整。'
  wait_apps "$WORK/prepared/render"
  prune_stale_configs

  timeout 30 systemctl start combo-dev-web-forward.service >/dev/null 2>&1 || fail 'Web 回环转发器启动失败。'
  timeout 30 systemctl start combo-dev-s3-forward.service >/dev/null 2>&1 || fail 'S3 回环转发器启动失败。'
  wait_loopback_listeners

  timeout 1200 "$INSTALL_ROOT/bin/combo-dev-smoke" \
    --revision "$revision" --since-time "$start" >/dev/null || {
    rc=$?; (( rc == 1 )) && fail '基础设施验收失败。'; blocked '基础设施验收证据不完整或超时。';
  }
  write_test_evidence \
    "$revision" "$workflow_run_id" "$workflow_run_attempt" \
    "$manifest" "$digest_file" "$RESET_PROOF_IN_USE" "$migration_proof"

  timeout 30 systemctl stop combo-dev-web-forward.service >/dev/null 2>&1 || fail 'Web 临时转发器无法停止。'
  timeout 30 systemctl stop combo-dev-s3-forward.service >/dev/null 2>&1 || fail 'S3 临时转发器无法停止。'
  local public_unit public_state
  for public_unit in "${PUBLIC_FORWARDER_UNITS[@]}"; do
    public_state=$(timeout 10 systemctl is-active "$public_unit" 2>/dev/null || true)
    [[ "$public_state" == inactive || "$public_state" == failed ]] ||
      fail '公网转发器在 Test 待验收提交前意外运行。'
  done
  after=$(production_fingerprint)
  [[ "$before" == "$after" ]] || fail '生产资源指纹在验收窗口内发生变化。'

  exec 8>"$FENCE_LOCK_FILE"
  flock -w 300 8 || fail '无法取得最终失败收敛锁。'
  [[ ! -e "$EXTERNAL_FENCE_MARKER" && ! -L "$EXTERNAL_FENCE_MARKER" &&
    ! -e "$PUBLICATION_MARKER" && ! -L "$PUBLICATION_MARKER" ]] ||
    fail '外部失败收敛已阻断本次部署。'
  post_capacity
  verify_writers_restored || fail '解除持久阻断前无法证明全部写入者已恢复单副本就绪。'
  # From this point the immutable release is intentionally retained. Setting
  # this before the two-link switch closes the TERM/INT window where cleanup
  # could otherwise delete the new target after current had moved to it.
  RELEASE_CREATED=0
  ln -sfn "$RELEASE_DIR" "$INSTALL_ROOT/current.next"
  mv -Tf "$INSTALL_ROOT/current.next" "$INSTALL_ROOT/current"
  prune_releases
  write_acceptance_pending "$revision" "$workflow_run_id" "$workflow_run_attempt" ||
    fail '无法写入有界 Test 待验收标记。'
  rm -f -- "$FAILURE_FENCE_MARKER" || fail '成功部署后无法解除持久写入阻断标记。'
  SUCCESS=1
  status "PASS revision=$revision workflowRunId=$workflow_run_id workflowRunAttempt=$workflow_run_attempt"
}

if [[ ${1:-} != '--render-only' && ${COMBO_DEV_DEADLINE_GUARD:-0} != 1 ]]; then
  command -v timeout >/dev/null 2>&1 || blocked '缺少总时限工具。'
  exec env COMBO_DEV_DEADLINE_GUARD=1 timeout --signal=TERM --kill-after=300s 6900s bash "${BASH_SOURCE[0]}" "$@"
fi
main "$@"
