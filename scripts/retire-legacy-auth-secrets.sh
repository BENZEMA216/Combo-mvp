#!/usr/bin/env bash
# Goal C administrator helper. It removes only the explicitly retired
# authentication keys and never reads or prints Secret values.
set -euo pipefail
set +x
umask 077

readonly CONFIRMATION='RETIRE-LEGACY-AUTH-AFTER-PRODUCTION'
readonly LEGACY_EXTERNAL_KEYS_CSV='LOGTO_ENDPOINT,LOGTO_ISSUER,LOGTO_JWKS_URI,LOGTO_APP_ID,LOGTO_APP_SECRET,LOGTO_AUDIENCE,LOGTO_REDIRECT_URI,LOGTO_ADMIN_ENDPOINT,LOGTO_DB,LOGTO_DB_ALTERATION_TARGET,LOGTO_MANAGEMENT_APP_ID,LOGTO_MANAGEMENT_APP_SECRET,LOGTO_BRANDING_LOGO_URL,LOGTO_BRANDING_DARK_LOGO_URL,LOGTO_BRANDING_FAVICON_URL,LOGTO_BRANDING_DARK_FAVICON_URL'
readonly LEGACY_DEV_KEYS_CSV='DEV_LOGIN_ENABLED,DEV_SESSION_SECRET'
readonly METADATA_TEMPLATE='go-template={{printf "%s\t%s\t%s" .metadata.uid .metadata.resourceVersion .type}}'

declare -Ar TARGET_NAMESPACE=(
  [test]=combo-preview
  [preview]=combo-review
  [production]=combo
)
declare -Ar TARGET_SECRET=(
  [test]=combo-dev-env
  [preview]=combo-preview-env
  [production]=combo-env
)
declare -a LEGACY_KEYS=()
declare -a ENVIRONMENTS=()

work=''
cleanup() {
  if [[ -n "$work" && -d "$work" ]]; then
    rm -rf -- "$work"
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

usage() {
  cat >&2 <<EOF
Usage: ${0##*/} --confirm=$CONFIRMATION <all|test|preview|production>
EOF
  exit 2
}

fail() {
  printf '[legacy-auth-retirement] FAIL: %s\n' "$1" >&2
  exit 1
}

resolve_environments() {
  case "$1" in
    all) ENVIRONMENTS=(test preview production) ;;
    test | preview | production) ENVIRONMENTS=("$1") ;;
    *) usage ;;
  esac
}

load_legacy_keys() {
  local combined key
  combined="$LEGACY_EXTERNAL_KEYS_CSV,$LEGACY_DEV_KEYS_CSV"
  IFS=',' read -r -a LEGACY_KEYS <<<"$combined"
  ((${#LEGACY_KEYS[@]} > 0)) || fail 'the legacy key allowlist is empty'
  for key in "${LEGACY_KEYS[@]}"; do
    [[ "$key" =~ ^[A-Z][A-Z0-9_]*$ ]] ||
      fail 'the legacy key allowlist is invalid'
  done
  [[ "$(printf '%s\n' "${LEGACY_KEYS[@]}" | LC_ALL=C sort -u | wc -l)" == \
    "${#LEGACY_KEYS[@]}" ]] || fail 'the legacy key allowlist contains duplicates'
}

read_metadata() {
  local environment=$1 namespace secret metadata uid rv type extra
  namespace=${TARGET_NAMESPACE[$environment]}
  secret=${TARGET_SECRET[$environment]}
  if ! metadata=$(kubectl -n "$namespace" get secret "$secret" \
    --output="$METADATA_TEMPLATE" 2>/dev/null); then
    fail "Secret metadata read failed: $environment"
  fi
  IFS=$'\t' read -r uid rv type extra <<<"$metadata"
  [[ -n "$uid" && -n "$rv" && "$type" == Opaque && -z "$extra" &&
    "$uid" != *$'\n'* && "$rv" != *$'\n'* ]] ||
    fail "unexpected Secret metadata: $environment"
  METADATA_UID=$uid
  METADATA_RV=$rv
  METADATA_TYPE=$type
}

preflight_environment() {
  local environment=$1 namespace secret permission
  namespace=${TARGET_NAMESPACE[$environment]}
  secret=${TARGET_SECRET[$environment]}

  if ! permission=$(kubectl auth can-i get "secret/$secret" \
    -n "$namespace" 2>/dev/null) || [[ "$permission" != yes ]]; then
    fail "missing exact Secret get permission: $environment"
  fi
  if ! permission=$(kubectl auth can-i patch "secret/$secret" \
    -n "$namespace" 2>/dev/null) || [[ "$permission" != yes ]]; then
    fail "missing exact Secret patch permission: $environment"
  fi
  read_metadata "$environment"
  PREFLIGHT_UID[$environment]=$METADATA_UID
  PREFLIGHT_RV[$environment]=$METADATA_RV
}

write_remove_patch() {
  local uid=$1 rv=$2 key=$3
  jq -cn \
    --arg uid "$uid" \
    --arg rv "$rv" \
    --arg path "/data/$key" '
      [
        {"op":"test","path":"/metadata/uid","value":$uid},
        {"op":"test","path":"/metadata/resourceVersion","value":$rv},
        {"op":"test","path":"/type","value":"Opaque"},
        {"op":"remove","path":$path}
      ]
    '
}

# RESULT_RV is the only output. A failed remove is accepted as an idempotent
# absence only when the API reports the exact RFC 6902 missing-path condition
# and the metadata resourceVersion stayed put.
remove_key_or_confirm_absent() {
  local environment=$1 expected_uid=$2 expected_rv=$3 key=$4
  local namespace secret error_file rc
  namespace=${TARGET_NAMESPACE[$environment]}
  secret=${TARGET_SECRET[$environment]}
  error_file="$work/$environment.patch-error"
  : >"$error_file"
  RESULT_RV=$expected_rv

  if write_remove_patch "$expected_uid" "$expected_rv" "$key" |
    kubectl -n "$namespace" patch secret "$secret" \
      --type=json --patch-file=/dev/stdin >/dev/null 2>"$error_file"; then
    read_metadata "$environment"
    [[ "$METADATA_UID" == "$expected_uid" && "$METADATA_TYPE" == Opaque ]] ||
      fail "Secret identity changed during retirement: $environment"
    [[ "$METADATA_RV" != "$expected_rv" ]] ||
      fail "Secret resourceVersion did not change after retirement: $environment"
    RESULT_RV=$METADATA_RV
    return 0
  else
    rc=$?
  fi

  read_metadata "$environment"
  [[ "$METADATA_UID" == "$expected_uid" && "$METADATA_TYPE" == Opaque ]] ||
    fail "Secret identity changed during retirement: $environment"
  if [[ "$METADATA_RV" != "$expected_rv" ]]; then
    RESULT_RV=$METADATA_RV
    return 3
  fi
  if LC_ALL=C grep -Eq \
    'remove operation does not apply:[[:space:]]*doc is missing path:.*missing value' \
    "$error_file" &&
    LC_ALL=C grep -Fq \
      "doc is missing path: \"/data/$key\": missing value" \
      "$error_file"; then
    return 2
  fi
  ((rc == 0)) || fail "atomic Secret patch failed: $environment"
  fail "unexpected Secret patch result: $environment"
}

retire_environment() {
  local environment=$1 expected_uid initial_rv current_rv key
  local pass retry rc key_resolved pass_changed pass_concurrent
  local changed_any=0 changed_label rv_changed
  expected_uid=${PREFLIGHT_UID[$environment]}
  initial_rv=${PREFLIGHT_RV[$environment]}

  read_metadata "$environment"
  [[ "$METADATA_UID" == "$expected_uid" && "$METADATA_TYPE" == Opaque ]] ||
    fail "Secret identity changed after preflight: $environment"
  current_rv=$METADATA_RV

  for ((pass = 0; pass < 8; pass += 1)); do
    pass_changed=0
    pass_concurrent=0
    for key in "${LEGACY_KEYS[@]}"; do
      key_resolved=0
      for ((retry = 0; retry < 8; retry += 1)); do
        if remove_key_or_confirm_absent \
          "$environment" "$expected_uid" "$current_rv" "$key"; then
          current_rv=$RESULT_RV
          pass_changed=1
          changed_any=1
          key_resolved=1
          break
        else
          rc=$?
        fi
        case "$rc" in
          2)
            current_rv=$RESULT_RV
            key_resolved=1
            break
            ;;
          3)
            current_rv=$RESULT_RV
            pass_concurrent=1
            ;;
          *)
            fail "unexpected Secret retirement state: $environment"
            ;;
        esac
      done
      ((key_resolved == 1)) ||
        fail "Secret changed too often during retirement: $environment"
    done

    read_metadata "$environment"
    [[ "$METADATA_UID" == "$expected_uid" && "$METADATA_TYPE" == Opaque ]] ||
      fail "Secret identity changed during final verification: $environment"
    if [[ "$METADATA_RV" != "$current_rv" ]]; then
      current_rv=$METADATA_RV
      pass_concurrent=1
    fi
    if ((pass_changed == 0 && pass_concurrent == 0)); then
      rv_changed=false
      [[ "$current_rv" == "$initial_rv" ]] || rv_changed=true
      if ((changed_any == 1)); then
        [[ "$rv_changed" == true ]] ||
          fail "Secret resourceVersion verification failed: $environment"
        changed_label=true
      else
        changed_label=false
      fi
      printf 'legacy_auth_retired environment=%s namespace=%s name=%s changed=%s uid_unchanged=true resourceVersion_changed=%s legacy_keys_absent=true unrelated_keys_preserved_by_exact_patch=true\n' \
        "$environment" "${TARGET_NAMESPACE[$environment]}" \
        "${TARGET_SECRET[$environment]}" "$changed_label" "$rv_changed"
      return 0
    fi
  done
  fail "Secret did not reach a stable retired state: $environment"
}

(($# == 2)) || usage
[[ "$1" == "--confirm=$CONFIRMATION" ]] || usage
resolve_environments "$2"

for command in kubectl jq grep sort wc mktemp rm; do
  command -v "$command" >/dev/null 2>&1 || fail "missing command: $command"
done
load_legacy_keys
work=$(mktemp -d)
chmod 0700 "$work"

declare -A PREFLIGHT_UID=()
declare -A PREFLIGHT_RV=()
for environment in "${ENVIRONMENTS[@]}"; do
  preflight_environment "$environment"
done
for environment in "${ENVIRONMENTS[@]}"; do
  retire_environment "$environment"
done
