#!/bin/sh
set -eu

fail() {
  printf '%s\n' "combo web runtime config: $1" >&2
  exit 1
}

case "${COMBO_ENVIRONMENT:-}" in
  development | test | preview | production) ;;
  *) fail 'invalid COMBO_ENVIRONMENT' ;;
esac

source_sha=${COMBO_SOURCE_SHA:-}
[ "${#source_sha}" -eq 40 ] ||
  fail 'COMBO_SOURCE_SHA must be 40 lowercase hexadecimal characters'
case "$source_sha" in
  *[!0-9a-f]*) fail 'COMBO_SOURCE_SHA must be 40 lowercase hexadecimal characters' ;;
esac

[ "${COMBO_RELEASE_ID:-}" = "release-${COMBO_SOURCE_SHA}" ] ||
  fail 'COMBO_RELEASE_ID must match COMBO_SOURCE_SHA'

case "${COMBO_BUILT_AT:-}" in
  ????-??-??T??:??:??.???Z) ;;
  *) fail 'COMBO_BUILT_AT must be a UTC timestamp with milliseconds' ;;
esac

validate_digest() {
  name=$1
  value=$2
  [ "${#value}" -eq 71 ] || fail "$name must be a lowercase sha256 digest"
  case "$value" in
    sha256:*)
      suffix=${value#sha256:}
      case "$suffix" in *[!0-9a-f]*) fail "$name must be a lowercase sha256 digest" ;; esac
      ;;
    *) fail "$name must be a lowercase sha256 digest" ;;
  esac
}

validate_digest COMBO_RELEASE_MANIFEST_DIGEST "${COMBO_RELEASE_MANIFEST_DIGEST:-}"
validate_digest COMBO_WEB_ASSET_MANIFEST "${COMBO_WEB_ASSET_MANIFEST:-}"

asset_file=/usr/share/nginx/html/web-asset-manifest.json
[ -f "$asset_file" ] && [ ! -L "$asset_file" ] || fail 'web asset manifest is missing'
actual_asset_digest="sha256:$(sha256sum "$asset_file" | awk '{print $1}')"

if [ "$COMBO_ENVIRONMENT" = development ] &&
  [ "$COMBO_WEB_ASSET_MANIFEST" = "sha256:0000000000000000000000000000000000000000000000000000000000000000" ]; then
  COMBO_WEB_ASSET_MANIFEST=$actual_asset_digest
elif [ "$actual_asset_digest" != "$COMBO_WEB_ASSET_MANIFEST" ]; then
  fail 'Web asset manifest digest does not match the release'
fi

umask 022
runtime_directory=/var/run/combo-web
mkdir -p "$runtime_directory"
[ -d "$runtime_directory" ] && [ ! -L "$runtime_directory" ] ||
  fail 'runtime metadata directory is unsafe'
chmod 0755 "$runtime_directory"

for output in \
  "$runtime_directory/runtime-config.json" \
  "$runtime_directory/version.json" \
  "$runtime_directory/try-runtime-config.json"; do
  {
    printf '{\n'
    printf '  "schemaVersion": 1,\n'
    printf '  "environment": "%s",\n' "$COMBO_ENVIRONMENT"
    printf '  "sourceSha": "%s",\n' "$COMBO_SOURCE_SHA"
    printf '  "releaseId": "%s",\n' "$COMBO_RELEASE_ID"
    printf '  "builtAt": "%s",\n' "$COMBO_BUILT_AT"
    printf '  "releaseManifestDigest": "%s",\n' "$COMBO_RELEASE_MANIFEST_DIGEST"
    printf '  "webAssetManifest": "%s"\n' "$COMBO_WEB_ASSET_MANIFEST"
    printf '}\n'
  } >"$output"
  chmod 0644 "$output"
done
