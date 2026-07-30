#!/usr/bin/env bash
set -euo pipefail

readonly DIGEST_RE='^sha256:[0-9a-f]{64}$'
readonly SOURCE_SHA_RE='^[0-9a-f]{40}$'
readonly POLICY_VALUE='established-clean-slate-v1'
readonly REUSE_POLICY_VALUE='reuse-existing-v1'
readonly FORMAL_INITIAL_SHA256='sha256:a2b92b1cf53fb6cbc72fae5687cdefcd60962dcceab9d823e220c7cef0262118'

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly SCRIPT_DIR

ENVIRONMENT=''
OPERATION=''
MANIFEST=''
MANIFEST_DIGEST=''
FOUNDATION_YAML=''
AUTHORITY_DIGEST=''
REQUEST_ID=''
POLICY=''
OUTPUT=''
RESET_ROLL_FORWARD_EVIDENCE=''
PREDECESSOR_RESET_EVIDENCE=''
SUPERSEDED_RESET_JSON='null'
AUDITED_SUPERSEDED_RESET_JSON='null'
KUBECONFIG_PATH=${KUBECONFIG:-"$HOME/.kube/config"}
EVIDENCE_ROOT=${COMBO_RELEASE_EVIDENCE_ROOT:-"$HOME/data/combo-releases/goal-a"}
MUTATION_LOCK=${COMBO_MUTATION_LOCK:-"$HOME/data/combo-release-mutation.lock"}
TRAFFIC_LOCK=${COMBO_RELEASE_TRAFFIC_LOCK:-"$HOME/data/combo-release-traffic.lock"}
TRAFFIC_STATE_ROOT=${COMBO_RELEASE_TRAFFIC_STATE_ROOT:-"$HOME/data/combo-releases/traffic"}
TRAFFIC_CHECKPOINT_ROOT=${COMBO_RELEASE_TRAFFIC_CHECKPOINT_ROOT:-/var/lib/combo-release/traffic-checkpoints}
K3S_STORAGE_ROOT=${COMBO_K3S_STORAGE_ROOT:-"$HOME/data/k3s/storage"}
WAIT_SECONDS=${COMBO_FOUNDATION_RESET_WAIT_SECONDS:-180}

status() { printf '[foundation-reset] %s\n' "$1"; }
fail() {
  printf '[foundation-reset] FAIL: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage: reset-release-foundation.sh
  --operation reset|assert-reuse
  --environment preview|production
  --manifest release.json
  --manifest-digest sha256:...
  --foundation-yaml rendered-foundation.yaml
  --authority-digest sha256:...
  --request-id sha256:...
  --policy established-clean-slate-v1|reuse-existing-v1
  --output foundation-reset-evidence.json
  [--reset-roll-forward-evidence reset-roll-forward-evidence.json]
EOF
  exit 2
}

while (($# > 0)); do
  (($# >= 2)) || usage
  case "$1" in
    --operation) OPERATION=$2 ;;
    --environment) ENVIRONMENT=$2 ;;
    --manifest) MANIFEST=$2 ;;
    --manifest-digest) MANIFEST_DIGEST=$2 ;;
    --foundation-yaml) FOUNDATION_YAML=$2 ;;
    --authority-digest) AUTHORITY_DIGEST=$2 ;;
    --request-id) REQUEST_ID=$2 ;;
    --policy) POLICY=$2 ;;
    --output) OUTPUT=$2 ;;
    --reset-roll-forward-evidence) RESET_ROLL_FORWARD_EVIDENCE=$2 ;;
    *) usage ;;
  esac
  shift 2
done

case "$ENVIRONMENT" in
  preview)
    NAMESPACE=combo-review
    FOUNDATION_TRACK=preview-v1
    PUBLIC_ORIGIN=https://review.43-160-242-46.sslip.io
    WEB_FORWARD_ENV=${COMBO_RELEASE_WEB_FORWARD_ENV:-/etc/combo-release/preview-web-forward.env}
    WEB_FORWARD_UNIT=combo-release-preview-web-forward.service
    WEB_FORWARD_PORT=18081
    NGINX_CONFIG=${COMBO_RELEASE_NGINX_CONFIG:-/etc/nginx/conf.d/combo-cloud-review.conf}
    FORMAL_NGINX_CONFIG=${COMBO_RELEASE_FORMAL_NGINX_CONFIG:-}
    ;;
  production)
    NAMESPACE=combo
    FOUNDATION_TRACK=production-v1
    PUBLIC_ORIGIN=https://agora.43-160-242-46.sslip.io
    WEB_FORWARD_ENV=${COMBO_RELEASE_WEB_FORWARD_ENV:-/etc/combo-release/production-web-forward.env}
    WEB_FORWARD_UNIT=combo-release-production-web-forward.service
    WEB_FORWARD_PORT=18082
    NGINX_CONFIG=${COMBO_RELEASE_NGINX_CONFIG:-/etc/nginx/conf.d/zz-agora-demo.conf}
    FORMAL_NGINX_CONFIG=${COMBO_RELEASE_FORMAL_NGINX_CONFIG:-/etc/nginx/conf.d/happy.conf}
    ;;
  *) usage ;;
esac
readonly NAMESPACE FOUNDATION_TRACK PUBLIC_ORIGIN WEB_FORWARD_ENV WEB_FORWARD_UNIT
readonly WEB_FORWARD_PORT NGINX_CONFIG FORMAL_NGINX_CONFIG

[[ "$MANIFEST_DIGEST" =~ $DIGEST_RE ]] || fail 'invalid manifest digest'
[[ "$AUTHORITY_DIGEST" =~ $DIGEST_RE ]] || fail 'invalid authority digest'
[[ "$REQUEST_ID" =~ $DIGEST_RE ]] || fail 'invalid reset request ID'
case "$OPERATION:$POLICY" in
  reset:"$POLICY_VALUE"|assert-reuse:"$REUSE_POLICY_VALUE") ;;
  *) fail 'unsupported foundation reset operation or policy' ;;
esac
if [[ ! "$WAIT_SECONDS" =~ ^[1-9][0-9]{0,2}$ ]] ||
  ((WAIT_SECONDS > 600)); then
  fail 'invalid reset wait duration'
fi

for input in "$MANIFEST" "$FOUNDATION_YAML"; do
  [[ -f "$input" && ! -L "$input" ]] || fail "input must be a regular file: $input"
done
[[ -n "$OUTPUT" ]] || fail 'output path is required'
[[ ! -L "$OUTPUT" ]] || fail 'output path must not be a symbolic link'
[[ -d "$(dirname -- "$OUTPUT")" && ! -L "$(dirname -- "$OUTPUT")" ]] ||
  fail 'output parent must be an existing regular directory'

for command in node jq sha256sum flock kubectl awk install mktemp realpath mv \
  rm dirname sleep seq sudo date chmod mkdir cmp sort sed curl systemctl find tr stat; do
  command -v "$command" >/dev/null 2>&1 || fail "missing host command: $command"
done
[[ -f "$SCRIPT_DIR/release-manifest.mjs" && ! -L "$SCRIPT_DIR/release-manifest.mjs" ]] ||
  fail 'release manifest verifier is missing'
[[ -f "$SCRIPT_DIR/verify-rendered-release.mjs" &&
  ! -L "$SCRIPT_DIR/verify-rendered-release.mjs" ]] ||
  fail 'rendered release verifier is missing'
[[ -f "$SCRIPT_DIR/release-nginx-route.mjs" &&
  ! -L "$SCRIPT_DIR/release-nginx-route.mjs" ]] ||
  fail 'structured Nginx route controller is missing'

K=(kubectl --kubeconfig "$KUBECONFIG_PATH")
readonly -a K
readonly -a CLAIMS=(
  data-release-postgres-0
  data-release-redis-queue-0
  data-release-minio-0
)
readonly -a FOUNDATION_TARGETS=(
  'deployment:release-redis-hot'
  'statefulset:release-postgres'
  'statefulset:release-redis-queue'
  'statefulset:release-minio'
  'service:release-postgres'
  'service:release-redis-queue'
  'service:release-redis-hot'
  'service:release-minio'
  'configmap:release-redis-hot-config'
  'configmap:release-redis-queue-config'
)
readonly -a OPTIONAL_TARGETS=('configmap:release-minio-init-script')

work=$(mktemp -d)
atomic_stage=''
cleanup() {
  if [[ -n "$atomic_stage" && -f "$atomic_stage" && ! -L "$atomic_stage" ]]; then
    rm -f -- "$atomic_stage"
  fi
  rm -rf -- "$work"
}
trap cleanup EXIT
chmod 0700 "$work"

atomic_install() {
  local source=$1 target=$2 stage
  [[ "$(stat -c '%d' "$staging_root")" == \
    "$(stat -c '%d' "$(dirname -- "$target")")" ]] ||
    fail "atomic target is on another filesystem: $target"
  stage=$(mktemp "$staging_root/.foundation-reset.XXXXXX")
  atomic_stage=$stage
  install -m 0600 "$source" "$stage"
  [[ "$(sha256sum "$stage" | awk '{print $1}')" == \
    "$(sha256sum "$source" | awk '{print $1}')" ]] ||
    fail "atomic staging changed: $target"
  mv -fT "$stage" "$target"
  atomic_stage=''
}

immutable_install() {
  local source=$1 target=$2
  if [[ -e "$target" || -L "$target" ]]; then
    [[ -f "$target" && ! -L "$target" ]] ||
      fail "immutable state path is unsafe: $target"
    cmp -s "$source" "$target" ||
      fail "immutable state changed: $target"
    return
  fi
  atomic_install "$source" "$target"
}

file_digest() {
  sha256sum "$1" | awk '{print "sha256:" $1}'
}

foundation_reset_request_id() {
  local environment=$1 source=$2 manifest_digest=$3
  printf '%s\0%s\0%s\0%s\0%s' \
    combo-foundation-reset-v1 "$environment" "$source" \
    "$manifest_digest" "$POLICY_VALUE" |
    sha256sum | awk '{print "sha256:" $1}'
}

resource_authority_digest() {
  jq -Sc '
    {
      apiVersion,
      kind,
      metadata: {
        name: .metadata.name,
        namespace: (.metadata.namespace // null),
        uid: .metadata.uid,
        labels: (.metadata.labels // {}),
        annotations: (.metadata.annotations // {}),
        ownerReferences: (.metadata.ownerReferences // [])
      },
      spec: (.spec // null),
      data: (.data // null),
      binaryData: (.binaryData // null),
      immutable: (.immutable // null)
    }
  ' <<<"$1" | sha256sum | awk '{print "sha256:" $1}'
}

now() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

manifest_verified=$(node "$SCRIPT_DIR/release-manifest.mjs" verify \
  --manifest "$MANIFEST" \
  --digest "$MANIFEST_DIGEST") ||
  fail 'release manifest verification failed'
[[ "$manifest_verified" == "$MANIFEST_DIGEST" ]] ||
  fail 'release manifest verifier returned an unexpected digest'
source_sha=$(jq -er '.sourceSha' "$MANIFEST")
release_id=$(jq -er '.releaseId' "$MANIFEST")
[[ "$source_sha" =~ $SOURCE_SHA_RE ]] || fail 'manifest source SHA is invalid'
[[ "$release_id" == "release-$source_sha" ]] || fail 'manifest release ID is invalid'
[[ "$AUTHORITY_DIGEST" == "$MANIFEST_DIGEST" ]] ||
  fail 'reset authority must be the exact release manifest digest'
expected_request_id=$(foundation_reset_request_id \
  "$ENVIRONMENT" "$source_sha" "$MANIFEST_DIGEST")
[[ "$REQUEST_ID" == "$expected_request_id" ]] ||
  fail 'reset request ID does not bind the exact release authority'
foundation_yaml_digest=$(file_digest "$FOUNDATION_YAML")
readonly source_sha release_id expected_request_id foundation_yaml_digest

expected_foundation_names="$work/expected-foundation-names.txt"
cat >"$expected_foundation_names" <<'EOF'
configmap/release-redis-hot-config
configmap/release-redis-queue-config
deployment.apps/release-redis-hot
service/release-minio
service/release-postgres
service/release-redis-hot
service/release-redis-queue
statefulset.apps/release-minio
statefulset.apps/release-postgres
statefulset.apps/release-redis-queue
EOF
foundation_names="$work/foundation-names.txt"
"${K[@]}" -n "$NAMESPACE" create --dry-run=client --validate=false \
  -f "$FOUNDATION_YAML" -o name |
  LC_ALL=C sort >"$foundation_names"
cmp -s "$expected_foundation_names" "$foundation_names" ||
  fail 'rendered foundation has an unexpected resource set'

if [[ -e "$EVIDENCE_ROOT" || -L "$EVIDENCE_ROOT" ]]; then
  [[ -d "$EVIDENCE_ROOT" && ! -L "$EVIDENCE_ROOT" ]] ||
    fail 'release evidence root is unsafe'
else
  mkdir -p "$EVIDENCE_ROOT"
fi
foundation_reset_root="$EVIDENCE_ROOT/foundation-resets"
if [[ -e "$foundation_reset_root" || -L "$foundation_reset_root" ]]; then
  [[ -d "$foundation_reset_root" && ! -L "$foundation_reset_root" ]] ||
    fail 'foundation reset root is unsafe'
else
  mkdir "$foundation_reset_root"
fi
chmod 0700 "$foundation_reset_root"
staging_root="$foundation_reset_root/.staging"
if [[ -e "$staging_root" || -L "$staging_root" ]]; then
  [[ -d "$staging_root" && ! -L "$staging_root" ]] ||
    fail 'foundation reset staging directory is unsafe'
else
  mkdir "$staging_root"
fi
chmod 0700 "$staging_root"
[[ -d "$staging_root" && ! -L "$staging_root" ]] ||
  fail 'foundation reset staging directory is unsafe'
state_root="$foundation_reset_root/$ENVIRONMENT"
if [[ -e "$state_root" || -L "$state_root" ]]; then
  [[ -d "$state_root" && ! -L "$state_root" ]] ||
    fail 'foundation reset state directory is unsafe'
else
  mkdir "$state_root"
fi
chmod 0700 "$state_root"
[[ -d "$state_root" && ! -L "$state_root" ]] ||
  fail 'foundation reset state directory is unsafe'
request_hex=${REQUEST_ID#sha256:}
plan="$state_root/$request_hex.foundation-reset-plan.json"
checkpoint="$state_root/$request_hex.foundation-reset-checkpoint.json"
ready_snapshot="$state_root/$request_hex.foundation-reset-ready.json"
evidence="$state_root/$request_hex.foundation-reset-evidence.json"
readonly foundation_reset_root staging_root state_root request_hex
readonly plan checkpoint ready_snapshot evidence

mkdir -p "$(dirname -- "$MUTATION_LOCK")"
exec 9>"$MUTATION_LOCK"
flock -x 9
mkdir -p "$(dirname -- "$TRAFFIC_LOCK")"
exec 8>"$TRAFFIC_LOCK"
flock -x 8

cleanup_stale_atomic_stages() {
  local entries="$work/staging-entries" stage name owner mode links size
  find "$staging_root" -mindepth 1 -maxdepth 1 -print0 >"$entries" ||
    fail 'foundation reset staging directory is unreadable'
  while IFS= read -r -d '' stage; do
    name=${stage##*/}
    [[ "$name" =~ ^\.foundation-reset\.[A-Za-z0-9]{6}$ &&
      -f "$stage" && ! -L "$stage" ]] ||
      fail 'foundation reset staging directory contains an unsafe entry'
    owner=$(stat -c '%u' "$stage")
    mode=$(stat -c '%a' "$stage")
    links=$(stat -c '%h' "$stage")
    size=$(stat -c '%s' "$stage")
    [[ "$owner" == "$EUID" && "$mode" == 600 && "$links" == 1 &&
      "$size" =~ ^[0-9]+$ && "$size" -le 16777216 ]] ||
      fail 'foundation reset staging entry has unsafe metadata'
    rm -f -- "$stage"
  done <"$entries"
}

cleanup_stale_atomic_stages

validate_reset_roll_forward_evidence() {
  local roll_request_id request_id_hex roll_root internal_evidence
  local roll_plan roll_checkpoint roll_archive roll_seal roll_cancellation
  local file pending_path
  roll_request_id=$(printf '%s\0%s\0%s\0%s' \
    combo-reset-roll-forward-v1 production "$source_sha" "$MANIFEST_DIGEST" |
    sha256sum | awk '{print "sha256:" $1}')
  request_id_hex=${roll_request_id#sha256:}
  roll_root="$EVIDENCE_ROOT/reset-roll-forwards/production"
  internal_evidence="$roll_root/$request_id_hex.evidence.json"
  roll_plan="$roll_root/$request_id_hex.plan.json"
  roll_checkpoint="$roll_root/$request_id_hex.checkpoint.json"
  roll_archive="$roll_root/$request_id_hex.old-pending.json"
  roll_seal="$roll_root/$request_id_hex.handoff-seal.json"
  roll_cancellation="$roll_root/$request_id_hex.cancellation.json"
  if [[ -z "$RESET_ROLL_FORWARD_EVIDENCE" ]]; then
    if [[ "$OPERATION" == assert-reuse && "$ENVIRONMENT" == production ]]; then
      if [[ -f "$roll_checkpoint" && ! -L "$roll_checkpoint" ]] &&
        [[ "$(jq -r '.phase // empty' "$roll_checkpoint")" == \
          cancelled-finalized ]]; then
        [[ -f "$roll_plan" && ! -L "$roll_plan" &&
          -f "$roll_archive" && ! -L "$roll_archive" &&
          -f "$roll_cancellation" && ! -L "$roll_cancellation" &&
          ! -e "$internal_evidence" && ! -L "$internal_evidence" &&
          ! -e "$roll_seal" && ! -L "$roll_seal" ]] ||
          fail 'cancelled reset roll-forward durable state is incomplete or unsafe'
        return 0
      fi
      for file in \
        "$internal_evidence" "$roll_plan" "$roll_checkpoint" \
        "$roll_archive" "$roll_seal"; do
        [[ ! -e "$file" && ! -L "$file" ]] ||
          fail 'this candidate entered reset roll-forward and requires its evidence'
      done
      [[ ! -e "$roll_cancellation" && ! -L "$roll_cancellation" ]] ||
        fail 'orphan reset roll-forward cancellation blocks this candidate'
    fi
    return 0
  fi
  [[ "$OPERATION" == assert-reuse && "$ENVIRONMENT" == production ]] ||
    fail 'reset roll-forward evidence is restricted to Production reuse admission'
  [[ -f "$RESET_ROLL_FORWARD_EVIDENCE" &&
    ! -L "$RESET_ROLL_FORWARD_EVIDENCE" ]] ||
    fail 'reset roll-forward evidence is not a regular file'
  for file in \
    "$internal_evidence" "$roll_plan" "$roll_checkpoint" "$roll_archive" "$roll_seal"; do
    [[ -f "$file" && ! -L "$file" ]] ||
      fail 'reset roll-forward durable state is incomplete or unsafe'
  done
  cmp -s "$RESET_ROLL_FORWARD_EVIDENCE" "$internal_evidence" ||
    fail 'reset roll-forward evidence differs from its durable completion record'
  jq -e \
    --arg requestId "$roll_request_id" \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg planDigest "$(file_digest "$roll_plan")" \
    --arg archiveDigest "$(file_digest "$roll_archive")" \
    --arg sealDigest "$(file_digest "$roll_seal")" '
      .schemaVersion == 1
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
    ' "$RESET_ROLL_FORWARD_EVIDENCE" >/dev/null ||
    fail 'reset roll-forward evidence does not authorize this exact reuse'
  jq -e \
    --arg requestId "$roll_request_id" \
    --arg planDigest "$(file_digest "$roll_plan")" \
    --arg evidenceDigest "$(file_digest "$RESET_ROLL_FORWARD_EVIDENCE")" '
      .schemaVersion == 1
      and .requestId == $requestId
      and .planDigest == $planDigest
      and .phase == "completed"
      and .evidenceDigest == $evidenceDigest
    ' "$roll_checkpoint" >/dev/null ||
    fail 'reset roll-forward completion checkpoint is invalid'
  pending_path="$EVIDENCE_ROOT/$ENVIRONMENT/pending.json"
  if [[ -e "$pending_path" || -L "$pending_path" ]]; then
    [[ -f "$pending_path" && ! -L "$pending_path" ]] ||
      fail 'Production pending path is unsafe after reset roll-forward'
    jq -e \
      --arg sourceSha "$source_sha" \
      --arg releaseId "$release_id" \
      --arg manifestDigest "$MANIFEST_DIGEST" '
        .schemaVersion == 3
        and .sourceSha == $sourceSha
        and .releaseId == $releaseId
        and .manifestDigest == $manifestDigest
        and .foundationResetEvidenceDigest == null
      ' "$pending_path" >/dev/null ||
      fail 'reset roll-forward retained a pending checkpoint for another release'
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

audit_reset_roll_forward_journals
validate_reset_roll_forward_evidence

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
  local plan_digest_value ready_digest
  plan_digest_value=$(file_digest "$plan_file")
  ready_digest=$(file_digest "$ready_file")
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
    --arg planDigest "$plan_digest_value" \
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
    --arg planDigest "$plan_digest_value" '
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
    --arg planDigest "$plan_digest_value" \
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

reset_consumption_directory_matches() {
  local directory=$1 proof_name=$2 reset_evidence=$3 reset_digest=$4
  local source=$5 release=$6 manifest=$7 proof
  proof="$directory/$proof_name"
  [[ -f "$proof" && ! -L "$proof" &&
    -f "$directory/foundation-reset-evidence.json" &&
    ! -L "$directory/foundation-reset-evidence.json" &&
    -f "$directory/SHA256SUMS" && ! -L "$directory/SHA256SUMS" ]] ||
    return 1
  (
    cd "$directory"
    sha256sum --quiet -c SHA256SUMS
  ) || return 1
  checksum_set_lists_file_once "$directory/SHA256SUMS" "$proof_name" ||
    return 1
  checksum_set_lists_file_once \
    "$directory/SHA256SUMS" foundation-reset-evidence.json || return 1
  cmp -s "$reset_evidence" "$directory/foundation-reset-evidence.json" ||
    return 1
  if [[ "$proof_name" == deploy-evidence.json ]]; then
    jq -e \
      --arg environment "$ENVIRONMENT" \
      --arg namespace "$NAMESPACE" \
      --arg sourceSha "$source" \
      --arg releaseId "$release" \
      --arg manifestDigest "$manifest" \
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
      --arg sourceSha "$source" \
      --arg releaseId "$release" \
      --arg manifestDigest "$manifest" \
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

completed_reset_is_consumed() {
  local reset_evidence=$1 reset_digest journal_source journal_release journal_manifest
  local pending environment_root finalized activation
  reset_digest=$(file_digest "$reset_evidence")
  journal_source=$(jq -er '.sourceSha' "$reset_evidence")
  journal_release=$(jq -er '.releaseId' "$reset_evidence")
  journal_manifest=$(jq -er '.manifestDigest' "$reset_evidence")
  [[ "$journal_source" =~ $SOURCE_SHA_RE &&
    "$journal_release" == "release-$journal_source" &&
    "$journal_manifest" =~ $DIGEST_RE ]] ||
    fail 'completed reset journal has an invalid release identity'
  environment_root="$EVIDENCE_ROOT/$ENVIRONMENT"
  finalized="$environment_root/$journal_release"
  if [[ -e "$finalized" || -L "$finalized" ]]; then
    [[ -d "$finalized" && ! -L "$finalized" ]] ||
      fail 'final release evidence directory is unsafe during reset journal audit'
    reset_consumption_directory_matches \
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
    reset_consumption_directory_matches \
      "$activation" activation-evidence.json "$reset_evidence" "$reset_digest" \
      "$journal_source" "$journal_release" "$journal_manifest" ||
      fail 'activation evidence does not consume its reset journal'
    return 0
  fi
  return 1
}

audit_reset_journals() {
  local plan_file stem checkpoint_file ready_file evidence_file phase pending
  local pending_reset_digest='' pending_source pending_release pending_manifest
  local -a plan_files checkpoint_files ready_files evidence_files
  shopt -s nullglob
  plan_files=("$state_root"/*.foundation-reset-plan.json)
  checkpoint_files=("$state_root"/*.foundation-reset-checkpoint.json)
  ready_files=("$state_root"/*.foundation-reset-ready.json)
  evidence_files=("$state_root"/*.foundation-reset-evidence.json)
  shopt -u nullglob

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
      if [[ "$OPERATION" != reset || "$stem" != "$request_hex" ]] &&
        ! completed_reset_is_consumed "$evidence_file"; then
        fail 'an unconsumed completed foundation reset blocks this operation'
      fi
    elif [[ "$OPERATION" != reset || "$stem" != "$request_hex" ]]; then
      fail 'an unfinished foundation reset journal blocks this operation'
    fi
  done

  for checkpoint_file in "${checkpoint_files[@]}"; do
    stem=${checkpoint_file##*/}
    stem=${stem%.foundation-reset-checkpoint.json}
    [[ -f "$state_root/$stem.foundation-reset-plan.json" ]] ||
      fail 'orphan foundation reset checkpoint blocks this operation'
  done
  for ready_file in "${ready_files[@]}"; do
    stem=${ready_file##*/}
    stem=${stem%.foundation-reset-ready.json}
    [[ -f "$state_root/$stem.foundation-reset-plan.json" ]] ||
      fail 'orphan foundation reset ready snapshot blocks this operation'
  done
  for evidence_file in "${evidence_files[@]}"; do
    stem=${evidence_file##*/}
    stem=${stem%.foundation-reset-evidence.json}
    [[ -f "$state_root/$stem.foundation-reset-plan.json" ]] ||
      fail 'orphan foundation reset evidence blocks this operation'
  done

  pending="$EVIDENCE_ROOT/$ENVIRONMENT/pending.json"
  if [[ -e "$pending" || -L "$pending" ]]; then
    [[ -f "$pending" && ! -L "$pending" ]] ||
      fail 'release pending checkpoint is unsafe during reset journal audit'
    pending_reset_digest=$(jq -r \
      '.foundationResetEvidenceDigest // empty' "$pending")
    if [[ -n "$pending_reset_digest" ]]; then
      pending_source=$(jq -er '.sourceSha' "$pending") ||
        fail 'pending clean-slate boundary lacks a source SHA'
      pending_release=$(jq -er '.releaseId' "$pending") ||
        fail 'pending clean-slate boundary lacks a release ID'
      pending_manifest=$(jq -er '.manifestDigest' "$pending") ||
        fail 'pending clean-slate boundary lacks a manifest digest'
      [[ "$pending_source" =~ $SOURCE_SHA_RE &&
        "$pending_release" == "release-$pending_source" &&
        "$pending_manifest" =~ $DIGEST_RE &&
        "$pending_reset_digest" =~ $DIGEST_RE ]] ||
        fail 'pending clean-slate boundary has an invalid release identity'
      if [[ "$OPERATION" == reset ]]; then
        [[ "$pending_source" == "$source_sha" &&
          "$pending_release" == "$release_id" &&
          "$pending_manifest" == "$MANIFEST_DIGEST" ]] ||
          fail 'a pending clean-slate boundary requires controlled roll-forward'
        [[ -f "$evidence" && ! -L "$evidence" &&
          "$(file_digest "$evidence")" == "$pending_reset_digest" ]] ||
          fail 'pending clean-slate boundary is not bound to this reset evidence'
      fi
    fi
  fi

  if [[ "$OPERATION" == assert-reuse ]]; then
    [[ -z "$pending_reset_digest" ]] ||
      fail 'a pending clean-slate boundary requires controlled roll-forward'
    if [[ -e "$plan" || -L "$plan" ||
      -e "$checkpoint" || -L "$checkpoint" ||
      -e "$ready_snapshot" || -L "$ready_snapshot" ||
      -e "$evidence" || -L "$evidence" ||
      -e "$OUTPUT" || -L "$OUTPUT" ]]; then
      fail 'this candidate has entered the clean-slate boundary and cannot use reuse'
    fi
    status 'foundation_reuse_admission=true reset_journal_absent=true'
    exit 0
  fi
}

audit_foundation_reset_journals() {
  local mode result predecessor_path state_root_real predecessor_real
  [[ -f "$SCRIPT_DIR/foundation-reset-journal.mjs" &&
    ! -L "$SCRIPT_DIR/foundation-reset-journal.mjs" ]] ||
    fail 'foundation reset journal auditor is missing or unsafe'
  if [[ "$OPERATION" == reset ]]; then
    mode=reset
  else
    mode=reuse
  fi
  result=$(node "$SCRIPT_DIR/foundation-reset-journal.mjs" audit \
    --evidence-root "$EVIDENCE_ROOT" \
    --environment "$ENVIRONMENT" \
    --source-sha "$source_sha" \
    --manifest-digest "$MANIFEST_DIGEST" \
    --mode "$mode") ||
    fail 'global foundation reset journal audit failed'
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
      and (.currentRetry | type == "boolean")
      and (.chainHeadRequestId == null
        or (.chainHeadRequestId | test("^sha256:[0-9a-f]{64}$")))
      and (.chainConsumed | type == "boolean")
      and all([.journalCount, .completedJournalCount][];
        type == "number" and . >= 0 and floor == .)
      and .completedJournalCount <= .journalCount
      and (
        (.supersededReset == null and .predecessorEvidencePath == null)
        or (
          (.supersededReset | keys | sort) == ([
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
          and (.predecessorEvidencePath
            | type == "string" and length > 0)
        )
      )
      and (
        if $mode == "reuse"
        then
          .authorization == "reuse"
          and .currentRetry == false
          and .supersededReset == null
          and .predecessorEvidencePath == null
          and .chainConsumed == true
        elif .authorization == "normal-reset"
        then
          .currentRetry == false
          and .supersededReset == null
          and .predecessorEvidencePath == null
          and .chainConsumed == true
        elif .authorization == "superseding-reset"
        then
          .currentRetry == false
          and .supersededReset != null
          and .chainHeadRequestId == .supersededReset.requestId
          and .chainConsumed == false
        elif .authorization == "exact-reset-retry"
        then .currentRetry == true
        else false
        end
      )
    ' <<<"$result" >/dev/null ||
    fail 'foundation reset journal auditor returned an invalid admission'
  AUDITED_SUPERSEDED_RESET_JSON=$(jq -c '.supersededReset' <<<"$result")
  if [[ "$OPERATION" == assert-reuse ]]; then
    status 'foundation_reuse_admission=true reset_journal_consumed=true'
    exit 0
  fi
  predecessor_path=$(jq -r '.predecessorEvidencePath // ""' <<<"$result")
  PREDECESSOR_RESET_EVIDENCE=''
  if [[ -n "$predecessor_path" ]]; then
    [[ "$ENVIRONMENT" == preview && "$OPERATION" == reset ]] ||
      fail 'only Preview reset may receive a supersession predecessor'
    state_root_real=$(realpath -e "$state_root")
    predecessor_real=$(realpath -e "$predecessor_path")
    [[ "${predecessor_real%/*}" == "$state_root_real" &&
      "${predecessor_real##*/}" =~ \
        ^[0-9a-f]{64}\.foundation-reset-evidence\.json$ ]] ||
      fail 'foundation reset auditor returned an unsafe predecessor path'
    PREDECESSOR_RESET_EVIDENCE=$predecessor_real
  fi
}

audit_foundation_reset_journals

"${K[@]}" -n "$NAMESPACE" apply --dry-run=server \
  -f "$FOUNDATION_YAML" -o json |
  node "$SCRIPT_DIR/verify-rendered-release.mjs" \
    --manifest "$MANIFEST" \
    --manifest-digest "$MANIFEST_DIGEST" \
    --environment "$ENVIRONMENT" \
    --phase foundation >/dev/null ||
  fail 'server-rendered foundation contract verification failed'

get_resource() {
  local kind=$1 name=$2
  "${K[@]}" -n "$NAMESPACE" get "$kind/$name" -o json
}

get_resource_optional() {
  local kind=$1 name=$2
  "${K[@]}" -n "$NAMESPACE" get "$kind/$name" --ignore-not-found -o json
}

validate_captured_resource() {
  local kind=$1 name=$2 value=$3
  jq -e \
    --arg namespace "$NAMESPACE" \
    --arg name "$name" '
      .metadata.namespace == $namespace
      and .metadata.name == $name
      and (.metadata.uid | type == "string" and length > 0)
      and (.metadata.resourceVersion | type == "string" and length > 0)
      and .metadata.deletionTimestamp == null
    ' <<<"$value" >/dev/null ||
    fail "resource is not stable: $kind/$name"
}

captured_resource() {
  local kind=$1 name=$2 value
  value=$(get_resource "$kind" "$name" 2>/dev/null) ||
    fail "required resource is missing: $kind/$name"
  validate_captured_resource "$kind" "$name" "$value"
  printf '%s\n' "$value"
}

preview_gate_is_closed() {
  local origin=$1 label=$2 headers health_status version_status
  headers="$work/active-route-$label-gate.headers"
  health_status=$(curl --silent --show-error --output /dev/null \
    --write-out '%{http_code}' --max-time 10 --max-filesize 1048576 \
    "$origin/__review/healthz") ||
    return 1
  [[ "$health_status" == 200 ]] || return 1
  version_status=$(curl --silent --show-error --output /dev/null \
    --dump-header "$headers" --write-out '%{http_code}' --max-time 10 \
    --max-filesize 1048576 "$origin/version.json") ||
    return 1
  [[ "$version_status" == 401 ]] || return 1
  grep -Eqi \
    '^X-Combo-Review-Gate:[[:space:]]*required[[:space:]]*$' \
    "$headers"
}

capture_legacy_production_authority() {
  local forward_service=$1 canary_digest=$2 formal_digest=$3
  local legacy_current pending checkpoint_root checkpoint_entry
  local evidence_path evidence_real environment_root verified_prior
  local prior_source prior_release prior_manifest prior_web_image
  local expected_files actual_files file
  local traffic_evidence deploy_evidence unit unit_digest
  local route_work canary_route_evidence formal_route_evidence

  [[ "$ENVIRONMENT" == production ]] ||
    fail 'legacy release checkpoint fallback is Production-only'

  pending="$EVIDENCE_ROOT/production/pending.json"
  [[ ! -e "$pending" && ! -L "$pending" ]] ||
    fail 'legacy Production fallback is blocked by a pending release'

  checkpoint_root="$TRAFFIC_CHECKPOINT_ROOT/production"
  if sudo -n test -e "$checkpoint_root" ||
    sudo -n test -L "$checkpoint_root"; then
    if ! sudo -n test -d "$checkpoint_root" ||
      ! sudo -n test ! -L "$checkpoint_root"; then
      fail 'legacy Production traffic checkpoint root is unsafe'
    fi
    checkpoint_entry=$(sudo -n find "$checkpoint_root" \
      -mindepth 1 -maxdepth 1 -printf . -quit) ||
      fail 'legacy Production traffic checkpoint root is unreadable'
    [[ -z "$checkpoint_entry" ]] ||
      fail 'legacy Production fallback is blocked by a traffic checkpoint'
  fi

  legacy_current="$EVIDENCE_ROOT/production/current.json"
  [[ -f "$legacy_current" && ! -L "$legacy_current" ]] ||
    fail 'legacy Production release checkpoint is missing or unsafe'
  jq -e '
    (keys | sort) == ([
      "schemaVersion", "status", "environment", "namespace", "sourceSha",
      "releaseId", "manifestDigest", "evidencePath"
    ] | sort)
    and .schemaVersion == 1
    and .status == "passed"
    and .environment == "production"
    and .namespace == "combo"
    and (.sourceSha | type == "string" and test("^[0-9a-f]{40}$"))
    and .releaseId == ("release-" + .sourceSha)
    and (.manifestDigest | type == "string"
      and test("^sha256:[0-9a-f]{64}$"))
    and (.evidencePath | type == "string" and length > 0)
  ' "$legacy_current" >/dev/null ||
    fail 'legacy Production release checkpoint is invalid'
  prior_source=$(jq -er '.sourceSha' "$legacy_current")
  prior_release=$(jq -er '.releaseId' "$legacy_current")
  prior_manifest=$(jq -er '.manifestDigest' "$legacy_current")
  [[ "$forward_service" == "release-${prior_source:0:12}-web" ]] ||
    fail 'legacy Production Web forward and checkpoint disagree'

  evidence_path=$(jq -er '.evidencePath' "$legacy_current")
  environment_root=$(realpath -e "$EVIDENCE_ROOT/production") ||
    fail 'legacy Production evidence root is missing'
  evidence_real=$(realpath -e "$evidence_path") ||
    fail 'legacy Production release evidence is missing'
  [[ "$evidence_real" == "$environment_root/$prior_release" &&
    -d "$evidence_real" && ! -L "$evidence_path" ]] ||
    fail 'legacy Production release evidence escaped its allowlist'

  expected_files="$work/legacy-production-files.expected"
  actual_files="$work/legacy-production-files.actual"
  cat >"$expected_files" <<'EOF'
SHA256SUMS
apps.yaml
cleanup-evidence.json
deploy-evidence.json
foundation.yaml
init.yaml
migrate.yaml
migration-files.txt
release.json
release.sha256
traffic-evidence.json
web-asset-manifest.json
EOF
  find "$evidence_real" -mindepth 1 -maxdepth 1 -printf '%f\n' |
    LC_ALL=C sort >"$actual_files"
  cmp -s "$expected_files" "$actual_files" ||
    fail 'legacy Production release evidence has an unexpected file set'
  while IFS= read -r file; do
    [[ -f "$evidence_real/$file" && ! -L "$evidence_real/$file" ]] ||
      fail "legacy Production release evidence file is unsafe: $file"
  done <"$expected_files"

  awk '
    (NF == 2 &&
      length($1) == 64 &&
      $1 ~ /^[0-9a-f]+$/ &&
      $2 ~ /^[A-Za-z0-9._-]+$/) {
        print $2
        next
      }
    { exit 1 }
  ' "$evidence_real/SHA256SUMS" |
    LC_ALL=C sort >"$work/legacy-production-checksums.actual" ||
    fail 'legacy Production checksum set is malformed'
  sed '/^SHA256SUMS$/d' "$expected_files" \
    >"$work/legacy-production-checksums.expected"
  cmp -s \
    "$work/legacy-production-checksums.expected" \
    "$work/legacy-production-checksums.actual" ||
    fail 'legacy Production checksum set has an unexpected file set'
  (
    cd "$evidence_real"
    sha256sum --quiet -c SHA256SUMS
  ) || fail 'legacy Production release evidence digest set changed'
  [[ "$(tr -d '\n' <"$evidence_real/release.sha256")" == "$prior_manifest" ]] ||
    fail 'legacy Production release manifest digest changed'
  verified_prior=$(node "$SCRIPT_DIR/release-manifest.mjs" verify \
    --manifest "$evidence_real/release.json" \
    --source-sha "$prior_source" \
    --release-id "$prior_release" \
    --digest "$prior_manifest") ||
    fail 'legacy Production release manifest no longer verifies'
  [[ "$verified_prior" == "$prior_manifest" ]] ||
    fail 'legacy Production release manifest verifier returned another digest'
  prior_web_image=$(jq -er '.images.web' "$evidence_real/release.json")
  [[ "$prior_web_image" =~ \
    ^ghcr\.io/dangdang-tech/combo-web@sha256:[0-9a-f]{64}$ ]] ||
    fail 'legacy Production release manifest Web image is invalid'

  traffic_evidence="$evidence_real/traffic-evidence.json"
  deploy_evidence="$evidence_real/deploy-evidence.json"
  jq -e \
    --arg sourceSha "$prior_source" \
    --arg releaseId "$prior_release" \
    --arg manifestDigest "$prior_manifest" \
    --arg canaryPath "$NGINX_CONFIG" \
    --arg canaryDigest "$canary_digest" \
    --arg webService "$forward_service" '
      (keys | sort) == ([
        "schemaVersion", "environment", "sourceSha", "releaseId",
        "manifestDigest", "publicOrigin", "s3Origin", "nginx", "units",
        "checks", "activatedAt"
      ] | sort)
      and .schemaVersion == 1
      and .environment == "production"
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and .publicOrigin == "https://agora.43-160-242-46.sslip.io"
      and .s3Origin == "https://s3.43-160-242-46.sslip.io"
      and .nginx == {path: $canaryPath, sha256: $canaryDigest}
      and (.activatedAt | type == "string" and length > 0)
      and .checks == {
        loopbackWebRelease: true,
        loopbackMinioReady: true,
        publicWebRelease: true,
        publicMinioReady: true
      }
      and (.units | type == "array" and length == 2)
      and ([.units[].name] | sort) == ([
        "combo-release-production-web-forward.service",
        "combo-release-production-minio-forward.service"
      ] | sort)
      and all(.units[];
        (keys | sort) == ["mainPid", "name", "port", "service", "sha256"]
        and (.mainPid | type == "number" and . > 0 and floor == .)
        and (.sha256 | test("^sha256:[0-9a-f]{64}$"))
        and (
          if .name == "combo-release-production-web-forward.service"
          then .service == $webService and .port == 18082
          else
            .name == "combo-release-production-minio-forward.service"
            and .service == "release-minio"
            and .port == 19002
          end
        ))
    ' "$traffic_evidence" >/dev/null ||
    fail 'legacy Production traffic evidence is invalid'
  jq -e \
    --arg sourceSha "$prior_source" \
    --arg releaseId "$prior_release" \
    --arg manifestDigest "$prior_manifest" \
    --slurpfile traffic "$traffic_evidence" '
      .schemaVersion == 1
      and .status == "passed"
      and .environment == "production"
      and .namespace == "combo"
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and .traffic == $traffic[0]
    ' "$deploy_evidence" >/dev/null ||
    fail 'legacy Production deploy evidence does not match its checkpoint'

  for unit in \
    combo-release-production-web-forward.service \
    combo-release-production-minio-forward.service; do
    sudo -n systemctl is-enabled --quiet "$unit" ||
      fail "legacy Production forward unit is not enabled: $unit"
    sudo -n systemctl is-active --quiet "$unit" ||
      fail "legacy Production forward unit is not active: $unit"
    sudo -n test -f "/etc/systemd/system/$unit" ||
      fail "legacy Production forward unit is missing: $unit"
    sudo -n test ! -L "/etc/systemd/system/$unit" ||
      fail "legacy Production forward unit is unsafe: $unit"
    unit_digest=$(sudo -n sha256sum "/etc/systemd/system/$unit" |
      awk '{print "sha256:" $1}')
    [[ "$unit_digest" == "$(jq -er --arg unit "$unit" \
      'first(.units[] | select(.name == $unit) | .sha256)' \
      "$traffic_evidence")" ]] ||
      fail "legacy Production forward unit changed: $unit"
  done

  [[ "$formal_digest" == "$FORMAL_INITIAL_SHA256" ]] ||
    fail 'legacy Production formal route is outside its initial allowlist'
  route_work=$(mktemp -d "$work/legacy-production-routes.XXXXXX")
  canary_route_evidence="$route_work/canary-route.json"
  formal_route_evidence="$route_work/formal-route.json"
  node "$SCRIPT_DIR/release-nginx-route.mjs" rewrite \
    --input "$NGINX_CONFIG" \
    --output "$route_work/canary.candidate" \
    --contract production-canary \
    --target release >"$canary_route_evidence" ||
    fail 'legacy Production canary route is structurally invalid'
  node "$SCRIPT_DIR/release-nginx-route.mjs" rewrite \
    --input "$FORMAL_NGINX_CONFIG" \
    --output "$route_work/formal.candidate" \
    --contract production-formal \
    --target release >"$formal_route_evidence" ||
    fail 'legacy Production formal route is structurally invalid'
  jq -e \
    --arg canaryDigest "$canary_digest" '
      .contract == "production-canary"
      and .beforeMode == "release"
      and .afterMode == "release"
      and .beforeSha256 == $canaryDigest
      and .afterSha256 == $canaryDigest
    ' "$canary_route_evidence" >/dev/null ||
    fail 'legacy Production canary route is not the trusted release route'
  jq -e \
    --arg formalDigest "$formal_digest" '
      .contract == "production-formal"
      and .beforeMode == "legacy"
      and .afterMode == "release"
      and .beforeSha256 == $formalDigest
      and (.afterSha256 | test("^sha256:[0-9a-f]{64}$"))
      and .afterSha256 != .beforeSha256
    ' "$formal_route_evidence" >/dev/null ||
    fail 'legacy Production formal route is not the initial legacy route'

  jq -n \
    --arg sourceSha "$prior_source" \
    --arg releaseId "$prior_release" \
    --arg manifestDigest "$prior_manifest" \
    --arg canaryNginxSha256 "$canary_digest" \
    --arg formalNginxSha256 "$formal_digest" \
    --arg webService "$forward_service" '{
      schemaVersion: 1,
      environment: "production",
      sourceSha: $sourceSha,
      releaseId: $releaseId,
      manifestDigest: $manifestDigest,
      canaryNginxSha256: $canaryNginxSha256,
      formalNginxSha256: $formalNginxSha256,
      webService: $webService
    }' >"$route_work/bootstrap-traffic-state.json"
  jq -n \
    --arg sourceSha "$prior_source" \
    --arg releaseId "$prior_release" \
    --arg manifestDigest "$prior_manifest" \
    --arg webService "$forward_service" \
    --arg webImage "$prior_web_image" \
    --arg trafficStateDigest \
      "$(file_digest "$route_work/bootstrap-traffic-state.json")" '{
      sourceSha: $sourceSha,
      releaseId: $releaseId,
      manifestDigest: $manifestDigest,
      webService: $webService,
      webImage: $webImage,
      trafficStateDigest: $trafficStateDigest
    }'
}

capture_preview_route_version() {
  local name=$1 output=$2
  preview_gate_is_closed \
    "http://127.0.0.1:${WEB_FORWARD_PORT}" loopback ||
    fail 'active Preview Web forward gate is not healthy and closed'
  preview_gate_is_closed "$PUBLIC_ORIGIN" public ||
    fail 'active public Preview Web gate is not healthy and closed'
  # The gate token expands only inside the exact active Web container.
  # shellcheck disable=SC2016
  "${K[@]}" -n "$NAMESPACE" exec "deployment/$name" -c web -- \
    sh -euc \
      'test -n "${REVIEW_ACCESS_TOKEN:-}" && exec wget --header="Cookie: combo_review_access=$REVIEW_ACCESS_TOKEN" -qO- "$1/version.json"' \
      sh "$PUBLIC_ORIGIN" >"$output" ||
    fail 'active authenticated Preview Web route is not readable'
}

capture_active_route_web() {
  local current_state web name service source release manifest web_image
  local traffic_digest forward_digest forward_service canary_digest formal_digest
  local route_version route_version_digest authority_mode authority_json
  local expected_web_image
  current_state="$TRAFFIC_STATE_ROOT/$ENVIRONMENT/current.json"

  if ! sudo -n test -f "$WEB_FORWARD_ENV" ||
    ! sudo -n test ! -L "$WEB_FORWARD_ENV"; then
    fail 'active release Web forward environment is missing or unsafe'
  fi
  [[ "$(sudo -n awk 'END {print NR}' "$WEB_FORWARD_ENV")" == 1 ]] ||
    fail 'active release Web forward environment has an invalid shape'
  forward_service=$(sudo -n awk -F= '
    $1 == "COMBO_RELEASE_WEB_SERVICE" {print $2}
  ' "$WEB_FORWARD_ENV")
  sudo -n systemctl is-enabled --quiet "$WEB_FORWARD_UNIT" ||
    fail 'active release Web forward unit is not enabled'
  sudo -n systemctl is-active --quiet "$WEB_FORWARD_UNIT" ||
    fail 'active release Web forward unit is not active'

  if ! sudo -n test -f "$NGINX_CONFIG" ||
    ! sudo -n test ! -L "$NGINX_CONFIG"; then
    fail 'active release Nginx route is missing or unsafe'
  fi
  canary_digest=$(sudo -n sha256sum "$NGINX_CONFIG" |
    awk '{print "sha256:" $1}')
  formal_digest=''
  if [[ -n "$FORMAL_NGINX_CONFIG" ]]; then
    if ! sudo -n test -f "$FORMAL_NGINX_CONFIG" ||
      ! sudo -n test ! -L "$FORMAL_NGINX_CONFIG"; then
      fail 'formal release Nginx route is missing or unsafe'
    fi
    formal_digest=$(sudo -n sha256sum "$FORMAL_NGINX_CONFIG" |
      awk '{print "sha256:" $1}')
  fi

  if [[ -e "$current_state" || -L "$current_state" ]]; then
    [[ -f "$current_state" && ! -L "$current_state" ]] ||
      fail 'active release traffic state is missing or unsafe'
    jq -e \
      --arg environment "$ENVIRONMENT" '
        (keys | sort) == ([
          "schemaVersion", "environment", "sourceSha", "releaseId",
          "manifestDigest", "canaryNginxSha256", "formalNginxSha256",
          "webService"
        ] | sort)
        and .schemaVersion == 1
        and .environment == $environment
        and (.sourceSha | test("^[0-9a-f]{40}$"))
        and .releaseId == ("release-" + .sourceSha)
        and (.manifestDigest | test("^sha256:[0-9a-f]{64}$"))
        and (.canaryNginxSha256 | test("^sha256:[0-9a-f]{64}$"))
        and (
          if $environment == "preview"
          then .formalNginxSha256 == null
          else (.formalNginxSha256 | test("^sha256:[0-9a-f]{64}$"))
          end
        )
        and .webService == ("release-" + .sourceSha[0:12] + "-web")
      ' "$current_state" >/dev/null ||
      fail 'active release traffic state is invalid'
    [[ "$canary_digest" == \
      "$(jq -er '.canaryNginxSha256' "$current_state")" ]] ||
      fail 'active release Nginx route changed outside its traffic state'
    if [[ -n "$FORMAL_NGINX_CONFIG" ]]; then
      [[ "$formal_digest" == \
        "$(jq -er '.formalNginxSha256' "$current_state")" ]] ||
        fail 'formal release Nginx route changed outside its traffic state'
    fi
    authority_mode=traffic-state
    authority_json=$(jq -c \
      --arg trafficStateDigest "$(file_digest "$current_state")" '{
        sourceSha,
        releaseId,
        manifestDigest,
        webService,
        webImage: null,
        trafficStateDigest: $trafficStateDigest
      }' "$current_state")
  else
    [[ "$ENVIRONMENT" == production ]] ||
      fail 'active release traffic state is missing or unsafe'
    authority_mode=legacy-production
    authority_json=$(capture_legacy_production_authority \
      "$forward_service" "$canary_digest" "$formal_digest")
  fi
  jq -e '
    (keys | sort) == ([
      "sourceSha", "releaseId", "manifestDigest", "webService",
      "webImage", "trafficStateDigest"
    ] | sort)
    and (.sourceSha | test("^[0-9a-f]{40}$"))
    and .releaseId == ("release-" + .sourceSha)
    and (.manifestDigest | test("^sha256:[0-9a-f]{64}$"))
    and .webService == ("release-" + .sourceSha[0:12] + "-web")
    and (
      .webImage == null
      or (.webImage
        | test("^ghcr.io/dangdang-tech/combo-web@sha256:[0-9a-f]{64}$"))
    )
    and (.trafficStateDigest | test("^sha256:[0-9a-f]{64}$"))
  ' <<<"$authority_json" >/dev/null ||
    fail 'active release traffic authority is invalid'

  name=$(jq -er '.webService' <<<"$authority_json")
  [[ "$forward_service" == "$name" ]] ||
    fail 'active release Web forward does not match the traffic authority'
  source=$(jq -er '.sourceSha' <<<"$authority_json")
  release=$(jq -er '.releaseId' <<<"$authority_json")
  manifest=$(jq -er '.manifestDigest' <<<"$authority_json")
  expected_web_image=$(jq -r '.webImage // ""' <<<"$authority_json")
  traffic_digest=$(jq -er '.trafficStateDigest' <<<"$authority_json")
  web=$(captured_resource deployment "$name")
  service=$(captured_resource service "$name")
  jq -e \
    --arg namespace "$NAMESPACE" \
    --arg name "$name" \
    --arg sourceSha "$source" \
    --arg releaseId "$release" \
    --arg manifestDigest "$manifest" \
    --arg expectedWebImage "$expected_web_image" '
      .metadata.namespace == $namespace
      and .metadata.name == $name
      and .metadata.deletionTimestamp == null
      and .metadata.labels["combo.build/release-track"] == "release-v1"
      and (.spec.replicas | type == "number" and . > 0 and floor == .)
      and .status.readyReplicas == .spec.replicas
      and .status.availableReplicas == .spec.replicas
      and .spec.selector.matchLabels == {
        app: $name,
        "combo.build/release-track": "release-v1"
      }
      and .spec.template.metadata.labels.app == $name
      and .spec.template.metadata.labels["combo.build/release-track"] == "release-v1"
      and .spec.template.metadata.annotations["combo.build/source-sha"] == $sourceSha
      and .spec.template.metadata.annotations["combo.build/release-id"] == $releaseId
      and .spec.template.metadata.annotations["combo.build/release-manifest-digest"]
        == $manifestDigest
      and ([.spec.template.spec.containers[] | select(.name == "web")] | length) == 1
      and (
        first(.spec.template.spec.containers[] | select(.name == "web") | .image)
        | test("^ghcr.io/dangdang-tech/combo-web@sha256:[0-9a-f]{64}$")
      )
      and (
        $expectedWebImage == ""
        or first(
          .spec.template.spec.containers[]
          | select(.name == "web")
          | .image
        ) == $expectedWebImage
      )
    ' <<<"$web" >/dev/null ||
    fail 'active release Web deployment is not ready or identity-bound'
  jq -e \
    --arg namespace "$NAMESPACE" \
    --arg name "$name" '
      .metadata.namespace == $namespace
      and .metadata.name == $name
      and .metadata.deletionTimestamp == null
      and .metadata.labels["combo.build/release-track"] == "release-v1"
      and .spec.type == "ClusterIP"
      and .spec.selector == {
        app: $name,
        "combo.build/release-track": "release-v1"
      }
      and (.spec.ports | type == "array" and length == 1)
      and .spec.ports[0].name == "http"
      and .spec.ports[0].port == 80
      and .spec.ports[0].targetPort == 80
      and .spec.ports[0].protocol == "TCP"
      and .spec.ports[0].nodePort == null
    ' <<<"$service" >/dev/null ||
    fail 'active release Web Service is not identity-bound'
  route_version="$work/active-route-version.json"
  if [[ "$ENVIRONMENT" == preview ]]; then
    capture_preview_route_version "$name" "$route_version"
  else
    curl --fail --silent --show-error --max-time 10 --max-filesize 1048576 \
      "http://127.0.0.1:${WEB_FORWARD_PORT}/version.json" >"$route_version" ||
      fail 'active release Web forward route is not readable'
  fi
  jq -e \
    --arg environment "$ENVIRONMENT" \
    --arg sourceSha "$source" \
    --arg releaseId "$release" \
    --arg manifestDigest "$manifest" '
      (keys | sort) == ([
        "schemaVersion", "environment", "sourceSha", "releaseId", "builtAt",
        "releaseManifestDigest", "webAssetManifest"
      ] | sort)
      and .schemaVersion == 1
      and .environment == $environment
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .releaseManifestDigest == $manifestDigest
      and (.builtAt
        | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$"))
      and (.webAssetManifest | test("^sha256:[0-9a-f]{64}$"))
  ' "$route_version" >/dev/null ||
    fail 'active release Web forward route has the wrong release identity'
  if [[ "$authority_mode" == legacy-production ]]; then
    curl --fail --silent --show-error --max-time 10 --max-filesize 1048576 \
      "$PUBLIC_ORIGIN/version.json" >"$work/active-public-route-version.json" ||
      fail 'legacy Production public Web route is not readable'
    jq -e --slurpfile loopback "$route_version" \
      '. == $loopback[0]' "$work/active-public-route-version.json" >/dev/null ||
      fail 'legacy Production public and loopback release identity disagree'
  fi
  web_image=$(jq -er \
    'first(.spec.template.spec.containers[] | select(.name == "web") | .image)' \
    <<<"$web")
  forward_digest=$(sudo -n sha256sum "$WEB_FORWARD_ENV" |
    awk '{print "sha256:" $1}')
  route_version_digest=$(file_digest "$route_version")
  jq -n \
    --arg name "$name" \
    --arg uid "$(jq -er '.metadata.uid' <<<"$web")" \
    --arg resourceVersion "$(jq -er '.metadata.resourceVersion' <<<"$web")" \
    --arg serviceName "$name" \
    --arg serviceUid "$(jq -er '.metadata.uid' <<<"$service")" \
    --arg serviceResourceVersion \
      "$(jq -er '.metadata.resourceVersion' <<<"$service")" \
    --arg sourceSha "$source" \
    --arg releaseId "$release" \
    --arg manifestDigest "$manifest" \
    --arg webImage "$web_image" \
    --arg trafficStateDigest "$traffic_digest" \
    --arg forwardEnvDigest "$forward_digest" \
    --arg forwardUnit "$WEB_FORWARD_UNIT" \
    --argjson forwardPort "$WEB_FORWARD_PORT" \
    --arg routeVersionDigest "$route_version_digest" \
    --arg canaryNginxSha256 "$canary_digest" \
    --arg formalNginxSha256 "$formal_digest" '{
      name: $name,
      uid: $uid,
      resourceVersion: $resourceVersion,
      serviceName: $serviceName,
      serviceUid: $serviceUid,
      serviceResourceVersion: $serviceResourceVersion,
      sourceSha: $sourceSha,
      releaseId: $releaseId,
      manifestDigest: $manifestDigest,
      webImage: $webImage,
      trafficStateDigest: $trafficStateDigest,
      forwardEnvDigest: $forwardEnvDigest,
      forwardUnit: $forwardUnit,
      forwardPort: $forwardPort,
      routeVersionDigest: $routeVersionDigest,
      canaryNginxSha256: $canaryNginxSha256,
      formalNginxSha256:
        (if $formalNginxSha256 == "" then null else $formalNginxSha256 end)
    }'
}

capture_writer_deployments() {
  local active_source=$1 predecessor_source=${2:-} predecessor_manifest=${3:-}
  local deployments row
  deployments=$("${K[@]}" -n "$NAMESPACE" get deployments -o json)
  jq -e \
    --arg activeSource "$active_source" \
    --arg predecessorSource "$predecessor_source" \
    --arg predecessorManifest "$predecessor_manifest" '
      [
        .items[]
        | select(
            (.metadata.name | test("^release-[0-9a-f]{12}-(api|runtime|worker)$"))
          )
      ] as $writers
      | all($writers[];
          . as $writer
          | ($writer.metadata.name
            | capture("-(?<role>api|runtime|worker)$").role) as $role
          | ($writer.metadata.uid | type == "string" and length > 0)
          and ($writer.metadata.resourceVersion | type == "string" and length > 0)
          and $writer.metadata.deletionTimestamp == null
          and $writer.metadata.labels["combo.build/release-track"] == "release-v1"
          and (
            $writer.metadata.name
            == (
              "release-"
              + $writer.spec.template.metadata.annotations["combo.build/source-sha"][0:12]
              + "-"
              + $role
            )
          )
          and (
            $writer.spec.template.metadata.annotations["combo.build/source-sha"]
            | test("^[0-9a-f]{40}$")
          )
          and $writer.spec.template.metadata.annotations["combo.build/release-id"]
            == (
              "release-"
              + $writer.spec.template.metadata.annotations["combo.build/source-sha"]
            )
          and (
            $writer.spec.template.metadata.annotations["combo.build/release-manifest-digest"]
            | test("^sha256:[0-9a-f]{64}$")
          )
          and $writer.spec.selector.matchLabels == {
            app: $writer.metadata.name,
            "combo.build/release-track": "release-v1"
          }
          and $writer.spec.template.metadata.labels.app == $writer.metadata.name
          and $writer.spec.template.metadata.labels["combo.build/release-track"]
            == "release-v1"
          and (
            [
              $writer.spec.template.spec.containers[]
              | select(.name == $role)
            ]
            | length
          ) == 1)
      and (
        if $predecessorSource == ""
        then
          ([$writers[]
            | select(
                .spec.template.metadata.annotations["combo.build/source-sha"]
                == $activeSource
              )
            | .metadata.name] | sort)
          == ([
            "release-" + $activeSource[0:12] + "-api",
            "release-" + $activeSource[0:12] + "-runtime",
            "release-" + $activeSource[0:12] + "-worker"
          ] | sort)
        else
          all($writers[];
            .spec.template.metadata.annotations["combo.build/source-sha"]
              == $predecessorSource
            and .spec.template.metadata.annotations[
              "combo.build/release-manifest-digest"
            ] == $predecessorManifest)
          and ($writers | length) <= 3
          and (($writers | map(.metadata.name) | unique | length)
            == ($writers | length))
        end
      )
    ' <<<"$deployments" >/dev/null ||
    fail 'release writer deployments are incomplete or outside their identity contract'
  : >"$work/writer-deployments.jsonl"
  while IFS= read -r row; do
    jq -n \
      --arg kind deployment \
      --arg name "$(jq -er '.metadata.name' <<<"$row")" \
      --arg uid "$(jq -er '.metadata.uid' <<<"$row")" \
      --arg resourceVersion "$(jq -er '.metadata.resourceVersion' <<<"$row")" \
      --arg authorityDigest "$(resource_authority_digest "$row")" '{
        kind: $kind,
        name: $name,
        uid: $uid,
        resourceVersion: $resourceVersion,
        authorityDigest: $authorityDigest
      }' >>"$work/writer-deployments.jsonl"
  done < <(jq -c '
    .items[]
    | select(.metadata.name
      | test("^release-[0-9a-f]{12}-(api|runtime|worker)$"))
  ' <<<"$deployments")
  jq -s 'sort_by(.name)' "$work/writer-deployments.jsonl"
}

capture_jobs() {
  local active_source=$1 predecessor_source=${2:-} predecessor_manifest=${3:-}
  local jobs row
  jobs=$("${K[@]}" -n "$NAMESPACE" get jobs -o json)
  jq -e \
    --arg track "$FOUNDATION_TRACK" \
    --arg activeSource "$active_source" \
    --arg predecessorSource "$predecessor_source" \
    --arg predecessorManifest "$predecessor_manifest" '
      [
        .items[]
      | select(
          (
            .metadata.name == "release-minio-init"
            or (.metadata.name | test("^release-[0-9a-f]{12}-(migrate|minio-init)$"))
          )
          and .metadata.deletionTimestamp == null
        )
    ] as $jobs
    | all($jobs[];
        (.metadata.uid | type == "string" and length > 0)
        and (.metadata.resourceVersion | type == "string" and length > 0)
        and (
          if .metadata.name == "release-minio-init"
          then .metadata.labels["combo.build/environment-foundation"] == $track
          else
            (.spec.template.metadata.annotations["combo.build/source-sha"]
              | test("^[0-9a-f]{40}$"))
            and .metadata.name
              == (
                "release-"
                + .spec.template.metadata.annotations["combo.build/source-sha"][0:12]
                + "-"
                + (
                  .metadata.name
                  | capture("-(?<role>migrate|minio-init)$").role
                )
              )
            and .spec.template.metadata.annotations["combo.build/release-id"]
              == (
                "release-"
                + .spec.template.metadata.annotations["combo.build/source-sha"]
              )
            and (
              .spec.template.metadata.annotations[
                "combo.build/release-manifest-digest"
              ]
              | test("^sha256:[0-9a-f]{64}$")
            )
            and (
              if $predecessorSource == ""
              then
                .spec.template.metadata.annotations["combo.build/source-sha"]
                  == $activeSource
              else
                .spec.template.metadata.annotations["combo.build/source-sha"]
                  == $predecessorSource
                and .spec.template.metadata.annotations[
                  "combo.build/release-manifest-digest"
                ] == $predecessorManifest
              end
            )
          end
        ))
  ' <<<"$jobs" >/dev/null ||
    fail 'release jobs are outside their identity contract'
  : >"$work/jobs.jsonl"
  while IFS= read -r row; do
    jq -n \
      --arg kind job \
      --arg name "$(jq -er '.metadata.name' <<<"$row")" \
      --arg uid "$(jq -er '.metadata.uid' <<<"$row")" \
      --arg resourceVersion "$(jq -er '.metadata.resourceVersion' <<<"$row")" \
      --arg authorityDigest "$(resource_authority_digest "$row")" '{
        kind: $kind,
        name: $name,
        uid: $uid,
        resourceVersion: $resourceVersion,
        authorityDigest: $authorityDigest
      }' >>"$work/jobs.jsonl"
  done < <(jq -c '
    .items[]
    | select(
        .metadata.name == "release-minio-init"
        or (.metadata.name | test("^release-[0-9a-f]{12}-(migrate|minio-init)$"))
      )
  ' <<<"$jobs")
  jq -s 'sort_by(.name)' "$work/jobs.jsonl"
}

validate_namespace_workload_surface() {
  local active_source=$1 active_manifest=$2 predecessor_source=${3:-}
  local predecessor_manifest=${4:-} resource surface_dir
  surface_dir="$work/workload-surface"
  install -d -m 0700 "$surface_dir"
  for resource in deployments statefulsets jobs replicasets pods cronjobs \
    daemonsets replicationcontrollers; do
    install -m 0600 /dev/null "$surface_dir/$resource.json"
  done
  "${K[@]}" -n "$NAMESPACE" get deployments -o json \
    >"$surface_dir/deployments.json"
  "${K[@]}" -n "$NAMESPACE" get statefulsets -o json \
    >"$surface_dir/statefulsets.json"
  "${K[@]}" -n "$NAMESPACE" get jobs -o json >"$surface_dir/jobs.json"
  "${K[@]}" -n "$NAMESPACE" get replicasets -o json \
    >"$surface_dir/replicasets.json"
  "${K[@]}" -n "$NAMESPACE" get pods -o json >"$surface_dir/pods.json"
  "${K[@]}" -n "$NAMESPACE" get cronjobs -o json \
    >"$surface_dir/cronjobs.json"
  "${K[@]}" -n "$NAMESPACE" get daemonsets -o json \
    >"$surface_dir/daemonsets.json"
  "${K[@]}" -n "$NAMESPACE" get replicationcontrollers -o json \
    >"$surface_dir/replicationcontrollers.json"
  jq -n -e \
    --arg track "$FOUNDATION_TRACK" \
    --arg activeSource "$active_source" \
    --arg activeManifest "$active_manifest" \
    --arg predecessorSource "$predecessor_source" \
    --arg predecessorManifest "$predecessor_manifest" \
    --slurpfile deployments "$surface_dir/deployments.json" \
    --slurpfile statefulsets "$surface_dir/statefulsets.json" \
    --slurpfile jobs "$surface_dir/jobs.json" \
    --slurpfile replicasets "$surface_dir/replicasets.json" \
    --slurpfile pods "$surface_dir/pods.json" \
    --slurpfile cronjobs "$surface_dir/cronjobs.json" \
    --slurpfile daemonsets "$surface_dir/daemonsets.json" \
    --slurpfile replicationcontrollers \
      "$surface_dir/replicationcontrollers.json" '
      def controller:
        [.metadata.ownerReferences[]? | select(.controller == true)];
      def exact_list:
        type == "object" and (.items | type == "array");
      def stable:
        (.metadata.uid | type == "string" and length > 0)
        and (.metadata.resourceVersion | type == "string" and length > 0)
        and .metadata.deletionTimestamp == null;
      def top_level:
        (.metadata.ownerReferences // []) == [];
      def exact_owner($parents; $apiVersion; $kind):
        controller as $owners
        | ($owners | length) == 1
        and $owners[0].apiVersion == $apiVersion
        and $owners[0].kind == $kind
        and ($owners[0].name | type == "string" and length > 0)
        and ($owners[0].uid | type == "string" and length > 0)
        and (
          $owners[0] as $owner
          | any($parents[];
              .metadata.name == $owner.name
              and .metadata.uid == $owner.uid)
        );
      def exact_release_deployment:
        if (.metadata.name
          | test("^release-[0-9a-f]{12}-(api|runtime|web|worker)$"))
        then
          . as $deployment
          | ($deployment.metadata.name
            | capture("-(?<role>api|runtime|web|worker)$").role
          ) as $role
          | $deployment.spec.template.metadata.annotations[
              "combo.build/source-sha"
            ] as $source
          | stable
          and top_level
          and $deployment.metadata.labels["combo.build/release-track"]
            == "release-v1"
          and ($source | test("^[0-9a-f]{40}$"))
          and $deployment.metadata.name
            == ("release-" + $source[0:12] + "-" + $role)
          and $deployment.spec.template.metadata.annotations[
              "combo.build/release-id"
            ] == ("release-" + $source)
          and (
            $deployment.spec.template.metadata.annotations[
              "combo.build/release-manifest-digest"
            ] | test("^sha256:[0-9a-f]{64}$")
          )
          and (
            if $role == "web"
            then
              $source == $activeSource
              and $deployment.spec.template.metadata.annotations[
                "combo.build/release-manifest-digest"
              ] == $activeManifest
            elif $predecessorSource == ""
            then
              $source == $activeSource
              and $deployment.spec.template.metadata.annotations[
                "combo.build/release-manifest-digest"
              ] == $activeManifest
            else
              $source == $predecessorSource
              and $deployment.spec.template.metadata.annotations[
                "combo.build/release-manifest-digest"
              ] == $predecessorManifest
            end
          )
          and $deployment.spec.selector.matchLabels == {
            app: $deployment.metadata.name,
            "combo.build/release-track": "release-v1"
          }
          and $deployment.spec.template.metadata.labels.app
            == $deployment.metadata.name
          and $deployment.spec.template.metadata.labels[
            "combo.build/release-track"
          ] == "release-v1"
          and [$deployment.spec.template.spec.containers[].name] == [$role]
          and (
            $deployment.spec.template.spec.containers[0].image
            | if $role == "api" or $role == "worker"
              then test("^ghcr.io/dangdang-tech/combo-api@sha256:[0-9a-f]{64}$")
              elif $role == "runtime"
              then test("^ghcr.io/dangdang-tech/combo-runtime@sha256:[0-9a-f]{64}$")
              else test("^ghcr.io/dangdang-tech/combo-web@sha256:[0-9a-f]{64}$")
              end
          )
          and (($deployment.spec.template.spec.initContainers // []) | length) == 0
          and (($deployment.spec.template.spec.ephemeralContainers // []) | length) == 0
        else false
        end;
      def exact_foundation_deployment:
        stable
        and top_level
        and .metadata.name == "release-redis-hot"
        and .metadata.labels["combo.build/environment-foundation"] == $track;
      def exact_foundation_statefulset:
        stable
        and top_level
        and (
          .metadata.name == "release-postgres"
          or .metadata.name == "release-redis-queue"
          or .metadata.name == "release-minio"
        )
        and .metadata.labels["combo.build/environment-foundation"] == $track;
      def exact_release_job:
        if (.metadata.name
          | test("^release-[0-9a-f]{12}-(migrate|minio-init)$"))
        then
          . as $job
          | ($job.metadata.name
            | capture("-(?<role>migrate|minio-init)$").role
          ) as $role
          | $job.spec.template.metadata.annotations[
              "combo.build/source-sha"
            ] as $source
          | stable
          and top_level
          and ($source | test("^[0-9a-f]{40}$"))
          and $job.metadata.name
            == ("release-" + $source[0:12] + "-" + $role)
          and $job.spec.template.metadata.annotations["combo.build/release-id"]
            == ("release-" + $source)
          and (
            $job.spec.template.metadata.annotations[
              "combo.build/release-manifest-digest"
            ] | test("^sha256:[0-9a-f]{64}$")
          )
          and (
            if $predecessorSource == ""
            then
              $source == $activeSource
              and $job.spec.template.metadata.annotations[
                "combo.build/release-manifest-digest"
              ] == $activeManifest
            else
              $source == $predecessorSource
              and $job.spec.template.metadata.annotations[
                "combo.build/release-manifest-digest"
              ] == $predecessorManifest
            end
          )
          and [$job.spec.template.spec.containers[].name] == [$role]
          and (($job.spec.template.spec.initContainers // []) | length) == 0
          and (($job.spec.template.spec.ephemeralContainers // []) | length) == 0
        else false
        end;
      def exact_foundation_job:
        stable
        and top_level
        and .metadata.name == "release-minio-init"
        and .metadata.labels["combo.build/environment-foundation"] == $track
        and [.spec.template.spec.containers[].name] == ["minio-init"]
        and ((.spec.template.spec.initContainers // []) | length) == 0
        and ((.spec.template.spec.ephemeralContainers // []) | length) == 0;
      ([
        $deployments,
        $statefulsets,
        $jobs,
        $replicasets,
        $pods,
        $cronjobs,
        $daemonsets,
        $replicationcontrollers
      ] | all(.[]; length == 1 and (.[0] | exact_list)))
      and (
        ($deployments[0].items) as $deploymentItems
        | ($statefulsets[0].items) as $statefulsetItems
        | ($jobs[0].items) as $jobItems
        | ($replicasets[0].items) as $replicasetItems
        | all($deploymentItems[];
            exact_foundation_deployment or exact_release_deployment)
        and all($statefulsetItems[]; exact_foundation_statefulset)
        and all($jobItems[]; exact_foundation_job or exact_release_job)
        and ($cronjobs[0].items | length) == 0
        and ($daemonsets[0].items | length) == 0
        and ($replicationcontrollers[0].items | length) == 0
        and all($replicasetItems[];
          stable
          and exact_owner($deploymentItems; "apps/v1"; "Deployment"))
        and all($pods[0].items[];
          stable
          and (
            exact_owner($replicasetItems; "apps/v1"; "ReplicaSet")
            or exact_owner($statefulsetItems; "apps/v1"; "StatefulSet")
            or exact_owner($jobItems; "batch/v1"; "Job")
          ))
      )
    ' >/dev/null ||
    fail 'namespace contains an unowned or unexpected workload writer surface'
}

capture_targets() {
  local target kind name value
  : >"$work/targets.jsonl"
  for target in "${FOUNDATION_TARGETS[@]}"; do
    kind=${target%%:*}
    name=${target#*:}
    value=$(captured_resource "$kind" "$name")
    jq -e --arg track "$FOUNDATION_TRACK" \
      '.metadata.labels["combo.build/environment-foundation"] == $track' \
      <<<"$value" >/dev/null ||
      fail "resource is outside the exact foundation track: $kind/$name"
    jq -n \
      --arg kind "$kind" \
      --arg name "$name" \
      --arg uid "$(jq -er '.metadata.uid' <<<"$value")" \
      --arg resourceVersion "$(jq -er '.metadata.resourceVersion' <<<"$value")" \
      --arg authorityDigest "$(resource_authority_digest "$value")" '{
        kind: $kind,
        name: $name,
        uid: $uid,
        resourceVersion: $resourceVersion,
        authorityDigest: $authorityDigest
      }' >>"$work/targets.jsonl"
  done
  for target in "${OPTIONAL_TARGETS[@]}"; do
    kind=${target%%:*}
    name=${target#*:}
    value=$(get_resource_optional "$kind" "$name") ||
      fail "failed to inspect optional resource: $kind/$name"
    if [[ -n "$value" ]]; then
      validate_captured_resource "$kind" "$name" "$value"
      jq -e --arg track "$FOUNDATION_TRACK" \
        '.metadata.labels["combo.build/environment-foundation"] == $track' \
        <<<"$value" >/dev/null ||
        fail "resource is outside the exact foundation track: $kind/$name"
      jq -n \
        --arg kind "$kind" \
        --arg name "$name" \
        --arg uid "$(jq -er '.metadata.uid' <<<"$value")" \
        --arg resourceVersion "$(jq -er '.metadata.resourceVersion' <<<"$value")" \
        --arg authorityDigest "$(resource_authority_digest "$value")" '{
          kind: $kind,
          name: $name,
          uid: $uid,
          resourceVersion: $resourceVersion,
          authorityDigest: $authorityDigest
        }' >>"$work/targets.jsonl"
    fi
  done
  jq -s 'sort_by(.kind, .name)' "$work/targets.jsonl"
}

capture_storage() {
  local output=$1 storage_root_real claim claim_json claim_uid volume pv_json
  local claim_resource_version volume_uid volume_resource_version path path_real
  local claim_authority_digest volume_authority_digest
  storage_root_real=$(sudo -n realpath -e "$K3S_STORAGE_ROOT")
  : >"$work/storage.jsonl"
  for claim in "${CLAIMS[@]}"; do
    claim_json=$(captured_resource pvc "$claim")
    claim_uid=$(jq -er '.metadata.uid' <<<"$claim_json")
    claim_resource_version=$(jq -er '.metadata.resourceVersion' <<<"$claim_json")
    claim_authority_digest=$(resource_authority_digest "$claim_json")
    jq -e \
      --arg track "$FOUNDATION_TRACK" '
        .status.phase == "Bound"
        and .metadata.labels["combo.build/data-policy"] == "disposable"
        and .metadata.labels["combo.build/environment-foundation"] == $track
        and .spec.storageClassName == "local-path"
        and .spec.accessModes == ["ReadWriteOnce"]
        and .spec.volumeMode == "Filesystem"
        and (.spec.volumeName | type == "string" and length > 0)
      ' <<<"$claim_json" >/dev/null ||
      fail "PVC is outside the disposable release contract: $claim"
    volume=$(jq -er '.spec.volumeName' <<<"$claim_json")
    [[ "$volume" == "pvc-$claim_uid" ]] ||
      fail "PVC has an unexpected PV identity: $claim"
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
      fail "PV is outside the disposable release contract: $volume"
    volume_uid=$(jq -er '.metadata.uid' <<<"$pv_json")
    volume_resource_version=$(jq -er '.metadata.resourceVersion' <<<"$pv_json")
    volume_authority_digest=$(resource_authority_digest "$pv_json")
    path=$(jq -er '.spec.local.path' <<<"$pv_json")
    path_real=$(sudo -n realpath -e "$path")
    [[ "$path_real" == "$storage_root_real/${volume}_${NAMESPACE}_${claim}" ]] ||
      fail "PV path is outside the exact release storage root: $volume"
    jq -n \
      --arg claim "$claim" \
      --arg claimUid "$claim_uid" \
      --arg claimResourceVersion "$claim_resource_version" \
      --arg claimAuthorityDigest "$claim_authority_digest" \
      --arg volume "$volume" \
      --arg volumeUid "$volume_uid" \
      --arg volumeResourceVersion "$volume_resource_version" \
      --arg volumeAuthorityDigest "$volume_authority_digest" \
      --arg path "$path_real" '{
        claim: $claim,
        claimUid: $claimUid,
        claimResourceVersion: $claimResourceVersion,
        claimAuthorityDigest: $claimAuthorityDigest,
        volume: $volume,
        volumeUid: $volumeUid,
        volumeResourceVersion: $volumeResourceVersion,
        volumeAuthorityDigest: $volumeAuthorityDigest,
        path: $path
      }' >>"$work/storage.jsonl"
  done
  jq -s 'sort_by(.claim)' "$work/storage.jsonl" >"$output"
}

load_superseded_reset_descriptor() {
  local predecessor_stem predecessor_root predecessor_plan predecessor_ready
  if [[ -z "$PREDECESSOR_RESET_EVIDENCE" ]]; then
    [[ "$AUDITED_SUPERSEDED_RESET_JSON" == null ]] ||
      fail 'foundation reset auditor predecessor output is inconsistent'
    SUPERSEDED_RESET_JSON=null
    return
  fi
  [[ "$ENVIRONMENT" == preview && "$OPERATION" == reset ]] ||
    fail 'foundation reset supersession is restricted to Preview reset'
  [[ -f "$PREDECESSOR_RESET_EVIDENCE" &&
    ! -L "$PREDECESSOR_RESET_EVIDENCE" ]] ||
    fail 'superseded reset evidence path is unsafe'
  predecessor_stem=${PREDECESSOR_RESET_EVIDENCE##*/}
  predecessor_stem=${predecessor_stem%.foundation-reset-evidence.json}
  [[ "$predecessor_stem" =~ ^[0-9a-f]{64}$ ]] ||
    fail 'superseded reset evidence name is invalid'
  predecessor_root=${PREDECESSOR_RESET_EVIDENCE%/*}
  predecessor_plan="$predecessor_root/$predecessor_stem.foundation-reset-plan.json"
  predecessor_ready="$predecessor_root/$predecessor_stem.foundation-reset-ready.json"
  for predecessor_file in "$predecessor_plan" "$predecessor_ready"; do
    [[ -f "$predecessor_file" && ! -L "$predecessor_file" ]] ||
      fail 'superseded reset journal is incomplete or unsafe'
  done
  SUPERSEDED_RESET_JSON=$(jq -cn \
    --arg environment "$ENVIRONMENT" \
    --arg namespace "$NAMESPACE" \
    --arg requestId "sha256:$predecessor_stem" \
    --arg sourceSha "$(jq -er '.sourceSha' "$PREDECESSOR_RESET_EVIDENCE")" \
    --arg releaseId "$(jq -er '.releaseId' "$PREDECESSOR_RESET_EVIDENCE")" \
    --arg manifestDigest \
      "$(jq -er '.manifestDigest' "$PREDECESSOR_RESET_EVIDENCE")" \
    --arg planDigest "$(file_digest "$predecessor_plan")" \
    --arg foundationSnapshotDigest "$(file_digest "$predecessor_ready")" \
    --arg evidenceDigest "$(file_digest "$PREDECESSOR_RESET_EVIDENCE")" '{
      environment: $environment,
      namespace: $namespace,
      requestId: $requestId,
      sourceSha: $sourceSha,
      releaseId: $releaseId,
      manifestDigest: $manifestDigest,
      planDigest: $planDigest,
      foundationSnapshotDigest: $foundationSnapshotDigest,
      evidenceDigest: $evidenceDigest
    }')
  jq -e \
    --arg sourceSha "$source_sha" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --argjson audited "$AUDITED_SUPERSEDED_RESET_JSON" '
      (keys | sort) == ([
        "environment", "namespace", "requestId", "sourceSha", "releaseId",
        "manifestDigest", "planDigest", "foundationSnapshotDigest",
        "evidenceDigest"
      ] | sort)
      and .environment == "preview"
      and .namespace == "combo-review"
      and (.requestId | test("^sha256:[0-9a-f]{64}$"))
      and (.sourceSha | test("^[0-9a-f]{40}$"))
      and .releaseId == ("release-" + .sourceSha)
      and all([
        .manifestDigest, .planDigest, .foundationSnapshotDigest,
        .evidenceDigest
      ][]; test("^sha256:[0-9a-f]{64}$"))
      and .sourceSha != $sourceSha
      and . == $audited
    ' <<<"$SUPERSEDED_RESET_JSON" >/dev/null ||
    fail 'superseded reset descriptor is invalid'
}

validate_superseded_reset_live_continuity() {
  local predecessor_stem predecessor_root predecessor_plan
  [[ "$SUPERSEDED_RESET_JSON" != null ]] || return 0
  predecessor_stem=$(jq -er '.requestId | sub("^sha256:"; "")' \
    <<<"$SUPERSEDED_RESET_JSON")
  predecessor_root=${PREDECESSOR_RESET_EVIDENCE%/*}
  predecessor_plan="$predecessor_root/$predecessor_stem.foundation-reset-plan.json"
  jq -e \
    --argjson capturedWeb "$preserved_web" \
    --argjson capturedTargets "$targets" \
    --slurpfile capturedStorage "$work/old-storage.json" \
    --slurpfile predecessorPlan "$predecessor_plan" '
      (
        $capturedStorage[0]
        | map(del(.claimAuthorityDigest, .volumeAuthorityDigest))
        | sort_by(.claim)
      ) == (.newStorage | sort_by(.claim))
      and (
        $capturedTargets
        | map(select(.name != "release-minio-init-script"))
        | map({kind, name, uid})
        | sort_by(.kind, .name)
      ) == (.foundation | sort_by(.kind, .name))
      and ($capturedWeb | {name, uid}) == .preservedWeb
      and (
        $capturedWeb | del(.resourceVersion, .serviceResourceVersion)
      ) == (
        $predecessorPlan[0].preservedWeb
        | del(.resourceVersion, .serviceResourceVersion)
      )
    ' "$PREDECESSOR_RESET_EVIDENCE" >/dev/null ||
    fail 'live Preview foundation does not exactly continue the superseded reset'
}

validate_plan() {
  local storage_root_real
  storage_root_real=$(sudo -n realpath -e "$K3S_STORAGE_ROOT")
  jq -e \
    --arg policy "$POLICY" \
    --arg requestId "$REQUEST_ID" \
    --arg authorityDigest "$AUTHORITY_DIGEST" \
    --arg environment "$ENVIRONMENT" \
    --arg namespace "$NAMESPACE" \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg foundationYamlDigest "$foundation_yaml_digest" \
    --arg storageRoot "$storage_root_real" \
    --argjson supersededReset "$SUPERSEDED_RESET_JSON" '
      (
        if $supersededReset == null
        then
          .schemaVersion == 1
          and (keys | sort) == ([
            "schemaVersion", "policy", "requestId", "authorityDigest",
            "environment", "namespace", "sourceSha", "releaseId",
            "manifestDigest", "foundationYamlDigest", "createdAt",
            "preservedWeb", "writerDeployments", "jobs", "targets", "oldStorage"
          ] | sort)
          and .supersededReset == null
        else
          .schemaVersion == 2
          and (keys | sort) == ([
            "schemaVersion", "policy", "requestId", "authorityDigest",
            "environment", "namespace", "sourceSha", "releaseId",
            "manifestDigest", "foundationYamlDigest", "createdAt",
            "preservedWeb", "writerDeployments", "jobs", "targets",
            "oldStorage", "supersededReset"
          ] | sort)
          and .supersededReset == $supersededReset
        end
      )
      and .policy == $policy
      and .requestId == $requestId
      and .authorityDigest == $authorityDigest
      and .environment == $environment
      and .namespace == $namespace
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and .foundationYamlDigest == $foundationYamlDigest
      and (.createdAt | type == "string" and length > 0)
      and (.preservedWeb | keys | sort) == ([
        "name", "uid", "resourceVersion", "serviceName", "serviceUid",
        "serviceResourceVersion", "sourceSha", "releaseId", "manifestDigest",
        "webImage", "trafficStateDigest", "forwardEnvDigest", "forwardUnit",
        "forwardPort", "routeVersionDigest",
        "canaryNginxSha256", "formalNginxSha256"
      ] | sort)
      and (.preservedWeb.name | test("^release-[0-9a-f]{12}-web$"))
      and .preservedWeb.serviceName == .preservedWeb.name
      and .preservedWeb.name == (
        "release-" + .preservedWeb.sourceSha[0:12] + "-web"
      )
      and .preservedWeb.releaseId == ("release-" + .preservedWeb.sourceSha)
      and (.preservedWeb.sourceSha | test("^[0-9a-f]{40}$"))
      and (.preservedWeb.manifestDigest | test("^sha256:[0-9a-f]{64}$"))
      and (.preservedWeb.webImage
        | test("^ghcr.io/dangdang-tech/combo-web@sha256:[0-9a-f]{64}$"))
      and all([
        .preservedWeb.trafficStateDigest,
        .preservedWeb.forwardEnvDigest,
        .preservedWeb.routeVersionDigest,
        .preservedWeb.canaryNginxSha256
      ][]; test("^sha256:[0-9a-f]{64}$"))
      and .preservedWeb.forwardUnit == (
        if $environment == "preview"
        then "combo-release-preview-web-forward.service"
        else "combo-release-production-web-forward.service"
        end
      )
      and .preservedWeb.forwardPort == (
        if $environment == "preview" then 18081 else 18082 end
      )
      and (
        if $environment == "preview"
        then .preservedWeb.formalNginxSha256 == null
        else (.preservedWeb.formalNginxSha256
          | test("^sha256:[0-9a-f]{64}$"))
        end
      )
      and all([
        .preservedWeb.uid,
        .preservedWeb.resourceVersion,
        .preservedWeb.serviceUid,
        .preservedWeb.serviceResourceVersion
      ][]; type == "string" and test("^[A-Za-z0-9._-]+$"))
      and (.writerDeployments | type == "array")
      and all(.writerDeployments[];
        (keys | sort)
          == ["authorityDigest", "kind", "name", "resourceVersion", "uid"]
        and .kind == "deployment"
        and (.name | test("^release-[0-9a-f]{12}-(api|runtime|worker)$"))
        and (.authorityDigest | test("^sha256:[0-9a-f]{64}$"))
        and all([.uid, .resourceVersion][];
          type == "string" and test("^[A-Za-z0-9._-]+$")))
      and ((.writerDeployments | map(.name) | length)
        == (.writerDeployments | map(.name) | unique | length))
      and (.jobs | type == "array")
      and all(.jobs[];
        (keys | sort)
          == ["authorityDigest", "kind", "name", "resourceVersion", "uid"]
        and .kind == "job"
        and (
          .name == "release-minio-init"
          or (.name | test("^release-[0-9a-f]{12}-(migrate|minio-init)$"))
        )
        and (.authorityDigest | test("^sha256:[0-9a-f]{64}$"))
        and all([.uid, .resourceVersion][];
          type == "string" and test("^[A-Za-z0-9._-]+$")))
      and ((.jobs | map(.name) | length)
        == (.jobs | map(.name) | unique | length))
      and (
        .preservedWeb.sourceSha[0:12] as $activePrefix
        | ($supersededReset.sourceSha // "")[0:12] as $predecessorPrefix
        |
        if $supersededReset == null
        then
          ([.writerDeployments[].name] | sort) == ([
            "release-" + $activePrefix + "-api",
            "release-" + $activePrefix + "-runtime",
            "release-" + $activePrefix + "-worker"
          ] | sort)
          and all(.jobs[];
            .name == "release-minio-init"
            or (.name | startswith("release-" + $activePrefix + "-")))
        else
          all(.writerDeployments[];
            .name | startswith("release-" + $predecessorPrefix + "-"))
          and all(.jobs[];
            .name == "release-minio-init"
            or (.name | startswith("release-" + $predecessorPrefix + "-")))
        end
      )
      and (.targets | type == "array")
      and all(.targets[];
        (keys | sort)
          == ["authorityDigest", "kind", "name", "resourceVersion", "uid"]
        and (.authorityDigest | test("^sha256:[0-9a-f]{64}$"))
        and all([.uid, .resourceVersion][];
          type == "string" and test("^[A-Za-z0-9._-]+$")))
      and (
        ([.targets[] | .kind + ":" + .name] | sort)
          == ([
            "deployment:release-redis-hot",
            "statefulset:release-postgres",
            "statefulset:release-redis-queue",
            "statefulset:release-minio",
            "service:release-postgres",
            "service:release-redis-queue",
            "service:release-redis-hot",
            "service:release-minio",
            "configmap:release-redis-hot-config",
            "configmap:release-redis-queue-config"
          ] | sort)
        or
        ([.targets[] | .kind + ":" + .name] | sort)
          == ([
            "deployment:release-redis-hot",
            "statefulset:release-postgres",
            "statefulset:release-redis-queue",
            "statefulset:release-minio",
            "service:release-postgres",
            "service:release-redis-queue",
            "service:release-redis-hot",
            "service:release-minio",
            "configmap:release-redis-hot-config",
            "configmap:release-redis-queue-config",
            "configmap:release-minio-init-script"
          ] | sort)
      )
      and (.oldStorage | type == "array" and length == 3)
      and ([.oldStorage[].claim] | sort) == [
        "data-release-minio-0",
        "data-release-postgres-0",
        "data-release-redis-queue-0"
      ]
      and all(.oldStorage[];
        (keys | sort) == ([
          "claim", "claimUid", "claimResourceVersion", "claimAuthorityDigest",
          "path", "volume", "volumeUid", "volumeResourceVersion",
          "volumeAuthorityDigest"
        ] | sort)
        and all([
          .claimAuthorityDigest, .volumeAuthorityDigest
        ][]; test("^sha256:[0-9a-f]{64}$"))
        and all([
          .claimUid, .claimResourceVersion,
          .volumeUid, .volumeResourceVersion
        ][];
          type == "string" and test("^[A-Za-z0-9._-]+$"))
        and .volume == ("pvc-" + .claimUid)
        and .path == (
          $storageRoot + "/" + .volume + "_" + $namespace + "_" + .claim
        ))
      and (. as $plan |
        all(["claimUid", "volume", "volumeUid", "path"][];
          . as $field |
          ($plan.oldStorage | map(.[$field])) as $values |
          ($values | length) == ($values | unique | length)))
    ' "$plan" >/dev/null ||
    fail 'persistent foundation reset plan does not match this request'
}

validate_checkpoint() {
  local binding_digest=$1
  jq -e \
    --arg requestId "$REQUEST_ID" \
    --arg planDigest "$binding_digest" '
      (keys | sort) == ([
        "schemaVersion", "requestId", "planDigest", "phase", "startedAt",
        "storageClearedAt", "foundationReadyAt", "foundationSnapshotDigest",
        "updatedAt"
      ] | sort)
      and .schemaVersion == 1
      and .requestId == $requestId
      and .planDigest == $planDigest
      and (.phase == "planned"
        or .phase == "storage-removed"
        or .phase == "foundation-ready")
      and (.startedAt | type == "string" and length > 0)
      and (.updatedAt | type == "string" and length > 0)
      and (
        if .phase == "planned"
        then
          .storageClearedAt == null
          and .foundationReadyAt == null
          and .foundationSnapshotDigest == null
        elif .phase == "storage-removed"
        then
          (.storageClearedAt | type == "string")
          and .foundationReadyAt == null
          and .foundationSnapshotDigest == null
        else
          (.storageClearedAt | type == "string")
          and (.foundationReadyAt | type == "string")
          and (.foundationSnapshotDigest | test("^sha256:[0-9a-f]{64}$"))
        end
      )
    ' "$checkpoint" >/dev/null ||
    fail 'persistent foundation reset checkpoint is invalid'
}

write_checkpoint() {
  local phase=$1 binding_digest=$2 started_at=$3 storage_at=$4 foundation_at=$5
  local snapshot_digest=${6:-}
  local staged="$work/checkpoint.json" updated_at
  updated_at=$(now)
  jq -n \
    --arg requestId "$REQUEST_ID" \
    --arg planDigest "$binding_digest" \
    --arg phase "$phase" \
    --arg startedAt "$started_at" \
    --argjson storageClearedAt "$storage_at" \
    --argjson foundationReadyAt "$foundation_at" \
    --arg foundationSnapshotDigest "$snapshot_digest" \
    --arg updatedAt "$updated_at" '{
      schemaVersion: 1,
      requestId: $requestId,
      planDigest: $planDigest,
      phase: $phase,
      startedAt: $startedAt,
      storageClearedAt: $storageClearedAt,
      foundationReadyAt: $foundationReadyAt,
      foundationSnapshotDigest:
        (if $foundationSnapshotDigest == ""
          then null else $foundationSnapshotDigest end),
      updatedAt: $updatedAt
    }' >"$staged"
  atomic_install "$staged" "$checkpoint"
}

load_superseded_reset_descriptor

plan_was_present=0
if [[ -e "$plan" ]]; then
  plan_was_present=1
  [[ -f "$plan" && ! -L "$plan" ]] || fail 'persistent plan path is unsafe'
  validate_plan
else
  preserved_web=$(capture_active_route_web)
  active_source=$(jq -er '.sourceSha' <<<"$preserved_web")
  active_manifest=$(jq -er '.manifestDigest' <<<"$preserved_web")
  predecessor_source=$(jq -r '.sourceSha // ""' <<<"$SUPERSEDED_RESET_JSON")
  predecessor_manifest=$(jq -r '.manifestDigest // ""' <<<"$SUPERSEDED_RESET_JSON")
  validate_namespace_workload_surface \
    "$active_source" "$active_manifest" \
    "$predecessor_source" "$predecessor_manifest"
  writer_deployments=$(capture_writer_deployments \
    "$active_source" "$predecessor_source" "$predecessor_manifest")
  jobs=$(capture_jobs \
    "$active_source" "$predecessor_source" "$predecessor_manifest")
  targets=$(capture_targets)
  capture_storage "$work/old-storage.json"
  validate_superseded_reset_live_continuity
  jq -n \
    --arg policy "$POLICY" \
    --arg requestId "$REQUEST_ID" \
    --arg authorityDigest "$AUTHORITY_DIGEST" \
    --arg environment "$ENVIRONMENT" \
    --arg namespace "$NAMESPACE" \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg foundationYamlDigest "$foundation_yaml_digest" \
    --arg createdAt "$(now)" \
    --argjson preservedWeb "$preserved_web" \
    --argjson writerDeployments "$writer_deployments" \
    --argjson jobs "$jobs" \
    --argjson targets "$targets" \
    --argjson supersededReset "$SUPERSEDED_RESET_JSON" \
    --slurpfile oldStorage "$work/old-storage.json" '{
      schemaVersion: (if $supersededReset == null then 1 else 2 end),
      policy: $policy,
      requestId: $requestId,
      authorityDigest: $authorityDigest,
      environment: $environment,
      namespace: $namespace,
      sourceSha: $sourceSha,
      releaseId: $releaseId,
      manifestDigest: $manifestDigest,
      foundationYamlDigest: $foundationYamlDigest,
      createdAt: $createdAt,
      preservedWeb: $preservedWeb,
      writerDeployments: $writerDeployments,
      jobs: $jobs,
      targets: $targets,
      oldStorage: $oldStorage[0]
    } + (
      if $supersededReset == null
      then {}
      else {supersededReset: $supersededReset}
      end
    )' >"$work/plan.json"
  atomic_install "$work/plan.json" "$plan"
fi
plan_digest=$(file_digest "$plan")
readonly plan_digest

validate_preserved_web() {
  local live
  live=$(capture_active_route_web)
  jq -e --argjson live "$live" '
    (.preservedWeb | del(.resourceVersion, .serviceResourceVersion))
      == ($live | del(.resourceVersion, .serviceResourceVersion))
  ' "$plan" >/dev/null ||
    fail 'preserved Web or its host traffic binding changed after the immutable plan'
}

validate_candidate_web() {
  local live=${1:-}
  [[ -n "$live" ]] || live=$(capture_active_route_web)
  jq -e \
    --arg name "release-${source_sha:0:12}-web" \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg image "$(jq -er '.images.web' "$MANIFEST")" '
      .name == $name
      and .serviceName == $name
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and .webImage == $image
    ' <<<"$live" >/dev/null ||
    fail 'candidate Web and host traffic do not match the completed reset release'
}

validate_preserved_or_candidate_web() {
  local live
  live=$(capture_active_route_web)
  if jq -e --argjson live "$live" '
    (.preservedWeb | del(.resourceVersion, .serviceResourceVersion))
      == ($live | del(.resourceVersion, .serviceResourceVersion))
  ' "$plan" >/dev/null; then
    return 0
  fi
  validate_candidate_web "$live"
}

validate_plan_only_live_continuity() {
  local active_source active_manifest predecessor_source predecessor_manifest
  local live_writers live_jobs live_targets
  active_source=$(jq -er '.preservedWeb.sourceSha' "$plan")
  active_manifest=$(jq -er '.preservedWeb.manifestDigest' "$plan")
  predecessor_source=$(jq -r '.sourceSha // ""' <<<"$SUPERSEDED_RESET_JSON")
  predecessor_manifest=$(jq -r '.manifestDigest // ""' <<<"$SUPERSEDED_RESET_JSON")

  validate_preserved_web
  validate_namespace_workload_surface \
    "$active_source" "$active_manifest" \
    "$predecessor_source" "$predecessor_manifest"
  live_writers=$(capture_writer_deployments \
    "$active_source" "$predecessor_source" "$predecessor_manifest")
  live_jobs=$(capture_jobs \
    "$active_source" "$predecessor_source" "$predecessor_manifest")
  live_targets=$(capture_targets)
  capture_storage "$work/plan-only-live-storage.json"

  jq -e \
    --argjson liveWriters "$live_writers" \
    --argjson liveJobs "$live_jobs" \
    --argjson liveTargets "$live_targets" \
    --slurpfile liveStorage "$work/plan-only-live-storage.json" '
      def stable_resources:
        map(del(.resourceVersion)) | sort_by(.kind, .name);
      def stable_storage:
        map(del(.claimResourceVersion, .volumeResourceVersion))
        | sort_by(.claim);
      (.writerDeployments | stable_resources)
        == ($liveWriters | stable_resources)
      and (.jobs | stable_resources) == ($liveJobs | stable_resources)
      and (.targets | stable_resources) == ($liveTargets | stable_resources)
      and (.oldStorage | stable_storage)
        == ($liveStorage[0] | stable_storage)
    ' "$plan" >/dev/null ||
    fail 'live foundation no longer matches the plan-only reset boundary'
}

if [[ -e "$checkpoint" ]]; then
  [[ -f "$checkpoint" && ! -L "$checkpoint" ]] ||
    fail 'persistent checkpoint path is unsafe'
  validate_checkpoint "$plan_digest"
elif [[ -e "$ready_snapshot" || -L "$ready_snapshot" ||
  -e "$evidence" || -L "$evidence" ]]; then
  fail 'persistent reset state exists without its phase checkpoint'
else
  if ((plan_was_present == 1)); then
    validate_plan_only_live_continuity
  fi
  started_at=$(jq -er '.createdAt' "$plan")
  write_checkpoint planned "$plan_digest" "$started_at" null null ''
fi

resource_api_path() {
  local kind=$1 name=$2
  case "$kind" in
    deployment)
      printf '/apis/apps/v1/namespaces/%s/deployments/%s\n' "$NAMESPACE" "$name"
      ;;
    statefulset)
      printf '/apis/apps/v1/namespaces/%s/statefulsets/%s\n' "$NAMESPACE" "$name"
      ;;
    job)
      printf '/apis/batch/v1/namespaces/%s/jobs/%s\n' "$NAMESPACE" "$name"
      ;;
    service)
      printf '/api/v1/namespaces/%s/services/%s\n' "$NAMESPACE" "$name"
      ;;
    configmap)
      printf '/api/v1/namespaces/%s/configmaps/%s\n' "$NAMESPACE" "$name"
      ;;
    pvc)
      printf '/api/v1/namespaces/%s/persistentvolumeclaims/%s\n' "$NAMESPACE" "$name"
      ;;
    *) fail "unsupported deletion kind: $kind" ;;
  esac
}

wait_absent() {
  local kind=$1 name=$2 uid=$3 authority_digest=$4 current
  for _ in $(seq 1 "$WAIT_SECONDS"); do
    current=$(get_resource_optional "$kind" "$name") ||
      fail "failed to observe deletion of $kind/$name"
    if [[ -z "$current" ]]; then
      return 0
    fi
    [[ "$(jq -er '.metadata.uid' <<<"$current")" == "$uid" ]] ||
      fail "$kind/$name changed UID while deletion was pending"
    [[ "$(resource_authority_digest "$current")" == "$authority_digest" ]] ||
      fail "$kind/$name changed deletion authority while deletion was pending"
    sleep 1
  done
  fail "timed out deleting $kind/$name"
}

delete_cas_preconditioned() {
  local kind=$1 name=$2 uid=$3 planned_resource_version=$4 authority_digest=$5
  local current current_resource_version options api_path
  [[ -n "$planned_resource_version" && "$authority_digest" =~ $DIGEST_RE ]] ||
    fail "invalid immutable deletion binding: $kind/$name"
  api_path=$(resource_api_path "$kind" "$name")
  options="$work/delete-${kind}-${name}.json"
  for _ in $(seq 1 5); do
    current=$(get_resource_optional "$kind" "$name") ||
      fail "failed to read $kind/$name before CAS deletion"
    if [[ -z "$current" ]]; then
      return 0
    fi
    [[ "$(jq -er '.metadata.uid' <<<"$current")" == "$uid" ]] ||
      fail "$kind/$name changed UID after the immutable plan"
    [[ "$(resource_authority_digest "$current")" == "$authority_digest" ]] ||
      fail "$kind/$name changed deletion authority after the immutable plan"
    if [[ "$(jq -r '.metadata.deletionTimestamp // empty' <<<"$current")" != '' ]]; then
      wait_absent "$kind" "$name" "$uid" "$authority_digest"
      return 0
    fi
    current_resource_version=$(jq -er '.metadata.resourceVersion' <<<"$current")
    jq -n \
      --arg uid "$uid" \
      --arg resourceVersion "$current_resource_version" '{
      apiVersion: "v1",
      kind: "DeleteOptions",
      propagationPolicy: "Foreground",
      preconditions: {uid: $uid, resourceVersion: $resourceVersion}
    }' >"$options"
    if "${K[@]}" delete --raw="$api_path" -f "$options" >/dev/null 2>&1; then
      wait_absent "$kind" "$name" "$uid" "$authority_digest"
      return 0
    fi
  done
  fail "UID/resourceVersion-preconditioned delete did not converge: $kind/$name"
}

fence_writers() {
  local row
  while IFS= read -r row; do
    delete_cas_preconditioned deployment \
      "$(jq -er '.name' <<<"$row")" \
      "$(jq -er '.uid' <<<"$row")" \
      "$(jq -er '.resourceVersion' <<<"$row")" \
      "$(jq -er '.authorityDigest' <<<"$row")"
  done < <(jq -c '.writerDeployments[]' "$plan")
  while IFS= read -r row; do
    delete_cas_preconditioned job \
      "$(jq -er '.name' <<<"$row")" \
      "$(jq -er '.uid' <<<"$row")" \
      "$(jq -er '.resourceVersion' <<<"$row")" \
      "$(jq -er '.authorityDigest' <<<"$row")"
  done < <(jq -c '.jobs[]' "$plan")
  validate_preserved_web
}

wait_old_storage_removed() {
  local row volume volume_uid path current removed
  while IFS= read -r row; do
    volume=$(jq -er '.volume' <<<"$row")
    volume_uid=$(jq -er '.volumeUid' <<<"$row")
    path=$(jq -er '.path' <<<"$row")
    removed=0
    for _ in $(seq 1 "$WAIT_SECONDS"); do
      if current=$("${K[@]}" get "pv/$volume" -o json 2>/dev/null); then
        [[ "$(jq -er '.metadata.uid' <<<"$current")" == "$volume_uid" ]] ||
          fail "old PV name was reused before exact removal: $volume"
      elif ! sudo -n test -e "$path"; then
        removed=1
        break
      fi
      sleep 1
    done
    ((removed == 1)) ||
      fail "old PV storage was not removed: $volume"
  done < <(jq -c '.oldStorage[]' "$plan")
}

validate_planned_storage_before_delete() {
  local row=$1 claim claim_uid volume volume_uid volume_authority_digest path pv
  claim=$(jq -er '.claim' <<<"$row")
  claim_uid=$(jq -er '.claimUid' <<<"$row")
  volume=$(jq -er '.volume' <<<"$row")
  volume_uid=$(jq -er '.volumeUid' <<<"$row")
  volume_authority_digest=$(jq -er '.volumeAuthorityDigest' <<<"$row")
  path=$(jq -er '.path' <<<"$row")
  pv=$("${K[@]}" get "pv/$volume" -o json) ||
    fail "planned PV disappeared before PVC deletion: $volume"
  jq -e \
    --arg namespace "$NAMESPACE" \
    --arg claim "$claim" \
    --arg claimUid "$claim_uid" \
    --arg volumeUid "$volume_uid" \
    --arg path "$path" '
      .metadata.uid == $volumeUid
      and .metadata.deletionTimestamp == null
      and .status.phase == "Bound"
      and .spec.storageClassName == "local-path"
      and .spec.accessModes == ["ReadWriteOnce"]
      and .spec.volumeMode == "Filesystem"
      and .spec.persistentVolumeReclaimPolicy == "Delete"
      and .spec.claimRef.namespace == $namespace
      and .spec.claimRef.name == $claim
      and .spec.claimRef.uid == $claimUid
      and .spec.local.path == $path
      and .spec.hostPath == null
    ' <<<"$pv" >/dev/null ||
    fail "planned PV changed before PVC deletion: $volume"
  [[ "$(resource_authority_digest "$pv")" == "$volume_authority_digest" ]] ||
    fail "planned PV changed authority before PVC deletion: $volume"
}

remove_planned_foundation() {
  local row claim old
  fence_writers
  while IFS= read -r row; do
    delete_cas_preconditioned \
      "$(jq -er '.kind' <<<"$row")" \
      "$(jq -er '.name' <<<"$row")" \
      "$(jq -er '.uid' <<<"$row")" \
      "$(jq -er '.resourceVersion' <<<"$row")" \
      "$(jq -er '.authorityDigest' <<<"$row")"
  done < <(jq -c '.targets[]' "$plan")
  for claim in "${CLAIMS[@]}"; do
    old=$(jq -c --arg claim "$claim" \
      'first(.oldStorage[] | select(.claim == $claim))' "$plan")
    validate_planned_storage_before_delete "$old"
    delete_cas_preconditioned \
      pvc "$claim" \
      "$(jq -er '.claimUid' <<<"$old")" \
      "$(jq -er '.claimResourceVersion' <<<"$old")" \
      "$(jq -er '.claimAuthorityDigest' <<<"$old")"
  done
  wait_old_storage_removed
  validate_preserved_web
}

capture_foundation() {
  local output=$1 target kind name value
  : >"$work/foundation.jsonl"
  for target in "${FOUNDATION_TARGETS[@]}"; do
    kind=${target%%:*}
    name=${target#*:}
    value=$(captured_resource "$kind" "$name")
    jq -e --arg track "$FOUNDATION_TRACK" \
      '.metadata.labels["combo.build/environment-foundation"] == $track' \
      <<<"$value" >/dev/null ||
      fail "resource is outside the exact foundation track: $kind/$name"
    jq -n \
      --arg kind "$kind" \
      --arg name "$name" \
      --arg uid "$(jq -er '.metadata.uid' <<<"$value")" '{
        kind: $kind,
        name: $name,
        uid: $uid
      }' >>"$work/foundation.jsonl"
  done
  jq -s 'sort_by(.kind, .name)' "$work/foundation.jsonl" >"$output"
}

validate_foundation_workloads_ready() {
  local workload current
  for workload in \
    statefulset/release-postgres \
    statefulset/release-redis-queue \
    statefulset/release-minio \
    deployment/release-redis-hot; do
    current=$(get_resource "${workload%%/*}" "${workload#*/}") ||
      fail "foundation workload disappeared: $workload"
    jq -e '
      (.spec.replicas // 0) > 0
      and (.status.readyReplicas // 0) == .spec.replicas
      and (.status.availableReplicas // .status.readyReplicas // 0) == .spec.replicas
    ' <<<"$current" >/dev/null ||
      fail "foundation workload is not ready: $workload"
  done
}

validate_new_storage_identity() {
  local new_file=$1 claim old new
  jq -e --slurpfile plan "$plan" '
    . as $new
    | $plan[0].oldStorage as $old
    | ([ $new[].claim ] | sort) == ([$old[].claim] | sort)
    and all(["claimUid", "volume", "volumeUid", "path"][];
      . as $field
      | ($old | map(.[$field])) as $oldValues
      | ($new | map(.[$field])) as $newValues
      | ($oldValues | length) == ($oldValues | unique | length)
      and ($newValues | length) == ($newValues | unique | length)
      and all($newValues[];
        . as $value | ($oldValues | index($value)) == null))
  ' "$new_file" >/dev/null ||
    fail 'new foundation storage identities are not globally unique'
  for claim in "${CLAIMS[@]}"; do
    old=$(jq -c --arg claim "$claim" \
      'first(.oldStorage[] | select(.claim == $claim))' "$plan")
    new=$(jq -c --arg claim "$claim" \
      'first(.[] | select(.claim == $claim))' "$new_file")
    [[ -n "$new" ]] || fail "new storage evidence is missing: $claim"
    [[ "$(jq -er '.claimUid' <<<"$new")" != "$(jq -er '.claimUid' <<<"$old")" ]] ||
      fail "new PVC reused the old UID: $claim"
    [[ "$(jq -er '.volumeUid' <<<"$new")" != "$(jq -er '.volumeUid' <<<"$old")" ]] ||
      fail "new PV reused the old UID: $claim"
    [[ "$(jq -er '.path' <<<"$new")" != "$(jq -er '.path' <<<"$old")" ]] ||
      fail "new PVC reused the old storage path: $claim"
  done
}

apply_and_verify_foundation() {
  "${K[@]}" -n "$NAMESPACE" apply -f "$FOUNDATION_YAML" >/dev/null ||
    fail 'rendered foundation apply failed'
  for workload in \
    statefulset/release-postgres \
    statefulset/release-redis-queue \
    statefulset/release-minio \
    deployment/release-redis-hot; do
    "${K[@]}" -n "$NAMESPACE" rollout status "$workload" \
      --timeout="${WAIT_SECONDS}s" >/dev/null ||
      fail "new foundation did not become ready: $workload"
  done
  for claim in "${CLAIMS[@]}"; do
    "${K[@]}" -n "$NAMESPACE" wait --for=jsonpath='{.status.phase}'=Bound \
      "pvc/$claim" --timeout="${WAIT_SECONDS}s" >/dev/null ||
      fail "new foundation PVC did not bind: $claim"
  done
  capture_storage "$work/new-storage.json"
  validate_new_storage_identity "$work/new-storage.json"
  capture_foundation "$work/foundation.json"
  validate_foundation_workloads_ready
  validate_preserved_web
}

write_ready_snapshot() {
  [[ -f "$work/new-storage.json" && -f "$work/foundation.json" ]] ||
    fail 'verified foundation capture is missing before ready snapshot'
  jq -n \
    --arg requestId "$REQUEST_ID" \
    --arg planDigest "$plan_digest" \
    --slurpfile newStorage "$work/new-storage.json" \
    --slurpfile foundation "$work/foundation.json" '{
      schemaVersion: 1,
      requestId: $requestId,
      planDigest: $planDigest,
      newStorage: $newStorage[0],
      foundation: $foundation[0]
    }' >"$work/ready-snapshot.json"
  immutable_install "$work/ready-snapshot.json" "$ready_snapshot"
}

validate_ready_snapshot() {
  local expected_digest=$1
  local route_mode=${2:-preserved}
  [[ -f "$ready_snapshot" && ! -L "$ready_snapshot" ]] ||
    fail 'foundation ready snapshot is missing or unsafe'
  [[ "$(file_digest "$ready_snapshot")" == "$expected_digest" ]] ||
    fail 'foundation ready snapshot changed after checkpoint binding'
  jq -e \
    --arg requestId "$REQUEST_ID" \
    --arg planDigest "$plan_digest" '
      (keys | sort) == [
        "foundation", "newStorage", "planDigest", "requestId", "schemaVersion"
      ]
      and .schemaVersion == 1
      and .requestId == $requestId
      and .planDigest == $planDigest
      and (.newStorage | type == "array" and length == 3)
      and (.foundation | type == "array" and length == 10)
      and all(.newStorage[];
        (keys | sort) == ([
          "claim", "claimUid", "claimResourceVersion", "claimAuthorityDigest",
          "path", "volume", "volumeUid", "volumeResourceVersion",
          "volumeAuthorityDigest"
        ] | sort))
      and all(.foundation[];
        (keys | sort) == ["kind", "name", "uid"])
    ' "$ready_snapshot" >/dev/null ||
    fail 'foundation ready snapshot is invalid'
  jq '.newStorage' "$ready_snapshot" >"$work/live-expected-storage.json"
  validate_new_storage_identity "$work/live-expected-storage.json"
  capture_storage "$work/live-storage.json"
  cmp -s "$work/live-expected-storage.json" "$work/live-storage.json" ||
    fail 'foundation storage changed after its ready snapshot'
  jq '.foundation' "$ready_snapshot" >"$work/live-expected-foundation.json"
  capture_foundation "$work/live-foundation.json"
  cmp -s "$work/live-expected-foundation.json" "$work/live-foundation.json" ||
    fail 'foundation resources changed after their ready snapshot'
  "${K[@]}" -n "$NAMESPACE" diff -f "$FOUNDATION_YAML" >/dev/null ||
    fail 'live foundation differs from the immutable rendered artifact'
  validate_foundation_workloads_ready
  if [[ "$route_mode" == completed ]]; then
    validate_preserved_or_candidate_web
  else
    [[ "$route_mode" == preserved ]] ||
      fail 'invalid ready snapshot route validation mode'
    validate_preserved_web
  fi
}

validate_foundation_ready_live() {
  local row current
  validate_ready_snapshot \
    "$(jq -er '.foundationSnapshotDigest' "$checkpoint")" completed
  capture_storage "$work/live-storage.json"
  validate_new_storage_identity "$work/live-storage.json"
  jq -e --slurpfile live "$work/live-storage.json" \
    '.newStorage == (
      $live[0] | map(del(.claimAuthorityDigest, .volumeAuthorityDigest))
    )' "$evidence" >/dev/null ||
    fail 'completed foundation storage changed identity'
  while IFS= read -r row; do
    current=$(get_resource "$(jq -er '.kind' <<<"$row")" \
      "$(jq -er '.name' <<<"$row")") ||
      fail 'completed foundation resource disappeared'
    [[ "$(jq -er '.metadata.uid' <<<"$current")" == "$(jq -er '.uid' <<<"$row")" ]] ||
      fail 'completed foundation resource changed UID'
  done < <(jq -c '.foundation[]' "$evidence")
  validate_foundation_workloads_ready
  validate_preserved_or_candidate_web
}

validate_evidence() {
  jq -e \
    --arg policy "$POLICY" \
    --arg requestId "$REQUEST_ID" \
    --arg authorityDigest "$AUTHORITY_DIGEST" \
    --arg environment "$ENVIRONMENT" \
    --arg namespace "$NAMESPACE" \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg planDigest "$plan_digest" \
    --argjson supersededReset "$SUPERSEDED_RESET_JSON" '
      (
        if $supersededReset == null
        then
          .schemaVersion == 1
          and (keys | sort) == ([
            "schemaVersion", "status", "policy", "requestId",
            "authorityDigest", "environment", "namespace", "sourceSha",
            "releaseId", "manifestDigest", "planDigest", "startedAt",
            "storageClearedAt", "foundationReadyAt",
            "foundationSnapshotDigest", "oldStorage", "newStorage",
            "foundation", "preservedWeb", "checks", "completedAt"
          ] | sort)
          and .supersededReset == null
        else
          .schemaVersion == 2
          and (keys | sort) == ([
            "schemaVersion", "status", "policy", "requestId",
            "authorityDigest", "environment", "namespace", "sourceSha",
            "releaseId", "manifestDigest", "planDigest", "startedAt",
            "storageClearedAt", "foundationReadyAt",
            "foundationSnapshotDigest", "oldStorage", "newStorage",
            "foundation", "preservedWeb", "supersededReset", "checks",
            "completedAt"
          ] | sort)
          and .supersededReset == $supersededReset
        end
      )
      and .status == "passed"
      and .policy == $policy
      and .requestId == $requestId
      and .authorityDigest == $authorityDigest
      and .environment == $environment
      and .namespace == $namespace
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and .planDigest == $planDigest
      and (.foundationSnapshotDigest | test("^sha256:[0-9a-f]{64}$"))
      and (.startedAt | type == "string")
      and (.storageClearedAt | type == "string")
      and (.foundationReadyAt | type == "string")
      and (.completedAt | type == "string")
      and (.oldStorage | type == "array" and length == 3)
      and (.newStorage | type == "array" and length == 3)
      and (.foundation | type == "array" and length == 10)
      and all(.oldStorage[], .newStorage[];
        (keys | sort) == ([
          "claim", "claimUid", "claimResourceVersion", "path", "volume",
          "volumeUid", "volumeResourceVersion"
        ] | sort))
      and all(.foundation[];
        (keys | sort) == ["kind", "name", "uid"])
      and (.preservedWeb | keys | sort) == ["name", "uid"]
      and .checks == (
        {
          writersFenced: true,
          oldStorageRemoved: true,
          newStorageIdentity: true,
          activeWebPreserved: true
        } + (
          if $supersededReset == null
          then {}
          else {supersededResetContinuity: true}
          end
        )
      )
    ' "$evidence" >/dev/null ||
    fail 'foundation reset evidence is invalid'
}

publish_output() {
  if [[ -e "$OUTPUT" ]]; then
    [[ -f "$OUTPUT" && ! -L "$OUTPUT" ]] ||
      fail 'existing output path is unsafe'
    cmp -s "$evidence" "$OUTPUT" ||
      fail 'existing output differs from the completed reset evidence'
    chmod 0600 "$OUTPUT"
  else
    atomic_install "$evidence" "$OUTPUT"
  fi
}

if [[ -e "$evidence" ]]; then
  [[ -f "$evidence" && ! -L "$evidence" ]] ||
    fail 'persistent evidence path is unsafe'
  validate_evidence
  [[ "$(jq -er '.phase' "$checkpoint")" == foundation-ready ]] ||
    fail 'completed reset evidence lacks its ready phase checkpoint'
  validate_foundation_ready_live
  publish_output
  status 'foundation_reset_reused=true evidence_ready=true'
  exit 0
fi

phase=$(jq -er '.phase' "$checkpoint")
started_at=$(jq -er '.startedAt' "$checkpoint")
storage_at=$(jq -r '.storageClearedAt // empty' "$checkpoint")
foundation_at=$(jq -r '.foundationReadyAt // empty' "$checkpoint")

if [[ "$phase" == planned ]]; then
  status 'phase=planned action=fence-and-remove'
  remove_planned_foundation
  storage_at=$(now)
  write_checkpoint storage-removed "$plan_digest" "$started_at" \
    "$(jq -Rn --arg value "$storage_at" '$value')" null ''
  phase=storage-removed
fi

if [[ "$phase" == storage-removed ]]; then
  status 'phase=storage-removed action=create-foundation'
  if [[ -e "$ready_snapshot" || -L "$ready_snapshot" ]]; then
    [[ -f "$ready_snapshot" && ! -L "$ready_snapshot" ]] ||
      fail 'foundation ready snapshot path is unsafe'
    ready_digest=$(file_digest "$ready_snapshot")
    validate_ready_snapshot "$ready_digest" preserved
  else
    apply_and_verify_foundation
    write_ready_snapshot
    ready_digest=$(file_digest "$ready_snapshot")
    validate_ready_snapshot "$ready_digest" preserved
  fi
  foundation_at=$(now)
  write_checkpoint foundation-ready "$plan_digest" "$started_at" \
    "$(jq -Rn --arg value "$storage_at" '$value')" \
    "$(jq -Rn --arg value "$foundation_at" '$value')" \
    "$ready_digest"
  phase=foundation-ready
fi

[[ "$phase" == foundation-ready ]] ||
  fail 'foundation reset did not reach its ready checkpoint'

ready_digest=$(jq -er '.foundationSnapshotDigest' "$checkpoint")
validate_ready_snapshot "$ready_digest" preserved

jq -n \
  --arg policy "$POLICY" \
  --arg requestId "$REQUEST_ID" \
  --arg authorityDigest "$AUTHORITY_DIGEST" \
  --arg environment "$ENVIRONMENT" \
  --arg namespace "$NAMESPACE" \
  --arg sourceSha "$source_sha" \
  --arg releaseId "$release_id" \
  --arg manifestDigest "$MANIFEST_DIGEST" \
  --arg planDigest "$plan_digest" \
  --arg startedAt "$started_at" \
  --arg storageClearedAt "$storage_at" \
  --arg foundationReadyAt "$foundation_at" \
  --arg foundationSnapshotDigest "$ready_digest" \
  --argjson supersededReset "$SUPERSEDED_RESET_JSON" \
  --slurpfile oldStorage "$plan" \
  --slurpfile ready "$ready_snapshot" \
  --arg preservedWebName "$(jq -er '.preservedWeb.name' "$plan")" \
  --arg preservedWebUid "$(jq -er '.preservedWeb.uid' "$plan")" \
  --arg completedAt "$(now)" '{
    schemaVersion: (if $supersededReset == null then 1 else 2 end),
    status: "passed",
    policy: $policy,
    requestId: $requestId,
    authorityDigest: $authorityDigest,
    environment: $environment,
    namespace: $namespace,
    sourceSha: $sourceSha,
    releaseId: $releaseId,
    manifestDigest: $manifestDigest,
    planDigest: $planDigest,
    startedAt: $startedAt,
    storageClearedAt: $storageClearedAt,
    foundationReadyAt: $foundationReadyAt,
    foundationSnapshotDigest: $foundationSnapshotDigest,
    oldStorage: (
      $oldStorage[0].oldStorage
      | map(del(.claimAuthorityDigest, .volumeAuthorityDigest))
    ),
    newStorage: (
      $ready[0].newStorage
      | map(del(.claimAuthorityDigest, .volumeAuthorityDigest))
    ),
    foundation: $ready[0].foundation,
    preservedWeb: {
      name: $preservedWebName,
      uid: $preservedWebUid
    },
    checks: {
      writersFenced: true,
      oldStorageRemoved: true,
      newStorageIdentity: true,
      activeWebPreserved: true
    },
    completedAt: $completedAt
  }
  + (
    if $supersededReset == null
    then {}
    else {
      supersededReset: $supersededReset,
      checks: (
        {
          writersFenced: true,
          oldStorageRemoved: true,
          newStorageIdentity: true,
          activeWebPreserved: true,
          supersededResetContinuity: true
        }
      )
    }
    end
  )' >"$work/evidence.json"

atomic_install "$work/evidence.json" "$evidence"
validate_evidence
publish_output
status 'foundation_reset_completed=true evidence_ready=true'
