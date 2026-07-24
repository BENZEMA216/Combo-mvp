#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly SCRIPT_DIR
readonly SHA_RE='^[0-9a-f]{40}$'
readonly DIGEST_RE='^sha256:[0-9a-f]{64}$'

ENVIRONMENT=''
FRESH_RESET=0
MANIFEST=''
MANIFEST_DIGEST=''
MIGRATIONS=''
FOUNDATION_YAML=''
INIT_YAML=''
MIGRATE_YAML=''
APPS_YAML=''
WEB_ASSETS=''
KUBECONFIG_PATH=${KUBECONFIG:-"$HOME/.kube/config"}
EVIDENCE_ROOT=${COMBO_RELEASE_EVIDENCE_ROOT:-"$HOME/data/combo-releases/goal-a"}
MUTATION_LOCK=${COMBO_MUTATION_LOCK:-"$HOME/data/combo-release-mutation.lock"}
K3S_STORAGE_ROOT=${COMBO_K3S_STORAGE_ROOT:-"$HOME/data/k3s/storage"}

status() { printf '[release] %s\n' "$1"; }
fail() {
  printf '[release] FAIL: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage: deploy-release.sh
  --environment preview|production
  --fresh-reset
  --manifest release.json
  --manifest-digest sha256:...
  --migrations migration-files.txt
  --foundation-yaml rendered-foundation.yaml
  --init-yaml rendered-init.yaml
  --migrate-yaml rendered-migrate.yaml
  --apps-yaml rendered-apps.yaml
  --web-assets web-asset-manifest.json
EOF
  exit 2
}

while (($# > 0)); do
  case "$1" in
    --fresh-reset)
      FRESH_RESET=1
      shift
      ;;
    --environment | --manifest | --manifest-digest | --migrations | --foundation-yaml | \
      --init-yaml | --migrate-yaml | --apps-yaml | --web-assets)
      (($# >= 2)) || usage
      case "$1" in
        --environment) ENVIRONMENT=$2 ;;
        --manifest) MANIFEST=$2 ;;
        --manifest-digest) MANIFEST_DIGEST=$2 ;;
        --migrations) MIGRATIONS=$2 ;;
        --foundation-yaml) FOUNDATION_YAML=$2 ;;
        --init-yaml) INIT_YAML=$2 ;;
        --migrate-yaml) MIGRATE_YAML=$2 ;;
        --apps-yaml) APPS_YAML=$2 ;;
        --web-assets) WEB_ASSETS=$2 ;;
      esac
      shift 2
      ;;
    *) usage ;;
  esac
done

case "$ENVIRONMENT" in
  preview)
    NAMESPACE=combo-review
    ENV_SECRET=combo-preview-env
    PULL_SECRET=combo-preview-ghcr-pull
    PUBLIC_ORIGIN=https://review.43-160-242-46.sslip.io
    S3_ORIGIN=https://review-s3.43-160-242-46.sslip.io
    WEB_FORWARD_UNIT=combo-release-preview-web-forward.service
    MINIO_FORWARD_UNIT=combo-release-preview-minio-forward.service
    WEB_FORWARD_ENV=/etc/combo-release/preview-web-forward.env
    WEB_FORWARD_PORT=18081
    MINIO_FORWARD_PORT=19001
    NGINX_CONFIG=/etc/nginx/conf.d/combo-cloud-review.conf
    LEGACY_WEB_PORT=30081
    LEGACY_MINIO_PORT=30901
    LEGACY_WEB_PROXY_COUNT=1
    FOUNDATION_TRACK=preview-v1
    [[ -n "$FOUNDATION_YAML" && -n "$INIT_YAML" ]] ||
      fail 'Preview requires fresh foundation and init manifests'
    LEGACY_DEPLOYMENTS=(api consumer redis-hot runtime sweeper web worker)
    LEGACY_STATEFULSETS=(postgres redis-queue minio)
    LEGACY_SERVICES=(api runtime web postgres redis-queue redis-hot minio)
    LEGACY_JOBS=(migrate minio-init)
    LEGACY_CONFIGMAPS=(
      redis-queue-config
      redis-hot-config
      minio-init-script
      combo-preview-web-review
    )
    LEGACY_CLAIMS=(
      combo-preview-postgres-data-postgres-0
      combo-preview-redis-queue-data-redis-queue-0
      combo-preview-minio-data-minio-0
    )
    PVC_RE='^(combo-preview-(postgres-data-postgres|redis-queue-data-redis-queue|minio-data-minio)-0|data-release-(postgres|redis-queue|minio)-0)$'
    DEPLOYMENT_RE='^(api|consumer|redis-hot|runtime|sweeper|web|worker|release-redis-hot|release-[0-9a-f]{12}-(api|runtime|web|worker))$'
    ;;
  production)
    NAMESPACE=combo
    ENV_SECRET=combo-env
    PULL_SECRET=ghcr-pull
    PUBLIC_ORIGIN=https://agora.43-160-242-46.sslip.io
    S3_ORIGIN=https://s3.43-160-242-46.sslip.io
    WEB_FORWARD_UNIT=combo-release-production-web-forward.service
    MINIO_FORWARD_UNIT=combo-release-production-minio-forward.service
    WEB_FORWARD_ENV=/etc/combo-release/production-web-forward.env
    WEB_FORWARD_PORT=18082
    MINIO_FORWARD_PORT=19002
    NGINX_CONFIG=/etc/nginx/conf.d/zz-agora-demo.conf
    LEGACY_WEB_PORT=30080
    LEGACY_MINIO_PORT=30900
    LEGACY_WEB_PROXY_COUNT=3
    FOUNDATION_TRACK=production-v1
    [[ -n "$FOUNDATION_YAML" && -n "$INIT_YAML" ]] ||
      fail 'Production requires fresh foundation and init manifests'
    LEGACY_DEPLOYMENTS=(api redis-hot runtime web worker)
    LEGACY_STATEFULSETS=(postgres redis-queue minio)
    LEGACY_SERVICES=(api runtime web postgres redis-queue redis-hot minio)
    LEGACY_JOBS=(migrate minio-init)
    LEGACY_CONFIGMAPS=(
      redis-queue-config
      redis-hot-config
      minio-init-script
    )
    LEGACY_CLAIMS=(data-postgres-0 data-redis-queue-0 data-minio-0)
    PVC_RE='^data-(postgres|redis-queue|minio)-0$|^data-release-(postgres|redis-queue|minio)-0$'
    DEPLOYMENT_RE='^(api|redis-hot|runtime|web|worker|release-redis-hot|release-[0-9a-f]{12}-(api|runtime|web|worker))$'
    ;;
  *) usage ;;
esac
((FRESH_RESET == 1)) || fail 'this deployment requires --fresh-reset'

RELEASE_STATEFULSETS=(release-postgres release-redis-queue release-minio)
RELEASE_SERVICES=(release-postgres release-redis-queue release-redis-hot release-minio)
RELEASE_CONFIGMAPS=(
  release-redis-queue-config
  release-redis-hot-config
  release-minio-init-script
)
RELEASE_CLAIMS=(
  data-release-postgres-0
  data-release-redis-queue-0
  data-release-minio-0
)

for command in node jq sha256sum flock kubectl cmp awk install mktemp realpath grep mv \
  rm dirname sleep seq tr sort sudo curl stat date systemctl ss; do
  command -v "$command" >/dev/null 2>&1 || fail "missing host command: $command"
done
[[ -x "$SCRIPT_DIR/switch-release-traffic.sh" ]] ||
  fail 'release traffic controller is missing or not executable'

K=(kubectl --kubeconfig "$KUBECONFIG_PATH")
source_sha=''
release_id=''
migration_head=''
built_at=''
web_asset_digest=''
api_image=''
runtime_image=''
web_image=''
PREFIX=''
metadata_name=''
INIT_JOB=''
work=''
release_directory=''
pending_checkpoint=''
traffic_evidence=''
cleanup_evidence=''
cleanup_targets=''
inventory_deployments=''
inventory_statefulsets=''
inventory_jobs=''
inventory_services=''
inventory_configmaps=''
inventory_pvcs=''
pvc_inventory=''
release_storage_evidence=''
mutation_started=0
deployment_succeeded=0
traffic_cut_succeeded=0
INITIAL_FRESH=0
TRAFFIC_MODE=''
ACTIVE_RELEASE_WEB=''
RECORD_CLEANUP=0
RESUME_POST_CUT=0
FOUNDATION_CREATED_THIS_RELEASE=0
REUSE_COMPLETED=0
CHECKPOINT_PHASE=''

validate_migrations() {
  local expected=(
    0000_baseline_schema.sql
    0001_expired_upload_reconciliation.sql
    0002_drop_stream_events.sql
    0003_turns.sql
    0004_studio_sessions.sql
    0005_capability_current_ui.sql
    0006_one_running_turn_per_session.sql
  )
  local actual=()
  mapfile -t actual <"$MIGRATIONS"
  ((${#actual[@]} == ${#expected[@]})) ||
    fail 'migration file list must contain exactly 0000 through 0006'
  local index
  for index in "${!expected[@]}"; do
    [[ "${actual[$index]}" == "${expected[$index]}" ]] ||
      fail 'migration file list differs from the exact 0000 through 0006 contract'
  done
  [[ "${actual[-1]}" == "$migration_head" ]] ||
    fail 'migration file list does not reach the release migration head'
}

validate_inputs() {
  local file verified_digest verified_web_digest
  for file in "$MANIFEST" "$MIGRATIONS" "$FOUNDATION_YAML" "$INIT_YAML" \
    "$MIGRATE_YAML" "$APPS_YAML" "$WEB_ASSETS"; do
    [[ -f "$file" && ! -L "$file" ]] || fail "input is not a regular file: $file"
  done
  [[ "$MANIFEST_DIGEST" =~ $DIGEST_RE ]] || fail 'invalid release manifest digest'
  verified_digest=$(node "$SCRIPT_DIR/release-manifest.mjs" verify \
    --manifest "$MANIFEST" --digest "$MANIFEST_DIGEST")
  [[ "$verified_digest" == "$MANIFEST_DIGEST" ]] ||
    fail 'release manifest verifier returned another digest'

  source_sha=$(jq -er '.sourceSha' "$MANIFEST")
  release_id=$(jq -er '.releaseId' "$MANIFEST")
  migration_head=$(jq -er '.migrationHead' "$MANIFEST")
  built_at=$(jq -er '.builtAt' "$MANIFEST")
  web_asset_digest=$(jq -er '.webAssetManifest' "$MANIFEST")
  api_image=$(jq -er '.images.api' "$MANIFEST")
  runtime_image=$(jq -er '.images.runtime' "$MANIFEST")
  web_image=$(jq -er '.images.web' "$MANIFEST")
  [[ "$source_sha" =~ $SHA_RE ]] || fail 'manifest source SHA is invalid'
  [[ "$release_id" == "release-$source_sha" ]] || fail 'manifest release identity is invalid'
  PREFIX="release-${source_sha:0:12}-"
  metadata_name="combo-release-meta-${source_sha:0:12}"
  INIT_JOB="${PREFIX}minio-init"

  verified_web_digest=$(node "$SCRIPT_DIR/web-asset-manifest.mjs" verify \
    --manifest "$WEB_ASSETS" --digest "$web_asset_digest")
  [[ "$verified_web_digest" == "$web_asset_digest" ]] ||
    fail 'Web asset manifest verifier returned another digest'
  validate_migrations
}

secret_has_nonempty_key() {
  local secret=$1 key=$2
  [[ "$key" =~ ^[A-Za-z0-9._-]+$ ]] || return 1
  # The API-side template emits only a fixed boolean marker, never key material.
  [[ "$("${K[@]}" -n "$NAMESPACE" get secret "$secret" \
    -o "go-template={{if gt (len (index .data \"$key\")) 0}}valid{{end}}" \
    2>/dev/null)" == valid ]]
}

validate_secret_keys() {
  local key
  for key in POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB S3_ACCESS_KEY S3_SECRET_KEY \
    LOGTO_ISSUER LOGTO_JWKS_URI LOGTO_AUDIENCE; do
    secret_has_nonempty_key "$ENV_SECRET" "$key" ||
      fail "$ENV_SECRET is missing required key $key"
  done
  secret_has_nonempty_key "$PULL_SECRET" .dockerconfigjson ||
    fail "$PULL_SECRET is missing its registry key"
  if [[ "$ENVIRONMENT" == preview ]]; then
    secret_has_nonempty_key combo-preview-bootstrap DEV_SESSION_SECRET ||
      fail 'combo-preview-bootstrap is missing DEV_SESSION_SECRET'
    secret_has_nonempty_key combo-preview-bootstrap REVIEW_ACCESS_TOKEN ||
      fail 'combo-preview-bootstrap is missing REVIEW_ACCESS_TOKEN'
  else
    for key in LOGTO_ENDPOINT LOGTO_APP_ID LOGTO_APP_SECRET LOGTO_REDIRECT_URI; do
      secret_has_nonempty_key "$ENV_SECRET" "$key" ||
        fail "$ENV_SECRET is missing required key $key"
    done
  fi
}

validate_rendered_phase() {
  local phase=$1 file=$2
  "${K[@]}" apply --dry-run=server -f "$file" -o json |
    node "$SCRIPT_DIR/verify-rendered-release.mjs" \
      --manifest "$MANIFEST" \
      --manifest-digest "$MANIFEST_DIGEST" \
      --environment "$ENVIRONMENT" \
      --phase "$phase" >/dev/null
}

metadata_matches() {
  local file=$1
  jq -e \
    --arg environment "$ENVIRONMENT" \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg builtAt "$built_at" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg webAssets "$web_asset_digest" '
      .schemaVersion == 1
      and .environment == $environment
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .builtAt == $builtAt
      and .releaseManifestDigest == $manifestDigest
      and .webAssetManifest == $webAssets
    ' "$file" >/dev/null 2>&1
}

reuse_completed_release() {
  local name expected desired ready public_version public_headers public_status
  local evidence_file workload actual_migrations internal_version
  REUSE_COMPLETED=0
  [[ -d "$release_directory" && ! -L "$release_directory" ]] || return 0
  for evidence_file in release.json release.sha256 migration-files.txt \
    web-asset-manifest.json foundation.yaml init.yaml migrate.yaml apps.yaml \
    traffic-evidence.json cleanup-evidence.json deploy-evidence.json SHA256SUMS; do
    [[ -f "$release_directory/$evidence_file" &&
      ! -L "$release_directory/$evidence_file" ]] || return 0
  done
  (
    cd "$release_directory"
    sha256sum --quiet -c SHA256SUMS
  ) || return 0
  cmp -s "$MANIFEST" "$release_directory/release.json" || return 0
  cmp -s "$MIGRATIONS" "$release_directory/migration-files.txt" || return 0
  cmp -s "$WEB_ASSETS" "$release_directory/web-asset-manifest.json" || return 0
  [[ "$(tr -d '\n' <"$release_directory/release.sha256")" == "$MANIFEST_DIGEST" ]] ||
    return 0
  jq -e \
    --arg environment "$ENVIRONMENT" \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg apiImage "$api_image" \
    --arg webService "${PREFIX}web" '
      .schemaVersion == 1
      and .status == "passed"
      and .environment == $environment
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and (.foundationMode == "fresh" or .foundationMode == "reused")
      and (.checks.freshFoundation | type == "boolean")
      and .checks.foundationReady == true
      and .checks.releaseStorage == true
      and .checks.minioInitialization == true
      and .checks.exactMigrations == true
      and .checks.applicationImages == true
      and .checks.publicTraffic == true
      and .checks.legacyCleanup == true
      and .cleanup.sourceSha == $sourceSha
      and .cleanup.verifiedAbsent == true
      and .migration.image == $apiImage
      and (.migration.completionTime | type == "string" and length > 0)
      and any(.traffic.units[]; .service == $webService)
      and any(.traffic.units[]; .service == "release-minio")
    ' "$release_directory/deploy-evidence.json" >/dev/null 2>&1 || return 0

  "${K[@]}" diff -f "$FOUNDATION_YAML" >/dev/null 2>&1 || return 0
  for workload in statefulset/release-postgres statefulset/release-redis-queue \
    statefulset/release-minio deployment/release-redis-hot; do
    "${K[@]}" -n "$NAMESPACE" rollout status "$workload" --timeout=30s \
      >/dev/null 2>&1 || return 0
  done
  validate_live_release_storage 2>/dev/null || return 0
  jq -e --slurpfile storage "$release_storage_evidence" '
    .storage == $storage[0]
  ' "$release_directory/deploy-evidence.json" >/dev/null 2>&1 || return 0
  for name in api worker runtime web; do
    case "$name" in
      api | worker) expected=$api_image ;;
      runtime) expected=$runtime_image ;;
      web) expected=$web_image ;;
    esac
    [[ "$("${K[@]}" -n "$NAMESPACE" get "deployment/${PREFIX}${name}" \
      -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null)" == "$expected" ]] ||
      return 0
    desired=$("${K[@]}" -n "$NAMESPACE" get "deployment/${PREFIX}${name}" \
      -o jsonpath='{.spec.replicas}' 2>/dev/null) || return 0
    ready=$("${K[@]}" -n "$NAMESPACE" get "deployment/${PREFIX}${name}" \
      -o jsonpath='{.status.readyReplicas}' 2>/dev/null) || return 0
    [[ "$desired" =~ ^[0-9]+$ && "$ready" == "$desired" ]] || return 0
    "${K[@]}" -n "$NAMESPACE" get pods \
      -l "combo.build/release-track=release-v1,app=${PREFIX}${name}" -o json 2>/dev/null |
      jq -e --arg image "$expected" --argjson desired "$desired" '
        [.items[] | select(.metadata.deletionTimestamp == null)] as $pods
        | ($pods | length) == $desired
        and all($pods[];
          (.status.containerStatuses | length) == 1
          and all(.status.containerStatuses[];
            .ready == true
            and ((.imageID | sub("^docker-pullable://"; "") | sub("^docker://"; "")) == $image)
          )
        )
      ' >/dev/null || return 0
  done
  local live_migrate_image
  if live_migrate_image=$("${K[@]}" -n "$NAMESPACE" get "job/${PREFIX}migrate" \
    -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null); then
    [[ "$live_migrate_image" == "$api_image" ]] || return 0
  fi
  actual_migrations="$work/reuse-migrations.txt"
  # Credentials are expanded only inside the PostgreSQL container.
  # shellcheck disable=SC2016
  "${K[@]}" -n "$NAMESPACE" exec release-postgres-0 -- sh -euc '
    export PGPASSWORD="$POSTGRES_PASSWORD"
    psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At \
      -c "SELECT filename FROM schema_migrations ORDER BY filename"
  ' >"$actual_migrations" 2>/dev/null || return 0
  cmp -s "$MIGRATIONS" "$actual_migrations" || return 0

  sudo -n systemctl is-active --quiet "$WEB_FORWARD_UNIT" || return 0
  sudo -n systemctl is-active --quiet "$MINIO_FORWARD_UNIT" || return 0
  sudo -n systemctl is-enabled --quiet "$WEB_FORWARD_UNIT" || return 0
  sudo -n systemctl is-enabled --quiet "$MINIO_FORWARD_UNIT" || return 0
  sudo -n grep -Fxq "COMBO_RELEASE_WEB_SERVICE=${PREFIX}web" "$WEB_FORWARD_ENV" ||
    return 0
  curl --fail --silent --show-error --max-time 15 \
    "http://127.0.0.1:${MINIO_FORWARD_PORT}/minio/health/ready" \
    >/dev/null 2>&1 || return 0
  curl --fail --silent --show-error --max-time 15 \
    "$S3_ORIGIN/minio/health/ready" >/dev/null 2>&1 || return 0
  internal_version="$work/reuse-internal-version.json"
  web_fetch http://127.0.0.1/version.json >"$internal_version" 2>/dev/null || return 0
  metadata_matches "$internal_version" || return 0

  if [[ "$ENVIRONMENT" == preview ]]; then
    curl --fail --silent --show-error --max-time 15 \
      "$PUBLIC_ORIGIN/__review/healthz" >/dev/null 2>&1 || return 0
    public_headers="$work/reuse-public-gate.headers"
    public_status=$(curl --silent --show-error --max-time 15 \
      --dump-header "$public_headers" --output /dev/null --write-out '%{http_code}' \
      "$PUBLIC_ORIGIN/version.json" 2>/dev/null) || return 0
    [[ "$public_status" == 401 ]] || return 0
    grep -Eqi '^X-Combo-Review-Gate:[[:space:]]*required' "$public_headers" || return 0
  else
    public_version="$work/reuse-public-version.json"
    curl --fail --silent --show-error --max-time 15 \
      "$PUBLIC_ORIGIN/version.json" >"$public_version" 2>/dev/null || return 0
    metadata_matches "$public_version" || return 0
  fi
  for name in "${LEGACY_DEPLOYMENTS[@]}"; do
    ! "${K[@]}" -n "$NAMESPACE" get "deployment/$name" >/dev/null 2>&1 || return 0
  done
  for name in "${LEGACY_STATEFULSETS[@]}"; do
    ! "${K[@]}" -n "$NAMESPACE" get "statefulset/$name" >/dev/null 2>&1 || return 0
  done
  for name in "${LEGACY_SERVICES[@]}"; do
    ! "${K[@]}" -n "$NAMESPACE" get "service/$name" >/dev/null 2>&1 || return 0
  done
  for name in "${LEGACY_JOBS[@]}"; do
    ! "${K[@]}" -n "$NAMESPACE" get "job/$name" >/dev/null 2>&1 || return 0
  done
  for name in "${LEGACY_CLAIMS[@]}"; do
    ! "${K[@]}" -n "$NAMESPACE" get "pvc/$name" >/dev/null 2>&1 || return 0
  done
  REUSE_COMPLETED=1
}

load_post_cut_checkpoint() {
  local created
  CHECKPOINT_PHASE=''
  [[ -e "$pending_checkpoint" ]] || return 0
  [[ -f "$pending_checkpoint" && ! -L "$pending_checkpoint" ]] ||
    fail 'post-cut checkpoint is not a regular file'
  jq -e \
    --arg environment "$ENVIRONMENT" \
    --arg namespace "$NAMESPACE" \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg webService "${PREFIX}web" '
      keys == [
        "environment",
        "foundationCreated",
        "manifestDigest",
        "namespace",
        "phase",
        "releaseId",
        "schemaVersion",
        "sourceSha",
        "trafficCutAt",
        "webService"
      ]
      and .schemaVersion == 2
      and .environment == $environment
      and .namespace == $namespace
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and .webService == $webService
      and (.foundationCreated | type == "boolean")
      and (.phase == "armed" or .phase == "post-cut")
      and (
        (.phase == "armed" and .trafficCutAt == null)
        or
        (.phase == "post-cut"
          and (.trafficCutAt | type == "string" and length > 0))
      )
    ' "$pending_checkpoint" >/dev/null ||
    fail 'another or invalid post-cut checkpoint requires recovery first'
  created=$(jq -r '.foundationCreated' "$pending_checkpoint")
  [[ "$created" == true || "$created" == false ]] ||
    fail 'post-cut checkpoint foundation mode is invalid'
  [[ "$created" == true ]] && FOUNDATION_CREATED_THIS_RELEASE=1 ||
    FOUNDATION_CREATED_THIS_RELEASE=0
  CHECKPOINT_PHASE=$(jq -er '.phase' "$pending_checkpoint")
}

write_release_checkpoint() {
  local phase=$1 checkpoint_stage created=false traffic_cut_at
  [[ "$phase" == armed || "$phase" == post-cut ]] ||
    fail 'invalid release checkpoint phase'
  ((FOUNDATION_CREATED_THIS_RELEASE == 0)) || created=true
  if [[ "$phase" == post-cut ]]; then
    traffic_cut_at=$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')
  else
    traffic_cut_at=''
  fi
  checkpoint_stage=$(mktemp "$EVIDENCE_ROOT/$ENVIRONMENT/.pending.XXXXXX")
  jq -n \
    --arg environment "$ENVIRONMENT" \
    --arg namespace "$NAMESPACE" \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg webService "${PREFIX}web" \
    --arg phase "$phase" \
    --arg trafficCutAt "$traffic_cut_at" \
    --argjson foundationCreated "$created" '{
      schemaVersion: 2,
      environment: $environment,
      namespace: $namespace,
      sourceSha: $sourceSha,
      releaseId: $releaseId,
      manifestDigest: $manifestDigest,
      webService: $webService,
      foundationCreated: $foundationCreated,
      phase: $phase,
      trafficCutAt: (if $phase == "post-cut" then $trafficCutAt else null end)
    }' >"$checkpoint_stage"
  chmod 0644 "$checkpoint_stage"
  mv -fT "$checkpoint_stage" "$pending_checkpoint"
  CHECKPOINT_PHASE=$phase
}

detect_live_traffic() {
  local old_web new_web old_minio new_minio active_source
  sudo -n test -f "$NGINX_CONFIG" || fail 'expected host Nginx config is missing'
  sudo -n test ! -L "$NGINX_CONFIG" || fail 'host Nginx config must not be a symlink'
  old_web=$(sudo -n grep -Ec \
    "proxy_pass http://127\\.0\\.0\\.1:${LEGACY_WEB_PORT};" "$NGINX_CONFIG" || true)
  new_web=$(sudo -n grep -Ec \
    "proxy_pass http://127\\.0\\.0\\.1:${WEB_FORWARD_PORT};" "$NGINX_CONFIG" || true)
  old_minio=$(sudo -n grep -Ec \
    "proxy_pass http://127\\.0\\.0\\.1:${LEGACY_MINIO_PORT};" "$NGINX_CONFIG" || true)
  new_minio=$(sudo -n grep -Ec \
    "proxy_pass http://127\\.0\\.0\\.1:${MINIO_FORWARD_PORT};" "$NGINX_CONFIG" || true)
  if ((old_web == LEGACY_WEB_PROXY_COUNT && new_web == 0 &&
    old_minio == 1 && new_minio == 0)); then
    TRAFFIC_MODE=legacy
    ACTIVE_RELEASE_WEB=''
    return
  fi
  if ((old_web == 0 && new_web == LEGACY_WEB_PROXY_COUNT &&
    old_minio == 0 && new_minio == 1)); then
    TRAFFIC_MODE=release
  else
    fail 'host Nginx has an ambiguous or partial release traffic route'
  fi
  sudo -n test -f "$WEB_FORWARD_ENV" ||
    fail 'release Web forward environment is missing'
  ACTIVE_RELEASE_WEB=$(sudo -n awk -F= '
    $1 == "COMBO_RELEASE_WEB_SERVICE" {print $2}
  ' "$WEB_FORWARD_ENV")
  [[ "$ACTIVE_RELEASE_WEB" =~ ^release-[0-9a-f]{12}-web$ ]] ||
    fail 'release Web forward target is invalid'
  active_source=$(jq -er --arg name "$ACTIVE_RELEASE_WEB" '
    first(.items[]
      | select(.metadata.name == $name)
      | .spec.template.metadata.annotations["combo.build/source-sha"])
  ' "$inventory_deployments") ||
    fail 'active release Web Deployment was not captured'
  [[ "$active_source" =~ $SHA_RE &&
    "release-${active_source:0:12}-web" == "$ACTIVE_RELEASE_WEB" ]] ||
    fail 'active release Web name and full source SHA disagree'
  jq -e --arg name "$ACTIVE_RELEASE_WEB" '
    any(.items[];
      .metadata.name == $name
      and .spec.selector.app == $name
      and .spec.selector["combo.build/release-track"] == "release-v1")
  ' "$inventory_services" >/dev/null ||
    fail 'active release Web Service selector is not isolated'
  if [[ "$ACTIVE_RELEASE_WEB" == "${PREFIX}web" ]]; then
    [[ "$CHECKPOINT_PHASE" == armed || "$CHECKPOINT_PHASE" == post-cut ]] ||
      fail 'the active candidate lacks a reusable valid evidence checkpoint'
    RESUME_POST_CUT=1
  fi
}

candidate_is_active_traffic() {
  local active old_web new_web
  sudo -n test -f "$NGINX_CONFIG" || return 1
  sudo -n test -f "$WEB_FORWARD_ENV" || return 1
  active=$(sudo -n awk -F= '
    $1 == "COMBO_RELEASE_WEB_SERVICE" {print $2}
  ' "$WEB_FORWARD_ENV" 2>/dev/null) || return 1
  [[ "$active" == "${PREFIX}web" ]] || return 1
  old_web=$(sudo -n grep -Ec \
    "proxy_pass http://127\\.0\\.0\\.1:${LEGACY_WEB_PORT};" "$NGINX_CONFIG" 2>/dev/null ||
    true)
  new_web=$(sudo -n grep -Ec \
    "proxy_pass http://127\\.0\\.0\\.1:${WEB_FORWARD_PORT};" "$NGINX_CONFIG" 2>/dev/null ||
    true)
  ((old_web == 0 && new_web == LEGACY_WEB_PROXY_COUNT))
}

validate_captured_release_ownership() {
  jq -e '
    . as $root
    | all(.items[] | select(.metadata.name | test("^combo-release-meta-[0-9a-f]{12}$"));
        .metadata.name as $name
        | .data.COMBO_SOURCE_SHA as $sha
        | ($sha | type == "string" and test("^[0-9a-f]{40}$"))
        and $name == ("combo-release-meta-" + $sha[0:12])
        and .data.COMBO_RELEASE_ID == ("release-" + $sha)
        and (.data.COMBO_RELEASE_MANIFEST_DIGEST | test("^sha256:[0-9a-f]{64}$"))
        and .metadata.labels["combo.build/release-metadata"] == "true")
    and all(.items[] | select(.metadata.name | test("^release-[0-9a-f]{12}-review-gate$"));
        .metadata.name as $name
        | ($name | capture("^release-(?<short>[0-9a-f]{12})-review-gate$")) as $parts
        | .metadata.labels["combo.build/release-track"] == "release-v1"
        and any($root.items[];
          .metadata.name == ("combo-release-meta-" + $parts.short)
          and .data.COMBO_SOURCE_SHA[0:12] == $parts.short))
  ' "$inventory_configmaps" >/dev/null ||
    fail 'captured release ConfigMap ownership is invalid'

  jq -e --arg track "$FOUNDATION_TRACK" '
    . as $root
    | all(.items[] | select(.metadata.name | test("^release-[0-9a-f]{12}-(api|runtime|web|worker)$"));
        .metadata.name as $name
        | ($name | capture("^release-(?<short>[0-9a-f]{12})-(?<component>api|runtime|web|worker)$")) as $parts
        | .spec.template.metadata.annotations["combo.build/source-sha"] as $sha
        | ($sha | type == "string" and test("^[0-9a-f]{40}$"))
        and $sha[0:12] == $parts.short
        and .spec.template.metadata.annotations["combo.build/release-id"] == ("release-" + $sha)
        and (.spec.template.metadata.annotations["combo.build/release-manifest-digest"]
          | test("^sha256:[0-9a-f]{64}$"))
        and .spec.selector.matchLabels == {
          app: $name,
          "combo.build/release-track": "release-v1"
        }
        and .spec.template.metadata.labels.app == $name
        and .spec.template.metadata.labels["combo.build/release-track"] == "release-v1")
    and all(.items[] | select(.metadata.name == "release-redis-hot");
        .metadata.labels["combo.build/environment-foundation"] == $track
        and .spec.selector.matchLabels == {
          app: "release-redis-hot",
          "combo.build/environment-foundation": $track
        })
  ' "$inventory_deployments" >/dev/null ||
    fail 'captured release Deployment ownership is invalid'

  jq -e --arg track "$FOUNDATION_TRACK" '
    all(.items[] | select(.metadata.name | test("^release-(postgres|redis-queue|minio)$"));
      .metadata.name as $name
      | .metadata.labels["combo.build/environment-foundation"] == $track
      and .spec.selector.matchLabels == {
        app: $name,
        "combo.build/environment-foundation": $track
      })
  ' "$inventory_statefulsets" >/dev/null ||
    fail 'captured release StatefulSet ownership is invalid'

  jq -e --arg track "$FOUNDATION_TRACK" --slurpfile configmaps "$inventory_configmaps" '
    . as $root
    | all(.items[] | select(.metadata.name | test("^release-[0-9a-f]{12}-(api|runtime|web)$"));
        .metadata.name as $name
        | ($name | capture("^release-(?<short>[0-9a-f]{12})-(?<component>api|runtime|web)$")) as $parts
        | .spec.selector == {
          app: $name,
          "combo.build/release-track": "release-v1"
        }
        and any($configmaps[0].items[];
          .metadata.name == ("combo-release-meta-" + $parts.short)
          and .data.COMBO_SOURCE_SHA[0:12] == $parts.short))
    and all(.items[] | select(.metadata.name | test("^release-(postgres|redis-queue|redis-hot|minio)$"));
        .metadata.name as $name
        | .metadata.labels["combo.build/environment-foundation"] == $track
        and .spec.selector == {
          app: $name,
          "combo.build/environment-foundation": $track
        })
  ' "$inventory_services" >/dev/null ||
    fail 'captured release Service ownership is invalid'

  jq -e --arg track "$FOUNDATION_TRACK" '
    all(.items[] | select(.metadata.name | test("^release-[0-9a-f]{12}-(migrate|minio-init)$"));
      .metadata.name as $name
      | ($name | capture("^release-(?<short>[0-9a-f]{12})-(?<component>migrate|minio-init)$")) as $parts
      | .spec.template.metadata.annotations["combo.build/source-sha"] as $sha
      | ($sha | type == "string" and test("^[0-9a-f]{40}$"))
      and $sha[0:12] == $parts.short
      and .spec.template.metadata.annotations["combo.build/release-id"] == ("release-" + $sha)
      and (if $parts.component == "migrate"
        then .spec.template.metadata.labels["combo.build/release-track"] == "release-v1"
        else .spec.template.metadata.labels["combo.build/environment-foundation"] == $track
        end))
    and all(.items[] | select(.metadata.name == "release-minio-init");
      .metadata.labels["combo.build/environment-foundation"] == $track)
  ' "$inventory_jobs" >/dev/null ||
    fail 'captured release Job ownership is invalid'

  jq -e --arg track "$FOUNDATION_TRACK" '
    all(.items[] | select(.metadata.name | test("^release-(redis-hot-config|redis-queue-config|minio-init-script)$"));
      .metadata.labels["combo.build/environment-foundation"] == $track)
  ' "$inventory_configmaps" >/dev/null ||
    fail 'captured release foundation ConfigMap ownership is invalid'
}

capture_inventory() {
  inventory_deployments="$work/deployments.json"
  inventory_statefulsets="$work/statefulsets.json"
  inventory_jobs="$work/jobs.json"
  inventory_services="$work/services.json"
  inventory_configmaps="$work/configmaps.json"
  inventory_pvcs="$work/pvcs.json"
  pvc_inventory="$work/pvcs.jsonl"

  "${K[@]}" -n "$NAMESPACE" get deployments -o json >"$inventory_deployments"
  "${K[@]}" -n "$NAMESPACE" get statefulsets -o json >"$inventory_statefulsets"
  "${K[@]}" -n "$NAMESPACE" get jobs -o json >"$inventory_jobs"
  "${K[@]}" -n "$NAMESPACE" get services -o json >"$inventory_services"
  "${K[@]}" -n "$NAMESPACE" get configmaps -o json >"$inventory_configmaps"
  "${K[@]}" -n "$NAMESPACE" get pvc -o json >"$inventory_pvcs"
  detect_live_traffic

  jq -e --arg allowed "$DEPLOYMENT_RE" '
    [.items[].metadata.name | select(test($allowed) | not)] | length == 0
  ' "$inventory_deployments" >/dev/null ||
    fail 'namespace contains an unapproved Deployment'
  jq -e '
    [.items[].metadata.name
      | select(test("^(postgres|redis-queue|minio|release-postgres|release-redis-queue|release-minio)$") | not)]
    | length == 0
  ' "$inventory_statefulsets" >/dev/null ||
    fail 'namespace contains an unapproved StatefulSet'
  jq -e '
    [.items[].metadata.name
      | select(test("^(migrate|minio-init|release-minio-init|release-[0-9a-f]{12}-(migrate|minio-init))$") | not)]
    | length == 0
  ' "$inventory_jobs" >/dev/null ||
    fail 'namespace contains an unapproved Job'
  jq -e '
    [.items[].metadata.name
      | select(test("^(api|runtime|web|postgres|redis-queue|redis-hot|minio|release-postgres|release-redis-queue|release-redis-hot|release-minio|release-[0-9a-f]{12}-(api|runtime|web))$") | not)]
    | length == 0
  ' "$inventory_services" >/dev/null ||
    fail 'namespace contains an unapproved Service'
  validate_captured_release_ownership

  local storage_root_real claim_json claim claim_uid volume pv_json reclaim path path_real
  storage_root_real=$(sudo -n realpath -e "$K3S_STORAGE_ROOT")
  : >"$pvc_inventory"
  while IFS= read -r claim; do
    [[ "$claim" =~ $PVC_RE ]] ||
      fail "namespace contains an unapproved PVC: $claim"
    claim_json=$(jq -ec --arg claim "$claim" '
      first(.items[] | select(.metadata.name == $claim))
    ' "$inventory_pvcs")
    claim_uid=$(jq -er '.metadata.uid' <<<"$claim_json")
    jq -e '
      .status.phase == "Bound"
      and .metadata.deletionTimestamp == null
      and .spec.storageClassName == "local-path"
      and .spec.accessModes == ["ReadWriteOnce"]
      and .spec.volumeMode == "Filesystem"
      and (.spec.volumeName | type == "string" and length > 0)
    ' <<<"$claim_json" >/dev/null ||
      fail "PVC $claim is not local-path"
    if [[ "$claim" =~ ^data-release- ]]; then
      jq -e --arg track "$FOUNDATION_TRACK" '
        .metadata.labels["combo.build/data-policy"] == "disposable"
        and .metadata.labels["combo.build/environment-foundation"] == $track
      ' <<<"$claim_json" >/dev/null ||
        fail "release PVC $claim lacks disposable foundation ownership"
    fi
    volume=$(jq -er '.spec.volumeName' <<<"$claim_json")
    [[ "$volume" == "pvc-$claim_uid" ]] ||
      fail "PVC $claim has an unexpected PV identity"
    pv_json=$("${K[@]}" get "pv/$volume" -o json)
    reclaim=$(jq -er '.spec.persistentVolumeReclaimPolicy' <<<"$pv_json")
    jq -e \
      --arg namespace "$NAMESPACE" \
      --arg claim "$claim" \
      --arg claimUid "$claim_uid" '
        .status.phase == "Bound"
        and .metadata.deletionTimestamp == null
        and .spec.storageClassName == "local-path"
        and .spec.accessModes == ["ReadWriteOnce"]
        and .spec.volumeMode == "Filesystem"
        and .spec.persistentVolumeReclaimPolicy == "Delete"
        and .spec.claimRef.namespace == $namespace
        and .spec.claimRef.name == $claim
        and .spec.claimRef.uid == $claimUid
        and (.spec.local.path | type == "string" and length > 1)
        and .spec.hostPath == null
      ' <<<"$pv_json" >/dev/null ||
      fail "PV $volume does not exactly bind disposable PVC $claim"
    [[ "$reclaim" == Delete ]] || fail "PV $volume does not have Delete reclaim policy"
    path=$(jq -er '.spec.local.path' <<<"$pv_json")
    path_real=$(sudo -n realpath -e "$path")
    [[ "$path_real" == "$storage_root_real/${volume}_${NAMESPACE}_${claim}" ]] ||
      fail "PV $volume does not use its exact dedicated K3s storage path"
    jq -cn \
      --arg claim "$claim" \
      --arg claimUid "$claim_uid" \
      --arg volume "$volume" \
      --arg volumeUid "$(jq -er '.metadata.uid' <<<"$pv_json")" \
      --arg path "$path_real" \
      '{claim: $claim, claimUid: $claimUid, volume: $volume, volumeUid: $volumeUid, path: $path}' \
      >>"$pvc_inventory"
  done < <(jq -r '.items[].metadata.name' "$inventory_pvcs" | sort)

  local legacy_stateful_count release_stateful_count legacy_claim_count=0
  local release_claim_count legacy_claim
  legacy_stateful_count=$(jq '[
    .items[].metadata.name | select(. == "postgres" or . == "redis-queue" or . == "minio")
  ] | length' "$inventory_statefulsets")
  release_stateful_count=$(jq '[
    .items[].metadata.name
    | select(. == "release-postgres" or . == "release-redis-queue" or . == "release-minio")
  ] | length' "$inventory_statefulsets")
  for legacy_claim in "${LEGACY_CLAIMS[@]}"; do
    if jq -e --arg claim "$legacy_claim" \
      'any(.items[]; .metadata.name == $claim)' "$inventory_pvcs" >/dev/null; then
      legacy_claim_count=$((legacy_claim_count + 1))
    fi
  done
  release_claim_count=$(jq '[
    .items[].metadata.name
    | select(. == "data-release-postgres-0"
      or . == "data-release-redis-queue-0"
      or . == "data-release-minio-0")
  ] | length' "$inventory_pvcs")
  case "$TRAFFIC_MODE" in
    legacy)
      if ((legacy_stateful_count == 3 && legacy_claim_count == 3)); then
        INITIAL_FRESH=1
      elif ((legacy_stateful_count == 0 && legacy_claim_count == 0 &&
        release_stateful_count == 0 && release_claim_count == 0)); then
        INITIAL_FRESH=1
      elif ((legacy_stateful_count == 0 && legacy_claim_count == 0 &&
        release_stateful_count == 3 && release_claim_count == 3)) &&
        [[ "$CHECKPOINT_PHASE" == armed || "$CHECKPOINT_PHASE" == post-cut ]]; then
        INITIAL_FRESH=0
      else
        fail 'legacy traffic does not have a complete legacy foundation'
      fi
      ;;
    release)
      ((release_stateful_count == 3 && release_claim_count == 3)) ||
        fail 'release traffic does not have a complete release foundation'
      INITIAL_FRESH=0
      ;;
    *) fail 'live traffic mode was not resolved' ;;
  esac
}

captured_uid() {
  local inventory=$1 name=$2
  jq -er --arg name "$name" \
    'first(.items[] | select(.metadata.name == $name) | .metadata.uid)' \
    "$inventory"
}

delete_captured_resource() {
  local kind=$1 inventory=$2 name=$3 timeout=$4 captured live live_uid
  local api_path plural delete_options removed=0
  captured=$(captured_uid "$inventory" "$name" 2>/dev/null) || return 0
  if ((RECORD_CLEANUP == 1)); then
    jq -n --arg kind "$kind" --arg name "$name" --arg uid "$captured" \
      '{kind: $kind, name: $name, uid: $uid}' >>"$cleanup_targets"
  fi
  if ! live=$("${K[@]}" -n "$NAMESPACE" get "$kind/$name" -o json 2>/dev/null); then
    return 0
  fi
  live_uid=$(jq -er '.metadata.uid' <<<"$live")
  [[ "$live_uid" == "$captured" ]] ||
    fail "$kind/$name was replaced after inventory capture"
  case "$kind" in
    deployment | statefulset)
      plural="${kind}s"
      api_path="/apis/apps/v1/namespaces/$NAMESPACE/$plural/$name"
      ;;
    job)
      api_path="/apis/batch/v1/namespaces/$NAMESPACE/jobs/$name"
      ;;
    service)
      api_path="/api/v1/namespaces/$NAMESPACE/services/$name"
      ;;
    configmap)
      api_path="/api/v1/namespaces/$NAMESPACE/configmaps/$name"
      ;;
    pvc)
      api_path="/api/v1/namespaces/$NAMESPACE/persistentvolumeclaims/$name"
      ;;
    *) fail "unsupported UID-safe delete kind: $kind" ;;
  esac
  delete_options="$work/delete-options-$kind-$name.json"
  jq -n --arg uid "$captured" '{
    apiVersion: "v1",
    kind: "DeleteOptions",
    propagationPolicy: "Foreground",
    preconditions: {uid: $uid}
  }' >"$delete_options"
  if ! "${K[@]}" delete --raw="$api_path" -f "$delete_options" >/dev/null 2>&1; then
    if ! live=$("${K[@]}" -n "$NAMESPACE" get "$kind/$name" -o json 2>/dev/null); then
      return 0
    fi
    live_uid=$(jq -er '.metadata.uid' <<<"$live")
    [[ "$live_uid" == "$captured" ]] ||
      fail "$kind/$name changed UID during its preconditioned delete"
    fail "UID-preconditioned delete failed for $kind/$name"
  fi
  for _ in $(seq 1 "${timeout%s}"); do
    if ! live=$("${K[@]}" -n "$NAMESPACE" get "$kind/$name" -o json 2>/dev/null); then
      removed=1
      break
    fi
    live_uid=$(jq -er '.metadata.uid' <<<"$live")
    [[ "$live_uid" == "$captured" ]] ||
      fail "$kind/$name was replaced while waiting for deletion"
    sleep 1
  done
  ((removed == 1)) || fail "timed out deleting captured $kind/$name"
}

scale_captured_resource() {
  local kind=$1 inventory=$2 name=$3 captured live live_uid resource_version
  captured=$(captured_uid "$inventory" "$name" 2>/dev/null) || return 0
  if ! live=$("${K[@]}" -n "$NAMESPACE" get "$kind/$name" -o json 2>/dev/null); then
    return 0
  fi
  live_uid=$(jq -er '.metadata.uid' <<<"$live")
  [[ "$live_uid" == "$captured" ]] ||
    fail "$kind/$name was replaced after inventory capture"
  resource_version=$(jq -er '.metadata.resourceVersion' <<<"$live")
  "${K[@]}" -n "$NAMESPACE" scale "$kind/$name" --replicas=0 \
    --resource-version="$resource_version" >/dev/null
}

delete_candidate_job() {
  local name=$1 live
  if ! live=$("${K[@]}" -n "$NAMESPACE" get "job/$name" -o json 2>/dev/null); then
    return 0
  fi
  jq -e --arg sourceSha "$source_sha" --arg releaseId "$release_id" '
    .spec.template.metadata.annotations["combo.build/source-sha"] == $sourceSha
    and .spec.template.metadata.annotations["combo.build/release-id"] == $releaseId
  ' <<<"$live" >/dev/null ||
    fail "refusing to fence Job/$name without the candidate identity"
  "${K[@]}" -n "$NAMESPACE" delete "job/$name" \
    --wait=true --timeout=120s >/dev/null
}

scale_candidate_deployment() {
  local name=$1 live resource_version
  if ! live=$("${K[@]}" -n "$NAMESPACE" get "deployment/$name" -o json 2>/dev/null); then
    return 0
  fi
  jq -e --arg sourceSha "$source_sha" --arg releaseId "$release_id" '
    .spec.template.metadata.annotations["combo.build/source-sha"] == $sourceSha
    and .spec.template.metadata.annotations["combo.build/release-id"] == $releaseId
  ' <<<"$live" >/dev/null ||
    fail "refusing to fence Deployment/$name without the candidate identity"
  resource_version=$(jq -er '.metadata.resourceVersion' <<<"$live")
  "${K[@]}" -n "$NAMESPACE" scale "deployment/$name" --replicas=0 \
    --resource-version="$resource_version" >/dev/null
}

wait_candidate_writers_fenced() {
  local name pods
  for _ in $(seq 1 60); do
    pods=0
    for name in api runtime web worker; do
      if "${K[@]}" -n "$NAMESPACE" get "deployment/${PREFIX}${name}" \
        >/dev/null 2>&1; then
        [[ "$("${K[@]}" -n "$NAMESPACE" get "deployment/${PREFIX}${name}" \
          -o jsonpath='{.spec.replicas}')" == 0 ]] || {
          pods=1
          continue
        }
      fi
      if [[ "$("${K[@]}" -n "$NAMESPACE" get pods \
        -l "combo.build/release-track=release-v1,app=${PREFIX}${name}" \
        -o json | jq '.items | length')" != 0 ]]; then
        pods=1
      fi
    done
    for name in "${PREFIX}migrate" "$INIT_JOB"; do
      if "${K[@]}" -n "$NAMESPACE" get "job/$name" >/dev/null 2>&1 ||
        [[ "$("${K[@]}" -n "$NAMESPACE" get pods -l "job-name=$name" \
          -o json | jq '.items | length')" != 0 ]]; then
        pods=1
      fi
    done
    ((pods != 0)) || return 0
    sleep 2
  done
  return 1
}

fence_writers() {
  local name failed=0
  status 'fencing only the isolated release candidate'
  delete_candidate_job "${PREFIX}migrate" || failed=1
  delete_candidate_job "$INIT_JOB" || failed=1
  for name in api runtime web worker; do
    scale_candidate_deployment "${PREFIX}${name}" || failed=1
  done
  wait_candidate_writers_fenced || failed=1
  ((failed == 0))
}

fence_captured_release_plane() {
  local name
  while IFS= read -r name; do
    [[ "$name" == release-minio-init ||
      "$name" =~ ^release-[0-9a-f]{12}-(migrate|minio-init)$ ]] || continue
    delete_captured_resource job "$inventory_jobs" "$name" 120s
  done < <(jq -r '.items[].metadata.name' "$inventory_jobs")
  while IFS= read -r name; do
    [[ "$name" == release-redis-hot ||
      "$name" =~ ^release-[0-9a-f]{12}-(api|runtime|web|worker)$ ]] || continue
    scale_captured_resource deployment "$inventory_deployments" "$name"
  done < <(jq -r '.items[].metadata.name' "$inventory_deployments")
  for name in "${RELEASE_STATEFULSETS[@]}"; do
    scale_captured_resource statefulset "$inventory_statefulsets" "$name"
  done
}

wait_for_removed_storage() {
  local scope=$1 claim volume path removed
  while IFS= read -r row; do
    claim=$(jq -r '.claim' <<<"$row")
    case "$scope" in
      release)
        [[ " ${RELEASE_CLAIMS[*]} " == *" $claim "* ]] || continue
        ;;
      legacy)
        [[ " ${LEGACY_CLAIMS[*]} " == *" $claim "* ]] || continue
        ;;
      *) return 2 ;;
    esac
    volume=$(jq -r '.volume' <<<"$row")
    path=$(jq -r '.path' <<<"$row")
    removed=0
    for _ in $(seq 1 90); do
      if ! "${K[@]}" get "pv/$volume" >/dev/null 2>&1 &&
        ! sudo -n test -e "$path"; then
        removed=1
        break
      fi
      sleep 2
    done
    ((removed == 1)) ||
      fail "local-path provisioner did not remove exact PV storage $volume"
  done <"$pvc_inventory"
}

validate_live_release_storage() {
  local storage_root_real claim claim_json claim_uid volume pv_json path path_real
  local rows="$work/release-storage.jsonl"
  release_storage_evidence="$work/release-storage-evidence.json"
  storage_root_real=$(sudo -n realpath -e "$K3S_STORAGE_ROOT")
  : >"$rows"

  "${K[@]}" -n "$NAMESPACE" get pvc -o json |
    jq -e --argjson expected "$(printf '%s\n' "${RELEASE_CLAIMS[@]}" |
      jq -R . | jq -s 'sort')" '
      [.items[].metadata.name | select(startswith("data-release-"))] | sort
      == $expected
    ' >/dev/null || fail 'release foundation has an unexpected PVC set'

  for claim in "${RELEASE_CLAIMS[@]}"; do
    claim_json=$("${K[@]}" -n "$NAMESPACE" get "pvc/$claim" -o json)
    claim_uid=$(jq -er '.metadata.uid' <<<"$claim_json")
    jq -e --arg track "$FOUNDATION_TRACK" '
      .status.phase == "Bound"
      and .metadata.deletionTimestamp == null
      and .metadata.labels["combo.build/data-policy"] == "disposable"
      and .metadata.labels["combo.build/environment-foundation"] == $track
      and .spec.storageClassName == "local-path"
      and .spec.accessModes == ["ReadWriteOnce"]
      and .spec.volumeMode == "Filesystem"
      and (.spec.volumeName | type == "string" and length > 0)
    ' <<<"$claim_json" >/dev/null ||
      fail "release PVC $claim is not an exact disposable local-path claim"
    volume=$(jq -er '.spec.volumeName' <<<"$claim_json")
    [[ "$volume" == "pvc-$claim_uid" ]] ||
      fail "release PVC $claim has an unexpected PV identity"
    pv_json=$("${K[@]}" get "pv/$volume" -o json)
    jq -e \
      --arg namespace "$NAMESPACE" \
      --arg claim "$claim" \
      --arg claimUid "$claim_uid" '
        .status.phase == "Bound"
        and .metadata.deletionTimestamp == null
        and .spec.storageClassName == "local-path"
        and .spec.accessModes == ["ReadWriteOnce"]
        and .spec.volumeMode == "Filesystem"
        and .spec.persistentVolumeReclaimPolicy == "Delete"
        and .spec.claimRef.namespace == $namespace
        and .spec.claimRef.name == $claim
        and .spec.claimRef.uid == $claimUid
        and (.spec.local.path | type == "string" and length > 1)
        and .spec.hostPath == null
      ' <<<"$pv_json" >/dev/null ||
      fail "release PV $volume does not exactly bind disposable PVC $claim"
    path=$(jq -er '.spec.local.path' <<<"$pv_json")
    path_real=$(sudo -n realpath -e "$path")
    [[ "$path_real" == "$storage_root_real/${volume}_${NAMESPACE}_${claim}" ]] ||
      fail "release PV $volume does not use its exact dedicated K3s storage path"
    jq -n \
      --arg claim "$claim" \
      --arg claimUid "$claim_uid" \
      --arg volume "$volume" \
      --arg volumeUid "$(jq -er '.metadata.uid' <<<"$pv_json")" \
      --arg path "$path_real" '{
        claim: $claim,
        claimUid: $claimUid,
        volume: $volume,
        volumeUid: $volumeUid,
        path: $path,
        storageClass: "local-path",
        accessMode: "ReadWriteOnce",
        volumeMode: "Filesystem",
        reclaimPolicy: "Delete"
      }' >>"$rows"
  done

  jq -s \
    --arg environment "$ENVIRONMENT" \
    --arg namespace "$NAMESPACE" \
    --arg sourceSha "$source_sha" '{
      schemaVersion: 1,
      environment: $environment,
      namespace: $namespace,
      sourceSha: $sourceSha,
      claims: sort_by(.claim),
      verified: true
    }' "$rows" >"$release_storage_evidence"
}

fresh_reset_release_data() {
  local name
  local release_foundation=(release-postgres release-redis-queue release-redis-hot release-minio)
  local release_claims=(
    data-release-postgres-0
    data-release-redis-queue-0
    data-release-minio-0
  )
  local business_names=(api worker runtime web)
  : "${release_foundation[*]}${business_names[*]}"

  if ((INITIAL_FRESH == 0)); then
    status 'reusing the verified release PostgreSQL, Redis, and MinIO foundation'
    return
  fi

  status 'clearing only a captured, isolated release foundation before its first build'
  fence_captured_release_plane

  while IFS= read -r name; do
    if [[ "$name" =~ ^release-[0-9a-f]{12}-(api|runtime|web|worker)$ ]]; then
      delete_captured_resource deployment "$inventory_deployments" "$name" 180s
    fi
  done < <(jq -r '.items[].metadata.name' "$inventory_deployments")
  while IFS= read -r name; do
    if [[ "$name" =~ ^release-[0-9a-f]{12}-(api|runtime|web)$ ]]; then
      delete_captured_resource service "$inventory_services" "$name" 120s
    fi
  done < <(jq -r '.items[].metadata.name' "$inventory_services")

  delete_captured_resource deployment "$inventory_deployments" release-redis-hot 180s
  for name in "${RELEASE_STATEFULSETS[@]}"; do
    delete_captured_resource statefulset "$inventory_statefulsets" "$name" 180s
  done
  for name in "${RELEASE_SERVICES[@]}"; do
    delete_captured_resource service "$inventory_services" "$name" 120s
  done
  for name in "${RELEASE_CONFIGMAPS[@]}"; do
    delete_captured_resource configmap "$inventory_configmaps" "$name" 120s
  done

  while IFS= read -r name; do
    [[ "$name" =~ ^combo-release-meta-[0-9a-f]{12}$ ||
      "$name" =~ ^release-[0-9a-f]{12}-review-gate$ ]] || continue
    delete_captured_resource configmap "$inventory_configmaps" "$name" 120s
  done < <(jq -r '.items[].metadata.name' "$inventory_configmaps")

  for name in "${release_claims[@]}"; do
    delete_captured_resource pvc "$inventory_pvcs" "$name" 180s
  done
  wait_for_removed_storage release
}

apply_release_metadata() {
  "${K[@]}" -n "$NAMESPACE" create configmap "$metadata_name" \
    --from-literal=COMBO_ENVIRONMENT="$ENVIRONMENT" \
    --from-literal=COMBO_SOURCE_SHA="$source_sha" \
    --from-literal=COMBO_RELEASE_ID="$release_id" \
    --from-literal=COMBO_BUILT_AT="$built_at" \
    --from-literal=COMBO_RELEASE_MANIFEST_DIGEST="$MANIFEST_DIGEST" \
    --from-literal=COMBO_WEB_ASSET_MANIFEST="$web_asset_digest" \
    --from-literal=EXPECTED_MIGRATION_HEAD="$migration_head" \
    --dry-run=client -o json |
    jq \
      --arg sourceSha "$source_sha" \
      --arg releaseId "$release_id" \
      --arg digest "$MANIFEST_DIGEST" '
        .immutable = true
        | .metadata.labels["combo.build/release-metadata"] = "true"
        | .metadata.annotations["combo.build/source-sha"] = $sourceSha
        | .metadata.annotations["combo.build/release-id"] = $releaseId
        | .metadata.annotations["combo.build/release-manifest-digest"] = $digest
      ' |
    "${K[@]}" apply -f - >/dev/null
}

apply_foundation() {
  local workload
  if ((INITIAL_FRESH == 1)); then
    status 'creating fresh PostgreSQL, Redis, and MinIO'
    "${K[@]}" apply -f "$FOUNDATION_YAML" >/dev/null
  else
    status 'verifying the unchanged shared release foundation'
    "${K[@]}" diff -f "$FOUNDATION_YAML" >/dev/null ||
      fail 'the reusable release foundation drifted from its allowlisted manifest'
  fi
  for workload in statefulset/release-postgres statefulset/release-redis-queue \
    statefulset/release-minio deployment/release-redis-hot; do
    "${K[@]}" -n "$NAMESPACE" rollout status "$workload" --timeout=600s
  done
  validate_live_release_storage

  delete_candidate_job "$INIT_JOB"
  "${K[@]}" apply -f "$INIT_YAML" >/dev/null
  if ! "${K[@]}" -n "$NAMESPACE" wait --for=condition=complete \
    "job/$INIT_JOB" --timeout=300s; then
    "${K[@]}" -n "$NAMESPACE" logs "job/$INIT_JOB" --tail=200 >&2 || true
    fail 'bucket initialization and synthetic object smoke failed'
  fi
}

run_migration() {
  status 'running the exact 0000 through 0006 migration set'
  delete_candidate_job "${PREFIX}migrate"
  "${K[@]}" apply -f "$MIGRATE_YAML" >/dev/null
  if ! "${K[@]}" -n "$NAMESPACE" wait --for=condition=complete \
    "job/${PREFIX}migrate" --timeout=600s; then
    "${K[@]}" -n "$NAMESPACE" logs "job/${PREFIX}migrate" --tail=200 >&2 || true
    fail 'migration failed; business manifests were not applied'
  fi

  local actual_migrations="$work/actual-migrations.txt"
  # Credentials are expanded only inside the PostgreSQL container.
  # shellcheck disable=SC2016
  "${K[@]}" -n "$NAMESPACE" exec release-postgres-0 -- sh -euc '
    export PGPASSWORD="$POSTGRES_PASSWORD"
    psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At \
      -c "SELECT filename FROM schema_migrations ORDER BY filename"
  ' >"$actual_migrations"
  cmp -s "$MIGRATIONS" "$actual_migrations" ||
    fail 'fresh database migration ledger differs from 0000 through 0006'

  [[ "$("${K[@]}" -n "$NAMESPACE" get "job/${PREFIX}migrate" \
    -o jsonpath='{.spec.template.spec.containers[0].image}')" == "$api_image" ]] ||
    fail 'migration Job does not use the release API image'
  "${K[@]}" -n "$NAMESPACE" get pods -l "job-name=${PREFIX}migrate" -o json |
    jq -e --arg image "$api_image" '
      [.items[]
        | select(.status.containerStatuses != null)
        | .status.containerStatuses[]
        | select(.state.terminated.exitCode == 0)
        | (.imageID | sub("^docker-pullable://"; "") | sub("^docker://"; ""))]
      | length >= 1 and all(. == $image)
    ' >/dev/null || fail 'migration Pod digest or completion evidence is invalid'
}

assert_release_metadata() {
  local file=$1 label=$2
  metadata_matches "$file" || fail "$label does not identify the release"
}

expected_image() {
  case "$1" in
    api | worker) printf '%s' "$api_image" ;;
    runtime) printf '%s' "$runtime_image" ;;
    web) printf '%s' "$web_image" ;;
  esac
}

web_fetch() {
  local url=$1
  if [[ "$ENVIRONMENT" == preview ]]; then
    # The token expands only inside the Web container and is never returned.
    # shellcheck disable=SC2016
    "${K[@]}" -n "$NAMESPACE" exec "deployment/${PREFIX}web" -- \
      sh -euc 'exec wget --header="Cookie: combo_review_access=$REVIEW_ACCESS_TOKEN" -qO- "$1"' \
      sh "$url"
  else
    "${K[@]}" -n "$NAMESPACE" exec "deployment/${PREFIX}web" -- \
      wget -qO- "$url"
  fi
}

apply_apps() {
  local name expected desired verified output endpoint
  status 'applying API, Worker, Runtime, and Web after migration'
  "${K[@]}" apply -f "$APPS_YAML" >/dev/null
  for name in api worker runtime web; do
    "${K[@]}" -n "$NAMESPACE" rollout status "deployment/${PREFIX}${name}" \
      --timeout=600s || fail "release ${name} rollout failed"
    expected=$(expected_image "$name")
    [[ "$("${K[@]}" -n "$NAMESPACE" get "deployment/${PREFIX}${name}" \
      -o jsonpath='{.spec.template.spec.containers[0].image}')" == "$expected" ]] ||
      fail "Deployment ${PREFIX}${name} does not use the release image"
    desired=$("${K[@]}" -n "$NAMESPACE" get "deployment/${PREFIX}${name}" \
      -o jsonpath='{.spec.replicas}')
    verified=0
    for _ in $(seq 1 60); do
      if "${K[@]}" -n "$NAMESPACE" get pods \
        -l "combo.build/release-track=release-v1,app=${PREFIX}${name}" -o json |
        jq -e --arg image "$expected" --argjson desired "$desired" '
          [.items[] | select(.metadata.deletionTimestamp == null)] as $pods
          | ($pods | length) == $desired
          and all($pods[];
            (.status.containerStatuses | length) == 1
            and all(.status.containerStatuses[];
              .ready == true
              and ((.imageID | sub("^docker-pullable://"; "") | sub("^docker://"; "")) == $image)
            )
          )
        ' >/dev/null; then
        verified=1
        break
      fi
      sleep 2
    done
    ((verified == 1)) || fail "live ${name} Pods do not use the immutable release digest"
  done

  for endpoint in version.json runtime-config.json try/runtime-config.json \
    api/v1/version api/v1/runtime/version; do
    output="$work/$(tr '/' '-' <<<"$endpoint").json"
    web_fetch "http://127.0.0.1/$endpoint" >"$output"
    assert_release_metadata "$output" "live $endpoint"
  done
  web_fetch http://127.0.0.1/health >/dev/null
  web_fetch http://127.0.0.1/ready >/dev/null

  local live_web_asset_digest
  live_web_asset_digest=$("${K[@]}" -n "$NAMESPACE" exec "deployment/${PREFIX}web" -- \
    sha256sum /usr/share/nginx/html/web-asset-manifest.json | awk '{print "sha256:" $1}')
  [[ "$live_web_asset_digest" == "$web_asset_digest" ]] ||
    fail 'live Web asset manifest digest differs from the release'

  local asset_path
  asset_path=$(jq -er '
    first(.assets[] | select(.application == "web" and (.path | startswith("assets/"))) | .path)
  ' "$WEB_ASSETS")
  web_fetch "http://127.0.0.1/$asset_path" >/dev/null
  if web_fetch http://127.0.0.1/assets/combo-missing-deadbeef.js >/dev/null; then
    fail 'a missing hashed Web asset returned success'
  fi
}

switch_release_traffic() {
  traffic_evidence="$work/traffic-evidence.json"
  "$SCRIPT_DIR/switch-release-traffic.sh" \
    --environment "$ENVIRONMENT" \
    --manifest "$MANIFEST" \
    --manifest-digest "$MANIFEST_DIGEST" \
    --evidence-output "$traffic_evidence"
}

cleanup_legacy() {
  local name
  cleanup_targets="$work/cleanup-targets.jsonl"
  cleanup_evidence="$work/cleanup-evidence.json"
  : >"$cleanup_targets"
  RECORD_CLEANUP=1
  status 'removing only captured superseded resources after successful traffic cutover'
  for name in "${LEGACY_JOBS[@]}"; do
    delete_captured_resource job "$inventory_jobs" "$name" 120s
  done
  for name in "${LEGACY_DEPLOYMENTS[@]}"; do
    scale_captured_resource deployment "$inventory_deployments" "$name"
  done
  for name in "${LEGACY_STATEFULSETS[@]}"; do
    scale_captured_resource statefulset "$inventory_statefulsets" "$name"
  done
  for name in "${LEGACY_DEPLOYMENTS[@]}"; do
    delete_captured_resource deployment "$inventory_deployments" "$name" 180s
  done
  for name in "${LEGACY_STATEFULSETS[@]}"; do
    delete_captured_resource statefulset "$inventory_statefulsets" "$name" 180s
  done
  for name in "${LEGACY_SERVICES[@]}"; do
    delete_captured_resource service "$inventory_services" "$name" 120s
  done
  for name in "${LEGACY_CONFIGMAPS[@]}"; do
    delete_captured_resource configmap "$inventory_configmaps" "$name" 120s
  done
  for name in "${LEGACY_CLAIMS[@]}"; do
    delete_captured_resource pvc "$inventory_pvcs" "$name" 180s
  done
  wait_for_removed_storage legacy

  while IFS= read -r name; do
    [[ "$name" =~ ^release-[0-9a-f]{12}-(migrate|minio-init)$ ||
      "$name" == release-minio-init ]] || continue
    [[ "$name" == "${PREFIX}migrate" || "$name" == "$INIT_JOB" ]] && continue
    delete_captured_resource job "$inventory_jobs" "$name" 120s
  done < <(jq -r '.items[].metadata.name' "$inventory_jobs")
  while IFS= read -r name; do
    [[ "$name" =~ ^release-[0-9a-f]{12}-(api|runtime|web|worker)$ ]] || continue
    [[ "$name" == "${PREFIX}api" || "$name" == "${PREFIX}runtime" ||
      "$name" == "${PREFIX}web" || "$name" == "${PREFIX}worker" ]] && continue
    scale_captured_resource deployment "$inventory_deployments" "$name"
    delete_captured_resource deployment "$inventory_deployments" "$name" 180s
  done < <(jq -r '.items[].metadata.name' "$inventory_deployments")
  while IFS= read -r name; do
    [[ "$name" =~ ^release-[0-9a-f]{12}-(api|runtime|web)$ ]] || continue
    [[ "$name" == "${PREFIX}api" || "$name" == "${PREFIX}runtime" ||
      "$name" == "${PREFIX}web" ]] && continue
    delete_captured_resource service "$inventory_services" "$name" 120s
  done < <(jq -r '.items[].metadata.name' "$inventory_services")
  while IFS= read -r name; do
    [[ "$name" =~ ^combo-release-meta-[0-9a-f]{12}$ ||
      "$name" =~ ^release-[0-9a-f]{12}-review-gate$ ]] || continue
    [[ "$name" == "$metadata_name" ||
      "$name" == "${PREFIX}review-gate" ]] && continue
    delete_captured_resource configmap "$inventory_configmaps" "$name" 120s
  done < <(jq -r '.items[].metadata.name' "$inventory_configmaps")

  for name in "${LEGACY_DEPLOYMENTS[@]}"; do
    ! "${K[@]}" -n "$NAMESPACE" get "deployment/$name" >/dev/null 2>&1 ||
      fail "legacy Deployment $name remains after cleanup"
  done
  for name in "${LEGACY_STATEFULSETS[@]}"; do
    ! "${K[@]}" -n "$NAMESPACE" get "statefulset/$name" >/dev/null 2>&1 ||
      fail "legacy StatefulSet $name remains after cleanup"
  done
  for name in "${LEGACY_SERVICES[@]}"; do
    ! "${K[@]}" -n "$NAMESPACE" get "service/$name" >/dev/null 2>&1 ||
      fail "legacy Service $name remains after cleanup"
  done
  for name in "${LEGACY_JOBS[@]}"; do
    ! "${K[@]}" -n "$NAMESPACE" get "job/$name" >/dev/null 2>&1 ||
      fail "legacy Job $name remains after cleanup"
  done
  for name in "${LEGACY_CONFIGMAPS[@]}"; do
    ! "${K[@]}" -n "$NAMESPACE" get "configmap/$name" >/dev/null 2>&1 ||
      fail "legacy ConfigMap $name remains after cleanup"
  done
  for name in "${LEGACY_CLAIMS[@]}"; do
    ! "${K[@]}" -n "$NAMESPACE" get "pvc/$name" >/dev/null 2>&1 ||
      fail "legacy PVC $name remains after cleanup"
  done
  "${K[@]}" -n "$NAMESPACE" get deployments -o json |
    jq -e --arg prefix "$PREFIX" '
      [.items[].metadata.name
        | select(test("^release-[0-9a-f]{12}-(api|runtime|web|worker)$"))
        | select(startswith($prefix) | not)]
      | length == 0
    ' >/dev/null || fail 'a previous release Deployment remains after cleanup'
  "${K[@]}" -n "$NAMESPACE" get services -o json |
    jq -e --arg prefix "$PREFIX" '
      [.items[].metadata.name
        | select(test("^release-[0-9a-f]{12}-(api|runtime|web)$"))
        | select(startswith($prefix) | not)]
      | length == 0
    ' >/dev/null || fail 'a previous release Service remains after cleanup'
  "${K[@]}" -n "$NAMESPACE" get jobs -o json |
    jq -e --arg migrate "${PREFIX}migrate" --arg init "$INIT_JOB" '
      [.items[].metadata.name
        | select(. == "release-minio-init"
          or test("^release-[0-9a-f]{12}-(migrate|minio-init)$"))
        | select(. != $migrate and . != $init)]
      | length == 0
    ' >/dev/null || fail 'a previous release Job remains after cleanup'
  "${K[@]}" -n "$NAMESPACE" get configmaps -o json |
    jq -e --arg metadata "$metadata_name" --arg gate "${PREFIX}review-gate" '
      [.items[].metadata.name
        | select(test("^combo-release-meta-[0-9a-f]{12}$")
          or test("^release-[0-9a-f]{12}-review-gate$"))
        | select(. != $metadata and . != $gate)]
      | length == 0
    ' >/dev/null || fail 'a previous release ConfigMap remains after cleanup'

  RECORD_CLEANUP=0
  jq -s \
    --arg environment "$ENVIRONMENT" \
    --arg namespace "$NAMESPACE" \
    --arg sourceSha "$source_sha" \
    --slurpfile capturedStorage "$pvc_inventory" '
      {
        schemaVersion: 1,
        environment: $environment,
        namespace: $namespace,
        sourceSha: $sourceSha,
        targets: (unique_by([.kind, .name])),
        capturedStorage: $capturedStorage,
        verifiedAbsent: true
      }
    ' "$cleanup_targets" >"$cleanup_evidence"
}

write_release_evidence() {
  local stage deployments_json migration_json foundation_json init_json
  local foundation_mode fresh_foundation
  [[ -f "$cleanup_evidence" && ! -L "$cleanup_evidence" ]] ||
    fail 'cleanup evidence is missing'
  [[ -f "$release_storage_evidence" && ! -L "$release_storage_evidence" ]] ||
    fail 'release storage evidence is missing'
  stage=$(mktemp -d "$EVIDENCE_ROOT/$ENVIRONMENT/.${release_id}.XXXXXX")
  install -m 0644 "$MANIFEST" "$stage/release.json"
  install -m 0644 "$MIGRATIONS" "$stage/migration-files.txt"
  install -m 0644 "$WEB_ASSETS" "$stage/web-asset-manifest.json"
  install -m 0644 "$FOUNDATION_YAML" "$stage/foundation.yaml"
  install -m 0644 "$INIT_YAML" "$stage/init.yaml"
  install -m 0644 "$MIGRATE_YAML" "$stage/migrate.yaml"
  install -m 0644 "$APPS_YAML" "$stage/apps.yaml"
  install -m 0644 "$traffic_evidence" "$stage/traffic-evidence.json"
  install -m 0644 "$cleanup_evidence" "$stage/cleanup-evidence.json"
  printf '%s\n' "$MANIFEST_DIGEST" >"$stage/release.sha256"
  chmod 0644 "$stage/release.sha256"

  deployments_json=$("${K[@]}" -n "$NAMESPACE" get \
    "deployment/${PREFIX}api" "deployment/${PREFIX}worker" \
    "deployment/${PREFIX}runtime" "deployment/${PREFIX}web" -o json |
    jq '[.items[] | {
      name: .metadata.name,
      generation: .metadata.generation,
      observedGeneration: .status.observedGeneration,
      replicas: .status.replicas,
      readyReplicas: .status.readyReplicas,
      image: .spec.template.spec.containers[0].image
    }] | sort_by(.name)')
  migration_json=$("${K[@]}" -n "$NAMESPACE" get "job/${PREFIX}migrate" -o json |
    jq '{
      name: .metadata.name,
      uid: .metadata.uid,
      image: .spec.template.spec.containers[0].image,
      completionTime: .status.completionTime
    }')
  foundation_json=$("${K[@]}" -n "$NAMESPACE" get \
    deployment/release-redis-hot statefulset/release-postgres \
    statefulset/release-redis-queue statefulset/release-minio -o json |
    jq '[.items[] | {
      kind: .kind,
      name: .metadata.name,
      uid: .metadata.uid,
      generation: .metadata.generation,
      observedGeneration: .status.observedGeneration,
      replicas: .status.replicas,
      readyReplicas: .status.readyReplicas,
      image: .spec.template.spec.containers[0].image
    }] | sort_by([.kind, .name])')
  init_json=$("${K[@]}" -n "$NAMESPACE" get "job/$INIT_JOB" -o json |
    jq '{
      name: .metadata.name,
      uid: .metadata.uid,
      image: .spec.template.spec.containers[0].image,
      completionTime: .status.completionTime
    }')
  if ((FOUNDATION_CREATED_THIS_RELEASE == 1)); then
    foundation_mode=fresh
    fresh_foundation=true
  else
    foundation_mode=reused
    fresh_foundation=false
  fi
  jq -n \
    --arg environment "$ENVIRONMENT" \
    --arg namespace "$NAMESPACE" \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg foundationMode "$foundation_mode" \
    --arg completedAt "$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')" \
    --argjson freshFoundation "$fresh_foundation" \
    --argjson deployments "$deployments_json" \
    --argjson migration "$migration_json" \
    --argjson foundation "$foundation_json" \
    --argjson init "$init_json" \
    --slurpfile storage "$release_storage_evidence" \
    --slurpfile traffic "$traffic_evidence" \
    --slurpfile cleanup "$cleanup_evidence" '{
      schemaVersion: 1,
      status: "passed",
      environment: $environment,
      namespace: $namespace,
      sourceSha: $sourceSha,
      releaseId: $releaseId,
      manifestDigest: $manifestDigest,
      foundationMode: $foundationMode,
      foundation: $foundation,
      storage: $storage[0],
      initialization: $init,
      deployments: $deployments,
      migration: $migration,
      traffic: $traffic[0],
      cleanup: $cleanup[0],
      checks: {
        freshFoundation: $freshFoundation,
        foundationReady: true,
        releaseStorage: true,
        minioInitialization: true,
        exactMigrations: true,
        applicationImages: true,
        publicTraffic: true,
        legacyCleanup: true
      },
      completedAt: $completedAt
    }' >"$stage/deploy-evidence.json"
  chmod 0644 "$stage/deploy-evidence.json"
  (
    cd "$stage"
    sha256sum release.json release.sha256 migration-files.txt web-asset-manifest.json \
      foundation.yaml init.yaml migrate.yaml apps.yaml traffic-evidence.json \
      cleanup-evidence.json deploy-evidence.json >SHA256SUMS
  )
  chmod 0644 "$stage/SHA256SUMS"
  [[ ! -e "$release_directory" ]] || fail 'release evidence directory already exists'
  mv "$stage" "$release_directory"

  finalize_release_commit 1
}

write_current_checkpoint() {
  local checkpoint_stage
  checkpoint_stage=$(mktemp "$EVIDENCE_ROOT/$ENVIRONMENT/.current.XXXXXX")
  jq -n \
    --arg environment "$ENVIRONMENT" \
    --arg namespace "$NAMESPACE" \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg evidencePath "$release_directory" '{
      schemaVersion: 1,
      status: "passed",
      environment: $environment,
      namespace: $namespace,
      sourceSha: $sourceSha,
      releaseId: $releaseId,
      manifestDigest: $manifestDigest,
      evidencePath: $evidencePath
    }' >"$checkpoint_stage"
  chmod 0644 "$checkpoint_stage"
  mv -fT "$checkpoint_stage" "$EVIDENCE_ROOT/$ENVIRONMENT/current.json"
}

finalize_release_commit() {
  local require_pending=${1:-0}
  if ((require_pending == 1)); then
    [[ -e "$pending_checkpoint" ]] ||
      fail 'release checkpoint is missing before evidence commit'
  fi
  if [[ -e "$pending_checkpoint" ]]; then
    load_post_cut_checkpoint
  fi
  write_current_checkpoint
  if [[ -e "$pending_checkpoint" ]]; then
    load_post_cut_checkpoint
    rm -f -- "$pending_checkpoint"
    CHECKPOINT_PHASE=''
  fi
}

on_exit() {
  local rc=$?
  trap - EXIT
  if ((rc != 0 && mutation_started == 1 && deployment_succeeded == 0 &&
    traffic_cut_succeeded == 0)); then
    if candidate_is_active_traffic; then
      status 'candidate is already active; skipping failure fence'
    elif ! fence_writers; then
      status 'candidate failure fence was incomplete; manual recovery is required'
    fi
  fi
  [[ -z "$work" ]] || rm -rf -- "$work"
  exit "$rc"
}
trap on_exit EXIT

validate_inputs
install -d -m 0750 "$EVIDENCE_ROOT" "$EVIDENCE_ROOT/$ENVIRONMENT"
install -d -m 0750 "$(dirname "$MUTATION_LOCK")"
exec 9>"$MUTATION_LOCK"
flock -n 9 || fail 'another environment mutation is running'

"${K[@]}" get namespace "$NAMESPACE" >/dev/null
validate_secret_keys
status 'server-side validating and allowlisting every rendered phase'
validate_rendered_phase foundation "$FOUNDATION_YAML"
validate_rendered_phase init "$INIT_YAML"
validate_rendered_phase migrate "$MIGRATE_YAML"
validate_rendered_phase apps "$APPS_YAML"

work=$(mktemp -d)
release_directory="$EVIDENCE_ROOT/$ENVIRONMENT/$release_id"
pending_checkpoint="$EVIDENCE_ROOT/$ENVIRONMENT/pending.json"
reuse_completed_release
if ((REUSE_COMPLETED == 1)); then
  finalize_release_commit 0
  status "$ENVIRONMENT already runs the verified $release_id"
  exit 0
fi
[[ ! -e "$release_directory" ]] ||
  fail 'existing release evidence is incomplete, mismatched, or no longer live'
load_post_cut_checkpoint

capture_inventory
mutation_started=1
if ((RESUME_POST_CUT == 0)); then
  if [[ -z "$CHECKPOINT_PHASE" ]]; then
    FOUNDATION_CREATED_THIS_RELEASE=$INITIAL_FRESH
  elif ((INITIAL_FRESH == 1)); then
    FOUNDATION_CREATED_THIS_RELEASE=1
  fi
  fresh_reset_release_data
  apply_release_metadata
else
  INITIAL_FRESH=0
  status 'resuming validation and cleanup for the active post-cut candidate'
fi
apply_foundation
run_migration
apply_apps
write_release_checkpoint armed
switch_release_traffic
write_release_checkpoint post-cut
traffic_cut_succeeded=1
cleanup_legacy
write_release_evidence
deployment_succeeded=1
status "$ENVIRONMENT release $release_id is complete"
