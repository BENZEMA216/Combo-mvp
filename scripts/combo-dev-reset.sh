#!/usr/bin/env bash
# 破坏性重置固定的 combo-preview 数据面。确认串、命名空间、工作负载和三个 PVC 都不可参数化。
set -Eeuo pipefail
umask 077
export PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

readonly NAMESPACE='combo-preview'
readonly PRODUCTION_NAMESPACE='combo'
readonly CONFIRMATION='DESTROY-COMBO-PREVIEW-DATA'
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
readonly SESSION_FILE='/etc/combo-dev/session.key'
readonly LOCK_FILE='/run/lock/combo-dev.lock'
readonly FAILURE_FENCE_MARKER='/var/lib/combo-dev/writers-fenced'
readonly DISPATCHER_FENCE_BEFORE_SECONDS=$((7 * 24 * 60 * 60))
readonly BOOTSTRAP_FOUNDATION='/opt/combo-dev/bootstrap-overlay/foundation'
readonly APPS=(api worker runtime web)
readonly FOUNDATION_STATEFUL=(postgres redis-queue minio)
readonly CONTROLLERS=(statefulset/postgres statefulset/redis-queue statefulset/minio deployment/redis-hot)
K=(kubectl --request-timeout=30s --kubeconfig "$KUBECONFIG_PATH")
PK=(kubectl --request-timeout=30s --kubeconfig "$PRODUCTION_KUBECONFIG")
WORK=''
FOUNDATION=''
MUTATING=0
SUCCESS=0

status() { printf '[combo-dev-reset] %s\n' "$1"; }
fail() { printf '[combo-dev-reset] FAIL: %s\n' "$1" >&2; exit 1; }
blocked() { printf '[combo-dev-reset] BLOCKED: %s\n' "$1" >&2; exit 2; }
cleanup() {
  local rc=$?
  set +e
  if (( MUTATING == 1 && SUCCESS == 0 )); then
    mark_failure_fence >/dev/null 2>&1 || true
    timeout 30 systemctl stop combo-dev-web-forward.service >/dev/null 2>&1 || true
    timeout 30 systemctl stop combo-dev-s3-forward.service >/dev/null 2>&1 || true
    if fence_all_writers >/dev/null 2>&1; then
      status '失败收敛已验证；全部写入者、任务与转发器保持关闭。'
    else
      status '失败收敛无法验证；阻断标记已保留并需要主机所有者介入。'
    fi
  fi
  [[ -z "$WORK" ]] || rm -rf -- "$WORK"
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

mark_failure_fence() {
  install -d -o root -g root -m 0700 /var/lib/combo-dev
  printf '%s\n' 'combo-dev-writers=fenced' >"$FAILURE_FENCE_MARKER"
  chmod 0600 "$FAILURE_FENCE_MARKER"
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
  for cmd in kubectl jq python3 openssl base64 sha256sum flock findmnt systemctl timeout stat dirname readlink df awk install find chown chmod rm; do command -v "$cmd" >/dev/null 2>&1 || blocked "缺少主机工具：$cmd"; done
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
  [[ $(timeout 10 systemctl is-enabled combo-dev-storage-guard.timer 2>/dev/null || true) == enabled ]] || blocked '持续存储守卫未启用。'
  timeout 180 systemctl start combo-dev-storage-guard.service >/dev/null 2>&1 || blocked '持续守卫无法证明两套凭据与失败收敛路径健康。'
  can_i_exact yes patch secrets/combo-dev-session "$NAMESPACE"
  can_i_exact yes get persistentvolumes/combo-dev-postgres
  can_i_exact yes get persistentvolumes/combo-dev-redis-queue
  can_i_exact yes get persistentvolumes/combo-dev-minio
  can_i_exact yes list namespaces
  can_i_exact yes list roles.rbac.authorization.k8s.io "$NAMESPACE"
  can_i_exact yes list rolebindings.rbac.authorization.k8s.io "$NAMESPACE"
  can_i_exact yes list clusterroles.rbac.authorization.k8s.io
  can_i_exact yes list clusterrolebindings.rbac.authorization.k8s.io
  can_i_exact no delete persistentvolumeclaims/data-postgres-0 "$NAMESPACE"
  can_i_exact no patch deployments.apps "$PRODUCTION_NAMESPACE"
  can_i_exact no get secrets "$NAMESPACE"
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
  local failed=0 item kind name rc
  timeout 30 systemctl stop combo-dev-web-forward.service >/dev/null 2>&1 || failed=1
  timeout 30 systemctl stop combo-dev-s3-forward.service >/dev/null 2>&1 || failed=1
  fence_all_writers || failed=1
  for name in minio-init migrate combo-dev-network-canary; do
    if resource_exists job "$name"; then
      "${K[@]}" -n "$NAMESPACE" delete "job/$name" --wait=true --timeout=90s >/dev/null 2>&1 || failed=1
    else
      rc=$?; (( rc == 1 )) || failed=1
    fi
  done
  for item in "${CONTROLLERS[@]}"; do
    kind=${item%%/*}; name=${item##*/}
    if resource_exists "$kind" "$name"; then
      "${K[@]}" -n "$NAMESPACE" delete "$item" --wait=true --timeout=180s >/dev/null 2>&1 || failed=1
    else
      rc=$?; (( rc == 1 )) || failed=1
    fi
  done
  (( failed == 0 )) || return 1
  for item in "${CONTROLLERS[@]}"; do
    kind=${item%%/*}; name=${item##*/}
    if resource_exists "$kind" "$name"; then return 1; else rc=$?; (( rc == 1 )) || return 1; fi
  done
}

rotate_session_credential() {
  local next="$WORK/session.next" manifest="$WORK/session.secret.json"
  openssl rand -hex 32 >"$next" 2>/dev/null || blocked '无法生成新的开发会话凭据。'
  chmod 600 "$next"
  python3 - "$next" "$manifest" <<'PY'
import base64, json, sys
value=open(sys.argv[1],'rb').read()
with open(sys.argv[2],'w',encoding='utf-8') as f:
    json.dump({
        'apiVersion':'v1',
        'kind':'Secret',
        'metadata':{'name':'combo-dev-session','namespace':'combo-preview'},
        'type':'Opaque',
        'data':{'DEV_SESSION_SECRET':base64.b64encode(value).decode('ascii')},
    },f,separators=(',',':'))
PY
  chmod 600 "$manifest"
  install -m 0600 "$next" "$SESSION_FILE"
  "${K[@]}" apply --server-side --field-manager=combo-dev-session --force-conflicts -f "$manifest" >/dev/null 2>&1 || blocked '开发会话 Secret 无法原地轮换。'
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

main() {
  [[ $# == 1 && $1 == "--confirm=$CONFIRMATION" ]] || blocked '必须提供完全匹配的破坏性确认串。'
  exec 9>"$LOCK_FILE"
  flock -w 300 9 || blocked '另一个 combo-dev 操作长时间持有主机锁。'
  WORK=$(mktemp -d)
  preflight
  local before after
  before=$(production_fingerprint)
  MUTATING=1
  mark_failure_fence || blocked '无法写入持久失败收敛标记。'
  rm -rf -- /run/combo-dev-forwarders
  stop_and_delete_inventory || blocked '固定工作负载未能全部停止并删除。'
  rotate_session_credential
  wipe_static_volume_data
  recreate_foundation
  timeout 180 /opt/combo-dev/bin/combo-dev-smoke --storage-only >/dev/null 2>&1 || blocked '重置后的固定 PVC 未通过静态路径与冷启动校验。'
  rm -f -- "$STORAGE_LOW_MARKER"
  fence_all_writers || blocked '重置后全部写入者未保持关闭。'
  after=$(production_fingerprint)
  [[ "$before" == "$after" ]] || fail '重置期间生产指纹发生变化。'
  SUCCESS=1
  status 'PASS namespace=combo-preview pvc=retained data=cleared session=rotated writers=fenced'
}

main "$@"
