#!/usr/bin/env bash
# combo-dev 有限验收。所有门禁必须 PASS；证据缺失返回 BLOCKED（退出码 2），从不跳过。
set -Eeuo pipefail
umask 077
export PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

readonly NAMESPACE='combo-preview'
readonly KUBECONFIG_PATH='/etc/combo-dev/dispatcher.kubeconfig'
readonly WEB_ORIGIN='http://127.0.0.1:18080'
readonly STORAGE_CLASS='combo-dev-bounded'
readonly CLUSTER_PLATFORM_CONTRACT='/etc/combo-dev/cluster-platform.canonical.json'
readonly HOST_BOUNDARY_APPROVAL='/etc/combo-dev/host-network-boundary.approved'
readonly HOST_BOUNDARY_CHECK='/opt/combo-dev/host-boundary/check'
readonly SHA_RE='^[0-9a-f]{40}$'
readonly TIME_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
readonly CANARY_IMAGE='python@sha256:37b14db89f587f9eaa890e4a442a3fe55db452b69cca1403cc730bd0fbdc8aaf'
readonly APPS=(api worker runtime web)
readonly STATEFUL=(postgres redis-queue minio)
K=(kubectl --request-timeout=30s --kubeconfig "$KUBECONFIG_PATH")
WORK=''
CANARY_CREATED=0

status() { printf '[combo-dev-smoke] %s\n' "$1"; }
fail() { printf '[combo-dev-smoke] FAIL: %s\n' "$1" >&2; exit 1; }
blocked() { printf '[combo-dev-smoke] BLOCKED: %s\n' "$1" >&2; exit 2; }
cleanup() {
  set +e
  if (( CANARY_CREATED == 1 )); then
    "${K[@]}" -n "$NAMESPACE" delete job/combo-dev-network-canary --ignore-not-found --wait=false >/dev/null 2>&1 || true
  fi
  [[ -z "$WORK" ]] || rm -rf -- "$WORK"
}
trap cleanup EXIT

require_tools() {
  local cmd
  for cmd in kubectl curl jq python3 openssl ss timeout stat findmnt readlink df dirname awk systemctl; do
    command -v "$cmd" >/dev/null 2>&1 || blocked "缺少验收工具：$cmd"
  done
}

root_owned_not_writable() {
  local path=$1 mode owner
  [[ -e "$path" && ! -L "$path" ]] || return 1
  mode=$(stat -c '%a' "$path" 2>/dev/null) || return 1
  owner=$(stat -c '%u' "$path" 2>/dev/null) || return 1
  [[ "$owner" == 0 && "$mode" =~ ^[0-7]{3,4}$ && $((8#$mode & 8#022)) == 0 ]]
}

verify_host_boundary_control() {
  [[ $(cat "$HOST_BOUNDARY_APPROVAL" 2>/dev/null || true) == 'combo-dev-host-boundary=audited-and-active' ]] || blocked '缺少主机级 Pod 到节点隔离批准。'
  if ! root_owned_not_writable "$HOST_BOUNDARY_CHECK" || [[ ! -x "$HOST_BOUNDARY_CHECK" ]]; then
    blocked '主机级隔离检查器不可用或可被非 root 修改。'
  fi
  timeout 30 "$HOST_BOUNDARY_CHECK" --check >/dev/null 2>&1 || blocked '主机级 Pod 到节点隔离未生效。'
}

validate_external_evidence() {
  local file=$1 revision=$2 since=$3 mode size
  [[ -f "$file" ]] || blocked '外部浏览器与产品流证据不存在。'
  mode=$(stat -c '%a' "$file" 2>/dev/null) || blocked '无法读取外部证据权限。'
  [[ "$mode" == 600 || "$mode" == 400 ]] || blocked '外部证据不是 owner-only 文件。'
  size=$(stat -c '%s' "$file" 2>/dev/null) || blocked '无法读取外部证据大小。'
  (( size > 0 && size <= 65536 )) || blocked '外部证据大小越界。'
  local rc
  set +e
  python3 - "$file" "$revision" "$since" <<'PY'
import datetime as dt, json, re, sys
path, revision, since = sys.argv[1:]
required = {
  'browser_spa', 'browser_auth', 'browser_logout', 'production_dev_login_unavailable',
  'product_task_idempotency', 'product_pairing_upload', 'product_sse_worker',
  'product_capability_publish', 'product_runtime_turn', 'product_artifact',
  's3_signed_roundtrip', 's3_exact_origin_cors', 'persistence_restarts',
  'private_ssh_forwards', 'off_host_private_access', 'temporary_artifacts_clean',
}
try:
    data = json.load(open(path, encoding='utf-8'))
except Exception:
    raise SystemExit(2)
if set(data) != {'revision', 'createdAt', 'checks'} or data['revision'] != revision:
    raise SystemExit(2)
if not isinstance(data['checks'], dict) or set(data['checks']) != required:
    raise SystemExit(2)
for value in data['checks'].values():
    if not isinstance(value, dict) or set(value) != {'status', 'id'} or value['status'] != 'PASS':
        raise SystemExit(1)
    if not isinstance(value['id'], str) or not re.fullmatch(r'[A-Za-z0-9._:-]{1,80}', value['id']):
        raise SystemExit(2)
def parse(value):
    return dt.datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=dt.timezone.utc)
try:
    created, started = parse(data['createdAt']), parse(since)
except Exception:
    raise SystemExit(2)
delta = (created - started).total_seconds()
if delta < 0 or delta > 7200:
    raise SystemExit(2)
PY
  rc=$?
  set -e
  case $rc in 0) ;; 1) fail '外部浏览器或产品流存在失败项。' ;; *) blocked '外部浏览器与产品流证据不完整或过期。' ;; esac
}

check_controller_readiness() {
  local name desired ready updated ownership
  for name in "${APPS[@]}" redis-hot; do
    desired=$("${K[@]}" -n "$NAMESPACE" get "deployment/$name" -o jsonpath='{.spec.replicas}' 2>/dev/null) || blocked 'Deployment 状态不可读。'
    ready=$("${K[@]}" -n "$NAMESPACE" get "deployment/$name" -o jsonpath='{.status.readyReplicas}' 2>/dev/null) || blocked 'Deployment 就绪状态不可读。'
    updated=$("${K[@]}" -n "$NAMESPACE" get "deployment/$name" -o jsonpath='{.status.updatedReplicas}' 2>/dev/null) || blocked 'Deployment 更新状态不可读。'
    [[ "$desired" == 1 && "$ready" == 1 && "$updated" == 1 ]] || fail 'Deployment 未保持单副本就绪。'
    if [[ " ${APPS[*]} " == *" $name "* ]]; then
      ownership=$("${K[@]}" -n "$NAMESPACE" get "deployment/$name" --show-managed-fields=true -o json 2>/dev/null) || blocked '应用副本 managedFields 不可读。'
      jq -e 'any(.metadata.managedFields[]?; .manager == "combo-dev-replicas" and .fieldsV1."f:spec"."f:replicas" == {}) and all(.metadata.managedFields[]?; if .manager == "combo-dev-dispatcher" then .fieldsV1."f:spec"."f:replicas" == null else true end)' <<<"$ownership" >/dev/null 2>&1 || fail '应用副本字段所有权没有与基础清单分离。'
    fi
  done
  for name in "${STATEFUL[@]}"; do
    desired=$("${K[@]}" -n "$NAMESPACE" get "statefulset/$name" -o jsonpath='{.spec.replicas}' 2>/dev/null) || blocked 'StatefulSet 状态不可读。'
    ready=$("${K[@]}" -n "$NAMESPACE" get "statefulset/$name" -o jsonpath='{.status.readyReplicas}' 2>/dev/null) || blocked 'StatefulSet 就绪状态不可读。'
    updated=$("${K[@]}" -n "$NAMESPACE" get "statefulset/$name" -o jsonpath='{.status.updatedReplicas}' 2>/dev/null) || blocked 'StatefulSet 更新状态不可读。'
    [[ "$desired" == 1 && "$ready" == 1 && "$updated" == 1 ]] || fail 'StatefulSet 未保持单副本就绪。'
  done

  local pods="$WORK/pods.json"
  "${K[@]}" -n "$NAMESPACE" get pods -l combo.dev/environment=combo-dev -o json >"$pods" 2>/dev/null || blocked '工作负载 Pod 清单不可读。'
  jq -e '[.items[] | select(.status.phase == "Running") | select(all(.status.containerStatuses[]?; .ready == true))] | length == 8' "$pods" >/dev/null 2>&1 || fail '八个稳态工作负载没有全部就绪。'
  jq -e 'all(.items[]; .spec.automountServiceAccountToken == false and ([.spec.volumes[]?.name | select(startswith("kube-api-access-"))] | length == 0))' "$pods" >/dev/null 2>&1 || fail '工作负载收到了 Kubernetes API 令牌。'
  jq -e '
    all(.items[]; ([.spec.volumes[]? | select(.hostPath != null)] | length) == 0)
    and ([.items[] | select(.metadata.labels.app == "postgres") | .spec.volumes[]? | select(.name == "data" and .persistentVolumeClaim.claimName == "data-postgres-0")] | length) >= 1
    and ([.items[] | select(.metadata.labels.app == "redis-queue") | .spec.volumes[]? | select(.name == "data" and .persistentVolumeClaim.claimName == "data-redis-queue-0")] | length) >= 1
    and ([.items[] | select(.metadata.labels.app == "minio") | .spec.volumes[]? | select(.name == "data" and .persistentVolumeClaim.claimName == "data-minio-0")] | length) >= 1
  ' "$pods" >/dev/null 2>&1 || fail '工作负载必须只通过三个固定 PVC 使用持久数据，且不得包含 hostPath。'
}

validate_cluster_platform_live() {
  local live="$WORK/cluster-platform.live.json" parts="$WORK/cluster-platform.live.parts" pvc="$WORK/pvc.json" resource
  root_owned_not_writable "$CLUSTER_PLATFORM_CONTRACT" || blocked '规范化集群平台契约不可用。'
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
    fail 'Namespace、ClusterRole、ClusterRoleBinding、StorageClass 或静态 PV 发生漂移。'
  jq -s -e 'all(.[]; if .kind == "PersistentVolume" then .status.phase == "Bound" and (.metadata.deletionTimestamp == null) else true end)' \
    "$parts" >/dev/null 2>&1 || fail '静态 PV 没有保持绑定终态。'
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
  ' "$pvc" >/dev/null 2>&1 || fail '静态 PVC 清单、预绑定或终态发生漂移。'
}

check_live_limits_and_access() {
  local mode=${1:-full}
  local quota="$WORK/quota.json" services="$WORK/services.json"
  "${K[@]}" -n "$NAMESPACE" get resourcequota/combo-dev-ceiling -o json >"$quota" 2>/dev/null || blocked 'ResourceQuota 不可读。'
  jq -e '.spec.hard == {
    "limits.cpu":"3", "limits.ephemeral-storage":"8Gi", "limits.memory":"6Gi",
    "combo-dev-bounded.storageclass.storage.k8s.io/requests.storage":"16Gi", "persistentvolumeclaims":"3",
    "pods":"12", "requests.cpu":"1500m", "requests.ephemeral-storage":"4Gi",
    "requests.memory":"4Gi", "requests.storage":"16Gi"
  }' "$quota" >/dev/null 2>&1 || fail '命名空间资源上限发生漂移。'

  validate_cluster_platform_live
  /opt/combo-dev/bin/combo-dev-storage-guard --check-only >/dev/null 2>&1 || fail '独立挂载、静态卷路径、标记、所有权或安全水位发生漂移。'
  [[ "$mode" == storage-only ]] && return

  "${K[@]}" -n "$NAMESPACE" get services -o json >"$services" 2>/dev/null || blocked 'Service 清单不可读。'
  jq -e '([.items[].metadata.name] | sort) == ["api","minio","postgres","redis-hot","redis-queue","runtime","web"] and all(.items[]; (.spec.type // "ClusterIP") == "ClusterIP" and ((.spec.externalIPs // []) | length == 0) and ([.spec.ports[]? | select(.nodePort != null)] | length == 0))' "$services" >/dev/null 2>&1 || fail '发现非私有 Service 或额外服务。'

  local policies
  policies=$("${K[@]}" -n "$NAMESPACE" get networkpolicies.networking.k8s.io -o json 2>/dev/null) || blocked 'NetworkPolicy 清单不可读。'
  jq -e '([.items[].metadata.name] | sort) == ["allow-dns","app-ingress-from-web","approved-public-https","authoring-internal-egress","default-deny","migrate-egress","minio-ingress","minio-init-egress","network-canary-dns-only","postgres-ingress","redis-hot-ingress","redis-queue-ingress","runtime-internal-egress","web-to-apps"]' <<<"$policies" >/dev/null 2>&1 || fail '网络隔离策略清单发生漂移。'
}

curl_json() {
  local path=$1 output=$2 candidate attempt
  candidate="${output}.next"
  for ((attempt = 1; attempt <= 60; attempt++)); do
    if curl --silent --show-error --fail --max-time 15 --max-filesize 1048576 \
      --output "$candidate" "$WEB_ORIGIN$path" 2>/dev/null; then
      mv -fT "$candidate" "$output"
      return
    fi
    rm -f -- "$candidate"
    (( attempt == 60 )) || sleep 2
  done
  blocked "回环健康端点在恢复窗口内不可读：$path"
}

check_health_and_origin() {
  local api_health="$WORK/api-health.json" api_ready="$WORK/api-ready.json"
  local runtime_health="$WORK/runtime-health.json" runtime_ready="$WORK/runtime-ready.json"
  local headers="$WORK/headers" body="$WORK/body" code
  curl_json /health "$api_health"
  curl_json /ready "$api_ready"
  curl_json /_combo-dev/runtime/health "$runtime_health"
  curl_json /_combo-dev/runtime/ready "$runtime_ready"
  for body in "$api_health" "$runtime_health"; do
    jq -e '.status == "ok"' "$body" >/dev/null 2>&1 || fail '应用 liveness 失败。'
  done
  for body in "$api_ready" "$runtime_ready"; do
    jq -e '.data.ready == true and .data.status == "ok" and ([.data.dependencies[] | select(.status != "ok")] | length == 0) and ([.data.dependencies[] | select(.name == "llm" and .status == "ok")] | length == 1)' "$body" >/dev/null 2>&1 || fail 'readiness 没有证明全部依赖与 LLM 可用。'
  done

  code=$(curl --silent --max-time 15 --max-filesize 1048576 --output "$body" --dump-header "$headers" -H 'Origin: http://127.0.0.1:18080' --write-out '%{http_code}' "$WEB_ORIGIN/ready" 2>/dev/null) || blocked '精确来源探针不可读。'
  [[ "$code" == 200 ]] || fail '精确开发来源被拒绝。'
  [[ $(tr -d '\015' <"$headers" | grep -Fxci 'access-control-allow-origin: http://127.0.0.1:18080') == 1 ]] || fail '精确来源 CORS 响应不唯一。'
  code=$(curl --silent --max-time 15 --max-filesize 1048576 --output "$body" -H 'Origin: http://127.0.0.1:18081' --write-out '%{http_code}' "$WEB_ORIGIN/ready" 2>/dev/null) || blocked '敌对来源探针不可读。'
  [[ "$code" == 403 ]] || fail '非固定浏览器来源没有被 Web 边界拒绝。'
}

check_loopback_only() {
  local sockets="$WORK/listeners.txt" web_pid s3_pid
  ss -H -ltnp >"$sockets" 2>/dev/null || blocked '主机监听状态不可读。'
  web_pid=$(timeout 10 systemctl show combo-dev-web-forward.service -p MainPID --value 2>/dev/null) || blocked 'Web 转发器进程身份不可读。'
  s3_pid=$(timeout 10 systemctl show combo-dev-s3-forward.service -p MainPID --value 2>/dev/null) || blocked 'S3 转发器进程身份不可读。'
  [[ "$web_pid" =~ ^[1-9][0-9]*$ && "$s3_pid" =~ ^[1-9][0-9]*$ ]] || blocked '回环转发器没有活动主进程。'
  /opt/combo-dev/bin/combo-dev-production-safety validate-listeners \
    --input "$sockets" --web-pid "$web_pid" --s3-pid "$s3_pid" >/dev/null 2>&1 ||
    fail '开发端口完整监听集合不是两个固定回环转发器。'
}

run_network_canary() {
  local manifest="$WORK/network-canary.yaml" state='' exit_code='' pod=''
  verify_host_boundary_control
  "${K[@]}" -n "$NAMESPACE" delete job/combo-dev-network-canary --ignore-not-found --wait=true --timeout=60s >/dev/null 2>&1 || blocked '旧网络 canary 状态不可收敛。'
  cat >"$manifest" <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: combo-dev-network-canary
  namespace: combo-preview
spec:
  backoffLimit: 0
  activeDeadlineSeconds: 60
  ttlSecondsAfterFinished: 60
  template:
    metadata:
      labels:
        app: combo-dev-network-canary
        combo.dev/environment: acceptance-canary
    spec:
      restartPolicy: Never
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        runAsGroup: 65534
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: canary
          image: $CANARY_IMAGE
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
          env:
            - name: HOST_IP
              valueFrom: { fieldRef: { fieldPath: status.hostIP } }
            - name: PYTHONDONTWRITEBYTECODE
              value: "1"
          command: ["python3", "-c"]
          args:
            - |
              import os
              import socket
              import sys

              def probe(host, port):
                  try:
                      addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
                  except socket.gaierror:
                      return None
                  for family, socket_type, protocol, _, address in addresses:
                      connection = socket.socket(family, socket_type, protocol)
                      try:
                          connection.settimeout(2.0)
                          if connection.connect_ex(address) == 0:
                              return True
                      finally:
                          connection.close()
                  return False

              control = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
              control.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
              control.bind(("127.0.0.1", 0))
              control.listen(1)
              control_port = control.getsockname()[1]
              if probe("127.0.0.1", control_port) is not True:
                  sys.exit(3)
              control.close()

              production_web = "web.combo.svc.cluster.local"
              control_plane = "kubernetes.default.svc.cluster.local"
              for required_name in (production_web, control_plane):
                  try:
                      socket.getaddrinfo(required_name, None)
                  except socket.gaierror:
                      sys.exit(2)
              denied = [
                  (production_web, 80),
                  (control_plane, 443),
                  ("169.254.169.254", 80),
              ]
              denied.extend((os.environ["HOST_IP"], port) for port in (22, 80, 443, 6443, 30080, 30900))
              if any(probe(host, port) is True for host, port in denied):
                  sys.exit(1)
          resources:
            requests: { cpu: 10m, memory: 16Mi, ephemeral-storage: 16Mi }
            limits: { cpu: 50m, memory: 32Mi, ephemeral-storage: 32Mi }
          volumeMounts:
            - { name: tmp, mountPath: /tmp }
      volumes:
        - name: tmp
          emptyDir: { sizeLimit: 16Mi }
EOF
  "${K[@]}" create -f "$manifest" >/dev/null 2>&1 || blocked '网络 canary 无法创建。'
  CANARY_CREATED=1
  for _ in $(seq 1 90); do
    state=$("${K[@]}" -n "$NAMESPACE" get job/combo-dev-network-canary -o jsonpath='{.status.succeeded}:{.status.failed}' 2>/dev/null) || blocked '网络 canary 状态不可读。'
    [[ "$state" == 1:* ]] && break
    [[ "$state" == *:1 ]] && break
    sleep 1
  done
  if [[ "$state" == 1:* ]]; then return; fi
  pod=$("${K[@]}" -n "$NAMESPACE" get pods -l job-name=combo-dev-network-canary -o jsonpath='{.items[0].metadata.name}' 2>/dev/null) || blocked '网络 canary Pod 不可读。'
  [[ -n "$pod" ]] || blocked '网络 canary 没有产生 Pod。'
  exit_code=$("${K[@]}" -n "$NAMESPACE" get "pod/$pod" -o jsonpath='{.status.containerStatuses[0].state.terminated.exitCode}' 2>/dev/null) || blocked '网络 canary 终态不可读。'
  [[ "$exit_code" == 2 ]] && blocked '生产或控制面 DNS 目标不可解析，隔离证据不足。'
  [[ "$exit_code" == 1 ]] && fail '网络 canary 到达了禁止目标。'
  blocked '网络 canary 未在时限内形成可判定证据。'
}

check_logs_fail_closed() {
  local since=$1 marker_file="$WORK/synthetic-marker" api_cfg="$WORK/api.curl" runtime_cfg="$WORK/runtime.curl" rc
  openssl rand -hex 24 >"$marker_file" 2>/dev/null || blocked '无法生成一次性合成标记。'
  chmod 600 "$marker_file"
  local marker
  marker=$(cat "$marker_file")
  cat >"$api_cfg" <<EOF
url = "$WEB_ORIGIN/api/__combo_dev_missing?probe=$marker"
silent
output = "/dev/null"
max-time = 15
EOF
  cat >"$runtime_cfg" <<EOF
url = "$WEB_ORIGIN/api/v1/runtime/__combo_dev_missing?probe=$marker"
silent
output = "/dev/null"
max-time = 15
EOF
  chmod 600 "$api_cfg" "$runtime_cfg"
  curl --config "$api_cfg" >/dev/null 2>&1 || true
  curl --config "$runtime_cfg" >/dev/null 2>&1 || true
  set +e
  /opt/combo-dev/bin/combo-dev-logs --since-time "$since" --marker-file "$marker_file" >/dev/null 2>&1
  rc=$?
  set -e
  (( rc == 0 )) && return
  (( rc == 2 )) && blocked '日志覆盖或当前窗口活动证据不可用。'
  fail '日志泄漏检查失败。'
}

main() {
  if [[ $# == 1 && $1 == '--storage-only' ]]; then
    require_tools
    WORK=$(mktemp -d)
    check_live_limits_and_access storage-only
    status 'PASS storage=bounded-and-bound'
    return
  fi
  if [[ $# == 1 && $1 == '--network-canary-only' ]]; then
    require_tools
    WORK=$(mktemp -d)
    run_network_canary
    status 'PASS network-canary=isolated'
    return
  fi
  local revision='' since='' evidence='' arg
  while (($#)); do
    arg=$1; shift
    case "$arg" in
      --revision) revision=${1:?}; shift ;;
      --since-time) since=${1:?}; shift ;;
      --evidence) evidence=${1:?}; shift ;;
      *) fail '未知参数。' ;;
    esac
  done
  [[ "$revision" =~ $SHA_RE ]] || blocked 'revision 不是完整提交 SHA。'
  [[ "$since" =~ $TIME_RE ]] || blocked '验收起始时间不合法。'
  require_tools
  WORK=$(mktemp -d)
  validate_external_evidence "$evidence" "$revision" "$since"
  check_loopback_only
  check_controller_readiness
  check_live_limits_and_access
  check_health_and_origin
  run_network_canary
  check_logs_fail_closed "$since"
  status "PASS revision=$revision gates=7"
}

main "$@"
