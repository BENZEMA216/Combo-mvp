#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly SCRIPT_DIR
readonly DIGEST_RE='^sha256:[0-9a-f]{64}$'
readonly SHA_RE='^[0-9a-f]{40}$'
readonly NGINX_CONFIG=/etc/nginx/conf.d/zz-agora-demo.conf
readonly FORMAL_NGINX_CONFIG=/etc/nginx/conf.d/happy.conf
readonly WEB_ENV=/etc/combo-release/production-web-forward.env
readonly WEB_UNIT=combo-release-production-web-forward.service
readonly MINIO_UNIT=combo-release-production-minio-forward.service
readonly WEB_PORT=18082
readonly MINIO_PORT=19002

PHASE=''
MANIFEST=''
MANIFEST_DIGEST=''
CLEANUP_PLAN=''
CLEANUP_PLAN_DIGEST=''
CLEANUP_EVIDENCE=''
CLEANUP_EVIDENCE_DIGEST=''
RELEASE_CHECKPOINT=''
EVIDENCE_OUTPUT=''
TRAFFIC_STATE_ROOT=${COMBO_RELEASE_TRAFFIC_STATE_ROOT:-"$HOME/data/combo-releases/traffic"}
TRAFFIC_LOCK=${COMBO_RELEASE_TRAFFIC_LOCK:-"$HOME/data/combo-release-traffic.lock"}
CHECKPOINT_ROOT=${COMBO_RELEASE_TRAFFIC_CHECKPOINT_ROOT:-/var/lib/combo-release/traffic-checkpoints}

fail() {
  printf '[release-traffic-seal] FAIL: %s\n' "$1" >&2
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
Usage: seal-release-traffic.sh
  --phase prepare|seal
  --manifest release.json
  --manifest-digest sha256:...
  --cleanup-plan cleanup-plan.json
  --cleanup-plan-digest sha256:...
  --cleanup-evidence cleanup-evidence.json
  --cleanup-evidence-digest sha256:...
  --release-checkpoint pending.json
  --evidence-output traffic-seal-evidence.json
EOF
  exit 2
}

while (($# > 0)); do
  (($# >= 2)) || usage
  case "$1" in
    --phase) PHASE=$2 ;;
    --manifest) MANIFEST=$2 ;;
    --manifest-digest) MANIFEST_DIGEST=$2 ;;
    --cleanup-plan) CLEANUP_PLAN=$2 ;;
    --cleanup-plan-digest) CLEANUP_PLAN_DIGEST=$2 ;;
    --cleanup-evidence) CLEANUP_EVIDENCE=$2 ;;
    --cleanup-evidence-digest) CLEANUP_EVIDENCE_DIGEST=$2 ;;
    --release-checkpoint) RELEASE_CHECKPOINT=$2 ;;
    --evidence-output) EVIDENCE_OUTPUT=$2 ;;
    *) usage ;;
  esac
  shift 2
done

for command in sudo systemctl ss grep install mktemp sha256sum jq node id dirname \
  chmod cp rm date flock awk mv; do
  command -v "$command" >/dev/null 2>&1 || fail "missing host command: $command"
done
[[ "$(id -un)" == xingzheng ]] || fail 'traffic checkpoint sealing must run as xingzheng'
[[ "$PHASE" == prepare || "$PHASE" == seal ]] || usage
for file in "$MANIFEST" "$CLEANUP_PLAN" "$RELEASE_CHECKPOINT"; do
  [[ -f "$file" && ! -L "$file" ]] || fail "input is not a regular file: $file"
done
[[ "$MANIFEST_DIGEST" =~ $DIGEST_RE &&
  "$CLEANUP_PLAN_DIGEST" =~ $DIGEST_RE ]] ||
  fail 'invalid evidence digest'
if [[ "$PHASE" == seal ]]; then
  [[ -f "$CLEANUP_EVIDENCE" && ! -L "$CLEANUP_EVIDENCE" ]] ||
    fail 'cleanup evidence is not a regular file'
  [[ "$CLEANUP_EVIDENCE_DIGEST" =~ $DIGEST_RE ]] ||
    fail 'invalid cleanup evidence digest'
else
  [[ -z "$CLEANUP_EVIDENCE" && -z "$CLEANUP_EVIDENCE_DIGEST" ]] ||
    fail 'prepare phase cannot accept cleanup evidence'
fi
[[ -n "$EVIDENCE_OUTPUT" && ! -e "$EVIDENCE_OUTPUT" ]] ||
  fail 'seal evidence output must not already exist'
[[ "$(node "$SCRIPT_DIR/release-manifest.mjs" verify \
  --manifest "$MANIFEST" --digest "$MANIFEST_DIGEST")" == "$MANIFEST_DIGEST" ]] ||
  fail 'manifest verification failed'
if [[ "$PHASE" == seal ]]; then
  [[ "$(sha256sum "$CLEANUP_EVIDENCE" | awk '{print "sha256:" $1}')" == \
    "$CLEANUP_EVIDENCE_DIGEST" ]] ||
    fail 'cleanup evidence digest does not match'
fi
[[ "$(sha256sum "$CLEANUP_PLAN" | awk '{print "sha256:" $1}')" == \
  "$CLEANUP_PLAN_DIGEST" ]] ||
  fail 'cleanup plan digest does not match'
source_sha=$(jq -er '.sourceSha' "$MANIFEST")
release_id=$(jq -er '.releaseId' "$MANIFEST")
[[ "$source_sha" =~ $SHA_RE && "$release_id" == "release-$source_sha" ]] ||
  fail 'manifest release identity is invalid'
jq -e \
  --arg sourceSha "$source_sha" \
  --arg releaseId "$release_id" \
  --arg manifestDigest "$MANIFEST_DIGEST" '
    .schemaVersion == 1
    and .purpose == "superseded-release-cleanup"
    and .environment == "production"
    and .namespace == "combo"
    and .sourceSha == $sourceSha
    and .releaseId == $releaseId
    and .manifestDigest == $manifestDigest
    and (.targets | type == "array")
    and (.capturedStorage | type == "array")
  ' "$CLEANUP_PLAN" >/dev/null ||
  fail 'cleanup plan does not identify this Production release'
if [[ "$PHASE" == seal ]]; then
  jq -e \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg cleanupPlanDigest "$CLEANUP_PLAN_DIGEST" \
    --slurpfile plan "$CLEANUP_PLAN" '
      .schemaVersion == 2
      and .purpose == "superseded-release-cleanup"
      and .environment == "production"
      and .namespace == "combo"
      and .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
      and .cleanupPlanDigest == $cleanupPlanDigest
      and .targets == $plan[0].targets
      and .capturedStorage == $plan[0].capturedStorage
      and .verifiedAbsent == true
    ' "$CLEANUP_EVIDENCE" >/dev/null ||
    fail 'cleanup evidence does not exactly seal its Production plan'
fi
jq -e \
  --arg sourceSha "$source_sha" \
  --arg releaseId "$release_id" \
  --arg manifestDigest "$MANIFEST_DIGEST" \
  --arg cleanupPlanDigest "$CLEANUP_PLAN_DIGEST" '
    (keys | sort) == ([
      "cleanupPlanDigest", "environment", "foundationCreated",
      "foundationResetEvidenceDigest", "manifestDigest", "namespace", "phase",
      "releaseId", "schemaVersion", "schemaStructureProofDigest", "sourceSha",
      "trafficCutAt", "webService"
    ] | sort)
    and .schemaVersion == 3
    and .phase == "finalizing"
    and .environment == "production"
    and .namespace == "combo"
    and .sourceSha == $sourceSha
    and .releaseId == $releaseId
    and .manifestDigest == $manifestDigest
    and .cleanupPlanDigest == $cleanupPlanDigest
    and (.foundationCreated | type == "boolean")
    and (.foundationResetEvidenceDigest == null
      or (.foundationResetEvidenceDigest | test("^sha256:[0-9a-f]{64}$")))
    and (.schemaStructureProofDigest | test("^sha256:[0-9a-f]{64}$"))
    and .webService == ("release-" + $sourceSha[0:12] + "-web")
    and (.trafficCutAt | type == "string" and test("Z$"))
  ' "$RELEASE_CHECKPOINT" >/dev/null ||
  fail 'finalizing release checkpoint does not bind the cleanup plan'

install -d -m 0750 "$(dirname "$EVIDENCE_OUTPUT")" "$(dirname "$TRAFFIC_LOCK")"
exec 8>"$TRAFFIC_LOCK"
flock -n 8 || fail 'another release traffic transaction is running'
checkpoint_directory="$CHECKPOINT_ROOT/production/$release_id"
checkpoint_host="$checkpoint_directory/checkpoint.json"
rollback_journal="$checkpoint_directory/rollback-in-progress.json"
current_state="$TRAFFIC_STATE_ROOT/production/current.json"
sudo -n test ! -e "$rollback_journal" ||
  fail 'traffic finalization is blocked by an active rollback journal'
for stale_stage in "${rollback_journal}.staging" "${checkpoint_host}.staging"; do
  if sudo -n test -e "$stale_stage"; then
    if ! sudo -n test -f "$stale_stage" ||
      ! sudo -n test ! -L "$stale_stage"; then
      fail "traffic finalization staging path is unsafe: $stale_stage"
    fi
    sudo -n rm -f -- "$stale_stage"
  fi
done
sudo -n test -f "$checkpoint_host" ||
  fail 'traffic checkpoint is missing'
sudo -n test ! -L "$checkpoint_host" ||
  fail 'traffic checkpoint must not be a symlink'
[[ -f "$current_state" && ! -L "$current_state" ]] ||
  fail 'active traffic state is missing'

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
sudo -n cp -- "$checkpoint_host" "$work/checkpoint.json"
sudo -n chown "$(id -u):$(id -g)" "$work/checkpoint.json"
chmod 0600 "$work/checkpoint.json"
jq -e \
  --arg sourceSha "$source_sha" \
  --arg releaseId "$release_id" \
  --arg manifestDigest "$MANIFEST_DIGEST" \
  --arg cleanupPlanDigest "$CLEANUP_PLAN_DIGEST" \
  --arg phase "$PHASE" '
    .schemaVersion == 1
    and (
      if $phase == "prepare" then
        .status == "activated" or .status == "finalizing" or .status == "sealed"
      else
        .status == "finalizing" or .status == "sealed"
      end
    )
    and .environment == "production"
    and .sourceSha == $sourceSha
    and .releaseId == $releaseId
    and .manifestDigest == $manifestDigest
    and .candidate.webService == ("release-" + $sourceSha[0:12] + "-web")
    and (.candidate.canaryNginxSha256 | test("^sha256:[0-9a-f]{64}$"))
    and (.candidate.formalNginxSha256 | test("^sha256:[0-9a-f]{64}$"))
    and (
      if .status == "activated" then
        (.cleanupPlanDigest // null) == null
      elif .status == "finalizing" then
        .cleanupPlanDigest == $cleanupPlanDigest
        and (.finalizingAt | type == "string" and length > 0)
      else
        .cleanupPlanDigest == $cleanupPlanDigest
        and (.finalizingAt | type == "string" and length > 0)
        and (.finalizingCheckpointDigest | test("^sha256:[0-9a-f]{64}$"))
        and (.cleanupEvidenceDigest | test("^sha256:[0-9a-f]{64}$"))
        and (.sealedAt | type == "string" and length > 0)
      end
    )
  ' "$work/checkpoint.json" >/dev/null ||
  fail 'traffic checkpoint is not the active finalization candidate'
jq -e \
  --arg sourceSha "$source_sha" \
  --arg releaseId "$release_id" \
  --arg manifestDigest "$MANIFEST_DIGEST" \
  --arg webService "$(jq -er '.candidate.webService' "$work/checkpoint.json")" \
  --arg canarySha "$(jq -er '.candidate.canaryNginxSha256' "$work/checkpoint.json")" \
  --arg formalSha "$(jq -er '.candidate.formalNginxSha256' "$work/checkpoint.json")" '
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
    and .webService == $webService
    and .canaryNginxSha256 == $canarySha
    and .formalNginxSha256 == $formalSha
  ' "$current_state" >/dev/null ||
  fail 'traffic CAS state is not the finalization candidate'

[[ "$(sudo -n sha256sum "$NGINX_CONFIG" | awk '{print "sha256:" $1}')" == \
  "$(jq -er '.candidate.canaryNginxSha256' "$work/checkpoint.json")" ]] ||
  fail 'Production canary Nginx is not the finalization candidate'
[[ "$(sudo -n sha256sum "$FORMAL_NGINX_CONFIG" |
  awk '{print "sha256:" $1}')" == \
  "$(jq -er '.candidate.formalNginxSha256' "$work/checkpoint.json")" ]] ||
  fail 'Production formal Nginx is not the finalization candidate'
if ! sudo -n test -f "$WEB_ENV" || ! sudo -n test ! -L "$WEB_ENV"; then
  fail 'Production Web forward environment is missing'
fi
if [[ "$(sudo -n awk 'END {print NR}' "$WEB_ENV")" != 1 ]] ||
  ! sudo -n grep -Fxq \
    "COMBO_RELEASE_WEB_SERVICE=$(jq -er '.candidate.webService' "$work/checkpoint.json")" \
    "$WEB_ENV"; then
  fail 'Production Web forward environment is not the finalization candidate'
fi

UNITS=("$WEB_UNIT" "$MINIO_UNIT")
PORTS=("$WEB_PORT" "$MINIO_PORT")
for index in 0 1; do
  unit=${UNITS[$index]}
  port=${PORTS[$index]}
  expected_unit_sha=$(jq -er --arg unit "$unit" '
    first(.previous.units[] | select(.name == $unit) | .sha256)
  ' "$work/checkpoint.json")
  [[ "$expected_unit_sha" =~ $DIGEST_RE ]] ||
    fail "Production finalization unit digest is invalid: $unit"
  if ! sudo -n test -f "/etc/systemd/system/$unit" ||
    ! sudo -n test ! -L "/etc/systemd/system/$unit"; then
    fail "Production finalization unit is missing: $unit"
  fi
  [[ "$(sudo -n sha256sum "/etc/systemd/system/$unit" |
    awk '{print "sha256:" $1}')" == "$expected_unit_sha" ]] ||
    fail "Production finalization unit changed: $unit"
  if ! sudo -n systemctl is-enabled --quiet "$unit" ||
    ! sudo -n systemctl is-active --quiet "$unit"; then
    fail "Production finalization unit is not enabled and active: $unit"
  fi
  main_pid=$(sudo -n systemctl show "$unit" --property=MainPID --value)
  [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] ||
    fail "Production finalization unit lacks a main process: $unit"
  listener_lines=$(sudo -n ss -H -lntp "( sport = :$port )")
  if [[ "$(grep -c . <<<"$listener_lines" || true)" != 1 ]] ||
    ! grep -Eq "127\\.0\\.0\\.1:${port}[[:space:]].*pid=${main_pid}," \
      <<<"$listener_lines"; then
    fail "Production finalization unit lost its loopback listener: $unit"
  fi
done

checkpoint_status=$(jq -er '.status' "$work/checkpoint.json")
if [[ "$PHASE" == prepare ]]; then
  if [[ "$checkpoint_status" == activated ]]; then
    finalizing_at=$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')
    jq \
      --arg finalizingAt "$finalizing_at" \
      --arg cleanupPlanDigest "$CLEANUP_PLAN_DIGEST" '
        .status = "finalizing"
        | .finalizingAt = $finalizingAt
        | .cleanupPlanDigest = $cleanupPlanDigest
      ' "$work/checkpoint.json" >"$work/checkpoint.finalizing.json"
    chmod 0600 "$work/checkpoint.finalizing.json"
    atomic_root_install "$work/checkpoint.finalizing.json" "$checkpoint_host" 0600
  else
    cp -- "$work/checkpoint.json" "$work/checkpoint.finalizing.json"
  fi
  if [[ "$checkpoint_status" == sealed ]]; then
    checkpoint_digest=$(jq -er '.finalizingCheckpointDigest' \
      "$work/checkpoint.finalizing.json")
  else
    checkpoint_digest=$(sha256sum "$work/checkpoint.finalizing.json" |
      awk '{print "sha256:" $1}')
  fi
  output_stage=$(mktemp "$(dirname "$EVIDENCE_OUTPUT")/.traffic-finalizing.XXXXXX")
  jq -n \
    --arg status finalizing \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg cleanupPlanDigest "$CLEANUP_PLAN_DIGEST" \
    --arg checkpointDigest "$checkpoint_digest" \
    --arg finalizingAt \
      "$(jq -er '.finalizingAt' "$work/checkpoint.finalizing.json")" '{
      schemaVersion: 1,
      status: $status,
      environment: "production",
      sourceSha: $sourceSha,
      releaseId: $releaseId,
      manifestDigest: $manifestDigest,
      cleanupPlanDigest: $cleanupPlanDigest,
      checkpointDigest: $checkpointDigest,
      rollbackAvailable: false,
      finalizingAt: $finalizingAt
    }' >"$output_stage"
  chmod 0600 "$output_stage"
  mv -fT "$output_stage" "$EVIDENCE_OUTPUT"
  exit 0
fi

if [[ "$checkpoint_status" == sealed ]]; then
  jq -e \
    --arg cleanupPlanDigest "$CLEANUP_PLAN_DIGEST" \
    --arg cleanupEvidenceDigest "$CLEANUP_EVIDENCE_DIGEST" '
      .status == "sealed"
      and .cleanupEvidenceDigest == $cleanupEvidenceDigest
      and .cleanupPlanDigest == $cleanupPlanDigest
      and (.finalizingCheckpointDigest | test("^sha256:[0-9a-f]{64}$"))
      and (.sealedAt | type == "string" and length > 0)
    ' "$work/checkpoint.json" >/dev/null ||
    fail 'sealed traffic checkpoint does not match the same cleanup evidence'
  cp -- "$work/checkpoint.json" "$work/checkpoint.sealed.json"
else
  [[ "$checkpoint_status" == finalizing ]] ||
    fail 'traffic checkpoint was not prepared for irreversible cleanup'
  finalizing_checkpoint_digest=$(sha256sum "$work/checkpoint.json" |
    awk '{print "sha256:" $1}')
  sealed_at=$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')
  jq \
    --arg sealedAt "$sealed_at" \
    --arg finalizingCheckpointDigest "$finalizing_checkpoint_digest" \
    --arg cleanupPlanDigest "$CLEANUP_PLAN_DIGEST" \
    --arg cleanupEvidenceDigest "$CLEANUP_EVIDENCE_DIGEST" '
      .status = "sealed"
      | .sealedAt = $sealedAt
      | .finalizingCheckpointDigest = $finalizingCheckpointDigest
      | .cleanupEvidenceDigest = $cleanupEvidenceDigest
      | .cleanupPlanDigest = $cleanupPlanDigest
    ' "$work/checkpoint.json" >"$work/checkpoint.sealed.json"
fi
chmod 0600 "$work/checkpoint.sealed.json"
if [[ "$checkpoint_status" == finalizing ]]; then
  atomic_root_install "$work/checkpoint.sealed.json" "$checkpoint_host" 0600
fi
sealed_at=$(jq -er '.sealedAt' "$work/checkpoint.sealed.json")
finalizing_checkpoint_digest=$(jq -er '.finalizingCheckpointDigest' \
  "$work/checkpoint.sealed.json")
checkpoint_digest=$(sha256sum "$work/checkpoint.sealed.json" |
  awk '{print "sha256:" $1}')
output_stage=$(mktemp "$(dirname "$EVIDENCE_OUTPUT")/.traffic-seal.XXXXXX")
jq -n \
  --arg sourceSha "$source_sha" \
  --arg releaseId "$release_id" \
  --arg manifestDigest "$MANIFEST_DIGEST" \
  --arg cleanupPlanDigest "$CLEANUP_PLAN_DIGEST" \
  --arg cleanupEvidenceDigest "$CLEANUP_EVIDENCE_DIGEST" \
  --arg finalizingCheckpointDigest "$finalizing_checkpoint_digest" \
  --arg checkpointDigest "$checkpoint_digest" \
  --arg sealedAt "$sealed_at" '{
    schemaVersion: 1,
    status: "sealed",
    environment: "production",
    sourceSha: $sourceSha,
    releaseId: $releaseId,
    manifestDigest: $manifestDigest,
    cleanupPlanDigest: $cleanupPlanDigest,
    cleanupEvidenceDigest: $cleanupEvidenceDigest,
    finalizingCheckpointDigest: $finalizingCheckpointDigest,
    checkpointDigest: $checkpointDigest,
    rollbackAvailable: false,
    sealedAt: $sealedAt
  }' >"$output_stage"
chmod 0600 "$output_stage"
mv -fT "$output_stage" "$EVIDENCE_OUTPUT"
