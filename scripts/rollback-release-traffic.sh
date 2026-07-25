#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly SCRIPT_DIR
readonly HOST_UNIT_ROOT="$SCRIPT_DIR/../infra/host/release"
readonly DIGEST_RE='^sha256:[0-9a-f]{64}$'
readonly SHA_RE='^[0-9a-f]{40}$'
readonly NGINX_CONFIG=/etc/nginx/conf.d/zz-agora-demo.conf
readonly FORMAL_NGINX_CONFIG=/etc/nginx/conf.d/happy.conf
readonly FORMAL_ORIGIN=https://buildwithcombo.com
readonly CANARY_ORIGIN=https://agora.43-160-242-46.sslip.io
readonly S3_ORIGIN=https://s3.43-160-242-46.sslip.io
readonly WEB_UNIT=combo-release-production-web-forward.service
readonly MINIO_UNIT=combo-release-production-minio-forward.service
readonly WEB_ENV=/etc/combo-release/production-web-forward.env
readonly WEB_PORT=18082
readonly MINIO_PORT=19002

MANIFEST=''
MANIFEST_DIGEST=''
EVIDENCE_OUTPUT=''
KUBECONFIG_PATH=${KUBECONFIG:-"$HOME/.kube/config"}
TRAFFIC_STATE_ROOT=${COMBO_RELEASE_TRAFFIC_STATE_ROOT:-"$HOME/data/combo-releases/traffic"}
TRAFFIC_LOCK=${COMBO_RELEASE_TRAFFIC_LOCK:-"$HOME/data/combo-release-traffic.lock"}
CHECKPOINT_ROOT=${COMBO_RELEASE_TRAFFIC_CHECKPOINT_ROOT:-/var/lib/combo-release/traffic-checkpoints}

status() { printf '[release-traffic-rollback] %s\n' "$1" >&2; }
fail() {
  printf '[release-traffic-rollback] FAIL: %s\n' "$1" >&2
  exit 1
}
file_digest() { sha256sum "$1" | awk '{print "sha256:" $1}'; }

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
Usage: rollback-release-traffic.sh
  --manifest release.json
  --manifest-digest sha256:...
  --evidence-output rollback-evidence.json
EOF
  exit 2
}

while (($# > 0)); do
  (($# >= 2)) || usage
  case "$1" in
    --manifest) MANIFEST=$2 ;;
    --manifest-digest) MANIFEST_DIGEST=$2 ;;
    --evidence-output) EVIDENCE_OUTPUT=$2 ;;
    *) usage ;;
  esac
  shift 2
done

for command in sudo systemctl ss awk grep cmp install mktemp sha256sum curl jq node realpath \
  id dirname chmod cp rm date kubectl flock mv; do
  command -v "$command" >/dev/null 2>&1 || fail "missing host command: $command"
done
[[ "$(id -un)" == xingzheng ]] || fail 'traffic rollback must run as xingzheng'
[[ -f "$MANIFEST" && ! -L "$MANIFEST" ]] || fail 'manifest is not a regular file'
[[ "$MANIFEST_DIGEST" =~ $DIGEST_RE ]] || fail 'invalid manifest digest'
[[ -n "$EVIDENCE_OUTPUT" && ! -e "$EVIDENCE_OUTPUT" ]] ||
  fail 'rollback evidence output must not already exist'
[[ -f "$SCRIPT_DIR/release-nginx-route.mjs" &&
  ! -L "$SCRIPT_DIR/release-nginx-route.mjs" ]] ||
  fail 'structured Nginx route controller is missing'

verified_digest=$(node "$SCRIPT_DIR/release-manifest.mjs" verify \
  --manifest "$MANIFEST" --digest "$MANIFEST_DIGEST")
[[ "$verified_digest" == "$MANIFEST_DIGEST" ]] ||
  fail 'manifest verifier returned another digest'
source_sha=$(jq -er '.sourceSha' "$MANIFEST")
release_id=$(jq -er '.releaseId' "$MANIFEST")
[[ "$source_sha" =~ $SHA_RE && "$release_id" == "release-$source_sha" ]] ||
  fail 'manifest release identity is invalid'

state_directory="$TRAFFIC_STATE_ROOT/production"
checkpoint_directory="$CHECKPOINT_ROOT/production/$release_id"
checkpoint_host="$checkpoint_directory/checkpoint.json"
current_state="$state_directory/current.json"
K=(kubectl --kubeconfig "$KUBECONFIG_PATH")
UNITS=("$WEB_UNIT" "$MINIO_UNIT")

install -d -m 0750 "$(dirname "$EVIDENCE_OUTPUT")" "$(dirname "$TRAFFIC_LOCK")"
exec 8>"$TRAFFIC_LOCK"
flock -n 8 || fail 'another release traffic transaction is running'
sudo -n test -f "$checkpoint_host" ||
  fail 'the exact persistent rollback checkpoint is missing'
sudo -n test ! -L "$checkpoint_host" ||
  fail 'the exact persistent rollback checkpoint must not be a symlink'
[[ -f "$current_state" && ! -L "$current_state" ]] ||
  fail 'the active traffic CAS state is missing'
work=$(mktemp -d)
evidence_stage=''
trap '[[ -z "$evidence_stage" ]] || rm -f -- "$evidence_stage"; rm -rf -- "$work"' EXIT
sudo -n cp -- "$checkpoint_host" "$work/checkpoint.json"
sudo -n chown "$(id -u):$(id -g)" "$work/checkpoint.json"
chmod 0600 "$work/checkpoint.json"
checkpoint="$work/checkpoint.json"
install -m 0600 "$current_state" "$work/current.active"

jq -e \
  --arg sourceSha "$source_sha" \
  --arg releaseId "$release_id" \
  --arg manifestDigest "$MANIFEST_DIGEST" \
  --arg webUnit "$WEB_UNIT" \
  --arg minioUnit "$MINIO_UNIT" '
    .schemaVersion == 1
    and .status == "activated"
    and .environment == "production"
    and .sourceSha == $sourceSha
    and .releaseId == $releaseId
    and .manifestDigest == $manifestDigest
    and .candidate.webService == ("release-" + $sourceSha[0:12] + "-web")
    and (.candidate.canaryNginxSha256 | test("^sha256:[0-9a-f]{64}$"))
    and (.candidate.formalNginxSha256 | test("^sha256:[0-9a-f]{64}$"))
    and (.previous.canaryMode == "legacy" or .previous.canaryMode == "release")
    and (.previous.formalMode == "legacy" or .previous.formalMode == "release")
    and (.previous.webService == null
      or (.previous.webService | test("^release-[0-9a-f]{12}-web$")))
    and .previous.files.canaryNginx.name == "nginx-canary.before"
    and (.previous.files.canaryNginx.sha256 | test("^sha256:[0-9a-f]{64}$"))
    and .previous.files.formalNginx.name == "nginx-formal.before"
    and (.previous.files.formalNginx.sha256 | test("^sha256:[0-9a-f]{64}$"))
    and (
      (.previous.webService == null and .previous.files.webEnvironment == null)
      or
      (.previous.webService != null
        and .previous.files.webEnvironment.name == "web-env.before"
        and (.previous.files.webEnvironment.sha256
          | test("^sha256:[0-9a-f]{64}$")))
    )
    and (.previous.units | length) == 2
    and [.previous.units[].name] == [$webUnit, $minioUnit]
    and all(.previous.units[];
      (.existed | type == "boolean")
      and (.active | type == "boolean")
      and (.enabled | type == "boolean")
      and (.sha256 | test("^sha256:[0-9a-f]{64}$"))
      and (
        (.existed == true
          and (.backupFile | test("^unit-[01]\\.before$")))
        or
        (.existed == false and .backupFile == null)
      ))
  ' "$checkpoint" >/dev/null ||
  fail 'rollback checkpoint does not match the exact candidate contract'

jq -e \
  --arg sourceSha "$source_sha" \
  --arg releaseId "$release_id" \
  --arg manifestDigest "$MANIFEST_DIGEST" \
  --arg canarySha "$(jq -er '.candidate.canaryNginxSha256' "$checkpoint")" \
  --arg formalSha "$(jq -er '.candidate.formalNginxSha256' "$checkpoint")" \
  --arg webService "$(jq -er '.candidate.webService' "$checkpoint")" '
    .schemaVersion == 1
    and .environment == "production"
    and .sourceSha == $sourceSha
    and .releaseId == $releaseId
    and .manifestDigest == $manifestDigest
    and .canaryNginxSha256 == $canarySha
    and .formalNginxSha256 == $formalSha
    and .webService == $webService
  ' "$current_state" >/dev/null ||
  fail 'active traffic state is not the exact rollback candidate'

for backup in nginx-canary.before nginx-formal.before; do
  sudo -n test -f "$checkpoint_directory/$backup" ||
    fail "persisted rollback file is missing: $backup"
  sudo -n test ! -L "$checkpoint_directory/$backup" ||
    fail "persisted rollback file must not be a symlink: $backup"
  sudo -n cp -- "$checkpoint_directory/$backup" "$work/$backup"
  sudo -n chown "$(id -u):$(id -g)" "$work/$backup"
  chmod 0600 "$work/$backup"
done
[[ "$(file_digest "$work/nginx-canary.before")" == \
  "$(jq -er '.previous.files.canaryNginx.sha256' "$checkpoint")" ]] ||
  fail 'persisted canary Nginx rollback digest changed'
[[ "$(file_digest "$work/nginx-formal.before")" == \
  "$(jq -er '.previous.files.formalNginx.sha256' "$checkpoint")" ]] ||
  fail 'persisted formal Nginx rollback digest changed'
if jq -e '.previous.files.webEnvironment != null' "$checkpoint" >/dev/null; then
  sudo -n test -f "$checkpoint_directory/web-env.before" ||
    fail 'persisted Web environment rollback file is missing'
  sudo -n test ! -L "$checkpoint_directory/web-env.before" ||
    fail 'persisted Web environment rollback file must not be a symlink'
  sudo -n cp -- "$checkpoint_directory/web-env.before" "$work/web-env.before"
  sudo -n chown "$(id -u):$(id -g)" "$work/web-env.before"
  chmod 0600 "$work/web-env.before"
  [[ "$(file_digest "$work/web-env.before")" == \
    "$(jq -er '.previous.files.webEnvironment.sha256' "$checkpoint")" ]] ||
    fail 'persisted Web environment rollback digest changed'
fi

previous_service=$(jq -r '.previous.webService // ""' "$checkpoint")
previous_source=$(jq -r '.previous.sourceSha // ""' "$checkpoint")
previous_release=$(jq -r '.previous.releaseId // ""' "$checkpoint")
previous_manifest=$(jq -r '.previous.manifestDigest // ""' "$checkpoint")
previous_canary_mode=$(jq -er '.previous.canaryMode' "$checkpoint")
previous_formal_mode=$(jq -er '.previous.formalMode' "$checkpoint")
candidate_service=$(jq -er '.candidate.webService' "$checkpoint")
checkpoint_digest=$(file_digest "$checkpoint")
rollback_journal="$checkpoint_directory/rollback-in-progress.json"
rollback_journal_stage="${rollback_journal}.staging"
rollback_resuming=0
all_candidate=1

node "$SCRIPT_DIR/release-nginx-route.mjs" rewrite \
  --input "$work/nginx-canary.before" \
  --output "$work/canary.candidate" \
  --contract production-canary \
  --target release >"$work/canary-candidate-route.json"
node "$SCRIPT_DIR/release-nginx-route.mjs" rewrite \
  --input "$work/nginx-formal.before" \
  --output "$work/formal.candidate" \
  --contract production-formal \
  --target release >"$work/formal-candidate-route.json"
[[ "$(file_digest "$work/canary.candidate")" == \
  "$(jq -er '.candidate.canaryNginxSha256' "$checkpoint")" ]] ||
  fail 'candidate canary Nginx cannot be reconstructed from its checkpoint'
[[ "$(file_digest "$work/formal.candidate")" == \
  "$(jq -er '.candidate.formalNginxSha256' "$checkpoint")" ]] ||
  fail 'candidate formal Nginx cannot be reconstructed from its checkpoint'
printf 'COMBO_RELEASE_WEB_SERVICE=%s\n' "$candidate_service" >"$work/web-env.candidate"
chmod 0600 "$work/web-env.candidate"

host_unit_root_real=$(realpath -e "$HOST_UNIT_ROOT")
for index in "${!UNITS[@]}"; do
  unit=${UNITS[$index]}
  candidate_unit="$HOST_UNIT_ROOT/$unit"
  candidate_unit_real=$(realpath -e "$candidate_unit")
  [[ "$candidate_unit_real" == "$host_unit_root_real/$unit" &&
    -f "$candidate_unit_real" && ! -L "$candidate_unit" ]] ||
    fail "candidate unit source escaped its release contract: $unit"
  [[ "$(file_digest "$candidate_unit_real")" == \
    "$(jq -er --arg name "$unit" '
      first(.previous.units[] | select(.name == $name) | .sha256)
    ' "$checkpoint")" ]] ||
    fail "candidate unit source changed after activation: $unit"
  install -m 0600 "$candidate_unit_real" "$work/unit-$index.candidate"
done

if sudo -n test -e "$rollback_journal_stage"; then
  if ! sudo -n test -f "$rollback_journal_stage" ||
    ! sudo -n test ! -L "$rollback_journal_stage"; then
    fail 'rollback journal staging path is unsafe'
  fi
  sudo -n rm -f -- "$rollback_journal_stage"
fi
if sudo -n test -e "$rollback_journal"; then
  if ! sudo -n test -f "$rollback_journal" ||
    ! sudo -n test ! -L "$rollback_journal"; then
    fail 'rollback journal is unsafe'
  fi
  sudo -n cp -- "$rollback_journal" "$work/rollback-in-progress.json"
  sudo -n chown "$(id -u):$(id -g)" "$work/rollback-in-progress.json"
  chmod 0600 "$work/rollback-in-progress.json"
  jq -e \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg checkpointDigest "$checkpoint_digest" '
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
    ' "$work/rollback-in-progress.json" >/dev/null ||
    fail 'rollback journal does not bind the activated checkpoint'
  rollback_resuming=1
fi

for path in "$NGINX_CONFIG" "$FORMAL_NGINX_CONFIG"; do
  sudo -n test -f "$path" || fail "rollback host file is missing: $path"
  sudo -n test ! -L "$path" || fail "rollback host file must not be a symlink: $path"
done
sudo -n cp -- "$NGINX_CONFIG" "$work/canary.live"
sudo -n cp -- "$FORMAL_NGINX_CONFIG" "$work/formal.live"
sudo -n chown "$(id -u):$(id -g)" "$work/canary.live" "$work/formal.live"
chmod 0600 "$work/canary.live" "$work/formal.live"
for name in canary formal; do
  live_digest=$(file_digest "$work/$name.live")
  candidate_digest=$(file_digest "$work/$name.candidate")
  previous_digest=$(file_digest "$work/nginx-$name.before")
  [[ "$live_digest" == "$candidate_digest" ||
    "$live_digest" == "$previous_digest" ]] ||
    fail "$name Nginx is outside the rollback checkpoint endpoints"
  [[ "$live_digest" == "$candidate_digest" ]] || all_candidate=0
done

if sudo -n test -e "$WEB_ENV"; then
  if ! sudo -n test -f "$WEB_ENV" || ! sudo -n test ! -L "$WEB_ENV"; then
    fail 'Web forward environment is unsafe during rollback recovery'
  fi
  sudo -n cp -- "$WEB_ENV" "$work/web-env.live"
  sudo -n chown "$(id -u):$(id -g)" "$work/web-env.live"
  chmod 0600 "$work/web-env.live"
  live_digest=$(file_digest "$work/web-env.live")
  candidate_digest=$(file_digest "$work/web-env.candidate")
  if [[ -n "$previous_service" ]]; then
    previous_digest=$(file_digest "$work/web-env.before")
    [[ "$live_digest" == "$candidate_digest" ||
      "$live_digest" == "$previous_digest" ]] ||
      fail 'Web forward environment is outside the rollback checkpoint endpoints'
  else
    [[ "$live_digest" == "$candidate_digest" ]] ||
      fail 'Web forward environment is outside the first-cutover endpoints'
  fi
  [[ "$live_digest" == "$candidate_digest" ]] || all_candidate=0
else
  [[ -z "$previous_service" ]] ||
    fail 'Web forward environment disappeared outside the rollback checkpoint'
  all_candidate=0
fi

for index in "${!UNITS[@]}"; do
  unit=${UNITS[$index]}
  unit_path="/etc/systemd/system/$unit"
  existed=$(jq -r --arg name "$unit" '
    first(.previous.units[] | select(.name == $name) | .existed)
  ' "$checkpoint")
  [[ "$existed" == true || "$existed" == false ]] ||
    fail "the persisted rollback unit existence is invalid: $unit"
  if sudo -n test -e "$unit_path"; then
    if ! sudo -n test -f "$unit_path" ||
      ! sudo -n test ! -L "$unit_path"; then
      fail "rollback unit path is unsafe: $unit"
    fi
    sudo -n cp -- "$unit_path" "$work/unit-$index.live"
    sudo -n chown "$(id -u):$(id -g)" "$work/unit-$index.live"
    chmod 0600 "$work/unit-$index.live"
    live_digest=$(file_digest "$work/unit-$index.live")
    candidate_digest=$(file_digest "$work/unit-$index.candidate")
    if [[ "$existed" == true ]]; then
      backup_file=$(jq -er --arg name "$unit" '
        first(.previous.units[] | select(.name == $name) | .backupFile)
      ' "$checkpoint")
      sudo -n cp -- "$checkpoint_directory/$backup_file" \
        "$work/unit-$index.previous"
      sudo -n chown "$(id -u):$(id -g)" "$work/unit-$index.previous"
      chmod 0600 "$work/unit-$index.previous"
      previous_digest=$(file_digest "$work/unit-$index.previous")
      [[ "$live_digest" == "$candidate_digest" ||
        "$live_digest" == "$previous_digest" ]] ||
        fail "unit is outside the rollback checkpoint endpoints: $unit"
    else
      [[ "$live_digest" == "$candidate_digest" ]] ||
        fail "unit is outside the first-cutover endpoints: $unit"
    fi
    [[ "$live_digest" == "$candidate_digest" ]] || all_candidate=0
  else
    [[ "$existed" == false ]] ||
      fail "rollback unit disappeared outside its checkpoint: $unit"
    all_candidate=0
  fi

  if [[ "$unit" == "$WEB_UNIT" ]]; then
    port=$WEB_PORT
  else
    port=$MINIO_PORT
  fi
  actual_active=false
  actual_enabled=false
  sudo -n systemctl is-active --quiet "$unit" && actual_active=true
  sudo -n systemctl is-enabled --quiet "$unit" && actual_enabled=true
  listener_lines=$(sudo -n ss -H -lntp "( sport = :$port )")
  if [[ "$actual_active" == true ]]; then
    main_pid=$(sudo -n systemctl show "$unit" --property=MainPID --value)
    [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] ||
      fail "rollback unit has no valid main process: $unit"
    if [[ "$(grep -c . <<<"$listener_lines" || true)" != 1 ]] ||
      ! grep -Eq "127\\.0\\.0\\.1:${port}[[:space:]].*pid=${main_pid}," \
        <<<"$listener_lines"; then
      fail "rollback unit listener is outside its process: $unit"
    fi
  else
    [[ -z "$listener_lines" ]] ||
      fail "inactive rollback unit still owns a listener: $unit"
  fi
  [[ "$actual_active" == true && "$actual_enabled" == true ]] ||
    all_candidate=0
done

if ((rollback_resuming == 0)); then
  ((all_candidate == 1)) ||
    fail 'rollback has no durable journal for the interrupted host state'
  jq -n \
    --arg sourceSha "$source_sha" \
    --arg releaseId "$release_id" \
    --arg manifestDigest "$MANIFEST_DIGEST" \
    --arg checkpointDigest "$checkpoint_digest" \
    --arg startedAt "$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')" '{
      schemaVersion: 1,
      status: "in-progress",
      direction: "rollback",
      environment: "production",
      sourceSha: $sourceSha,
      releaseId: $releaseId,
      manifestDigest: $manifestDigest,
      checkpointDigest: $checkpointDigest,
      startedAt: $startedAt
    }' >"$work/rollback-in-progress.json"
  chmod 0600 "$work/rollback-in-progress.json"
  atomic_root_install "$work/rollback-in-progress.json" "$rollback_journal" 0600
fi

transaction_armed=0
transaction_committed=0
rollback_checkpoint_committed=0

restore_active_candidate() {
  status 'rollback failed; converging the journaled host transaction to the candidate'
  (atomic_root_install "$work/canary.candidate" "$NGINX_CONFIG" 0644) || true
  (atomic_root_install "$work/formal.candidate" "$FORMAL_NGINX_CONFIG" 0644) || true
  (atomic_root_install "$work/web-env.candidate" "$WEB_ENV" 0644) || true
  local index unit
  for index in "${!UNITS[@]}"; do
    unit=${UNITS[$index]}
    (atomic_root_install "$work/unit-$index.candidate" \
      "/etc/systemd/system/$unit" 0644) || true
  done
  sudo -n systemctl daemon-reload >/dev/null 2>&1 || true
  for unit in "${UNITS[@]}"; do
    sudo -n systemctl enable "$unit" >/dev/null 2>&1 || true
    sudo -n systemctl restart "$unit" >/dev/null 2>&1 || true
  done
  sudo -n nginx -t >/dev/null 2>&1 || true
  sudo -n systemctl reload nginx >/dev/null 2>&1 || true
  (atomic_root_install "$checkpoint" "$checkpoint_host" 0600) || true
  (atomic_user_install "$work/current.active" "$current_state" 0600) || true
  rm -f -- "$EVIDENCE_OUTPUT" || true
}

cleanup() {
  local rc=$?
  trap - EXIT
  if ((rc != 0 && transaction_armed == 1 && transaction_committed == 0 &&
    rollback_checkpoint_committed == 0)); then
    restore_active_candidate
  elif ((rc != 0 && rollback_checkpoint_committed == 1)); then
    status 'rollback checkpoint is committed; preserving predecessor state for outer recovery'
  fi
  [[ -z "$evidence_stage" ]] || rm -f -- "$evidence_stage"
  rm -rf -- "$work"
  exit "$rc"
}
trap cleanup EXIT
transaction_armed=1

if [[ -n "$previous_service" ]]; then
  "${K[@]}" -n combo get "service/$previous_service" >/dev/null 2>&1 ||
    fail 'the previous Web Service no longer exists; rollback is sealed'
  "${K[@]}" -n combo get "deployment/$previous_service" -o json |
    jq -e \
      --arg sourceSha "$previous_source" \
      --arg releaseId "$previous_release" '
        .spec.template.metadata.annotations["combo.build/source-sha"] == $sourceSha
        and .spec.template.metadata.annotations["combo.build/release-id"] == $releaseId
      ' >/dev/null ||
    fail 'the previous Web workload no longer matches the rollback checkpoint'
else
  curl --fail --silent --show-error --max-time 10 \
    http://127.0.0.1:30080/ >/dev/null ||
    fail 'the legacy Web target is unavailable; rollback is sealed'
fi

node "$SCRIPT_DIR/release-nginx-route.mjs" rewrite \
  --input "$work/canary.candidate" \
  --output "$work/canary.rollback" \
  --contract production-canary \
  --target "$previous_canary_mode" >"$work/canary-rollback-route.json"
node "$SCRIPT_DIR/release-nginx-route.mjs" rewrite \
  --input "$work/formal.candidate" \
  --output "$work/formal.rollback" \
  --contract production-formal \
  --target "$previous_formal_mode" >"$work/formal-rollback-route.json"
cmp -s "$work/canary.rollback" "$work/nginx-canary.before" ||
  fail 'persisted canary Nginx is not the exact structured rollback result'
cmp -s "$work/formal.rollback" "$work/nginx-formal.before" ||
  fail 'persisted formal Nginx is not the exact structured rollback result'

for unit in "${UNITS[@]}"; do
  sudo -n systemctl stop "$unit"
done
for index in "${!UNITS[@]}"; do
  unit=${UNITS[$index]}
  existed=$(jq -r --arg name "$unit" '
    first(.previous.units[] | select(.name == $name) | .existed)
  ' "$checkpoint")
  [[ "$existed" == true || "$existed" == false ]] ||
    fail "the persisted rollback unit existence is invalid: $unit"
  if [[ "$existed" == true ]]; then
    backup_file=$(jq -er --arg name "$unit" '
      first(.previous.units[] | select(.name == $name) | .backupFile)
    ' "$checkpoint")
    [[ "$backup_file" =~ ^unit-[01]\.before$ ]] ||
      fail "the persisted rollback unit is missing: $unit"
    sudo -n test -f "$checkpoint_directory/$backup_file" ||
      fail "the persisted rollback unit is missing: $unit"
    sudo -n test ! -L "$checkpoint_directory/$backup_file" ||
      fail "the persisted rollback unit must not be a symlink: $unit"
    sudo -n cp -- "$checkpoint_directory/$backup_file" "$work/$backup_file"
    sudo -n chown "$(id -u):$(id -g)" "$work/$backup_file"
    chmod 0600 "$work/$backup_file"
    [[ "$(file_digest "$work/$backup_file")" == \
      "$(jq -er --arg name "$unit" '
        first(.previous.units[] | select(.name == $name) | .sha256)
      ' "$checkpoint")" ]] ||
      fail "the persisted rollback unit digest changed: $unit"
    atomic_root_install "$work/$backup_file" "/etc/systemd/system/$unit" 0644
  else
    sudo -n rm -f -- "/etc/systemd/system/$unit"
  fi
done
if [[ -n "$previous_service" ]]; then
  [[ "$(awk -F= '$1 == "COMBO_RELEASE_WEB_SERVICE" {print $2}' \
    "$work/web-env.before")" == "$previous_service" ]] ||
    fail 'persisted Web environment target changed'
  atomic_root_install "$work/web-env.before" "$WEB_ENV" 0644
else
  sudo -n rm -f -- "$WEB_ENV"
fi
sudo -n systemctl daemon-reload
for index in "${!UNITS[@]}"; do
  unit=${UNITS[$index]}
  enabled=$(jq -r --arg name "$unit" '
    first(.previous.units[] | select(.name == $name) | .enabled)
  ' "$checkpoint")
  active=$(jq -r --arg name "$unit" '
    first(.previous.units[] | select(.name == $name) | .active)
  ' "$checkpoint")
  [[ "$enabled" == true || "$enabled" == false ]] ||
    fail "the persisted rollback unit enablement is invalid: $unit"
  [[ "$active" == true || "$active" == false ]] ||
    fail "the persisted rollback unit activity is invalid: $unit"
  if [[ "$enabled" == true ]]; then
    sudo -n systemctl enable "$unit" >/dev/null
  else
    sudo -n systemctl disable "$unit" >/dev/null
  fi
  if [[ "$active" == true ]]; then
    sudo -n systemctl restart "$unit"
  fi
done

for index in "${!UNITS[@]}"; do
  unit=${UNITS[$index]}
  expected_enabled=$(jq -r --arg name "$unit" '
    first(.previous.units[] | select(.name == $name) | .enabled)
  ' "$checkpoint")
  expected_active=$(jq -r --arg name "$unit" '
    first(.previous.units[] | select(.name == $name) | .active)
  ' "$checkpoint")
  [[ "$expected_enabled" == true || "$expected_enabled" == false ]] ||
    fail "the persisted rollback unit enablement is invalid: $unit"
  [[ "$expected_active" == true || "$expected_active" == false ]] ||
    fail "the persisted rollback unit activity is invalid: $unit"
  actual_enabled=false
  actual_active=false
  sudo -n systemctl is-enabled --quiet "$unit" && actual_enabled=true
  sudo -n systemctl is-active --quiet "$unit" && actual_active=true
  [[ "$actual_enabled" == "$expected_enabled" &&
    "$actual_active" == "$expected_active" ]] ||
    fail "restored unit state differs from the checkpoint: $unit"
  existed=$(jq -r --arg name "$unit" '
    first(.previous.units[] | select(.name == $name) | .existed)
  ' "$checkpoint")
  [[ "$existed" == true || "$existed" == false ]] ||
    fail "the persisted rollback unit existence is invalid: $unit"
  if [[ "$existed" == true ]]; then
    expected_unit_sha=$(jq -er --arg name "$unit" '
      first(.previous.units[] | select(.name == $name) | .sha256)
    ' "$checkpoint")
    [[ "$(sudo -n sha256sum "/etc/systemd/system/$unit" |
      awk '{print "sha256:" $1}')" == "$expected_unit_sha" ]] ||
      fail "restored unit digest differs from the checkpoint: $unit"
  else
    sudo -n test ! -e "/etc/systemd/system/$unit" ||
      fail "restored absent unit unexpectedly exists: $unit"
  fi
  if [[ "$unit" == "$WEB_UNIT" ]]; then
    port=$WEB_PORT
  else
    port=$MINIO_PORT
  fi
  listener_lines=$(sudo -n ss -H -lntp "( sport = :$port )")
  if [[ "$expected_active" == true ]]; then
    main_pid=$(sudo -n systemctl show "$unit" --property=MainPID --value)
    [[ "$main_pid" =~ ^[1-9][0-9]*$ ]] ||
      fail "restored unit lacks a live main process: $unit"
    if [[ "$(grep -c . <<<"$listener_lines" || true)" != 1 ]] ||
      ! grep -Eq "127\\.0\\.0\\.1:${port}[[:space:]].*pid=${main_pid}," \
        <<<"$listener_lines"; then
      fail "restored unit lacks its single loopback listener: $unit"
    fi
  else
    [[ -z "$listener_lines" ]] ||
      fail "an inactive restored unit still owns a loopback listener: $unit"
  fi
done

atomic_root_install "$work/nginx-canary.before" "$NGINX_CONFIG" 0644
atomic_root_install "$work/nginx-formal.before" "$FORMAL_NGINX_CONFIG" 0644
sudo -n nginx -t >/dev/null
sudo -n systemctl reload nginx
[[ "$(sudo -n sha256sum "$NGINX_CONFIG" | awk '{print "sha256:" $1}')" == \
  "$(file_digest "$work/nginx-canary.before")" ]] ||
  fail 'restored canary Nginx digest changed'
[[ "$(sudo -n sha256sum "$FORMAL_NGINX_CONFIG" | awk '{print "sha256:" $1}')" == \
  "$(file_digest "$work/nginx-formal.before")" ]] ||
  fail 'restored formal Nginx digest changed'

public_version="$work/previous-version.json"
if [[ -n "$previous_source" ]]; then
  if [[ "$previous_formal_mode" == release ]]; then
    verification_origin=$FORMAL_ORIGIN
  else
    verification_origin=$CANARY_ORIGIN
  fi
  curl --fail --silent --show-error --max-time 20 \
    "$verification_origin/version.json" >"$public_version"
  jq -e \
    --arg sourceSha "$previous_source" \
    --arg releaseId "$previous_release" \
    --arg manifestDigest "$previous_manifest" '
      .sourceSha == $sourceSha
      and .releaseId == $releaseId
      and .releaseManifestDigest == $manifestDigest
    ' "$public_version" >/dev/null ||
    fail 'the previous public release did not recover after rollback'
else
  curl --fail --silent --show-error --max-time 20 \
    "$CANARY_ORIGIN/" >/dev/null ||
    fail 'Production canary did not recover its legacy target'
fi
curl --fail --silent --show-error --max-time 20 \
  "$S3_ORIGIN/minio/health/ready" >/dev/null ||
  fail 'Production S3 did not recover after rollback'

rolled_back_at=$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')
checkpoint_stage=$(mktemp "$work/checkpoint.rolled-back.XXXXXX")
jq --arg rolledBackAt "$rolled_back_at" '
  .status = "rolled-back"
  | .rolledBackAt = $rolledBackAt
' "$checkpoint" >"$checkpoint_stage"
chmod 0600 "$checkpoint_stage"

if [[ -n "$previous_source" ]]; then
  current_stage=$(mktemp "$state_directory/.current.XXXXXX")
  jq -n \
    --arg sourceSha "$previous_source" \
    --arg releaseId "$previous_release" \
    --arg manifestDigest "$previous_manifest" \
    --arg canarySha "$(sha256sum "$work/canary.rollback" | awk '{print "sha256:" $1}')" \
    --arg formalSha "$(sha256sum "$work/formal.rollback" | awk '{print "sha256:" $1}')" \
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
fi

evidence_stage=$(mktemp "$(dirname "$EVIDENCE_OUTPUT")/.rollback-evidence.XXXXXX")
jq -n \
  --arg sourceSha "$source_sha" \
  --arg releaseId "$release_id" \
  --arg manifestDigest "$MANIFEST_DIGEST" \
  --arg previousSourceSha "$previous_source" \
  --arg previousReleaseId "$previous_release" \
  --arg checkpointDigest "$(sha256sum "$checkpoint_stage" | awk '{print "sha256:" $1}')" \
  --arg rolledBackAt "$rolled_back_at" '{
    schemaVersion: 1,
    status: "passed",
    environment: "production",
    sourceSha: $sourceSha,
    releaseId: $releaseId,
    manifestDigest: $manifestDigest,
    restoredSourceSha: (if $previousSourceSha == "" then null else $previousSourceSha end),
    restoredReleaseId: (if $previousReleaseId == "" then null else $previousReleaseId end),
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
chmod 0600 "$evidence_stage"

atomic_root_install "$checkpoint_stage" "$checkpoint_host" 0600
rollback_checkpoint_committed=1
if [[ -n "$previous_source" ]]; then
  atomic_user_install "$current_stage" "$current_state" 0600
  rm -f -- "$current_stage"
else
  rm -f -- "$current_state"
fi
mv -fT "$evidence_stage" "$EVIDENCE_OUTPUT"
evidence_stage=''
jq -e \
  --arg checkpointDigest "$(sha256sum "$checkpoint_stage" | awk '{print "sha256:" $1}')" '
    .schemaVersion == 1
    and .status == "passed"
    and .environment == "production"
    and .checkpointDigest == $checkpointDigest
  ' "$EVIDENCE_OUTPUT" >/dev/null
jq -e '.status == "rolled-back"' "$checkpoint_stage" >/dev/null
[[ "$(sudo -n sha256sum "$checkpoint_host" | awk '{print "sha256:" $1}')" == \
  "$(sha256sum "$checkpoint_stage" | awk '{print "sha256:" $1}')" ]] ||
  fail 'rolled-back checkpoint commit could not be confirmed'
transaction_committed=1
sudo -n rm -f -- "$rollback_journal"

status "$release_id traffic rollback completed"
