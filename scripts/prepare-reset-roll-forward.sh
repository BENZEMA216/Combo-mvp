#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly DIGEST_RE='^sha256:[0-9a-f]{64}$'
readonly SOURCE_SHA_RE='^[0-9a-f]{40}$'

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly SCRIPT_DIR

ENVIRONMENT=''
MANIFEST=''
MANIFEST_DIGEST=''
OUTPUT=''
KUBECONFIG_PATH=${KUBECONFIG:-"$HOME/.kube/config"}
EVIDENCE_ROOT=${COMBO_RELEASE_EVIDENCE_ROOT:-"$HOME/data/combo-releases/goal-a"}
TRAFFIC_STATE_ROOT=${COMBO_RELEASE_TRAFFIC_STATE_ROOT:-"$HOME/data/combo-releases/traffic"}
MUTATION_LOCK=${COMBO_MUTATION_LOCK:-"$HOME/data/combo-release-mutation.lock"}
TRAFFIC_LOCK=${COMBO_RELEASE_TRAFFIC_LOCK:-"$HOME/data/combo-release-traffic.lock"}
WEB_FORWARD_ENV=${COMBO_RELEASE_WEB_FORWARD_ENV:-/etc/combo-release/production-web-forward.env}
NGINX_CONFIG=${COMBO_RELEASE_NGINX_CONFIG:-/etc/nginx/conf.d/zz-agora-demo.conf}
FORMAL_NGINX_CONFIG=${COMBO_RELEASE_FORMAL_NGINX_CONFIG:-/etc/nginx/conf.d/happy.conf}
WEB_FORWARD_UNIT=${COMBO_RELEASE_WEB_FORWARD_UNIT:-combo-release-production-web-forward.service}
WAIT_SECONDS=${COMBO_RESET_ROLL_FORWARD_WAIT_SECONDS:-180}

status() { printf '[reset-roll-forward] %s\n' "$1"; }
fail() {
  printf '[reset-roll-forward] FAIL: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage: prepare-reset-roll-forward.sh
  --environment production
  --manifest release.json
  --manifest-digest sha256:...
  --output reset-roll-forward-evidence.json
EOF
  exit 2
}

while (($# > 0)); do
  (($# >= 2)) || usage
  case "$1" in
    --environment) ENVIRONMENT=$2 ;;
    --manifest) MANIFEST=$2 ;;
    --manifest-digest) MANIFEST_DIGEST=$2 ;;
    --output) OUTPUT=$2 ;;
    *) usage ;;
  esac
  shift 2
done

[[ "$ENVIRONMENT" == production ]] || fail 'reset roll-forward is restricted to Production'
[[ "$MANIFEST_DIGEST" =~ $DIGEST_RE ]] || fail 'invalid manifest digest'
[[ -f "$MANIFEST" && ! -L "$MANIFEST" ]] ||
  fail 'manifest must be a regular file'
[[ -n "$OUTPUT" && ! -L "$OUTPUT" ]] || fail 'output path is missing or unsafe'
[[ -d "$(dirname -- "$OUTPUT")" && ! -L "$(dirname -- "$OUTPUT")" ]] ||
  fail 'output parent must be an existing regular directory'
if [[ ! "$WAIT_SECONDS" =~ ^[1-9][0-9]{0,2}$ ]] ||
  ((WAIT_SECONDS > 600)); then
  fail 'invalid roll-forward wait duration'
fi

for command in node jq sha256sum flock kubectl awk install mktemp mv rm dirname \
  sleep seq sudo date chmod mkdir cmp sort systemctl; do
  command -v "$command" >/dev/null 2>&1 ||
    fail "missing host command: $command"
done
[[ -f "$SCRIPT_DIR/release-manifest.mjs" && ! -L "$SCRIPT_DIR/release-manifest.mjs" ]] ||
  fail 'release manifest verifier is missing'

verified_manifest=$(node "$SCRIPT_DIR/release-manifest.mjs" verify \
  --manifest "$MANIFEST" --digest "$MANIFEST_DIGEST") ||
  fail 'release manifest verification failed'
[[ "$verified_manifest" == "$MANIFEST_DIGEST" ]] ||
  fail 'release manifest verifier returned another digest'
new_source_sha=$(jq -er '.sourceSha' "$MANIFEST")
new_release_id=$(jq -er '.releaseId' "$MANIFEST")
[[ "$new_source_sha" =~ $SOURCE_SHA_RE ]] || fail 'new source SHA is invalid'
[[ "$new_release_id" == "release-$new_source_sha" ]] ||
  fail 'new release identity is invalid'

request_id=$(printf '%s\0%s\0%s\0%s' \
  combo-reset-roll-forward-v1 production "$new_source_sha" "$MANIFEST_DIGEST" |
  sha256sum | awk '{print "sha256:" $1}')
request_hex=${request_id#sha256:}
readonly new_source_sha new_release_id request_id request_hex

readonly NAMESPACE=combo
readonly environment_root="$EVIDENCE_ROOT/production"
readonly pending="$environment_root/pending.json"
readonly state_root="$EVIDENCE_ROOT/reset-roll-forwards/production"
readonly plan="$state_root/$request_hex.plan.json"
readonly checkpoint="$state_root/$request_hex.checkpoint.json"
readonly pending_archive="$state_root/$request_hex.old-pending.json"
readonly handoff_seal="$state_root/$request_hex.handoff-seal.json"
readonly evidence="$state_root/$request_hex.evidence.json"
readonly cancellation="$state_root/$request_hex.cancellation.json"
readonly current_state="$TRAFFIC_STATE_ROOT/production/current.json"

[[ -d "$EVIDENCE_ROOT" && ! -L "$EVIDENCE_ROOT" ]] ||
  fail 'release evidence root is missing or unsafe'
[[ -d "$environment_root" && ! -L "$environment_root" ]] ||
  fail 'Production release evidence directory is missing or unsafe'
for directory in "$EVIDENCE_ROOT/reset-roll-forwards" "$state_root"; do
  if [[ -e "$directory" || -L "$directory" ]]; then
    [[ -d "$directory" && ! -L "$directory" ]] ||
      fail "roll-forward state parent is unsafe: $directory"
  fi
done

work=$(mktemp -d)
cleanup() {
  rm -rf -- "$work"
}
trap cleanup EXIT
chmod 0700 "$work"

atomic_install() {
  local source=$1 target=$2 stage
  stage=$(mktemp "$(dirname -- "$target")/.reset-roll-forward.XXXXXX")
  install -m 0600 "$source" "$stage"
  cmp -s "$source" "$stage" || fail "atomic staging changed: $target"
  mv -fT "$stage" "$target"
}

immutable_install() {
  local source=$1 target=$2
  if [[ -e "$target" || -L "$target" ]]; then
    [[ -f "$target" && ! -L "$target" ]] ||
      fail "immutable state path is unsafe: $target"
    cmp -s "$source" "$target" || fail "immutable state changed: $target"
    return
  fi
  atomic_install "$source" "$target"
}

file_digest() {
  sha256sum "$1" | awk '{print "sha256:" $1}'
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
      spec: (.spec // null)
    }
  ' <<<"$1" | sha256sum | awk '{print "sha256:" $1}'
}

checksum_set_lists_file_once() {
  local checksum_file=$1 expected_name=$2 count
  count=$(awk -v expected="$expected_name" '
    $2 == expected { count += 1 }
    END { print count + 0 }
  ' "$checksum_file")
  [[ "$count" == 1 ]]
}

sudo_file_digest() {
  sudo -n sha256sum "$1" | awk '{print "sha256:" $1}'
}

now() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

for lock in "$MUTATION_LOCK" "$TRAFFIC_LOCK"; do
  lock_parent=$(dirname -- "$lock")
  mkdir -p "$lock_parent"
  [[ -d "$lock_parent" && ! -L "$lock_parent" ]] ||
    fail "lock parent is unsafe: $lock_parent"
  if [[ -e "$lock" || -L "$lock" ]]; then
    [[ -f "$lock" && ! -L "$lock" ]] ||
      fail "lock path is unsafe: $lock"
  fi
done
exec 9>"$MUTATION_LOCK"
chmod 0600 "$MUTATION_LOCK"
flock -x 9
exec 8>"$TRAFFIC_LOCK"
chmod 0600 "$TRAFFIC_LOCK"
flock -x 8

mkdir -p "$state_root"
chmod 0700 "$EVIDENCE_ROOT/reset-roll-forwards" "$state_root"
[[ -d "$state_root" && ! -L "$state_root" ]] ||
  fail 'roll-forward state directory is unsafe'
[[ -f "$SCRIPT_DIR/reset-roll-forward-journal.mjs" &&
  ! -L "$SCRIPT_DIR/reset-roll-forward-journal.mjs" ]] ||
  fail 'reset roll-forward journal auditor is missing or unsafe'
node "$SCRIPT_DIR/reset-roll-forward-journal.mjs" audit \
  --evidence-root "$EVIDENCE_ROOT" \
  --environment production \
  --source-sha "$new_source_sha" \
  --manifest-digest "$MANIFEST_DIGEST" \
  --mode prepare >"$work/journal-audit.json" ||
  fail 'global reset roll-forward journal audit failed'

K=(kubectl --kubeconfig "$KUBECONFIG_PATH")
readonly -a K

get_resource() {
  local kind=$1 name=$2
  "${K[@]}" -n "$NAMESPACE" get "$kind/$name" -o json
}

get_resource_optional() {
  local kind=$1 name=$2
  "${K[@]}" -n "$NAMESPACE" get "$kind/$name" --ignore-not-found -o json
}

capture_active_web() {
  local source_sha release_id manifest_digest web_name forward_service
  local web service canary_digest formal_digest web_image
  [[ -f "$current_state" && ! -L "$current_state" ]] ||
    fail 'Production traffic state is missing or unsafe'
  jq -e '
    (keys | sort) == ([
      "schemaVersion", "environment", "sourceSha", "releaseId",
      "manifestDigest", "canaryNginxSha256", "formalNginxSha256",
      "webService"
    ] | sort)
    and .schemaVersion == 1
    and .environment == "production"
    and (.sourceSha | test("^[0-9a-f]{40}$"))
    and .releaseId == ("release-" + .sourceSha)
    and (.manifestDigest | test("^sha256:[0-9a-f]{64}$"))
    and (.canaryNginxSha256 | test("^sha256:[0-9a-f]{64}$"))
    and (.formalNginxSha256 | test("^sha256:[0-9a-f]{64}$"))
    and .webService == ("release-" + .sourceSha[0:12] + "-web")
  ' "$current_state" >/dev/null || fail 'Production traffic state is invalid'
  source_sha=$(jq -er '.sourceSha' "$current_state")
  release_id=$(jq -er '.releaseId' "$current_state")
  manifest_digest=$(jq -er '.manifestDigest' "$current_state")
  web_name=$(jq -er '.webService' "$current_state")

  if ! sudo -n test -f "$WEB_FORWARD_ENV" ||
    ! sudo -n test ! -L "$WEB_FORWARD_ENV"; then
    fail 'Production Web forward environment is missing or unsafe'
  fi
  [[ "$(sudo -n awk 'END {print NR}' "$WEB_FORWARD_ENV")" == 1 ]] ||
    fail 'Production Web forward environment has an invalid shape'
  forward_service=$(sudo -n awk -F= '
    $1 == "COMBO_RELEASE_WEB_SERVICE" {print $2}
  ' "$WEB_FORWARD_ENV")
  [[ "$forward_service" == "$web_name" ]] ||
    fail 'Production Web forward does not match current traffic'
  sudo -n systemctl is-enabled --quiet "$WEB_FORWARD_UNIT" ||
    fail 'Production Web forwarder is not enabled'
  sudo -n systemctl is-active --quiet "$WEB_FORWARD_UNIT" ||
    fail 'Production Web forwarder is not active'

  for path in "$NGINX_CONFIG" "$FORMAL_NGINX_CONFIG"; do
    if ! sudo -n test -f "$path" || ! sudo -n test ! -L "$path"; then
      fail 'Production Nginx route is missing or unsafe'
    fi
  done
  canary_digest=$(sudo_file_digest "$NGINX_CONFIG")
  formal_digest=$(sudo_file_digest "$FORMAL_NGINX_CONFIG")
  [[ "$canary_digest" == "$(jq -er '.canaryNginxSha256' "$current_state")" ]] ||
    fail 'Production canary Nginx route changed outside traffic state'
  [[ "$formal_digest" == "$(jq -er '.formalNginxSha256' "$current_state")" ]] ||
    fail 'Production formal Nginx route changed outside traffic state'

  web=$(get_resource deployment "$web_name") ||
    fail 'active Production Web deployment is missing'
  service=$(get_resource service "$web_name") ||
    fail 'active Production Web Service is missing'
  jq -e \
    --arg namespace "$NAMESPACE" \
    --arg name "$web_name" \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$manifest_digest" '
      .metadata.namespace == $namespace
      and .metadata.name == $name
      and .metadata.deletionTimestamp == null
      and .metadata.labels["combo.build/release-track"] == "release-v1"
      and (.metadata.uid | type == "string" and length > 0)
      and (.metadata.resourceVersion | type == "string" and length > 0)
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
    ' <<<"$web" >/dev/null ||
    fail 'active Production Web deployment is not identity-bound and ready'
  jq -e \
    --arg namespace "$NAMESPACE" \
    --arg name "$web_name" '
      .metadata.namespace == $namespace
      and .metadata.name == $name
      and .metadata.deletionTimestamp == null
      and .metadata.labels["combo.build/release-track"] == "release-v1"
      and (.metadata.uid | type == "string" and length > 0)
      and (.metadata.resourceVersion | type == "string" and length > 0)
      and (.spec.type == null or .spec.type == "ClusterIP")
      and .spec.selector == {
        app: $name,
        "combo.build/release-track": "release-v1"
      }
      and ((.spec.ports // []) | length == 1)
      and .spec.ports[0].name == "http"
      and .spec.ports[0].port == 80
      and .spec.ports[0].targetPort == 80
      and .spec.ports[0].protocol == "TCP"
      and .spec.ports[0].nodePort == null
    ' <<<"$service" >/dev/null ||
    fail 'active Production Web Service is not identity-bound'
  web_image=$(jq -er \
    'first(.spec.template.spec.containers[] | select(.name == "web") | .image)' \
    <<<"$web")
  jq -n \
    --arg name "$web_name" \
    --arg uid "$(jq -er '.metadata.uid' <<<"$web")" \
    --arg resourceVersion "$(jq -er '.metadata.resourceVersion' <<<"$web")" \
    --arg serviceName "$web_name" \
    --arg serviceUid "$(jq -er '.metadata.uid' <<<"$service")" \
    --arg serviceResourceVersion "$(jq -er '.metadata.resourceVersion' <<<"$service")" \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$manifest_digest" \
    --arg webImage "$web_image" \
    --arg trafficStateDigest "$(file_digest "$current_state")" \
    --arg forwardEnvDigest "$(sudo_file_digest "$WEB_FORWARD_ENV")" \
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
      canaryNginxSha256: $canaryNginxSha256,
      formalNginxSha256: $formalNginxSha256
    }'
}

capture_targets() {
  local old_source=$1 old_release=$2 old_manifest=$3 role name value
  : >"$work/targets.jsonl"
  for role in api runtime worker; do
    name="release-${old_source:0:12}-$role"
    value=$(get_resource deployment "$name") ||
      fail "old candidate writer is missing: deployment/$name"
    jq -e \
      --arg namespace "$NAMESPACE" \
      --arg name "$name" \
      --arg role "$role" \
      --arg sourceSha "$old_source" \
      --arg releaseId "$old_release" \
      --arg manifestDigest "$old_manifest" '
        .metadata.namespace == $namespace
        and .metadata.name == $name
        and .metadata.deletionTimestamp == null
        and .metadata.labels["combo.build/release-track"] == "release-v1"
        and (.metadata.uid | type == "string" and length > 0)
        and (.metadata.resourceVersion | type == "string" and length > 0)
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
        and ([.spec.template.spec.containers[] | select(.name == $role)] | length) == 1
      ' <<<"$value" >/dev/null ||
      fail "old candidate writer is outside its identity contract: $name"
    jq -n \
      --arg kind deployment \
      --arg name "$name" \
      --arg uid "$(jq -er '.metadata.uid' <<<"$value")" \
      --arg resourceVersion "$(jq -er '.metadata.resourceVersion' <<<"$value")" \
      --arg authorityDigest "$(resource_authority_digest "$value")" '{
        kind: $kind,
        name: $name,
        state: "present",
        uid: $uid,
        resourceVersion: $resourceVersion,
        authorityDigest: $authorityDigest
      }' >>"$work/targets.jsonl"
  done
  for role in migrate minio-init; do
    name="release-${old_source:0:12}-$role"
    value=$(get_resource_optional job "$name") ||
      fail "failed to read old candidate Job: job/$name"
    if [[ -z "$value" ]]; then
      jq -n \
        --arg kind job \
        --arg name "$name" '{
          kind: $kind,
          name: $name,
          state: "already-absent",
          uid: null,
          resourceVersion: null,
          authorityDigest: null
        }' >>"$work/targets.jsonl"
      continue
    fi
    jq -e \
      --arg namespace "$NAMESPACE" \
      --arg name "$name" \
      --arg sourceSha "$old_source" \
      --arg releaseId "$old_release" \
      --arg manifestDigest "$old_manifest" '
        .metadata.namespace == $namespace
        and .metadata.name == $name
        and .metadata.deletionTimestamp == null
        and (.metadata.uid | type == "string" and length > 0)
        and (.metadata.resourceVersion | type == "string" and length > 0)
        and .spec.template.metadata.annotations["combo.build/source-sha"] == $sourceSha
        and .spec.template.metadata.annotations["combo.build/release-id"] == $releaseId
        and .spec.template.metadata.annotations["combo.build/release-manifest-digest"]
          == $manifestDigest
      ' <<<"$value" >/dev/null ||
      fail "old candidate Job is outside its identity contract: $name"
    jq -n \
      --arg kind job \
      --arg name "$name" \
      --arg uid "$(jq -er '.metadata.uid' <<<"$value")" \
      --arg resourceVersion "$(jq -er '.metadata.resourceVersion' <<<"$value")" \
      --arg authorityDigest "$(resource_authority_digest "$value")" '{
        kind: $kind,
        name: $name,
        state: "present",
        uid: $uid,
        resourceVersion: $resourceVersion,
        authorityDigest: $authorityDigest
      }' >>"$work/targets.jsonl"
  done
  jq -s 'sort_by(.kind, .name)' "$work/targets.jsonl"
}

validate_activation() {
  local old_source=$1 old_release=$2 old_manifest=$3 reset_digest=$4
  local schema_digest=$5 directory=$6 verified
  [[ -d "$directory" && ! -L "$directory" ]] ||
    fail 'old Production activation directory is missing or unsafe'
  for file in SHA256SUMS activation-evidence.json foundation-reset-evidence.json \
    release.json release.sha256; do
    [[ -f "$directory/$file" && ! -L "$directory/$file" ]] ||
      fail "old Production activation lacks $file"
  done
  (cd "$directory" && sha256sum --quiet -c SHA256SUMS) ||
    fail 'old Production activation checksum set changed'
  [[ "$(tr -d '\n' <"$directory/release.sha256")" == "$old_manifest" ]] ||
    fail 'old Production activation manifest digest changed'
  verified=$(node "$SCRIPT_DIR/release-manifest.mjs" verify \
    --manifest "$directory/release.json" --digest "$old_manifest") ||
    fail 'old Production activation manifest verification failed'
  [[ "$verified" == "$old_manifest" ]] ||
    fail 'old Production activation manifest verifier returned another digest'
  [[ "$(file_digest "$directory/foundation-reset-evidence.json")" == "$reset_digest" ]] ||
    fail 'old Production reset evidence digest changed'
  jq -e \
    --arg sourceSha "$old_source" \
    --arg releaseId "$old_release" \
    --arg manifestDigest "$old_manifest" \
    --arg schemaStructureProofDigest "$schema_digest" \
    --arg resetDigest "$reset_digest" '
      .schemaVersion == 1
      and .status == "awaiting-acceptance"
      and .environment == "production"
      and .namespace == "combo"
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and .foundationResetEvidenceDigest == $resetDigest
      and .schemaStructureProofDigest == $schemaStructureProofDigest
      and .checks.candidateReady == true
      and .checks.trafficActivated == true
      and .checks.formalDomainVerified == true
      and .checks.supersededReleaseRetained == true
    ' "$directory/activation-evidence.json" >/dev/null ||
    fail 'old Production activation evidence is invalid'
}

finalized_reset_release_is_current() {
  local old_source=$1 old_release=$2 old_manifest=$3 reset_digest=$4
  local schema_digest=$5 directory current live verified file
  directory="$environment_root/$old_release"
  current="$environment_root/current.json"
  if [[ ! -e "$directory" && ! -L "$directory" ]]; then
    return 1
  fi
  [[ -d "$directory" && ! -L "$directory" ]] ||
    fail 'finalized predecessor release directory is unsafe'
  for file in SHA256SUMS deploy-evidence.json foundation-reset-evidence.json \
    release.json release.sha256; do
    [[ -f "$directory/$file" && ! -L "$directory/$file" ]] ||
      fail "finalized predecessor release lacks $file"
  done
  checksum_set_lists_file_once \
    "$directory/SHA256SUMS" deploy-evidence.json ||
    fail 'finalized predecessor checksum set does not bind deploy evidence once'
  checksum_set_lists_file_once \
    "$directory/SHA256SUMS" foundation-reset-evidence.json ||
    fail 'finalized predecessor checksum set does not bind reset evidence once'
  (
    cd "$directory"
    sha256sum --quiet -c SHA256SUMS
  ) || fail 'finalized predecessor release checksum set changed'
  [[ "$(tr -d '\n' <"$directory/release.sha256")" == "$old_manifest" ]] ||
    fail 'finalized predecessor manifest digest changed'
  verified=$(node "$SCRIPT_DIR/release-manifest.mjs" verify \
    --manifest "$directory/release.json" --digest "$old_manifest") ||
    fail 'finalized predecessor manifest verification failed'
  [[ "$verified" == "$old_manifest" ]] ||
    fail 'finalized predecessor manifest verifier returned another digest'
  [[ "$(file_digest "$directory/foundation-reset-evidence.json")" == \
    "$reset_digest" ]] ||
    fail 'finalized predecessor reset evidence digest changed'
  jq -e \
    --arg sourceSha "$old_source" \
    --arg releaseId "$old_release" \
    --arg manifestDigest "$old_manifest" \
    --arg resetDigest "$reset_digest" \
    --arg schemaDigest "$schema_digest" '
      .schemaVersion == 1
      and .status == "passed"
      and .environment == "production"
      and .namespace == "combo"
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and .foundationMode == "reset"
      and .foundationResetEvidenceDigest == $resetDigest
      and .foundationReset.status == "passed"
      and .schemaStructureDigest == $schemaDigest
      and .checks.protectedAcceptance == true
      and .checks.publicTraffic == true
      and .traffic.formalOrigin == "https://buildwithcombo.com"
      and .traffic.formalAliasOrigin == "https://www.buildwithcombo.com"
    ' "$directory/deploy-evidence.json" >/dev/null ||
    fail 'finalized predecessor deploy evidence is invalid'
  [[ -f "$current" && ! -L "$current" ]] ||
    fail 'finalized predecessor is not the committed current release'
  jq -e \
    --arg sourceSha "$old_source" \
    --arg releaseId "$old_release" \
    --arg manifestDigest "$old_manifest" \
    --arg evidencePath "$directory" '
      (keys | sort) == ([
        "schemaVersion", "status", "environment", "namespace", "sourceSha",
        "releaseId", "manifestDigest", "evidencePath"
      ] | sort)
      and .schemaVersion == 1
      and .status == "passed"
      and .environment == "production"
      and .namespace == "combo"
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and .evidencePath == $evidencePath
    ' "$current" >/dev/null ||
    fail 'finalized predecessor current checkpoint is invalid'
  live=$(capture_active_web)
  jq -e \
    --arg sourceSha "$old_source" \
    --arg releaseId "$old_release" \
    --arg manifestDigest "$old_manifest" '
      .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and .name == ("release-" + $sourceSha[0:12] + "-web")
    ' <<<"$live" >/dev/null ||
    fail 'finalized predecessor is not the active Production Web release'
}

retire_finalized_reset_pending() {
  local old_pending_digest=$1 retirements_root retirement_root archive
  retirements_root="$EVIDENCE_ROOT/finalized-reset-pending-retirements"
  retirement_root="$retirements_root/production"
  if [[ -e "$retirements_root" || -L "$retirements_root" ]]; then
    [[ -d "$retirements_root" && ! -L "$retirements_root" ]] ||
      fail 'finalized pending retirement parent is unsafe'
  else
    mkdir -m 0700 -- "$retirements_root"
  fi
  if [[ -e "$retirement_root" || -L "$retirement_root" ]]; then
    [[ -d "$retirement_root" && ! -L "$retirement_root" ]] ||
      fail 'finalized pending retirement root is unsafe'
  else
    mkdir -m 0700 -- "$retirement_root"
  fi
  chmod 0700 "$retirements_root" "$retirement_root"
  [[ -d "$retirement_root" && ! -L "$retirement_root" ]] ||
    fail 'finalized pending retirement root is unsafe'
  archive="$retirement_root/${old_pending_digest#sha256:}.pending.json"
  immutable_install "$pending" "$archive"
  [[ "$(file_digest "$pending")" == "$old_pending_digest" &&
    "$(file_digest "$archive")" == "$old_pending_digest" ]] ||
    fail 'finalized pending changed before metadata-only retirement'
  rm -f -- "$pending"
  [[ ! -e "$pending" && ! -L "$pending" ]] ||
    fail 'finalized predecessor pending checkpoint could not be retired'
}

validate_plan() {
  jq -e \
    --arg requestId "$request_id" \
    --arg newSourceSha "$new_source_sha" \
    --arg newReleaseId "$new_release_id" \
    --arg newManifestDigest "$MANIFEST_DIGEST" '
      (keys | sort) == ([
        "schemaVersion", "operation", "environment", "namespace", "requestId",
        "createdAt", "newSourceSha", "newReleaseId", "newManifestDigest",
        "oldPending", "activation", "preservedWeb", "targets"
      ] | sort)
      and .schemaVersion == 1
      and .operation == "production-reset-roll-forward"
      and .environment == "production"
      and .namespace == "combo"
      and .requestId == $requestId
      and .newSourceSha == $newSourceSha
      and .newReleaseId == $newReleaseId
      and .newManifestDigest == $newManifestDigest
      and (.createdAt | type == "string" and test("Z$"))
      and (.oldPending.sourceSha | test("^[0-9a-f]{40}$"))
      and .oldPending.releaseId == ("release-" + .oldPending.sourceSha)
      and .oldPending.sourceSha != $newSourceSha
      and (.oldPending.manifestDigest | test("^sha256:[0-9a-f]{64}$"))
      and .oldPending.phase == "post-cut"
      and (.oldPending.foundationResetEvidenceDigest
        | test("^sha256:[0-9a-f]{64}$"))
      and (.oldPending.schemaStructureProofDigest
        | test("^sha256:[0-9a-f]{64}$"))
      and (.oldPending.digest | test("^sha256:[0-9a-f]{64}$"))
      and ((.oldPending | keys | sort) == ([
        "sourceSha", "releaseId", "manifestDigest", "phase",
        "foundationResetEvidenceDigest", "schemaStructureProofDigest", "digest"
      ] | sort))
      and ((.activation | keys | sort) == ([
        "sha256SumsDigest", "activationEvidenceDigest",
        "resetEvidenceDigest", "schemaStructureProofDigest"
      ] | sort))
      and (.activation.sha256SumsDigest | test("^sha256:[0-9a-f]{64}$"))
      and (.activation.activationEvidenceDigest | test("^sha256:[0-9a-f]{64}$"))
      and .activation.resetEvidenceDigest
        == .oldPending.foundationResetEvidenceDigest
      and .activation.schemaStructureProofDigest
        == .oldPending.schemaStructureProofDigest
      and ((.preservedWeb | keys | sort) == ([
        "name", "uid", "resourceVersion", "serviceName", "serviceUid",
        "serviceResourceVersion", "sourceSha", "releaseId", "manifestDigest",
        "webImage", "trafficStateDigest", "forwardEnvDigest",
        "canaryNginxSha256", "formalNginxSha256"
      ] | sort))
      and (.preservedWeb.name
        == ("release-" + .oldPending.sourceSha[0:12] + "-web"))
      and .preservedWeb.serviceName == .preservedWeb.name
      and .preservedWeb.sourceSha == .oldPending.sourceSha
      and .preservedWeb.releaseId == .oldPending.releaseId
      and .preservedWeb.manifestDigest == .oldPending.manifestDigest
      and (.preservedWeb.uid | type == "string" and length > 0)
      and (.preservedWeb.resourceVersion | type == "string" and length > 0)
      and (.preservedWeb.serviceUid | type == "string" and length > 0)
      and (.preservedWeb.serviceResourceVersion
        | type == "string" and length > 0)
      and (.preservedWeb.webImage
        | test("^ghcr.io/dangdang-tech/combo-web@sha256:[0-9a-f]{64}$"))
      and (.preservedWeb.trafficStateDigest
        | test("^sha256:[0-9a-f]{64}$"))
      and (.preservedWeb.forwardEnvDigest
        | test("^sha256:[0-9a-f]{64}$"))
      and (.preservedWeb.canaryNginxSha256
        | test("^sha256:[0-9a-f]{64}$"))
      and (.preservedWeb.formalNginxSha256
        | test("^sha256:[0-9a-f]{64}$"))
      and (.targets | length == 5)
      and ([.targets[] | .kind + "/" + .name] | sort) == ([
        "deployment/release-" + .oldPending.sourceSha[0:12] + "-api",
        "deployment/release-" + .oldPending.sourceSha[0:12] + "-runtime",
        "deployment/release-" + .oldPending.sourceSha[0:12] + "-worker",
        "job/release-" + .oldPending.sourceSha[0:12] + "-migrate",
        "job/release-" + .oldPending.sourceSha[0:12] + "-minio-init"
      ] | sort)
      and all(.targets[];
        (keys | sort)
          == [
            "authorityDigest", "kind", "name", "resourceVersion", "state", "uid"
          ]
        and (
          if .state == "present" then
            (.uid | type == "string" and length > 0)
            and (.resourceVersion | type == "string" and length > 0)
            and (.authorityDigest | test("^sha256:[0-9a-f]{64}$"))
          else
            .state == "already-absent"
            and .kind == "job"
            and .uid == null
            and .resourceVersion == null
            and .authorityDigest == null
          end
        ))
    ' "$plan" >/dev/null || fail 'immutable roll-forward plan is invalid'
}

validate_checkpoint() {
  local expected_plan_digest=$1
  jq -e \
    --arg requestId "$request_id" \
    --arg planDigest "$expected_plan_digest" '
      (keys | sort) == ([
        "schemaVersion", "requestId", "planDigest", "phase", "startedAt",
        "writersRemovedAt", "handoffSealedAt", "completedAt",
        "archiveDigest", "sealDigest", "evidenceDigest", "updatedAt"
      ] | sort)
      and .schemaVersion == 1
      and .requestId == $requestId
      and .planDigest == $planDigest
      and (.phase == "planned" or .phase == "writers-removed"
        or .phase == "handoff-sealed" or .phase == "completed"
        or .phase == "cancelled-finalized")
      and (.startedAt | type == "string" and test("Z$"))
      and (.updatedAt | type == "string" and test("Z$"))
      and (
        if .phase == "planned" then
          .writersRemovedAt == null and .handoffSealedAt == null
          and .completedAt == null and .archiveDigest == null
          and .sealDigest == null and .evidenceDigest == null
        elif .phase == "writers-removed" then
          (.writersRemovedAt | type == "string" and test("Z$"))
          and .handoffSealedAt == null and .completedAt == null
          and .archiveDigest == null and .sealDigest == null
          and .evidenceDigest == null
        elif .phase == "handoff-sealed" then
          (.writersRemovedAt | type == "string" and test("Z$"))
          and (.handoffSealedAt | type == "string" and test("Z$"))
          and .completedAt == null
          and (.archiveDigest | test("^sha256:[0-9a-f]{64}$"))
          and (.sealDigest | test("^sha256:[0-9a-f]{64}$"))
          and .evidenceDigest == null
        elif .phase == "cancelled-finalized" then
          .writersRemovedAt == null
          and .handoffSealedAt == null
          and (.completedAt | type == "string" and test("Z$"))
          and (.archiveDigest | test("^sha256:[0-9a-f]{64}$"))
          and .sealDigest == null
          and (.evidenceDigest | test("^sha256:[0-9a-f]{64}$"))
        else
          (.writersRemovedAt | type == "string" and test("Z$"))
          and (.handoffSealedAt | type == "string" and test("Z$"))
          and (.completedAt | type == "string" and test("Z$"))
          and (.archiveDigest | test("^sha256:[0-9a-f]{64}$"))
          and (.sealDigest | test("^sha256:[0-9a-f]{64}$"))
          and (.evidenceDigest | test("^sha256:[0-9a-f]{64}$"))
        end
      )
    ' "$checkpoint" >/dev/null || fail 'roll-forward checkpoint is invalid'
}

write_checkpoint() {
  local phase=$1 plan_digest_value=$2 started_at=$3 writers_at=$4 sealed_at=$5
  local completed_at=$6 archive_digest=${7:-} seal_digest=${8:-}
  local evidence_digest=${9:-} stage="$work/checkpoint.json"
  jq -n \
    --arg requestId "$request_id" \
    --arg planDigest "$plan_digest_value" \
    --arg phase "$phase" \
    --arg startedAt "$started_at" \
    --argjson writersRemovedAt "$writers_at" \
    --argjson handoffSealedAt "$sealed_at" \
    --argjson completedAt "$completed_at" \
    --arg archiveDigest "$archive_digest" \
    --arg sealDigest "$seal_digest" \
    --arg evidenceDigest "$evidence_digest" \
    --arg updatedAt "$(now)" '{
      schemaVersion: 1,
      requestId: $requestId,
      planDigest: $planDigest,
      phase: $phase,
      startedAt: $startedAt,
      writersRemovedAt: $writersRemovedAt,
      handoffSealedAt: $handoffSealedAt,
      completedAt: $completedAt,
      archiveDigest: (if $archiveDigest == "" then null else $archiveDigest end),
      sealDigest: (if $sealDigest == "" then null else $sealDigest end),
      evidenceDigest: (if $evidenceDigest == "" then null else $evidenceDigest end),
      updatedAt: $updatedAt
    }' >"$stage"
  atomic_install "$stage" "$checkpoint"
}

validate_cancellation() {
  local expected_digest=${1:-}
  [[ -f "$cancellation" && ! -L "$cancellation" ]] ||
    fail 'finalized predecessor cancellation evidence is missing or unsafe'
  jq -e \
    --arg requestId "$request_id" \
    --arg planDigest "$plan_digest" \
    --arg archiveDigest "$(file_digest "$pending_archive")" \
    --arg oldSourceSha "$(jq -er '.oldPending.sourceSha' "$plan")" \
    --arg oldReleaseId "$(jq -er '.oldPending.releaseId' "$plan")" \
    --arg oldManifestDigest "$(jq -er '.oldPending.manifestDigest' "$plan")" \
    --arg newSourceSha "$new_source_sha" \
    --arg newReleaseId "$new_release_id" \
    --arg newManifestDigest "$MANIFEST_DIGEST" '
      (keys | sort) == ([
        "schemaVersion", "status", "operation", "reason", "environment",
        "namespace", "requestId", "planDigest", "pendingArchiveDigest",
        "oldSourceSha", "oldReleaseId", "oldManifestDigest",
        "newSourceSha", "newReleaseId", "newManifestDigest", "checks",
        "completedAt"
      ] | sort)
      and .schemaVersion == 1
      and .status == "cancelled"
      and .operation == "production-reset-roll-forward"
      and .reason == "predecessor-already-finalized"
      and .environment == "production"
      and .namespace == "combo"
      and .requestId == $requestId
      and .planDigest == $planDigest
      and .pendingArchiveDigest == $archiveDigest
      and .oldSourceSha == $oldSourceSha
      and .oldReleaseId == $oldReleaseId
      and .oldManifestDigest == $oldManifestDigest
      and .newSourceSha == $newSourceSha
      and .newReleaseId == $newReleaseId
      and .newManifestDigest == $newManifestDigest
      and .checks == {
        predecessorFinalized: true,
        currentCheckpointMatched: true,
        writersRemoved: false,
        pendingArchived: true,
        rollForwardRequired: false,
        secretMaterialAccessed: false
      }
      and (.completedAt | type == "string" and test("Z$"))
    ' "$cancellation" >/dev/null ||
    fail 'finalized predecessor cancellation evidence is invalid'
  if [[ -n "$expected_digest" ]]; then
    [[ "$(file_digest "$cancellation")" == "$expected_digest" ]] ||
      fail 'finalized predecessor cancellation evidence digest changed'
  fi
}

validate_planned_targets_untouched() {
  local row current state kind name
  while IFS= read -r row; do
    state=$(jq -er '.state' <<<"$row")
    kind=$(jq -er '.kind' <<<"$row")
    name=$(jq -er '.name' <<<"$row")
    current=$(get_resource_optional "$kind" "$name") ||
      fail "failed to revalidate planned target before cancellation: $kind/$name"
    if [[ "$state" == already-absent ]]; then
      [[ -z "$current" ]] ||
        fail "already-absent planned target reappeared: $kind/$name"
      continue
    fi
    [[ -n "$current" ]] ||
      fail "roll-forward mutation began before predecessor finalization: $kind/$name"
    [[ "$(jq -er '.metadata.uid' <<<"$current")" == \
      "$(jq -er '.uid' <<<"$row")" &&
      "$(resource_authority_digest "$current")" == \
      "$(jq -er '.authorityDigest' <<<"$row")" ]] ||
      fail "planned target changed before predecessor finalization: $kind/$name"
  done < <(jq -c '.targets[]' "$plan")
}

cancel_planned_roll_forward_for_finalized_predecessor() {
  local old_source old_release old_manifest reset_digest schema_digest
  local archive_digest completed_at cancellation_digest
  [[ "$phase" == planned ]] ||
    fail 'a finalized predecessor appeared after roll-forward mutation began'
  old_source=$(jq -er '.oldPending.sourceSha' "$plan")
  old_release=$(jq -er '.oldPending.releaseId' "$plan")
  old_manifest=$(jq -er '.oldPending.manifestDigest' "$plan")
  reset_digest=$(jq -er '.oldPending.foundationResetEvidenceDigest' "$plan")
  schema_digest=$(jq -er '.oldPending.schemaStructureProofDigest' "$plan")
  finalized_reset_release_is_current \
    "$old_source" "$old_release" "$old_manifest" \
    "$reset_digest" "$schema_digest" ||
    return 1
  validate_planned_targets_untouched
  [[ -f "$pending" && ! -L "$pending" ]] ||
    fail 'planned finalized-predecessor recovery lost its pending checkpoint'
  [[ "$(file_digest "$pending")" == "$(jq -er '.oldPending.digest' "$plan")" ]] ||
    fail 'planned finalized-predecessor pending checkpoint changed'
  [[ ! -e "$OUTPUT" && ! -L "$OUTPUT" ]] ||
    fail 'cancelled roll-forward cannot publish handoff evidence'
  immutable_install "$pending" "$pending_archive"
  archive_digest=$(file_digest "$pending_archive")
  if [[ -e "$cancellation" || -L "$cancellation" ]]; then
    [[ -f "$cancellation" && ! -L "$cancellation" ]] ||
      fail 'finalized predecessor cancellation evidence is unsafe'
    validate_cancellation
    completed_at=$(jq -er '.completedAt' "$cancellation")
  else
    completed_at=$(now)
    jq -n \
      --arg requestId "$request_id" \
      --arg planDigest "$plan_digest" \
      --arg pendingArchiveDigest "$archive_digest" \
      --arg oldSourceSha "$old_source" \
      --arg oldReleaseId "$old_release" \
      --arg oldManifestDigest "$old_manifest" \
      --arg newSourceSha "$new_source_sha" \
      --arg newReleaseId "$new_release_id" \
      --arg newManifestDigest "$MANIFEST_DIGEST" \
      --arg completedAt "$completed_at" '{
        schemaVersion: 1,
        status: "cancelled",
        operation: "production-reset-roll-forward",
        reason: "predecessor-already-finalized",
        environment: "production",
        namespace: "combo",
        requestId: $requestId,
        planDigest: $planDigest,
        pendingArchiveDigest: $pendingArchiveDigest,
        oldSourceSha: $oldSourceSha,
        oldReleaseId: $oldReleaseId,
        oldManifestDigest: $oldManifestDigest,
        newSourceSha: $newSourceSha,
        newReleaseId: $newReleaseId,
        newManifestDigest: $newManifestDigest,
        checks: {
          predecessorFinalized: true,
          currentCheckpointMatched: true,
          writersRemoved: false,
          pendingArchived: true,
          rollForwardRequired: false,
          secretMaterialAccessed: false
        },
        completedAt: $completedAt
      }' >"$work/cancellation.json"
    immutable_install "$work/cancellation.json" "$cancellation"
  fi
  cancellation_digest=$(file_digest "$cancellation")
  validate_cancellation "$cancellation_digest"
  write_checkpoint cancelled-finalized "$plan_digest" "$started_at" \
    null null "$(jq -Rn --arg value "$completed_at" '$value')" \
    "$archive_digest" '' "$cancellation_digest"
  rm -f -- "$pending"
  [[ ! -e "$pending" && ! -L "$pending" ]] ||
    fail 'finalized predecessor pending checkpoint could not be retired'
  status 'stale_finalized_pending_retired=true roll_forward_required=false'
  exit 0
}

resource_api_path() {
  local kind=$1 name=$2
  case "$kind" in
    deployment)
      printf '/apis/apps/v1/namespaces/%s/deployments/%s\n' "$NAMESPACE" "$name"
      ;;
    job)
      printf '/apis/batch/v1/namespaces/%s/jobs/%s\n' "$NAMESPACE" "$name"
      ;;
    *) fail "unsupported roll-forward deletion kind: $kind" ;;
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

delete_cas() {
  local kind=$1 name=$2 uid=$3 planned_resource_version=$4 authority_digest=$5
  local current current_resource_version options api_path
  [[ -n "$planned_resource_version" &&
    "$authority_digest" =~ ^sha256:[0-9a-f]{64}$ ]] ||
    fail "invalid immutable deletion binding: $kind/$name"
  current=$(get_resource_optional "$kind" "$name") ||
    fail "failed to read $kind/$name before CAS deletion"
  if [[ -z "$current" ]]; then
    return 0
  fi
  [[ "$(jq -er '.metadata.uid' <<<"$current")" == "$uid" ]] ||
    fail "$kind/$name changed UID after roll-forward planning"
  [[ "$(resource_authority_digest "$current")" == "$authority_digest" ]] ||
    fail "$kind/$name changed deletion authority after roll-forward planning"
  if [[ -n "$(jq -r '.metadata.deletionTimestamp // empty' <<<"$current")" ]]; then
    wait_absent "$kind" "$name" "$uid" "$authority_digest"
    return 0
  fi
  current_resource_version=$(jq -er '.metadata.resourceVersion' <<<"$current")
  options="$work/delete-${kind}-${name}.json"
  jq -n \
    --arg uid "$uid" \
    --arg resourceVersion "$current_resource_version" '{
      apiVersion: "v1",
      kind: "DeleteOptions",
      propagationPolicy: "Foreground",
      preconditions: {uid: $uid, resourceVersion: $resourceVersion}
    }' >"$options"
  api_path=$(resource_api_path "$kind" "$name")
  "${K[@]}" delete --raw="$api_path" -f "$options" >/dev/null ||
    fail "UID/resourceVersion delete failed: $kind/$name"
  wait_absent "$kind" "$name" "$uid" "$authority_digest"
}

verify_targets_absent() {
  local row current
  while IFS= read -r row; do
    current=$(get_resource_optional "$(jq -er '.kind' <<<"$row")" \
      "$(jq -er '.name' <<<"$row")") ||
      fail 'failed to verify old candidate writer and Job absence'
    [[ -z "$current" ]] ||
      fail 'old candidate writer or Job reappeared after roll-forward fencing'
  done < <(jq -c '.targets[]' "$plan")
}

validate_bound_old_state() {
  local old_source old_release old_manifest reset_digest schema_digest
  local activation_directory live
  old_source=$(jq -er '.oldPending.sourceSha' "$plan")
  old_release=$(jq -er '.oldPending.releaseId' "$plan")
  old_manifest=$(jq -er '.oldPending.manifestDigest' "$plan")
  reset_digest=$(jq -er '.oldPending.foundationResetEvidenceDigest' "$plan")
  schema_digest=$(jq -er '.oldPending.schemaStructureProofDigest' "$plan")
  activation_directory="$environment_root/$old_release.activation"
  validate_activation "$old_source" "$old_release" "$old_manifest" \
    "$reset_digest" "$schema_digest" "$activation_directory"
  [[ "$(file_digest "$activation_directory/SHA256SUMS")" == \
    "$(jq -er '.activation.sha256SumsDigest' "$plan")" ]] ||
    fail 'old activation SHA256SUMS changed after roll-forward planning'
  [[ "$(file_digest "$activation_directory/activation-evidence.json")" == \
    "$(jq -er '.activation.activationEvidenceDigest' "$plan")" ]] ||
    fail 'old activation evidence changed after roll-forward planning'
  live=$(capture_active_web)
  jq -e --argjson live "$live" '
    (.preservedWeb | del(.resourceVersion, .serviceResourceVersion))
      == ($live | del(.resourceVersion, .serviceResourceVersion))
  ' "$plan" >/dev/null ||
    fail 'active Web or host traffic changed during reset roll-forward'
}

validate_preserved_or_new_web() {
  local live
  live=$(capture_active_web)
  if jq -e --argjson live "$live" '
    (.preservedWeb | del(.resourceVersion, .serviceResourceVersion))
      == ($live | del(.resourceVersion, .serviceResourceVersion))
  ' "$plan" >/dev/null; then
    return 0
  fi
  jq -e \
    --arg newSourceSha "$new_source_sha" \
    --arg newReleaseId "$new_release_id" \
    --arg newManifestDigest "$MANIFEST_DIGEST" \
    --arg newImage "$(jq -er '.images.web' "$MANIFEST")" '
      .name == ("release-" + $newSourceSha[0:12] + "-web")
      and .sourceSha == $newSourceSha
      and .releaseId == $newReleaseId
      and .manifestDigest == $newManifestDigest
      and .webImage == $newImage
    ' <<<"$live" >/dev/null ||
    fail 'completed roll-forward no longer preserves the old or new active Web'
}

validate_seal() {
  local expected_digest=$1
  [[ -f "$handoff_seal" && ! -L "$handoff_seal" ]] ||
    fail 'roll-forward handoff seal is missing or unsafe'
  [[ "$(file_digest "$handoff_seal")" == "$expected_digest" ]] ||
    fail 'roll-forward handoff seal digest changed'
  jq -e \
    --arg requestId "$request_id" \
    --arg planDigest "$(file_digest "$plan")" \
    --arg archiveDigest "$(file_digest "$pending_archive")" \
    --arg oldSourceSha "$(jq -er '.oldPending.sourceSha' "$plan")" \
    --arg oldReleaseId "$(jq -er '.oldPending.releaseId' "$plan")" \
    --arg oldManifestDigest "$(jq -er '.oldPending.manifestDigest' "$plan")" \
    --arg resetEvidenceDigest \
      "$(jq -er '.oldPending.foundationResetEvidenceDigest' "$plan")" \
    --arg newSourceSha "$new_source_sha" \
    --arg newReleaseId "$new_release_id" \
    --arg newManifestDigest "$MANIFEST_DIGEST" \
    --argjson preservedWeb \
      "$(jq '.preservedWeb | {name, uid, serviceName, serviceUid}' "$plan")" \
    --argjson removedTargets \
      "$(jq '[.targets[] | {kind, name, state, uid}]' "$plan")" '
      (keys | sort) == ([
        "schemaVersion", "status", "operation", "environment", "namespace",
        "requestId", "planDigest", "pendingArchiveDigest", "oldSourceSha",
        "oldReleaseId", "oldManifestDigest", "resetEvidenceDigest",
        "newSourceSha", "newReleaseId", "newManifestDigest", "preservedWeb",
        "removedTargets", "checks", "sealedAt"
      ] | sort)
      and .schemaVersion == 1
      and .status == "sealed"
      and .operation == "production-reset-roll-forward"
      and .environment == "production"
      and .namespace == "combo"
      and .requestId == $requestId
      and .planDigest == $planDigest
      and .pendingArchiveDigest == $archiveDigest
      and .oldSourceSha == $oldSourceSha
      and .oldReleaseId == $oldReleaseId
      and .oldManifestDigest == $oldManifestDigest
      and .resetEvidenceDigest == $resetEvidenceDigest
      and .newSourceSha == $newSourceSha
      and .newReleaseId == $newReleaseId
      and .newManifestDigest == $newManifestDigest
      and .preservedWeb == $preservedWeb
      and .removedTargets == $removedTargets
      and .checks == {
        activeWebPreserved: true,
        oldCandidateWritersRemoved: true,
        pendingArchivePrepared: true,
        resetBoundaryRetained: true,
        secretMaterialAccessed: false
      }
      and (.sealedAt | type == "string" and test("Z$"))
    ' "$handoff_seal" >/dev/null || fail 'roll-forward handoff seal is invalid'
}

validate_evidence() {
  [[ -f "$evidence" && ! -L "$evidence" ]] ||
    fail 'roll-forward completion evidence is missing or unsafe'
  jq -e \
    --arg requestId "$request_id" \
    --arg planDigest "$(file_digest "$plan")" \
    --arg archiveDigest "$(file_digest "$pending_archive")" \
    --arg sealDigest "$(file_digest "$handoff_seal")" \
    --arg oldSourceSha "$(jq -er '.oldPending.sourceSha' "$plan")" \
    --arg oldReleaseId "$(jq -er '.oldPending.releaseId' "$plan")" \
    --arg oldManifestDigest "$(jq -er '.oldPending.manifestDigest' "$plan")" \
    --arg resetEvidenceDigest \
      "$(jq -er '.oldPending.foundationResetEvidenceDigest' "$plan")" \
    --arg newSourceSha "$new_source_sha" \
    --arg newReleaseId "$new_release_id" \
    --arg newManifestDigest "$MANIFEST_DIGEST" \
    --argjson preservedWeb \
      "$(jq '.preservedWeb | {name, uid, serviceName, serviceUid}' "$plan")" \
    --argjson removedTargets \
      "$(jq '[.targets[] | {kind, name, state, uid}]' "$plan")" '
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
      and .oldSourceSha == $oldSourceSha
      and .oldReleaseId == $oldReleaseId
      and .oldManifestDigest == $oldManifestDigest
      and .resetEvidenceDigest == $resetEvidenceDigest
      and .newSourceSha == $newSourceSha
      and .newReleaseId == $newReleaseId
      and .newManifestDigest == $newManifestDigest
      and .preservedWeb == $preservedWeb
      and .removedTargets == $removedTargets
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
    ' "$evidence" >/dev/null || fail 'roll-forward completion evidence is invalid'
}

publish_output() {
  if [[ -e "$OUTPUT" || -L "$OUTPUT" ]]; then
    [[ -f "$OUTPUT" && ! -L "$OUTPUT" ]] || fail 'existing output path is unsafe'
    cmp -s "$evidence" "$OUTPUT" ||
      fail 'existing output differs from roll-forward completion evidence'
    chmod 0600 "$OUTPUT"
  else
    atomic_install "$evidence" "$OUTPUT"
  fi
}

validate_completed_pending_state() {
  if [[ ! -e "$pending" && ! -L "$pending" ]]; then
    return
  fi
  [[ -f "$pending" && ! -L "$pending" ]] ||
    fail 'completed reset roll-forward found an unsafe pending checkpoint'
  jq -e \
    --arg sourceSha "$new_source_sha" \
    --arg releaseId "$new_release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" '
      .schemaVersion == 3
      and .environment == "production"
      and .namespace == "combo"
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and .foundationResetEvidenceDigest == null
      and (.phase == "armed"
        or .phase == "post-cut"
        or .phase == "finalizing")
    ' "$pending" >/dev/null ||
    fail 'completed reset roll-forward found a pending checkpoint for another release'
}

if [[ -e "$plan" || -L "$plan" ]]; then
  [[ -f "$plan" && ! -L "$plan" ]] || fail 'roll-forward plan path is unsafe'
  validate_plan
else
  [[ -f "$pending" && ! -L "$pending" ]] ||
    fail 'Production reset roll-forward requires an existing pending checkpoint'
  jq -e '
    (keys | sort) == ([
      "cleanupPlanDigest", "environment", "foundationCreated",
      "foundationResetEvidenceDigest", "manifestDigest", "namespace", "phase",
      "releaseId", "schemaVersion", "schemaStructureProofDigest", "sourceSha",
      "trafficCutAt", "webService"
    ] | sort)
    and .schemaVersion == 3
    and .environment == "production"
    and .namespace == "combo"
    and .phase == "post-cut"
    and (.sourceSha | test("^[0-9a-f]{40}$"))
    and .releaseId == ("release-" + .sourceSha)
    and (.manifestDigest | test("^sha256:[0-9a-f]{64}$"))
    and (.foundationResetEvidenceDigest | test("^sha256:[0-9a-f]{64}$"))
    and (.schemaStructureProofDigest | test("^sha256:[0-9a-f]{64}$"))
    and .webService == ("release-" + .sourceSha[0:12] + "-web")
    and .foundationCreated == true
    and (
      .cleanupPlanDigest == null
      or (.cleanupPlanDigest | test("^sha256:[0-9a-f]{64}$"))
    )
    and (.trafficCutAt | type == "string" and test("Z$"))
  ' "$pending" >/dev/null ||
    fail 'Production pending checkpoint is not a post-cut reset boundary'
  old_source_sha=$(jq -er '.sourceSha' "$pending")
  old_release_id=$(jq -er '.releaseId' "$pending")
  old_manifest_digest=$(jq -er '.manifestDigest' "$pending")
  old_reset_digest=$(jq -er '.foundationResetEvidenceDigest' "$pending")
  old_schema_digest=$(jq -er '.schemaStructureProofDigest' "$pending")
  old_pending_digest=$(file_digest "$pending")
  [[ "$old_source_sha" != "$new_source_sha" ]] ||
    fail 'reset roll-forward requires a newer distinct candidate'
  if finalized_reset_release_is_current \
    "$old_source_sha" "$old_release_id" "$old_manifest_digest" \
    "$old_reset_digest" "$old_schema_digest"; then
    [[ ! -e "$OUTPUT" && ! -L "$OUTPUT" ]] ||
      fail 'metadata-only finalized pending recovery cannot publish handoff evidence'
    retire_finalized_reset_pending "$old_pending_digest"
    status 'stale_finalized_pending_retired=true roll_forward_required=false'
    exit 0
  fi
  activation_directory="$environment_root/$old_release_id.activation"
  validate_activation "$old_source_sha" "$old_release_id" \
    "$old_manifest_digest" "$old_reset_digest" "$old_schema_digest" \
    "$activation_directory"
  active_web=$(capture_active_web)
  jq -e \
    --arg sourceSha "$old_source_sha" \
    --arg releaseId "$old_release_id" \
    --arg manifestDigest "$old_manifest_digest" '
      .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and .name == ("release-" + $sourceSha[0:12] + "-web")
    ' <<<"$active_web" >/dev/null ||
    fail 'post-cut Production traffic is not the old reset candidate'
  targets=$(capture_targets \
    "$old_source_sha" "$old_release_id" "$old_manifest_digest")
  jq -n \
    --arg requestId "$request_id" \
    --arg createdAt "$(now)" \
    --arg newSourceSha "$new_source_sha" \
    --arg newReleaseId "$new_release_id" \
    --arg newManifestDigest "$MANIFEST_DIGEST" \
    --arg oldSourceSha "$old_source_sha" \
    --arg oldReleaseId "$old_release_id" \
    --arg oldManifestDigest "$old_manifest_digest" \
    --arg oldPhase post-cut \
    --arg resetEvidenceDigest "$old_reset_digest" \
    --arg schemaStructureProofDigest "$old_schema_digest" \
    --arg oldPendingDigest "$old_pending_digest" \
    --arg sha256SumsDigest "$(file_digest "$activation_directory/SHA256SUMS")" \
    --arg activationEvidenceDigest \
      "$(file_digest "$activation_directory/activation-evidence.json")" \
    --argjson preservedWeb "$active_web" \
    --argjson targets "$targets" '{
      schemaVersion: 1,
      operation: "production-reset-roll-forward",
      environment: "production",
      namespace: "combo",
      requestId: $requestId,
      createdAt: $createdAt,
      newSourceSha: $newSourceSha,
      newReleaseId: $newReleaseId,
      newManifestDigest: $newManifestDigest,
      oldPending: {
        sourceSha: $oldSourceSha,
        releaseId: $oldReleaseId,
        manifestDigest: $oldManifestDigest,
        phase: $oldPhase,
        foundationResetEvidenceDigest: $resetEvidenceDigest,
        schemaStructureProofDigest: $schemaStructureProofDigest,
        digest: $oldPendingDigest
      },
      activation: {
        sha256SumsDigest: $sha256SumsDigest,
        activationEvidenceDigest: $activationEvidenceDigest,
        resetEvidenceDigest: $resetEvidenceDigest,
        schemaStructureProofDigest: $schemaStructureProofDigest
      },
      preservedWeb: $preservedWeb,
      targets: $targets
    }' >"$work/plan.json"
  immutable_install "$work/plan.json" "$plan"
  validate_plan
fi

plan_digest=$(file_digest "$plan")
readonly plan_digest
if [[ -e "$checkpoint" || -L "$checkpoint" ]]; then
  [[ -f "$checkpoint" && ! -L "$checkpoint" ]] ||
    fail 'roll-forward checkpoint path is unsafe'
  validate_checkpoint "$plan_digest"
else
  write_checkpoint planned "$plan_digest" "$(jq -er '.createdAt' "$plan")" \
    null null null '' '' ''
fi

phase=$(jq -er '.phase' "$checkpoint")
started_at=$(jq -er '.startedAt' "$checkpoint")
writers_at=$(jq -r '.writersRemovedAt // empty' "$checkpoint")
sealed_at=$(jq -r '.handoffSealedAt // empty' "$checkpoint")

if [[ "$phase" == cancelled-finalized ]]; then
  [[ -f "$pending_archive" && ! -L "$pending_archive" ]] ||
    fail 'cancelled roll-forward lost its pending archive'
  validate_cancellation "$(jq -er '.evidenceDigest' "$checkpoint")"
  if [[ -e "$pending" || -L "$pending" ]]; then
    [[ -f "$pending" && ! -L "$pending" ]] ||
      fail 'cancelled roll-forward found an unsafe pending checkpoint'
    [[ "$(file_digest "$pending")" == \
      "$(jq -er '.oldPending.digest' "$plan")" ]] ||
      fail 'cancelled roll-forward pending checkpoint changed'
    rm -f -- "$pending"
  fi
  [[ ! -e "$pending" && ! -L "$pending" ]] ||
    fail 'cancelled roll-forward could not retire its pending checkpoint'
  [[ ! -e "$OUTPUT" && ! -L "$OUTPUT" ]] ||
    fail 'cancelled roll-forward unexpectedly published handoff evidence'
  status 'stale_finalized_pending_retired=true roll_forward_required=false'
  exit 0
fi

if [[ "$phase" == completed ]]; then
  validate_completed_pending_state
  [[ -f "$pending_archive" && ! -L "$pending_archive" ]] ||
    fail 'completed reset roll-forward lost its pending archive'
  [[ "$(file_digest "$pending_archive")" == \
    "$(jq -er '.archiveDigest' "$checkpoint")" ]] ||
    fail 'completed reset roll-forward pending archive digest changed'
  validate_seal "$(jq -er '.sealDigest' "$checkpoint")"
  validate_evidence
  [[ "$(file_digest "$evidence")" == "$(jq -er '.evidenceDigest' "$checkpoint")" ]] ||
    fail 'completed reset roll-forward evidence digest changed'
  verify_targets_absent
  validate_preserved_or_new_web
  publish_output
  status 'reset_roll_forward_reused=true handoff_ready=true'
  exit 0
fi

if [[ "$phase" == planned ]]; then
  if cancel_planned_roll_forward_for_finalized_predecessor; then
    fail 'finalized predecessor cancellation returned unexpectedly'
  fi
fi

validate_bound_old_state
if [[ -e "$pending" || -L "$pending" ]]; then
  [[ -f "$pending" && ! -L "$pending" ]] ||
    fail 'Production pending checkpoint became unsafe'
  [[ "$(file_digest "$pending")" == "$(jq -er '.oldPending.digest' "$plan")" ]] ||
    fail 'Production pending checkpoint changed after roll-forward planning'
elif [[ "$phase" != handoff-sealed ]]; then
  fail 'Production pending checkpoint disappeared before the handoff seal'
fi

if [[ "$phase" == planned ]]; then
  status 'phase=planned action=remove-old-candidate-writers'
  while IFS= read -r row; do
    if [[ "$(jq -er '.state' <<<"$row")" == already-absent ]]; then
      continue
    fi
    delete_cas \
      "$(jq -er '.kind' <<<"$row")" \
      "$(jq -er '.name' <<<"$row")" \
      "$(jq -er '.uid' <<<"$row")" \
      "$(jq -er '.resourceVersion' <<<"$row")" \
      "$(jq -er '.authorityDigest' <<<"$row")"
  done < <(jq -c '.targets[]' "$plan")
  verify_targets_absent
  validate_bound_old_state
  writers_at=$(now)
  write_checkpoint writers-removed "$plan_digest" "$started_at" \
    "$(jq -Rn --arg value "$writers_at" '$value')" null null '' '' ''
  phase=writers-removed
fi

if [[ "$phase" == writers-removed ]]; then
  status 'phase=writers-removed action=seal-handoff'
  verify_targets_absent
  validate_bound_old_state
  immutable_install "$pending" "$pending_archive"
  archive_digest=$(file_digest "$pending_archive")
  [[ "$archive_digest" == "$(jq -er '.oldPending.digest' "$plan")" ]] ||
    fail 'atomic pending archive differs from the immutable plan'
  jq -n \
    --arg requestId "$request_id" \
    --arg planDigest "$plan_digest" \
    --arg pendingArchiveDigest "$archive_digest" \
    --arg oldSourceSha "$(jq -er '.oldPending.sourceSha' "$plan")" \
    --arg oldReleaseId "$(jq -er '.oldPending.releaseId' "$plan")" \
    --arg oldManifestDigest "$(jq -er '.oldPending.manifestDigest' "$plan")" \
    --arg resetEvidenceDigest \
      "$(jq -er '.oldPending.foundationResetEvidenceDigest' "$plan")" \
    --arg newSourceSha "$new_source_sha" \
    --arg newReleaseId "$new_release_id" \
    --arg newManifestDigest "$MANIFEST_DIGEST" \
    --argjson preservedWeb "$(jq '.preservedWeb | {name, uid, serviceName, serviceUid}' "$plan")" \
    --argjson removedTargets \
      "$(jq '[.targets[] | {kind, name, state, uid}]' "$plan")" \
    --arg sealedAt "$writers_at" '{
      schemaVersion: 1,
      status: "sealed",
      operation: "production-reset-roll-forward",
      environment: "production",
      namespace: "combo",
      requestId: $requestId,
      planDigest: $planDigest,
      pendingArchiveDigest: $pendingArchiveDigest,
      oldSourceSha: $oldSourceSha,
      oldReleaseId: $oldReleaseId,
      oldManifestDigest: $oldManifestDigest,
      resetEvidenceDigest: $resetEvidenceDigest,
      newSourceSha: $newSourceSha,
      newReleaseId: $newReleaseId,
      newManifestDigest: $newManifestDigest,
      preservedWeb: $preservedWeb,
      removedTargets: $removedTargets,
      checks: {
        activeWebPreserved: true,
        oldCandidateWritersRemoved: true,
        pendingArchivePrepared: true,
        resetBoundaryRetained: true,
        secretMaterialAccessed: false
      },
      sealedAt: $sealedAt
    }' >"$work/handoff-seal.json"
  immutable_install "$work/handoff-seal.json" "$handoff_seal"
  seal_digest=$(file_digest "$handoff_seal")
  validate_seal "$seal_digest"
  sealed_at=$(jq -er '.sealedAt' "$handoff_seal")
  write_checkpoint handoff-sealed "$plan_digest" "$started_at" \
    "$(jq -Rn --arg value "$writers_at" '$value')" \
    "$(jq -Rn --arg value "$sealed_at" '$value')" null \
    "$archive_digest" "$seal_digest" ''
  phase=handoff-sealed
fi

[[ "$phase" == handoff-sealed ]] ||
  fail 'reset roll-forward did not reach its sealed handoff'
archive_digest=$(jq -er '.archiveDigest' "$checkpoint")
seal_digest=$(jq -er '.sealDigest' "$checkpoint")
[[ -f "$pending_archive" && ! -L "$pending_archive" ]] ||
  fail 'sealed handoff lost its pending archive'
[[ "$(file_digest "$pending_archive")" == "$archive_digest" ]] ||
  fail 'sealed pending archive digest changed'
validate_seal "$seal_digest"
verify_targets_absent
validate_bound_old_state

if [[ -e "$pending" || -L "$pending" ]]; then
  [[ -f "$pending" && ! -L "$pending" ]] ||
    fail 'old pending checkpoint is unsafe before retirement'
  [[ "$(file_digest "$pending")" == "$archive_digest" ]] ||
    fail 'old pending checkpoint changed before retirement'
  rm -f -- "$pending"
fi
[[ ! -e "$pending" && ! -L "$pending" ]] ||
  fail 'old pending checkpoint could not be retired'

if [[ -e "$evidence" || -L "$evidence" ]]; then
  [[ -f "$evidence" && ! -L "$evidence" ]] ||
    fail 'roll-forward evidence path is unsafe'
else
  jq -n \
    --arg requestId "$request_id" \
    --arg planDigest "$plan_digest" \
    --arg pendingArchiveDigest "$archive_digest" \
    --arg handoffSealDigest "$seal_digest" \
    --arg oldSourceSha "$(jq -er '.oldPending.sourceSha' "$plan")" \
    --arg oldReleaseId "$(jq -er '.oldPending.releaseId' "$plan")" \
    --arg oldManifestDigest "$(jq -er '.oldPending.manifestDigest' "$plan")" \
    --arg resetEvidenceDigest \
      "$(jq -er '.oldPending.foundationResetEvidenceDigest' "$plan")" \
    --arg newSourceSha "$new_source_sha" \
    --arg newReleaseId "$new_release_id" \
    --arg newManifestDigest "$MANIFEST_DIGEST" \
    --argjson preservedWeb "$(jq '.preservedWeb | {name, uid, serviceName, serviceUid}' "$plan")" \
    --argjson removedTargets \
      "$(jq '[.targets[] | {kind, name, state, uid}]' "$plan")" \
    --arg completedAt "$sealed_at" '{
      schemaVersion: 1,
      status: "passed",
      operation: "production-reset-roll-forward",
      environment: "production",
      namespace: "combo",
      requestId: $requestId,
      planDigest: $planDigest,
      pendingArchiveDigest: $pendingArchiveDigest,
      handoffSealDigest: $handoffSealDigest,
      oldSourceSha: $oldSourceSha,
      oldReleaseId: $oldReleaseId,
      oldManifestDigest: $oldManifestDigest,
      resetEvidenceDigest: $resetEvidenceDigest,
      newSourceSha: $newSourceSha,
      newReleaseId: $newReleaseId,
      newManifestDigest: $newManifestDigest,
      preservedWeb: $preservedWeb,
      removedTargets: $removedTargets,
      checks: {
        activeWebPreserved: true,
        oldCandidateWritersRemoved: true,
        pendingArchived: true,
        pendingRemoved: true,
        resetBoundaryRetained: true,
        rollForwardOnly: true,
        secretMaterialAccessed: false
      },
      completedAt: $completedAt
    }' >"$work/evidence.json"
  immutable_install "$work/evidence.json" "$evidence"
fi
validate_evidence
evidence_digest=$(file_digest "$evidence")
completed_at=$(jq -er '.completedAt' "$evidence")
write_checkpoint completed "$plan_digest" "$started_at" \
  "$(jq -Rn --arg value "$writers_at" '$value')" \
  "$(jq -Rn --arg value "$sealed_at" '$value')" \
  "$(jq -Rn --arg value "$completed_at" '$value')" \
  "$archive_digest" "$seal_digest" "$evidence_digest"
publish_output
status 'reset_roll_forward_completed=true handoff_ready=true'
