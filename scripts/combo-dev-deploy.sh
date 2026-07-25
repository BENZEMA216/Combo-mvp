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
readonly ACCEPTANCE_RUNNER='/opt/combo-dev/acceptance/run'
readonly INSTALL_ROOT='/opt/combo-dev'
readonly LOCK_FILE='/run/lock/combo-dev.lock'
readonly FENCE_LOCK_FILE='/run/lock/combo-dev-fence.lock'
readonly BEFORE_FREE_BYTES=$((45 * 1024 * 1024 * 1024))
readonly AFTER_FREE_BYTES=$((40 * 1024 * 1024 * 1024))
readonly SHA_RE='^[0-9a-f]{40}$'
readonly DIGEST_RE='^sha256:[0-9a-f]{64}$'
readonly JOB_PREFLIGHT_IMAGE='busybox@sha256:9532d8c39891ca2ecde4d30d7710e01fb739c87a8b9299685c63704296b16028'
readonly STORAGE_LOW_MARKER='/run/combo-dev-storage-low'
readonly FAILURE_FENCE_MARKER='/var/lib/combo-dev/writers-fenced'
readonly DISPATCHER_FENCE_BEFORE_SECONDS=$((7 * 24 * 60 * 60))
readonly DISPATCHER_OPERATION_MIN_SECONDS=$((4 * 60 * 60))
readonly APP_NAMES=(api worker runtime web)
readonly FOUNDATION_NAMES=(postgres redis-queue minio)
readonly CONTROL_FILES=(
  scripts/combo-dev-bootstrap.sh
  scripts/combo-dev-deploy.sh
  scripts/combo-dev-smoke.sh
  scripts/combo-dev-logs.sh
  scripts/combo-dev-reset.sh
  scripts/combo-dev-forwarder-lease.sh
  scripts/combo-dev-storage-guard.sh
  scripts/combo-dev-production-safety.py
  infra/host/combo-dev/combo-dev-web-forward.service
  infra/host/combo-dev/combo-dev-s3-forward.service
  infra/host/combo-dev/combo-dev-storage-guard.service
  infra/host/combo-dev/combo-dev-storage-guard.timer
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
RELEASE_CREATED=0
MUTATING=0
SUCCESS=0

status() { printf '[combo-dev] %s\n' "$1"; }
fail() { printf '[combo-dev] FAIL: %s\n' "$1" >&2; exit 1; }
blocked() { printf '[combo-dev] BLOCKED: %s\n' "$1" >&2; exit 2; }
require_command() { command -v "$1" >/dev/null 2>&1 || blocked "缺少主机工具：$1"; }

cleanup() {
  local rc=$?
  set +e
  [[ -z "$INCOMING_BUNDLE" ]] || rm -f -- "$INCOMING_BUNDLE"
  if (( MUTATING == 1 && SUCCESS == 0 )); then
    mark_failure_fence >/dev/null 2>&1 || true
    timeout 30 systemctl stop combo-dev-web-forward.service >/dev/null 2>&1 || true
    timeout 30 systemctl stop combo-dev-s3-forward.service >/dev/null 2>&1 || true
    if fence_all_writers_cleanup >/dev/null 2>&1; then
      status '失败收敛已验证；全部写入者、任务与转发器保持关闭。'
    else
      status '失败收敛无法验证；阻断标记已保留并需要主机所有者介入。'
    fi
  fi
  [[ -z "$WORK" ]] || rm -rf -- "$WORK"
  if (( SUCCESS == 0 && RELEASE_CREATED == 1 )) && [[ -n "$RELEASE_DIR" ]]; then rm -rf -- "$RELEASE_DIR"; fi
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

free_bytes() {
  df -PB1 "$1" 2>/dev/null | awk 'NR==2 {print $4}'
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

claim_forwarders_for_deploy() {
  local unit active
  rm -rf -- /run/combo-dev-forwarders
  timeout 30 systemctl stop combo-dev-web-forward.service combo-dev-s3-forward.service >/dev/null 2>&1 || blocked '无法取得回环转发器排他所有权。'
  for unit in combo-dev-web-forward.service combo-dev-s3-forward.service; do
    active=$(timeout 10 systemctl is-active "$unit" 2>/dev/null || true)
    [[ "$active" == inactive || "$active" == failed ]] || blocked '回环转发器仍由其他会话持有。'
  done
}

host_preflight() {
  [[ $(id -u) -eq 0 ]] || blocked '调度器必须由受限 sudo 规则以 root 启动。'
  for cmd in kubectl python3 jq sha256sum flock findmnt df systemctl ss timeout readlink install diff mv stat dirname openssl base64 head; do require_command "$cmd"; done
  root_owned_not_writable /etc/combo-dev || blocked '开发配置目录可被非 root 修改。'
  root_owned_not_writable "$INSTALL_ROOT" || blocked '安装根目录可被非 root 修改。'
  root_owned_not_writable "$INSTALL_ROOT/bin" || blocked '调度器目录可被非 root 修改。'
  if ! root_owned_not_writable "$INSTALL_ROOT/bin/combo-dev-production-safety" || [[ ! -x "$INSTALL_ROOT/bin/combo-dev-production-safety" ]]; then
    blocked '共享生产安全检查器不可用。'
  fi
  root_owned_not_writable /var/lib/combo-dev || blocked '持久失败收敛目录可被非 root 修改。'
  root_owned_not_writable "$INSTALL_ROOT/releases" || blocked '发布目录可被非 root 修改。'
  root_owned_not_writable "$INSTALL_ROOT/acceptance" || blocked '验收器目录可被非 root 修改。'
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
  verify_bounded_storage_pool || blocked 'combo-dev 没有使用独立且硬限制为 18 GiB 以内的挂载。'
  verify_k3s_mount_dependencies || blocked 'k3s 必须只依赖生产父数据盘，不能依赖开发挂载或其任何子路径。'
  dispatcher_certificate_valid_for "$DISPATCHER_OPERATION_MIN_SECONDS" || blocked '调度证书不足以覆盖最长部署操作。'
  dispatcher_certificate_valid_for "$DISPATCHER_FENCE_BEFORE_SECONDS" || blocked '调度证书已进入预到期失败收敛窗口，必须重新 bootstrap。'
  [[ $(timeout 10 systemctl is-enabled combo-dev-storage-guard.timer 2>/dev/null || true) == enabled ]] || blocked '持续存储守卫未启用。'
  timeout 180 systemctl start combo-dev-storage-guard.service >/dev/null 2>&1 || blocked '持续守卫无法证明两套凭据与失败收敛路径健康。'
  assert_storage_headroom
  local free
  free=$(free_bytes /) || blocked '无法读取根盘容量。'
  if [[ ! "$free" =~ ^[0-9]+$ ]] || (( free < BEFORE_FREE_BYTES )); then blocked '部署前根盘可用空间不足 45 GiB。'; fi
  free=$(free_bytes "$DATA_MOUNT") || blocked '无法读取数据盘容量。'
  if [[ ! "$free" =~ ^[0-9]+$ ]] || (( free < BEFORE_FREE_BYTES )); then blocked '部署前数据盘可用空间不足 45 GiB。'; fi
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
  can_i_exact yes list clusterroles.rbac.authorization.k8s.io
  can_i_exact yes list clusterrolebindings.rbac.authorization.k8s.io
  can_i_exact no list persistentvolumes
  can_i_exact no create pods "$NAMESPACE"
  can_i_exact no get secrets "$NAMESPACE"
  can_i_exact no patch deployments.apps "$PRODUCTION_NAMESPACE"
  can_i_exact no create jobs.batch "$PRODUCTION_NAMESPACE"

  python3 "$INSTALL_ROOT/bin/combo-dev-production-safety" verify-observer \
    --audit-kubeconfig "$DEPLOY_KUBECONFIG" \
    --observer-kubeconfig "$PRODUCTION_KUBECONFIG" \
    --production-namespace "$PRODUCTION_NAMESPACE" \
    --work-dir "$WORK/observer-audit" >/dev/null 2>&1 || blocked '生产观察身份不符合精确只读边界。'

  validate_cluster_platform_live
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

mark_failure_fence() {
  install -d -o root -g root -m 0700 /var/lib/combo-dev
  printf '%s\n' 'combo-dev-writers=fenced' >"$FAILURE_FENCE_MARKER"
  chmod 0600 "$FAILURE_FENCE_MARKER"
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
import os, pathlib, sys, tarfile
archive, destination = sys.argv[1:]
allowed_files = {
    'metadata/revision', 'metadata/image-digests.txt',
    'metadata/release.json', 'metadata/release-manifest-digest.txt',
    'scripts/combo-dev-bootstrap.sh', 'scripts/combo-dev-deploy.sh',
    'scripts/combo-dev-smoke.sh', 'scripts/combo-dev-connect.sh',
    'scripts/combo-dev-logs.sh', 'scripts/combo-dev-reset.sh',
    'scripts/combo-dev-forwarder-lease.sh', 'scripts/combo-dev-storage-guard.sh',
    'scripts/combo-dev-production-safety.py',
    'infra/host/combo-dev/README.md',
    'infra/host/combo-dev/combo-dev-web-forward.service',
    'infra/host/combo-dev/combo-dev-s3-forward.service',
    'infra/host/combo-dev/combo-dev-storage-guard.service',
    'infra/host/combo-dev/combo-dev-storage-guard.timer',
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
    os.makedirs(destination, mode=0o700, exist_ok=False)
    tf.extractall(destination)
for root, dirs, files in os.walk(destination):
    os.chown(root, 0, 0)
    os.chmod(root, 0o755)
    for name in files:
        path=os.path.join(root,name)
        os.chown(path, 0, 0)
        relative=os.path.relpath(path,destination)
        if relative.startswith('scripts/combo-dev-') and relative.endswith('.sh'):
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
    "$INSTALL_ROOT/bin/combo-dev-storage-guard"
    "$INSTALL_ROOT/bin/combo-dev-production-safety"
    /etc/systemd/system/combo-dev-web-forward.service
    /etc/systemd/system/combo-dev-s3-forward.service
    /etc/systemd/system/combo-dev-storage-guard.service
    /etc/systemd/system/combo-dev-storage-guard.timer
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
for current, dirs, files in os.walk(root, followlinks=False):
    entries=[current]+[os.path.join(current,x) for x in dirs+files]
    for path in entries:
        s=os.lstat(path)
        if s.st_uid != 0 or stat.S_ISLNK(s.st_mode) or (s.st_mode & 0o022):
            raise SystemExit(2)
PY
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

allowed_secret_names={'combo-dev-env','combo-dev-session'}
expected_secret_keys={
 'minio':{'MINIO_ROOT_USER','MINIO_ROOT_PASSWORD'},
 'postgres':{'POSTGRES_USER','POSTGRES_PASSWORD','POSTGRES_DB'},
 'redis-hot':set(),'redis-queue':set(),
 'minio-init':{'MINIO_ROOT_USER','MINIO_ROOT_PASSWORD','S3_ACCESS_KEY','S3_SECRET_KEY'},
 'migrate':{'POSTGRES_USER','POSTGRES_PASSWORD','POSTGRES_DB'},
 'api':{'DEV_SESSION_SECRET','S3_ACCESS_KEY','S3_SECRET_KEY','LOGTO_ENDPOINT','LOGTO_ISSUER','LOGTO_JWKS_URI','LOGTO_APP_ID','LOGTO_APP_SECRET','LOGTO_AUDIENCE','ANTHROPIC_API_KEY','OPENROUTER_API_KEY','LLM_PROVIDER','LLM_BASE_URL','LLM_MODEL','POSTGRES_USER','POSTGRES_PASSWORD','POSTGRES_DB'},
 'runtime':{'DEV_SESSION_SECRET','POSTGRES_USER','POSTGRES_PASSWORD','POSTGRES_DB','S3_ACCESS_KEY','S3_SECRET_KEY','LOGTO_ISSUER','LOGTO_JWKS_URI','LOGTO_AUDIENCE','ANTHROPIC_API_KEY','OPENROUTER_API_KEY','RUNTIME_LLM_PROVIDER','RUNTIME_LLM_MODEL'},
 'worker':{'POSTGRES_USER','POSTGRES_PASSWORD','POSTGRES_DB','S3_ACCESS_KEY','S3_SECRET_KEY','ANTHROPIC_API_KEY','OPENROUTER_API_KEY','LLM_PROVIDER','LLM_BASE_URL','LLM_MODEL'},
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
    if any(secret != ('combo-dev-session' if key == 'DEV_SESSION_SECRET' else 'combo-dev-env') for key,secret in refs_found):
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
if 'http://127.0.0.1:18080' not in text or 'http://127.0.0.1:19000' not in text: raise SystemExit('guard:origins')
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
  local free
  assert_storage_headroom
  free=$(free_bytes /) || blocked '无法读取部署后根盘容量。'
  if [[ ! "$free" =~ ^[0-9]+$ ]] || (( free < AFTER_FREE_BYTES )); then fail '部署后根盘可用空间不足 40 GiB。'; fi
  free=$(free_bytes "$DATA_MOUNT") || blocked '无法读取部署后数据盘容量。'
  if [[ ! "$free" =~ ^[0-9]+$ ]] || (( free < AFTER_FREE_BYTES )); then fail '部署后数据盘可用空间不足 40 GiB。'; fi
}

prune_releases() {
  local keep
  mapfile -t keep < <(find "$INSTALL_ROOT/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | awk 'NR>3 {print $2}')
  ((${#keep[@]} == 0)) || rm -rf -- "${keep[@]}"
  find "$INSTALL_ROOT/incoming" -maxdepth 1 -type f -mtime +2 -delete
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
  local bundle='' revision='' arg
  while (($#)); do
    arg=$1; shift
    case "$arg" in
      --bundle) bundle=${1:?}; shift ;;
      --revision) revision=${1:?}; shift ;;
      *) fail '未知部署参数。' ;;
    esac
  done
  [[ -f "$bundle" && ! -L "$bundle" ]] || blocked '部署包不存在或不是普通文件。'
  [[ "$revision" =~ $SHA_RE ]] || blocked '部署 revision 不是完整提交 SHA。'
  [[ $(readlink -f "$bundle" 2>/dev/null || true) == "$INSTALL_ROOT/incoming/$revision.tar.gz" ]] || blocked '部署包不在固定 incoming 路径。'
  INCOMING_BUNDLE=$bundle

  exec 9>"$LOCK_FILE"
  flock -w 300 9 || blocked '另一个 combo-dev 操作长时间持有主机锁。'
  WORK=$(mktemp -d)
  host_preflight
  rbac_preflight
  claim_forwarders_for_deploy

  local trusted_bundle="$WORK/bundle.tar.gz"
  install -m 0600 "$bundle" "$trusted_bundle" || blocked '部署包无法复制到 root-owned 临时目录。'
  rm -f -- "$bundle" || blocked 'incoming 部署包无法在受信复制后删除。'
  INCOMING_BUNDLE=''
  local candidate_release="$INSTALL_ROOT/releases/$revision" candidate_extract="$WORK/candidate"
  validate_bundle "$trusted_bundle" "$candidate_extract" || blocked '部署包不在固定白名单内。'
  if [[ -e "$candidate_release" ]]; then
    [[ -d "$candidate_release" && ! -L "$candidate_release" ]] || blocked '既有 revision 路径不是 root-owned 发布目录。'
    diff -qr "$candidate_extract" "$candidate_release" >/dev/null 2>&1 || blocked '同一 revision 的既有发布内容不一致。'
    rm -rf -- "$candidate_extract"
  else
    mv "$candidate_extract" "$candidate_release"
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

  local before after start evidence evidence_bytes runner_mode
  before=$(production_fingerprint)
  start=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  MUTATING=1
  mark_failure_fence || fail '持久失败收敛标记无法写入。'
  fence_all_writers || fail '全部持久与临时写入者未能关闭。'
  apply_and_wait_foundation "$WORK/prepared/render"
  run_pre_app_storage
  run_pre_app_isolation
  run_job minio-init "$WORK/prepared/render/init.yaml" 360
  run_job migrate "$WORK/prepared/render/migrate.yaml" 660
  wait_apps "$WORK/prepared/render"
  prune_stale_configs

  timeout 30 systemctl start combo-dev-web-forward.service >/dev/null 2>&1 || fail 'Web 回环转发器启动失败。'
  timeout 30 systemctl start combo-dev-s3-forward.service >/dev/null 2>&1 || fail 'S3 回环转发器启动失败。'
  wait_loopback_listeners

  [[ -x "$ACCEPTANCE_RUNNER" ]] || blocked '真实浏览器与产品流验收器尚未由主机所有者配置。'
  [[ $(stat -c '%u' "$ACCEPTANCE_RUNNER" 2>/dev/null) == 0 ]] || blocked '真实验收器不归 root 所有。'
  runner_mode=$(stat -c '%a' "$ACCEPTANCE_RUNNER" 2>/dev/null) || blocked '真实验收器权限不可读。'
  [[ "$runner_mode" =~ ^[0-7]{3,4}$ ]] || blocked '真实验收器权限格式异常。'
  (( (8#$runner_mode & 8#022) == 0 )) || blocked '真实验收器可被非 root 修改。'
  evidence=$(mktemp "$WORK/acceptance.XXXXXX.json")
  if ! timeout 3600 "$ACCEPTANCE_RUNNER" --revision "$revision" \
    --web-origin 'http://127.0.0.1:18080' --s3-origin 'http://127.0.0.1:19000' 2>/dev/null |
    head -c 65537 >"$evidence"; then
    blocked '真实浏览器或产品流验收未完成。'
  fi
  evidence_bytes=$(stat -c '%s' "$evidence" 2>/dev/null) || blocked '真实验收证据大小不可读。'
  [[ "$evidence_bytes" =~ ^[0-9]+$ && "$evidence_bytes" -le 65536 ]] || blocked '真实验收证据超过 64 KiB。'
  timeout 1200 "$INSTALL_ROOT/bin/combo-dev-smoke" --revision "$revision" --since-time "$start" --evidence "$evidence" >/dev/null || {
    rc=$?; (( rc == 1 )) && fail '有限验收失败。'; blocked '有限验收证据不完整或超时。';
  }

  timeout 30 systemctl stop combo-dev-web-forward.service >/dev/null 2>&1 || fail 'Web 临时转发器无法停止。'
  timeout 30 systemctl stop combo-dev-s3-forward.service >/dev/null 2>&1 || fail 'S3 临时转发器无法停止。'
  after=$(production_fingerprint)
  [[ "$before" == "$after" ]] || fail '生产资源指纹在验收窗口内发生变化。'

  exec 8>"$FENCE_LOCK_FILE"
  flock -w 300 8 || fail '无法取得最终失败收敛锁。'
  post_capacity
  verify_writers_restored || fail '解除持久阻断前无法证明全部写入者已恢复单副本就绪。'
  ln -sfn "$RELEASE_DIR" "$INSTALL_ROOT/current.next"
  mv -Tf "$INSTALL_ROOT/current.next" "$INSTALL_ROOT/current"
  prune_releases
  rm -f -- "$FAILURE_FENCE_MARKER" || fail '成功部署后无法解除持久写入阻断标记。'
  SUCCESS=1
  status "PASS revision=$revision"
}

if [[ ${1:-} != '--render-only' && ${COMBO_DEV_DEADLINE_GUARD:-0} != 1 ]]; then
  command -v timeout >/dev/null 2>&1 || blocked '缺少总时限工具。'
  exec env COMBO_DEV_DEADLINE_GUARD=1 timeout --signal=TERM --kill-after=300s 6900s bash "${BASH_SOURCE[0]}" "$@"
fi
main "$@"
