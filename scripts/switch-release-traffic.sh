#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly SCRIPT_DIR
readonly HOST_UNIT_ROOT="$SCRIPT_DIR/../infra/host/release"
readonly DIGEST_RE='^sha256:[0-9a-f]{64}$'
readonly SHA_RE='^[0-9a-f]{40}$'
readonly FORMAL_INITIAL_SHA256='sha256:a2b92b1cf53fb6cbc72fae5687cdefcd60962dcceab9d823e220c7cef0262118'

ENVIRONMENT=''
MANIFEST=''
MANIFEST_DIGEST=''
EVIDENCE_OUTPUT=''
KUBECONFIG_PATH=${KUBECONFIG:-"$HOME/.kube/config"}
TRAFFIC_STATE_ROOT=${COMBO_RELEASE_TRAFFIC_STATE_ROOT:-"$HOME/data/combo-releases/traffic"}
TRAFFIC_LOCK=${COMBO_RELEASE_TRAFFIC_LOCK:-"$HOME/data/combo-release-traffic.lock"}
CHECKPOINT_ROOT=${COMBO_RELEASE_TRAFFIC_CHECKPOINT_ROOT:-/var/lib/combo-release/traffic-checkpoints}
RELEASE_EVIDENCE_ROOT=${COMBO_RELEASE_EVIDENCE_ROOT:-"$HOME/data/combo-releases/goal-a"}

status() { printf '[release-traffic] %s\n' "$1" >&2; }
fail() {
  printf '[release-traffic] FAIL: %s\n' "$1" >&2
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

atomic_user_install() {
  local source=$1 target=$2 mode=$3 stage
  stage=$(mktemp "$(dirname "$target")/.atomic.XXXXXX")
  install -m "$mode" "$source" "$stage"
  [[ "$(sha256sum "$stage" | awk '{print "sha256:" $1}')" == \
    "$(sha256sum "$source" | awk '{print "sha256:" $1}')" ]] ||
    fail "staged file changed: $target"
  mv -fT "$stage" "$target"
}

usage() {
  cat >&2 <<'EOF'
Usage: switch-release-traffic.sh
  --environment preview|production
  --manifest release.json
  --manifest-digest sha256:...
  --evidence-output traffic-evidence.json
EOF
  exit 2
}

while (($# > 0)); do
  (($# >= 2)) || usage
  case "$1" in
    --environment) ENVIRONMENT=$2 ;;
    --manifest) MANIFEST=$2 ;;
    --manifest-digest) MANIFEST_DIGEST=$2 ;;
    --evidence-output) EVIDENCE_OUTPUT=$2 ;;
    *) usage ;;
  esac
  shift 2
done

case "$ENVIRONMENT" in
  preview)
    NAMESPACE=combo-review
    NGINX_CONFIG=/etc/nginx/conf.d/combo-cloud-review.conf
    NGINX_CONTRACT=preview
    PUBLIC_ORIGIN=https://review.43-160-242-46.sslip.io
    S3_ORIGIN=https://review-s3.43-160-242-46.sslip.io
    FORMAL_NGINX_CONFIG=''
    FORMAL_ORIGIN=''
    FORMAL_ALIAS_ORIGIN=''
    LEGACY_WEB_PORT=30081
    UNITS=(
      combo-release-preview-web-forward.service
      combo-release-preview-minio-forward.service
    )
    PORTS=(18081 19001)
    ENV_FILES=(
      /etc/combo-release/preview-web-forward.env
      ''
    )
    ;;
  production)
    NAMESPACE=combo
    NGINX_CONFIG=/etc/nginx/conf.d/zz-agora-demo.conf
    NGINX_CONTRACT=production-canary
    PUBLIC_ORIGIN=https://agora.43-160-242-46.sslip.io
    S3_ORIGIN=https://s3.43-160-242-46.sslip.io
    FORMAL_NGINX_CONFIG=/etc/nginx/conf.d/happy.conf
    FORMAL_ORIGIN=https://buildwithcombo.com
    FORMAL_ALIAS_ORIGIN=https://www.buildwithcombo.com
    LEGACY_WEB_PORT=30080
    UNITS=(
      combo-release-production-web-forward.service
      combo-release-production-minio-forward.service
    )
    PORTS=(18082 19002)
    ENV_FILES=(
      /etc/combo-release/production-web-forward.env
      ''
    )
    ;;
  *) usage ;;
esac
readonly NGINX_CONFIG NGINX_CONTRACT PUBLIC_ORIGIN S3_ORIGIN
readonly FORMAL_NGINX_CONFIG FORMAL_ORIGIN FORMAL_ALIAS_ORIGIN
readonly LEGACY_WEB_PORT

for command in sudo systemctl ss awk grep cmp install mktemp sha256sum curl jq node \
  realpath stat id sleep seq dirname wc chmod cp rm date kubectl flock mv; do
  command -v "$command" >/dev/null 2>&1 || fail "missing host command: $command"
done
[[ "$(id -un)" == xingzheng ]] || fail 'traffic control must run as xingzheng'
[[ -f "$MANIFEST" && ! -L "$MANIFEST" ]] || fail 'manifest is not a regular file'
[[ "$MANIFEST_DIGEST" =~ $DIGEST_RE ]] || fail 'invalid manifest digest'
[[ -n "$EVIDENCE_OUTPUT" && ! -e "$EVIDENCE_OUTPUT" ]] ||
  fail 'traffic evidence output must not already exist'
[[ -f "$SCRIPT_DIR/release-nginx-route.mjs" &&
  ! -L "$SCRIPT_DIR/release-nginx-route.mjs" ]] ||
  fail 'structured Nginx route controller is missing'

verified_digest=$(node "$SCRIPT_DIR/release-manifest.mjs" verify \
  --manifest "$MANIFEST" --digest "$MANIFEST_DIGEST")
[[ "$verified_digest" == "$MANIFEST_DIGEST" ]] ||
  fail 'manifest verifier returned another digest'
source_sha=$(jq -er '.sourceSha' "$MANIFEST")
release_id=$(jq -er '.releaseId' "$MANIFEST")
built_at=$(jq -er '.builtAt' "$MANIFEST")
web_asset_digest=$(jq -er '.webAssetManifest' "$MANIFEST")
[[ "$source_sha" =~ $SHA_RE && "$release_id" == "release-$source_sha" ]] ||
  fail 'manifest release identity is invalid'
release_prefix="release-${source_sha:0:12}-"
SERVICES=("${release_prefix}web" release-minio)
K=(kubectl --kubeconfig "$KUBECONFIG_PATH")

install -d -m 0750 "$(dirname "$EVIDENCE_OUTPUT")"
install -d -m 0750 "$TRAFFIC_STATE_ROOT" "$TRAFFIC_STATE_ROOT/$ENVIRONMENT"
install -d -m 0750 "$(dirname "$TRAFFIC_LOCK")"
sudo -n install -d -o root -g root -m 0700 \
  "$CHECKPOINT_ROOT" "$CHECKPOINT_ROOT/$ENVIRONMENT"
exec 8>"$TRAFFIC_LOCK"
flock -n 8 || fail 'another release traffic transaction is running'

work=$(mktemp -d)
nginx_backup="$work/nginx.before"
nginx_candidate="$work/nginx.candidate"
nginx_route_evidence="$work/nginx-route.json"
formal_nginx_backup="$work/formal-nginx.before"
formal_nginx_candidate="$work/formal-nginx.candidate"
formal_route_evidence="$work/formal-route.json"
current_state="$TRAFFIC_STATE_ROOT/$ENVIRONMENT/current.json"
checkpoint_directory="$CHECKPOINT_ROOT/$ENVIRONMENT/$release_id"
checkpoint_staging_directory="${checkpoint_directory}.staging"
checkpoint_created=0
checkpoint_reused=0
checkpoint_promoted_from_armed=0
transaction_armed=0
transaction_committed=0
traffic_state_changed=0
forwards_changed=0
current_state_existed=0
nginx_candidate_installed=0
formal_nginx_candidate_installed=0
declare -a UNIT_EXISTED UNIT_WAS_ACTIVE UNIT_WAS_ENABLED ENV_EXISTED
declare -a UNIT_SOURCE_SHA
previous_web_service=''
prior_source=''
prior_release=''
prior_manifest=''
checkpoint_digest=''
initial_formal_allowlist=false
RECOVERING_CHECKPOINT=0

current_matches_checkpoint_endpoint() {
  local checkpoint=$1
  jq -e \
    --slurpfile checkpoint "$checkpoint" '
      .schemaVersion == 1
      and .environment == $checkpoint[0].environment
      and (
        (
          .sourceSha == $checkpoint[0].previous.sourceSha
          and .releaseId == $checkpoint[0].previous.releaseId
          and .manifestDigest == $checkpoint[0].previous.manifestDigest
          and .canaryNginxSha256 == $checkpoint[0].previous.canaryNginxSha256
          and .formalNginxSha256 == $checkpoint[0].previous.formalNginxSha256
          and .webService == $checkpoint[0].previous.webService
        )
        or
        (
          .sourceSha == $checkpoint[0].sourceSha
          and .releaseId == $checkpoint[0].releaseId
          and .manifestDigest == $checkpoint[0].manifestDigest
          and .canaryNginxSha256 == $checkpoint[0].candidate.canaryNginxSha256
          and .formalNginxSha256 == $checkpoint[0].candidate.formalNginxSha256
          and .webService == $checkpoint[0].candidate.webService
        )
      )
    ' "$current_state" >/dev/null
}

resolve_previous_release_identity() {
  local legacy_current evidence_path evidence_real environment_root verified_prior
  local current_source recovery_checkpoint live_canary_sha live_formal_sha
  current_source=''
  if [[ -e "$current_state" ]]; then
    jq -e \
      --arg environment "$ENVIRONMENT" '
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
        and .environment == $environment
        and (.sourceSha | test("^[0-9a-f]{40}$"))
        and .releaseId == ("release-" + .sourceSha)
        and (.manifestDigest | test("^sha256:[0-9a-f]{64}$"))
        and (.canaryNginxSha256 | test("^sha256:[0-9a-f]{64}$"))
        and (
          if $environment == "preview" then
            .formalNginxSha256 == null
          else
            (.formalNginxSha256 | test("^sha256:[0-9a-f]{64}$"))
          end
        )
        and .webService == ("release-" + .sourceSha[0:12] + "-web")
      ' "$current_state" >/dev/null ||
      fail 'release traffic current state is invalid'
    current_source=$(jq -er '.sourceSha' "$current_state")
    if [[ "$current_source" == "$source_sha" ]]; then
      jq -e \
        --arg releaseId "$release_id" \
        --arg manifestDigest "$MANIFEST_DIGEST" \
        --arg webService "${SERVICES[0]}" '
          .releaseId == $releaseId
          and .manifestDigest == $manifestDigest
          and .webService == $webService
        ' "$current_state" >/dev/null ||
        fail 'candidate traffic state identifies another immutable release'
      sudo -n test -d "$checkpoint_directory" ||
        fail 'candidate traffic state lacks its rollback checkpoint'
    fi
    if ! sudo -n test -d "$checkpoint_directory"; then
      live_canary_sha=$(sha256sum "$nginx_backup" | awk '{print "sha256:" $1}')
      live_formal_sha=''
      if [[ -n "$FORMAL_NGINX_CONFIG" ]]; then
        live_formal_sha=$(sha256sum "$formal_nginx_backup" |
          awk '{print "sha256:" $1}')
      fi
      jq -e \
        --arg webService "$previous_web_service" \
        --arg canarySha "$live_canary_sha" \
        --arg formalSha "$live_formal_sha" '
          .webService == $webService
          and .canaryNginxSha256 == $canarySha
          and (
            if $formalSha == "" then
              .formalNginxSha256 == null
            else
              .formalNginxSha256 == $formalSha
            end
          )
        ' "$current_state" >/dev/null ||
        fail 'release traffic current state does not match the live route'
      prior_source=$current_source
      prior_release=$(jq -er '.releaseId' "$current_state")
      prior_manifest=$(jq -er '.manifestDigest' "$current_state")
      return
    fi
  elif ! sudo -n test -d "$checkpoint_directory"; then
    [[ -n "$previous_web_service" ]] || return
    current_source=''
  else
    current_source=''
  fi

  if sudo -n test -d "$checkpoint_directory"; then
    if ! sudo -n test ! -L "$checkpoint_directory" ||
      ! sudo -n test -f "$checkpoint_directory/checkpoint.json" ||
      ! sudo -n test ! -L "$checkpoint_directory/checkpoint.json"; then
      fail 'candidate traffic has an incomplete recovery checkpoint'
    fi
    recovery_checkpoint="$work/checkpoint.recovery.json"
    sudo -n cp -- "$checkpoint_directory/checkpoint.json" "$recovery_checkpoint"
    sudo -n chown "$(id -u):$(id -g)" "$recovery_checkpoint"
    chmod 0600 "$recovery_checkpoint"
    live_canary_sha=$(sha256sum "$nginx_backup" | awk '{print "sha256:" $1}')
    live_formal_sha=''
    if [[ -n "$FORMAL_NGINX_CONFIG" ]]; then
      live_formal_sha=$(sha256sum "$formal_nginx_backup" |
        awk '{print "sha256:" $1}')
    fi
    if jq -e \
      --arg environment "$ENVIRONMENT" \
      --arg sourceSha "$source_sha" \
      --arg releaseId "$release_id" \
      --arg manifestDigest "$MANIFEST_DIGEST" \
      --arg liveWebService "$previous_web_service" \
      --arg canarySha "$live_canary_sha" \
      --arg formalSha "$live_formal_sha" '
        .schemaVersion == 1
        and .status == "armed"
        and .environment == $environment
        and .sourceSha == $sourceSha
        and .releaseId == $releaseId
        and .manifestDigest == $manifestDigest
        and .previous.canaryNginxSha256 == $canarySha
        and (
          if $formalSha == "" then
            .previous.formalNginxSha256 == null
          else
            .previous.formalNginxSha256 == $formalSha
          end
        )
        and (
          if .previous.webService == null then
            $liveWebService == ""
          else
            .previous.webService == $liveWebService
          end
        )
      ' "$recovery_checkpoint" >/dev/null; then
      if [[ -n "$current_source" ]]; then
        current_matches_checkpoint_endpoint "$recovery_checkpoint" ||
          fail 'armed traffic checkpoint endpoint state changed'
      else
        jq -e '
          .previous.sourceSha == null
          and .previous.releaseId == null
          and .previous.manifestDigest == null
          and .previous.webService == null
        ' "$recovery_checkpoint" >/dev/null ||
          fail 'armed traffic checkpoint lost its predecessor state'
      fi
      prior_source=$(jq -r '.previous.sourceSha // ""' "$recovery_checkpoint")
      prior_release=$(jq -r '.previous.releaseId // ""' "$recovery_checkpoint")
      prior_manifest=$(jq -r '.previous.manifestDigest // ""' "$recovery_checkpoint")
      initial_formal_allowlist=$(jq -r '.initialFormalAllowlist' "$recovery_checkpoint")
      [[ "$initial_formal_allowlist" == true ||
        "$initial_formal_allowlist" == false ]] ||
        fail 'armed checkpoint formal allowlist marker is invalid'
      return
    fi
    jq -e \
      --arg environment "$ENVIRONMENT" \
      --arg sourceSha "$source_sha" \
      --arg releaseId "$release_id" \
      --arg manifestDigest "$MANIFEST_DIGEST" \
      --arg webService "${SERVICES[0]}" \
      --arg liveWebService "$previous_web_service" \
      --arg canarySha "$live_canary_sha" \
      --arg formalSha "$live_formal_sha" '
        .schemaVersion == 1
        and (.status == "armed" or .status == "activated")
        and .environment == $environment
        and .sourceSha == $sourceSha
        and .releaseId == $releaseId
        and .manifestDigest == $manifestDigest
        and .candidate.webService == $webService
        and (
          .previous.webService == $liveWebService
          or .candidate.webService == $liveWebService
          or (.previous.webService == null and $liveWebService == "")
        )
        and (
          .previous.canaryNginxSha256 == $canarySha
          or .candidate.canaryNginxSha256 == $canarySha
        )
        and (
          if $formalSha == "" then
            .candidate.formalNginxSha256 == null
          else
            .previous.formalNginxSha256 == $formalSha
            or .candidate.formalNginxSha256 == $formalSha
          end
        )
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
            and .previous.webService ==
              ("release-" + .previous.sourceSha[0:12] + "-web")
          )
        )
      ' "$recovery_checkpoint" >/dev/null ||
      fail 'interrupted traffic components do not match either checkpoint endpoint'
    if [[ -n "$current_source" ]]; then
      current_matches_checkpoint_endpoint "$recovery_checkpoint" ||
        fail 'traffic state is not a checkpointed endpoint during activation recovery'
    else
      jq -e '
        .previous.sourceSha == null
        and .previous.releaseId == null
        and .previous.manifestDigest == null
        and .previous.webService == null
      ' "$recovery_checkpoint" >/dev/null ||
        fail 'missing traffic state does not match the checkpointed predecessor'
    fi
    if [[ "$current_source" == "$source_sha" &&
      "$previous_web_service" == "${SERVICES[0]}" &&
      "$live_canary_sha" == \
        "$(jq -er '.candidate.canaryNginxSha256' "$recovery_checkpoint")" ]] &&
      {
        [[ -z "$FORMAL_NGINX_CONFIG" ]] ||
          [[ "$live_formal_sha" == \
            "$(jq -er '.candidate.formalNginxSha256' "$recovery_checkpoint")" ]]
      }; then
      prior_source=$source_sha
      prior_release=$release_id
      prior_manifest=$MANIFEST_DIGEST
      initial_formal_allowlist=$(jq -r '.initialFormalAllowlist' \
        "$recovery_checkpoint")
      return
    fi
    prior_source=$(jq -r '.previous.sourceSha // ""' "$recovery_checkpoint")
    prior_release=$(jq -r '.previous.releaseId // ""' "$recovery_checkpoint")
    prior_manifest=$(jq -r '.previous.manifestDigest // ""' "$recovery_checkpoint")
    previous_web_service=$(jq -r '.previous.webService // ""' "$recovery_checkpoint")
    initial_formal_allowlist=$(jq -r '.initialFormalAllowlist' "$recovery_checkpoint")
    [[ "$initial_formal_allowlist" == true ||
      "$initial_formal_allowlist" == false ]] ||
      fail 'recovery checkpoint formal allowlist marker is invalid'
    RECOVERING_CHECKPOINT=1
    return
  fi

  legacy_current="$RELEASE_EVIDENCE_ROOT/$ENVIRONMENT/current.json"
  [[ -f "$legacy_current" && ! -L "$legacy_current" ]] ||
    fail 'the existing release forward lacks a trusted release checkpoint'
  jq -e \
    --arg environment "$ENVIRONMENT" \
    --arg namespace "$NAMESPACE" '
      .schemaVersion == 1
      and .status == "passed"
      and .environment == $environment
      and .namespace == $namespace
      and (.sourceSha | type == "string" and test("^[0-9a-f]{40}$"))
      and .releaseId == ("release-" + .sourceSha)
      and (.manifestDigest | type == "string" and test("^sha256:[0-9a-f]{64}$"))
      and (.evidencePath | type == "string" and length > 0)
    ' "$legacy_current" >/dev/null ||
    fail 'the existing release checkpoint is invalid'
  prior_source=$(jq -er '.sourceSha' "$legacy_current")
  prior_release=$(jq -er '.releaseId' "$legacy_current")
  prior_manifest=$(jq -er '.manifestDigest' "$legacy_current")
  [[ "$previous_web_service" == "release-${prior_source:0:12}-web" ]] ||
    fail 'the existing Web forward and trusted release checkpoint disagree'
  evidence_path=$(jq -er '.evidencePath' "$legacy_current")
  environment_root=$(realpath -e "$RELEASE_EVIDENCE_ROOT/$ENVIRONMENT")
  evidence_real=$(realpath -e "$evidence_path")
  [[ "$evidence_real" == "$environment_root/$prior_release" &&
    -d "$evidence_real" && ! -L "$evidence_path" ]] ||
    fail 'the existing release evidence path escaped its allowlist'
  for file in release.json release.sha256 deploy-evidence.json SHA256SUMS; do
    [[ -f "$evidence_real/$file" && ! -L "$evidence_real/$file" ]] ||
      fail "the existing release evidence lacks $file"
  done
  (
    cd "$evidence_real"
    sha256sum --quiet -c SHA256SUMS
  ) || fail 'the existing release evidence digest set changed'
  [[ "$(tr -d '\n' <"$evidence_real/release.sha256")" == "$prior_manifest" ]] ||
    fail 'the existing release manifest digest changed'
  verified_prior=$(node "$SCRIPT_DIR/release-manifest.mjs" verify \
    --manifest "$evidence_real/release.json" --digest "$prior_manifest")
  [[ "$verified_prior" == "$prior_manifest" ]] ||
    fail 'the existing release manifest no longer verifies'
  jq -e \
    --arg sourceSha "$prior_source" \
    --arg releaseId "$prior_release" \
    --arg manifestDigest "$prior_manifest" '
      .schemaVersion == 1
      and .status == "passed"
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
    ' "$evidence_real/deploy-evidence.json" >/dev/null ||
    fail 'the existing release deploy evidence does not match its checkpoint'
  "${K[@]}" -n "$NAMESPACE" get "deployment/$previous_web_service" -o json |
    jq -e \
      --arg sourceSha "$prior_source" \
      --arg releaseId "$prior_release" '
        .spec.template.metadata.annotations["combo.build/source-sha"] == $sourceSha
        and .spec.template.metadata.annotations["combo.build/release-id"] == $releaseId
      ' >/dev/null ||
    fail 'the existing Web Deployment does not match its trusted release evidence'
  "${K[@]}" -n "$NAMESPACE" get "service/$previous_web_service" -o json |
    jq -e --arg service "$previous_web_service" '
      .spec.selector == {
        app: $service,
        "combo.build/release-track": "release-v1"
      }
    ' >/dev/null ||
    fail 'the existing Web Service selector is not release-isolated'
}

prepare_route_candidate() {
  node "$SCRIPT_DIR/release-nginx-route.mjs" rewrite \
    --input "$nginx_backup" \
    --output "$nginx_candidate" \
    --contract "$NGINX_CONTRACT" \
    --target release >"$nginx_route_evidence"
  chmod 0600 "$nginx_route_evidence"

  if [[ -z "$FORMAL_NGINX_CONFIG" ]]; then
    : >"$formal_route_evidence"
    chmod 0600 "$formal_route_evidence"
    if ((RECOVERING_CHECKPOINT == 1)); then
      jq -e \
        --arg beforeSha "$(jq -er '.beforeSha256' "$nginx_route_evidence")" \
        --arg afterSha "$(jq -er '.afterSha256' "$nginx_route_evidence")" \
        --arg beforeMode "$(jq -er '.beforeMode' "$nginx_route_evidence")" '
          .candidate.canaryNginxSha256 == $afterSha
          and .candidate.formalNginxSha256 == null
          and (
            (
              .previous.canaryNginxSha256 == $beforeSha
              and .previous.canaryMode == $beforeMode
            )
            or
            (
              .candidate.canaryNginxSha256 == $beforeSha
              and $beforeMode == "release"
            )
          )
        ' "$work/checkpoint.recovery.json" >/dev/null ||
        fail 'live candidate route changed during checkpoint recovery'
    fi
    return
  fi
  node "$SCRIPT_DIR/release-nginx-route.mjs" rewrite \
    --input "$formal_nginx_backup" \
    --output "$formal_nginx_candidate" \
    --contract production-formal \
    --target release >"$formal_route_evidence"
  chmod 0600 "$formal_route_evidence"

  local formal_before canary_before active_service
  formal_before=$(jq -er '.beforeSha256' "$formal_route_evidence")
  canary_before=$(jq -er '.beforeSha256' "$nginx_route_evidence")
  if ((RECOVERING_CHECKPOINT == 1)); then
    jq -e \
      --arg canaryBeforeSha "$canary_before" \
      --arg canaryAfterSha "$(jq -er '.afterSha256' "$nginx_route_evidence")" \
      --arg canaryBeforeMode "$(jq -er '.beforeMode' "$nginx_route_evidence")" \
      --arg formalBeforeSha "$formal_before" \
      --arg formalAfterSha "$(jq -er '.afterSha256' "$formal_route_evidence")" \
      --arg formalBeforeMode "$(jq -er '.beforeMode' "$formal_route_evidence")" '
        .candidate.canaryNginxSha256 == $canaryAfterSha
        and .candidate.formalNginxSha256 == $formalAfterSha
        and (
          (
            .previous.canaryNginxSha256 == $canaryBeforeSha
            and .previous.canaryMode == $canaryBeforeMode
          )
          or
          (
            .candidate.canaryNginxSha256 == $canaryBeforeSha
            and $canaryBeforeMode == "release"
          )
        )
        and (
          (
            .previous.formalNginxSha256 == $formalBeforeSha
            and .previous.formalMode == $formalBeforeMode
          )
          or
          (
            .candidate.formalNginxSha256 == $formalBeforeSha
            and $formalBeforeMode == "release"
          )
        )
      ' "$work/checkpoint.recovery.json" >/dev/null ||
      fail 'interrupted Nginx routes are outside their checkpoint endpoints'
    return
  fi
  if [[ -e "$current_state" ]]; then
    [[ -f "$current_state" && ! -L "$current_state" ]] ||
      fail 'release traffic current state is not a regular file'
    jq -e \
      --arg environment "$ENVIRONMENT" \
      --arg canarySha "$canary_before" \
      --arg formalSha "$formal_before" \
      --arg webService "$previous_web_service" '
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
        and .environment == $environment
        and (.sourceSha | type == "string" and test("^[0-9a-f]{40}$"))
        and .releaseId == ("release-" + .sourceSha)
        and (.manifestDigest | type == "string" and test("^sha256:[0-9a-f]{64}$"))
        and .canaryNginxSha256 == $canarySha
        and .formalNginxSha256 == $formalSha
        and .webService == $webService
      ' "$current_state" >/dev/null ||
      fail 'formal Production route changed outside its persisted CAS state'
    active_service=$(jq -er '.webService' "$current_state")
    [[ "$active_service" == "$previous_web_service" ]] ||
      fail 'formal Production forward target changed outside its persisted CAS state'
  else
    [[ "$formal_before" == "$FORMAL_INITIAL_SHA256" ]] ||
      fail 'formal Production Nginx does not match the initial checksum allowlist'
    [[ "$(jq -er '.beforeMode' "$formal_route_evidence")" == legacy ]] ||
      fail 'the initial formal Production route is not on the allowlisted legacy port'
    initial_formal_allowlist=true
  fi
}

validate_reused_rollback_checkpoint() {
  local checkpoint=$work/checkpoint.persisted.json backup_name backup_digest
  local index unit existed previous_source previous_release previous_service
  local previous_deployment="$work/reused-previous-deployment.json"
  jq -e \
    --arg environment "$ENVIRONMENT" \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg webService "${SERVICES[0]}" \
    --arg webUnit "${UNITS[0]}" \
    --arg minioUnit "${UNITS[1]}" \
    --arg canarySha "$(jq -er '.afterSha256' "$nginx_route_evidence")" \
    --arg formalSha "$(
      if [[ -s "$formal_route_evidence" ]]; then
        jq -er '.afterSha256' "$formal_route_evidence"
      fi
    )" '
      keys == [
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
      and .schemaVersion == 1
      and (.status == "armed" or .status == "activated")
      and .environment == $environment
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and .candidate.webService == $webService
      and .candidate.canaryNginxSha256 == $canarySha
      and (
        if $formalSha == "" then
          .candidate.formalNginxSha256 == null
        else
          .candidate.formalNginxSha256 == $formalSha
        end
      )
      and (.initialFormalAllowlist | type == "boolean")
      and (.armedAt | type == "string" and length > 0)
      and (
        (.status == "armed" and .activatedAt == null)
        or
        (.status == "activated"
          and (.activatedAt | type == "string" and length > 0))
      )
      and (.previous.canaryMode == "legacy" or .previous.canaryMode == "release")
      and (.previous.formalMode == null
        or .previous.formalMode == "legacy"
        or .previous.formalMode == "release")
      and (.previous.canaryNginxSha256 | test("^sha256:[0-9a-f]{64}$"))
      and (.previous.formalNginxSha256 == null
        or (.previous.formalNginxSha256 | test("^sha256:[0-9a-f]{64}$")))
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
      and .previous.files.canaryNginx.name == "nginx-canary.before"
      and (.previous.files.canaryNginx.sha256 | test("^sha256:[0-9a-f]{64}$"))
      and (
        if $formalSha == "" then
          .previous.files.formalNginx == null
        else
          .previous.files.formalNginx.name == "nginx-formal.before"
          and (.previous.files.formalNginx.sha256 | test("^sha256:[0-9a-f]{64}$"))
        end
      )
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
    fail 'the reused rollback checkpoint contract changed'

  backup_name=nginx-canary.before
  backup_digest=$(jq -er '.previous.files.canaryNginx.sha256' "$checkpoint")
  if ! sudo -n test -f "$checkpoint_directory/$backup_name" ||
    ! sudo -n test ! -L "$checkpoint_directory/$backup_name"; then
    fail "the reused rollback backup is unavailable: $backup_name"
  fi
  [[ "$(sudo -n sha256sum "$checkpoint_directory/$backup_name" |
    awk '{print "sha256:" $1}')" == "$backup_digest" ]] ||
    fail "the reused rollback backup changed: $backup_name"

  if jq -e '.previous.files.formalNginx != null' "$checkpoint" >/dev/null; then
    backup_name=nginx-formal.before
    backup_digest=$(jq -er '.previous.files.formalNginx.sha256' "$checkpoint")
    if ! sudo -n test -f "$checkpoint_directory/$backup_name" ||
      ! sudo -n test ! -L "$checkpoint_directory/$backup_name"; then
      fail "the reused rollback backup is unavailable: $backup_name"
    fi
    [[ "$(sudo -n sha256sum "$checkpoint_directory/$backup_name" |
      awk '{print "sha256:" $1}')" == "$backup_digest" ]] ||
      fail "the reused rollback backup changed: $backup_name"
  fi
  if jq -e '.previous.files.webEnvironment != null' "$checkpoint" >/dev/null; then
    backup_name=web-env.before
    backup_digest=$(jq -er '.previous.files.webEnvironment.sha256' "$checkpoint")
    if ! sudo -n test -f "$checkpoint_directory/$backup_name" ||
      ! sudo -n test ! -L "$checkpoint_directory/$backup_name"; then
      fail "the reused rollback backup is unavailable: $backup_name"
    fi
    [[ "$(sudo -n sha256sum "$checkpoint_directory/$backup_name" |
      awk '{print "sha256:" $1}')" == "$backup_digest" ]] ||
      fail "the reused rollback backup changed: $backup_name"
  fi
  for index in "${!UNITS[@]}"; do
    unit=${UNITS[$index]}
    existed=$(jq -r ".previous.units[$index].existed" "$checkpoint")
    if [[ "$existed" == true ]]; then
      backup_name=$(jq -er ".previous.units[$index].backupFile" "$checkpoint")
      [[ "$backup_name" == "unit-$index.before" ]] ||
        fail "the reused rollback unit backup name changed: $unit"
      backup_digest=$(jq -er ".previous.units[$index].sha256" "$checkpoint")
      if ! sudo -n test -f "$checkpoint_directory/$backup_name" ||
        ! sudo -n test ! -L "$checkpoint_directory/$backup_name"; then
        fail "the reused rollback unit backup is unavailable: $unit"
      fi
      [[ "$(sudo -n sha256sum "$checkpoint_directory/$backup_name" |
        awk '{print "sha256:" $1}')" == "$backup_digest" ]] ||
        fail "the reused rollback unit backup changed: $unit"
    else
      sudo -n test ! -e "$checkpoint_directory/unit-$index.before" ||
        fail "the reused rollback checkpoint has an unexpected unit backup: $unit"
    fi
  done

  previous_source=$(jq -r '.previous.sourceSha // ""' "$checkpoint")
  previous_release=$(jq -r '.previous.releaseId // ""' "$checkpoint")
  previous_service=$(jq -r '.previous.webService // ""' "$checkpoint")
  if [[ -n "$previous_source" ]]; then
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
      fail 'the previous release is no longer rollback-ready'
    "${K[@]}" -n "$NAMESPACE" get "service/$previous_service" -o json |
      jq -e --arg service "$previous_service" '
        .spec.selector == {
          app: $service,
          "combo.build/release-track": "release-v1"
        }
      ' >/dev/null ||
      fail 'the previous release Service is no longer rollback-ready'
  else
    curl --fail --silent --show-error --max-time 10 \
      "http://127.0.0.1:$LEGACY_WEB_PORT/" >/dev/null ||
      fail 'the legacy release is no longer rollback-ready'
  fi
}

persist_rollback_checkpoint() {
  local stage units_json="$work/checkpoint-units.jsonl" index unit backup_name=''
  local checkpoint_status
  if sudo -n test -e "$checkpoint_staging_directory"; then
    if ! sudo -n test -d "$checkpoint_staging_directory" ||
      ! sudo -n test ! -L "$checkpoint_staging_directory"; then
      fail 'stale rollback checkpoint staging path is unsafe'
    fi
    sudo -n rm -rf -- "$checkpoint_staging_directory"
  fi
  if ! sudo -n test ! -e "$checkpoint_directory"; then
    sudo -n test -f "$checkpoint_directory/checkpoint.json" ||
      fail 'the existing rollback checkpoint is incomplete'
    sudo -n test ! -L "$checkpoint_directory/checkpoint.json" ||
      fail 'the existing rollback checkpoint must not be a symlink'
    sudo -n cp -- "$checkpoint_directory/checkpoint.json" \
      "$work/checkpoint.persisted.json"
    sudo -n chown "$(id -u):$(id -g)" "$work/checkpoint.persisted.json"
    chmod 0600 "$work/checkpoint.persisted.json"
    jq -e \
      --arg environment "$ENVIRONMENT" \
      --arg sourceSha "$source_sha" \
      --arg releaseId "$release_id" \
      --arg manifestDigest "$MANIFEST_DIGEST" \
      --arg webService "${SERVICES[0]}" \
      --arg canarySha "$(jq -er '.afterSha256' "$nginx_route_evidence")" \
      --arg formalSha "$(
        if [[ -s "$formal_route_evidence" ]]; then
          jq -er '.afterSha256' "$formal_route_evidence"
        fi
      )" '
        .schemaVersion == 1
        and (.status == "armed" or .status == "activated")
        and .environment == $environment
        and .sourceSha == $sourceSha
        and .releaseId == $releaseId
        and .manifestDigest == $manifestDigest
        and .candidate.webService == $webService
        and .candidate.canaryNginxSha256 == $canarySha
        and (
          if $formalSha == "" then
            .candidate.formalNginxSha256 == null
          else
            .candidate.formalNginxSha256 == $formalSha
          end
        )
      ' "$work/checkpoint.persisted.json" >/dev/null ||
      fail 'another rollback checkpoint already exists for this release'
    validate_reused_rollback_checkpoint
    checkpoint_digest=$(sha256sum "$work/checkpoint.persisted.json" |
      awk '{print "sha256:" $1}')
    checkpoint_status=$(jq -er '.status' "$work/checkpoint.persisted.json")
    if [[ "$checkpoint_status" == activated ]]; then
      checkpoint_reused=1
    else
      checkpoint_reused=0
      checkpoint_promoted_from_armed=1
    fi
    return
  fi
  stage=$(mktemp -d "$work/checkpoint.XXXXXX")
  chmod 0700 "$stage"
  install -m 0600 "$nginx_backup" "$stage/nginx-canary.before"
  if [[ -n "$FORMAL_NGINX_CONFIG" ]]; then
    install -m 0600 "$formal_nginx_backup" "$stage/nginx-formal.before"
  fi
  if [[ "${ENV_EXISTED[0]}" == 1 ]]; then
    install -m 0600 "$work/env-0.before" "$stage/web-env.before"
  fi
  : >"$units_json"
  for index in "${!UNITS[@]}"; do
    unit=${UNITS[$index]}
    backup_name=''
    if [[ "${UNIT_EXISTED[$index]}" == 1 ]]; then
      backup_name="unit-$index.before"
      install -m 0600 "$work/unit-$index.before" "$stage/$backup_name"
    fi
    jq -cn \
      --arg name "$unit" \
      --arg backupFile "$backup_name" \
      --arg sha256 "${UNIT_SOURCE_SHA[$index]}" \
      --argjson existed "${UNIT_EXISTED[$index]}" \
      --argjson active "${UNIT_WAS_ACTIVE[$index]}" \
      --argjson enabled "${UNIT_WAS_ENABLED[$index]}" '{
        name: $name,
        existed: ($existed == 1),
        active: ($active == 1),
        enabled: ($enabled == 1),
        sha256: $sha256,
        backupFile: (if $backupFile == "" then null else $backupFile end)
      }' >>"$units_json"
  done
  jq -n \
    --arg environment "$ENVIRONMENT" \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg priorSourceSha "$prior_source" \
    --arg priorReleaseId "$prior_release" \
    --arg priorManifestDigest "$prior_manifest" \
    --arg priorWebService "$previous_web_service" \
    --arg candidateWebService "${SERVICES[0]}" \
    --arg canaryBackupSha "$(sha256sum "$stage/nginx-canary.before" |
      awk '{print "sha256:" $1}')" \
    --arg formalBackupSha "$(
      if [[ -f "$stage/nginx-formal.before" ]]; then
        sha256sum "$stage/nginx-formal.before" | awk '{print "sha256:" $1}'
      fi
    )" \
    --arg webEnvBackupSha "$(
      if [[ -f "$stage/web-env.before" ]]; then
        sha256sum "$stage/web-env.before" | awk '{print "sha256:" $1}'
      fi
    )" \
    --arg armedAt "$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')" \
    --argjson initialFormalAllowlist "$initial_formal_allowlist" \
    --slurpfile canary "$nginx_route_evidence" \
    --slurpfile formal "$formal_route_evidence" \
    --slurpfile units "$units_json" '{
      schemaVersion: 1,
      status: "armed",
      environment: $environment,
      sourceSha: $sourceSha,
      releaseId: $releaseId,
      manifestDigest: $manifestDigest,
      previous: {
        sourceSha: (if $priorSourceSha == "" then null else $priorSourceSha end),
        releaseId: (if $priorReleaseId == "" then null else $priorReleaseId end),
        manifestDigest: (if $priorManifestDigest == "" then null else $priorManifestDigest end),
        webService: (if $priorWebService == "" then null else $priorWebService end),
        canaryMode: $canary[0].beforeMode,
        canaryNginxSha256: $canary[0].beforeSha256,
        formalMode: (if ($formal | length) == 0 then null else $formal[0].beforeMode end),
        formalNginxSha256:
          (if ($formal | length) == 0 then null else $formal[0].beforeSha256 end),
        files: {
          canaryNginx: {
            name: "nginx-canary.before",
            sha256: $canaryBackupSha
          },
          formalNginx: (if $formalBackupSha == "" then null else {
            name: "nginx-formal.before",
            sha256: $formalBackupSha
          } end),
          webEnvironment: (if $webEnvBackupSha == "" then null else {
            name: "web-env.before",
            sha256: $webEnvBackupSha
          } end)
        },
        units: $units
      },
      candidate: {
        webService: $candidateWebService,
        canaryNginxSha256: $canary[0].afterSha256,
        formalNginxSha256:
          (if ($formal | length) == 0 then null else $formal[0].afterSha256 end)
      },
      initialFormalAllowlist: $initialFormalAllowlist,
      armedAt: $armedAt,
      activatedAt: null
    }' >"$stage/checkpoint.json"
  chmod 0600 "$stage/checkpoint.json"
  install -m 0600 "$stage/checkpoint.json" "$work/checkpoint.persisted.json"
  sudo -n install -d -o root -g root -m 0700 "$checkpoint_staging_directory"
  for backup_name in nginx-canary.before nginx-formal.before web-env.before \
    unit-0.before unit-1.before; do
    [[ ! -f "$stage/$backup_name" ]] ||
      sudo -n install -o root -g root -m 0600 \
        "$stage/$backup_name" "$checkpoint_staging_directory/$backup_name"
  done
  sudo -n install -o root -g root -m 0600 \
    "$stage/checkpoint.json" "$checkpoint_staging_directory/checkpoint.json"
  for backup_name in checkpoint.json nginx-canary.before nginx-formal.before \
    web-env.before unit-0.before unit-1.before; do
    [[ ! -f "$stage/$backup_name" ]] ||
      [[ "$(sudo -n sha256sum "$checkpoint_staging_directory/$backup_name" |
        awk '{print "sha256:" $1}')" == \
        "$(sha256sum "$stage/$backup_name" | awk '{print "sha256:" $1}')" ]] ||
      fail "staged rollback checkpoint file changed: $backup_name"
  done
  sudo -n test ! -e "$checkpoint_directory" ||
    fail 'rollback checkpoint appeared before atomic publication'
  sudo -n mv -T "$checkpoint_staging_directory" "$checkpoint_directory"
  checkpoint_created=1
  checkpoint_digest=$(sha256sum "$stage/checkpoint.json" | awk '{print "sha256:" $1}')
}

commit_traffic_state() {
  local canary_sha formal_sha='' live_service checkpoint_stage current_stage
  canary_sha=$(sudo -n sha256sum "$NGINX_CONFIG" | awk '{print "sha256:" $1}')
  [[ "$canary_sha" == "$(jq -er '.afterSha256' "$nginx_route_evidence")" ]] ||
    fail 'canary Nginx changed after its route CAS'
  if [[ -n "$FORMAL_NGINX_CONFIG" ]]; then
    formal_sha=$(sudo -n sha256sum "$FORMAL_NGINX_CONFIG" | awk '{print "sha256:" $1}')
    [[ "$formal_sha" == "$(jq -er '.afterSha256' "$formal_route_evidence")" ]] ||
      fail 'formal Production Nginx changed after its route CAS'
  fi
  live_service=$(sudo -n awk -F= '
    $1 == "COMBO_RELEASE_WEB_SERVICE" {print $2}
  ' "${ENV_FILES[0]}")
  [[ "$live_service" == "${SERVICES[0]}" ]] ||
    fail 'release Web forward changed before traffic state commit'

  if ((checkpoint_reused == 0)); then
    checkpoint_stage=$(mktemp "$work/checkpoint.activated.XXXXXX")
    jq --arg activatedAt "$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')" '
      .status = "activated"
      | .activatedAt = $activatedAt
    ' "$work/checkpoint.persisted.json" >"$checkpoint_stage"
    chmod 0600 "$checkpoint_stage"
    atomic_root_install "$checkpoint_stage" \
      "$checkpoint_directory/checkpoint.json" 0600
    checkpoint_digest=$(sha256sum "$checkpoint_stage" | awk '{print "sha256:" $1}')
  fi

  current_stage=$(mktemp "$TRAFFIC_STATE_ROOT/$ENVIRONMENT/.current.XXXXXX")
  jq -n \
    --arg environment "$ENVIRONMENT" \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg canarySha "$canary_sha" \
    --arg formalSha "$formal_sha" \
    --arg webService "$live_service" '{
      schemaVersion: 1,
      environment: $environment,
      sourceSha: $sourceSha,
      releaseId: $releaseId,
      manifestDigest: $manifestDigest,
      canaryNginxSha256: $canarySha,
      formalNginxSha256: (if $formalSha == "" then null else $formalSha end),
      webService: $webService
    }' >"$current_stage"
  chmod 0600 "$current_stage"
  mv -fT "$current_stage" "$current_state"
  traffic_state_changed=1
}

listener_lines() {
  sudo -n ss -H -lntp "( sport = :$1 )"
}

rollback_forwards() {
  local index unit env_file rollback_ok=1
  status 'restoring the previous loopback forward transaction'
  for index in "${!UNITS[@]}"; do
    unit=${UNITS[$index]}
    sudo -n systemctl stop "$unit" >/dev/null 2>&1 || rollback_ok=0
    if [[ "${UNIT_EXISTED[$index]}" == 1 ]]; then
      (atomic_root_install "$work/unit-$index.before" \
        "/etc/systemd/system/$unit" 0644) || rollback_ok=0
    else
      sudo -n rm -f -- "/etc/systemd/system/$unit" || rollback_ok=0
    fi
    env_file=${ENV_FILES[$index]}
    if [[ -n "$env_file" ]]; then
      if [[ "${ENV_EXISTED[$index]}" == 1 ]]; then
        (atomic_root_install "$work/env-$index.before" "$env_file" 0644) ||
          rollback_ok=0
      else
        sudo -n rm -f -- "$env_file" || rollback_ok=0
      fi
    fi
  done
  sudo -n systemctl daemon-reload >/dev/null 2>&1 || rollback_ok=0
  for index in "${!UNITS[@]}"; do
    unit=${UNITS[$index]}
    if [[ "${UNIT_WAS_ENABLED[$index]}" == 1 ]]; then
      sudo -n systemctl enable "$unit" >/dev/null 2>&1 || rollback_ok=0
    else
      sudo -n systemctl disable "$unit" >/dev/null 2>&1 || rollback_ok=0
    fi
    if [[ "${UNIT_WAS_ACTIVE[$index]}" == 1 ]]; then
      sudo -n systemctl restart "$unit" >/dev/null 2>&1 || rollback_ok=0
    fi
  done
  ((rollback_ok == 1))
}

rollback_nginx() {
  status 'restoring the previous host Nginx configuration'
  (atomic_root_install "$nginx_backup" "$NGINX_CONFIG" 0644) || return
  if [[ -n "$FORMAL_NGINX_CONFIG" && -f "$formal_nginx_backup" ]]; then
    (atomic_root_install "$formal_nginx_backup" "$FORMAL_NGINX_CONFIG" 0644) || return
  fi
  sudo -n nginx -t >/dev/null || return
  sudo -n systemctl reload nginx || return
}

cleanup() {
  local rc=$? compensation_ok=1
  trap - EXIT
  if ((rc != 0 && transaction_armed == 1 && transaction_committed == 0)); then
    if ((forwards_changed == 1)); then
      rollback_forwards || compensation_ok=0
    fi
    if ((nginx_candidate_installed == 1 || formal_nginx_candidate_installed == 1)); then
      rollback_nginx || compensation_ok=0
    fi
    if ((traffic_state_changed == 1)); then
      if ((current_state_existed == 1)); then
        (atomic_user_install "$work/current.before" "$current_state" 0600) ||
          compensation_ok=0
      else
        rm -f -- "$current_state" || compensation_ok=0
      fi
    fi
    if ((checkpoint_promoted_from_armed == 1)); then
      (atomic_root_install "$work/checkpoint.persisted.json" \
        "$checkpoint_directory/checkpoint.json" 0600) || compensation_ok=0
    fi
    if ((checkpoint_created == 1 && compensation_ok == 1)); then
      sudo -n rm -rf -- "$checkpoint_directory" || compensation_ok=0
    fi
    if ((compensation_ok == 0)); then
      status 'compensation was incomplete; preserving the rollback checkpoint for retry'
    fi
  fi
  if sudo -n test -e "$checkpoint_staging_directory"; then
    if sudo -n test -d "$checkpoint_staging_directory" &&
      sudo -n test ! -L "$checkpoint_staging_directory"; then
      sudo -n rm -rf -- "$checkpoint_staging_directory" || true
    fi
  fi
  rm -rf -- "$work"
  exit "$rc"
}
trap cleanup EXIT

host_unit_root_real=$(realpath -e "$HOST_UNIT_ROOT")
for index in "${!UNITS[@]}"; do
  unit=${UNITS[$index]}
  source_unit="$HOST_UNIT_ROOT/$unit"
  source_unit_real=$(realpath -e "$source_unit")
  [[ "$source_unit_real" == "$host_unit_root_real/$unit" && -f "$source_unit_real" &&
    ! -L "$source_unit" ]] || fail "unit source escaped the release host contract: $unit"
  UNIT_SOURCE_SHA[index]=$(sha256sum "$source_unit_real" | awk '{print "sha256:" $1}')
  if sudo -n test -f "/etc/systemd/system/$unit"; then
    sudo -n test ! -L "/etc/systemd/system/$unit" ||
      fail "$unit must not be a symlink"
    UNIT_EXISTED[index]=1
    sudo -n cp -- "/etc/systemd/system/$unit" "$work/unit-$index.before"
    sudo -n chown "$(id -u):$(id -g)" "$work/unit-$index.before"
    chmod 0600 "$work/unit-$index.before"
    installed_unit_sha=$(sha256sum "$work/unit-$index.before" |
      awk '{print "sha256:" $1}')
    [[ "$installed_unit_sha" == "${UNIT_SOURCE_SHA[$index]}" ]] ||
      fail "$unit differs from its versioned allowlist"
  else
    UNIT_EXISTED[index]=0
  fi
  if sudo -n systemctl is-active --quiet "$unit"; then
    UNIT_WAS_ACTIVE[index]=1
  else
    UNIT_WAS_ACTIVE[index]=0
  fi
  if sudo -n systemctl is-enabled --quiet "$unit"; then
    UNIT_WAS_ENABLED[index]=1
  else
    UNIT_WAS_ENABLED[index]=0
  fi
  env_file=${ENV_FILES[$index]}
  if [[ -n "$env_file" ]] && sudo -n test -f "$env_file"; then
    sudo -n test ! -L "$env_file" ||
      fail "$unit environment must not be a symlink"
    ENV_EXISTED[index]=1
    sudo -n cp -- "$env_file" "$work/env-$index.before"
    sudo -n chown "$(id -u):$(id -g)" "$work/env-$index.before"
    chmod 0600 "$work/env-$index.before"
    [[ "$(wc -l <"$work/env-$index.before")" == 1 ]] ||
      fail "$unit environment contains unapproved fields"
    if ((index == 0)); then
      previous_web_service=$(awk -F= '
        $1 == "COMBO_RELEASE_WEB_SERVICE" {print $2}
      ' "$work/env-$index.before")
      [[ "$previous_web_service" =~ ^release-[0-9a-f]{12}-web$ ]] ||
        fail "$unit environment target is invalid"
    else
      fail "$unit must not use an environment file"
    fi
  else
    ENV_EXISTED[index]=0
  fi
done

sudo -n test -f "$NGINX_CONFIG" || fail 'expected host Nginx config is missing'
sudo -n test ! -L "$NGINX_CONFIG" || fail 'host Nginx config must not be a symlink'
sudo -n cp -- "$NGINX_CONFIG" "$nginx_backup"
sudo -n chown "$(id -u):$(id -g)" "$nginx_backup"
chmod 0600 "$nginx_backup"
if [[ -n "$FORMAL_NGINX_CONFIG" ]]; then
  sudo -n test -f "$FORMAL_NGINX_CONFIG" ||
    fail 'formal Production Nginx config is missing'
  sudo -n test ! -L "$FORMAL_NGINX_CONFIG" ||
    fail 'formal Production Nginx config must not be a symlink'
  sudo -n cp -- "$FORMAL_NGINX_CONFIG" "$formal_nginx_backup"
  sudo -n chown "$(id -u):$(id -g)" "$formal_nginx_backup"
  chmod 0600 "$formal_nginx_backup"
fi
if [[ -e "$current_state" ]]; then
  [[ -f "$current_state" && ! -L "$current_state" ]] ||
    fail 'release traffic current state is not a regular file'
  install -m 0600 "$current_state" "$work/current.before"
  current_state_existed=1
fi
transaction_armed=1
resolve_previous_release_identity
prepare_route_candidate
persist_rollback_checkpoint

revalidate_captured_host_state() {
  local index unit env_file live_sha captured_sha
  if ! sudo -n test -f "$NGINX_CONFIG" ||
    ! sudo -n test ! -L "$NGINX_CONFIG"; then
    fail 'host Nginx config changed before traffic mutation'
  fi
  live_sha=$(sudo -n sha256sum "$NGINX_CONFIG" | awk '{print "sha256:" $1}')
  captured_sha=$(sha256sum "$nginx_backup" | awk '{print "sha256:" $1}')
  [[ "$live_sha" == "$captured_sha" ]] ||
    fail 'host Nginx config changed before traffic mutation'
  if [[ -n "$FORMAL_NGINX_CONFIG" ]]; then
    if ! sudo -n test -f "$FORMAL_NGINX_CONFIG" ||
      ! sudo -n test ! -L "$FORMAL_NGINX_CONFIG"; then
      fail 'formal Production Nginx config changed before traffic mutation'
    fi
    live_sha=$(sudo -n sha256sum "$FORMAL_NGINX_CONFIG" |
      awk '{print "sha256:" $1}')
    captured_sha=$(sha256sum "$formal_nginx_backup" |
      awk '{print "sha256:" $1}')
    [[ "$live_sha" == "$captured_sha" ]] ||
      fail 'formal Production Nginx config changed before traffic mutation'
  fi
  for index in "${!UNITS[@]}"; do
    unit=${UNITS[$index]}
    if [[ "${UNIT_EXISTED[$index]}" == 1 ]]; then
      if ! sudo -n test -f "/etc/systemd/system/$unit" ||
        ! sudo -n test ! -L "/etc/systemd/system/$unit"; then
        fail "$unit changed before traffic mutation"
      fi
      live_sha=$(sudo -n sha256sum "/etc/systemd/system/$unit" |
        awk '{print "sha256:" $1}')
      captured_sha=$(sha256sum "$work/unit-$index.before" |
        awk '{print "sha256:" $1}')
      [[ "$live_sha" == "$captured_sha" ]] ||
        fail "$unit changed before traffic mutation"
    else
      sudo -n test ! -e "/etc/systemd/system/$unit" ||
        fail "$unit appeared before traffic mutation"
    fi
    env_file=${ENV_FILES[$index]}
    [[ -n "$env_file" ]] || continue
    if [[ "${ENV_EXISTED[$index]}" == 1 ]]; then
      if ! sudo -n test -f "$env_file" ||
        ! sudo -n test ! -L "$env_file"; then
        fail "$unit environment changed before traffic mutation"
      fi
      live_sha=$(sudo -n sha256sum "$env_file" | awk '{print "sha256:" $1}')
      captured_sha=$(sha256sum "$work/env-$index.before" |
        awk '{print "sha256:" $1}')
      [[ "$live_sha" == "$captured_sha" ]] ||
        fail "$unit environment changed before traffic mutation"
    else
      sudo -n test ! -e "$env_file" ||
        fail "$unit environment appeared before traffic mutation"
    fi
  done
  if ((current_state_existed == 1)); then
    [[ -f "$current_state" && ! -L "$current_state" ]] ||
      fail 'release traffic current state changed before traffic mutation'
    [[ "$(sha256sum "$current_state" | awk '{print "sha256:" $1}')" == \
      "$(sha256sum "$work/current.before" | awk '{print "sha256:" $1}')" ]] ||
      fail 'release traffic current state changed before traffic mutation'
  else
    [[ ! -e "$current_state" ]] ||
      fail 'release traffic current state appeared before traffic mutation'
  fi
}

revalidate_captured_host_state
sudo -n install -d -o root -g root -m 0755 /etc/combo-release
forwards_changed=1
for index in "${!UNITS[@]}"; do
  unit=${UNITS[$index]}
  atomic_root_install "$HOST_UNIT_ROOT/$unit" "/etc/systemd/system/$unit" 0644
  env_file=${ENV_FILES[$index]}
  if [[ -n "$env_file" ]]; then
    env_candidate="$work/env-$index.candidate"
    printf 'COMBO_RELEASE_WEB_SERVICE=%s\n' "${SERVICES[$index]}" >"$env_candidate"
    chmod 0644 "$env_candidate"
    atomic_root_install "$env_candidate" "$env_file" 0644
  fi
done
sudo -n systemctl daemon-reload
for unit in "${UNITS[@]}"; do
  sudo -n systemctl enable "$unit" >/dev/null
  sudo -n systemctl restart "$unit"
done

for index in "${!UNITS[@]}"; do
  unit=${UNITS[$index]}
  port=${PORTS[$index]}
  listener_ok=0
  for _ in $(seq 1 30); do
    main_pid=$(sudo -n systemctl show "$unit" --property=MainPID --value)
    lines=$(listener_lines "$port")
    if [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] &&
      [[ $(grep -c . <<<"$lines" || true) -eq 1 ]] &&
      grep -Eq "127\\.0\\.0\\.1:${port}[[:space:]].*pid=${main_pid}," <<<"$lines"; then
      listener_ok=1
      break
    fi
    sleep 1
  done
  ((listener_ok == 1)) ||
    fail "$unit did not acquire its single IPv4 loopback listener"
done

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

preview_release_ready() {
  local origin=$1 output=$2 status_code
  status_code=$(curl --silent --show-error --max-time 15 \
    --output "$output" --write-out '%{http_code}' \
    "$origin/version.json" 2>/dev/null) || return 1
  [[ "$status_code" == 200 ]] || return 1
  metadata_matches "$output"
}

curl_https_capture() {
  local origin=$1 path=$2 headers=$3 output=$4
  shift 4
  local result
  result=$(curl --silent --show-error --max-time 20 --max-filesize 8388608 \
    --dump-header "$headers" --output "$output" --write-out '%{http_code} %{ssl_verify_result}' \
    "$@" "$origin$path") || return 1
  [[ "$result" == '200 0' ]]
}

assert_header_contains() {
  local headers=$1 name=$2 pattern=$3
  grep -Eqi "^${name}:[[:space:]].*${pattern}" "$headers"
}

formal_version_ready() {
  local origin=$1 label=$2
  local headers="$work/$label-version.headers"
  local output="$work/$label-version.json"
  curl_https_capture "$origin" /version.json "$headers" "$output" || return 1
  metadata_matches "$output"
}

validate_formal_public() {
  local home="$work/formal-home.html" home_headers="$work/formal-home.headers"
  local refresh="$work/formal-refresh.html" refresh_headers="$work/formal-refresh.headers"
  local route route_body route_headers
  local version="$work/formal-version-final.json"
  local version_headers="$work/formal-version-final.headers"
  local runtime_config="$work/formal-runtime-config.json"
  local runtime_headers="$work/formal-runtime-config.headers"
  local api_version="$work/formal-api-version.json"
  local api_headers="$work/formal-api-version.headers"
  local health="$work/formal-health.json" health_headers="$work/formal-health.headers"
  local ready="$work/formal-ready.json" ready_headers="$work/formal-ready.headers"
  local assets="$work/formal-web-assets.json" assets_headers="$work/formal-web-assets.headers"
  local asset_path asset_body="$work/formal-asset" asset_headers="$work/formal-asset.headers"
  local missing="$work/formal-missing" missing_headers="$work/formal-missing.headers"
  local missing_result alias_version="$work/formal-alias-version.json"
  local alias_headers="$work/formal-alias-version.headers"

  curl_https_capture "$FORMAL_ORIGIN" / "$home_headers" "$home" ||
    fail 'formal Production home did not return HTTP 200 with valid TLS'
  { assert_header_contains "$home_headers" Cache-Control 'no-cache' &&
    assert_header_contains "$home_headers" Cache-Control 'must-revalidate'; } ||
    fail 'formal Production HTML cache policy is not no-cache/must-revalidate'
  assert_header_contains "$home_headers" Content-Type 'text/html' ||
    fail 'formal Production home is not HTML'

  curl_https_capture "$FORMAL_ORIGIN" / "$refresh_headers" "$refresh" \
    --header 'Cache-Control: no-cache' ||
    fail 'formal Production forced refresh failed'
  cmp -s "$home" "$refresh" ||
    fail 'formal Production normal and forced refresh returned different HTML'

  for route in /tasks /capabilities; do
    route_body="$work/formal-$(tr -d / <<<"$route").html"
    route_headers="$work/formal-$(tr -d / <<<"$route").headers"
    curl_https_capture "$FORMAL_ORIGIN" "$route" "$route_headers" "$route_body" ||
      fail "formal Production SPA route $route did not load"
    cmp -s "$home" "$route_body" ||
      fail "formal Production SPA route $route did not return the active shell"
  done

  curl_https_capture "$FORMAL_ORIGIN" /version.json "$version_headers" "$version" ||
    fail 'formal Production version endpoint failed'
  metadata_matches "$version" ||
    fail 'formal Production version endpoint identifies another release'
  assert_header_contains "$version_headers" Cache-Control 'no-store' ||
    fail 'formal Production version endpoint can be cached'

  curl_https_capture "$FORMAL_ORIGIN" /runtime-config.json \
    "$runtime_headers" "$runtime_config" ||
    fail 'formal Production runtime config failed'
  metadata_matches "$runtime_config" ||
    fail 'formal Production runtime config identifies another release'
  assert_header_contains "$runtime_headers" Cache-Control 'no-store' ||
    fail 'formal Production runtime config can be cached'

  curl_https_capture "$FORMAL_ORIGIN" /api/v1/version "$api_headers" "$api_version" ||
    fail 'formal Production API version endpoint failed'
  metadata_matches "$api_version" ||
    fail 'formal Production API identifies another release'
  curl_https_capture "$FORMAL_ORIGIN" /health "$health_headers" "$health" ||
    fail 'formal Production API health endpoint failed'
  curl_https_capture "$FORMAL_ORIGIN" /ready "$ready_headers" "$ready" ||
    fail 'formal Production API readiness endpoint failed'

  curl_https_capture "$FORMAL_ORIGIN" /web-asset-manifest.json \
    "$assets_headers" "$assets" ||
    fail 'formal Production Web asset manifest failed'
  [[ "$(sha256sum "$assets" | awk '{print "sha256:" $1}')" == "$web_asset_digest" ]] ||
    fail 'formal Production Web asset manifest digest differs from the release'
  asset_path=$(jq -er '
    first(.assets[]
      | select(.application == "web" and (.path | startswith("assets/")))
      | .path)
  ' "$assets") || fail 'formal Production Web asset manifest lacks a hashed Web asset'
  [[ "$asset_path" =~ ^assets/[A-Za-z0-9._/-]+$ && "$asset_path" != *..* ]] ||
    fail 'formal Production Web asset path is unsafe'
  curl_https_capture "$FORMAL_ORIGIN" "/$asset_path" "$asset_headers" "$asset_body" ||
    fail 'formal Production hashed Web asset failed'
  { assert_header_contains "$asset_headers" Cache-Control 'max-age=31536000' &&
    assert_header_contains "$asset_headers" Cache-Control 'immutable'; } ||
    fail 'formal Production hashed Web asset is not immutable'

  missing_result=$(curl --silent --show-error --max-time 20 --max-filesize 1048576 \
    --dump-header "$missing_headers" --output "$missing" \
    --write-out '%{http_code} %{ssl_verify_result}' \
    "$FORMAL_ORIGIN/assets/combo-missing-${source_sha:0:12}.js") || return 1
  [[ "$missing_result" == '404 0' ]] ||
    fail 'formal Production missing hashed asset did not return TLS-valid 404'
  ! cmp -s "$missing" "$home" ||
    fail 'formal Production missing hashed asset returned the SPA shell'

  curl_https_capture "$FORMAL_ALIAS_ORIGIN" /version.json \
    "$alias_headers" "$alias_version" --location --max-redirs 2 ||
    fail 'formal Production www alias did not return a TLS-valid version'
  metadata_matches "$alias_version" ||
    fail 'formal Production www alias identifies another release'
}

loopback_origin="http://127.0.0.1:${PORTS[0]}"
if [[ "$ENVIRONMENT" == preview ]]; then
  candidate_version="$work/candidate-version.json"
  preview_release_ready "$loopback_origin" "$candidate_version" ||
    fail 'loopback Preview Web does not identify the release'
else
  loopback_version="$work/loopback-version.json"
  curl --fail --silent --show-error --max-time 15 \
    "$loopback_origin/version.json" >"$loopback_version"
  metadata_matches "$loopback_version" || fail 'loopback Web does not identify the release'
fi
curl --fail --silent --show-error --output /dev/null --max-time 15 \
  "http://127.0.0.1:${PORTS[1]}/minio/health/ready"

if ! cmp -s "$nginx_backup" "$nginx_candidate"; then
  atomic_root_install "$nginx_candidate" "$NGINX_CONFIG" 0644
  nginx_candidate_installed=1
fi
if [[ -n "$FORMAL_NGINX_CONFIG" ]] &&
  ! cmp -s "$formal_nginx_backup" "$formal_nginx_candidate"; then
  atomic_root_install "$formal_nginx_candidate" "$FORMAL_NGINX_CONFIG" 0644
  formal_nginx_candidate_installed=1
fi
if ((nginx_candidate_installed == 1 || formal_nginx_candidate_installed == 1 ||
  RECOVERING_CHECKPOINT == 1)); then
  sudo -n nginx -t >/dev/null
  sudo -n systemctl reload nginx
fi

public_version="$work/public-version.json"
public_ok=0
for _ in $(seq 1 20); do
  if [[ "$ENVIRONMENT" == preview ]]; then
    if preview_release_ready "$PUBLIC_ORIGIN" "$public_version"; then
      public_ok=1
      break
    fi
  else
    if curl --fail --silent --show-error --max-time 15 \
      "$PUBLIC_ORIGIN/version.json" >"$public_version" 2>/dev/null &&
      metadata_matches "$public_version"; then
      public_ok=1
      break
    fi
  fi
  sleep 1
done
((public_ok == 1)) || fail 'public Web did not converge to the release'
if [[ -n "$S3_ORIGIN" ]]; then
  s3_ok=0
  for _ in $(seq 1 20); do
    if curl --fail --silent --show-error --output /dev/null --max-time 15 \
      "$S3_ORIGIN/minio/health/ready" 2>/dev/null; then
      s3_ok=1
      break
    fi
    sleep 1
  done
  ((s3_ok == 1)) || fail "public $ENVIRONMENT S3 did not converge to the release foundation"
fi
if [[ "$ENVIRONMENT" == production ]]; then
  formal_ok=0
  for _ in $(seq 1 20); do
    if formal_version_ready "$FORMAL_ORIGIN" formal; then
      formal_ok=1
      break
    fi
    sleep 1
  done
  ((formal_ok == 1)) ||
    fail 'buildwithcombo.com did not converge to the Production release'
  validate_formal_public
fi

unit_evidence="$work/units.jsonl"
for index in "${!UNITS[@]}"; do
  unit=${UNITS[$index]}
  port=${PORTS[$index]}
  unit_sha=$(sha256sum "$HOST_UNIT_ROOT/$unit" | awk '{print "sha256:" $1}')
  main_pid=$(sudo -n systemctl show "$unit" --property=MainPID --value)
  jq -n \
    --arg name "$unit" \
    --arg service "${SERVICES[$index]}" \
    --argjson port "$port" \
    --argjson mainPid "$main_pid" \
    --arg sha256 "$unit_sha" \
    '{name: $name, service: $service, port: $port, mainPid: $mainPid, sha256: $sha256}' \
    >>"$unit_evidence"
done
commit_traffic_state
nginx_sha=$(sudo -n sha256sum "$NGINX_CONFIG" | awk '{print "sha256:" $1}')
formal_nginx_sha=''
if [[ -n "$FORMAL_NGINX_CONFIG" ]]; then
  formal_nginx_sha=$(sudo -n sha256sum "$FORMAL_NGINX_CONFIG" |
    awk '{print "sha256:" $1}')
fi
evidence_stage=$(mktemp "$(dirname "$EVIDENCE_OUTPUT")/.traffic-evidence.XXXXXX")
jq -n \
  --arg environment "$ENVIRONMENT" \
  --arg sourceSha "$source_sha" \
  --arg releaseId "$release_id" \
  --arg manifestDigest "$MANIFEST_DIGEST" \
  --arg publicOrigin "$PUBLIC_ORIGIN" \
  --arg s3Origin "$S3_ORIGIN" \
  --arg formalOrigin "$FORMAL_ORIGIN" \
  --arg formalAliasOrigin "$FORMAL_ALIAS_ORIGIN" \
  --arg nginxConfig "$NGINX_CONFIG" \
  --arg nginxSha256 "$nginx_sha" \
  --arg formalNginxConfig "$FORMAL_NGINX_CONFIG" \
  --arg formalNginxSha256 "$formal_nginx_sha" \
  --arg rollbackCheckpoint "$release_id" \
  --arg rollbackCheckpointDigest "$checkpoint_digest" \
  --arg activatedAt "$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')" \
  --slurpfile canaryRoute "$nginx_route_evidence" \
  --slurpfile formalRoute "$formal_route_evidence" \
  --slurpfile units "$unit_evidence" '{
    schemaVersion: 1,
    environment: $environment,
    sourceSha: $sourceSha,
    releaseId: $releaseId,
    manifestDigest: $manifestDigest,
    publicOrigin: $publicOrigin,
    s3Origin: (if $s3Origin == "" then null else $s3Origin end),
    formalOrigin: (if $formalOrigin == "" then null else $formalOrigin end),
    formalAliasOrigin:
      (if $formalAliasOrigin == "" then null else $formalAliasOrigin end),
    nginx: {
      path: $nginxConfig,
      sha256: $nginxSha256
    },
    formalNginx: (if $formalNginxConfig == "" then null else {
      path: $formalNginxConfig,
      sha256: $formalNginxSha256
    } end),
    routeCas: {
      canary: $canaryRoute[0],
      formal: (if ($formalRoute | length) == 0 then null else $formalRoute[0] end)
    },
    rollback: {
      checkpointId: $rollbackCheckpoint,
      checkpointDigest: $rollbackCheckpointDigest,
      persisted: true
    },
    units: $units,
    checks: {
      loopbackWebRelease: true,
      loopbackMinioReady: true,
      publicWebRelease: true,
      publicMinioReady: true,
      formalHome: ($formalOrigin != ""),
      formalVersion: ($formalOrigin != ""),
      formalSpaRoutes: ($formalOrigin != ""),
      formalApi: ($formalOrigin != ""),
      formalTls: ($formalOrigin != ""),
      formalHtmlCache: ($formalOrigin != ""),
      formalAssetCache: ($formalOrigin != ""),
      formalMissingAsset404: ($formalOrigin != ""),
      formalForcedRefresh: ($formalOrigin != ""),
      internalPortsLoopbackOnly: true
    },
    activatedAt: $activatedAt
  }' >"$evidence_stage"
chmod 0644 "$evidence_stage"
transaction_committed=1
mv -fT "$evidence_stage" "$EVIDENCE_OUTPUT"
status "$ENVIRONMENT public traffic now identifies $release_id"
