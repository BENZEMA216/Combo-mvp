#!/usr/bin/env bash
# 只做失败关闭的日志覆盖与泄漏检查；任何情况下都不回显原始日志或标记值。
set -Eeuo pipefail
umask 077
export PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

readonly NAMESPACE='combo-preview'
readonly KUBECONFIG_PATH='/etc/combo-dev/dispatcher.kubeconfig'
readonly TIME_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
readonly ACTIVITY_ATTEMPTS=15
readonly ACTIVITY_RETRY_SECONDS=2
readonly AUDIT_MAX_SECONDS=90
readonly LOG_CAPTURE_BYTES=8388609
K=(kubectl --request-timeout=30s --kubeconfig "$KUBECONFIG_PATH")
WORK=''
LAST_REASON='unclassified'
AUDIT_DEADLINE_EPOCH=0

status() { printf '[combo-dev-logs] %s\n' "$1"; }
fail() { printf '[combo-dev-logs] FAIL: %s\n' "$1" >&2; exit 1; }
blocked() { printf '[combo-dev-logs] BLOCKED: %s\n' "$1" >&2; exit 2; }
cleanup() {
  set +e
  [[ -z "$WORK" ]] || rm -rf -- "$WORK"
}
trap cleanup EXIT

pod_for_app() {
  local app=$1 container=$2 json count name uid restart_count
  json=$(mktemp "$WORK/pods.XXXXXX.json") || return 2
  "${K[@]}" -n "$NAMESPACE" get pods -l "app=$app" -o json >"$json" 2>/dev/null || return 2
  count=$(jq '[.items[] | select(.status.phase == "Running") | select(all(.status.containerStatuses[]?; .ready == true))] | length' "$json" 2>/dev/null) || return 2
  [[ "$count" == 1 ]] || return 1
  name=$(jq -r '.items[] | select(.status.phase == "Running") | select(all(.status.containerStatuses[]?; .ready == true)) | .metadata.name' "$json" 2>/dev/null) || return 2
  [[ "$name" =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]] || return 2
  uid=$(jq -r --arg name "$name" '.items[] | select(.metadata.name == $name) | .metadata.uid' "$json" 2>/dev/null) || return 2
  [[ "$uid" =~ ^[A-Za-z0-9._:-]{1,128}$ ]] || return 2
  restart_count=$(jq -er --arg name "$name" --arg container "$container" '
    [
      .items[]
      | select(.metadata.name == $name)
      | .status.containerStatuses[]?
      | select(.name == $container)
    ] as $statuses
    | if (
        ($statuses | length) == 1
        and ($statuses[0].restartCount | type) == "number"
        and $statuses[0].restartCount >= 0
      )
      then $statuses[0].restartCount
      else error("container restart state is not uniquely readable")
      end
  ' "$json" 2>/dev/null) || return 2
  [[ "$restart_count" =~ ^[0-9]+$ ]] || return 2
  printf '%s\t%s\t%s' "$name" "$uid" "$restart_count" || return 2
}

scan_log_file() {
  local file=$1 marker=$2 rc
  if grep -Fq -- "$marker" "$file"; then
    LAST_REASON='synthetic-marker-detected'
    return 1
  else
    rc=$?
    (( rc == 1 )) || {
      LAST_REASON='log-corpus-unreadable'
      return 2
    }
  fi
  if grep -Eiq '(authorization[" :=]+(bearer|basic)[[:space:]]+[A-Za-z0-9._~+/-]+|cookie[" :=]+[^[:space:]]+=|cb_session=|x-amz-(credential|signature)=|[?&](access_token|token|pairing_code|code)=)' "$file"; then
    LAST_REASON='credential-pattern-detected'
    return 1
  else
    rc=$?
    (( rc == 1 )) || {
      LAST_REASON='log-corpus-unreadable'
      return 2
    }
  fi
  return 0
}

within_audit_deadline() {
  local now
  now=$(date +%s 2>/dev/null) || return 1
  [[ "$now" =~ ^[0-9]+$ && "$AUDIT_DEADLINE_EPOCH" =~ ^[0-9]+$ ]] || return 1
  (( now < AUDIT_DEADLINE_EPOCH ))
}

retryable_reason() {
  case "$LAST_REASON" in
    api-activity-missing | runtime-activity-missing | worker-activity-missing | \
      source-*-not-unique | source-*-state-unreadable | source-*-identity-unreadable | \
      source-*-current-log-unreadable | source-*-previous-log-unreadable | \
      source-*-state-changed-during-capture)
      return 0
      ;;
    *) return 1 ;;
  esac
}

capture_complete_log() {
  local pod=$1 container=$2 since=$3 output=$4 mode=$5 rc size
  local args=("$pod" -c "$container")
  if [[ "$mode" == previous ]]; then
    args+=(--previous)
  elif [[ "$mode" != current ]]; then
    return 2
  fi
  if "${K[@]}" -n "$NAMESPACE" logs "${args[@]}" --since-time="$since" 2>/dev/null |
    head -c "$LOG_CAPTURE_BYTES" >"$output"; then
    rc=0
  else
    rc=$?
  fi
  size=$(stat -c '%s' "$output" 2>/dev/null) || return 2
  [[ "$size" =~ ^[0-9]+$ ]] || return 2
  (( size < LOG_CAPTURE_BYTES )) || return 1
  (( rc == 0 )) || return 2
  return 0
}

collect_snapshot() {
  local since=$1 marker=$2 snapshot=$3
  local app container identity identity_after pod uid restart_count corpus previous combined rc
  rm -rf -- "$snapshot" || {
    LAST_REASON='snapshot-cleanup-unavailable'
    return 2
  }
  mkdir -m 0700 "$snapshot" || {
    LAST_REASON='snapshot-directory-unavailable'
    return 2
  }
  combined="$snapshot/all.log"
  : >"$combined" || {
    LAST_REASON='combined-log-unavailable'
    return 2
  }

  while read -r app container; do
    within_audit_deadline || {
      LAST_REASON='audit-deadline-exceeded'
      return 2
    }
    if identity=$(pod_for_app "$app" "$container"); then
      rc=0
    else
      rc=$?
    fi
    case $rc in
      0) ;;
      1)
        LAST_REASON="source-${app}-not-unique"
        return 2
        ;;
      *)
        LAST_REASON="source-${app}-state-unreadable"
        return 2
        ;;
    esac
    IFS=$'\t' read -r pod uid restart_count <<<"$identity"
    [[ -n "$pod" && "$uid" =~ ^[A-Za-z0-9._:-]{1,128}$ && "$restart_count" =~ ^[0-9]+$ ]] || {
      LAST_REASON="source-${app}-identity-unreadable"
      return 2
    }
    (( restart_count <= 1 )) || {
      LAST_REASON="source-${app}-restart-history-out-of-range"
      return 2
    }
    corpus="$snapshot/$app.current.log"
    if capture_complete_log "$pod" "$container" "$since" "$corpus" current; then
      rc=0
    else
      rc=$?
    fi
    case $rc in
      0) ;;
      1)
        LAST_REASON="source-${app}-current-log-truncated"
        return 2
        ;;
      *)
        LAST_REASON="source-${app}-current-log-unreadable"
        return 2
        ;;
    esac
    if scan_log_file "$corpus" "$marker"; then
      rc=0
    else
      rc=$?
    fi
    (( rc == 0 )) || return "$rc"
    cat "$corpus" >>"$combined" || {
      LAST_REASON="source-${app}-combined-log-unwritable"
      return 2
    }
    if (( restart_count == 1 )); then
      previous="$snapshot/$app.previous.log"
      if capture_complete_log "$pod" "$container" "$since" "$previous" previous; then
        rc=0
      else
        rc=$?
      fi
      case $rc in
        0) ;;
        1)
          LAST_REASON="source-${app}-previous-log-truncated"
          return 2
          ;;
        *)
          LAST_REASON="source-${app}-previous-log-unreadable"
          return 2
          ;;
      esac
      if scan_log_file "$previous" "$marker"; then
        rc=0
      else
        rc=$?
      fi
      (( rc == 0 )) || return "$rc"
      cat "$previous" >>"$combined" || {
        LAST_REASON="source-${app}-combined-log-unwritable"
        return 2
      }
      cat "$previous" >>"$corpus" || {
        LAST_REASON="source-${app}-activity-log-unwritable"
        return 2
      }
    fi
    if identity_after=$(pod_for_app "$app" "$container"); then
      rc=0
    else
      rc=$?
    fi
    if (( rc != 0 )) || [[ "$identity_after" != "$identity" ]]; then
      LAST_REASON="source-${app}-state-changed-during-capture"
      return 2
    fi
  done <<'SOURCES'
api api
worker worker
runtime runtime
web web
postgres postgres
redis-queue redis
redis-hot redis
minio minio
SOURCES

  if scan_log_file "$combined" "$marker"; then
    rc=0
  else
    rc=$?
  fi
  (( rc == 0 )) || return "$rc"

  if grep -Fq 'route not found' "$snapshot/api.current.log"; then
    :
  else
    rc=$?
    if (( rc == 1 )); then
      LAST_REASON='api-activity-missing'
    else
      LAST_REASON='api-activity-log-unreadable'
    fi
    return 2
  fi
  if grep -Fq 'route not found' "$snapshot/runtime.current.log"; then
    :
  else
    rc=$?
    if (( rc == 1 )); then
      LAST_REASON='runtime-activity-missing'
    else
      LAST_REASON='runtime-activity-log-unreadable'
    fi
    return 2
  fi
  if grep -Fq 'pipeline finished' "$snapshot/worker.current.log"; then
    :
  else
    rc=$?
    if (( rc == 1 )); then
      LAST_REASON='worker-activity-missing'
    else
      LAST_REASON='worker-activity-log-unreadable'
    fi
    return 2
  fi
}

main() {
  local since='' marker_file='' arg marker mode attempt rc snapshot now
  while (($#)); do
    arg=$1; shift
    case "$arg" in
      --since-time) since=${1:?}; shift ;;
      --marker-file) marker_file=${1:?}; shift ;;
      *) fail '未知参数。' ;;
    esac
  done
  [[ "$since" =~ $TIME_RE ]] || blocked '缺少合法的验收时间窗口。'
  [[ -f "$marker_file" ]] || blocked '缺少合成泄漏标记文件。'
  mode=$(stat -c '%a' "$marker_file" 2>/dev/null) || blocked '无法读取标记文件权限。'
  [[ "$mode" == 600 || "$mode" == 400 ]] || blocked '合成标记文件权限不安全。'
  marker=$(cat "$marker_file") || blocked '无法读取合成标记。'
  [[ "$marker" =~ ^[A-Za-z0-9._-]{20,128}$ ]] || blocked '合成标记格式不合法。'

  WORK=$(mktemp -d) || blocked '日志审计临时目录不可用。'
  now=$(date +%s 2>/dev/null) || blocked '日志审计时钟不可用。'
  [[ "$now" =~ ^[0-9]+$ ]] || blocked '日志审计时钟不合法。'
  AUDIT_DEADLINE_EPOCH=$((now + AUDIT_MAX_SECONDS))
  snapshot="$WORK/snapshot"
  for ((attempt = 1; attempt <= ACTIVITY_ATTEMPTS; attempt++)); do
    if collect_snapshot "$since" "$marker" "$snapshot"; then
      rc=0
    else
      rc=$?
    fi
    case $rc in
      0)
        status 'PASS sources=8 activity=3 redaction=PASS'
        return
        ;;
      1)
        [[ "$LAST_REASON" =~ ^[a-z0-9-]{1,80}$ ]] || LAST_REASON='unclassified'
        fail "reason=$LAST_REASON"
        ;;
      *)
        [[ "$LAST_REASON" =~ ^[a-z0-9-]{1,80}$ ]] || LAST_REASON='unclassified'
        if (( attempt == ACTIVITY_ATTEMPTS )) || ! retryable_reason || ! within_audit_deadline; then
          blocked "reason=$LAST_REASON"
        fi
        sleep "$ACTIVITY_RETRY_SECONDS"
        ;;
    esac
  done
  [[ "$LAST_REASON" =~ ^[a-z0-9-]{1,80}$ ]] || LAST_REASON='unclassified'
  blocked "reason=$LAST_REASON"
}

main "$@"
