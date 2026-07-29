#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly SCRIPT_DIR
readonly SHA_RE='^[0-9a-f]{40}$'

CANDIDATE_SOURCE_SHA=''
EVIDENCE_ROOT=${COMBO_RELEASE_EVIDENCE_ROOT:-"$HOME/data/combo-releases/goal-a"}
TRAFFIC_STATE_ROOT=${COMBO_RELEASE_TRAFFIC_STATE_ROOT:-"$HOME/data/combo-releases/traffic"}

status() { printf '[preview-post-cut-recovery] %s\n' "$1"; }
fail() {
  printf '[preview-post-cut-recovery] FAIL: %s\n' "$1" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
Usage: recover-preview-post-cut.sh --candidate-source-sha <40-character-sha>
EOF
  exit 2
}

while (($# > 0)); do
  (($# >= 2)) || usage
  case "$1" in
    --candidate-source-sha) CANDIDATE_SOURCE_SHA=$2 ;;
    *) usage ;;
  esac
  shift 2
done

[[ "$CANDIDATE_SOURCE_SHA" =~ $SHA_RE ]] || usage
for command in awk bash cmp jq node realpath sha256sum sort; do
  command -v "$command" >/dev/null 2>&1 ||
    fail "missing host command: $command"
done
[[ -x "$SCRIPT_DIR/deploy-release.sh" &&
  ! -L "$SCRIPT_DIR/deploy-release.sh" ]] ||
  fail 'bundled deployment controller is missing or unsafe'
[[ -f "$SCRIPT_DIR/release-manifest.mjs" &&
  ! -L "$SCRIPT_DIR/release-manifest.mjs" ]] ||
  fail 'bundled release manifest verifier is missing or unsafe'

preview_root="$EVIDENCE_ROOT/preview"
pending_checkpoint="$preview_root/pending.json"
[[ "$EVIDENCE_ROOT" == /* && ! -L "$EVIDENCE_ROOT" ]] ||
  fail 'Preview evidence root path is unsafe'
if [[ ! -e "$EVIDENCE_ROOT" ]]; then
  status 'no pending Preview checkpoint requires recovery'
  exit 0
fi
[[ -d "$EVIDENCE_ROOT" &&
  "$(realpath -e "$EVIDENCE_ROOT")" == "$EVIDENCE_ROOT" ]] ||
  fail 'Preview evidence root is missing or traverses a symbolic link'
if [[ ! -e "$preview_root" && ! -L "$preview_root" ]]; then
  status 'no pending Preview checkpoint requires recovery'
  exit 0
fi
[[ -d "$preview_root" && ! -L "$preview_root" &&
  "$(realpath -e "$preview_root")" == "$preview_root" ]] ||
  fail 'Preview evidence root is missing or unsafe'

if [[ ! -e "$pending_checkpoint" && ! -L "$pending_checkpoint" ]]; then
  shopt -s nullglob
  orphan_pending=(
    "$preview_root"/release-*.traffic.pending.json
    "$preview_root"/release-*.cleanup-plan.pending.json
  )
  shopt -u nullglob
  ((${#orphan_pending[@]} == 0)) ||
    fail 'Preview has orphan auxiliary pending evidence without a release checkpoint'
  status 'no pending Preview checkpoint requires recovery'
  exit 0
fi
[[ -f "$pending_checkpoint" && ! -L "$pending_checkpoint" ]] ||
  fail 'pending Preview checkpoint is not a regular file'

pending_source=$(jq -er '.sourceSha' "$pending_checkpoint") ||
  fail 'pending Preview checkpoint lacks a source SHA'
[[ "$pending_source" =~ $SHA_RE ]] ||
  fail 'pending Preview checkpoint source SHA is invalid'
if [[ "$pending_source" == "$CANDIDATE_SOURCE_SHA" ]]; then
  status 'pending Preview checkpoint belongs to the current candidate'
  exit 0
fi

jq -e \
  --arg sourceSha "$pending_source" \
  --arg releaseId "release-$pending_source" \
  --arg webService "release-${pending_source:0:12}-web" '
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
    and .environment == "preview"
    and .namespace == "combo-review"
    and .sourceSha == $sourceSha
    and .releaseId == $releaseId
    and (.manifestDigest | test("^sha256:[0-9a-f]{64}$"))
    and (.foundationCreated | type == "boolean")
    and (
      .foundationResetEvidenceDigest == null
      or (.foundationResetEvidenceDigest | test("^sha256:[0-9a-f]{64}$"))
    )
    and .phase == "post-cut"
    and (.schemaStructureProofDigest | test("^sha256:[0-9a-f]{64}$"))
    and (.cleanupPlanDigest | test("^sha256:[0-9a-f]{64}$"))
    and (.trafficCutAt | type == "string" and length > 0)
    and .webService == $webService
  ' "$pending_checkpoint" >/dev/null ||
  fail 'foreign Preview checkpoint is not a completed post-cut checkpoint'

release_id="release-$pending_source"
manifest_digest=$(jq -er '.manifestDigest' "$pending_checkpoint")
cleanup_plan_digest=$(jq -er '.cleanupPlanDigest' "$pending_checkpoint")
schema_structure_digest=$(jq -er '.schemaStructureProofDigest' "$pending_checkpoint")
foundation_reset_digest=$(jq -r '.foundationResetEvidenceDigest // ""' "$pending_checkpoint")
release_directory="$preview_root/$release_id"
traffic_pending="$preview_root/$release_id.traffic.pending.json"
cleanup_plan_pending="$preview_root/$release_id.cleanup-plan.pending.json"
current_checkpoint="$preview_root/current.json"

current_is_candidate=0
if [[ -e "$current_checkpoint" || -L "$current_checkpoint" ]]; then
  [[ -f "$current_checkpoint" && ! -L "$current_checkpoint" ]] ||
    fail 'Preview release current checkpoint is unsafe during recovery'
  jq -e \
    --arg evidenceRoot "$preview_root" '
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
      and .environment == "preview"
      and .namespace == "combo-review"
      and (.sourceSha | test("^[0-9a-f]{40}$"))
      and .releaseId == ("release-" + .sourceSha)
      and (.manifestDigest | test("^sha256:[0-9a-f]{64}$"))
      and .evidencePath == ($evidenceRoot + "/release-" + .sourceSha)
    ' "$current_checkpoint" >/dev/null ||
    fail 'Preview release current checkpoint is invalid during recovery'
  if jq -e \
    --arg sourceSha "$pending_source" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$manifest_digest" '
      .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .manifestDigest == $manifestDigest
    ' "$current_checkpoint" >/dev/null; then
    current_is_candidate=1
  fi
fi

shopt -s nullglob
auxiliary_pending=(
  "$preview_root"/release-*.traffic.pending.json
  "$preview_root"/release-*.cleanup-plan.pending.json
)
shopt -u nullglob
for path in "${auxiliary_pending[@]}"; do
  [[ "$path" == "$traffic_pending" || "$path" == "$cleanup_plan_pending" ]] ||
    fail 'Preview has foreign auxiliary pending evidence during recovery'
done

[[ -d "$release_directory" && ! -L "$release_directory" &&
  "$(realpath -e "$release_directory")" == "$release_directory" ]] ||
  fail 'foreign Preview release evidence directory is missing or unsafe'

required_files=(
  release.json
  release.sha256
  migration-files.txt
  web-asset-manifest.json
  foundation.yaml
  init.yaml
  migrate.yaml
  apps.yaml
  traffic-evidence.json
  cleanup-plan.json
  cleanup-evidence.json
  deploy-evidence.json
  SHA256SUMS
)
checksum_files=(
  release.json
  release.sha256
  migration-files.txt
  web-asset-manifest.json
  foundation.yaml
  init.yaml
  migrate.yaml
  apps.yaml
  traffic-evidence.json
  cleanup-plan.json
  cleanup-evidence.json
  deploy-evidence.json
)
for name in "${required_files[@]}"; do
  [[ -f "$release_directory/$name" && ! -L "$release_directory/$name" ]] ||
    fail "foreign Preview release evidence file is missing or unsafe: $name"
done

deploy_args=()
if [[ -n "$foundation_reset_digest" ]]; then
  reset_evidence="$release_directory/foundation-reset-evidence.json"
  [[ -f "$reset_evidence" && ! -L "$reset_evidence" ]] ||
    fail 'foreign Preview foundation reset evidence is missing or unsafe'
  [[ "$(sha256sum "$reset_evidence" | awk '{print "sha256:" $1}')" == \
    "$foundation_reset_digest" ]] ||
    fail 'foreign Preview foundation reset evidence digest changed'
  checksum_files+=(foundation-reset-evidence.json)
  deploy_args+=(--foundation-reset-evidence "$reset_evidence")
else
  [[ ! -e "$release_directory/foundation-reset-evidence.json" &&
    ! -L "$release_directory/foundation-reset-evidence.json" ]] ||
    fail 'foreign Preview release has unexpected foundation reset evidence'
fi

if ! checksum_names=$(awk '
  NF != 2 ||
    $1 !~ /^[0-9a-f]{64}$/ ||
    $2 !~ /^[A-Za-z0-9][A-Za-z0-9._-]*$/ { exit 1 }
  { print $2 }
  END { if (NR == 0) exit 1 }
' "$release_directory/SHA256SUMS"); then
  fail 'foreign Preview SHA256SUMS has unsafe or malformed entries'
fi
expected_names=$(printf '%s\n' "${checksum_files[@]}" | LC_ALL=C sort)
actual_names=$(printf '%s\n' "$checksum_names" | LC_ALL=C sort)
[[ "$actual_names" == "$expected_names" ]] ||
  fail 'foreign Preview SHA256SUMS file set is not exact'
(
  cd "$release_directory"
  sha256sum --strict --quiet -c SHA256SUMS
) || fail 'foreign Preview release evidence checksum verification failed'

verified_manifest=$(node "$SCRIPT_DIR/release-manifest.mjs" verify \
  --manifest "$release_directory/release.json" \
  --source-sha "$pending_source" \
  --release-id "$release_id" \
  --digest "$manifest_digest") ||
  fail 'foreign Preview release manifest verification failed'
[[ "$verified_manifest" == "$manifest_digest" ]] ||
  fail 'foreign Preview release manifest verifier returned another digest'
[[ "$(awk 'END { print NR }' "$release_directory/release.sha256")" == 1 &&
  "$(<"$release_directory/release.sha256")" == "$manifest_digest" ]] ||
  fail 'foreign Preview persisted release digest changed'
[[ "$(sha256sum "$release_directory/cleanup-plan.json" |
  awk '{print "sha256:" $1}')" == "$cleanup_plan_digest" ]] ||
  fail 'foreign Preview cleanup plan digest changed'
for path in "$traffic_pending" "$cleanup_plan_pending"; do
  if [[ -e "$path" || -L "$path" ]]; then
    [[ -f "$path" && ! -L "$path" ]] ||
      fail 'foreign Preview auxiliary pending evidence is unsafe'
  elif ((current_is_candidate == 0)); then
    fail 'foreign Preview auxiliary pending evidence is missing before current commit'
  fi
done
if [[ -e "$traffic_pending" ]]; then
  cmp -s "$traffic_pending" "$release_directory/traffic-evidence.json" ||
    fail 'foreign Preview pending traffic evidence changed'
fi
if [[ -e "$cleanup_plan_pending" ]]; then
  cmp -s "$cleanup_plan_pending" "$release_directory/cleanup-plan.json" ||
    fail 'foreign Preview pending cleanup plan changed'
fi

jq -e \
  --arg sourceSha "$pending_source" \
  --arg releaseId "$release_id" \
  --arg manifestDigest "$manifest_digest" \
  --arg schemaStructureDigest "$schema_structure_digest" \
  --arg foundationResetEvidenceDigest "$foundation_reset_digest" '
    .schemaVersion == 1
    and .status == "passed"
    and .environment == "preview"
    and .namespace == "combo-review"
    and .sourceSha == $sourceSha
    and .releaseId == $releaseId
    and .manifestDigest == $manifestDigest
    and .schemaStructureDigest == $schemaStructureDigest
    and .foundationResetEvidenceDigest ==
      (if $foundationResetEvidenceDigest == "" then null
        else $foundationResetEvidenceDigest end)
    and .cleanup.sourceSha == $sourceSha
    and .cleanup.verifiedAbsent == true
  ' "$release_directory/deploy-evidence.json" >/dev/null ||
  fail 'foreign Preview deploy evidence is not complete or bound to the checkpoint'

traffic_preview_root="$TRAFFIC_STATE_ROOT/preview"
traffic_current="$traffic_preview_root/current.json"
[[ "$TRAFFIC_STATE_ROOT" == /* && -d "$TRAFFIC_STATE_ROOT" &&
  ! -L "$TRAFFIC_STATE_ROOT" &&
  "$(realpath -e "$TRAFFIC_STATE_ROOT")" == "$TRAFFIC_STATE_ROOT" ]] ||
  fail 'Preview traffic state root is missing or unsafe'
[[ -d "$traffic_preview_root" && ! -L "$traffic_preview_root" &&
  "$(realpath -e "$traffic_preview_root")" == "$traffic_preview_root" ]] ||
  fail 'Preview traffic state directory is missing or unsafe'
[[ -f "$traffic_current" && ! -L "$traffic_current" ]] ||
  fail 'Preview traffic current state is missing or unsafe'
jq -e \
  --arg sourceSha "$pending_source" \
  --arg releaseId "$release_id" \
  --arg manifestDigest "$manifest_digest" \
  --arg webService "release-${pending_source:0:12}-web" '
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
  ' "$traffic_current" >/dev/null ||
  fail 'Preview traffic current state does not identify the foreign checkpoint'
traffic_digest_before=$(sha256sum "$traffic_current" | awk '{print "sha256:" $1}')
release_checksums_digest_before=$(sha256sum "$release_directory/SHA256SUMS" |
  awk '{print "sha256:" $1}')

status "revalidating completed foreign Preview release $release_id"
bash "$SCRIPT_DIR/deploy-release.sh" \
  --environment preview \
  --fresh-reset \
  --recover-existing-post-cut \
  "${deploy_args[@]}" \
  --manifest "$release_directory/release.json" \
  --manifest-digest "$manifest_digest" \
  --migrations "$release_directory/migration-files.txt" \
  --foundation-yaml "$release_directory/foundation.yaml" \
  --init-yaml "$release_directory/init.yaml" \
  --migrate-yaml "$release_directory/migrate.yaml" \
  --apps-yaml "$release_directory/apps.yaml" \
  --web-assets "$release_directory/web-asset-manifest.json"

[[ ! -e "$pending_checkpoint" && ! -L "$pending_checkpoint" ]] ||
  fail 'foreign Preview pending checkpoint remains after controller recovery'
[[ ! -e "$traffic_pending" && ! -L "$traffic_pending" ]] ||
  fail 'foreign Preview traffic pending evidence remains after recovery'
[[ ! -e "$cleanup_plan_pending" && ! -L "$cleanup_plan_pending" ]] ||
  fail 'foreign Preview cleanup plan remains pending after recovery'
[[ "$(sha256sum "$traffic_current" | awk '{print "sha256:" $1}')" == \
  "$traffic_digest_before" ]] ||
  fail 'foreign Preview recovery unexpectedly changed live traffic state'
[[ "$(sha256sum "$release_directory/SHA256SUMS" |
  awk '{print "sha256:" $1}')" == "$release_checksums_digest_before" ]] ||
  fail 'foreign Preview recovery unexpectedly changed release evidence'

[[ -f "$current_checkpoint" && ! -L "$current_checkpoint" ]] ||
  fail 'foreign Preview recovery did not commit the current checkpoint'
jq -e \
  --arg sourceSha "$pending_source" \
  --arg releaseId "$release_id" \
  --arg manifestDigest "$manifest_digest" \
  --arg evidencePath "$release_directory" '
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
    and .environment == "preview"
    and .namespace == "combo-review"
    and .sourceSha == $sourceSha
    and .releaseId == $releaseId
    and .manifestDigest == $manifestDigest
    and .evidencePath == $evidencePath
  ' "$current_checkpoint" >/dev/null ||
  fail 'foreign Preview current checkpoint commit is invalid'

status "recovered completed foreign Preview release $release_id"
