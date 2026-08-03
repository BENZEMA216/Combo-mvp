#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly SCRIPT_DIR
readonly SHA_RE='^[0-9a-f]{40}$'
readonly DIGEST_RE='^sha256:[0-9a-f]{64}$'

ENVIRONMENT=''
FRESH_RESET=0
DEFER_CLEANUP=0
FINALIZE=0
ROLLBACK=0
RECOVER_EXISTING_POST_CUT=0
MANIFEST=''
MANIFEST_DIGEST=''
MIGRATIONS=''
FOUNDATION_YAML=''
INIT_YAML=''
MIGRATE_YAML=''
APPS_YAML=''
WEB_ASSETS=''
ACCEPTANCE_ATTESTATION=''
ACCEPTANCE_ATTESTATION_DIGEST=''
ACCEPTANCE_EVIDENCE=''
PROMOTION_IDENTITY=''
FOUNDATION_RESET_EVIDENCE=''
RESET_ROLL_FORWARD_EVIDENCE=''
KUBECONFIG_PATH=${KUBECONFIG:-"$HOME/.kube/config"}
EVIDENCE_ROOT=${COMBO_RELEASE_EVIDENCE_ROOT:-"$HOME/data/combo-releases/goal-a"}
MUTATION_LOCK=${COMBO_MUTATION_LOCK:-"$HOME/data/combo-release-mutation.lock"}
K3S_STORAGE_ROOT=${COMBO_K3S_STORAGE_ROOT:-"$HOME/data/k3s/storage"}

status() { printf '[release] %s\n' "$1"; }
fail() {
  printf '[release] FAIL: %s\n' "$1" >&2
  exit 1
}

atomic_root_install() {
  local source=$1 target=$2 mode=$3 stage
  stage="${target}.staging"
  if sudo -n test -e "$stage"; then
    if ! sudo -n test -f "$stage" || ! sudo -n test ! -L "$stage"; then
      fail "root staging path is unsafe: $stage"
    fi
    sudo -n rm -f -- "$stage"
  fi
  sudo -n install -o root -g root -m "$mode" "$source" "$stage"
  [[ "$(sudo -n sha256sum "$stage" | awk '{print "sha256:" $1}')" == \
    "$(sha256sum "$source" | awk '{print "sha256:" $1}')" ]] ||
    fail "root staged file changed: $target"
  sudo -n mv -fT "$stage" "$target"
}

usage() {
  cat >&2 <<'EOF'
Usage: deploy-release.sh
  --environment preview|production
  --fresh-reset
  [--defer-cleanup | --finalize | --rollback | --recover-existing-post-cut]
  --manifest release.json
  --manifest-digest sha256:...
  --migrations migration-files.txt
  --foundation-yaml rendered-foundation.yaml
  --init-yaml rendered-init.yaml
  --migrate-yaml rendered-migrate.yaml
  --apps-yaml rendered-apps.yaml
  --web-assets web-asset-manifest.json
  [--foundation-reset-evidence foundation-reset-evidence.json]
  [--reset-roll-forward-evidence reset-roll-forward-evidence.json]
  [--acceptance-attestation acceptance-attestation.json
   --acceptance-attestation-digest sha256:...
   --acceptance-evidence production-browser-acceptance.json
   --promotion-identity production-identity.json]
EOF
  exit 2
}

while (($# > 0)); do
  case "$1" in
    --fresh-reset)
      FRESH_RESET=1
      shift
      ;;
    --defer-cleanup)
      DEFER_CLEANUP=1
      shift
      ;;
    --finalize)
      FINALIZE=1
      shift
      ;;
    --rollback)
      ROLLBACK=1
      shift
      ;;
    --recover-existing-post-cut)
      RECOVER_EXISTING_POST_CUT=1
      shift
      ;;
    --environment | --manifest | --manifest-digest | --migrations | --foundation-yaml | \
      --init-yaml | --migrate-yaml | --apps-yaml | --web-assets | \
      --foundation-reset-evidence | --reset-roll-forward-evidence | \
      --acceptance-attestation | \
      --acceptance-attestation-digest | --acceptance-evidence | \
      --promotion-identity)
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
        --foundation-reset-evidence) FOUNDATION_RESET_EVIDENCE=$2 ;;
        --reset-roll-forward-evidence) RESET_ROLL_FORWARD_EVIDENCE=$2 ;;
        --acceptance-attestation) ACCEPTANCE_ATTESTATION=$2 ;;
        --acceptance-attestation-digest) ACCEPTANCE_ATTESTATION_DIGEST=$2 ;;
        --acceptance-evidence) ACCEPTANCE_EVIDENCE=$2 ;;
        --promotion-identity) PROMOTION_IDENTITY=$2 ;;
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
((DEFER_CLEANUP + FINALIZE + ROLLBACK + RECOVER_EXISTING_POST_CUT <= 1)) ||
  fail 'deployment phases are mutually exclusive'
if ((RECOVER_EXISTING_POST_CUT == 1)); then
  [[ "$ENVIRONMENT" == preview ]] ||
    fail '--recover-existing-post-cut is restricted to Preview'
fi
if [[ "$ENVIRONMENT" == production ]]; then
  ((DEFER_CLEANUP == 1 || FINALIZE == 1 || ROLLBACK == 1)) ||
    fail 'Production requires an explicit activation, finalization, or rollback phase'
else
  ((DEFER_CLEANUP == 0 && FINALIZE == 0 && ROLLBACK == 0)) ||
    fail 'Preview remains an atomic single-phase deployment'
fi
if ((FINALIZE == 1)); then
  [[ -n "$ACCEPTANCE_ATTESTATION" &&
    "$ACCEPTANCE_ATTESTATION_DIGEST" =~ $DIGEST_RE &&
    -n "$ACCEPTANCE_EVIDENCE" && -n "$PROMOTION_IDENTITY" ]] ||
    fail 'Production finalization requires acceptance evidence, identity, attestation, and digest'
else
  [[ -z "$ACCEPTANCE_ATTESTATION" && -z "$ACCEPTANCE_ATTESTATION_DIGEST" &&
    -z "$ACCEPTANCE_EVIDENCE" && -z "$PROMOTION_IDENTITY" ]] ||
    fail 'acceptance evidence is only accepted during finalization'
fi

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
[[ -x "$SCRIPT_DIR/rollback-release-traffic.sh" ]] ||
  fail 'release traffic rollback controller is missing or not executable'
[[ -x "$SCRIPT_DIR/seal-release-traffic.sh" ]] ||
  fail 'release traffic checkpoint sealer is missing or not executable'
[[ -f "$SCRIPT_DIR/verify-release-schema.mjs" &&
  ! -L "$SCRIPT_DIR/verify-release-schema.mjs" ]] ||
  fail 'release database schema verifier is missing or not executable'
[[ -f "$SCRIPT_DIR/promotion-evidence.mjs" &&
  ! -L "$SCRIPT_DIR/promotion-evidence.mjs" ]] ||
  fail 'release acceptance evidence verifier is missing'

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
routing_name=''
INIT_JOB=''
work=''
release_directory=''
activation_directory=''
pending_checkpoint=''
pending_traffic_evidence=''
rollback_pending_evidence=''
rollback_cleanup_plan=''
rollback_cleanup_plan_digest=''
rollback_cleanup_plan_final=''
rollback_cleanup_binding=''
rollback_plan_preexisting=0
HOST_ROLLBACK_STATUS=''
HOST_ROLLBACK_JOURNAL_PRESENT=0
traffic_evidence=''
cleanup_evidence=''
cleanup_targets=''
cleanup_plan=''
cleanup_plan_digest=''
rollback_evidence=''
traffic_seal_evidence=''
inventory_deployments=''
inventory_statefulsets=''
inventory_jobs=''
inventory_services=''
inventory_configmaps=''
inventory_pvcs=''
pvc_inventory=''
release_storage_evidence=''
schema_structure_evidence=''
schema_structure_digest=''
foundation_reset_digest=''
reset_roll_forward_digest=''
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
RECOVERY_CURRENT_IS_CANDIDATE=0

validate_migrations() {
  local expected=(
    0000_baseline_schema.sql
    0001_expired_upload_reconciliation.sql
    0002_drop_stream_events.sql
    0003_turns.sql
    0004_studio_sessions.sql
    0005_capability_current_ui.sql
    0006_one_running_turn_per_session.sql
    0007_first_party_email_auth.sql
    0008_application_database_roles.sql
    0009_billing.sql
  )
  local actual=()
  mapfile -t actual <"$MIGRATIONS"
  ((${#actual[@]} == ${#expected[@]})) ||
    fail 'migration file list must contain exactly 0000 through 0009'
  local index
  for index in "${!expected[@]}"; do
    [[ "${actual[$index]}" == "${expected[$index]}" ]] ||
      fail 'migration file list differs from the exact 0000 through 0009 contract'
  done
  [[ "${actual[-1]}" == "$migration_head" ]] ||
    fail 'migration file list does not reach the release migration head'
}

validate_foundation_reset_evidence() {
  local expected_claims expected_foundation expected_request_id storage_root
  [[ -n "$FOUNDATION_RESET_EVIDENCE" ]] || {
    foundation_reset_digest=''
    return 0
  }
  [[ -f "$FOUNDATION_RESET_EVIDENCE" && ! -L "$FOUNDATION_RESET_EVIDENCE" ]] ||
    fail 'foundation reset evidence is not a regular file'
  foundation_reset_digest=$(sha256sum "$FOUNDATION_RESET_EVIDENCE" |
    awk '{print "sha256:" $1}')
  [[ "$foundation_reset_digest" =~ $DIGEST_RE ]] ||
    fail 'foundation reset evidence digest is invalid'
  expected_claims=$(printf '%s\n' "${RELEASE_CLAIMS[@]}" |
    jq -R . | jq -s 'sort')
  expected_foundation=$(printf '%s\n' \
    'configmap/release-redis-hot-config' \
    'configmap/release-redis-queue-config' \
    'deployment/release-redis-hot' \
    'service/release-minio' \
    'service/release-postgres' \
    'service/release-redis-hot' \
    'service/release-redis-queue' \
    'statefulset/release-minio' \
    'statefulset/release-postgres' \
    'statefulset/release-redis-queue' |
    jq -R . | jq -s 'sort')
  expected_request_id=$(printf '%s\0%s\0%s\0%s\0%s' \
    combo-foundation-reset-v1 "$ENVIRONMENT" "$source_sha" \
    "$MANIFEST_DIGEST" established-clean-slate-v1 |
    sha256sum | awk '{print "sha256:" $1}')
  storage_root=$(sudo -n realpath -e "$K3S_STORAGE_ROOT")
  jq -e \
    --arg environment "$ENVIRONMENT" \
    --arg namespace "$NAMESPACE" \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg requestId "$expected_request_id" \
    --arg storageRoot "$storage_root" \
    --argjson expectedClaims "$expected_claims" \
    --argjson expectedFoundation "$expected_foundation" '
      (
        if .schemaVersion == 1
        then
          keys == ([
            "authorityDigest", "checks", "completedAt", "environment",
            "foundation", "foundationReadyAt", "foundationSnapshotDigest",
            "manifestDigest", "namespace", "newStorage", "oldStorage",
            "planDigest", "policy", "preservedWeb", "releaseId",
            "requestId", "schemaVersion", "sourceSha", "startedAt",
            "status", "storageClearedAt"
          ] | sort)
          and .supersededReset == null
        elif .schemaVersion == 2
        then
          keys == ([
            "authorityDigest", "checks", "completedAt", "environment",
            "foundation", "foundationReadyAt", "foundationSnapshotDigest",
            "manifestDigest", "namespace", "newStorage", "oldStorage",
            "planDigest", "policy", "preservedWeb", "releaseId",
            "requestId", "schemaVersion", "sourceSha", "startedAt",
            "status", "storageClearedAt", "supersededReset"
          ] | sort)
          and (.supersededReset | keys | sort) == ([
            "environment", "namespace", "requestId", "sourceSha", "releaseId",
            "manifestDigest", "planDigest", "foundationSnapshotDigest",
            "evidenceDigest"
          ] | sort)
          and .supersededReset.environment == "preview"
          and .supersededReset.namespace == "combo-review"
          and (.supersededReset.requestId | test("^sha256:[0-9a-f]{64}$"))
          and (.supersededReset.sourceSha | test("^[0-9a-f]{40}$"))
          and .supersededReset.releaseId
            == ("release-" + .supersededReset.sourceSha)
          and all([
            .supersededReset.manifestDigest,
            .supersededReset.planDigest,
            .supersededReset.foundationSnapshotDigest,
            .supersededReset.evidenceDigest
          ][]; test("^sha256:[0-9a-f]{64}$"))
          and .supersededReset.sourceSha != $sourceSha
        else false
        end
      )
      and .status == "passed"
      and .policy == "established-clean-slate-v1"
      and .environment == $environment
      and .namespace == $namespace
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and .requestId == $requestId
      and .authorityDigest == $manifestDigest
      and (.planDigest | test("^sha256:[0-9a-f]{64}$"))
      and (.foundationSnapshotDigest | test("^sha256:[0-9a-f]{64}$"))
      and ([.oldStorage[].claim] | sort) == $expectedClaims
      and ([.newStorage[].claim] | sort) == $expectedClaims
      and all(.oldStorage[], .newStorage[];
        keys == ([
          "claim", "claimUid", "claimResourceVersion", "path", "volume",
          "volumeUid", "volumeResourceVersion"
        ] | sort)
        and (.claimUid | test("^[0-9a-f-]{36}$"))
        and (.claimResourceVersion | test("^[1-9][0-9]*$"))
        and .volume == ("pvc-" + .claimUid)
        and (.volumeUid | test("^[0-9a-f-]{36}$"))
        and (.volumeResourceVersion | test("^[1-9][0-9]*$"))
        and .path == (
          $storageRoot + "/" + .volume + "_" + $namespace + "_" + .claim
        ))
      and (. as $evidence |
        all(["claimUid", "volume", "volumeUid", "path"][];
          . as $field |
          ($evidence.oldStorage | map(.[$field])) as $oldValues |
          ($evidence.newStorage | map(.[$field])) as $newValues |
          ($oldValues | length) == ($oldValues | unique | length)
          and ($newValues | length) == ($newValues | unique | length)
          and all($newValues[];
            . as $value | ($oldValues | index($value)) == null)))
      and ([.foundation[] | .kind + "/" + .name] | sort) == $expectedFoundation
      and all(.foundation[];
        keys == ["kind", "name", "uid"]
        and (.uid | test("^[0-9a-f-]{36}$")))
      and (.preservedWeb | keys) == ["name", "uid"]
      and (.preservedWeb.name | test("^release-[0-9a-f]{12}-web$"))
      and (.preservedWeb.uid | test("^[0-9a-f-]{36}$"))
      and .checks == (
        {
          activeWebPreserved: true,
          newStorageIdentity: true,
          oldStorageRemoved: true,
          writersFenced: true
        } + (
          if .schemaVersion == 2
          then {supersededResetContinuity: true}
          else {}
          end
        )
      )
      and all([
        .startedAt,
        .storageClearedAt,
        .foundationReadyAt,
        .completedAt
      ][]; type == "string" and test("Z$"))
  ' "$FOUNDATION_RESET_EVIDENCE" >/dev/null ||
    fail 'foundation reset evidence does not match this exact release'
}

validate_live_foundation_reset_uids() {
  local evidence_json current_digest rows row kind name uid current count=0
  [[ -n "$FOUNDATION_RESET_EVIDENCE" ]] || return 0
  IFS= read -r -d '' evidence_json <"$FOUNDATION_RESET_EVIDENCE" ||
    [[ -n "$evidence_json" ]] ||
    fail 'foundation reset evidence became unreadable before live UID validation'
  current_digest=$(printf '%s' "$evidence_json" |
    sha256sum | awk '{print "sha256:" $1}') ||
    fail 'foundation reset evidence digest could not be recomputed'
  [[ "$current_digest" == "$foundation_reset_digest" ]] ||
    fail 'foundation reset evidence changed before live UID validation'
  rows=$(jq -cer '
    .foundation
    | if type == "array" and length == 10
      then .[]
      else error("expected exactly ten foundation resources")
      end
  ' <<<"$evidence_json") ||
    fail 'foundation reset evidence lost its exact foundation resource set'
  while IFS= read -r row; do
    kind=$(jq -er '.kind' <<<"$row")
    name=$(jq -er '.name' <<<"$row")
    uid=$(jq -er '.uid' <<<"$row")
    current=$("${K[@]}" -n "$NAMESPACE" get "$kind/$name" -o json) ||
      fail "reset foundation resource disappeared: $kind/$name"
    jq -e \
      --arg name "$name" \
      --arg uid "$uid" \
      --arg track "$FOUNDATION_TRACK" '
        .metadata.name == $name
        and .metadata.uid == $uid
        and .metadata.deletionTimestamp == null
        and .metadata.labels["combo.build/environment-foundation"] == $track
      ' <<<"$current" >/dev/null ||
      fail "reset foundation resource changed UID or ownership: $kind/$name"
    ((count += 1))
  done <<<"$rows"
  ((count == 10)) ||
    fail 'foundation reset evidence did not validate all ten live resources'
  status 'live foundation UIDs still match the clean-slate reset evidence'
}

validate_reset_roll_forward_evidence() {
  local expected_request_id request_hex state_root internal_evidence
  local plan checkpoint archive seal cancellation file pending_path
  expected_request_id=$(printf '%s\0%s\0%s\0%s' \
    combo-reset-roll-forward-v1 production "$source_sha" "$MANIFEST_DIGEST" |
    sha256sum | awk '{print "sha256:" $1}')
  request_hex=${expected_request_id#sha256:}
  state_root="$EVIDENCE_ROOT/reset-roll-forwards/production"
  internal_evidence="$state_root/$request_hex.evidence.json"
  plan="$state_root/$request_hex.plan.json"
  checkpoint="$state_root/$request_hex.checkpoint.json"
  archive="$state_root/$request_hex.old-pending.json"
  seal="$state_root/$request_hex.handoff-seal.json"
  cancellation="$state_root/$request_hex.cancellation.json"
  [[ -n "$RESET_ROLL_FORWARD_EVIDENCE" ]] || {
    reset_roll_forward_digest=''
    if [[ "$ENVIRONMENT" == production ]]; then
      if [[ -f "$checkpoint" && ! -L "$checkpoint" ]] &&
        [[ "$(jq -r '.phase // empty' "$checkpoint")" == cancelled-finalized ]]; then
        [[ -f "$plan" && ! -L "$plan" &&
          -f "$archive" && ! -L "$archive" &&
          -f "$cancellation" && ! -L "$cancellation" &&
          ! -e "$internal_evidence" && ! -L "$internal_evidence" &&
          ! -e "$seal" && ! -L "$seal" ]] ||
          fail 'cancelled reset roll-forward durable state is incomplete or unsafe'
        return 0
      fi
      for file in "$internal_evidence" "$plan" "$checkpoint" "$archive" "$seal"; do
        [[ ! -e "$file" && ! -L "$file" ]] ||
          fail 'this candidate entered reset roll-forward and requires its evidence'
      done
      [[ ! -e "$cancellation" && ! -L "$cancellation" ]] ||
        fail 'orphan reset roll-forward cancellation blocks this candidate'
    fi
    return 0
  }
  [[ "$ENVIRONMENT" == production ]] ||
    fail 'reset roll-forward evidence is restricted to Production'
  [[ -z "$FOUNDATION_RESET_EVIDENCE" ]] ||
    fail 'foundation reset and reset roll-forward evidence are mutually exclusive'
  [[ -f "$RESET_ROLL_FORWARD_EVIDENCE" &&
    ! -L "$RESET_ROLL_FORWARD_EVIDENCE" ]] ||
    fail 'reset roll-forward evidence is not a regular file'
  reset_roll_forward_digest=$(sha256sum "$RESET_ROLL_FORWARD_EVIDENCE" |
    awk '{print "sha256:" $1}')
  [[ "$reset_roll_forward_digest" =~ $DIGEST_RE ]] ||
    fail 'reset roll-forward evidence digest is invalid'
  for file in "$internal_evidence" "$plan" "$checkpoint" "$archive" "$seal"; do
    [[ -f "$file" && ! -L "$file" ]] ||
      fail 'reset roll-forward durable state is incomplete or unsafe'
  done
  cmp -s "$RESET_ROLL_FORWARD_EVIDENCE" "$internal_evidence" ||
    fail 'reset roll-forward evidence differs from its durable completion record'
  jq -e \
    --arg requestId "$expected_request_id" \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg planDigest "$(sha256sum "$plan" | awk '{print "sha256:" $1}')" \
    --arg archiveDigest "$(sha256sum "$archive" | awk '{print "sha256:" $1}')" \
    --arg sealDigest "$(sha256sum "$seal" | awk '{print "sha256:" $1}')" '
      (keys | sort) == ([
        "schemaVersion", "status", "operation", "environment", "namespace",
        "requestId", "planDigest", "pendingArchiveDigest", "handoffSealDigest",
        "oldSourceSha", "oldReleaseId", "oldManifestDigest",
        "resetEvidenceDigest", "newSourceSha", "newReleaseId",
        "newManifestDigest", "preservedWeb", "removedTargets", "checks",
        "completedAt"
      ] | sort)
      and .schemaVersion == 1
      and .status == "passed"
      and .operation == "production-reset-roll-forward"
      and .environment == "production"
      and .namespace == "combo"
      and .requestId == $requestId
      and .planDigest == $planDigest
      and .pendingArchiveDigest == $archiveDigest
      and .handoffSealDigest == $sealDigest
      and (.oldSourceSha | test("^[0-9a-f]{40}$"))
      and .oldSourceSha != $sourceSha
      and .oldReleaseId == ("release-" + .oldSourceSha)
      and (.oldManifestDigest | test("^sha256:[0-9a-f]{64}$"))
      and (.resetEvidenceDigest | test("^sha256:[0-9a-f]{64}$"))
      and .newSourceSha == $sourceSha
      and .newReleaseId == $releaseId
      and .newManifestDigest == $manifestDigest
      and .preservedWeb.name
        == ("release-" + .oldSourceSha[0:12] + "-web")
      and (.preservedWeb.uid | type == "string" and length > 0)
      and .preservedWeb.serviceName == .preservedWeb.name
      and (.preservedWeb.serviceUid | type == "string" and length > 0)
      and ([.removedTargets[] | .kind + "/" + .name] | sort) == ([
        "deployment/release-" + .oldSourceSha[0:12] + "-api",
        "deployment/release-" + .oldSourceSha[0:12] + "-runtime",
        "deployment/release-" + .oldSourceSha[0:12] + "-worker",
        "job/release-" + .oldSourceSha[0:12] + "-migrate",
        "job/release-" + .oldSourceSha[0:12] + "-minio-init"
      ] | sort)
      and all(.removedTargets[];
        (keys | sort) == ["kind", "name", "state", "uid"]
        and (
          (.state == "present"
            and (.uid | type == "string" and length > 0))
          or
          (.state == "already-absent" and .kind == "job" and .uid == null)
        ))
      and .checks == {
        activeWebPreserved: true,
        oldCandidateWritersRemoved: true,
        pendingArchived: true,
        pendingRemoved: true,
        resetBoundaryRetained: true,
        rollForwardOnly: true,
        secretMaterialAccessed: false
      }
      and (.completedAt | type == "string" and test("Z$"))
    ' "$RESET_ROLL_FORWARD_EVIDENCE" >/dev/null ||
    fail 'reset roll-forward evidence does not authorize this exact release'
  jq -e \
    --arg requestId "$expected_request_id" \
    --arg evidenceDigest "$reset_roll_forward_digest" \
    --arg planDigest "$(sha256sum "$plan" | awk '{print "sha256:" $1}')" '
      .schemaVersion == 1
      and .requestId == $requestId
      and .planDigest == $planDigest
      and .phase == "completed"
      and .evidenceDigest == $evidenceDigest
    ' "$checkpoint" >/dev/null ||
    fail 'reset roll-forward completion checkpoint is invalid'
  pending_path="$EVIDENCE_ROOT/$ENVIRONMENT/pending.json"
  if [[ -e "$pending_path" || -L "$pending_path" ]]; then
    [[ -f "$pending_path" && ! -L "$pending_path" ]] ||
      fail 'Production pending path is unsafe after reset roll-forward'
  fi
}

audit_reset_roll_forward_journals() {
  local -a args
  [[ "$ENVIRONMENT" == production ]] || return 0
  [[ -f "$SCRIPT_DIR/reset-roll-forward-journal.mjs" &&
    ! -L "$SCRIPT_DIR/reset-roll-forward-journal.mjs" ]] ||
    fail 'reset roll-forward journal auditor is missing or unsafe'
  args=(
    audit
    --evidence-root "$EVIDENCE_ROOT"
    --environment production
    --source-sha "$source_sha"
    --manifest-digest "$MANIFEST_DIGEST"
    --mode consumer
  )
  if [[ -n "$RESET_ROLL_FORWARD_EVIDENCE" ]]; then
    args+=(--evidence "$RESET_ROLL_FORWARD_EVIDENCE")
  fi
  node "$SCRIPT_DIR/reset-roll-forward-journal.mjs" "${args[@]}" >/dev/null ||
    fail 'global reset roll-forward journal audit failed'
}

validate_reset_roll_forward_copy() {
  local directory=$1 context=$2 path
  path="$directory/reset-roll-forward-evidence.json"
  if [[ -n "$RESET_ROLL_FORWARD_EVIDENCE" ]]; then
    [[ -f "$path" && ! -L "$path" ]] ||
      fail "$context lacks sealed reset roll-forward evidence"
    cmp -s "$RESET_ROLL_FORWARD_EVIDENCE" "$path" ||
      fail "$context reset roll-forward evidence changed"
  else
    [[ ! -e "$path" && ! -L "$path" ]] ||
      fail "$context unexpectedly contains reset roll-forward evidence"
  fi
}

checksum_set_lists_file_once() {
  local checksum_file=$1 expected_name=$2 count
  count=$(awk -v expected="$expected_name" '
    $2 == expected { count += 1 }
    END { print count + 0 }
  ' "$checksum_file")
  [[ "$count" == 1 ]]
}

validate_completed_foundation_reset_journal() {
  local plan_file=$1 checkpoint_file=$2 ready_file=$3 evidence_file=$4 stem=$5
  local plan_digest ready_digest
  plan_digest=$(sha256sum "$plan_file" | awk '{print "sha256:" $1}')
  ready_digest=$(sha256sum "$ready_file" | awk '{print "sha256:" $1}')
  jq -e \
    --arg requestId "sha256:$stem" \
    --arg environment "$ENVIRONMENT" \
    --arg namespace "$NAMESPACE" '
      .schemaVersion == 1
      and .policy == "established-clean-slate-v1"
      and .requestId == $requestId
      and .authorityDigest == .manifestDigest
      and .environment == $environment
      and .namespace == $namespace
      and (.sourceSha | test("^[0-9a-f]{40}$"))
      and .releaseId == ("release-" + .sourceSha)
      and (.manifestDigest | test("^sha256:[0-9a-f]{64}$"))
      and (.foundationYamlDigest | test("^sha256:[0-9a-f]{64}$"))
      and (.createdAt | type == "string" and length > 0)
      and (.oldStorage | type == "array" and length == 3)
      and (.preservedWeb.name | test("^release-[0-9a-f]{12}-web$"))
      and (.preservedWeb.uid | type == "string" and length > 0)
    ' "$plan_file" >/dev/null ||
    fail 'completed foundation reset plan is invalid'
  jq -e \
    --arg requestId "sha256:$stem" \
    --arg planDigest "$plan_digest" \
    --arg snapshotDigest "$ready_digest" '
      (keys | sort) == ([
        "schemaVersion", "requestId", "planDigest", "phase", "startedAt",
        "storageClearedAt", "foundationReadyAt", "foundationSnapshotDigest",
        "updatedAt"
      ] | sort)
      and .schemaVersion == 1
      and .requestId == $requestId
      and .planDigest == $planDigest
      and .phase == "foundation-ready"
      and .foundationSnapshotDigest == $snapshotDigest
      and all([
        .startedAt, .storageClearedAt, .foundationReadyAt, .updatedAt
      ][]; type == "string" and length > 0)
    ' "$checkpoint_file" >/dev/null ||
    fail 'completed foundation reset checkpoint chain is invalid'
  jq -e \
    --arg requestId "sha256:$stem" \
    --arg planDigest "$plan_digest" '
      (keys | sort) == [
        "foundation", "newStorage", "planDigest", "requestId", "schemaVersion"
      ]
      and .schemaVersion == 1
      and .requestId == $requestId
      and .planDigest == $planDigest
      and (.newStorage | type == "array" and length == 3)
      and (.foundation | type == "array" and length == 10)
    ' "$ready_file" >/dev/null ||
    fail 'completed foundation reset ready snapshot chain is invalid'
  jq -e \
    --arg requestId "sha256:$stem" \
    --arg planDigest "$plan_digest" \
    --arg snapshotDigest "$ready_digest" \
    --arg environment "$ENVIRONMENT" \
    --arg namespace "$NAMESPACE" \
    --slurpfile plan "$plan_file" \
    --slurpfile ready "$ready_file" '
      .schemaVersion == 1
      and .status == "passed"
      and .policy == "established-clean-slate-v1"
      and .requestId == $requestId
      and .authorityDigest == .manifestDigest
      and .environment == $environment
      and .namespace == $namespace
      and .sourceSha == $plan[0].sourceSha
      and .releaseId == $plan[0].releaseId
      and .manifestDigest == $plan[0].manifestDigest
      and .authorityDigest == $plan[0].authorityDigest
      and .planDigest == $planDigest
      and .foundationSnapshotDigest == $snapshotDigest
      and .oldStorage
        == ($plan[0].oldStorage
          | map(del(.claimAuthorityDigest, .volumeAuthorityDigest)))
      and .newStorage
        == ($ready[0].newStorage
          | map(del(.claimAuthorityDigest, .volumeAuthorityDigest)))
      and .foundation == $ready[0].foundation
      and .preservedWeb == {
        name: $plan[0].preservedWeb.name,
        uid: $plan[0].preservedWeb.uid
      }
      and .checks == {
        writersFenced: true,
        oldStorageRemoved: true,
        newStorageIdentity: true,
        activeWebPreserved: true
      }
    ' "$evidence_file" >/dev/null ||
    fail 'completed foundation reset evidence chain is invalid'
}

foundation_reset_consumption_directory_matches() {
  local directory=$1 proof_name=$2 reset_evidence=$3 reset_digest=$4
  local journal_source=$5 journal_release=$6 journal_manifest=$7 proof
  proof="$directory/$proof_name"
  [[ -f "$proof" && ! -L "$proof" &&
    -f "$directory/foundation-reset-evidence.json" &&
    ! -L "$directory/foundation-reset-evidence.json" &&
    -f "$directory/SHA256SUMS" && ! -L "$directory/SHA256SUMS" ]] ||
    return 1
  checksum_set_lists_file_once "$directory/SHA256SUMS" "$proof_name" ||
    return 1
  checksum_set_lists_file_once \
    "$directory/SHA256SUMS" foundation-reset-evidence.json || return 1
  (
    cd "$directory"
    sha256sum --quiet -c SHA256SUMS
  ) || return 1
  cmp -s "$reset_evidence" "$directory/foundation-reset-evidence.json" ||
    return 1
  if [[ "$proof_name" == deploy-evidence.json ]]; then
    jq -e \
      --arg environment "$ENVIRONMENT" \
      --arg namespace "$NAMESPACE" \
      --arg sourceSha "$journal_source" \
      --arg releaseId "$journal_release" \
      --arg manifestDigest "$journal_manifest" \
      --arg digest "$reset_digest" '
        .schemaVersion == 1
        and .status == "passed"
        and .environment == $environment
        and .namespace == $namespace
        and .sourceSha == $sourceSha
        and .releaseId == $releaseId
        and .manifestDigest == $manifestDigest
        and .foundationMode == "reset"
        and .foundationResetEvidenceDigest == $digest
        and .foundationReset.status == "passed"
      ' "$proof" >/dev/null
  else
    jq -e \
      --arg sourceSha "$journal_source" \
      --arg releaseId "$journal_release" \
      --arg manifestDigest "$journal_manifest" \
      --arg digest "$reset_digest" '
        .schemaVersion == 1
        and .status == "awaiting-acceptance"
        and .environment == "production"
        and .namespace == "combo"
        and .sourceSha == $sourceSha
        and .releaseId == $releaseId
        and .manifestDigest == $manifestDigest
        and .foundationResetEvidenceDigest == $digest
      ' "$proof" >/dev/null
  fi
}

completed_foundation_reset_is_consumed_for_reuse() {
  local reset_evidence=$1 reset_digest journal_source journal_release journal_manifest
  local pending environment_root finalized activation
  reset_digest=$(sha256sum "$reset_evidence" | awk '{print "sha256:" $1}')
  journal_source=$(jq -er '.sourceSha' "$reset_evidence") ||
    fail 'completed reset journal lacks a source SHA'
  journal_release=$(jq -er '.releaseId' "$reset_evidence") ||
    fail 'completed reset journal lacks a release ID'
  journal_manifest=$(jq -er '.manifestDigest' "$reset_evidence") ||
    fail 'completed reset journal lacks a manifest digest'
  [[ "$journal_source" =~ $SHA_RE &&
    "$journal_release" == "release-$journal_source" &&
    "$journal_manifest" =~ $DIGEST_RE ]] ||
    fail 'completed reset journal has an invalid release identity'

  environment_root="$EVIDENCE_ROOT/$ENVIRONMENT"
  finalized="$environment_root/$journal_release"
  if [[ -e "$finalized" || -L "$finalized" ]]; then
    [[ -d "$finalized" && ! -L "$finalized" ]] ||
      fail 'final release evidence directory is unsafe during reset journal audit'
    foundation_reset_consumption_directory_matches \
      "$finalized" deploy-evidence.json "$reset_evidence" "$reset_digest" \
      "$journal_source" "$journal_release" "$journal_manifest" ||
      fail 'final release evidence does not consume its reset journal'
    return 0
  fi

  pending="$environment_root/pending.json"
  if [[ -e "$pending" || -L "$pending" ]]; then
    [[ -f "$pending" && ! -L "$pending" ]] ||
      fail 'release pending checkpoint is unsafe during reset journal audit'
    if jq -e \
      --arg sourceSha "$journal_source" \
      --arg releaseId "$journal_release" \
      --arg manifestDigest "$journal_manifest" \
      --arg digest "$reset_digest" '
        .schemaVersion == 3
        and .sourceSha == $sourceSha
        and .releaseId == $releaseId
        and .manifestDigest == $manifestDigest
        and .foundationResetEvidenceDigest == $digest
        and (.phase == "armed"
          or .phase == "post-cut"
          or .phase == "finalizing")
      ' "$pending" >/dev/null; then
      return 0
    fi
  fi

  activation="$environment_root/$journal_release.activation"
  if [[ -e "$activation" || -L "$activation" ]]; then
    [[ -d "$activation" && ! -L "$activation" ]] ||
      fail 'activation evidence directory is unsafe during reset journal audit'
    foundation_reset_consumption_directory_matches \
      "$activation" activation-evidence.json "$reset_evidence" "$reset_digest" \
      "$journal_source" "$journal_release" "$journal_manifest" ||
      fail 'activation evidence does not consume its reset journal'
    return 0
  fi
  return 1
}

validate_foundation_reuse_admission() {
  local journals_root state_root environment_root
  local plan_file stem checkpoint_file ready_file evidence_file phase pending
  local expected_request_id request_hex candidate_output
  local -a plan_files=() checkpoint_files=() ready_files=() evidence_files=()

  [[ -z "$foundation_reset_digest" ]] || return 0

  journals_root="$EVIDENCE_ROOT/foundation-resets"
  state_root="$journals_root/$ENVIRONMENT"
  environment_root="$EVIDENCE_ROOT/$ENVIRONMENT"
  if [[ -e "$journals_root" || -L "$journals_root" ]]; then
    [[ -d "$journals_root" && ! -L "$journals_root" ]] ||
      fail 'foundation reset journal root is unsafe during reuse admission'
  fi
  if [[ -e "$state_root" || -L "$state_root" ]]; then
    [[ -d "$state_root" && ! -L "$state_root" ]] ||
      fail 'foundation reset state directory is unsafe during reuse admission'
    shopt -s nullglob
    plan_files=("$state_root"/*.foundation-reset-plan.json)
    checkpoint_files=("$state_root"/*.foundation-reset-checkpoint.json)
    ready_files=("$state_root"/*.foundation-reset-ready.json)
    evidence_files=("$state_root"/*.foundation-reset-evidence.json)
    shopt -u nullglob
  fi

  for plan_file in "${plan_files[@]}"; do
    [[ -f "$plan_file" && ! -L "$plan_file" ]] ||
      fail 'foundation reset journal plan path is unsafe'
    stem=${plan_file##*/}
    stem=${stem%.foundation-reset-plan.json}
    [[ "$stem" =~ ^[0-9a-f]{64}$ ]] ||
      fail 'foundation reset journal plan name is invalid'
    checkpoint_file="$state_root/$stem.foundation-reset-checkpoint.json"
    ready_file="$state_root/$stem.foundation-reset-ready.json"
    evidence_file="$state_root/$stem.foundation-reset-evidence.json"
    [[ -f "$checkpoint_file" && ! -L "$checkpoint_file" ]] ||
      fail 'foundation reset journal lacks its checkpoint'
    jq -e --arg requestId "sha256:$stem" '
      .schemaVersion == 1
      and .requestId == $requestId
      and (.phase == "planned"
        or .phase == "storage-removed"
        or .phase == "foundation-ready")
    ' "$checkpoint_file" >/dev/null ||
      fail 'foundation reset journal checkpoint is invalid'
    phase=$(jq -er '.phase' "$checkpoint_file")
    if [[ -e "$evidence_file" || -L "$evidence_file" ]]; then
      [[ -f "$evidence_file" && ! -L "$evidence_file" ]] ||
        fail 'foundation reset journal evidence path is unsafe'
      [[ "$phase" == foundation-ready ]] ||
        fail 'foundation reset evidence is paired with an incomplete checkpoint'
      [[ -f "$ready_file" && ! -L "$ready_file" ]] ||
        fail 'completed foundation reset journal lacks its ready snapshot'
      validate_completed_foundation_reset_journal \
        "$plan_file" "$checkpoint_file" "$ready_file" "$evidence_file" "$stem"
      completed_foundation_reset_is_consumed_for_reuse "$evidence_file" ||
        fail 'an unconsumed completed foundation reset blocks reuse deployment'
    else
      fail 'an unfinished foundation reset journal blocks reuse deployment'
    fi
  done

  for checkpoint_file in "${checkpoint_files[@]}"; do
    stem=${checkpoint_file##*/}
    stem=${stem%.foundation-reset-checkpoint.json}
    [[ -f "$state_root/$stem.foundation-reset-plan.json" ]] ||
      fail 'orphan foundation reset checkpoint blocks reuse deployment'
  done
  for ready_file in "${ready_files[@]}"; do
    stem=${ready_file##*/}
    stem=${stem%.foundation-reset-ready.json}
    [[ -f "$state_root/$stem.foundation-reset-plan.json" ]] ||
      fail 'orphan foundation reset ready snapshot blocks reuse deployment'
  done
  for evidence_file in "${evidence_files[@]}"; do
    stem=${evidence_file##*/}
    stem=${stem%.foundation-reset-evidence.json}
    [[ -f "$state_root/$stem.foundation-reset-plan.json" ]] ||
      fail 'orphan foundation reset evidence blocks reuse deployment'
  done

  pending="$environment_root/pending.json"
  if [[ -e "$pending" || -L "$pending" ]]; then
    [[ -f "$pending" && ! -L "$pending" ]] ||
      fail 'release pending checkpoint is unsafe during reuse admission'
    jq -e '.foundationResetEvidenceDigest == null' "$pending" >/dev/null ||
      fail 'a pending clean-slate boundary requires controlled roll-forward'
  fi

  expected_request_id=$(printf '%s\0%s\0%s\0%s\0%s' \
    combo-foundation-reset-v1 "$ENVIRONMENT" "$source_sha" \
    "$MANIFEST_DIGEST" established-clean-slate-v1 |
    sha256sum | awk '{print "sha256:" $1}')
  request_hex=${expected_request_id#sha256:}
  candidate_output="$environment_root/${release_id}.foundation-reset.json"
  for plan_file in \
    "$state_root/$request_hex.foundation-reset-plan.json" \
    "$state_root/$request_hex.foundation-reset-checkpoint.json" \
    "$state_root/$request_hex.foundation-reset-ready.json" \
    "$state_root/$request_hex.foundation-reset-evidence.json" \
    "$candidate_output"; do
    [[ ! -e "$plan_file" && ! -L "$plan_file" ]] ||
      fail 'this candidate entered the clean-slate boundary and cannot use reuse'
  done

  status 'foundation reuse admission revalidated under the deployment mutation lock'
}

audit_foundation_reset_journals() {
  local mode result expected_request_id
  [[ -f "$SCRIPT_DIR/foundation-reset-journal.mjs" &&
    ! -L "$SCRIPT_DIR/foundation-reset-journal.mjs" ]] ||
    fail 'foundation reset journal auditor is missing or unsafe'
  if [[ -n "$FOUNDATION_RESET_EVIDENCE" ]]; then
    mode=deploy-reset
    result=$(node "$SCRIPT_DIR/foundation-reset-journal.mjs" audit \
      --evidence-root "$EVIDENCE_ROOT" \
      --environment "$ENVIRONMENT" \
      --source-sha "$source_sha" \
      --manifest-digest "$MANIFEST_DIGEST" \
      --mode "$mode" \
      --evidence "$FOUNDATION_RESET_EVIDENCE") ||
      fail 'global foundation reset journal audit failed'
  else
    mode=reuse
    result=$(node "$SCRIPT_DIR/foundation-reset-journal.mjs" audit \
      --evidence-root "$EVIDENCE_ROOT" \
      --environment "$ENVIRONMENT" \
      --source-sha "$source_sha" \
      --manifest-digest "$MANIFEST_DIGEST" \
      --mode "$mode") ||
      fail 'global foundation reset journal audit failed'
  fi
  expected_request_id=$(printf '%s\0%s\0%s\0%s\0%s' \
    combo-foundation-reset-v1 "$ENVIRONMENT" "$source_sha" \
    "$MANIFEST_DIGEST" established-clean-slate-v1 |
    sha256sum | awk '{print "sha256:" $1}')
  jq -e \
    --arg environment "$ENVIRONMENT" \
    --arg mode "$mode" \
    --arg requestId "$expected_request_id" '
      (keys | sort) == ([
        "schemaVersion", "status", "environment", "mode",
        "currentRequestId", "authorization", "predecessorEvidencePath",
        "supersededReset", "currentRetry", "chainHeadRequestId",
        "chainConsumed", "journalCount", "completedJournalCount"
      ] | sort)
      and .schemaVersion == 1
      and .status == "passed"
      and .environment == $environment
      and .mode == $mode
      and .currentRequestId == $requestId
      and .authorization == (
        if $mode == "deploy-reset" then "exact-reset-deploy" else "reuse" end
      )
      and .predecessorEvidencePath == null
      and .supersededReset == null
      and (.currentRetry | type == "boolean")
      and (.chainHeadRequestId == null
        or (.chainHeadRequestId | test("^sha256:[0-9a-f]{64}$")))
      and (.chainConsumed | type == "boolean")
      and all([.journalCount, .completedJournalCount][];
        type == "number" and . >= 0 and floor == .)
    ' <<<"$result" >/dev/null ||
    fail 'foundation reset journal auditor returned an invalid deployment admission'
  status 'foundation reset journal admission revalidated under the deployment mutation lock'
}

validate_inputs() {
  local file verified_digest verified_web_digest actual_attestation_digest
  local acceptance_repository acceptance_run_id acceptance_run_attempt
  for file in "$MANIFEST" "$MIGRATIONS" "$FOUNDATION_YAML" "$INIT_YAML" \
    "$MIGRATE_YAML" "$APPS_YAML" "$WEB_ASSETS"; do
    [[ -f "$file" && ! -L "$file" ]] || fail "input is not a regular file: $file"
  done
  if ((FINALIZE == 1)); then
    [[ -f "$ACCEPTANCE_ATTESTATION" && ! -L "$ACCEPTANCE_ATTESTATION" ]] ||
      fail 'acceptance attestation is not a regular file'
    [[ -f "$ACCEPTANCE_EVIDENCE" && ! -L "$ACCEPTANCE_EVIDENCE" ]] ||
      fail 'acceptance evidence is not a regular file'
    [[ -f "$PROMOTION_IDENTITY" && ! -L "$PROMOTION_IDENTITY" ]] ||
      fail 'promotion identity is not a regular file'
    actual_attestation_digest=$(sha256sum "$ACCEPTANCE_ATTESTATION" |
      awk '{print "sha256:" $1}')
    [[ "$actual_attestation_digest" == "$ACCEPTANCE_ATTESTATION_DIGEST" ]] ||
      fail 'acceptance attestation digest does not match'
  fi
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
  if [[ "$ENVIRONMENT" == preview ]]; then
    routing_name="${PREFIX}preview-routing"
  fi
  INIT_JOB="${PREFIX}minio-init"

  verified_web_digest=$(node "$SCRIPT_DIR/web-asset-manifest.mjs" verify \
    --manifest "$WEB_ASSETS" --digest "$web_asset_digest")
  [[ "$verified_web_digest" == "$web_asset_digest" ]] ||
    fail 'Web asset manifest verifier returned another digest'
  validate_migrations
  validate_foundation_reset_evidence
  if ((FINALIZE == 1)); then
    acceptance_repository=$(jq -er '.repository' "$ACCEPTANCE_ATTESTATION")
    acceptance_run_id=$(jq -er '.acceptanceWorkflowRunId' "$ACCEPTANCE_ATTESTATION")
    acceptance_run_attempt=$(jq -er \
      '.acceptanceWorkflowRunAttempt' "$ACCEPTANCE_ATTESTATION")
    node "$SCRIPT_DIR/promotion-evidence.mjs" validate-live-attestation \
      --evidence "$ACCEPTANCE_EVIDENCE" \
      --identity "$PROMOTION_IDENTITY" \
      --attestation "$ACCEPTANCE_ATTESTATION" \
      --repository "$acceptance_repository" \
      --workflow-run-id "$acceptance_run_id" \
      --workflow-run-attempt "$acceptance_run_attempt" >/dev/null ||
      fail 'Production acceptance evidence, identity, and attestation do not match'
  fi
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
  for key in POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB \
    POSTGRES_API_PASSWORD POSTGRES_WORKER_PASSWORD POSTGRES_RUNTIME_PASSWORD \
    S3_ACCESS_KEY S3_SECRET_KEY S3_PUBLIC_ENDPOINT RESEND_API_KEY OTP_HMAC_SECRET; do
    secret_has_nonempty_key "$ENV_SECRET" "$key" ||
      fail "$ENV_SECRET is missing required key $key"
  done
  secret_has_nonempty_key "$PULL_SECRET" .dockerconfigjson ||
    fail "$PULL_SECRET is missing its registry key"
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

validate_completed_production_traffic_seal() {
  local cleanup_digest=$1
  local finalizing="$release_directory/traffic-finalizing-evidence.json"
  local seal="$release_directory/traffic-seal-evidence.json"
  local checkpoint_root checkpoint_host checkpoint journal traffic_lock
  local checkpoint_digest
  checkpoint_root=${COMBO_RELEASE_TRAFFIC_CHECKPOINT_ROOT:-/var/lib/combo-release/traffic-checkpoints}
  checkpoint_host="$checkpoint_root/production/$release_id/checkpoint.json"
  journal="$checkpoint_root/production/$release_id/rollback-in-progress.json"
  checkpoint="$work/reuse-sealed-traffic-checkpoint.json"
  traffic_lock=${COMBO_RELEASE_TRAFFIC_LOCK:-"$HOME/data/combo-release-traffic.lock"}
  install -d -m 0750 "$(dirname "$traffic_lock")"
  exec 7>"$traffic_lock"
  flock -n 7 || fail 'another release traffic transaction is running'
  if ! sudo -n test ! -e "$journal" ||
    ! sudo -n test ! -e "${journal}.staging" ||
    ! sudo -n test ! -e "${checkpoint_host}.staging"; then
    fail 'completed Production release retains an incomplete traffic transaction'
  fi
  if ! sudo -n test -f "$checkpoint_host" ||
    ! sudo -n test ! -L "$checkpoint_host"; then
    fail 'completed Production traffic checkpoint is unsafe'
  fi
  sudo -n cp -- "$checkpoint_host" "$checkpoint"
  sudo -n chown "$(id -u):$(id -g)" "$checkpoint"
  chmod 0600 "$checkpoint"
  checkpoint_digest=$(sha256sum "$checkpoint" | awk '{print "sha256:" $1}')
  jq -e \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg cleanupPlanDigest "$cleanup_plan_digest" '
      keys == [
        "checkpointDigest",
        "cleanupPlanDigest",
        "environment",
        "finalizingAt",
        "manifestDigest",
        "releaseId",
        "rollbackAvailable",
        "schemaVersion",
        "sourceSha",
        "status"
      ]
      and .schemaVersion == 1
      and .status == "finalizing"
      and .environment == "production"
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and .cleanupPlanDigest == $cleanupPlanDigest
      and (.checkpointDigest | test("^sha256:[0-9a-f]{64}$"))
      and .rollbackAvailable == false
      and (.finalizingAt | type == "string" and length > 0)
    ' "$finalizing" >/dev/null ||
    fail 'completed Production finalizing evidence changed'
  jq -e \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg cleanupPlanDigest "$cleanup_plan_digest" \
    --arg cleanupEvidenceDigest "$cleanup_digest" \
    --arg checkpointDigest "$checkpoint_digest" \
    --arg finalizingCheckpointDigest \
      "$(jq -er '.checkpointDigest' "$finalizing")" '
      keys == [
        "checkpointDigest",
        "cleanupEvidenceDigest",
        "cleanupPlanDigest",
        "environment",
        "finalizingCheckpointDigest",
        "manifestDigest",
        "releaseId",
        "rollbackAvailable",
        "schemaVersion",
        "sealedAt",
        "sourceSha",
        "status"
      ]
      and .schemaVersion == 1
      and .status == "sealed"
      and .environment == "production"
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and .cleanupPlanDigest == $cleanupPlanDigest
      and .cleanupEvidenceDigest == $cleanupEvidenceDigest
      and .checkpointDigest == $checkpointDigest
      and .finalizingCheckpointDigest == $finalizingCheckpointDigest
      and .rollbackAvailable == false
      and (.sealedAt | type == "string" and length > 0)
    ' "$seal" >/dev/null ||
    fail 'completed Production seal evidence changed'
  jq -e \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg cleanupPlanDigest "$cleanup_plan_digest" \
    --arg cleanupEvidenceDigest "$cleanup_digest" \
    --arg finalizingCheckpointDigest \
      "$(jq -er '.checkpointDigest' "$finalizing")" '
      .schemaVersion == 1
      and .status == "sealed"
      and .environment == "production"
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and .cleanupPlanDigest == $cleanupPlanDigest
      and .cleanupEvidenceDigest == $cleanupEvidenceDigest
      and .finalizingCheckpointDigest == $finalizingCheckpointDigest
      and (.sealedAt | type == "string" and length > 0)
    ' "$checkpoint" >/dev/null ||
    fail 'completed Production root traffic checkpoint changed'
  flock -u 7
  exec 7>&-
}

reuse_completed_release() {
  local name expected desired ready public_version public_status
  local evidence_file workload actual_migrations internal_version formal_config formal_rewrite
  local cleanup_digest
  REUSE_COMPLETED=0
  [[ -d "$release_directory" && ! -L "$release_directory" ]] || return 0
  for evidence_file in release.json release.sha256 migration-files.txt \
    web-asset-manifest.json foundation.yaml init.yaml migrate.yaml apps.yaml \
    traffic-evidence.json cleanup-plan.json cleanup-evidence.json \
    deploy-evidence.json SHA256SUMS; do
    [[ -f "$release_directory/$evidence_file" &&
      ! -L "$release_directory/$evidence_file" ]] || return 0
  done
  if [[ "$ENVIRONMENT" == production ]]; then
    for evidence_file in acceptance-attestation.json activation-evidence.json \
      acceptance-evidence.json promotion-identity.json \
      traffic-finalizing-evidence.json traffic-seal-evidence.json; do
      [[ -f "$release_directory/$evidence_file" &&
        ! -L "$release_directory/$evidence_file" ]] || return 0
    done
  fi
  if [[ -n "$FOUNDATION_RESET_EVIDENCE" ]]; then
    [[ -f "$release_directory/foundation-reset-evidence.json" &&
      ! -L "$release_directory/foundation-reset-evidence.json" ]] || return 0
    cmp -s "$FOUNDATION_RESET_EVIDENCE" \
      "$release_directory/foundation-reset-evidence.json" || return 0
  else
    [[ ! -e "$release_directory/foundation-reset-evidence.json" &&
      ! -L "$release_directory/foundation-reset-evidence.json" ]] || return 0
  fi
  validate_reset_roll_forward_copy "$release_directory" 'completed release'
  (
    cd "$release_directory"
    sha256sum --quiet -c SHA256SUMS
  ) || return 0
  cmp -s "$MANIFEST" "$release_directory/release.json" || return 0
  cmp -s "$MIGRATIONS" "$release_directory/migration-files.txt" || return 0
  cmp -s "$WEB_ASSETS" "$release_directory/web-asset-manifest.json" || return 0
  [[ "$(tr -d '\n' <"$release_directory/release.sha256")" == "$MANIFEST_DIGEST" ]] ||
    return 0
  cleanup_plan="$release_directory/cleanup-plan.json"
  validate_cleanup_plan
  validate_cleanup_evidence "$release_directory/cleanup-evidence.json"
  verify_cleanup_plan_absent
  cleanup_digest=$(sha256sum "$release_directory/cleanup-evidence.json" |
    awk '{print "sha256:" $1}')
  if [[ "$ENVIRONMENT" == production ]]; then
    validate_completed_production_traffic_seal "$cleanup_digest"
  fi
  jq -e \
    --arg environment "$ENVIRONMENT" \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg apiImage "$api_image" \
    --arg foundationResetDigest "$foundation_reset_digest" \
    --arg webService "${PREFIX}web" '
      .schemaVersion == 1
      and .status == "passed"
      and .environment == $environment
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and (.foundationMode == "fresh"
        or .foundationMode == "reused"
        or .foundationMode == "reset")
      and (.checks.freshFoundation | type == "boolean")
      and .checks.schemaStructure == true
      and (.schemaStructure.contractDigest | test("^sha256:[0-9a-f]{64}$"))
      and .schemaStructure.actualDigest == .schemaStructure.contractDigest
      and .schemaStructure.verified == true
      and (.schemaStructureDigest | test("^sha256:[0-9a-f]{64}$"))
      and .schemaStructureDigest == .schemaStructure.actualDigest
      and (
        if .foundationMode == "reset" then
          $foundationResetDigest != ""
          and .foundationResetEvidenceDigest == $foundationResetDigest
          and .foundationReset.status == "passed"
          and .foundationReset.sourceSha == $sourceSha
          and .checks.foundationReset == true
          and .checks.freshFoundation == true
        else
          $foundationResetDigest == ""
          and .foundationResetEvidenceDigest == null
          and .foundationReset == null
          and .checks.foundationReset == false
        end
      )
      and .checks.foundationReady == true
      and .checks.releaseStorage == true
      and .checks.minioInitialization == true
      and .checks.exactMigrations == true
      and .checks.applicationImages == true
      and .checks.publicTraffic == true
      and .checks.legacyCleanup == true
      and (
        if $environment == "production" then
          .checks.protectedAcceptance == true
          and .traffic.formalOrigin == "https://buildwithcombo.com"
          and .traffic.formalAliasOrigin == "https://www.buildwithcombo.com"
          and .traffic.routeCas.formal.contract == "production-formal"
          and .traffic.routeCas.formal.afterMode == "release"
          and .traffic.checks.formalHome == true
          and .traffic.checks.formalVersion == true
          and .traffic.checks.formalApi == true
          and .traffic.checks.formalTls == true
        else true end
      )
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
  verify_release_schema_structure >/dev/null 2>&1 || return 0
  [[ "$schema_structure_digest" == \
    "$(jq -er '.schemaStructureDigest' \
      "$release_directory/deploy-evidence.json")" ]] || return 0
  jq -e --slurpfile schema "$schema_structure_evidence" '
    .schemaStructure.contractVersion == $schema[0].contractVersion
    and .schemaStructure.environment == $schema[0].environment
    and .schemaStructure.namespace == $schema[0].namespace
    and .schemaStructure.sourceSha == $schema[0].sourceSha
    and .schemaStructure.migrationHead == $schema[0].migrationHead
    and .schemaStructure.contractDigest == $schema[0].contractDigest
    and .schemaStructure.actualDigest == $schema[0].actualDigest
    and .schemaStructure.verified == $schema[0].verified
    and .schemaStructure.counts == $schema[0].counts
  ' "$release_directory/deploy-evidence.json" >/dev/null 2>&1 || return 0

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
    public_version="$work/reuse-public-version.json"
    public_status=$(curl --silent --show-error --max-time 15 \
      --output "$public_version" --write-out '%{http_code}' \
      "$PUBLIC_ORIGIN/version.json" 2>/dev/null) || return 0
    [[ "$public_status" == 200 ]] || return 0
    metadata_matches "$public_version" || return 0
  else
    public_version="$work/reuse-public-version.json"
    curl --fail --silent --show-error --max-time 15 \
      "$PUBLIC_ORIGIN/version.json" >"$public_version" 2>/dev/null || return 0
    metadata_matches "$public_version" || return 0
    public_version="$work/reuse-formal-version.json"
    curl --fail --silent --show-error --max-time 15 \
      https://buildwithcombo.com/version.json >"$public_version" 2>/dev/null || return 0
    metadata_matches "$public_version" || return 0
    public_version="$work/reuse-formal-alias-version.json"
    curl --fail --silent --show-error --max-time 15 \
      https://www.buildwithcombo.com/version.json >"$public_version" 2>/dev/null || return 0
    metadata_matches "$public_version" || return 0
    formal_config="$work/reuse-formal-nginx.conf"
    formal_rewrite="$work/reuse-formal-nginx.release.conf"
    sudo -n cp -- /etc/nginx/conf.d/happy.conf "$formal_config" || return 0
    sudo -n chown "$(id -u):$(id -g)" "$formal_config" || return 0
    chmod 0600 "$formal_config"
    node "$SCRIPT_DIR/release-nginx-route.mjs" rewrite \
      --input "$formal_config" \
      --output "$formal_rewrite" \
      --contract production-formal \
      --target release >/dev/null 2>&1 || return 0
    cmp -s "$formal_config" "$formal_rewrite" || return 0
    jq -e \
      --arg sourceSha "$source_sha" \
      --arg releaseId "$release_id" \
      --arg manifestDigest "$MANIFEST_DIGEST" '
        .schemaVersion == 1
        and .environment == "production"
        and .sourceSha == $sourceSha
        and .releaseId == $releaseId
        and .manifestDigest == $manifestDigest
      ' "$HOME/data/combo-releases/traffic/production/current.json" \
      >/dev/null 2>&1 || return 0
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
    --arg foundationResetEvidenceDigest "$foundation_reset_digest" \
    --arg webService "${PREFIX}web" '
      keys == [
        "cleanupPlanDigest",
        "environment",
        "foundationCreated",
        "foundationResetEvidenceDigest",
        "manifestDigest",
        "namespace",
        "phase",
        "releaseId",
        "schemaStructureProofDigest",
        "schemaVersion",
        "sourceSha",
        "trafficCutAt",
        "webService"
      ]
      and .schemaVersion == 3
      and .environment == $environment
      and .namespace == $namespace
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and .foundationResetEvidenceDigest ==
        (if $foundationResetEvidenceDigest == "" then null
          else $foundationResetEvidenceDigest end)
      and (.schemaStructureProofDigest | test("^sha256:[0-9a-f]{64}$"))
      and .webService == $webService
      and (.foundationCreated | type == "boolean")
      and (.phase == "armed" or .phase == "post-cut" or .phase == "finalizing")
      and (
        (.phase == "armed" and .trafficCutAt == null)
        or
        ((.phase == "post-cut" or .phase == "finalizing")
          and (.trafficCutAt | type == "string" and length > 0))
      )
      and (
        (.phase == "finalizing"
          and (.cleanupPlanDigest | test("^sha256:[0-9a-f]{64}$")))
        or
        (.phase == "armed" and .cleanupPlanDigest == null)
        or
        (.phase == "post-cut"
          and (
            .cleanupPlanDigest == null
            or (.cleanupPlanDigest | test("^sha256:[0-9a-f]{64}$"))
          ))
      )
    ' "$pending_checkpoint" >/dev/null ||
    fail 'another or invalid post-cut checkpoint requires recovery first'
  created=$(jq -r '.foundationCreated' "$pending_checkpoint")
  [[ "$created" == true || "$created" == false ]] ||
    fail 'post-cut checkpoint foundation mode is invalid'
  [[ "$created" == true ]] && FOUNDATION_CREATED_THIS_RELEASE=1 ||
    FOUNDATION_CREATED_THIS_RELEASE=0
  CHECKPOINT_PHASE=$(jq -er '.phase' "$pending_checkpoint")
  schema_structure_digest=$(jq -er '.schemaStructureProofDigest' "$pending_checkpoint")
}

write_release_checkpoint() {
  local phase=$1 checkpoint_stage created=false traffic_cut_at plan_digest=''
  [[ "$phase" == armed || "$phase" == post-cut || "$phase" == finalizing ]] ||
    fail 'invalid release checkpoint phase'
  [[ "$schema_structure_digest" =~ $DIGEST_RE ]] ||
    fail 'release checkpoint requires a verified schema structure digest'
  ((FOUNDATION_CREATED_THIS_RELEASE == 0)) || created=true
  if [[ "$phase" == finalizing ]]; then
    [[ "$CHECKPOINT_PHASE" == post-cut || "$CHECKPOINT_PHASE" == finalizing ]] ||
      fail 'Production finalization can start only from a post-cut checkpoint'
    traffic_cut_at=$(jq -er '.trafficCutAt' "$pending_checkpoint")
    [[ "$cleanup_plan_digest" =~ $DIGEST_RE ]] ||
      fail 'Production finalization requires a durable cleanup plan'
    plan_digest=$cleanup_plan_digest
  elif [[ "$phase" == post-cut ]]; then
    if [[ -e "$pending_checkpoint" ]] &&
      [[ "$(jq -r '.phase // ""' "$pending_checkpoint")" == post-cut ]]; then
      traffic_cut_at=$(jq -er '.trafficCutAt' "$pending_checkpoint")
      plan_digest=$(jq -r '.cleanupPlanDigest // ""' "$pending_checkpoint")
    else
      traffic_cut_at=$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')
    fi
    if [[ -n "$cleanup_plan_digest" ]]; then
      [[ "$cleanup_plan_digest" =~ $DIGEST_RE ]] ||
        fail 'post-cut cleanup plan digest is invalid'
      if [[ -n "$plan_digest" && "$plan_digest" != "$cleanup_plan_digest" ]]; then
        fail 'post-cut cleanup plan digest changed'
      fi
      plan_digest=$cleanup_plan_digest
    fi
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
    --arg foundationResetEvidenceDigest "$foundation_reset_digest" \
    --arg schemaStructureProofDigest "$schema_structure_digest" \
    --arg webService "${PREFIX}web" \
    --arg phase "$phase" \
    --arg trafficCutAt "$traffic_cut_at" \
    --arg cleanupPlanDigest "$plan_digest" \
    --argjson foundationCreated "$created" '{
      schemaVersion: 3,
      environment: $environment,
      namespace: $namespace,
      sourceSha: $sourceSha,
      releaseId: $releaseId,
      manifestDigest: $manifestDigest,
      foundationResetEvidenceDigest:
        (if $foundationResetEvidenceDigest == "" then null
          else $foundationResetEvidenceDigest end),
      schemaStructureProofDigest: $schemaStructureProofDigest,
      webService: $webService,
      foundationCreated: $foundationCreated,
      phase: $phase,
      trafficCutAt: (if $phase == "armed" then null else $trafficCutAt end),
      cleanupPlanDigest:
        (if $cleanupPlanDigest == "" then null else $cleanupPlanDigest end)
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
    if ((ROLLBACK == 1)) &&
      [[ "$CHECKPOINT_PHASE" == armed || "$CHECKPOINT_PHASE" == post-cut ]]; then
      TRAFFIC_MODE=interrupted
      ACTIVE_RELEASE_WEB=''
      if [[ "$CHECKPOINT_PHASE" == armed ]]; then
        RESUME_POST_CUT=2
      else
        RESUME_POST_CUT=3
      fi
      return
    fi
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
    [[ "$CHECKPOINT_PHASE" == armed || "$CHECKPOINT_PHASE" == post-cut ||
      "$CHECKPOINT_PHASE" == finalizing ]] ||
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
    and all(.items[]
      | select(.metadata.name
        | test("^release-[0-9a-f]{12}-(preview-routing|review-gate)$"));
        .metadata.name as $name
        | ($name
          | capture("^release-(?<short>[0-9a-f]{12})-(preview-routing|review-gate)$")) as $parts
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
        then .metadata.labels["combo.build/managed-by"] == "release-v1"
          and .spec.template.metadata.labels["combo.build/managed-by"] == "release-v1"
        else .metadata.labels["combo.build/environment-foundation"] == $track
          and .spec.template.metadata.labels["combo.build/environment-foundation"] == $track
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
        [[ "$CHECKPOINT_PHASE" == armed || "$CHECKPOINT_PHASE" == post-cut ||
          "$CHECKPOINT_PHASE" == finalizing ]]; then
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
    interrupted)
      ((ROLLBACK == 1)) ||
        fail 'interrupted traffic is accepted only by the rollback controller'
      if ((release_stateful_count == 3 && release_claim_count == 3)); then
        INITIAL_FRESH=0
      elif ((rollback_plan_preexisting == 1 &&
        FOUNDATION_CREATED_THIS_RELEASE == 1 &&
        release_stateful_count >= 0 && release_stateful_count <= 3 &&
        release_claim_count >= 0 && release_claim_count <= 3)); then
        INITIAL_FRESH=0
      else
        fail 'interrupted rollback foundation lacks its durable cleanup plan'
      fi
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
  local scope=$1 claim volume volume_uid path removed live_pv live_uid
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
    volume_uid=$(jq -r '.volumeUid' <<<"$row")
    path=$(jq -r '.path' <<<"$row")
    removed=0
    for _ in $(seq 1 90); do
      if live_pv=$("${K[@]}" get "pv/$volume" -o json 2>/dev/null); then
        live_uid=$(jq -er '.metadata.uid' <<<"$live_pv")
        [[ "$live_uid" == "$volume_uid" ]] ||
          fail "PV $volume was replaced while waiting for exact storage removal"
      elif ! sudo -n test -e "$path"; then
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
      "$name" =~ ^release-[0-9a-f]{12}-preview-routing$ ||
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
  if [[ -n "$FOUNDATION_RESET_EVIDENCE" ]]; then
    jq -e --slurpfile storage "$release_storage_evidence" '
      (
        .newStorage
        | map({claim, claimUid, volume, volumeUid, path})
        | sort_by(.claim)
      ) == (
        $storage[0].claims
        | map({claim, claimUid, volume, volumeUid, path})
        | sort_by(.claim)
      )
    ' "$FOUNDATION_RESET_EVIDENCE" >/dev/null ||
      fail 'live release storage no longer matches the clean-slate reset evidence'
  fi

  delete_candidate_job "$INIT_JOB"
  "${K[@]}" apply -f "$INIT_YAML" >/dev/null
  if ! "${K[@]}" -n "$NAMESPACE" wait --for=condition=complete \
    "job/$INIT_JOB" --timeout=300s; then
    "${K[@]}" -n "$NAMESPACE" logs "job/$INIT_JOB" --tail=200 >&2 || true
    fail 'bucket initialization and synthetic object smoke failed'
  fi
}

run_migration() {
  status 'running the exact 0000 through 0009 migration set'
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
    fail 'fresh database migration ledger differs from 0000 through 0009'

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

verify_release_schema_structure() {
  local digest
  schema_structure_evidence="$work/schema-structure-evidence.json"
  node "$SCRIPT_DIR/verify-release-schema.mjs" \
    --environment "$ENVIRONMENT" \
    --namespace "$NAMESPACE" \
    --source-sha "$source_sha" \
    --migration-head "$migration_head" \
    --output "$schema_structure_evidence" >/dev/null
  [[ -f "$schema_structure_evidence" && ! -L "$schema_structure_evidence" ]] ||
    fail 'release database schema verifier did not produce regular evidence'
  jq -e \
    --arg environment "$ENVIRONMENT" \
    --arg namespace "$NAMESPACE" \
    --arg sourceSha "$source_sha" \
    --arg migrationHead "$migration_head" '
      keys == ([
        "actualDigest",
        "contractDigest",
        "contractVersion",
        "counts",
        "environment",
        "migrationHead",
        "namespace",
        "schemaVersion",
        "sourceSha",
        "status",
        "verified",
        "verifiedAt"
      ] | sort)
      and .schemaVersion == 1
      and .status == "passed"
      and .contractVersion == "combo-schema-0009-v1"
      and .environment == $environment
      and .namespace == $namespace
      and .sourceSha == $sourceSha
      and .migrationHead == $migrationHead
      and (.contractDigest | test("^sha256:[0-9a-f]{64}$"))
      and .actualDigest == .contractDigest
      and .verified == true
      and (.counts | keys) == [
        "columns",
        "constraints",
        "functions",
        "grants",
        "indexes",
        "relations",
        "roles",
        "triggers"
      ]
      and all(.counts[]; type == "number" and . > 0 and floor == .)
      and (.verifiedAt | type == "string" and test("Z$"))
    ' "$schema_structure_evidence" >/dev/null ||
    fail 'release database schema structure evidence is invalid'
  digest=$(jq -er '.actualDigest' "$schema_structure_evidence")
  [[ "$digest" =~ $DIGEST_RE ]] ||
    fail 'release database schema identity digest is invalid'
  schema_structure_digest=$digest
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
  "${K[@]}" -n "$NAMESPACE" exec "deployment/${PREFIX}web" -- \
    wget -qO- "$url"
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

  local asset_path runtime_asset_path
  asset_path=$(jq -er '
    first(.assets[] | select(.application == "web" and (.path | startswith("assets/"))) | .path)
  ' "$WEB_ASSETS")
  runtime_asset_path=$(jq -er '
    first(
      .assets[]
      | select(.application == "runtime-web" and (.path | startswith("assets/")))
      | .path
    )
  ' "$WEB_ASSETS")
  web_fetch "http://127.0.0.1/$asset_path" >/dev/null
  web_fetch http://127.0.0.1/try/ >/dev/null
  web_fetch http://127.0.0.1/try/sessions/combo-release-route-contract >/dev/null
  web_fetch "http://127.0.0.1/try/$runtime_asset_path" >/dev/null
  if web_fetch http://127.0.0.1/assets/combo-missing-deadbeef.js >/dev/null; then
    fail 'a missing hashed Web asset returned success'
  fi
  if web_fetch http://127.0.0.1/try/assets/combo-missing-deadbeef.js >/dev/null; then
    fail 'a missing hashed Runtime Web asset returned success'
  fi
}

switch_release_traffic() {
  traffic_evidence=$pending_traffic_evidence
  "$SCRIPT_DIR/switch-release-traffic.sh" \
    --environment "$ENVIRONMENT" \
    --manifest "$MANIFEST" \
    --manifest-digest "$MANIFEST_DIGEST" \
    --evidence-output "$traffic_evidence"
}

validate_traffic_cleanup_gate() {
  [[ -f "$traffic_evidence" && ! -L "$traffic_evidence" ]] ||
    fail 'traffic evidence is missing before superseded release cleanup'
  jq -e \
    --arg environment "$ENVIRONMENT" \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" '
      .schemaVersion == 1
      and .environment == $environment
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and .routeCas.canary.afterMode == "release"
      and .rollback.checkpointId == $releaseId
      and (.rollback.checkpointDigest | test("^sha256:[0-9a-f]{64}$"))
      and .rollback.persisted == true
      and .checks.loopbackWebRelease == true
      and .checks.loopbackMinioReady == true
      and .checks.publicWebRelease == true
      and .checks.publicMinioReady == true
      and .checks.internalPortsLoopbackOnly == true
      and (
        if $environment == "production" then
          .formalOrigin == "https://buildwithcombo.com"
          and .formalAliasOrigin == "https://www.buildwithcombo.com"
          and .formalNginx.path == "/etc/nginx/conf.d/happy.conf"
          and (.formalNginx.sha256 | test("^sha256:[0-9a-f]{64}$"))
          and .routeCas.formal.contract == "production-formal"
          and .routeCas.formal.afterMode == "release"
          and .checks.formalHome == true
          and .checks.formalVersion == true
          and .checks.formalSpaRoutes == true
          and .checks.formalApi == true
          and .checks.formalTls == true
          and .checks.formalHtmlCache == true
          and .checks.formalAssetCache == true
          and .checks.formalMissingAsset404 == true
          and .checks.formalForcedRefresh == true
        else
          .formalOrigin == null
          and .formalAliasOrigin == null
          and .formalNginx == null
          and .routeCas.formal == null
        end
      )
    ' "$traffic_evidence" >/dev/null ||
    fail 'traffic evidence did not authorize superseded release cleanup'
}

write_activation_evidence() {
  local stage file candidate_file
  if [[ -e "$activation_directory" ]]; then
    [[ -d "$activation_directory" && ! -L "$activation_directory" ]] ||
      fail 'Production activation evidence is not a directory'
    for file in release.json release.sha256 migration-files.txt web-asset-manifest.json \
      foundation.yaml init.yaml migrate.yaml apps.yaml traffic-evidence.json \
      release-storage-evidence.json activation-evidence.json SHA256SUMS; do
      [[ -f "$activation_directory/$file" &&
        ! -L "$activation_directory/$file" ]] ||
        fail "Production activation evidence lacks $file"
    done
    if [[ -n "$FOUNDATION_RESET_EVIDENCE" ]]; then
      [[ -f "$activation_directory/foundation-reset-evidence.json" &&
        ! -L "$activation_directory/foundation-reset-evidence.json" ]] ||
        fail 'Production activation lost its sealed foundation reset evidence'
      cmp -s "$FOUNDATION_RESET_EVIDENCE" \
        "$activation_directory/foundation-reset-evidence.json" ||
        fail 'Production activation foundation reset evidence changed'
    else
      [[ ! -e "$activation_directory/foundation-reset-evidence.json" &&
        ! -L "$activation_directory/foundation-reset-evidence.json" ]] ||
        fail 'Production activation unexpectedly contains foundation reset evidence'
    fi
    validate_reset_roll_forward_copy "$activation_directory" 'Production activation'
    (
      cd "$activation_directory"
      sha256sum --quiet -c SHA256SUMS
    ) || fail 'Production activation evidence digest set changed'
    cmp -s "$MANIFEST" "$activation_directory/release.json" ||
      fail 'Production activation manifest differs from the retry'
    cmp -s "$MIGRATIONS" "$activation_directory/migration-files.txt" ||
      fail 'Production activation migrations differ from the retry'
    cmp -s "$WEB_ASSETS" "$activation_directory/web-asset-manifest.json" ||
      fail 'Production activation Web assets differ from the retry'
    for file in foundation init migrate apps; do
      case "$file" in
        foundation) candidate_file=$FOUNDATION_YAML ;;
        init) candidate_file=$INIT_YAML ;;
        migrate) candidate_file=$MIGRATE_YAML ;;
        apps) candidate_file=$APPS_YAML ;;
      esac
      cmp -s "$candidate_file" "$activation_directory/$file.yaml" ||
        fail "Production activation $file manifest differs from the retry"
    done
    jq -e \
      --arg sourceSha "$source_sha" \
      --arg releaseId "$release_id" \
      --arg manifestDigest "$MANIFEST_DIGEST" \
      --arg foundationResetEvidenceDigest "$foundation_reset_digest" '
        .schemaVersion == 1
        and .status == "awaiting-acceptance"
        and .environment == "production"
        and .namespace == "combo"
        and .sourceSha == $sourceSha
        and .releaseId == $releaseId
        and .manifestDigest == $manifestDigest
        and .foundationResetEvidenceDigest ==
          (if $foundationResetEvidenceDigest == "" then null
            else $foundationResetEvidenceDigest end)
        and (.schemaStructureProofDigest | test("^sha256:[0-9a-f]{64}$"))
        and .rollbackCheckpointId == $releaseId
        and (.rollbackCheckpointDigest | test("^sha256:[0-9a-f]{64}$"))
        and .checks.candidateReady == true
        and .checks.trafficActivated == true
        and .checks.formalDomainVerified == true
        and .checks.supersededReleaseRetained == true
      ' "$activation_directory/activation-evidence.json" >/dev/null ||
      fail 'Production activation evidence is not reusable'
    traffic_evidence="$work/activation-traffic.json"
    release_storage_evidence="$work/activation-storage.json"
    install -m 0600 "$activation_directory/traffic-evidence.json" "$traffic_evidence"
    install -m 0600 "$activation_directory/release-storage-evidence.json" \
      "$release_storage_evidence"
    validate_traffic_cleanup_gate
    return
  fi
  stage=$(mktemp -d "$EVIDENCE_ROOT/$ENVIRONMENT/.${release_id}.activation.XXXXXX")
  install -m 0644 "$MANIFEST" "$stage/release.json"
  install -m 0644 "$MIGRATIONS" "$stage/migration-files.txt"
  install -m 0644 "$WEB_ASSETS" "$stage/web-asset-manifest.json"
  install -m 0644 "$FOUNDATION_YAML" "$stage/foundation.yaml"
  install -m 0644 "$INIT_YAML" "$stage/init.yaml"
  install -m 0644 "$MIGRATE_YAML" "$stage/migrate.yaml"
  install -m 0644 "$APPS_YAML" "$stage/apps.yaml"
  install -m 0644 "$traffic_evidence" "$stage/traffic-evidence.json"
  install -m 0644 "$release_storage_evidence" "$stage/release-storage-evidence.json"
  if [[ -n "$FOUNDATION_RESET_EVIDENCE" ]]; then
    install -m 0644 "$FOUNDATION_RESET_EVIDENCE" \
      "$stage/foundation-reset-evidence.json"
  fi
  if [[ -n "$RESET_ROLL_FORWARD_EVIDENCE" ]]; then
    install -m 0644 "$RESET_ROLL_FORWARD_EVIDENCE" \
      "$stage/reset-roll-forward-evidence.json"
  fi
  printf '%s\n' "$MANIFEST_DIGEST" >"$stage/release.sha256"
  chmod 0644 "$stage/release.sha256"
  jq -n \
    --arg environment "$ENVIRONMENT" \
    --arg namespace "$NAMESPACE" \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg foundationResetEvidenceDigest "$foundation_reset_digest" \
    --arg schemaStructureProofDigest "$schema_structure_digest" \
    --arg activatedAt "$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')" \
    --slurpfile traffic "$traffic_evidence" '{
      schemaVersion: 1,
      status: "awaiting-acceptance",
      environment: $environment,
      namespace: $namespace,
      sourceSha: $sourceSha,
      releaseId: $releaseId,
      manifestDigest: $manifestDigest,
      foundationResetEvidenceDigest:
        (if $foundationResetEvidenceDigest == "" then null
          else $foundationResetEvidenceDigest end),
      schemaStructureProofDigest: $schemaStructureProofDigest,
      rollbackCheckpointId: $traffic[0].rollback.checkpointId,
      rollbackCheckpointDigest: $traffic[0].rollback.checkpointDigest,
      checks: {
        candidateReady: true,
        trafficActivated: true,
        formalDomainVerified: true,
        supersededReleaseRetained: true
      },
      activatedAt: $activatedAt
    }' >"$stage/activation-evidence.json"
  chmod 0644 "$stage/activation-evidence.json"
  (
    cd "$stage"
    activation_files=(
      release.json release.sha256 migration-files.txt web-asset-manifest.json
      foundation.yaml init.yaml migrate.yaml apps.yaml traffic-evidence.json
      release-storage-evidence.json activation-evidence.json
    )
    if [[ -e foundation-reset-evidence.json ||
      -L foundation-reset-evidence.json ]]; then
      [[ -f foundation-reset-evidence.json &&
        ! -L foundation-reset-evidence.json ]] ||
        fail 'Production activation staged an unsafe foundation reset evidence path'
      activation_files+=(foundation-reset-evidence.json)
    fi
    if [[ -e reset-roll-forward-evidence.json ||
      -L reset-roll-forward-evidence.json ]]; then
      [[ -f reset-roll-forward-evidence.json &&
        ! -L reset-roll-forward-evidence.json ]] ||
        fail 'Production activation staged an unsafe reset roll-forward evidence path'
      activation_files+=(reset-roll-forward-evidence.json)
    fi
    sha256sum "${activation_files[@]}" >SHA256SUMS
  )
  chmod 0644 "$stage/SHA256SUMS"
  mv "$stage" "$activation_directory"
}

load_activation_evidence() {
  local file stored_storage="$work/activation-storage.json"
  [[ -d "$activation_directory" && ! -L "$activation_directory" ]] ||
    fail 'Production finalization lacks pending activation evidence'
  for file in release.json release.sha256 migration-files.txt web-asset-manifest.json \
    foundation.yaml init.yaml migrate.yaml apps.yaml traffic-evidence.json \
    release-storage-evidence.json activation-evidence.json SHA256SUMS; do
    [[ -f "$activation_directory/$file" && ! -L "$activation_directory/$file" ]] ||
      fail "Production activation evidence lacks $file"
  done
  if [[ -n "$FOUNDATION_RESET_EVIDENCE" ]]; then
    [[ -f "$activation_directory/foundation-reset-evidence.json" &&
      ! -L "$activation_directory/foundation-reset-evidence.json" ]] ||
      fail 'Production finalization lacks sealed foundation reset evidence'
    [[ "$(sha256sum "$activation_directory/foundation-reset-evidence.json" |
      awk '{print "sha256:" $1}')" == "$foundation_reset_digest" ]] ||
      fail 'Production activation foundation reset evidence digest changed'
    cmp -s "$FOUNDATION_RESET_EVIDENCE" \
      "$activation_directory/foundation-reset-evidence.json" ||
      fail 'Production finalization reset evidence differs from activation'
  else
    [[ ! -e "$activation_directory/foundation-reset-evidence.json" &&
      ! -L "$activation_directory/foundation-reset-evidence.json" ]] ||
      fail 'Production finalization omitted its reset authorization'
  fi
  validate_reset_roll_forward_copy "$activation_directory" 'Production finalization'
  (
    cd "$activation_directory"
    sha256sum --quiet -c SHA256SUMS
  ) || fail 'Production activation evidence digest set changed'
  [[ "$(tr -d '\n' <"$activation_directory/release.sha256")" == "$MANIFEST_DIGEST" ]] ||
    fail 'Production activation manifest digest changed'
  cmp -s "$MANIFEST" "$activation_directory/release.json" ||
    fail 'Production finalization manifest differs from activation'
  cmp -s "$MIGRATIONS" "$activation_directory/migration-files.txt" ||
    fail 'Production finalization migrations differ from activation'
  cmp -s "$WEB_ASSETS" "$activation_directory/web-asset-manifest.json" ||
    fail 'Production finalization Web assets differ from activation'
  for file in foundation init migrate apps; do
    case "$file" in
      foundation) candidate_file=$FOUNDATION_YAML ;;
      init) candidate_file=$INIT_YAML ;;
      migrate) candidate_file=$MIGRATE_YAML ;;
      apps) candidate_file=$APPS_YAML ;;
    esac
    cmp -s "$candidate_file" "$activation_directory/$file.yaml" ||
      fail "Production finalization $file manifest differs from activation"
  done
  jq -e \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg foundationResetEvidenceDigest "$foundation_reset_digest" '
      .schemaVersion == 1
      and .status == "awaiting-acceptance"
      and .environment == "production"
      and .namespace == "combo"
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and .foundationResetEvidenceDigest ==
        (if $foundationResetEvidenceDigest == "" then null
          else $foundationResetEvidenceDigest end)
      and (.schemaStructureProofDigest | test("^sha256:[0-9a-f]{64}$"))
      and .rollbackCheckpointId == $releaseId
      and (.rollbackCheckpointDigest | test("^sha256:[0-9a-f]{64}$"))
      and .checks.candidateReady == true
      and .checks.trafficActivated == true
      and .checks.formalDomainVerified == true
      and .checks.supersededReleaseRetained == true
    ' "$activation_directory/activation-evidence.json" >/dev/null ||
    fail 'Production activation evidence is not finalizable'
  jq -e \
    --arg sourceSha "$source_sha" '
      .schemaVersion == 1
      and .suite == "combo-six-area-live-attestation"
      and .status == "passed"
      and .environment == "production"
      and .namespace == "combo"
      and .sourceSha == $sourceSha
      and (.acceptanceWorkflowRunId | type == "number" and . > 0)
      and (.acceptanceWorkflowRunAttempt | type == "number" and . > 0)
      and (.acceptedAt | type == "string" and length > 0)
      and (.identityDigest | test("^sha256:[0-9a-f]{64}$"))
      and (.acceptanceEvidenceDigest | test("^sha256:[0-9a-f]{64}$"))
    ' "$ACCEPTANCE_ATTESTATION" >/dev/null ||
    fail 'Production acceptance attestation does not admit this candidate'
  install -m 0600 "$activation_directory/traffic-evidence.json" \
    "$work/activation-traffic.json"
  install -m 0600 "$activation_directory/release-storage-evidence.json" \
    "$stored_storage"
  traffic_evidence="$work/activation-traffic.json"
  release_storage_evidence="$stored_storage"
  validate_traffic_cleanup_gate
}

validate_live_host_traffic_for_finalize() {
  local formal_config=/etc/nginx/conf.d/happy.conf
  local current_state="$HOME/data/combo-releases/traffic/production/current.json"
  local path unit port expected_service expected_sha main_pid listeners
  [[ "$ENVIRONMENT" == production ]] ||
    fail 'host finalization CAS is restricted to Production'
  for path in "$NGINX_CONFIG" "$formal_config" "$WEB_FORWARD_ENV"; do
    if ! sudo -n test -f "$path" || ! sudo -n test ! -L "$path"; then
      fail "Production host traffic file changed after activation: $path"
    fi
  done
  [[ "$(sudo -n sha256sum "$NGINX_CONFIG" | awk '{print "sha256:" $1}')" == \
    "$(jq -er '.nginx.sha256' "$traffic_evidence")" ]] ||
    fail 'Production canary Nginx changed after activation'
  [[ "$(sudo -n sha256sum "$formal_config" | awk '{print "sha256:" $1}')" == \
    "$(jq -er '.formalNginx.sha256' "$traffic_evidence")" ]] ||
    fail 'Production formal Nginx changed after activation'
  [[ -f "$current_state" && ! -L "$current_state" ]] ||
    fail 'Production host traffic CAS state changed after activation'
  jq -e \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg canarySha "$(jq -er '.nginx.sha256' "$traffic_evidence")" \
    --arg formalSha "$(jq -er '.formalNginx.sha256' "$traffic_evidence")" \
    --arg webService "${PREFIX}web" '
      keys == [
        "canaryNginxSha256",
        "environment",
        "formalNginxSha256",
        "manifestDigest",
        "releaseId",
        "schemaVersion",
        "sourceSha",
        "webService"
      ]
      and .schemaVersion == 1
      and .environment == "production"
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and .canaryNginxSha256 == $canarySha
      and .formalNginxSha256 == $formalSha
      and .webService == $webService
    ' "$current_state" >/dev/null ||
    fail 'Production host traffic CAS state changed after activation'
  [[ "$(sudo -n awk 'END {print NR}' "$WEB_FORWARD_ENV")" == 1 ]] ||
    fail 'Production Web forward environment changed after activation'
  sudo -n grep -Fxq "COMBO_RELEASE_WEB_SERVICE=${PREFIX}web" "$WEB_FORWARD_ENV" ||
    fail 'Production Web forward target changed after activation'

  for unit in "$WEB_FORWARD_UNIT" "$MINIO_FORWARD_UNIT"; do
    if [[ "$unit" == "$WEB_FORWARD_UNIT" ]]; then
      port=$WEB_FORWARD_PORT
      expected_service="${PREFIX}web"
    else
      port=$MINIO_FORWARD_PORT
      expected_service=release-minio
    fi
    expected_sha=$(jq -er \
      --arg name "$unit" \
      --arg service "$expected_service" \
      --argjson port "$port" '
        [.units[]
          | select(.name == $name and .service == $service and .port == $port)] as $matches
        | if ($matches | length) == 1
          then $matches[0].sha256
          else error("unit evidence mismatch")
          end
      ' "$traffic_evidence")
    [[ "$expected_sha" =~ $DIGEST_RE ]] ||
      fail "Production activation unit evidence is invalid: $unit"
    if ! sudo -n test -f "/etc/systemd/system/$unit" ||
      ! sudo -n test ! -L "/etc/systemd/system/$unit"; then
      fail "Production forward unit changed after activation: $unit"
    fi
    [[ "$(sudo -n sha256sum "/etc/systemd/system/$unit" |
      awk '{print "sha256:" $1}')" == "$expected_sha" ]] ||
      fail "Production forward unit changed after activation: $unit"
    if ! sudo -n systemctl is-enabled --quiet "$unit" ||
      ! sudo -n systemctl is-active --quiet "$unit"; then
      fail "Production forward unit is not enabled and active: $unit"
    fi
    main_pid=$(sudo -n systemctl show "$unit" --property=MainPID --value)
    [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] ||
      fail "Production forward unit lacks a main process: $unit"
    listeners=$(sudo -n ss -H -lntp "( sport = :$port )")
    if [[ "$(grep -c . <<<"$listeners" || true)" != 1 ]] ||
      ! grep -Eq "127\\.0\\.0\\.1:${port}[[:space:]].*pid=${main_pid}," \
        <<<"$listeners"; then
      fail "Production forward unit lost its single loopback listener: $unit"
    fi
  done
}

validate_persisted_rollback_checkpoint_for_finalize() {
  local checkpoint_root checkpoint_directory checkpoint checkpoint_digest expected_digest
  local previous_source previous_release previous_service
  local backup_name backup_digest index unit existed previous_deployment
  local checkpoint_status persisted_cleanup cleanup_digest
  checkpoint_root=${COMBO_RELEASE_TRAFFIC_CHECKPOINT_ROOT:-/var/lib/combo-release/traffic-checkpoints}
  checkpoint_directory="$checkpoint_root/production/$release_id"
  checkpoint="$work/finalize-rollback-checkpoint.json"
  [[ "$ENVIRONMENT" == production ]] ||
    fail 'rollback checkpoint finalization gate is restricted to Production'
  if ! sudo -n test -d "$checkpoint_directory" ||
    ! sudo -n test ! -L "$checkpoint_directory" ||
    ! sudo -n test -f "$checkpoint_directory/checkpoint.json" ||
    ! sudo -n test ! -L "$checkpoint_directory/checkpoint.json"; then
    fail 'Production rollback checkpoint is unavailable before finalization'
  fi
  sudo -n cp -- "$checkpoint_directory/checkpoint.json" "$checkpoint"
  sudo -n chown "$(id -u):$(id -g)" "$checkpoint"
  chmod 0600 "$checkpoint"
  checkpoint_digest=$(sha256sum "$checkpoint" | awk '{print "sha256:" $1}')
  checkpoint_status=$(jq -er '.status' "$checkpoint")
  if [[ "$checkpoint_status" == sealed ]]; then
    [[ "$CHECKPOINT_PHASE" == finalizing ]] ||
      fail 'sealed Production traffic checkpoint lacks a finalizing release checkpoint'
    cleanup_plan="$activation_directory/cleanup-plan.json"
    validate_cleanup_plan
    persisted_cleanup="$activation_directory/cleanup-evidence.json"
    validate_cleanup_evidence "$persisted_cleanup"
    verify_cleanup_plan_absent
    cleanup_digest=$(sha256sum "$persisted_cleanup" | awk '{print "sha256:" $1}')
    jq -e \
      --arg sourceSha "$source_sha" \
      --arg releaseId "$release_id" \
      --arg manifestDigest "$MANIFEST_DIGEST" \
      --arg cleanupPlanDigest "$cleanup_plan_digest" \
      --arg cleanupDigest "$cleanup_digest" '
        keys == [
          "activatedAt",
          "armedAt",
          "candidate",
          "cleanupEvidenceDigest",
          "cleanupPlanDigest",
          "environment",
          "finalizingAt",
          "finalizingCheckpointDigest",
          "initialFormalAllowlist",
          "manifestDigest",
          "previous",
          "releaseId",
          "schemaVersion",
          "sealedAt",
          "sourceSha",
          "status"
        ]
        and .schemaVersion == 1
        and .status == "sealed"
        and .environment == "production"
        and .sourceSha == $sourceSha
        and .releaseId == $releaseId
        and .manifestDigest == $manifestDigest
        and .cleanupPlanDigest == $cleanupPlanDigest
        and .cleanupEvidenceDigest == $cleanupDigest
        and (.finalizingAt | type == "string" and length > 0)
        and (.finalizingCheckpointDigest | test("^sha256:[0-9a-f]{64}$"))
        and (.sealedAt | type == "string" and length > 0)
      ' "$checkpoint" >/dev/null ||
      fail 'sealed Production traffic checkpoint does not match cleanup evidence'
    return
  fi
  [[ "$checkpoint_status" == activated || "$checkpoint_status" == finalizing ]] ||
    fail 'Production traffic checkpoint is not valid for finalization'
  if [[ "$checkpoint_status" == activated ]]; then
    expected_digest=$(jq -er '.rollback.checkpointDigest' "$traffic_evidence")
    [[ "$checkpoint_digest" == "$expected_digest" ]] ||
      fail 'Production rollback checkpoint changed after activation'
  else
    [[ "$CHECKPOINT_PHASE" == finalizing ]] ||
      fail 'host finalization checkpoint lacks its release checkpoint'
    cleanup_plan="$activation_directory/cleanup-plan.json"
    validate_cleanup_plan
  fi
  jq -e \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg webService "${PREFIX}web" \
    --arg webUnit "$WEB_FORWARD_UNIT" \
    --arg minioUnit "$MINIO_FORWARD_UNIT" \
    --arg checkpointStatus "$checkpoint_status" \
    --arg cleanupPlanDigest "$cleanup_plan_digest" '
      (
        (
          $checkpointStatus == "activated"
          and keys == [
            "activatedAt",
            "armedAt",
            "candidate",
            "environment",
            "initialFormalAllowlist",
            "manifestDigest",
            "previous",
            "releaseId",
            "schemaVersion",
            "sourceSha",
            "status"
          ]
        )
        or
        (
          $checkpointStatus == "finalizing"
          and keys == [
            "activatedAt",
            "armedAt",
            "candidate",
            "cleanupPlanDigest",
            "environment",
            "finalizingAt",
            "initialFormalAllowlist",
            "manifestDigest",
            "previous",
            "releaseId",
            "schemaVersion",
            "sourceSha",
            "status"
          ]
        )
      )
      and .schemaVersion == 1
      and .status == $checkpointStatus
      and .environment == "production"
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and .candidate == {
        webService: $webService,
        canaryNginxSha256: .candidate.canaryNginxSha256,
        formalNginxSha256: .candidate.formalNginxSha256
      }
      and (.candidate.canaryNginxSha256 | test("^sha256:[0-9a-f]{64}$"))
      and (.candidate.formalNginxSha256 | test("^sha256:[0-9a-f]{64}$"))
      and (.initialFormalAllowlist | type == "boolean")
      and (.armedAt | type == "string" and length > 0)
      and (.activatedAt | type == "string" and length > 0)
      and (
        if $checkpointStatus == "finalizing" then
          .cleanupPlanDigest == $cleanupPlanDigest
          and (.finalizingAt | type == "string" and length > 0)
        else true end
      )
      and (.previous | keys) == [
        "canaryMode",
        "canaryNginxSha256",
        "files",
        "formalMode",
        "formalNginxSha256",
        "manifestDigest",
        "releaseId",
        "sourceSha",
        "units",
        "webService"
      ]
      and (.previous.canaryMode == "legacy" or .previous.canaryMode == "release")
      and (.previous.formalMode == "legacy" or .previous.formalMode == "release")
      and (.previous.canaryNginxSha256 | test("^sha256:[0-9a-f]{64}$"))
      and (.previous.formalNginxSha256 | test("^sha256:[0-9a-f]{64}$"))
      and (
        (
          .previous.sourceSha == null
          and .previous.releaseId == null
          and .previous.manifestDigest == null
          and .previous.webService == null
        )
        or
        (
          (.previous.sourceSha | test("^[0-9a-f]{40}$"))
          and .previous.releaseId == ("release-" + .previous.sourceSha)
          and (.previous.manifestDigest | test("^sha256:[0-9a-f]{64}$"))
          and .previous.webService == ("release-" + .previous.sourceSha[0:12] + "-web")
        )
      )
      and (.previous.files | keys) == [
        "canaryNginx",
        "formalNginx",
        "webEnvironment"
      ]
      and .previous.files.canaryNginx.name == "nginx-canary.before"
      and (.previous.files.canaryNginx.sha256 | test("^sha256:[0-9a-f]{64}$"))
      and .previous.files.formalNginx.name == "nginx-formal.before"
      and (.previous.files.formalNginx.sha256 | test("^sha256:[0-9a-f]{64}$"))
      and (
        if .previous.webService == null then
          .previous.files.webEnvironment == null
        else
          .previous.files.webEnvironment.name == "web-env.before"
          and (.previous.files.webEnvironment.sha256 | test("^sha256:[0-9a-f]{64}$"))
        end
      )
      and (.previous.units | length) == 2
      and [.previous.units[].name] == [$webUnit, $minioUnit]
      and all(.previous.units[];
        (.existed | type == "boolean")
        and (.active | type == "boolean")
        and (.enabled | type == "boolean")
        and (.sha256 | test("^sha256:[0-9a-f]{64}$"))
        and (
          (.existed == true and (.backupFile | test("^unit-[01]\\.before$")))
          or
          (.existed == false and .backupFile == null)
        ))
    ' "$checkpoint" >/dev/null ||
    fail 'Production rollback checkpoint contract changed after activation'

  for backup_name in nginx-canary.before nginx-formal.before; do
    backup_digest=$(jq -er --arg name "$backup_name" '
      if $name == "nginx-canary.before"
      then .previous.files.canaryNginx.sha256
      else .previous.files.formalNginx.sha256
      end
    ' "$checkpoint")
    if ! sudo -n test -f "$checkpoint_directory/$backup_name" ||
      ! sudo -n test ! -L "$checkpoint_directory/$backup_name"; then
      fail "Production rollback backup is unavailable: $backup_name"
    fi
    [[ "$(sudo -n sha256sum "$checkpoint_directory/$backup_name" |
      awk '{print "sha256:" $1}')" == "$backup_digest" ]] ||
      fail "Production rollback backup changed: $backup_name"
  done

  if jq -e '.previous.files.webEnvironment != null' "$checkpoint" >/dev/null; then
    backup_name=web-env.before
    backup_digest=$(jq -er '.previous.files.webEnvironment.sha256' "$checkpoint")
    if ! sudo -n test -f "$checkpoint_directory/$backup_name" ||
      ! sudo -n test ! -L "$checkpoint_directory/$backup_name"; then
      fail "Production rollback backup is unavailable: $backup_name"
    fi
    [[ "$(sudo -n sha256sum "$checkpoint_directory/$backup_name" |
      awk '{print "sha256:" $1}')" == "$backup_digest" ]] ||
      fail "Production rollback backup changed: $backup_name"
  else
    sudo -n test ! -e "$checkpoint_directory/web-env.before" ||
      fail 'Production rollback checkpoint has an unexpected Web environment backup'
  fi

  for index in 0 1; do
    unit=$(jq -er ".previous.units[$index].name" "$checkpoint")
    existed=$(jq -r ".previous.units[$index].existed" "$checkpoint")
    if [[ "$existed" == true ]]; then
      backup_name=$(jq -er ".previous.units[$index].backupFile" "$checkpoint")
      [[ "$backup_name" == "unit-$index.before" ]] ||
        fail "Production rollback unit backup name changed: $unit"
      backup_digest=$(jq -er ".previous.units[$index].sha256" "$checkpoint")
      if ! sudo -n test -f "$checkpoint_directory/$backup_name" ||
        ! sudo -n test ! -L "$checkpoint_directory/$backup_name"; then
        fail "Production rollback unit backup is unavailable: $unit"
      fi
      [[ "$(sudo -n sha256sum "$checkpoint_directory/$backup_name" |
        awk '{print "sha256:" $1}')" == "$backup_digest" ]] ||
        fail "Production rollback unit backup changed: $unit"
    else
      sudo -n test ! -e "$checkpoint_directory/unit-$index.before" ||
      fail "Production rollback checkpoint has an unexpected unit backup: $unit"
    fi
  done

  if [[ "$CHECKPOINT_PHASE" == finalizing ]]; then
    return
  fi
  [[ "$CHECKPOINT_PHASE" == post-cut ]] ||
    fail 'Production rollback target can be admitted only before cleanup starts'
  previous_source=$(jq -r '.previous.sourceSha // ""' "$checkpoint")
  previous_release=$(jq -r '.previous.releaseId // ""' "$checkpoint")
  previous_service=$(jq -r '.previous.webService // ""' "$checkpoint")
  if [[ -n "$previous_source" ]]; then
    previous_deployment="$work/finalize-previous-deployment.json"
    "${K[@]}" -n "$NAMESPACE" get "deployment/$previous_service" \
      -o json >"$previous_deployment"
    jq -e \
      --arg sourceSha "$previous_source" \
      --arg releaseId "$previous_release" '
        .spec.template.metadata.annotations["combo.build/source-sha"] == $sourceSha
        and .spec.template.metadata.annotations["combo.build/release-id"] == $releaseId
        and (.spec.replicas | type == "number" and . > 0)
        and .status.readyReplicas == .spec.replicas
      ' "$previous_deployment" >/dev/null ||
      fail 'previous Production release is not rollback-ready'
    "${K[@]}" -n "$NAMESPACE" get "service/$previous_service" -o json |
      jq -e --arg service "$previous_service" '
        .spec.selector == {
          app: $service,
          "combo.build/release-track": "release-v1"
        }
      ' >/dev/null ||
      fail 'previous Production release Service is not rollback-ready'
  else
    curl --fail --silent --show-error --max-time 10 \
      "http://127.0.0.1:$LEGACY_WEB_PORT/" >/dev/null ||
      fail 'legacy Production Web target is not rollback-ready'
  fi
}

validate_activation_directory_for_removal() {
  local file
  [[ -d "$activation_directory" && ! -L "$activation_directory" ]] ||
    fail 'Production activation cleanup target is unsafe'
  for file in release.json release.sha256 migration-files.txt web-asset-manifest.json \
    foundation.yaml init.yaml migrate.yaml apps.yaml traffic-evidence.json \
    release-storage-evidence.json activation-evidence.json SHA256SUMS; do
    [[ -f "$activation_directory/$file" &&
      ! -L "$activation_directory/$file" ]] ||
      fail "Production activation cleanup target lacks $file"
  done
  if [[ -n "$FOUNDATION_RESET_EVIDENCE" ]]; then
    [[ -f "$activation_directory/foundation-reset-evidence.json" &&
      ! -L "$activation_directory/foundation-reset-evidence.json" ]] ||
      fail 'Production activation cleanup target lost reset evidence'
    [[ "$(sha256sum "$activation_directory/foundation-reset-evidence.json" |
      awk '{print "sha256:" $1}')" == "$foundation_reset_digest" ]] ||
      fail 'Production activation cleanup reset evidence changed'
  else
    [[ ! -e "$activation_directory/foundation-reset-evidence.json" &&
      ! -L "$activation_directory/foundation-reset-evidence.json" ]] ||
      fail 'Production activation cleanup target has unexpected reset evidence'
  fi
  validate_reset_roll_forward_copy \
    "$activation_directory" 'Production activation cleanup target'
  (
    cd "$activation_directory"
    sha256sum --quiet -c SHA256SUMS
  ) || fail 'Production activation cleanup target digest set changed'
  cmp -s "$MANIFEST" "$activation_directory/release.json" ||
    fail 'Production activation cleanup target identifies another manifest'
  [[ "$(tr -d '\n' <"$activation_directory/release.sha256")" == \
    "$MANIFEST_DIGEST" ]] ||
    fail 'Production activation cleanup target manifest digest changed'
  jq -e \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" '
      .schemaVersion == 1
      and .status == "awaiting-acceptance"
      and .environment == "production"
      and .namespace == "combo"
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
    ' "$activation_directory/activation-evidence.json" >/dev/null ||
    fail 'Production activation cleanup target identity changed'
}

validate_live_candidate_for_finalize() {
  local name expected desired actual_migrations public_version stored_storage deployment_json
  stored_storage=$release_storage_evidence
  validate_live_release_storage
  jq -e --slurpfile expected "$stored_storage" '. == $expected[0]' \
    "$release_storage_evidence" >/dev/null ||
    fail 'Production release storage changed after activation'
  for name in api worker runtime web; do
    expected=$(expected_image "$name")
    deployment_json="$work/finalize-${name}-deployment.json"
    "${K[@]}" -n "$NAMESPACE" get "deployment/${PREFIX}${name}" \
      -o json >"$deployment_json"
    jq -e --arg image "$expected" '
      (.spec.template.spec.containers | length) == 1
      and .spec.template.spec.containers[0].image == $image
      and ((.spec.template.spec.initContainers // []) | length) == 0
      and ((.spec.template.spec.ephemeralContainers // []) | length) == 0
      and (.spec.replicas | type == "number" and . > 0 and floor == .)
      and .status.readyReplicas == .spec.replicas
      and .status.updatedReplicas == .spec.replicas
      and .status.availableReplicas == .spec.replicas
    ' "$deployment_json" >/dev/null ||
      fail "Production ${PREFIX}${name} is no longer ready"
    desired=$(jq -er '.spec.replicas' "$deployment_json")
    "${K[@]}" -n "$NAMESPACE" get pods \
      -l "combo.build/release-track=release-v1,app=${PREFIX}${name}" -o json |
      jq -e --arg image "$expected" --argjson desired "$desired" '
        [.items[] | select(.metadata.deletionTimestamp == null)] as $pods
        | ($pods | length) == $desired
        and all($pods[];
          (.spec.containers | length) == 1
          and .spec.containers[0].image == $image
          and ((.spec.initContainers // []) | length) == 0
          and ((.spec.ephemeralContainers // []) | length) == 0
          and (.status.containerStatuses | length) == 1
          and all(.status.containerStatuses[];
            .ready == true
            and ((.imageID | sub("^docker-pullable://"; "") | sub("^docker://"; ""))
              == $image)))
      ' >/dev/null ||
      fail "Production ${PREFIX}${name} live digest changed after activation"
  done
  actual_migrations="$work/finalize-migrations.txt"
  # Credentials expand only inside the PostgreSQL container.
  # shellcheck disable=SC2016
  "${K[@]}" -n "$NAMESPACE" exec release-postgres-0 -- sh -euc '
    export PGPASSWORD="$POSTGRES_PASSWORD"
    psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At \
      -c "SELECT filename FROM schema_migrations ORDER BY filename"
  ' >"$actual_migrations"
  cmp -s "$MIGRATIONS" "$actual_migrations" ||
    fail 'Production migration ledger changed after activation'
  verify_release_schema_structure
  [[ "$schema_structure_digest" == \
    "$(jq -er '.schemaStructureProofDigest' \
      "$activation_directory/activation-evidence.json")" ]] ||
    fail 'Production schema structure changed after activation'
  validate_live_host_traffic_for_finalize
  validate_persisted_rollback_checkpoint_for_finalize
  candidate_is_active_traffic ||
    fail 'Production candidate is no longer the active release traffic'
  public_version="$work/finalize-public-version.json"
  curl --fail --silent --show-error --max-time 20 \
    https://buildwithcombo.com/version.json >"$public_version"
  metadata_matches "$public_version" ||
    fail 'formal Production domain changed after acceptance'
  curl --fail --silent --show-error --max-time 20 \
    "$S3_ORIGIN/minio/health/ready" >/dev/null ||
    fail 'Production S3 changed after acceptance'
}

rollback_host_traffic() {
  rollback_evidence=$rollback_pending_evidence
  "$SCRIPT_DIR/rollback-release-traffic.sh" \
    --manifest "$MANIFEST" \
    --manifest-digest "$MANIFEST_DIGEST" \
    --evidence-output "$rollback_evidence"
  jq -e \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" '
      .schemaVersion == 1
      and .status == "passed"
      and .environment == "production"
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and .checks.activeCas == true
      and .checks.previousTargetAvailable == true
      and .checks.unitsRestored == true
      and .checks.nginxRestored == true
      and .checks.publicWebRestored == true
    ' "$rollback_evidence" >/dev/null ||
    fail 'host traffic rollback evidence is invalid'
}

load_host_rollback_status() {
  local checkpoint_root checkpoint_host checkpoint_copy traffic_lock rollback_journal
  checkpoint_root=${COMBO_RELEASE_TRAFFIC_CHECKPOINT_ROOT:-/var/lib/combo-release/traffic-checkpoints}
  checkpoint_host="$checkpoint_root/production/$release_id/checkpoint.json"
  rollback_journal="$checkpoint_root/production/$release_id/rollback-in-progress.json"
  checkpoint_copy="$work/rollback-host-status.json"
  traffic_lock=${COMBO_RELEASE_TRAFFIC_LOCK:-"$HOME/data/combo-release-traffic.lock"}
  install -d -m 0750 "$(dirname "$traffic_lock")"
  exec 8>"$traffic_lock"
  flock -n 8 || fail 'another release traffic transaction is running'
  if ! sudo -n test -f "$checkpoint_host" ||
    ! sudo -n test ! -L "$checkpoint_host"; then
    fail 'Production rollback host checkpoint is missing'
  fi
  sudo -n cp -- "$checkpoint_host" "$checkpoint_copy"
  sudo -n chown "$(id -u):$(id -g)" "$checkpoint_copy"
  chmod 0600 "$checkpoint_copy"
  HOST_ROLLBACK_JOURNAL_PRESENT=0
  for journal_path in "$rollback_journal" "${rollback_journal}.staging"; do
    if sudo -n test -e "$journal_path"; then
      if ! sudo -n test -f "$journal_path" ||
        ! sudo -n test ! -L "$journal_path"; then
        fail 'Production rollback journal path is unsafe'
      fi
      HOST_ROLLBACK_JOURNAL_PRESENT=1
    fi
  done
  flock -u 8
  exec 8>&-
  jq -e \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" '
      .schemaVersion == 1
      and (.status == "armed"
        or .status == "activated"
        or .status == "rolled-back")
      and .environment == "production"
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
    ' "$checkpoint_copy" >/dev/null ||
    fail 'Production rollback host checkpoint identity changed'
  HOST_ROLLBACK_STATUS=$(jq -er '.status' "$checkpoint_copy")
}

validate_completed_host_rollback() {
  local validation_mode=${1:-converge}
  local expected_rollback_evidence=${2:-}
  local checkpoint_root checkpoint checkpoint_host checkpoint_digest current_state
  local checkpoint_status checkpoint_stage current_stage
  local previous_source previous_release rolled_back_at evidence_stage
  local previous_manifest previous_service previous_formal_mode verification_origin
  local traffic_lock activation_traffic activated_checkpoint_digest
  local rollback_journal rollback_journal_copy
  local index unit existed expected_active expected_enabled actual_active actual_enabled
  local expected_unit_sha port main_pid listener_lines
  checkpoint_root=${COMBO_RELEASE_TRAFFIC_CHECKPOINT_ROOT:-/var/lib/combo-release/traffic-checkpoints}
  checkpoint_host="$checkpoint_root/production/$release_id/checkpoint.json"
  rollback_journal="$checkpoint_root/production/$release_id/rollback-in-progress.json"
  rollback_journal_copy="$work/rollback-in-progress.current.json"
  checkpoint="$work/rollback-checkpoint.current.json"
  current_state="${COMBO_RELEASE_TRAFFIC_STATE_ROOT:-"$HOME/data/combo-releases/traffic"}/production/current.json"
  traffic_lock=${COMBO_RELEASE_TRAFFIC_LOCK:-"$HOME/data/combo-release-traffic.lock"}
  install -d -m 0750 "$(dirname "$traffic_lock")"
  exec 8>"$traffic_lock"
  flock -n 8 || fail 'another release traffic transaction is running'
  if ! sudo -n test -f "$checkpoint_host" ||
    ! sudo -n test ! -L "$checkpoint_host"; then
    fail 'persisted host rollback checkpoint is missing'
  fi
  sudo -n cp -- "$checkpoint_host" "$checkpoint"
  sudo -n chown "$(id -u):$(id -g)" "$checkpoint"
  chmod 0600 "$checkpoint"
  jq -e \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" '
      .schemaVersion == 1
      and (.status == "activated" or .status == "rolled-back")
      and .environment == "production"
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and (
        (.status == "activated" and .rolledBackAt == null)
        or
        (.status == "rolled-back"
          and (.rolledBackAt | type == "string" and length > 0))
      )
    ' "$checkpoint" >/dev/null ||
    fail 'host rollback checkpoint does not match the candidate'
  checkpoint_status=$(jq -er '.status' "$checkpoint")
  if [[ "$validation_mode" == read-only ]]; then
    [[ "$checkpoint_status" == rolled-back ]] ||
      fail 'completed rollback root checkpoint is not rolled back'
    if ! sudo -n test ! -e "$rollback_journal" ||
      ! sudo -n test ! -e "${rollback_journal}.staging" ||
      ! sudo -n test ! -e "${checkpoint_host}.staging"; then
      fail 'completed rollback retains an incomplete host transaction'
    fi
    [[ -f "$expected_rollback_evidence" &&
      ! -L "$expected_rollback_evidence" ]] ||
      fail 'completed rollback lacks its immutable host evidence'
  elif [[ "$validation_mode" != converge ]]; then
    fail 'invalid host rollback validation mode'
  fi
  if [[ "$checkpoint_status" == activated ]] ||
    sudo -n test -e "$rollback_journal"; then
    activation_traffic="$activation_directory/traffic-evidence.json"
    [[ -d "$activation_directory" && ! -L "$activation_directory" &&
      -f "$activation_traffic" && ! -L "$activation_traffic" &&
      -f "$activation_directory/SHA256SUMS" &&
      ! -L "$activation_directory/SHA256SUMS" ]] ||
      fail 'activated Production rollback recovery lacks durable activation evidence'
    (
      cd "$activation_directory"
      sha256sum --quiet -c SHA256SUMS
    ) || fail 'Production activation evidence changed before rollback recovery'
    if [[ "$checkpoint_status" == activated ]]; then
      activated_checkpoint_digest=$(sha256sum "$checkpoint" |
        awk '{print "sha256:" $1}')
    else
      activated_checkpoint_digest=$(jq -er '.rollback.checkpointDigest' \
        "$activation_traffic")
      [[ "$activated_checkpoint_digest" =~ $DIGEST_RE ]] ||
        fail 'Production activation checkpoint digest is invalid'
    fi
    jq -e \
      --arg sourceSha "$source_sha" \
      --arg releaseId "$release_id" \
      --arg manifestDigest "$MANIFEST_DIGEST" \
      --arg checkpointDigest "$activated_checkpoint_digest" '
        .schemaVersion == 1
        and .environment == "production"
        and .sourceSha == $sourceSha
        and .releaseId == $releaseId
        and .manifestDigest == $manifestDigest
        and .rollback.checkpointId == $releaseId
        and .rollback.checkpointDigest == $checkpointDigest
        and .rollback.persisted == true
      ' "$activation_traffic" >/dev/null ||
      fail 'activated Production rollback checkpoint is not bound to activation evidence'
  fi
  if sudo -n test -e "$rollback_journal"; then
    if ! sudo -n test -f "$rollback_journal" ||
      ! sudo -n test ! -L "$rollback_journal"; then
      fail 'Production rollback journal is unsafe'
    fi
    sudo -n cp -- "$rollback_journal" "$rollback_journal_copy"
    sudo -n chown "$(id -u):$(id -g)" "$rollback_journal_copy"
    chmod 0600 "$rollback_journal_copy"
    jq -e \
      --arg sourceSha "$source_sha" \
      --arg releaseId "$release_id" \
      --arg manifestDigest "$MANIFEST_DIGEST" \
      --arg checkpointDigest \
        "$(jq -er '.rollback.checkpointDigest' "$activation_traffic")" '
        keys == [
          "checkpointDigest",
          "direction",
          "environment",
          "manifestDigest",
          "releaseId",
          "schemaVersion",
          "sourceSha",
          "startedAt",
          "status"
        ]
        and .schemaVersion == 1
        and .status == "in-progress"
        and .direction == "rollback"
        and .environment == "production"
        and .sourceSha == $sourceSha
        and .releaseId == $releaseId
        and .manifestDigest == $manifestDigest
        and .checkpointDigest == $checkpointDigest
        and (.startedAt | type == "string" and length > 0)
      ' "$rollback_journal_copy" >/dev/null ||
      fail 'Production rollback journal does not match activation evidence'
  fi
  [[ "$(sudo -n sha256sum /etc/nginx/conf.d/zz-agora-demo.conf |
    awk '{print "sha256:" $1}')" == \
    "$(jq -er '.previous.files.canaryNginx.sha256' "$checkpoint")" ]] ||
    fail 'rolled-back Production canary Nginx changed'
  [[ "$(sudo -n sha256sum /etc/nginx/conf.d/happy.conf |
    awk '{print "sha256:" $1}')" == \
    "$(jq -er '.previous.files.formalNginx.sha256' "$checkpoint")" ]] ||
    fail 'rolled-back Production formal Nginx changed'

  previous_source=$(jq -r '.previous.sourceSha // ""' "$checkpoint")
  previous_release=$(jq -r '.previous.releaseId // ""' "$checkpoint")
  previous_manifest=$(jq -r '.previous.manifestDigest // ""' "$checkpoint")
  previous_service=$(jq -r '.previous.webService // ""' "$checkpoint")
  previous_formal_mode=$(jq -er '.previous.formalMode' "$checkpoint")

  for index in 0 1; do
    if ((index == 0)); then
      unit=$WEB_FORWARD_UNIT
      port=$WEB_FORWARD_PORT
    else
      unit=$MINIO_FORWARD_UNIT
      port=$MINIO_FORWARD_PORT
    fi
    existed=$(jq -r --arg name "$unit" '
      first(.previous.units[] | select(.name == $name) | .existed)
    ' "$checkpoint")
    expected_active=$(jq -r --arg name "$unit" '
      first(.previous.units[] | select(.name == $name) | .active)
    ' "$checkpoint")
    expected_enabled=$(jq -r --arg name "$unit" '
      first(.previous.units[] | select(.name == $name) | .enabled)
    ' "$checkpoint")
    [[ "$existed" == true || "$existed" == false ]] ||
      fail "rolled-back Production forward unit existence is invalid: $unit"
    [[ "$expected_active" == true || "$expected_active" == false ]] ||
      fail "rolled-back Production forward unit activity is invalid: $unit"
    [[ "$expected_enabled" == true || "$expected_enabled" == false ]] ||
      fail "rolled-back Production forward unit enablement is invalid: $unit"
    actual_active=false
    actual_enabled=false
    sudo -n systemctl is-active --quiet "$unit" && actual_active=true
    sudo -n systemctl is-enabled --quiet "$unit" && actual_enabled=true
    [[ "$actual_active" == "$expected_active" &&
      "$actual_enabled" == "$expected_enabled" ]] ||
      fail "rolled-back Production forward unit state changed: $unit"
    if [[ "$existed" == true ]]; then
      if ! sudo -n test -f "/etc/systemd/system/$unit" ||
        ! sudo -n test ! -L "/etc/systemd/system/$unit"; then
        fail "rolled-back Production forward unit changed: $unit"
      fi
      expected_unit_sha=$(jq -er --arg name "$unit" '
        first(.previous.units[] | select(.name == $name) | .sha256)
      ' "$checkpoint")
      [[ "$(sudo -n sha256sum "/etc/systemd/system/$unit" |
        awk '{print "sha256:" $1}')" == "$expected_unit_sha" ]] ||
        fail "rolled-back Production forward unit changed: $unit"
    else
      sudo -n test ! -e "/etc/systemd/system/$unit" ||
        fail "rolled-back Production forward unit unexpectedly exists: $unit"
    fi
    listener_lines=$(sudo -n ss -H -lntp "( sport = :$port )")
    if [[ "$expected_active" == true ]]; then
      main_pid=$(sudo -n systemctl show "$unit" --property=MainPID --value)
      [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] ||
        fail "rolled-back Production forward unit lacks a main process: $unit"
      if [[ "$(grep -c . <<<"$listener_lines" || true)" != 1 ]] ||
        ! grep -Eq "127\\.0\\.0\\.1:${port}[[:space:]].*pid=${main_pid}," \
          <<<"$listener_lines"; then
        fail "rolled-back Production forward unit lost its loopback listener: $unit"
      fi
    else
      [[ -z "$listener_lines" ]] ||
        fail "rolled-back inactive Production unit owns a listener: $unit"
    fi
  done

  if [[ -n "$previous_source" ]]; then
    [[ "$TRAFFIC_MODE" == release && "$ACTIVE_RELEASE_WEB" == "$previous_service" ]] ||
      fail 'rolled-back Production route no longer targets the previous release'
    if ! sudo -n test -f "$WEB_FORWARD_ENV" ||
      ! sudo -n test ! -L "$WEB_FORWARD_ENV"; then
      fail 'rolled-back Production Web forward environment changed'
    fi
    [[ "$(sudo -n awk 'END {print NR}' "$WEB_FORWARD_ENV")" == 1 ]] ||
      fail 'rolled-back Production Web forward environment changed'
    sudo -n grep -Fxq "COMBO_RELEASE_WEB_SERVICE=$previous_service" \
      "$WEB_FORWARD_ENV" ||
      fail 'rolled-back Production Web forward environment changed'
    if [[ -e "$current_state" ]]; then
      [[ -f "$current_state" && ! -L "$current_state" ]] ||
        fail 'rolled-back Production traffic state is not a regular file'
      jq -e \
        --arg validationMode "$validation_mode" \
        --slurpfile checkpoint "$checkpoint" '
          .schemaVersion == 1
          and .environment == "production"
          and (
            (
              .sourceSha == $checkpoint[0].previous.sourceSha
              and .releaseId == $checkpoint[0].previous.releaseId
              and .manifestDigest == $checkpoint[0].previous.manifestDigest
              and .canaryNginxSha256 ==
                $checkpoint[0].previous.canaryNginxSha256
              and .formalNginxSha256 ==
                $checkpoint[0].previous.formalNginxSha256
              and .webService == $checkpoint[0].previous.webService
            )
            or
            (
              $validationMode == "converge"
              and
              .sourceSha == $checkpoint[0].sourceSha
              and .releaseId == $checkpoint[0].releaseId
              and .manifestDigest == $checkpoint[0].manifestDigest
              and .canaryNginxSha256 ==
                $checkpoint[0].candidate.canaryNginxSha256
              and .formalNginxSha256 ==
                $checkpoint[0].candidate.formalNginxSha256
              and .webService == $checkpoint[0].candidate.webService
            )
          )
        ' "$current_state" >/dev/null ||
        fail 'rolled-back Production traffic state is neither candidate nor predecessor'
    elif [[ "$validation_mode" == read-only ]]; then
      fail 'completed Production rollback is missing predecessor traffic state'
    fi
    if [[ "$previous_formal_mode" == release ]]; then
      verification_origin=https://buildwithcombo.com
    else
      verification_origin=https://agora.43-160-242-46.sslip.io
    fi
    curl --fail --silent --show-error --max-time 20 \
      "$verification_origin/version.json" >"$work/rollback-retry-version.json"
    jq -e \
      --arg sourceSha "$previous_source" \
      --arg releaseId "$previous_release" \
      --arg manifestDigest "$previous_manifest" '
        .sourceSha == $sourceSha
        and .releaseId == $releaseId
        and .releaseManifestDigest == $manifestDigest
      ' "$work/rollback-retry-version.json" >/dev/null ||
      fail 'rolled-back previous Production release is no longer live'
  else
    [[ "$TRAFFIC_MODE" == legacy && -z "$ACTIVE_RELEASE_WEB" ]] ||
      fail 'rolled-back Production route no longer targets the legacy release'
    if [[ -e "$current_state" ]]; then
      [[ "$validation_mode" == converge ]] ||
        fail 'completed legacy rollback retained a candidate traffic state'
      [[ -f "$current_state" && ! -L "$current_state" ]] ||
        fail 'rolled-back legacy Production traffic state is not a regular file'
      jq -e \
        --slurpfile checkpoint "$checkpoint" '
          .schemaVersion == 1
          and .environment == "production"
          and .sourceSha == $checkpoint[0].sourceSha
          and .releaseId == $checkpoint[0].releaseId
          and .manifestDigest == $checkpoint[0].manifestDigest
          and .canaryNginxSha256 ==
            $checkpoint[0].candidate.canaryNginxSha256
          and .formalNginxSha256 ==
            $checkpoint[0].candidate.formalNginxSha256
          and .webService == $checkpoint[0].candidate.webService
        ' "$current_state" >/dev/null ||
        fail 'rolled-back legacy Production traffic state is not the candidate'
    fi
    sudo -n test ! -e "$WEB_FORWARD_ENV" ||
      fail 'rolled-back legacy Production retained a release Web forward target'
    curl --fail --silent --show-error --max-time 20 \
      https://agora.43-160-242-46.sslip.io/ >/dev/null ||
      fail 'rolled-back legacy Production canary is no longer live'
  fi
  curl --fail --silent --show-error --max-time 20 \
    "$S3_ORIGIN/minio/health/ready" >/dev/null ||
    fail 'rolled-back Production S3 is no longer ready'

  if [[ "$validation_mode" == read-only ]]; then
    checkpoint_digest=$(sha256sum "$checkpoint" | awk '{print "sha256:" $1}')
    jq -e \
      --arg sourceSha "$source_sha" \
      --arg releaseId "$release_id" \
      --arg manifestDigest "$MANIFEST_DIGEST" \
      --arg checkpointDigest "$checkpoint_digest" \
      --arg previousSourceSha "$previous_source" \
      --arg previousReleaseId "$previous_release" \
      --arg rolledBackAt "$(jq -er '.rolledBackAt' "$checkpoint")" '
        .schemaVersion == 1
        and .status == "passed"
        and .environment == "production"
        and .sourceSha == $sourceSha
        and .releaseId == $releaseId
        and .manifestDigest == $manifestDigest
        and .checkpointDigest == $checkpointDigest
        and .restoredSourceSha ==
          (if $previousSourceSha == "" then null else $previousSourceSha end)
        and .restoredReleaseId ==
          (if $previousReleaseId == "" then null else $previousReleaseId end)
        and .rolledBackAt == $rolledBackAt
        and .checks == {
          activeCas: true,
          previousTargetAvailable: true,
          unitsRestored: true,
          nginxRestored: true,
          publicWebRestored: true
        }
      ' "$expected_rollback_evidence" >/dev/null ||
      fail 'completed rollback host evidence no longer matches root state'
    rollback_evidence=$expected_rollback_evidence
    flock -u 8
    exec 8>&-
    return
  fi

  if [[ "$checkpoint_status" == activated ]]; then
    rolled_back_at=$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')
    checkpoint_stage=$(mktemp "$work/rollback-checkpoint.XXXXXX")
    jq --arg rolledBackAt "$rolled_back_at" '
      .status = "rolled-back"
      | .rolledBackAt = $rolledBackAt
    ' "$checkpoint" >"$checkpoint_stage"
    chmod 0600 "$checkpoint_stage"
    atomic_root_install "$checkpoint_stage" "$checkpoint_host" 0600
    install -m 0600 "$checkpoint_stage" "$checkpoint"
    checkpoint_status=rolled-back
  else
    rolled_back_at=$(jq -er '.rolledBackAt' "$checkpoint")
  fi
  checkpoint_digest=$(sha256sum "$checkpoint" | awk '{print "sha256:" $1}')
  [[ "$(sudo -n sha256sum "$checkpoint_host" | awk '{print "sha256:" $1}')" == \
    "$checkpoint_digest" ]] ||
    fail 'rolled-back Production checkpoint commit could not be confirmed'

  if [[ -n "$previous_source" ]]; then
    current_stage=$(mktemp "$(dirname "$current_state")/.rollback-current.XXXXXX")
    jq -n \
      --arg sourceSha "$previous_source" \
      --arg releaseId "$previous_release" \
      --arg manifestDigest "$previous_manifest" \
      --arg canarySha "$(jq -er '.previous.canaryNginxSha256' "$checkpoint")" \
      --arg formalSha "$(jq -er '.previous.formalNginxSha256' "$checkpoint")" \
      --arg webService "$previous_service" '{
        schemaVersion: 1,
        environment: "production",
        sourceSha: $sourceSha,
        releaseId: $releaseId,
        manifestDigest: $manifestDigest,
        canaryNginxSha256: $canarySha,
        formalNginxSha256: $formalSha,
        webService: $webService
      }' >"$current_stage"
    chmod 0600 "$current_stage"
    mv -fT "$current_stage" "$current_state"
    jq -e \
      --arg sourceSha "$previous_source" \
      --arg releaseId "$previous_release" \
      --arg manifestDigest "$previous_manifest" \
      --arg webService "$previous_service" '
        .schemaVersion == 1
        and .environment == "production"
        and .sourceSha == $sourceSha
        and .releaseId == $releaseId
        and .manifestDigest == $manifestDigest
        and .webService == $webService
      ' "$current_state" >/dev/null ||
      fail 'rolled-back Production traffic state commit could not be confirmed'
  else
    rm -f -- "$current_state"
    [[ ! -e "$current_state" ]] ||
      fail 'rolled-back legacy Production traffic state could not be removed'
  fi

  if [[ -e "$rollback_pending_evidence" ]]; then
    [[ -f "$rollback_pending_evidence" && ! -L "$rollback_pending_evidence" ]] ||
      fail 'persisted host rollback evidence is not a regular file'
    jq -e \
      --arg sourceSha "$source_sha" \
      --arg releaseId "$release_id" \
      --arg manifestDigest "$MANIFEST_DIGEST" \
      --arg checkpointDigest "$checkpoint_digest" \
      --arg previousSourceSha "$previous_source" \
      --arg previousReleaseId "$previous_release" \
      --arg rolledBackAt "$rolled_back_at" '
        keys == [
          "checkpointDigest",
          "checks",
          "environment",
          "manifestDigest",
          "releaseId",
          "restoredReleaseId",
          "restoredSourceSha",
          "rolledBackAt",
          "schemaVersion",
          "sourceSha",
          "status"
        ]
        and .schemaVersion == 1
        and .status == "passed"
        and .environment == "production"
        and .sourceSha == $sourceSha
        and .releaseId == $releaseId
        and .manifestDigest == $manifestDigest
        and .checkpointDigest == $checkpointDigest
        and .restoredSourceSha ==
          (if $previousSourceSha == "" then null else $previousSourceSha end)
        and .restoredReleaseId ==
          (if $previousReleaseId == "" then null else $previousReleaseId end)
        and .rolledBackAt == $rolledBackAt
        and (.checks | keys) == [
          "activeCas",
          "nginxRestored",
          "previousTargetAvailable",
          "publicWebRestored",
          "unitsRestored"
        ]
        and .checks.activeCas == true
        and .checks.previousTargetAvailable == true
        and .checks.unitsRestored == true
        and .checks.nginxRestored == true
        and .checks.publicWebRestored == true
      ' "$rollback_pending_evidence" >/dev/null ||
      fail 'persisted host rollback evidence is invalid'
  else
    evidence_stage=$(mktemp "$EVIDENCE_ROOT/$ENVIRONMENT/.${release_id}.rollback.XXXXXX")
    jq -n \
      --arg sourceSha "$source_sha" \
      --arg releaseId "$release_id" \
      --arg manifestDigest "$MANIFEST_DIGEST" \
      --arg checkpointDigest "$checkpoint_digest" \
      --arg previousSourceSha "$previous_source" \
      --arg previousReleaseId "$previous_release" \
      --arg rolledBackAt "$rolled_back_at" '{
        schemaVersion: 1,
        status: "passed",
        environment: "production",
        sourceSha: $sourceSha,
        releaseId: $releaseId,
        manifestDigest: $manifestDigest,
        restoredSourceSha:
          (if $previousSourceSha == "" then null else $previousSourceSha end),
        restoredReleaseId:
          (if $previousReleaseId == "" then null else $previousReleaseId end),
        checkpointDigest: $checkpointDigest,
        checks: {
          activeCas: true,
          previousTargetAvailable: true,
          unitsRestored: true,
          nginxRestored: true,
          publicWebRestored: true
        },
        rolledBackAt: $rolledBackAt
      }' >"$evidence_stage"
    chmod 0644 "$evidence_stage"
    mv -fT "$evidence_stage" "$rollback_pending_evidence"
  fi
  rollback_evidence=$rollback_pending_evidence
  if [[ -f "$rollback_journal_copy" ]]; then
    [[ "$(sudo -n sha256sum "$rollback_journal" |
      awk '{print "sha256:" $1}')" == \
      "$(sha256sum "$rollback_journal_copy" | awk '{print "sha256:" $1}')" ]] ||
      fail 'Production rollback journal changed before convergence commit'
    sudo -n rm -f -- "$rollback_journal"
    sudo -n test ! -e "$rollback_journal" ||
      fail 'Production rollback journal could not be retired'
  fi
  flock -u 8
  exec 8>&-
}

build_rollback_cleanup_plan() {
  local name stage binding_stage targets="$work/rollback-cleanup-targets.jsonl"
  : >"$targets"
  cleanup_targets=$targets
  append_cleanup_plan_target job "$inventory_jobs" "${PREFIX}migrate"
  append_cleanup_plan_target job "$inventory_jobs" "$INIT_JOB"
  for name in api worker runtime web; do
    append_cleanup_plan_target deployment "$inventory_deployments" "${PREFIX}${name}"
  done
  for name in api runtime web; do
    append_cleanup_plan_target service "$inventory_services" "${PREFIX}${name}"
  done
  append_cleanup_plan_target configmap "$inventory_configmaps" "$metadata_name"
  if [[ -n "$routing_name" ]]; then
    append_cleanup_plan_target configmap "$inventory_configmaps" "$routing_name"
  fi
  if ((FOUNDATION_CREATED_THIS_RELEASE == 1)); then
    append_cleanup_plan_target deployment "$inventory_deployments" release-redis-hot
    for name in "${RELEASE_STATEFULSETS[@]}"; do
      append_cleanup_plan_target statefulset "$inventory_statefulsets" "$name"
    done
    for name in "${RELEASE_SERVICES[@]}"; do
      append_cleanup_plan_target service "$inventory_services" "$name"
    done
    for name in "${RELEASE_CONFIGMAPS[@]}"; do
      append_cleanup_plan_target configmap "$inventory_configmaps" "$name"
    done
    for name in "${RELEASE_CLAIMS[@]}"; do
      append_cleanup_plan_target pvc "$inventory_pvcs" "$name"
    done
  fi

  stage=$(mktemp "$EVIDENCE_ROOT/$ENVIRONMENT/.${release_id}.rollback-plan.XXXXXX")
  jq -s \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg plannedAt "$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')" \
    --argjson foundationCreated "$(
      ((FOUNDATION_CREATED_THIS_RELEASE == 1)) && printf true || printf false
    )" \
    --slurpfile capturedStorage "$pvc_inventory" '
      (unique_by([.kind, .name]) | sort_by([.kind, .name])) as $targets
      | {
          schemaVersion: 1,
          purpose: "candidate-rollback-cleanup",
          environment: "production",
          namespace: "combo",
          sourceSha: $sourceSha,
          releaseId: $releaseId,
          manifestDigest: $manifestDigest,
          foundationCreated: $foundationCreated,
          targets: $targets,
          targetCount: ($targets | length),
          capturedStorage: ([
            $capturedStorage[]
            | select(. as $storage
              | any($targets[];
                  .kind == "pvc"
                  and .name == $storage.claim
                  and .uid == $storage.claimUid))
          ] | sort_by(.claim)),
          plannedAt: $plannedAt
        }
    ' "$targets" >"$stage"
  chmod 0600 "$stage"
  mv -fT "$stage" "$rollback_cleanup_plan"
  rollback_cleanup_plan_digest=$(sha256sum "$rollback_cleanup_plan" |
    awk '{print "sha256:" $1}')

  binding_stage=$(mktemp \
    "$EVIDENCE_ROOT/$ENVIRONMENT/.${release_id}.rollback-plan-binding.XXXXXX")
  jq -n \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg planDigest "$rollback_cleanup_plan_digest" \
    --arg boundAt "$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')" '{
      schemaVersion: 1,
      status: "pending",
      purpose: "candidate-rollback-cleanup",
      environment: "production",
      namespace: "combo",
      sourceSha: $sourceSha,
      releaseId: $releaseId,
      manifestDigest: $manifestDigest,
      cleanupPlanDigest: $planDigest,
      boundAt: $boundAt
    }' >"$binding_stage"
  chmod 0600 "$binding_stage"
  mv -fT "$binding_stage" "$rollback_cleanup_binding"
}

validate_rollback_cleanup_plan() {
  local expected_foundation
  [[ -f "$rollback_cleanup_plan" && ! -L "$rollback_cleanup_plan" ]] ||
    fail 'Production rollback cleanup plan is missing'
  expected_foundation=$(jq -er '.foundationCreated' "$rollback_cleanup_plan")
  [[ "$expected_foundation" == true || "$expected_foundation" == false ]] ||
    fail 'rollback cleanup plan foundation mode is invalid'
  [[ "$expected_foundation" == true ]] && FOUNDATION_CREATED_THIS_RELEASE=1 ||
    FOUNDATION_CREATED_THIS_RELEASE=0
  rollback_cleanup_plan_digest=$(sha256sum "$rollback_cleanup_plan" |
    awk '{print "sha256:" $1}')
  if [[ -n "$rollback_cleanup_binding" ]]; then
    [[ -f "$rollback_cleanup_binding" && ! -L "$rollback_cleanup_binding" ]] ||
      fail 'Production rollback cleanup binding is missing'
    jq -e \
      --arg sourceSha "$source_sha" \
      --arg releaseId "$release_id" \
      --arg manifestDigest "$MANIFEST_DIGEST" \
      --arg planDigest "$rollback_cleanup_plan_digest" '
        keys == [
          "boundAt",
          "cleanupPlanDigest",
          "environment",
          "manifestDigest",
          "namespace",
          "purpose",
          "releaseId",
          "schemaVersion",
          "sourceSha",
          "status"
        ]
        and .schemaVersion == 1
        and .status == "pending"
        and .purpose == "candidate-rollback-cleanup"
        and .environment == "production"
        and .namespace == "combo"
        and .sourceSha == $sourceSha
        and .releaseId == $releaseId
        and .manifestDigest == $manifestDigest
        and .cleanupPlanDigest == $planDigest
        and (.boundAt | type == "string" and length > 0)
      ' "$rollback_cleanup_binding" >/dev/null ||
      fail 'Production rollback cleanup binding changed'
  fi
  jq -e \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg prefix "$PREFIX" \
    --arg metadata "$metadata_name" \
    --arg routing "$routing_name" \
    --arg init "$INIT_JOB" '
      . as $plan
      | keys == [
        "capturedStorage",
        "environment",
        "foundationCreated",
        "manifestDigest",
        "namespace",
        "plannedAt",
        "purpose",
        "releaseId",
        "schemaVersion",
        "sourceSha",
        "targetCount",
        "targets"
      ]
      and .schemaVersion == 1
      and .purpose == "candidate-rollback-cleanup"
      and .environment == "production"
      and .namespace == "combo"
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and (.foundationCreated | type == "boolean")
      and (.plannedAt | type == "string" and length > 0)
      and (.targets | type == "array")
      and (.capturedStorage | type == "array")
      and (.targetCount | type == "number" and floor == . and . >= 0)
      and .targetCount == (.targets | length)
      and ([.targets[] | [.kind, .name]] | unique | length) == .targetCount
      and all(.targets[];
        keys == ["kind", "name", "uid"]
        and (.uid | type == "string" and length > 0
          and test("^[A-Za-z0-9._:-]+$"))
        and (
          (.kind == "deployment"
            and (
              (.name | test("^" + $prefix + "(api|runtime|web|worker)$"))
              or ($plan.foundationCreated and .name == "release-redis-hot")
            ))
          or
          (.kind == "statefulset"
            and $plan.foundationCreated
            and (.name | test("^release-(postgres|redis-queue|minio)$")))
          or
          (.kind == "job"
            and (.name == ($prefix + "migrate") or .name == $init))
          or
          (.kind == "service"
            and (
              (.name | test("^" + $prefix + "(api|runtime|web)$"))
              or
              ($plan.foundationCreated
                and (.name | test("^release-(postgres|redis-queue|redis-hot|minio)$")))
            ))
          or
          (.kind == "configmap"
            and (
              .name == $metadata
              or .name == $routing
              or
              ($plan.foundationCreated
                and (.name
                  | test("^release-(redis-queue-config|redis-hot-config|minio-init-script)$")))
            ))
          or
          (.kind == "pvc"
            and $plan.foundationCreated
            and (.name | test("^data-release-(postgres|redis-queue|minio)-0$")))
        ))
      and all(.capturedStorage[];
        keys == ["claim", "claimUid", "path", "volume", "volumeUid"]
        and (.claim | test("^data-release-(postgres|redis-queue|minio)-0$"))
        and (.claimUid | type == "string" and length > 0)
        and (.volume | type == "string" and length > 0)
        and (.volumeUid | type == "string" and length > 0)
        and (.path | type == "string" and startswith("/")))
      and ([.capturedStorage[].claim] | unique | length)
        == (.capturedStorage | length)
      and (.capturedStorage | length)
        == ([.targets[] | select(.kind == "pvc")] | length)
      and ([.targets[] | select(.kind == "pvc") | [.name, .uid]] | sort)
        == ([.capturedStorage[] | [.claim, .claimUid]] | sort)
    ' "$rollback_cleanup_plan" >/dev/null ||
    fail 'Production rollback cleanup plan is invalid'
  [[ "$(jq -r '.foundationCreated' "$rollback_cleanup_plan")" == \
    "$expected_foundation" ]] ||
    fail 'Production rollback cleanup plan foundation mode changed'
}

materialize_rollback_cleanup_plan() {
  cleanup_plan=$rollback_cleanup_plan
  cleanup_plan_digest=$rollback_cleanup_plan_digest
  materialize_cleanup_plan
}

verify_rollback_candidate_absent() {
  local name foundation_created
  for name in "${PREFIX}api" "${PREFIX}runtime" "${PREFIX}web" "${PREFIX}worker"; do
    ! "${K[@]}" -n "$NAMESPACE" get "deployment/$name" >/dev/null 2>&1 ||
      fail "rolled-back candidate Deployment $name reappeared"
  done
  for name in "${PREFIX}api" "${PREFIX}runtime" "${PREFIX}web"; do
    ! "${K[@]}" -n "$NAMESPACE" get "service/$name" >/dev/null 2>&1 ||
      fail "rolled-back candidate Service $name reappeared"
  done
  for name in "${PREFIX}migrate" "$INIT_JOB"; do
    ! "${K[@]}" -n "$NAMESPACE" get "job/$name" >/dev/null 2>&1 ||
      fail "rolled-back candidate Job $name reappeared"
  done
  ! "${K[@]}" -n "$NAMESPACE" get "configmap/$metadata_name" >/dev/null 2>&1 ||
    fail "rolled-back candidate ConfigMap $metadata_name reappeared"
  if [[ -n "$routing_name" ]]; then
    ! "${K[@]}" -n "$NAMESPACE" get "configmap/$routing_name" >/dev/null 2>&1 ||
      fail "rolled-back candidate ConfigMap $routing_name reappeared"
  fi

  foundation_created=$(jq -er '.foundationCreated' "$rollback_cleanup_plan")
  [[ "$foundation_created" == true || "$foundation_created" == false ]] ||
    fail 'rolled-back candidate foundation marker is invalid'
  [[ "$foundation_created" == true ]] || return
  ! "${K[@]}" -n "$NAMESPACE" get deployment/release-redis-hot \
    >/dev/null 2>&1 ||
    fail 'rolled-back candidate foundation Deployment reappeared'
  for name in "${RELEASE_STATEFULSETS[@]}"; do
    ! "${K[@]}" -n "$NAMESPACE" get "statefulset/$name" >/dev/null 2>&1 ||
      fail "rolled-back candidate foundation StatefulSet $name reappeared"
  done
  for name in "${RELEASE_SERVICES[@]}"; do
    ! "${K[@]}" -n "$NAMESPACE" get "service/$name" >/dev/null 2>&1 ||
      fail "rolled-back candidate foundation Service $name reappeared"
  done
  for name in "${RELEASE_CONFIGMAPS[@]}"; do
    ! "${K[@]}" -n "$NAMESPACE" get "configmap/$name" >/dev/null 2>&1 ||
      fail "rolled-back candidate foundation ConfigMap $name reappeared"
  done
  for name in "${RELEASE_CLAIMS[@]}"; do
    ! "${K[@]}" -n "$NAMESPACE" get "pvc/$name" >/dev/null 2>&1 ||
      fail "rolled-back candidate foundation PVC $name reappeared"
  done
}

reuse_completed_rollback() {
  local final_evidence="$EVIDENCE_ROOT/$ENVIRONMENT/${release_id}.rollback.json"
  local host_evidence="$work/completed-host-rollback.json"
  local host_digest
  [[ -e "$final_evidence" ]] || return 1
  [[ -f "$final_evidence" && ! -L "$final_evidence" &&
    -f "$rollback_cleanup_plan_final" &&
    ! -L "$rollback_cleanup_plan_final" ]] ||
    fail 'completed Production rollback evidence is incomplete'

  rollback_cleanup_plan=$rollback_cleanup_plan_final
  rollback_cleanup_binding=''
  validate_rollback_cleanup_plan
  rollback_plan_preexisting=1
  capture_inventory
  materialize_rollback_cleanup_plan
  jq -e \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg cleanupPlanDigest "$rollback_cleanup_plan_digest" \
    --arg cleanupPlanPath "$rollback_cleanup_plan_final" '
      keys == [
        "cleanupPlanDigest",
        "cleanupPlanPath",
        "completedAt",
        "environment",
        "hostRollback",
        "hostRollbackEvidenceDigest",
        "manifestDigest",
        "namespace",
        "purpose",
        "releaseId",
        "schemaVersion",
        "sourceSha",
        "status",
        "verifiedAbsent"
      ]
      and .schemaVersion == 2
      and .status == "passed"
      and .purpose == "candidate-rollback-complete"
      and .environment == "production"
      and .namespace == "combo"
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and .cleanupPlanDigest == $cleanupPlanDigest
      and .cleanupPlanPath == $cleanupPlanPath
      and (.hostRollbackEvidenceDigest | test("^sha256:[0-9a-f]{64}$"))
      and (.hostRollback | type == "object")
      and .verifiedAbsent == true
      and (.completedAt | type == "string" and length > 0)
    ' "$final_evidence" >/dev/null ||
    fail 'completed Production rollback evidence changed'
  jq '.hostRollback' "$final_evidence" >"$host_evidence"
  chmod 0600 "$host_evidence"
  host_digest=$(jq -cS . "$host_evidence" | sha256sum |
    awk '{print "sha256:" $1}')
  [[ "$host_digest" == \
    "$(jq -er '.hostRollbackEvidenceDigest' "$final_evidence")" ]] ||
    fail 'completed Production host rollback evidence digest changed'

  validate_completed_host_rollback read-only "$host_evidence"
  jq -e --slurpfile expected "$host_evidence" '. == $expected[0]' \
    "$rollback_evidence" >/dev/null ||
    fail 'completed Production rollback host state differs from final evidence'
  verify_planned_targets_absent
  verify_rollback_candidate_absent

  if [[ -e "$pending_checkpoint" ]]; then
    load_post_cut_checkpoint
    [[ "$CHECKPOINT_PHASE" == armed || "$CHECKPOINT_PHASE" == post-cut ]] ||
      fail 'completed rollback retained an unrelated release checkpoint'
  fi
  if [[ -e "$pending_traffic_evidence" ]]; then
    [[ -f "$pending_traffic_evidence" && ! -L "$pending_traffic_evidence" ]] ||
      fail 'completed rollback retained unsafe traffic evidence'
    jq -e \
      --arg sourceSha "$source_sha" \
      --arg releaseId "$release_id" \
      --arg manifestDigest "$MANIFEST_DIGEST" '
        .sourceSha == $sourceSha
        and .releaseId == $releaseId
        and .manifestDigest == $manifestDigest
      ' "$pending_traffic_evidence" >/dev/null ||
      fail 'completed rollback retained unrelated traffic evidence'
  fi
  if [[ -e "$rollback_pending_evidence" ]]; then
    [[ -f "$rollback_pending_evidence" &&
      ! -L "$rollback_pending_evidence" ]] ||
      fail 'completed rollback retained unsafe host evidence'
    jq -e --slurpfile expected "$host_evidence" '. == $expected[0]' \
      "$rollback_pending_evidence" >/dev/null ||
      fail 'completed rollback retained different host evidence'
  fi
  if [[ -e "$activation_directory" ]]; then
    validate_activation_directory_for_removal
  fi
  if [[ -e "$EVIDENCE_ROOT/$ENVIRONMENT/${release_id}.rollback-cleanup-plan.pending.json" ]]; then
    cmp -s \
      "$EVIDENCE_ROOT/$ENVIRONMENT/${release_id}.rollback-cleanup-plan.pending.json" \
      "$rollback_cleanup_plan_final" ||
      fail 'completed rollback retained a different pending cleanup plan'
  fi

  rm -f -- "$pending_checkpoint" "$pending_traffic_evidence" \
    "$rollback_pending_evidence" \
    "$EVIDENCE_ROOT/$ENVIRONMENT/${release_id}.rollback-cleanup-plan.pending.json" \
    "$EVIDENCE_ROOT/$ENVIRONMENT/${release_id}.rollback-cleanup-binding.pending.json"
  if [[ -e "$activation_directory" ]]; then
    rm -rf -- "$activation_directory"
  fi
  rollback_evidence=$host_evidence
  return 0
}

cleanup_pending_candidate_after_rollback() {
  local name evidence_stage plan_stage host_rollback_digest completed_at
  local final_evidence="$EVIDENCE_ROOT/$ENVIRONMENT/${release_id}.rollback.json"
  validate_rollback_cleanup_plan
  materialize_rollback_cleanup_plan
  fence_writers ||
    fail 'candidate writers could not be fenced after traffic rollback'
  delete_captured_resource job "$inventory_jobs" "${PREFIX}migrate" 120s
  delete_captured_resource job "$inventory_jobs" "$INIT_JOB" 120s
  for name in api worker runtime web; do
    delete_captured_resource deployment "$inventory_deployments" \
      "${PREFIX}${name}" 180s
  done
  for name in api runtime web; do
    delete_captured_resource service "$inventory_services" "${PREFIX}${name}" 120s
  done
  delete_captured_resource configmap "$inventory_configmaps" "$metadata_name" 120s
  if [[ -n "$routing_name" ]]; then
    delete_captured_resource configmap "$inventory_configmaps" "$routing_name" 120s
  fi

  if ((FOUNDATION_CREATED_THIS_RELEASE == 1)); then
    delete_captured_resource deployment "$inventory_deployments" \
      release-redis-hot 180s
    for name in "${RELEASE_STATEFULSETS[@]}"; do
      delete_captured_resource statefulset "$inventory_statefulsets" "$name" 180s
    done
    for name in "${RELEASE_SERVICES[@]}"; do
      delete_captured_resource service "$inventory_services" "$name" 120s
    done
    for name in "${RELEASE_CONFIGMAPS[@]}"; do
      delete_captured_resource configmap "$inventory_configmaps" "$name" 120s
    done
    for name in "${RELEASE_CLAIMS[@]}"; do
      delete_captured_resource pvc "$inventory_pvcs" "$name" 180s
    done
    wait_for_removed_storage release
  fi
  verify_planned_targets_absent
  verify_rollback_candidate_absent
  [[ -f "$rollback_evidence" && ! -L "$rollback_evidence" ]] ||
    fail 'host rollback evidence disappeared before candidate cleanup completed'
  host_rollback_digest=$(jq -cS . "$rollback_evidence" | sha256sum |
    awk '{print "sha256:" $1}')
  if [[ -e "$rollback_cleanup_plan_final" ]]; then
    [[ -f "$rollback_cleanup_plan_final" &&
      ! -L "$rollback_cleanup_plan_final" ]] ||
      fail 'final rollback cleanup plan is unsafe'
    cmp -s "$rollback_cleanup_plan" "$rollback_cleanup_plan_final" ||
      fail 'final rollback cleanup plan differs from its pending plan'
  else
    plan_stage=$(mktemp \
      "$EVIDENCE_ROOT/$ENVIRONMENT/.${release_id}.rollback-plan-final.XXXXXX")
    install -m 0644 "$rollback_cleanup_plan" "$plan_stage"
    mv -fT "$plan_stage" "$rollback_cleanup_plan_final"
  fi
  completed_at=$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')
  evidence_stage=$(mktemp \
    "$EVIDENCE_ROOT/$ENVIRONMENT/.${release_id}.rollback-final.XXXXXX")
  jq -n \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg cleanupPlanDigest "$rollback_cleanup_plan_digest" \
    --arg cleanupPlanPath "$rollback_cleanup_plan_final" \
    --arg hostRollbackEvidenceDigest "$host_rollback_digest" \
    --arg completedAt "$completed_at" \
    --slurpfile hostRollback "$rollback_evidence" '{
      schemaVersion: 2,
      status: "passed",
      purpose: "candidate-rollback-complete",
      environment: "production",
      namespace: "combo",
      sourceSha: $sourceSha,
      releaseId: $releaseId,
      manifestDigest: $manifestDigest,
      cleanupPlanDigest: $cleanupPlanDigest,
      cleanupPlanPath: $cleanupPlanPath,
      hostRollbackEvidenceDigest: $hostRollbackEvidenceDigest,
      hostRollback: $hostRollback[0],
      verifiedAbsent: true,
      completedAt: $completedAt
    }' >"$evidence_stage"
  chmod 0644 "$evidence_stage"
  mv -fT "$evidence_stage" "$final_evidence"
  rm -f -- "$pending_checkpoint"
  rm -f -- "$pending_traffic_evidence"
  if [[ -e "$activation_directory" ]]; then
    validate_activation_directory_for_removal
    rm -rf -- "$activation_directory"
  fi
  rm -f -- "$rollback_pending_evidence"
  rm -f -- "$rollback_cleanup_plan" "$rollback_cleanup_binding"
}

prepare_release_traffic_finalization() {
  local generated="$work/traffic-finalizing-evidence.json"
  local persisted="$activation_directory/traffic-finalizing-evidence.json"
  local stage
  validate_cleanup_plan
  "$SCRIPT_DIR/seal-release-traffic.sh" \
    --phase prepare \
    --manifest "$MANIFEST" \
    --manifest-digest "$MANIFEST_DIGEST" \
    --cleanup-plan "$cleanup_plan" \
    --cleanup-plan-digest "$cleanup_plan_digest" \
    --release-checkpoint "$pending_checkpoint" \
    --evidence-output "$generated"
  jq -e \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg cleanupPlanDigest "$cleanup_plan_digest" '
      .schemaVersion == 1
      and .status == "finalizing"
      and .environment == "production"
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and .cleanupPlanDigest == $cleanupPlanDigest
      and (.checkpointDigest | test("^sha256:[0-9a-f]{64}$"))
      and .rollbackAvailable == false
      and (.finalizingAt | type == "string" and length > 0)
    ' "$generated" >/dev/null ||
    fail 'Production traffic rollback was not durably disabled'
  if [[ -e "$persisted" ]]; then
    [[ -f "$persisted" && ! -L "$persisted" ]] ||
      fail 'persisted Production finalizing evidence is unsafe'
    cmp -s "$generated" "$persisted" ||
      fail 'persisted Production finalizing evidence changed'
  else
    stage=$(mktemp "$activation_directory/.traffic-finalizing.XXXXXX")
    install -m 0600 "$generated" "$stage"
    mv -fT "$stage" "$persisted"
  fi
}

seal_release_traffic() {
  local cleanup_digest persisted_seal="$activation_directory/traffic-seal-evidence.json"
  local persisted_stage
  traffic_seal_evidence="$work/traffic-seal-evidence.json"
  validate_cleanup_plan
  validate_cleanup_evidence "$cleanup_evidence"
  verify_cleanup_plan_absent
  cleanup_digest=$(sha256sum "$cleanup_evidence" | awk '{print "sha256:" $1}')
  "$SCRIPT_DIR/seal-release-traffic.sh" \
    --phase seal \
    --manifest "$MANIFEST" \
    --manifest-digest "$MANIFEST_DIGEST" \
    --cleanup-plan "$cleanup_plan" \
    --cleanup-plan-digest "$cleanup_plan_digest" \
    --cleanup-evidence "$cleanup_evidence" \
    --cleanup-evidence-digest "$cleanup_digest" \
    --release-checkpoint "$pending_checkpoint" \
    --evidence-output "$traffic_seal_evidence"
  jq -e \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg cleanupPlanDigest "$cleanup_plan_digest" \
    --arg cleanupDigest "$cleanup_digest" \
    --arg finalizingCheckpointDigest \
      "$(jq -er '.checkpointDigest' \
        "$activation_directory/traffic-finalizing-evidence.json")" '
      .schemaVersion == 1
      and .status == "sealed"
      and .environment == "production"
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and .cleanupPlanDigest == $cleanupPlanDigest
      and .cleanupEvidenceDigest == $cleanupDigest
      and .finalizingCheckpointDigest == $finalizingCheckpointDigest
      and .rollbackAvailable == false
    ' "$traffic_seal_evidence" >/dev/null ||
    fail 'Production traffic checkpoint was not sealed'
  if [[ -e "$persisted_seal" ]]; then
    [[ -f "$persisted_seal" && ! -L "$persisted_seal" ]] ||
      fail 'persisted Production traffic seal is not a regular file'
    cmp -s "$traffic_seal_evidence" "$persisted_seal" ||
      fail 'persisted Production traffic seal changed'
  else
    persisted_stage=$(mktemp "$activation_directory/.traffic-seal.XXXXXX")
    install -m 0600 "$traffic_seal_evidence" "$persisted_stage"
    mv -fT "$persisted_stage" "$persisted_seal"
  fi
}

append_cleanup_plan_target() {
  local kind=$1 inventory=$2 name=$3 uid
  uid=$(captured_uid "$inventory" "$name" 2>/dev/null) || return 0
  jq -cn \
    --arg kind "$kind" \
    --arg name "$name" \
    --arg uid "$uid" \
    '{kind: $kind, name: $name, uid: $uid}' >>"$cleanup_targets"
}

build_cleanup_plan() {
  local name stage
  cleanup_targets="$work/cleanup-plan-targets.jsonl"
  : >"$cleanup_targets"
  for name in "${LEGACY_JOBS[@]}"; do
    append_cleanup_plan_target job "$inventory_jobs" "$name"
  done
  for name in "${LEGACY_DEPLOYMENTS[@]}"; do
    append_cleanup_plan_target deployment "$inventory_deployments" "$name"
  done
  for name in "${LEGACY_STATEFULSETS[@]}"; do
    append_cleanup_plan_target statefulset "$inventory_statefulsets" "$name"
  done
  for name in "${LEGACY_SERVICES[@]}"; do
    append_cleanup_plan_target service "$inventory_services" "$name"
  done
  for name in "${LEGACY_CONFIGMAPS[@]}"; do
    append_cleanup_plan_target configmap "$inventory_configmaps" "$name"
  done
  for name in "${LEGACY_CLAIMS[@]}"; do
    append_cleanup_plan_target pvc "$inventory_pvcs" "$name"
  done
  while IFS= read -r name; do
    [[ "$name" =~ ^release-[0-9a-f]{12}-(migrate|minio-init)$ ||
      "$name" == release-minio-init ]] || continue
    [[ "$name" == "${PREFIX}migrate" || "$name" == "$INIT_JOB" ]] && continue
    append_cleanup_plan_target job "$inventory_jobs" "$name"
  done < <(jq -r '.items[].metadata.name' "$inventory_jobs")
  while IFS= read -r name; do
    [[ "$name" =~ ^release-[0-9a-f]{12}-(api|runtime|web|worker)$ ]] || continue
    [[ "$name" == "${PREFIX}api" || "$name" == "${PREFIX}runtime" ||
      "$name" == "${PREFIX}web" || "$name" == "${PREFIX}worker" ]] && continue
    append_cleanup_plan_target deployment "$inventory_deployments" "$name"
  done < <(jq -r '.items[].metadata.name' "$inventory_deployments")
  while IFS= read -r name; do
    [[ "$name" =~ ^release-[0-9a-f]{12}-(api|runtime|web)$ ]] || continue
    [[ "$name" == "${PREFIX}api" || "$name" == "${PREFIX}runtime" ||
      "$name" == "${PREFIX}web" ]] && continue
    append_cleanup_plan_target service "$inventory_services" "$name"
  done < <(jq -r '.items[].metadata.name' "$inventory_services")
  while IFS= read -r name; do
    [[ "$name" =~ ^combo-release-meta-[0-9a-f]{12}$ ||
      "$name" =~ ^release-[0-9a-f]{12}-preview-routing$ ||
      "$name" =~ ^release-[0-9a-f]{12}-review-gate$ ]] || continue
    [[ "$name" == "$metadata_name" ||
      "$name" == "$routing_name" ]] && continue
    append_cleanup_plan_target configmap "$inventory_configmaps" "$name"
  done < <(jq -r '.items[].metadata.name' "$inventory_configmaps")

  stage=$(mktemp "$(dirname "$cleanup_plan")/.cleanup-plan.XXXXXX")
  jq -s \
    --arg environment "$ENVIRONMENT" \
    --arg namespace "$NAMESPACE" \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg purpose superseded-release-cleanup \
    --arg plannedAt "$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')" \
    --slurpfile capturedStorage "$pvc_inventory" '
      (unique_by([.kind, .name]) | sort_by([.kind, .name])) as $targets
      | {
          schemaVersion: 1,
          purpose: $purpose,
          environment: $environment,
          namespace: $namespace,
          sourceSha: $sourceSha,
          releaseId: $releaseId,
          manifestDigest: $manifestDigest,
          targets: $targets,
          targetCount: ($targets | length),
          capturedStorage: ([
            $capturedStorage[]
            | select(. as $storage
              | any($targets[];
                  .kind == "pvc"
                  and .name == $storage.claim
                  and .uid == $storage.claimUid))
          ] | sort_by(.claim)),
          plannedAt: $plannedAt
        }
    ' "$cleanup_targets" >"$stage"
  chmod 0600 "$stage"
  mv -fT "$stage" "$cleanup_plan"
}

validate_cleanup_plan() {
  local expected_digest=''
  [[ -f "$cleanup_plan" && ! -L "$cleanup_plan" ]] ||
    fail 'durable release cleanup plan is missing'
  cleanup_plan_digest=$(sha256sum "$cleanup_plan" | awk '{print "sha256:" $1}')
  if [[ "$CHECKPOINT_PHASE" == finalizing ]] ||
    [[ "$CHECKPOINT_PHASE" == post-cut &&
      "$(jq -r '.cleanupPlanDigest // ""' "$pending_checkpoint")" != '' ]]; then
    expected_digest=$(jq -er '.cleanupPlanDigest' "$pending_checkpoint")
    [[ "$cleanup_plan_digest" == "$expected_digest" ]] ||
      fail 'release cleanup plan changed after it was bound'
  fi
  jq -e \
    --arg environment "$ENVIRONMENT" \
    --arg namespace "$NAMESPACE" \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg prefix "$PREFIX" \
    --arg metadata "$metadata_name" \
    --arg routing "$routing_name" \
    --arg init "$INIT_JOB" '
      . as $plan
      | keys == [
        "capturedStorage",
        "environment",
        "manifestDigest",
        "namespace",
        "plannedAt",
        "purpose",
        "releaseId",
        "schemaVersion",
        "sourceSha",
        "targetCount",
        "targets"
      ]
      and .schemaVersion == 1
      and .purpose == "superseded-release-cleanup"
      and .environment == $environment
      and .namespace == $namespace
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and (.plannedAt | type == "string" and length > 0)
      and (.targets | type == "array")
      and (.capturedStorage | type == "array")
      and (.targetCount | type == "number" and floor == . and . >= 0)
      and .targetCount == (.targets | length)
      and ([.targets[] | [.kind, .name]] | unique | length) == .targetCount
      and all(.targets[];
        keys == ["kind", "name", "uid"]
        and (.uid | type == "string" and length > 0
          and test("^[A-Za-z0-9._:-]+$"))
        and (
          (
            .kind == "deployment"
            and (.name | test("^(api|redis-hot|runtime|web|worker|release-[0-9a-f]{12}-(api|runtime|web|worker))$"))
            and .name != ($prefix + "api")
            and .name != ($prefix + "runtime")
            and .name != ($prefix + "web")
            and .name != ($prefix + "worker")
          )
          or
          (
            .kind == "statefulset"
            and (.name | test("^(postgres|redis-queue|minio)$"))
          )
          or
          (
            .kind == "job"
            and (.name | test("^(migrate|minio-init|release-minio-init|release-[0-9a-f]{12}-(migrate|minio-init))$"))
            and .name != ($prefix + "migrate")
            and .name != $init
          )
          or
          (
            .kind == "service"
            and (.name | test("^(api|runtime|web|postgres|redis-queue|redis-hot|minio|release-[0-9a-f]{12}-(api|runtime|web))$"))
            and .name != ($prefix + "api")
            and .name != ($prefix + "runtime")
            and .name != ($prefix + "web")
          )
          or
          (
            .kind == "configmap"
            and (.name | test("^(redis-queue-config|redis-hot-config|minio-init-script|combo-release-meta-[0-9a-f]{12}|release-[0-9a-f]{12}-(preview-routing|review-gate))$"))
            and .name != $metadata
            and .name != $routing
          )
          or
          (
            .kind == "pvc"
            and (.name | test("^data-(postgres|redis-queue|minio)-0$"))
          )
        ))
      and all(.capturedStorage[];
        keys == ["claim", "claimUid", "path", "volume", "volumeUid"]
        and (.claim | test("^data-(release-)?(postgres|redis-queue|minio)-0$"))
        and (.claimUid | type == "string" and length > 0)
        and (.volume | type == "string" and length > 0)
        and (.volumeUid | type == "string" and length > 0)
        and (.path | type == "string" and startswith("/")))
      and ([.capturedStorage[].claim] | unique | length)
        == (.capturedStorage | length)
      and (.capturedStorage | length)
        == ([.targets[] | select(.kind == "pvc")] | length)
      and ([.targets[] | select(.kind == "pvc") | [.name, .uid]] | sort)
        == ([$plan.capturedStorage[] | [.claim, .claimUid]] | sort)
    ' "$cleanup_plan" >/dev/null ||
    fail 'durable release cleanup plan is invalid'
}

materialize_cleanup_plan() {
  inventory_deployments="$work/cleanup-plan-deployments.json"
  inventory_statefulsets="$work/cleanup-plan-statefulsets.json"
  inventory_jobs="$work/cleanup-plan-jobs.json"
  inventory_services="$work/cleanup-plan-services.json"
  inventory_configmaps="$work/cleanup-plan-configmaps.json"
  inventory_pvcs="$work/cleanup-plan-pvcs.json"
  jq --arg kind deployment \
    '{items: [.targets[] | select(.kind == $kind) | {metadata: {name, uid}}]}' \
    "$cleanup_plan" >"$inventory_deployments"
  jq --arg kind statefulset \
    '{items: [.targets[] | select(.kind == $kind) | {metadata: {name, uid}}]}' \
    "$cleanup_plan" >"$inventory_statefulsets"
  jq --arg kind job \
    '{items: [.targets[] | select(.kind == $kind) | {metadata: {name, uid}}]}' \
    "$cleanup_plan" >"$inventory_jobs"
  jq --arg kind service \
    '{items: [.targets[] | select(.kind == $kind) | {metadata: {name, uid}}]}' \
    "$cleanup_plan" >"$inventory_services"
  jq --arg kind configmap \
    '{items: [.targets[] | select(.kind == $kind) | {metadata: {name, uid}}]}' \
    "$cleanup_plan" >"$inventory_configmaps"
  jq --arg kind pvc \
    '{items: [.targets[] | select(.kind == $kind) | {metadata: {name, uid}}]}' \
    "$cleanup_plan" >"$inventory_pvcs"
  pvc_inventory="$work/cleanup-plan-storage.jsonl"
  jq -c '.capturedStorage[]' "$cleanup_plan" >"$pvc_inventory"
}

validate_cleanup_evidence() {
  local evidence=$1
  [[ -f "$evidence" && ! -L "$evidence" ]] ||
    fail 'release cleanup evidence is not a regular file'
  jq -e \
    --arg environment "$ENVIRONMENT" \
    --arg namespace "$NAMESPACE" \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg cleanupPlanDigest "$cleanup_plan_digest" \
    --slurpfile plan "$cleanup_plan" '
      keys == [
        "capturedStorage",
        "cleanupPlanDigest",
        "environment",
        "manifestDigest",
        "namespace",
        "purpose",
        "releaseId",
        "schemaVersion",
        "sourceSha",
        "targets",
        "verifiedAbsent",
        "verifiedAt"
      ]
      and .schemaVersion == 2
      and .purpose == "superseded-release-cleanup"
      and .environment == $environment
      and .namespace == $namespace
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and .cleanupPlanDigest == $cleanupPlanDigest
      and .targets == $plan[0].targets
      and .capturedStorage == $plan[0].capturedStorage
      and .verifiedAbsent == true
      and (.verifiedAt | type == "string" and length > 0)
    ' "$evidence" >/dev/null ||
    fail 'release cleanup evidence does not exactly match its durable plan'
}

verify_planned_targets_absent() {
  local row kind name uid live live_uid volume volume_uid path
  while IFS= read -r row; do
    kind=$(jq -er '.kind' <<<"$row")
    name=$(jq -er '.name' <<<"$row")
    uid=$(jq -er '.uid' <<<"$row")
    if live=$("${K[@]}" -n "$NAMESPACE" get "$kind/$name" -o json 2>/dev/null); then
      live_uid=$(jq -er '.metadata.uid' <<<"$live")
      [[ "$live_uid" == "$uid" ]] ||
        fail "$kind/$name was replaced after its cleanup plan was committed"
      fail "$kind/$name remains after its cleanup plan was executed"
    fi
  done < <(jq -c '.targets[]' "$cleanup_plan")

  while IFS= read -r row; do
    volume=$(jq -er '.volume' <<<"$row")
    volume_uid=$(jq -er '.volumeUid' <<<"$row")
    path=$(jq -er '.path' <<<"$row")
    if live=$("${K[@]}" get "pv/$volume" -o json 2>/dev/null); then
      live_uid=$(jq -er '.metadata.uid' <<<"$live")
      [[ "$live_uid" == "$volume_uid" ]] ||
        fail "PV $volume was replaced after its cleanup plan was committed"
      fail "PV $volume remains after its cleanup plan was executed"
    fi
    sudo -n test ! -e "$path" ||
      fail "storage path remains after exact PV cleanup: $path"
  done < <(jq -c '.capturedStorage[]' "$cleanup_plan")
}

verify_cleanup_plan_absent() {
  local name
  verify_planned_targets_absent
  for name in "${LEGACY_DEPLOYMENTS[@]}"; do
    ! "${K[@]}" -n "$NAMESPACE" get "deployment/$name" >/dev/null 2>&1 ||
      fail "legacy Deployment $name reappeared after cleanup"
  done
  for name in "${LEGACY_STATEFULSETS[@]}"; do
    ! "${K[@]}" -n "$NAMESPACE" get "statefulset/$name" >/dev/null 2>&1 ||
      fail "legacy StatefulSet $name reappeared after cleanup"
  done
  for name in "${LEGACY_SERVICES[@]}"; do
    ! "${K[@]}" -n "$NAMESPACE" get "service/$name" >/dev/null 2>&1 ||
      fail "legacy Service $name reappeared after cleanup"
  done
  for name in "${LEGACY_JOBS[@]}"; do
    ! "${K[@]}" -n "$NAMESPACE" get "job/$name" >/dev/null 2>&1 ||
      fail "legacy Job $name reappeared after cleanup"
  done
  for name in "${LEGACY_CONFIGMAPS[@]}"; do
    ! "${K[@]}" -n "$NAMESPACE" get "configmap/$name" >/dev/null 2>&1 ||
      fail "legacy ConfigMap $name reappeared after cleanup"
  done
  for name in "${LEGACY_CLAIMS[@]}"; do
    ! "${K[@]}" -n "$NAMESPACE" get "pvc/$name" >/dev/null 2>&1 ||
      fail "legacy PVC $name reappeared after cleanup"
  done
  "${K[@]}" -n "$NAMESPACE" get deployments -o json |
    jq -e --arg prefix "$PREFIX" '
      [.items[].metadata.name
        | select(test("^release-[0-9a-f]{12}-(api|runtime|web|worker)$"))
        | select(startswith($prefix) | not)]
      | length == 0
    ' >/dev/null || fail 'a superseded release Deployment reappeared'
  "${K[@]}" -n "$NAMESPACE" get services -o json |
    jq -e --arg prefix "$PREFIX" '
      [.items[].metadata.name
        | select(test("^release-[0-9a-f]{12}-(api|runtime|web)$"))
        | select(startswith($prefix) | not)]
      | length == 0
    ' >/dev/null || fail 'a superseded release Service reappeared'
  "${K[@]}" -n "$NAMESPACE" get jobs -o json |
    jq -e --arg migrate "${PREFIX}migrate" --arg init "$INIT_JOB" '
      [.items[].metadata.name
        | select(. == "release-minio-init"
          or test("^release-[0-9a-f]{12}-(migrate|minio-init)$"))
        | select(. != $migrate and . != $init)]
      | length == 0
    ' >/dev/null || fail 'a superseded release Job reappeared'
  "${K[@]}" -n "$NAMESPACE" get configmaps -o json |
    jq -e --arg metadata "$metadata_name" --arg routing "$routing_name" '
      [.items[].metadata.name
        | select(test("^combo-release-meta-[0-9a-f]{12}$")
          or test("^release-[0-9a-f]{12}-preview-routing$")
          or test("^release-[0-9a-f]{12}-review-gate$"))
        | select(. != $metadata and . != $routing)]
      | length == 0
    ' >/dev/null || fail 'a superseded release ConfigMap reappeared'
}

prepare_cleanup_plan() {
  if [[ "$ENVIRONMENT" == production ]]; then
    cleanup_plan="$activation_directory/cleanup-plan.json"
  else
    cleanup_plan="$EVIDENCE_ROOT/$ENVIRONMENT/${release_id}.cleanup-plan.pending.json"
  fi
  case "$CHECKPOINT_PHASE" in
    post-cut)
      [[ -e "$cleanup_plan" ]] || build_cleanup_plan
      ;;
    finalizing)
      ;;
    *) fail 'Production cleanup plan requires a post-cut or finalizing checkpoint' ;;
  esac
  validate_cleanup_plan
  materialize_cleanup_plan
}

cleanup_for_finalize() {
  local persisted_cleanup="$activation_directory/cleanup-evidence.json" stage
  if [[ -e "$persisted_cleanup" ]]; then
    validate_cleanup_evidence "$persisted_cleanup"
    verify_cleanup_plan_absent
    cleanup_evidence="$work/cleanup-evidence.json"
    install -m 0600 "$persisted_cleanup" "$cleanup_evidence"
    return
  fi
  cleanup_legacy
  stage=$(mktemp "$activation_directory/.cleanup-evidence.XXXXXX")
  install -m 0600 "$cleanup_evidence" "$stage"
  mv -fT "$stage" "$persisted_cleanup"
}

cleanup_legacy() {
  local name
  cleanup_evidence="$work/cleanup-evidence.json"
  [[ -f "$cleanup_plan" && ! -L "$cleanup_plan" ]] ||
    fail 'cleanup cannot start without its durable plan'
  validate_cleanup_plan
  materialize_cleanup_plan
  RECORD_CLEANUP=0
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
      "$name" =~ ^release-[0-9a-f]{12}-preview-routing$ ||
      "$name" =~ ^release-[0-9a-f]{12}-review-gate$ ]] || continue
    [[ "$name" == "$metadata_name" ||
      "$name" == "$routing_name" ]] && continue
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
    jq -e --arg metadata "$metadata_name" --arg routing "$routing_name" '
      [.items[].metadata.name
        | select(test("^combo-release-meta-[0-9a-f]{12}$")
          or test("^release-[0-9a-f]{12}-preview-routing$")
          or test("^release-[0-9a-f]{12}-review-gate$"))
        | select(. != $metadata and . != $routing)]
      | length == 0
    ' >/dev/null || fail 'a previous release ConfigMap remains after cleanup'

  verify_cleanup_plan_absent
  jq -n \
    --arg environment "$ENVIRONMENT" \
    --arg namespace "$NAMESPACE" \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg cleanupPlanDigest "$cleanup_plan_digest" \
    --arg verifiedAt "$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')" \
    --slurpfile plan "$cleanup_plan" '
      {
        schemaVersion: 2,
        purpose: "superseded-release-cleanup",
        environment: $environment,
        namespace: $namespace,
        sourceSha: $sourceSha,
        releaseId: $releaseId,
        manifestDigest: $manifestDigest,
        cleanupPlanDigest: $cleanupPlanDigest,
        targets: $plan[0].targets,
        capturedStorage: $plan[0].capturedStorage,
        verifiedAbsent: true,
        verifiedAt: $verifiedAt
      }
    ' >"$cleanup_evidence"
  validate_cleanup_evidence "$cleanup_evidence"
}

write_release_evidence() {
  local stage deployments_json migration_json foundation_json init_json
  local foundation_mode fresh_foundation foundation_reset_json
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
  install -m 0644 "$cleanup_plan" "$stage/cleanup-plan.json"
  install -m 0644 "$cleanup_evidence" "$stage/cleanup-evidence.json"
  if ((FINALIZE == 1)); then
    install -m 0644 "$ACCEPTANCE_ATTESTATION" \
      "$stage/acceptance-attestation.json"
    install -m 0644 "$ACCEPTANCE_EVIDENCE" \
      "$stage/acceptance-evidence.json"
    install -m 0644 "$PROMOTION_IDENTITY" \
      "$stage/promotion-identity.json"
    install -m 0644 "$activation_directory/activation-evidence.json" \
      "$stage/activation-evidence.json"
    install -m 0644 "$activation_directory/traffic-finalizing-evidence.json" \
      "$stage/traffic-finalizing-evidence.json"
    install -m 0644 "$traffic_seal_evidence" \
      "$stage/traffic-seal-evidence.json"
  fi
  if [[ -n "$FOUNDATION_RESET_EVIDENCE" ]]; then
    install -m 0644 "$FOUNDATION_RESET_EVIDENCE" \
      "$stage/foundation-reset-evidence.json"
  fi
  if [[ -n "$RESET_ROLL_FORWARD_EVIDENCE" ]]; then
    install -m 0644 "$RESET_ROLL_FORWARD_EVIDENCE" \
      "$stage/reset-roll-forward-evidence.json"
  fi
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
  [[ -f "$schema_structure_evidence" && ! -L "$schema_structure_evidence" &&
    "$schema_structure_digest" =~ $DIGEST_RE ]] ||
    fail 'schema structure evidence is missing before release evidence commit'
  foundation_reset_json=null
  if [[ -n "$FOUNDATION_RESET_EVIDENCE" ]]; then
    foundation_mode=reset
    fresh_foundation=true
    foundation_reset_json=$(<"$FOUNDATION_RESET_EVIDENCE")
  elif ((FOUNDATION_CREATED_THIS_RELEASE == 1)); then
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
    --arg acceptanceAttestationDigest "$ACCEPTANCE_ATTESTATION_DIGEST" \
    --arg foundationMode "$foundation_mode" \
    --arg foundationResetEvidenceDigest "$foundation_reset_digest" \
    --arg schemaStructureDigest "$schema_structure_digest" \
    --arg completedAt "$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')" \
    --argjson freshFoundation "$fresh_foundation" \
    --argjson foundationReset "$foundation_reset_json" \
    --argjson deployments "$deployments_json" \
    --argjson migration "$migration_json" \
    --argjson foundation "$foundation_json" \
    --argjson init "$init_json" \
    --slurpfile schemaStructure "$schema_structure_evidence" \
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
      acceptanceAttestationDigest:
        (if $acceptanceAttestationDigest == "" then null
          else $acceptanceAttestationDigest end),
      foundationMode: $foundationMode,
      foundationResetEvidenceDigest:
        (if $foundationResetEvidenceDigest == "" then null
          else $foundationResetEvidenceDigest end),
      foundationReset: $foundationReset,
      foundation: $foundation,
      storage: $storage[0],
      initialization: $init,
      deployments: $deployments,
      migration: $migration,
      schemaStructureDigest: $schemaStructureDigest,
      schemaStructure: $schemaStructure[0],
      traffic: $traffic[0],
      cleanup: $cleanup[0],
      checks: {
        freshFoundation: $freshFoundation,
        foundationReset: ($foundationMode == "reset"),
        foundationReady: true,
        releaseStorage: true,
        minioInitialization: true,
        exactMigrations: true,
        schemaStructure: true,
        applicationImages: true,
        publicTraffic: true,
        legacyCleanup: true,
        protectedAcceptance: ($acceptanceAttestationDigest != "")
      },
      completedAt: $completedAt
    }' >"$stage/deploy-evidence.json"
  chmod 0644 "$stage/deploy-evidence.json"
  (
    cd "$stage"
    evidence_files=(
      release.json release.sha256 migration-files.txt web-asset-manifest.json
      foundation.yaml init.yaml migrate.yaml apps.yaml traffic-evidence.json
      cleanup-plan.json cleanup-evidence.json deploy-evidence.json
    )
    if ((FINALIZE == 1)); then
      evidence_files+=(
        acceptance-attestation.json acceptance-evidence.json
        promotion-identity.json activation-evidence.json
      )
      evidence_files+=(traffic-finalizing-evidence.json traffic-seal-evidence.json)
    fi
    if [[ -e foundation-reset-evidence.json ||
      -L foundation-reset-evidence.json ]]; then
      [[ -f foundation-reset-evidence.json &&
        ! -L foundation-reset-evidence.json ]] ||
        fail 'release evidence staged an unsafe foundation reset evidence path'
      evidence_files+=(foundation-reset-evidence.json)
    fi
    if [[ -e reset-roll-forward-evidence.json ||
      -L reset-roll-forward-evidence.json ]]; then
      [[ -f reset-roll-forward-evidence.json &&
        ! -L reset-roll-forward-evidence.json ]] ||
        fail 'release evidence staged an unsafe reset roll-forward evidence path'
      evidence_files+=(reset-roll-forward-evidence.json)
    fi
    sha256sum "${evidence_files[@]}" >SHA256SUMS
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
  if [[ "$ENVIRONMENT" == preview ]]; then
    rm -f -- "$pending_traffic_evidence"
    rm -f -- "$EVIDENCE_ROOT/$ENVIRONMENT/${release_id}.cleanup-plan.pending.json"
    if [[ -e "$pending_checkpoint" ]]; then
      load_post_cut_checkpoint
      rm -f -- "$pending_checkpoint"
      CHECKPOINT_PHASE=''
    fi
  else
    if [[ -e "$pending_checkpoint" ]]; then
      load_post_cut_checkpoint
      rm -f -- "$pending_checkpoint"
      CHECKPOINT_PHASE=''
    fi
    rm -f -- "$pending_traffic_evidence"
  fi
}

validate_existing_release_current_for_recovery() {
  local current="$EVIDENCE_ROOT/$ENVIRONMENT/current.json"
  RECOVERY_CURRENT_IS_CANDIDATE=0
  if [[ ! -e "$current" && ! -L "$current" ]]; then
    return 0
  fi
  [[ -f "$current" && ! -L "$current" ]] ||
    fail 'Preview release current checkpoint is unsafe during post-cut recovery'
  jq -e \
    --arg environment "$ENVIRONMENT" \
    --arg namespace "$NAMESPACE" \
    --arg evidenceRoot "$EVIDENCE_ROOT/$ENVIRONMENT" '
      keys == [
        "environment",
        "evidencePath",
        "manifestDigest",
        "namespace",
        "releaseId",
        "schemaVersion",
        "sourceSha",
        "status"
      ]
      and .schemaVersion == 1
      and .status == "passed"
      and .environment == $environment
      and .namespace == $namespace
      and (.sourceSha | test("^[0-9a-f]{40}$"))
      and .releaseId == ("release-" + .sourceSha)
      and (.manifestDigest | test("^sha256:[0-9a-f]{64}$"))
      and .evidencePath == ($evidenceRoot + "/release-" + .sourceSha)
    ' "$current" >/dev/null ||
    fail 'Preview release current checkpoint is invalid during post-cut recovery'
  if jq -e \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" '
      .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
    ' "$current" >/dev/null; then
    RECOVERY_CURRENT_IS_CANDIDATE=1
  fi
}

validate_existing_post_cut_traffic_current() {
  local traffic_root traffic_preview current
  traffic_root=${COMBO_RELEASE_TRAFFIC_STATE_ROOT:-"$HOME/data/combo-releases/traffic"}
  traffic_preview="$traffic_root/preview"
  current="$traffic_preview/current.json"
  [[ "$traffic_root" == /* && -d "$traffic_root" && ! -L "$traffic_root" &&
    "$(realpath -e "$traffic_root")" == "$traffic_root" ]] ||
    fail 'Preview traffic state root is missing or unsafe during post-cut recovery'
  [[ -d "$traffic_preview" && ! -L "$traffic_preview" &&
    "$(realpath -e "$traffic_preview")" == "$traffic_preview" ]] ||
    fail 'Preview traffic state directory is missing or unsafe during post-cut recovery'
  [[ -f "$current" && ! -L "$current" ]] ||
    fail 'Preview traffic current state is missing or unsafe during post-cut recovery'
  jq -e \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg webService "${PREFIX}web" '
      keys == [
        "canaryNginxSha256",
        "environment",
        "formalNginxSha256",
        "manifestDigest",
        "releaseId",
        "schemaVersion",
        "sourceSha",
        "webService"
      ]
      and .schemaVersion == 1
      and .environment == "preview"
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and (.canaryNginxSha256 | test("^sha256:[0-9a-f]{64}$"))
      and .formalNginxSha256 == null
      and .webService == $webService
    ' "$current" >/dev/null ||
    fail 'Preview traffic current state changed during post-cut recovery'
}

validate_existing_post_cut_auxiliary_evidence() {
  local path pending_cleanup_plan
  local -a auxiliary=()
  pending_cleanup_plan="$EVIDENCE_ROOT/$ENVIRONMENT/${release_id}.cleanup-plan.pending.json"
  shopt -s nullglob
  auxiliary=(
    "$EVIDENCE_ROOT/$ENVIRONMENT"/release-*.traffic.pending.json
    "$EVIDENCE_ROOT/$ENVIRONMENT"/release-*.cleanup-plan.pending.json
  )
  shopt -u nullglob
  for path in "${auxiliary[@]}"; do
    [[ "$path" == "$pending_traffic_evidence" || "$path" == "$pending_cleanup_plan" ]] ||
      fail 'Preview has foreign auxiliary pending evidence during post-cut recovery'
  done
  for path in "$pending_traffic_evidence" "$pending_cleanup_plan"; do
    if [[ -e "$path" || -L "$path" ]]; then
      [[ -f "$path" && ! -L "$path" ]] ||
        fail 'Preview post-cut recovery auxiliary evidence is unsafe'
    elif ((RECOVERY_CURRENT_IS_CANDIDATE == 0)); then
      fail 'Preview post-cut recovery auxiliary evidence is missing before current commit'
    fi
  done
  if [[ -e "$pending_traffic_evidence" ]]; then
    cmp -s "$pending_traffic_evidence" "$release_directory/traffic-evidence.json" ||
      fail 'Preview post-cut recovery traffic evidence changed'
  fi
  if [[ -e "$pending_cleanup_plan" ]]; then
    cmp -s "$pending_cleanup_plan" "$release_directory/cleanup-plan.json" ||
      fail 'Preview post-cut recovery cleanup plan changed'
  fi
}

recover_existing_post_cut_release() {
  local checkpoint_schema_digest traffic_lock
  [[ -d "$release_directory" && ! -L "$release_directory" ]] ||
    fail 'Preview post-cut recovery requires existing release evidence'
  traffic_lock=${COMBO_RELEASE_TRAFFIC_LOCK:-"$HOME/data/combo-release-traffic.lock"}
  install -d -m 0750 "$(dirname "$traffic_lock")"
  if [[ -e "$traffic_lock" || -L "$traffic_lock" ]]; then
    [[ -f "$traffic_lock" && ! -L "$traffic_lock" ]] ||
      fail 'Preview traffic lock path is unsafe during post-cut recovery'
  fi
  exec 8>"$traffic_lock"
  chmod 0600 "$traffic_lock"
  flock -n 8 || fail 'another release traffic transaction is running'
  validate_existing_release_current_for_recovery
  load_post_cut_checkpoint
  [[ "$CHECKPOINT_PHASE" == post-cut ]] ||
    fail 'Preview post-cut recovery requires the exact pending post-cut checkpoint'
  checkpoint_schema_digest=$schema_structure_digest
  capture_inventory
  ((RESUME_POST_CUT == 1)) ||
    fail 'Preview post-cut recovery candidate is not active traffic'
  validate_existing_post_cut_traffic_current
  reuse_completed_release
  ((REUSE_COMPLETED == 1)) ||
    fail 'Preview post-cut release evidence is not safely reusable'
  [[ "$schema_structure_digest" == "$checkpoint_schema_digest" &&
    "$(jq -er '.schemaStructureDigest' \
      "$release_directory/deploy-evidence.json")" == "$checkpoint_schema_digest" ]] ||
    fail 'Preview post-cut schema proof changed during recovery'
  validate_existing_post_cut_auxiliary_evidence
  finalize_release_commit 1
  flock -u 8
  exec 8>&-
  deployment_succeeded=1
  status "$ENVIRONMENT release $release_id post-cut checkpoint was recovered"
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
audit_reset_roll_forward_journals
validate_reset_roll_forward_evidence
audit_foundation_reset_journals

"${K[@]}" get namespace "$NAMESPACE" >/dev/null
validate_live_foundation_reset_uids
validate_secret_keys
status 'server-side validating and allowlisting every rendered phase'
validate_rendered_phase foundation "$FOUNDATION_YAML"
validate_rendered_phase init "$INIT_YAML"
validate_rendered_phase migrate "$MIGRATE_YAML"
validate_rendered_phase apps "$APPS_YAML"

work=$(mktemp -d)
release_directory="$EVIDENCE_ROOT/$ENVIRONMENT/$release_id"
activation_directory="$EVIDENCE_ROOT/$ENVIRONMENT/${release_id}.activation"
pending_checkpoint="$EVIDENCE_ROOT/$ENVIRONMENT/pending.json"
pending_traffic_evidence="$EVIDENCE_ROOT/$ENVIRONMENT/${release_id}.traffic.pending.json"
rollback_pending_evidence="$EVIDENCE_ROOT/$ENVIRONMENT/${release_id}.rollback.pending.json"
rollback_cleanup_plan="$EVIDENCE_ROOT/$ENVIRONMENT/${release_id}.rollback-cleanup-plan.pending.json"
rollback_cleanup_binding="$EVIDENCE_ROOT/$ENVIRONMENT/${release_id}.rollback-cleanup-binding.pending.json"
rollback_cleanup_plan_final="$EVIDENCE_ROOT/$ENVIRONMENT/${release_id}.rollback-cleanup-plan.json"
if ((ROLLBACK == 1)); then
  [[ "$ENVIRONMENT" == production ]] ||
    fail 'release rollback is restricted to Production'
  if reuse_completed_rollback; then
    deployment_succeeded=1
    status "$ENVIRONMENT release $release_id rollback was already committed"
    exit 0
  fi
  load_post_cut_checkpoint
  [[ "$CHECKPOINT_PHASE" == armed || "$CHECKPOINT_PHASE" == post-cut ]] ||
    fail 'Production rollback requires the active armed or post-cut checkpoint'
  [[ "$(jq -r '.foundationResetEvidenceDigest // ""' "$pending_checkpoint")" == "" ]] ||
    fail 'this clean-slate schema boundary is roll-forward only; rollback is disabled'
  load_host_rollback_status
  if {
    [[ "$HOST_ROLLBACK_STATUS" == rolled-back ]] ||
      ((HOST_ROLLBACK_JOURNAL_PRESENT == 1))
  } &&
    [[ ! -e "$rollback_cleanup_plan" || ! -e "$rollback_cleanup_binding" ]]; then
    fail 'mutated Production rollback lacks its pre-mutation cleanup authorization'
  fi
  if [[ -e "$rollback_cleanup_plan" && ! -e "$rollback_cleanup_binding" ]]; then
    [[ -f "$rollback_cleanup_plan" && ! -L "$rollback_cleanup_plan" ]] ||
      fail 'incomplete rollback cleanup plan path is unsafe'
    rm -f -- "$rollback_cleanup_plan"
  elif [[ ! -e "$rollback_cleanup_plan" && -e "$rollback_cleanup_binding" ]]; then
    fail 'committed rollback cleanup binding lost its plan'
  fi
  if [[ -e "$rollback_cleanup_plan" || -e "$rollback_cleanup_binding" ]]; then
    validate_rollback_cleanup_plan
    rollback_plan_preexisting=1
  fi
  capture_inventory
  if ((rollback_plan_preexisting == 0)); then
    build_rollback_cleanup_plan
    validate_rollback_cleanup_plan
  fi
  materialize_rollback_cleanup_plan
  mutation_started=1
  if [[ "$HOST_ROLLBACK_STATUS" == armed ]] &&
    ((RESUME_POST_CUT != 0)); then
    status 'recovering the journaled interrupted activation before rollback'
    switch_release_traffic
    validate_traffic_cleanup_gate
    write_release_checkpoint post-cut
    rollback_host_traffic
  elif [[ "$HOST_ROLLBACK_STATUS" == activated ]]; then
    if [[ "$CHECKPOINT_PHASE" == armed ]]; then
      # A host cutover may complete immediately before the local checkpoint is
      # advanced.  Promote only after the captured live route proves that the
      # exact candidate is active, so rollback can safely recover that crash
      # window without admitting an uncut armed candidate.
      write_release_checkpoint post-cut
    fi
    rollback_host_traffic
  elif [[ "$HOST_ROLLBACK_STATUS" == rolled-back ]]; then
    validate_completed_host_rollback
    status 'resuming candidate cleanup after the exact host rollback was committed'
  else
    [[ "$HOST_ROLLBACK_STATUS" == armed && "$CHECKPOINT_PHASE" == armed &&
      "$RESUME_POST_CUT" == 0 ]] ||
      fail 'Production rollback host state cannot be reconciled'
    status 'armed Production candidate never became active; removing it without changing traffic'
  fi
  cleanup_pending_candidate_after_rollback
  deployment_succeeded=1
  status "$ENVIRONMENT release $release_id was rolled back"
  exit 0
fi
if ((RECOVER_EXISTING_POST_CUT == 1)); then
  recover_existing_post_cut_release
  exit 0
fi
if ((FINALIZE == 1)); then
  if [[ -e "$release_directory" ]]; then
    reuse_completed_release
    ((REUSE_COMPLETED == 1)) ||
      fail 'existing Production release evidence is not safely reusable'
    if [[ -e "$activation_directory" ]]; then
      validate_activation_directory_for_removal
    fi
    finalize_release_commit 0
    [[ ! -e "$activation_directory" ]] || rm -rf -- "$activation_directory"
    deployment_succeeded=1
    status "$ENVIRONMENT release $release_id finalization was already committed"
    exit 0
  fi
  load_post_cut_checkpoint
  [[ "$CHECKPOINT_PHASE" == post-cut || "$CHECKPOINT_PHASE" == finalizing ]] ||
    fail 'Production finalization requires the active post-cut or finalizing checkpoint'
  capture_inventory
  mutation_started=1
  ((RESUME_POST_CUT == 1)) ||
    fail 'Production finalization candidate is not active traffic'
  load_activation_evidence
  validate_live_candidate_for_finalize
  traffic_cut_succeeded=1
  prepare_cleanup_plan
  write_release_checkpoint finalizing
  prepare_release_traffic_finalization
  cleanup_for_finalize
  seal_release_traffic
  write_release_evidence
  rm -rf -- "$activation_directory"
  deployment_succeeded=1
  status "$ENVIRONMENT release $release_id is finalized"
  exit 0
fi
reuse_completed_release
if ((REUSE_COMPLETED == 1)); then
  if [[ "$ENVIRONMENT" == production && -e "$activation_directory" ]]; then
    validate_activation_directory_for_removal
  fi
  finalize_release_commit 0
  if [[ "$ENVIRONMENT" == production && -e "$activation_directory" ]]; then
    rm -rf -- "$activation_directory"
  fi
  status "$ENVIRONMENT already runs the verified $release_id"
  exit 0
fi
[[ ! -e "$release_directory" ]] ||
  fail 'existing release evidence is incomplete, mismatched, or no longer live'
load_post_cut_checkpoint

capture_inventory
mutation_started=1
if ((DEFER_CLEANUP == 1 && RESUME_POST_CUT == 1)) &&
  [[ -d "$activation_directory" && ! -L "$activation_directory" ]]; then
  write_activation_evidence
  validate_live_candidate_for_finalize
  traffic_cut_succeeded=1
  deployment_succeeded=1
  status "$ENVIRONMENT release $release_id already awaits protected acceptance"
  exit 0
fi
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
verify_release_schema_structure
apply_apps
if ((RESUME_POST_CUT == 0)); then
  write_release_checkpoint armed
  switch_release_traffic
  validate_traffic_cleanup_gate
  if [[ "$ENVIRONMENT" == production ]]; then
    if [[ -e "$pending_traffic_evidence" ]]; then
      [[ -f "$pending_traffic_evidence" && ! -L "$pending_traffic_evidence" ]] ||
        fail 'pending Production traffic evidence is not a regular file'
      cmp -s "$traffic_evidence" "$pending_traffic_evidence" ||
        fail 'pending Production traffic evidence changed'
    else
      install -m 0600 "$traffic_evidence" "$pending_traffic_evidence"
    fi
  fi
else
  if [[ ! -e "$pending_traffic_evidence" ]]; then
    [[ "$CHECKPOINT_PHASE" == armed ]] ||
      fail "resumed $ENVIRONMENT activation lacks durable traffic evidence"
    status 'recovering durable traffic evidence for the already active candidate'
    switch_release_traffic
  fi
  [[ -f "$pending_traffic_evidence" && ! -L "$pending_traffic_evidence" ]] ||
    fail "resumed $ENVIRONMENT traffic evidence is not a regular file"
  traffic_evidence="$work/traffic-evidence.json"
  install -m 0600 "$pending_traffic_evidence" "$traffic_evidence"
  validate_traffic_cleanup_gate
fi
write_release_checkpoint post-cut
traffic_cut_succeeded=1
if ((DEFER_CLEANUP == 1)); then
  write_activation_evidence
  rm -f -- "$pending_traffic_evidence"
  deployment_succeeded=1
  status "$ENVIRONMENT release $release_id awaits protected acceptance and finalization"
  exit 0
fi
prepare_cleanup_plan
write_release_checkpoint post-cut
cleanup_legacy
write_release_evidence
deployment_succeeded=1
status "$ENVIRONMENT release $release_id is complete"
