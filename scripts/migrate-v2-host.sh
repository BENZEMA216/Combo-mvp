#!/usr/bin/env bash
# tecent2 主机上的唯一 V2 迁移入口。持有与 Preview/Production 正式迁移相同的
# shared-foundation flock，直到 Job、实例级角色核对和三环境 readiness 全部结束。
set -euo pipefail
set +x

usage() {
  printf '%s\n' 'usage: migrate-v2-host.sh --render-dir DIR [--kubeconfig PATH]' >&2
  exit 2
}

render_dir=
kubeconfig=${KUBECONFIG:-$HOME/.kube/config}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --render-dir) render_dir=${2:-}; shift 2 ;;
    --kubeconfig) kubeconfig=${2:-}; shift 2 ;;
    *) usage ;;
  esac
done

[[ -n "$render_dir" && -d "$render_dir" ]] || usage
[[ -f "$render_dir/namespace.yaml" && -f "$render_dir/job-migrate.yaml" ]] || usage
command -v flock >/dev/null 2>&1 || { printf '%s\n' 'migrate-v2-host: flock is required' >&2; exit 1; }
command -v kubectl >/dev/null 2>&1 || { printf '%s\n' 'migrate-v2-host: kubectl is required' >&2; exit 1; }

mkdir -p "$HOME/data"
exec 9>"$HOME/data/combo-foundation-shared.lock"
flock -w 900 9 || {
  printf '%s\n' 'migrate-v2-host: timed out waiting for the shared foundation lock' >&2
  exit 1
}

k=(kubectl --kubeconfig "$kubeconfig" --request-timeout=30s)
cleanup_required=0

job_and_pods_absent() {
  local namespace job pods
  namespace=$("${k[@]}" get namespace combo-v2 -o name --ignore-not-found 2>/dev/null) || return 1
  [[ -z "$namespace" ]] && return 0
  job=$(
    "${k[@]}" -n combo-v2 get job migrate -o name --ignore-not-found 2>/dev/null
  ) || return 1
  [[ -n "$job" ]] && return 1
  pods=$("${k[@]}" -n combo-v2 get pods -l job-name=migrate -o name 2>/dev/null) || return 1
  [[ -z "$pods" ]]
}

# 退出或中断前必须确认 V2 Job 与 Pod 都已消失。API Server 暂时不可达时持续重试并
# 保持 fd 9 的主机锁；宁可阻塞正式迁移，也不能让失去监护的 V2 Job 并发运行。
stop_v2_job() {
  while true; do
    "${k[@]}" -n combo-v2 delete job migrate \
      --ignore-not-found --wait=true --timeout=120s >/dev/null 2>&1 || true
    if job_and_pods_absent; then
      cleanup_required=0
      return 0
    fi
    printf '%s\n' 'migrate-v2-host: waiting to confirm migration Job termination' >&2
    sleep 5
  done
}

cleanup_on_exit() {
  local status=$?
  trap - EXIT
  trap '' HUP INT TERM
  if [[ "$cleanup_required" == 1 ]]; then
    stop_v2_job
  fi
  exit "$status"
}
trap cleanup_on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

cleanup_required=1
"${k[@]}" apply -f "$render_dir/namespace.yaml"

# 清理任何上次异常遗留的同名 Job 后，才允许读取本次迁移输入。
stop_v2_job
"${k[@]}" -n combo-v2 get secret combo-env >/dev/null

# 0014→0015 是停机迁移：禁止旧 billing/gateway writer 与新 schema 混跑。调用者先把
# 四个 V2 Deployment 缩到 0，并等待所有 Pod 消失；迁移成功后再应用同候选的新清单。
for deployment in authz billing llm-gateway restart-life; do
  replicas=$(
    "${k[@]}" -n combo-v2 get deployment "$deployment" \
      -o 'jsonpath={.spec.replicas}' --ignore-not-found
  ) || {
    printf 'migrate-v2-host: cannot inspect combo-v2/%s\n' "$deployment" >&2
    exit 1
  }
  if [[ -n "$replicas" && "$replicas" != 0 ]]; then
    printf 'migrate-v2-host: combo-v2/%s must be scaled to zero before migration\n' \
      "$deployment" >&2
    exit 1
  fi
done
v2_writer_pods=$(
  "${k[@]}" -n combo-v2 get pods \
    -l 'app in (authz,billing,llm-gateway,restart-life)' -o name
) || {
  printf '%s\n' 'migrate-v2-host: cannot verify stopped V2 writer Pods' >&2
  exit 1
}
if [[ -n "$v2_writer_pods" ]]; then
  printf '%s\n' 'migrate-v2-host: V2 writer Pods must be absent before migration' >&2
  exit 1
fi

# 三个共享实例应用角色的 V2 密码必须与 Preview/Production 当前 Secret 完全一致。
# 只在 shell 内存比较 Kubernetes 返回的 base64 字段；绝不打印、落盘或复制值。
shared_role_secrets_match() {
  local key=$1
  local v2_value preview_value production_value
  v2_value=$("${k[@]}" -n combo-v2 get secret combo-env -o "jsonpath={.data.${key}}") || return 1
  preview_value=$("${k[@]}" -n combo-preview get secret combo-env -o "jsonpath={.data.${key}}") || return 1
  production_value=$("${k[@]}" -n combo-prod get secret combo-env -o "jsonpath={.data.${key}}") || return 1
  [[ -n "$v2_value" && "$v2_value" == "$preview_value" && "$v2_value" == "$production_value" ]]
}
for key in POSTGRES_API_PASSWORD POSTGRES_WORKER_PASSWORD POSTGRES_RUNTIME_PASSWORD; do
  if ! shared_role_secrets_match "$key"; then
    printf 'migrate-v2-host: shared role Secret mismatch for %s\n' "$key" >&2
    exit 1
  fi
done

cleanup_required=1
"${k[@]}" apply -f "$render_dir/job-migrate.yaml"

failed=0
if ! "${k[@]}" -n combo-v2 wait --for=condition=complete job/migrate --timeout=300s; then
  "${k[@]}" -n combo-v2 logs job/migrate --tail=100 >&2 || true
  stop_v2_job
  failed=1
fi

# runner 把每次 NOLOGIN 与密码恢复放在同一 migration transaction。Job 返回后再从
# shared PostgreSQL 主实例核对五个实例级角色，查询只输出单个布尔值，不读取密码。
# Quoted variables intentionally expand inside the PostgreSQL container.
# shellcheck disable=SC2016
roles_ready=$(
  "${k[@]}" -n combo-foundation exec statefulset/postgres -- sh -ceu \
    'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "
       SELECT count(*) = 5 AND bool_and(rolcanlogin)
         FROM pg_roles
        WHERE rolname IN ('"'"'combo_api'"'"', '"'"'combo_worker'"'"', '"'"'combo_runtime'"'"',
                          '"'"'combo_authz'"'"', '"'"'combo_billing'"'"')"' \
    2>/dev/null | tr -d '[:space:]'
) || roles_ready=false
if [[ "$roles_ready" != t ]]; then
  printf '%s\n' 'migrate-v2-host: application role login verification failed' >&2
  failed=1
fi

# Secret 相等后，再从 Preview/Production 当前 Pod 用各自注入的凭据建立全新连接。
# 这同时防止 Secret 已轮换但 Pod 仍持旧环境变量时误报成功。
verify_application_role_connection() {
  local namespace=$1 deployment=$2 pg_module=$3 expected_role=$4 secret_key=$5
  local secret_value pod_value
  secret_value=$(
    "${k[@]}" -n "$namespace" get secret combo-env -o "jsonpath={.data.${secret_key}}"
  ) || return 1
  pod_value=$(
    "${k[@]}" -n "$namespace" exec "deployment/$deployment" -- \
      node -e 'const {Client}=require(process.argv[1]); const expected=process.argv[2]; const encoded=Buffer.from(process.env.PGPASSWORD ?? "", "utf8").toString("base64"); (async()=>{const client=new Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000}); try{await client.connect(); const result=await client.query("SELECT current_user"); if(result.rows[0]?.current_user!==expected) throw new Error("role mismatch"); process.stdout.write(encoded);} finally{await client.end().catch(()=>undefined);}})().catch(()=>{process.exitCode=1;});' \
      "$pg_module" "$expected_role" \
      2>/dev/null
  ) || return 1
  [[ -n "$secret_value" && "$pod_value" == "$secret_value" ]] || return 1
}
for namespace in combo-preview combo-prod; do
  if ! verify_application_role_connection \
    "$namespace" api /app/apps/authoring/node_modules/pg combo_api POSTGRES_API_PASSWORD; then
    printf 'migrate-v2-host: %s/combo_api credential or fresh connection failed\n' "$namespace" >&2
    failed=1
  fi
  if ! verify_application_role_connection \
    "$namespace" worker /app/apps/authoring/node_modules/pg combo_worker POSTGRES_WORKER_PASSWORD; then
    printf 'migrate-v2-host: %s/combo_worker credential or fresh connection failed\n' "$namespace" >&2
    failed=1
  fi
  if ! verify_application_role_connection \
    "$namespace" runtime /app/apps/runtime/node_modules/pg combo_runtime POSTGRES_RUNTIME_PASSWORD; then
    printf 'migrate-v2-host: %s/combo_runtime credential or fresh connection failed\n' "$namespace" >&2
    failed=1
  fi
done

for namespace in combo-test combo-preview combo-prod; do
  for deployment in api worker runtime web; do
    if ! "${k[@]}" -n "$namespace" rollout status "deployment/$deployment" --timeout=120s; then
      printf 'migrate-v2-host: %s/%s is not ready\n' "$namespace" "$deployment" >&2
      failed=1
    fi
  done
done

if [[ "$failed" != 0 ]]; then
  printf '%s\n' 'migrate-v2-host: V2 migration verification failed' >&2
  exit 1
fi

printf '%s\n' 'migrate-v2-host: V2 migration and shared foundation verification completed'
