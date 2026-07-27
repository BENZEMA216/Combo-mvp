#!/usr/bin/env bash
# Interactive administrator helper. Secret values are read without echo, passed only on stdin,
# and never written to arguments, dotenv files, logs, or temporary files.
set -euo pipefail
set +x

usage() {
  printf 'usage:\n' >&2
  printf '  %s github <all|combo-dev|cloud-review|production>\n' "${0##*/}" >&2
  printf '  %s kubernetes <all|test|preview|production>\n' "${0##*/}" >&2
  exit 2
}

clear_values() {
  resend_key=''
}
trap clear_values EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

prompt_hidden() {
  local destination=$1 prompt=$2 value
  IFS= read -r -s -p "$prompt" value
  printf '\n' >&2
  [[ -n "$value" && "$value" != *$'\n'* && "$value" != *$'\r'* ]] || {
    printf 'empty or invalid input\n' >&2
    exit 1
  }
  printf -v "$destination" '%s' "$value"
}

validate_acceptance_resend_key() {
  command -v node >/dev/null 2>&1 || {
    printf 'node is required\n' >&2
    exit 1
  }
  if ! ACCEPTANCE_RESEND_API_KEY="$resend_key" \
    node "$script_dir/resend-sent-email.mjs" --validate-key >/dev/null 2>&1; then
    printf 'Resend sent-email permission validation failed; GitHub was not changed\n' >&2
    exit 1
  fi
}

configure_github() {
  local target=$1 environment
  local -a environments
  case "$target" in
    all) environments=(combo-dev cloud-review production) ;;
    combo-dev | cloud-review | production) environments=("$target") ;;
    *) usage ;;
  esac
  command -v gh >/dev/null 2>&1 || {
    printf 'gh is required\n' >&2
    exit 1
  }

  # Prove every destination exists before accepting or writing a credential.
  for environment in "${environments[@]}"; do
    if ! gh api --silent \
      "repos/dangdang-tech/Combo/environments/$environment" >/dev/null 2>&1; then
      printf 'GitHub Environment preflight failed: %s\n' "$environment" >&2
      exit 1
    fi
  done

  prompt_hidden resend_key 'Full-access Resend API key (hidden): '
  [[ "$resend_key" =~ ^re_[A-Za-z0-9_-]{16,252}$ ]] || {
    printf 'invalid Resend API key shape\n' >&2
    exit 1
  }
  validate_acceptance_resend_key

  for environment in "${environments[@]}"; do
    if ! printf '%s' "$resend_key" |
      gh secret set --repo dangdang-tech/Combo --env "$environment" \
        ACCEPTANCE_RESEND_API_KEY >/dev/null; then
      printf 'GitHub Environment Secret update failed: %s\n' "$environment" >&2
      exit 1
    fi
    printf 'github_environment_secret_updated environment=%s name=ACCEPTANCE_RESEND_API_KEY\n' \
      "$environment"
  done
  resend_key=''
}

resolve_kubernetes_target() {
  local environment=$1
  case "$environment" in
    test)
      printf '%s %s\n' combo-preview combo-dev-env
      ;;
    preview)
      printf '%s %s\n' combo-review combo-preview-env
      ;;
    production)
      printf '%s %s\n' combo combo-env
      ;;
    *)
      usage
      ;;
  esac
}

preflight_kubernetes_environment() {
  local environment=$1 namespace secret uid rv type
  read -r namespace secret < <(resolve_kubernetes_target "$environment")
  [[ "$(kubectl auth can-i get "secret/$secret" -n "$namespace")" == yes &&
    "$(kubectl auth can-i patch "secret/$secret" -n "$namespace")" == yes ]] || {
    printf 'missing exact Secret get/patch permission: %s\n' "$environment" >&2
    exit 1
  }
  uid=$(kubectl -n "$namespace" get secret "$secret" -o jsonpath='{.metadata.uid}')
  rv=$(kubectl -n "$namespace" get secret "$secret" \
    -o jsonpath='{.metadata.resourceVersion}')
  type=$(kubectl -n "$namespace" get secret "$secret" -o jsonpath='{.type}')
  [[ -n "$uid" && -n "$rv" && "$type" == Opaque ]] || {
    printf 'unexpected Secret metadata: %s\n' "$environment" >&2
    exit 1
  }
}

patch_kubernetes_environment() {
  local environment=$1 namespace secret before_uid before_rv before_type
  local after_uid after_rv
  read -r namespace secret < <(resolve_kubernetes_target "$environment")

  before_uid=$(kubectl -n "$namespace" get secret "$secret" -o jsonpath='{.metadata.uid}')
  before_rv=$(kubectl -n "$namespace" get secret "$secret" \
    -o jsonpath='{.metadata.resourceVersion}')
  before_type=$(kubectl -n "$namespace" get secret "$secret" -o jsonpath='{.type}')
  [[ -n "$before_uid" && -n "$before_rv" && "$before_type" == Opaque ]] || {
    printf 'unexpected Secret metadata: %s\n' "$environment" >&2
    exit 1
  }

  # Python generates a fresh, independent OTP secret and three URL-safe role
  # passwords for this environment. Generated values flow only into kubectl stdin.
  if ! printf '%s\0%s\0%s\0' "$resend_key" "$before_uid" "$before_rv" |
    python3 -c '
import base64, json, secrets, sys
parts = sys.stdin.buffer.read().split(b"\0")
if len(parts) != 4 or parts[-1] != b"":
    raise SystemExit(2)
resend, uid, rv = parts[:-1]
generated = [secrets.token_urlsafe(48)] + [
    secrets.token_urlsafe(36) for _ in range(3)
]
if len(set(generated)) != 4:
    raise SystemExit(2)
otp, api, worker, runtime = (value.encode("ascii") for value in generated)
encode = lambda value: base64.b64encode(value).decode("ascii")
patch = [
    {"op": "test", "path": "/metadata/uid", "value": uid.decode()},
    {"op": "test", "path": "/metadata/resourceVersion", "value": rv.decode()},
    {"op": "test", "path": "/type", "value": "Opaque"},
    {"op": "add", "path": "/data/RESEND_API_KEY", "value": encode(resend)},
    {"op": "add", "path": "/data/OTP_HMAC_SECRET", "value": encode(otp)},
    {"op": "add", "path": "/data/POSTGRES_API_PASSWORD", "value": encode(api)},
    {"op": "add", "path": "/data/POSTGRES_WORKER_PASSWORD", "value": encode(worker)},
    {"op": "add", "path": "/data/POSTGRES_RUNTIME_PASSWORD", "value": encode(runtime)},
]
sys.stdout.write(json.dumps(patch, separators=(",", ":")))
' |
    kubectl -n "$namespace" patch secret "$secret" --type=json \
      --patch-file=/dev/stdin >/dev/null 2>&1; then
    printf 'atomic Secret patch failed: %s\n' "$environment" >&2
    exit 1
  fi

  after_uid=$(kubectl -n "$namespace" get secret "$secret" -o jsonpath='{.metadata.uid}')
  after_rv=$(kubectl -n "$namespace" get secret "$secret" \
    -o jsonpath='{.metadata.resourceVersion}')
  [[ "$after_uid" == "$before_uid" && "$after_rv" != "$before_rv" ]] || {
    printf 'Secret identity/version verification failed: %s\n' "$environment" >&2
    exit 1
  }
  printf 'kubernetes_secret_updated environment=%s namespace=%s name=%s uid_unchanged=true resourceVersion_changed=true\n' \
    "$environment" "$namespace" "$secret"
}

configure_kubernetes() {
  local target=$1 environment
  local -a environments
  case "$target" in
    all) environments=(test preview production) ;;
    test | preview | production) environments=("$target") ;;
    *) usage ;;
  esac
  command -v kubectl >/dev/null 2>&1 || {
    printf 'kubectl is required\n' >&2
    exit 1
  }
  command -v python3 >/dev/null 2>&1 || {
    printf 'python3 is required\n' >&2
    exit 1
  }

  # Complete all permission/existence checks before the first mutation.
  for environment in "${environments[@]}"; do
    preflight_kubernetes_environment "$environment"
  done
  prompt_hidden resend_key 'Resend sending API key (hidden): '
  [[ "$resend_key" =~ ^re_[A-Za-z0-9_-]{16,252}$ ]] || {
    printf 'invalid Resend API key shape\n' >&2
    exit 1
  }
  for environment in "${environments[@]}"; do
    patch_kubernetes_environment "$environment"
  done
  resend_key=''
}

script_dir=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
(($# == 2)) || usage
case "$1" in
  github) configure_github "$2" ;;
  kubernetes) configure_kubernetes "$2" ;;
  *) usage ;;
esac
