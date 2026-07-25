#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly SCRIPT_DIR
readonly HOST_UNIT_ROOT="$SCRIPT_DIR/../infra/host/release"
readonly DIGEST_RE='^sha256:[0-9a-f]{64}$'
readonly SHA_RE='^[0-9a-f]{40}$'

ENVIRONMENT=''
MANIFEST=''
MANIFEST_DIGEST=''
EVIDENCE_OUTPUT=''
KUBECONFIG_PATH=${KUBECONFIG:-"$HOME/.kube/config"}

status() { printf '[release-traffic] %s\n' "$1" >&2; }
fail() {
  printf '[release-traffic] FAIL: %s\n' "$1" >&2
  exit 1
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
    PUBLIC_ORIGIN=https://review.43-160-242-46.sslip.io
    S3_ORIGIN=https://review-s3.43-160-242-46.sslip.io
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
    PUBLIC_ORIGIN=https://agora.43-160-242-46.sslip.io
    S3_ORIGIN=https://s3.43-160-242-46.sslip.io
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
readonly NGINX_CONFIG PUBLIC_ORIGIN S3_ORIGIN

for command in sudo systemctl ss awk grep sed cmp install mktemp sha256sum curl jq node \
  realpath stat id sleep seq dirname wc chmod cp rm date kubectl; do
  command -v "$command" >/dev/null 2>&1 || fail "missing host command: $command"
done
[[ "$(id -un)" == xingzheng ]] || fail 'traffic control must run as xingzheng'
[[ -f "$MANIFEST" && ! -L "$MANIFEST" ]] || fail 'manifest is not a regular file'
[[ "$MANIFEST_DIGEST" =~ $DIGEST_RE ]] || fail 'invalid manifest digest'
[[ -n "$EVIDENCE_OUTPUT" && ! -e "$EVIDENCE_OUTPUT" ]] ||
  fail 'traffic evidence output must not already exist'

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
work=$(mktemp -d)
nginx_backup="$work/nginx.before"
nginx_candidate="$work/nginx.candidate"
transaction_armed=0
transaction_committed=0
nginx_candidate_installed=0
declare -a UNIT_EXISTED UNIT_WAS_ACTIVE UNIT_WAS_ENABLED ENV_EXISTED

listener_lines() {
  sudo -n ss -H -lntp "( sport = :$1 )"
}

rollback_forwards() {
  local index unit env_file
  status 'restoring the previous loopback forward transaction'
  for index in "${!UNITS[@]}"; do
    unit=${UNITS[$index]}
    sudo -n systemctl stop "$unit" >/dev/null 2>&1 || true
    if [[ "${UNIT_EXISTED[$index]}" == 1 ]]; then
      sudo -n install -o root -g root -m 0644 \
        "$work/unit-$index.before" "/etc/systemd/system/$unit" || true
    else
      sudo -n rm -f -- "/etc/systemd/system/$unit" || true
    fi
    env_file=${ENV_FILES[$index]}
    if [[ -n "$env_file" ]]; then
      if [[ "${ENV_EXISTED[$index]}" == 1 ]]; then
        sudo -n install -o root -g root -m 0644 \
          "$work/env-$index.before" "$env_file" || true
      else
        sudo -n rm -f -- "$env_file" || true
      fi
    fi
  done
  sudo -n systemctl daemon-reload >/dev/null 2>&1 || true
  for index in "${!UNITS[@]}"; do
    unit=${UNITS[$index]}
    if [[ "${UNIT_WAS_ENABLED[$index]}" == 1 ]]; then
      sudo -n systemctl enable "$unit" >/dev/null 2>&1 || true
    else
      sudo -n systemctl disable "$unit" >/dev/null 2>&1 || true
    fi
    if [[ "${UNIT_WAS_ACTIVE[$index]}" == 1 ]]; then
      sudo -n systemctl restart "$unit" >/dev/null 2>&1 || true
    fi
  done
}

rollback_nginx() {
  status 'restoring the previous host Nginx configuration'
  sudo -n install -o root -g root -m 0644 "$nginx_backup" "$NGINX_CONFIG" || return
  sudo -n nginx -t >/dev/null || return
  sudo -n systemctl reload nginx || return
}

cleanup() {
  local rc=$?
  trap - EXIT
  if ((rc != 0 && transaction_armed == 1 && transaction_committed == 0)); then
    ((nginx_candidate_installed == 0)) || rollback_nginx || true
    rollback_forwards || true
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
  if sudo -n test -f "/etc/systemd/system/$unit"; then
    UNIT_EXISTED[index]=1
    sudo -n cp -- "/etc/systemd/system/$unit" "$work/unit-$index.before"
    sudo -n chown "$(id -u):$(id -g)" "$work/unit-$index.before"
    chmod 0600 "$work/unit-$index.before"
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
    ENV_EXISTED[index]=1
    sudo -n cp -- "$env_file" "$work/env-$index.before"
    sudo -n chown "$(id -u):$(id -g)" "$work/env-$index.before"
    chmod 0600 "$work/env-$index.before"
  else
    ENV_EXISTED[index]=0
  fi
done

sudo -n test -f "$NGINX_CONFIG" || fail 'expected host Nginx config is missing'
sudo -n test ! -L "$NGINX_CONFIG" || fail 'host Nginx config must not be a symlink'
sudo -n cp -- "$NGINX_CONFIG" "$nginx_backup"
sudo -n chown "$(id -u):$(id -g)" "$nginx_backup"
chmod 0600 "$nginx_backup"
transaction_armed=1

sudo -n install -d -o root -g root -m 0755 /etc/combo-release
for index in "${!UNITS[@]}"; do
  unit=${UNITS[$index]}
  sudo -n install -o root -g root -m 0644 \
    "$HOST_UNIT_ROOT/$unit" "/etc/systemd/system/$unit"
  env_file=${ENV_FILES[$index]}
  if [[ -n "$env_file" ]]; then
    env_candidate="$work/env-$index.candidate"
    printf 'COMBO_RELEASE_WEB_SERVICE=%s\n' "${SERVICES[$index]}" >"$env_candidate"
    chmod 0644 "$env_candidate"
    sudo -n install -o root -g root -m 0644 "$env_candidate" "$env_file"
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

preview_gate_ready() {
  local origin=$1 label=$2
  local headers="$work/$label-gate.headers" status_code
  curl --fail --silent --show-error --output /dev/null --max-time 15 \
    "$origin/__review/healthz" 2>/dev/null || return 1
  status_code=$(curl --silent --show-error --output /dev/null --dump-header "$headers" \
    --write-out '%{http_code}' --max-time 15 "$origin/version.json" 2>/dev/null) ||
    return 1
  [[ "$status_code" == 401 ]] || return 1
  grep -Eqi '^X-Combo-Review-Gate:[[:space:]]*required' "$headers"
}

preview_authenticated_metadata() {
  local origin=$1 output=$2
  # The gate token expands only inside the candidate Web container.
  # shellcheck disable=SC2016
  "${K[@]}" -n "$NAMESPACE" exec "deployment/${release_prefix}web" -- \
    sh -euc 'exec wget --header="Cookie: combo_review_access=$REVIEW_ACCESS_TOKEN" -qO- "$1/version.json"' \
    sh "$origin" >"$output"
  metadata_matches "$output"
}

loopback_origin="http://127.0.0.1:${PORTS[0]}"
if [[ "$ENVIRONMENT" == preview ]]; then
  preview_gate_ready "$loopback_origin" loopback ||
    fail 'loopback Preview Web gate is not healthy and closed'
  candidate_version="$work/candidate-version.json"
  preview_authenticated_metadata http://127.0.0.1 "$candidate_version" ||
    fail 'candidate Preview Web does not identify the release'
else
  loopback_version="$work/loopback-version.json"
  curl --fail --silent --show-error --max-time 15 \
    "$loopback_origin/version.json" >"$loopback_version"
  metadata_matches "$loopback_version" || fail 'loopback Web does not identify the release'
fi
curl --fail --silent --show-error --output /dev/null --max-time 15 \
  "http://127.0.0.1:${PORTS[1]}/minio/health/ready"

case "$ENVIRONMENT" in
  preview)
    grep -Eq 'server_name[[:space:]]+review\.43-160-242-46\.sslip\.io;' "$nginx_backup" ||
      fail 'Preview Nginx vhost identity changed'
    grep -Eq 'server_name[[:space:]]+review-s3\.43-160-242-46\.sslip\.io;' "$nginx_backup" ||
      fail 'Preview S3 Nginx vhost identity changed'
    old_web=$(grep -Ec 'proxy_pass http://127\.0\.0\.1:30081;' "$nginx_backup" || true)
    new_web=$(grep -Ec 'proxy_pass http://127\.0\.0\.1:18081;' "$nginx_backup" || true)
    old_s3=$(grep -Ec 'proxy_pass http://127\.0\.0\.1:30901;' "$nginx_backup" || true)
    new_s3=$(grep -Ec 'proxy_pass http://127\.0\.0\.1:19001;' "$nginx_backup" || true)
    ((old_web + new_web == 1 && old_s3 + new_s3 == 1)) ||
      fail 'Preview Nginx upstream set changed'
    ((old_web == 1 && old_s3 == 1 || new_web == 1 && new_s3 == 1)) ||
      fail 'Preview Nginx contains a partial traffic switch'
    sed \
      -e 's#proxy_pass http://127\.0\.0\.1:30081;#proxy_pass http://127.0.0.1:18081;#g' \
      -e 's#proxy_pass http://127\.0\.0\.1:30901;#proxy_pass http://127.0.0.1:19001;#g' \
      "$nginx_backup" >"$nginx_candidate"
    ;;
  production)
    grep -Eq 'server_name[[:space:]]+agora\.43-160-242-46\.sslip\.io;' "$nginx_backup" ||
      fail 'Production Nginx vhost identity changed'
    grep -Eq 'server_name[[:space:]]+s3\.43-160-242-46\.sslip\.io;' "$nginx_backup" ||
      fail 'Production S3 Nginx vhost identity changed'
    old_web=$(grep -Ec 'proxy_pass http://127\.0\.0\.1:30080;' "$nginx_backup" || true)
    new_web=$(grep -Ec 'proxy_pass http://127\.0\.0\.1:18082;' "$nginx_backup" || true)
    old_s3=$(grep -Ec 'proxy_pass http://127\.0\.0\.1:30900;' "$nginx_backup" || true)
    new_s3=$(grep -Ec 'proxy_pass http://127\.0\.0\.1:19002;' "$nginx_backup" || true)
    ((old_web + new_web == 3 && old_s3 + new_s3 == 1)) ||
      fail 'Production Nginx upstream set changed'
    ((old_web == 3 && old_s3 == 1 || new_web == 3 && new_s3 == 1)) ||
      fail 'Production Nginx contains a partial traffic switch'
    sed \
      -e 's#proxy_pass http://127\.0\.0\.1:30080;#proxy_pass http://127.0.0.1:18082;#g' \
      -e 's#proxy_pass http://127\.0\.0\.1:30900;#proxy_pass http://127.0.0.1:19002;#g' \
      "$nginx_backup" >"$nginx_candidate"
    ;;
esac

if ! cmp -s "$nginx_backup" "$nginx_candidate"; then
  sudo -n install -o root -g root -m 0644 "$nginx_candidate" "$NGINX_CONFIG"
  nginx_candidate_installed=1
  sudo -n nginx -t >/dev/null
  sudo -n systemctl reload nginx
fi

public_version="$work/public-version.json"
public_ok=0
for _ in $(seq 1 20); do
  if [[ "$ENVIRONMENT" == preview ]]; then
    if preview_gate_ready "$PUBLIC_ORIGIN" public; then
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
if [[ "$ENVIRONMENT" == preview ]]; then
  public_version="$work/public-version.json"
  preview_authenticated_metadata "$PUBLIC_ORIGIN" "$public_version" ||
    fail 'authenticated public Preview does not identify the release'
fi
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
nginx_sha=$(sudo -n sha256sum "$NGINX_CONFIG" | awk '{print "sha256:" $1}')
jq -n \
  --arg environment "$ENVIRONMENT" \
  --arg sourceSha "$source_sha" \
  --arg releaseId "$release_id" \
  --arg manifestDigest "$MANIFEST_DIGEST" \
  --arg publicOrigin "$PUBLIC_ORIGIN" \
  --arg s3Origin "$S3_ORIGIN" \
  --arg nginxConfig "$NGINX_CONFIG" \
  --arg nginxSha256 "$nginx_sha" \
  --arg activatedAt "$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')" \
  --slurpfile units "$unit_evidence" '{
    schemaVersion: 1,
    environment: $environment,
    sourceSha: $sourceSha,
    releaseId: $releaseId,
    manifestDigest: $manifestDigest,
    publicOrigin: $publicOrigin,
    s3Origin: (if $s3Origin == "" then null else $s3Origin end),
    nginx: {
      path: $nginxConfig,
      sha256: $nginxSha256
    },
    units: $units,
    checks: {
      loopbackWebRelease: true,
      loopbackMinioReady: true,
      publicWebRelease: true,
      publicMinioReady: true
    },
    activatedAt: $activatedAt
  }' >"$EVIDENCE_OUTPUT"
chmod 0644 "$EVIDENCE_OUTPUT"
transaction_committed=1
status "$ENVIRONMENT public traffic now identifies $release_id"
