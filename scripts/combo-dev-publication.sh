#!/usr/bin/env bash
# Root-owned Test public entry controller. It never changes application workloads.
set -Eeuo pipefail
umask 077
export PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

readonly NAMESPACE='combo-preview'
readonly KUBECONFIG_PATH='/etc/combo-dev/dispatcher.kubeconfig'
readonly INSTALL_ROOT='/opt/combo-dev'
readonly PUBLICATION_MARKER='/var/lib/combo-dev/publication'
readonly ACCEPTANCE_PENDING_MARKER='/var/lib/combo-dev/acceptance-pending'
readonly FAILURE_FENCE_MARKER='/var/lib/combo-dev/writers-fenced'
readonly EXTERNAL_FENCE_MARKER='/var/lib/combo-dev/external-fence'
readonly OPERATION_LOCK_FILE='/run/lock/combo-dev.lock'
readonly FENCE_LOCK_FILE='/run/lock/combo-dev-fence.lock'
readonly FORWARDER_LOCK_FILE='/run/lock/combo-dev-forwarders.lock'
readonly PUBLIC_UNITS=(combo-dev-public-web-forward.service combo-dev-public-s3-forward.service)
readonly SHA_RE='^[0-9a-f]{40}$'

K=(kubectl --request-timeout=30s --kubeconfig "$KUBECONFIG_PATH")
WORK=''

status() { printf '[combo-dev-publication] %s\n' "$1"; }
fail() { printf '[combo-dev-publication] BLOCKED: %s\n' "$1" >&2; exit 2; }
require_command() { command -v "$1" >/dev/null 2>&1 || fail "缺少主机工具：$1"; }

cleanup() {
  [[ -z "$WORK" ]] || rm -rf -- "$WORK"
}
trap cleanup EXIT

private_marker_has_value() {
  local path=$1 expected=$2 expected_bytes
  expected_bytes=$((${#expected} + 1))
  [[ -f "$path" && ! -L "$path" &&
    $(stat -c '%u:%g:%a:%h:%s' "$path" 2>/dev/null) == "0:0:600:1:$expected_bytes" &&
    $(<"$path") == "$expected" ]]
}

pending_matches() {
  local revision=$1 run_id=$2 run_attempt=$3 value deadline now
  [[ -f "$ACCEPTANCE_PENDING_MARKER" && ! -L "$ACCEPTANCE_PENDING_MARKER" ]] || return 1
  value=$(<"$ACCEPTANCE_PENDING_MARKER") || return 1
  [[ "$value" =~ ^([0-9a-f]{40})\ ([1-9][0-9]*)\ ([1-9][0-9]*)\ ([1-9][0-9]*)$ ]] || return 1
  [[ ${BASH_REMATCH[1]} == "$revision" && ${BASH_REMATCH[2]} == "$run_id" &&
    ${BASH_REMATCH[3]} == "$run_attempt" ]] || return 1
  deadline=${BASH_REMATCH[4]}
  private_marker_has_value "$ACCEPTANCE_PENDING_MARKER" "$value" || return 1
  now=$(date +%s 2>/dev/null) || return 1
  [[ "$now" =~ ^[1-9][0-9]*$ ]] || return 1
  (( now <= deadline ))
}

live_revision_matches() {
  local revision=$1
  local expected_ref="combo-release-meta-${revision:0:12}"
  local current metadata deployments statefulset services pods endpoint_slices
  [[ -L "$INSTALL_ROOT/current" ]] || return 1
  current=$(readlink -f -- "$INSTALL_ROOT/current" 2>/dev/null) || return 1
  [[ "$current" == "$INSTALL_ROOT/releases/$revision" && -d "$current" && ! -L "$current" ]] || return 1
  [[ $(cat "$current/metadata/revision" 2>/dev/null || true) == "$revision" ]] || return 1
  metadata="$WORK/release-metadata.json"
  deployments="$WORK/deployments.json"
  statefulset="$WORK/minio-statefulset.json"
  services="$WORK/public-services.json"
  pods="$WORK/public-pods.json"
  endpoint_slices="$WORK/public-endpoint-slices.json"
  "${K[@]}" -n "$NAMESPACE" get "configmap/$expected_ref" -o json >"$metadata" 2>/dev/null || return 1
  "${K[@]}" -n "$NAMESPACE" get deployment api worker runtime web -o json >"$deployments" 2>/dev/null || return 1
  "${K[@]}" -n "$NAMESPACE" get statefulset minio -o json >"$statefulset" 2>/dev/null || return 1
  "${K[@]}" -n "$NAMESPACE" get service api runtime web minio -o json >"$services" 2>/dev/null || return 1
  "${K[@]}" -n "$NAMESPACE" get pods -l combo.dev/environment=combo-dev -o json >"$pods" 2>/dev/null || return 1
  "${K[@]}" -n "$NAMESPACE" get endpointslices.discovery.k8s.io -o json >"$endpoint_slices" 2>/dev/null || return 1
  "$INSTALL_ROOT/bin/combo-dev-production-safety" validate-public-live \
    --revision "$revision" \
    --image-metadata "$current/metadata/image-digests.txt" \
    --release-metadata "$metadata" \
    --deployments "$deployments" \
    --statefulset "$statefulset" \
    --services "$services" \
    --pods "$pods" \
    --endpoint-slices "$endpoint_slices" >/dev/null 2>&1
}

public_forwarders_active() {
  local unit state
  for unit in "${PUBLIC_UNITS[@]}"; do
    state=$(timeout 10 systemctl is-active "$unit" 2>/dev/null || true)
    [[ "$state" == active ]] || return 1
  done
}

public_forwarder_state() {
  local unit state active=0 inactive=0
  for unit in "${PUBLIC_UNITS[@]}"; do
    state=$(timeout 10 systemctl is-active "$unit" 2>/dev/null || true)
    if [[ "$state" == active ]]; then active=$((active + 1))
    elif [[ "$state" == inactive || "$state" == failed ]]; then inactive=$((inactive + 1))
    else return 2
    fi
  done
  (( active == 2 )) && return 0
  (( inactive == 2 )) && return 1
  return 2
}

public_listener_contract() {
  local sockets="$WORK/listeners.txt" web_pid s3_pid
  ss -H -ltnp >"$sockets" 2>/dev/null || return 1
  web_pid=$(timeout 10 systemctl show combo-dev-public-web-forward.service -p MainPID --value 2>/dev/null) || return 1
  s3_pid=$(timeout 10 systemctl show combo-dev-public-s3-forward.service -p MainPID --value 2>/dev/null) || return 1
  [[ "$web_pid" =~ ^[1-9][0-9]*$ && "$s3_pid" =~ ^[1-9][0-9]*$ ]] || return 1
  "$INSTALL_ROOT/bin/combo-dev-production-safety" validate-public-listeners \
    --input "$sockets" --web-pid "$web_pid" --s3-pid "$s3_pid" >/dev/null 2>&1
}

public_https_contract() {
  curl --silent --show-error --fail --max-time 10 --output /dev/null \
    --resolve test.43-160-242-46.sslip.io:443:127.0.0.1 \
    https://test.43-160-242-46.sslip.io/version.json 2>/dev/null &&
    curl --silent --show-error --fail --max-time 10 --output /dev/null \
      --resolve test-s3.43-160-242-46.sslip.io:443:127.0.0.1 \
      https://test-s3.43-160-242-46.sslip.io/minio/health/ready 2>/dev/null
}

wait_public_ready() {
  local attempt
  for ((attempt = 1; attempt <= 60; attempt++)); do
    if public_forwarders_active && public_listener_contract &&
      curl --silent --show-error --fail --max-time 10 --output /dev/null \
        http://127.0.0.1:18083/ready 2>/dev/null &&
      curl --silent --show-error --fail --max-time 10 --output /dev/null \
        http://127.0.0.1:19003/minio/health/ready 2>/dev/null &&
      public_https_contract; then
      return 0
    fi
    sleep 1
  done
  return 1
}

stop_public_forwarders() {
  timeout 30 systemctl stop "${PUBLIC_UNITS[@]}" >/dev/null 2>&1 || true
}

open_pending() {
  local revision=$1 run_id=$2 run_attempt=$3
  [[ "$revision" =~ $SHA_RE ]] || fail 'revision 不合法。'
  [[ "$run_id" =~ ^[1-9][0-9]*$ && "$run_attempt" =~ ^[1-9][0-9]*$ ]] ||
    fail 'workflow identity 不合法。'
  exec 9>"$OPERATION_LOCK_FILE"
  flock -s -w 300 9 || fail '无法取得公网发布操作锁。'
  exec 8>"$FENCE_LOCK_FILE"
  flock -w 300 8 || fail '无法取得失败收敛锁。'
  exec 7>"$FORWARDER_LOCK_FILE"
  flock -w 30 7 || fail '无法取得转发器状态锁。'
  [[ ! -e "$FAILURE_FENCE_MARKER" && ! -L "$FAILURE_FENCE_MARKER" &&
    ! -e "$EXTERNAL_FENCE_MARKER" && ! -L "$EXTERNAL_FENCE_MARKER" ]] ||
    fail 'Test 已处于失败阻断状态。'
  [[ ! -e "$PUBLICATION_MARKER" && ! -L "$PUBLICATION_MARKER" ]] ||
    fail '既有公网发布标记未由下一次 Test 变更撤销。'
  pending_matches "$revision" "$run_id" "$run_attempt" ||
    fail '待验收标记与当前 workflow attempt 不匹配或已经过期。'
  live_revision_matches "$revision" || fail 'Test live release 与待验收 revision 不一致。'
  if public_forwarder_state; then
    wait_public_ready || fail '既有公网转发器不符合精确监听或上游健康契约。'
    status "PASS pending-publication=$revision workflowRunId=$run_id workflowRunAttempt=$run_attempt"
    return
  else
    local state_rc=$?
    if (( state_rc != 1 )); then
      stop_public_forwarders
      fail '公网转发器处于部分或不可读状态。'
    fi
  fi
  timeout 30 systemctl start "${PUBLIC_UNITS[@]}" >/dev/null 2>&1 || {
    stop_public_forwarders
    fail '公网转发器启动失败。'
  }
  if ! wait_public_ready; then
    stop_public_forwarders
    fail '公网转发器或上游健康检查没有在固定窗口内就绪。'
  fi
  status "PASS pending-publication=$revision workflowRunId=$run_id workflowRunAttempt=$run_attempt"
}

main() {
  [[ $(id -u) -eq 0 ]] || fail '公网发布控制器必须由 root 执行。'
  local cmd
  for cmd in kubectl flock systemctl timeout stat readlink date ss curl rm sleep mktemp chmod; do require_command "$cmd"; done
  [[ -f "$KUBECONFIG_PATH" && ! -L "$KUBECONFIG_PATH" &&
    $(stat -c '%u:%g:%a' "$KUBECONFIG_PATH" 2>/dev/null) == '0:0:600' ]] ||
    fail '调度凭据不是 owner-only 文件。'
  WORK=$(mktemp -d /run/combo-dev-publication.XXXXXX) || fail '无法建立私有运行目录。'
  chmod 0700 "$WORK"
  case $# in
    4)
      [[ $1 == --open-pending ]] || fail '参数不合法。'
      open_pending "$2" "$3" "$4"
      ;;
    *) fail '参数不合法。' ;;
  esac
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
