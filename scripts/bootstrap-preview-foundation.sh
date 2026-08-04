#!/usr/bin/env bash
# One-time, fail-closed Preview foundation bootstrap. Secret values stay in process memory/stdin.
set -euo pipefail
set +x

usage() {
  printf 'usage: %s <--bootstrap|--verify>\n' "${0##*/}" >&2
  exit 2
}

MODE=${1:-}
case "$MODE" in
  --bootstrap | --verify) ;;
  *) usage ;;
esac

for command in kubectl python3; do
  command -v "$command" >/dev/null 2>&1 || {
    printf '%s is required\n' "$command" >&2
    exit 1
  }
done

FOUNDATION_NAMESPACE=combo-preview-foundation

if ! kubectl get namespace "$FOUNDATION_NAMESPACE" >/dev/null 2>&1; then
  [[ "$MODE" == --bootstrap ]] || {
    printf 'Preview foundation namespace is missing; run --bootstrap first\n' >&2
    exit 1
  }
  kubectl create namespace "$FOUNDATION_NAMESPACE" >/dev/null
fi
if [[ "$MODE" == --bootstrap ]]; then
  kubectl label namespace "$FOUNDATION_NAMESPACE" \
    combo.build/environment=preview combo.build/foundation=preview --overwrite >/dev/null
else
  [[ "$(kubectl get namespace "$FOUNDATION_NAMESPACE" \
    -o jsonpath='{.metadata.labels.combo\.build/environment}')" == preview && \
    "$(kubectl get namespace "$FOUNDATION_NAMESPACE" \
      -o jsonpath='{.metadata.labels.combo\.build/foundation}')" == preview ]] || {
    printf 'Preview foundation namespace labels are missing\n' >&2
    exit 1
  }
fi

if [[ "$MODE" == --bootstrap ]] && \
  ! kubectl -n "$FOUNDATION_NAMESPACE" get secret combo-env >/dev/null 2>&1; then
  if [[ -n "$(kubectl -n "$FOUNDATION_NAMESPACE" get statefulset,pvc -o name 2>/dev/null)" ]]; then
    printf 'Preview foundation has persistent resources but no combo-env Secret; refusing rotation\n' >&2
    exit 1
  fi
fi

BOOTSTRAP_MODE=${MODE#--} python3 <<'PY'
import base64
import datetime
import hashlib
import hmac
import json
import os
import secrets
import subprocess
import sys
import urllib.error
import urllib.request

app_namespace = "combo-preview"
foundation_namespace = "combo-preview-foundation"
production_app_namespace = "combo-prod"
production_foundation_namespace = "combo-foundation"
mode = os.environ["BOOTSTRAP_MODE"]
name = "combo-env"
preview_s3_public_endpoint = "https://review-s3.43-160-242-46.sslip.io"
production_s3_endpoint = "https://s3.43-160-242-46.sslip.io"

shared_keys = ["POSTGRES_PASSWORD", "S3_ACCESS_KEY", "S3_SECRET_KEY"]
app_only_keys = [
    "POSTGRES_API_PASSWORD",
    "POSTGRES_WORKER_PASSWORD",
    "POSTGRES_RUNTIME_PASSWORD",
    "OTP_HMAC_SECRET",
]
identity_keys = ["POSTGRES_USER", "POSTGRES_DB"]
public_keys = ["S3_PUBLIC_ENDPOINT"]


def kubectl(*args, input_text=None, check=True):
    return subprocess.run(
        ["kubectl", *args],
        input=input_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=check,
    )


def get_secret(namespace, required=True):
    result = kubectl("-n", namespace, "get", "secret", name, "-o", "json", check=False)
    if result.returncode != 0:
        if required:
            raise SystemExit(f"required Secret is missing in {namespace}")
        return None
    return json.loads(result.stdout)


def fresh(size=48):
    return base64.b64encode(secrets.token_urlsafe(size).encode("ascii")).decode("ascii")


def encoded(value):
    return base64.b64encode(value.encode("utf-8")).decode("ascii")


def decoded(value):
    return base64.b64decode(value).decode("utf-8")


def production_s3_rejects_preview_credentials(app_secret):
    access_key = decoded(app_secret["data"]["S3_ACCESS_KEY"])
    secret_key = decoded(app_secret["data"]["S3_SECRET_KEY"])
    now = datetime.datetime.now(datetime.timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    region = "us-east-1"
    service = "s3"
    host = "s3.43-160-242-46.sslip.io"
    payload_hash = hashlib.sha256(b"").hexdigest()
    canonical_headers = (
        f"host:{host}\n"
        f"x-amz-content-sha256:{payload_hash}\n"
        f"x-amz-date:{amz_date}\n"
    )
    signed_headers = "host;x-amz-content-sha256;x-amz-date"
    canonical_request = "\n".join(
        ["GET", "/", "", canonical_headers, signed_headers, payload_hash]
    )
    credential_scope = f"{date_stamp}/{region}/{service}/aws4_request"
    string_to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            amz_date,
            credential_scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ]
    )

    def sign(key, message):
        return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()

    date_key = sign(("AWS4" + secret_key).encode("utf-8"), date_stamp)
    region_key = sign(date_key, region)
    service_key = sign(region_key, service)
    signing_key = sign(service_key, "aws4_request")
    signature = hmac.new(
        signing_key, string_to_sign.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    authorization = (
        f"AWS4-HMAC-SHA256 Credential={access_key}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )
    request = urllib.request.Request(
        f"{production_s3_endpoint}/",
        method="GET",
        headers={
            "Authorization": authorization,
            "Host": host,
            "x-amz-content-sha256": payload_hash,
            "x-amz-date": amz_date,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            raise SystemExit(
                f"Preview credentials reached Production S3 with HTTP {response.status}"
            )
    except urllib.error.HTTPError as error:
        if error.code != 403:
            raise SystemExit(
                f"Production S3 credential rejection returned HTTP {error.code}"
            )
    except urllib.error.URLError:
        raise SystemExit("Production S3 credential rejection probe could not connect")


app = get_secret(app_namespace)
production_app = get_secret(production_app_namespace)
production_foundation = get_secret(production_foundation_namespace)
foundation = get_secret(foundation_namespace, required=False)

for key in identity_keys + shared_keys + app_only_keys + public_keys:
    if key not in app.get("data", {}):
        raise SystemExit(f"Preview app Secret lacks required key {key}")
for key in shared_keys:
    if key not in production_foundation.get("data", {}):
        raise SystemExit(f"Production foundation Secret lacks required key {key}")

if foundation is None:
    if mode != "bootstrap":
        raise SystemExit("Preview foundation Secret is missing; run --bootstrap first")
    foundation_data = {key: app["data"][key] for key in identity_keys}
    foundation_data.update({key: fresh() for key in shared_keys})
    manifest = {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {
            "name": name,
            "namespace": foundation_namespace,
            "annotations": {"combo.build/bootstrap": "preview-foundation-v1"},
        },
        "type": "Opaque",
        "data": foundation_data,
    }
    applied = kubectl("apply", "-f", "-", input_text=json.dumps(manifest))
    if applied.returncode != 0:
        raise SystemExit("failed to create Preview foundation Secret")
    foundation = get_secret(foundation_namespace)

for key in identity_keys + shared_keys:
    if key not in foundation.get("data", {}):
        raise SystemExit(f"Preview foundation Secret lacks required key {key}")

if mode == "bootstrap":
    desired = {key: foundation["data"][key] for key in shared_keys}
    for key in app_only_keys:
        current = app["data"].get(key)
        production = production_app.get("data", {}).get(key)
        desired[key] = fresh() if current is None or current == production else current
    desired.update({key: foundation["data"][key] for key in identity_keys})
    desired["S3_PUBLIC_ENDPOINT"] = encoded(preview_s3_public_endpoint)
    patch = [
        {"op": "test", "path": "/metadata/uid", "value": app["metadata"]["uid"]},
        {
            "op": "test",
            "path": "/metadata/resourceVersion",
            "value": app["metadata"]["resourceVersion"],
        },
        {"op": "test", "path": "/type", "value": "Opaque"},
    ]
    patch.extend(
        {"op": "add", "path": f"/data/{key}", "value": value}
        for key, value in desired.items()
    )
    updated = kubectl(
        "-n",
        app_namespace,
        "patch",
        "secret",
        name,
        "--type=json",
        "--patch-file=/dev/stdin",
        input_text=json.dumps(patch, separators=(",", ":")),
        check=False,
    )
    if updated.returncode != 0:
        raise SystemExit("failed to reconcile Preview app Secret")
    app = get_secret(app_namespace)

for key in identity_keys + shared_keys:
    if app["data"].get(key) != foundation["data"].get(key):
        raise SystemExit(f"Preview app/foundation Secret mismatch for {key}")
for key in shared_keys:
    if foundation["data"].get(key) == production_foundation["data"].get(key):
        raise SystemExit(f"Preview and Production foundation share {key}")
for key in shared_keys + app_only_keys:
    if app["data"].get(key) == production_app.get("data", {}).get(key):
        raise SystemExit(f"Preview and Production app share {key}")
if app["data"].get("S3_PUBLIC_ENDPOINT") != encoded(preview_s3_public_endpoint):
    raise SystemExit("Preview S3 public endpoint is not the isolated review endpoint")

production_s3_rejects_preview_credentials(app)

print(
    "preview_foundation_secret_verified "
    "app_namespace=combo-preview foundation_namespace=combo-preview-foundation "
    "shared_keys_match=true production_keys_distinct=true production_s3_denied=true"
)
PY
