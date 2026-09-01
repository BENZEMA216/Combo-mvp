#!/usr/bin/env bash
# 第一方邮件验证码认证的唯一完整本地端到端入口。
# 真实浏览器与 API 级反向用例共用一次临时 Compose 栈；所有凭据、邮箱、验证码和 Cookie 只存在于受限临时目录与进程环境。
set -Eeuo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

fail() {
  printf 'resend auth e2e failed: %s\n' "$1" >&2
  exit 1
}

require_clean_checkout() {
  local checkout_status
  if ! checkout_status="$(git status --porcelain=v1 --untracked-files=all)"; then
    fail 'could not verify the browser truth checkout state'
  fi
  [[ -z "$checkout_status" ]] \
    || fail 'browser truth evidence requires a clean checkout with no untracked files'
}

for command_name in docker node pnpm curl; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing command: $command_name"
done

node --input-type=module -e '
  import { spawnSync } from "node:child_process";
  const result = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 });
  process.exit(result.status === 0 ? 0 : 1);
' || fail 'Docker daemon is unavailable'

node --input-type=module -e '
  import { existsSync } from "node:fs";
  import { chromium } from "@playwright/test";
  process.exit(existsSync(chromium.executablePath()) ? 0 : 1);
' || fail 'Playwright Chromium is unavailable; run pnpm exec playwright install chromium once'

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail 'not inside a git worktree'
WORKTREE_ROOT="$(git rev-parse --show-toplevel)"
[[ "$WORKTREE_ROOT" == "$ROOT_DIR" ]] || fail 'script must run from the checked-out repository root'
SOURCE_SHA="${SOURCE_SHA:-$(git rev-parse HEAD)}"
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'SOURCE_SHA must be a full lowercase commit SHA'
[[ "$(git rev-parse HEAD)" == "$SOURCE_SHA" ]] || fail 'SOURCE_SHA does not match the checkout'
require_clean_checkout

TMP_DIR="$(mktemp -d "/tmp/agora-resend-auth-e2e.XXXXXX")"
chmod 700 "$TMP_DIR"
trap 'rm -rf "$TMP_DIR"' EXIT
TMP_DIR="$TMP_DIR" ROOT_DIR="$ROOT_DIR" node --input-type=module -e '
  import { lstatSync, realpathSync, readdirSync } from "node:fs";
  import { isAbsolute, relative } from "node:path";
  const requested = process.env.TMP_DIR ?? "";
  if (!isAbsolute(requested)) process.exit(1);
  const stat = lstatSync(requested);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) process.exit(1);
  if (readdirSync(requested).length !== 0) process.exit(1);
  const directory = realpathSync(requested);
  const repository = realpathSync(process.env.ROOT_DIR ?? "");
  const fromRepository = relative(repository, directory);
  if (fromRepository === "" || (!fromRepository.startsWith("..") && !isAbsolute(fromRepository))) {
    process.exit(1);
  }
' || fail 'the browser truth temporary directory must be private and outside the repository'
export TMPDIR="$TMP_DIR"
LOG_FILE="$TMP_DIR/compose.log"
COOKIE_JAR="$TMP_DIR/api.cookies"

if [[ -n "${COMBO_BROWSER_TRUTH_PRIVATE_DIR:-}" ]]; then
  TRUTH_PRIVATE_DIR="$COMBO_BROWSER_TRUTH_PRIVATE_DIR"
  TRUTH_PRIVATE_DIR="$TRUTH_PRIVATE_DIR" ROOT_DIR="$ROOT_DIR" node --input-type=module -e '
    import { lstatSync, realpathSync, readdirSync } from "node:fs";
    import { isAbsolute, relative } from "node:path";
    const requested = process.env.TRUTH_PRIVATE_DIR ?? "";
    if (!isAbsolute(requested)) process.exit(1);
    const stat = lstatSync(requested);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) process.exit(1);
    if (readdirSync(requested).length !== 0) process.exit(1);
    const directory = realpathSync(requested);
    const repository = realpathSync(process.env.ROOT_DIR ?? "");
    const fromRepository = relative(repository, directory);
    if (fromRepository === "" || (!fromRepository.startsWith("..") && !isAbsolute(fromRepository))) {
      process.exit(1);
    }
  ' || fail 'COMBO_BROWSER_TRUTH_PRIVATE_DIR must be an empty private directory outside the repository'
else
  TRUTH_PRIVATE_DIR="$TMP_DIR/browser-truth"
  mkdir -m 700 "$TRUTH_PRIVATE_DIR"
fi
SENTINEL_FILE="$TRUTH_PRIVATE_DIR/sentinels.txt"
PLAYWRIGHT_RAW_REPORT="$TRUTH_PRIVATE_DIR/playwright-report.json"
PLAYWRIGHT_STDOUT="$TRUTH_PRIVATE_DIR/playwright.stdout"
PLAYWRIGHT_STDERR="$TRUTH_PRIVATE_DIR/playwright.stderr"
[[ ! -e "$SENTINEL_FILE" && ! -e "$PLAYWRIGHT_RAW_REPORT" \
  && ! -e "$PLAYWRIGHT_STDOUT" && ! -e "$PLAYWRIGHT_STDERR" ]] \
  || fail 'browser truth files already exist'
: >"$SENTINEL_FILE"
chmod 600 "$SENTINEL_FILE"
require_clean_checkout

PROJECT_NAME="agora-resend-auth-e2e-${RANDOM:-0}-$$"
read -r WEB_PORT RESEND_MOCK_PORT POSTGRES_PORT REDIS_QUEUE_PORT REDIS_HOT_PORT \
  MINIO_API_PORT MINIO_CONSOLE_PORT API_PORT <<<"$(node --input-type=module -e '
  import net from "node:net";
  const servers = Array.from({ length: 8 }, () => net.createServer());
  await Promise.all(servers.map((server) => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  })));
  const ports = servers.map((server) => {
    const address = server.address();
    if (!address || typeof address === "string") process.exit(1);
    return address.port;
  });
  process.stdout.write(ports.join(" "));
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
')"
PUBLIC_APP_ORIGIN="http://127.0.0.1:${WEB_PORT}"
PUBLIC_APP_ORIGINS="$PUBLIC_APP_ORIGIN"
RESEND_MOCK_BASE_URL="http://127.0.0.1:${RESEND_MOCK_PORT}"
S3_PUBLIC_ENDPOINT="http://127.0.0.1:${MINIO_API_PORT}"
POSTGRES_USER='combo'
POSTGRES_PASSWORD="$(node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write("owner/" + randomBytes(24).toString("base64url") + "#?");')"
POSTGRES_API_PASSWORD="$(node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(24).toString("base64url"));')"
POSTGRES_WORKER_PASSWORD="$(node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(24).toString("base64url"));')"
POSTGRES_RUNTIME_PASSWORD="$(node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(24).toString("base64url"));')"
POSTGRES_DB='combo'
S3_ACCESS_KEY="$(node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(16).toString("hex"));')"
S3_SECRET_KEY="$(node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(32).toString("base64url"));')"
GRAFANA_ADMIN_PASSWORD="$(node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(24).toString("base64url"));')"
RESEND_MOCK_API_KEY="$(node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(32).toString("base64url"));')"
RESEND_API_KEY="$RESEND_MOCK_API_KEY"
OTP_HMAC_SECRET="$(node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write(randomBytes(48).toString("base64url"));')"
RESEND_FROM_EMAIL='no-reply@example.test'
RESEND_MOCK_FROM_EMAIL="$RESEND_FROM_EMAIL"
ALTERNATE_BEARER="$(node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write("bearer-" + randomBytes(24).toString("base64url"));')"
ALTERNATE_QUERY_TOKEN="$(node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write("query-" + randomBytes(24).toString("base64url"));')"
PROXY_FAILURE_QUERY="$(node --input-type=module -e 'import { randomBytes } from "node:crypto"; process.stdout.write("proxy-" + randomBytes(24).toString("base64url"));')"
COMBO_SOURCE_SHA="$SOURCE_SHA"
COMBO_RELEASE_ID="release-$SOURCE_SHA"
COMBO_BUILT_AT="$(SOURCE_TIMESTAMP="$(git show -s --format=%cI "$SOURCE_SHA")" node --input-type=module -e '
  const timestamp = new Date(process.env.SOURCE_TIMESTAMP ?? "");
  if (Number.isNaN(timestamp.getTime())) process.exit(1);
  process.stdout.write(timestamp.toISOString());
')"
COMBO_RELEASE_MANIFEST_DIGEST="sha256:$(SOURCE_SHA="$SOURCE_SHA" node --input-type=module -e '
  import { createHash } from "node:crypto";
  process.stdout.write(createHash("sha256").update("auth-e2e:" + process.env.SOURCE_SHA).digest("hex"));
')"
# Compose validates the environment before the image exists. Replace this non-runtime placeholder
# with the exact built asset digest before creating any container.
COMBO_WEB_ASSET_MANIFEST="sha256:$(printf '0%.0s' {1..64})"

export WEB_PORT PUBLIC_APP_ORIGIN PUBLIC_APP_ORIGINS RESEND_MOCK_PORT POSTGRES_PORT REDIS_QUEUE_PORT REDIS_HOT_PORT
export MINIO_API_PORT MINIO_CONSOLE_PORT API_PORT S3_PUBLIC_ENDPOINT
export POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB POSTGRES_API_PASSWORD
export POSTGRES_WORKER_PASSWORD POSTGRES_RUNTIME_PASSWORD S3_ACCESS_KEY S3_SECRET_KEY
export GRAFANA_ADMIN_PASSWORD RESEND_MOCK_API_KEY RESEND_API_KEY OTP_HMAC_SECRET
export RESEND_FROM_EMAIL RESEND_MOCK_FROM_EMAIL
export COMBO_SOURCE_SHA COMBO_RELEASE_ID COMBO_BUILT_AT
export COMBO_RELEASE_MANIFEST_DIGEST COMBO_WEB_ASSET_MANIFEST

COMPOSE=(
  docker compose
  --project-name "$PROJECT_NAME"
  -f infra/docker-compose.yml
  -f infra/docker-compose.dev-test.yml
)
CLEANUP_REQUIRED=1
LOGS_CAPTURED=0
CURRENT_STEP='initialization'

step() {
  CURRENT_STEP="$1"
  printf '%s\n' "$CURRENT_STEP"
}

report_error() {
  local status="$1"
  local line="$2"
  printf 'resend auth e2e command failed at line %s during: %s\n' "$line" "$CURRENT_STEP" >&2
  return "$status"
}
trap 'report_error "$?" "$LINENO"' ERR

capture_logs() {
  if [[ "$CLEANUP_REQUIRED" -eq 1 && "$LOGS_CAPTURED" -eq 0 ]]; then
    "${COMPOSE[@]}" logs --no-color >"$LOG_FILE" 2>&1 || true
    LOGS_CAPTURED=1
  fi
}

cleanup() {
  local status=$?
  local cleanup_failed=0
  local remaining_containers remaining_volumes remaining_networks remaining_images
  local -a project_images=()
  trap - EXIT INT TERM
  if [[ "$status" -ne 0 ]]; then
    printf 'resend auth e2e failed during: %s\n' "$CURRENT_STEP" >&2
  fi
  capture_logs
  if [[ "$CLEANUP_REQUIRED" -eq 1 ]]; then
    if ! "${COMPOSE[@]}" down --volumes --remove-orphans --rmi local >/dev/null 2>&1; then
      cleanup_failed=1
    fi
    while IFS= read -r project_image; do
      if [[ -n "$project_image" ]]; then
        project_images+=("$project_image")
      fi
    done < <(docker image ls -q --filter "label=com.docker.compose.project=$PROJECT_NAME" | sort -u)
    if [[ "${#project_images[@]}" -gt 0 ]] && ! docker image rm -f "${project_images[@]}" >/dev/null 2>&1; then
      cleanup_failed=1
    fi
    remaining_containers="$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT_NAME" | wc -l | tr -d ' ')"
    remaining_volumes="$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT_NAME" | wc -l | tr -d ' ')"
    remaining_networks="$(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT_NAME" | wc -l | tr -d ' ')"
    remaining_images="$(docker image ls -q --filter "label=com.docker.compose.project=$PROJECT_NAME" | sort -u | wc -l | tr -d ' ')"
    if [[ "$remaining_containers" != 0 || "$remaining_volumes" != 0 || "$remaining_networks" != 0 || "$remaining_images" != 0 ]]; then
      printf 'resend auth e2e cleanup left project-local Docker resources\n' >&2
      cleanup_failed=1
    fi
  fi
  rm -rf "$TMP_DIR"
  if [[ "$status" -eq 0 && "$cleanup_failed" -ne 0 ]]; then status=1; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

remember() {
  [[ -n "$1" ]] || fail 'refusing to record an empty sentinel'
  printf '%s\n' "$1" >>"$SENTINEL_FILE"
}

remember "$POSTGRES_PASSWORD"
remember "$POSTGRES_API_PASSWORD"
remember "$POSTGRES_WORKER_PASSWORD"
remember "$POSTGRES_RUNTIME_PASSWORD"
remember "$S3_ACCESS_KEY"
remember "$S3_SECRET_KEY"
remember "$GRAFANA_ADMIN_PASSWORD"
remember "$RESEND_MOCK_API_KEY"
remember "$OTP_HMAC_SECRET"
remember "$RESEND_FROM_EMAIL"
remember "$ALTERNATE_BEARER"
remember "$ALTERNATE_QUERY_TOKEN"
remember "$PROXY_FAILURE_QUERY"

json_challenge() {
  TEST_EMAIL="$1" node --input-type=module -e 'process.stdout.write(JSON.stringify({ email: process.env.TEST_EMAIL }))'
}

json_verification() {
  TEST_EMAIL="$1" OTP_CODE="$2" node --input-type=module -e '
    process.stdout.write(JSON.stringify({ email: process.env.TEST_EMAIL, code: process.env.OTP_CODE }));
  '
}

new_email() {
  TEST_PREFIX="$1" node --input-type=module -e '
    import { randomUUID } from "node:crypto";
    process.stdout.write(process.env.TEST_PREFIX + "-" + randomUUID().replaceAll("-", "") + "@example.test");
  '
}

new_uuid() {
  node --input-type=module -e 'import { randomUUID } from "node:crypto"; process.stdout.write(randomUUID());'
}

new_creator_account() {
  node --input-type=module -e '
    import { randomBytes } from "node:crypto";
    const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
    const bytes = randomBytes(8);
    process.stdout.write("creator-" + Array.from(bytes, (value) => alphabet[value % alphabet.length]).join(""));
  '
}

http_status() {
  local expected="$1"
  local actual="$2"
  local operation="$3"
  [[ "$actual" == "$expected" ]] || fail "$operation returned HTTP $actual instead of $expected"
}

assert_auth_error() {
  local response_file="$1"
  RESPONSE_FILE="$response_file" node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const body = JSON.parse(readFileSync(process.env.RESPONSE_FILE, "utf8"));
    const error = body?.error;
    if (!error || typeof error !== "object" || "code" in error) process.exit(1);
    if (typeof error.userMessage !== "string" || error.userMessage.length === 0) process.exit(1);
    if (typeof error.retriable !== "boolean") process.exit(1);
    if (typeof error.action !== "string" || error.action.length === 0) process.exit(1);
    if (typeof error.traceId !== "string" || error.traceId.length === 0) process.exit(1);
  ' || fail 'unexpected authentication error envelope'
}

auth_error_fingerprint() {
  RESPONSE_FILE="$1" node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const body = JSON.parse(readFileSync(process.env.RESPONSE_FILE, "utf8")).error;
    process.stdout.write(JSON.stringify({
      userMessage: body?.userMessage,
      retriable: body?.retriable,
      action: body?.action,
    }));
  '
}

assert_no_set_cookie() {
  local headers_file="$1"
  if grep -Eiq '^set-cookie:[[:space:]]*cb_session=' "$headers_file"; then
    fail 'dependency failure response signed or cleared cb_session'
  fi
}

set_mock_mode() {
  local mode="$1"
  local output_file="$TMP_DIR/mock-mode-${mode}.json"
  local status
  status="$(MOCK_MODE="$mode" node --input-type=module -e '
      process.stdout.write(JSON.stringify({ mode: process.env.MOCK_MODE }));
    ' | curl -sS --max-time 5 -o "$output_file" -w '%{http_code}' \
      -X PUT "$RESEND_MOCK_BASE_URL/__test/mode" \
      -H "Authorization: Bearer $RESEND_MOCK_API_KEY" \
      -H 'Content-Type: application/json' \
      --data-binary @-)"
  http_status 200 "$status" "set mock mode $mode"
}

latest_code() {
  MOCK_API_KEY="$RESEND_MOCK_API_KEY" MOCK_BASE_URL="$RESEND_MOCK_BASE_URL" TEST_EMAIL="$1" node --input-type=module -e '
    try {
      const response = await fetch(new URL("/__test/inbox/latest", process.env.MOCK_BASE_URL), {
        method: "POST",
        headers: {
          Authorization: "Bearer " + process.env.MOCK_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ to: process.env.TEST_EMAIL }),
      });
      if (!response.ok) process.exit(1);
      const body = await response.json();
      if (!/^\d{6}$/.test(body?.code ?? "")) process.exit(1);
      process.stdout.write(body.code);
    } catch {
      process.exit(1);
    }
  '
}

challenge() {
  local email="$1"
  local expected_status="$2"
  local operation="$3"
  local response_file="$TMP_DIR/${operation}.json"
  local headers_file="$TMP_DIR/${operation}.headers"
  local status
  status="$(json_challenge "$email" | curl -sS --max-time 12 \
    -D "$headers_file" -o "$response_file" -w '%{http_code}' \
    -X POST "$PUBLIC_APP_ORIGIN/api/v1/auth/email/challenges" \
    -H "Origin: $PUBLIC_APP_ORIGIN" \
    -H 'Content-Type: application/json' \
    --data-binary @-)"
  http_status "$expected_status" "$status" "$operation"
  grep -Eiq '^cache-control:[[:space:]]*no-store' "$headers_file" || fail "$operation omitted Cache-Control: no-store"
  assert_no_set_cookie "$headers_file"
  if [[ "$expected_status" == 202 ]]; then
    RESPONSE_FILE="$response_file" node --input-type=module -e '
      import { readFileSync } from "node:fs";
      const body = JSON.parse(readFileSync(process.env.RESPONSE_FILE, "utf8"));
      if (body?.data?.accepted !== true || typeof body?.meta?.traceId !== "string") process.exit(1);
      if (body?.data?.expiresInSeconds !== 300 || body?.data?.resendAfterSeconds !== 60) process.exit(1);
    ' || fail "$operation returned an invalid challenge envelope"
  else
    assert_auth_error "$response_file"
  fi
  if grep -Fq "$email" "$response_file"; then
    fail "$operation reflected the email address"
  fi
}

verify() {
  local email="$1"
  local code="$2"
  local expected_status="$3"
  local operation="$4"
  local cookie_jar="${5:-}"
  local response_file="$TMP_DIR/${operation}.json"
  local headers_file="$TMP_DIR/${operation}.headers"
  local curl_cookie_args=(-b /dev/null)
  local status
  if [[ -n "$cookie_jar" ]]; then
    curl_cookie_args=(-b "$cookie_jar" -c "$cookie_jar")
  fi
  status="$(json_verification "$email" "$code" | curl -sS --max-time 12 \
    -D "$headers_file" -o "$response_file" -w '%{http_code}' \
    "${curl_cookie_args[@]}" \
    -X POST "$PUBLIC_APP_ORIGIN/api/v1/auth/email/verifications" \
    -H "Origin: $PUBLIC_APP_ORIGIN" \
    -H 'Content-Type: application/json' \
    --data-binary @-)"
  http_status "$expected_status" "$status" "$operation"
  grep -Eiq '^cache-control:[[:space:]]*no-store' "$headers_file" || fail "$operation omitted Cache-Control: no-store"
  if [[ "$expected_status" == 200 ]]; then
    RESPONSE_FILE="$response_file" node --input-type=module -e '
      import { readFileSync } from "node:fs";
      const body = JSON.parse(readFileSync(process.env.RESPONSE_FILE, "utf8"));
      if (!/^[0-9a-f-]{36}$/i.test(body?.data?.user?.id ?? "")) process.exit(1);
      if (!/^creator-[a-z2-7]{8}$/.test(body?.data?.user?.account ?? "")) process.exit(1);
      if (JSON.stringify(body?.data?.user?.roles) !== JSON.stringify(["creator"])) process.exit(1);
      if (typeof body?.data?.returnTo !== "string" || typeof body?.meta?.traceId !== "string") process.exit(1);
    ' || fail "$operation returned an invalid verification envelope"
  else
    assert_no_set_cookie "$headers_file"
    assert_auth_error "$response_file"
  fi
}

pg_scalar() {
  local sql="$1"
  "${COMPOSE[@]}" exec -T postgres psql -X -qAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$sql"
}

wait_for_authenticated_me() {
  local cookie_jar="$1"
  local status='000'
  for _ in {1..20}; do
    status="$(curl -sS --max-time 3 -o "$TMP_DIR/recovered-me.json" -w '%{http_code}' \
      -b "$cookie_jar" "$PUBLIC_APP_ORIGIN/api/v1/me" || true)"
    [[ "$status" == 200 ]] && return 0
    sleep 1
  done
  fail "authoring session did not recover after PostgreSQL restart; last HTTP status was $status"
}

assert_error_exchange() {
  local operation="$1"
  local expected_status="$2"
  local actual_status="$3"
  local headers_file="$4"
  local response_file="$5"
  http_status "$expected_status" "$actual_status" "$operation"
  grep -Eiq '^cache-control:[[:space:]]*no-store' "$headers_file" \
    || fail "$operation omitted Cache-Control: no-store"
  assert_auth_error "$response_file"
  assert_no_set_cookie "$headers_file"
}

assert_production_image_clean() {
  local service="$1"
  local image_id
  local leaked_paths
  image_id="${PROJECT_NAME}-${service}:latest"
  docker image inspect "$image_id" >/dev/null 2>&1 || fail "could not resolve the $service image"
  leaked_paths="$(docker run --rm --entrypoint /bin/sh "$image_id" -c '
    set --
    for root in /app/apps /app/packages /app/db /usr/share/nginx; do
      if [ -e "$root" ]; then set -- "$@" "$root"; fi
    done
    [ "$#" -gt 0 ] || exit 1
    find "$@" -type f \( \
      -path "*/__tests__/*" -o -path "*/test/*" \
      -name "*.test.*" -o -name "*.spec.*" -o -iname "*resend-mock*" \
    \) -print
  ')" || fail "could not inspect the $service image"
  [[ -z "$leaked_paths" ]] || fail "$service image contains project test or mock files"
}

step 'Validating and building the isolated Resend auth test stack...'
"${COMPOSE[@]}" config -q
"${COMPOSE[@]}" build migrate api runtime web resend-mock
for production_service in migrate api runtime web; do
  assert_production_image_clean "$production_service"
done
COMBO_WEB_ASSET_MANIFEST="sha256:$(
  docker run --rm --entrypoint sha256sum \
    "${PROJECT_NAME}-web:latest" /usr/share/nginx/html/web-asset-manifest.json |
    awk 'NR == 1 { print $1 }'
)"
[[ "$COMBO_WEB_ASSET_MANIFEST" =~ ^sha256:[0-9a-f]{64}$ ]] ||
  fail 'could not derive the built Web asset manifest digest'
export COMBO_WEB_ASSET_MANIFEST
"${COMPOSE[@]}" config -q
"${COMPOSE[@]}" up -d --wait postgres redis_queue redis_hot minio resend-mock migrate api runtime web
set_mock_mode accepted

step 'Checking authentication request boundaries...'
BOUNDARY_EMAIL="$(new_email boundary)"
remember "$BOUNDARY_EMAIL"
NO_ORIGIN_STATUS="$(json_challenge "$BOUNDARY_EMAIL" | curl -sS --max-time 5 \
  -D "$TMP_DIR/no-origin.headers" -o "$TMP_DIR/no-origin.json" -w '%{http_code}' \
  -X POST "$PUBLIC_APP_ORIGIN/api/v1/auth/email/challenges" \
  -H 'Sec-Fetch-Site: same-origin' \
  -H 'Content-Type: application/json' \
  --data-binary @-)"
assert_error_exchange 'missing Origin rejection' 403 "$NO_ORIGIN_STATUS" \
  "$TMP_DIR/no-origin.headers" "$TMP_DIR/no-origin.json"

CROSS_ORIGIN_STATUS="$(json_challenge "$BOUNDARY_EMAIL" | curl -sS --max-time 5 \
  -D "$TMP_DIR/cross-origin.headers" -o "$TMP_DIR/cross-origin.json" -w '%{http_code}' \
  -X POST "$PUBLIC_APP_ORIGIN/api/v1/auth/email/challenges" \
  -H 'Origin: https://attacker.invalid' \
  -H 'Sec-Fetch-Site: cross-site' \
  -H 'Content-Type: application/json' \
  --data-binary @-)"
assert_error_exchange 'cross-origin rejection' 403 "$CROSS_ORIGIN_STATUS" \
  "$TMP_DIR/cross-origin.headers" "$TMP_DIR/cross-origin.json"
if grep -Eiq '^access-control-allow-origin:[[:space:]]*https://attacker\.invalid' "$TMP_DIR/cross-origin.headers"; then
  fail 'cross-origin rejection reflected the attacker origin'
fi

MALFORMED_STATUS="$(printf '%s' '{"email":' | curl -sS --max-time 5 \
  -D "$TMP_DIR/malformed.headers" -o "$TMP_DIR/malformed.json" -w '%{http_code}' \
  -X POST "$PUBLIC_APP_ORIGIN/api/v1/auth/email/challenges" \
  -H "Origin: $PUBLIC_APP_ORIGIN" \
  -H 'Content-Type: application/json' \
  --data-binary @-)"
assert_error_exchange 'malformed JSON rejection' 400 "$MALFORMED_STATUS" \
  "$TMP_DIR/malformed.headers" "$TMP_DIR/malformed.json"

UNKNOWN_FIELD_STATUS="$(TEST_EMAIL="$BOUNDARY_EMAIL" node --input-type=module -e '
    process.stdout.write(JSON.stringify({ email: process.env.TEST_EMAIL, unexpected: true }));
  ' | curl -sS --max-time 5 \
  -D "$TMP_DIR/unknown-field.headers" -o "$TMP_DIR/unknown-field.json" -w '%{http_code}' \
  -X POST "$PUBLIC_APP_ORIGIN/api/v1/auth/email/challenges" \
  -H "Origin: $PUBLIC_APP_ORIGIN" \
  -H 'Content-Type: application/json' \
  --data-binary @-)"
assert_error_exchange 'unknown-field rejection' 400 "$UNKNOWN_FIELD_STATUS" \
  "$TMP_DIR/unknown-field.headers" "$TMP_DIR/unknown-field.json"

OVERSIZED_STATUS="$(node --input-type=module -e '
    process.stdout.write(JSON.stringify({ email: "a".repeat(5000) + "@example.test" }));
  ' | curl -sS --max-time 5 \
  -D "$TMP_DIR/oversized.headers" -o "$TMP_DIR/oversized.json" -w '%{http_code}' \
  -X POST "$PUBLIC_APP_ORIGIN/api/v1/auth/email/challenges" \
  -H "Origin: $PUBLIC_APP_ORIGIN" \
  -H 'Content-Type: application/json' \
  --data-binary @-)"
assert_error_exchange 'oversized JSON rejection' 413 "$OVERSIZED_STATUS" \
  "$TMP_DIR/oversized.headers" "$TMP_DIR/oversized.json"

step 'Running the custom login page in Chromium...'
AUTH_E2E_WEB_BASE_URL="$PUBLIC_APP_ORIGIN" \
AUTH_E2E_RESEND_MOCK_BASE_URL="$RESEND_MOCK_BASE_URL" \
AUTH_E2E_RESEND_MOCK_API_KEY="$RESEND_MOCK_API_KEY" \
AUTH_E2E_SENTINEL_FILE="$SENTINEL_FILE" \
AUTH_E2E_COMPOSE_PROJECT="$PROJECT_NAME" \
AUTH_E2E_REPO_ROOT="$ROOT_DIR" \
COMBO_BROWSER_TRUTH_CANDIDATE_SHA="$SOURCE_SHA" \
PLAYWRIGHT_JSON_OUTPUT_FILE="$PLAYWRIGHT_RAW_REPORT" \
PLAYWRIGHT_OUTPUT_DIR="$TMP_DIR/playwright" \
PW_TEST_REPORTER='' \
PW_TEST_DEBUG_REPORTERS='' \
PW_TEST_CONNECT_EXPOSE_NETWORK='' \
PW_TEST_CONNECT_HEADERS='' \
PWDEBUG='' \
PWDEBUGIMPL='' \
PWPAUSE='' \
PW_RUNNER_DEBUG='' \
PW_TEST_CONNECT_WS_ENDPOINT='' \
PW_TEST_REUSE_CONTEXT='' \
PW_TEST_SOURCE_TRANSFORM='' \
PW_TEST_SOURCE_TRANSFORM_SCOPE='' \
PWTEST_CACHE_DIR="$TMP_DIR/playwright-cache" \
PWTEST_CHILD_PROCESS_TIMEOUT='' \
PWTEST_DEBUG='' \
PWTEST_FORCE_EXIT_TIMEOUT='' \
PWTEST_WATCH='' \
PWTEST_HEADED_FOR_TEST='' \
PWTEST_SHARD_WEIGHTS='' \
PLAYWRIGHT_DASHBOARD='' \
PLAYWRIGHT_FORCE_ASYNC_LOADER='' \
PLAYWRIGHT_FORCE_TTY='' \
PLAYWRIGHT_LAST_RUN_OUTPUT_FILE='' \
PLAYWRIGHT_TEST_BASE_URL='' \
PW_DISABLE_TS_ESM='' \
  pnpm exec playwright test --config tests/e2e/playwright.test-truth.config.ts \
    --tsconfig tsconfig.e2e.json --browser=chromium --reporter=json \
    >"$PLAYWRIGHT_STDOUT" 2>"$PLAYWRIGHT_STDERR"
for playwright_private_file in "$PLAYWRIGHT_RAW_REPORT" "$PLAYWRIGHT_STDOUT" "$PLAYWRIGHT_STDERR"; do
  [[ -f "$playwright_private_file" && ! -L "$playwright_private_file" ]] \
    || fail 'Playwright did not create every private evidence file'
  chmod 600 "$playwright_private_file"
done
rm -rf "$TMP_DIR/playwright"

step 'Checking challenge cooldown rate limiting...'
RATE_EMAIL="$(new_email rate-limit)"
remember "$RATE_EMAIL"
challenge "$RATE_EMAIL" 202 'rate-limit-first'
RATE_CODE="$(latest_code "$RATE_EMAIL")" || fail 'could not read the rate-limit mock OTP'
remember "$RATE_CODE"
challenge "$RATE_EMAIL" 429 'rate-limit-second'
grep -Eiq '^retry-after:[[:space:]]*[1-9][0-9]*' "$TMP_DIR/rate-limit-second.headers" \
  || fail 'rate-limited challenge omitted Retry-After'

step 'Running API resend rotation checks...'
API_EMAIL="$(new_email api)"
remember "$API_EMAIL"
challenge "$API_EMAIL" 202 'api-challenge-first'
FIRST_CODE="$(latest_code "$API_EMAIL")" || fail 'could not read the first mock OTP'
remember "$FIRST_CODE"

pg_scalar "UPDATE auth_otp_challenges SET created_at = created_at - interval '61 seconds', activated_at = activated_at - interval '61 seconds', expires_at = expires_at - interval '61 seconds' WHERE consumed_at IS NULL AND invalidated_at IS NULL;" >/dev/null \
  || fail 'could not age the first challenge'
challenge "$API_EMAIL" 202 'api-challenge-second'
SECOND_CODE="$(latest_code "$API_EMAIL")" || fail 'could not read the second mock OTP'
for _ in 1 2 3; do
  [[ "$SECOND_CODE" != "$FIRST_CODE" ]] && break
  pg_scalar "UPDATE auth_otp_challenges SET created_at = created_at - interval '61 seconds', activated_at = activated_at - interval '61 seconds', expires_at = expires_at - interval '61 seconds' WHERE consumed_at IS NULL AND invalidated_at IS NULL;" >/dev/null \
    || fail 'could not age a colliding challenge'
  challenge "$API_EMAIL" 202 "api-challenge-collision-${_}"
  SECOND_CODE="$(latest_code "$API_EMAIL")" || fail 'could not read a replacement mock OTP'
done
[[ "$SECOND_CODE" != "$FIRST_CODE" ]] || fail 'could not obtain a distinct resend code after three attempts'
remember "$SECOND_CODE"

verify "$API_EMAIL" "$FIRST_CODE" 401 'api-old-code'
assert_auth_error "$TMP_DIR/api-old-code.json"
verify "$API_EMAIL" "$SECOND_CODE" 200 'api-verification' "$COOKIE_JAR"

step 'Checking the shared session and alternate credential rejection...'
SESSION_COOKIE_COUNT="$(awk '$6 == "cb_session" { count += 1 } END { print count + 0 }' "$COOKIE_JAR")"
[[ "$SESSION_COOKIE_COUNT" == 1 ]] || fail "expected one cb_session cookie, found $SESSION_COOKIE_COUNT"
SESSION_COOKIE="$(awk '$6 == "cb_session" { value = $7 } END { print value }' "$COOKIE_JAR")"
[[ "$SESSION_COOKIE" =~ ^s1\.[A-Za-z0-9_-]{43}$ ]] || fail 'cb_session was not a versioned 32-byte base64url value'
remember "$SESSION_COOKIE"
COOKIE_HEADER="$(grep -Ei '^set-cookie:[[:space:]]*cb_session=' "$TMP_DIR/api-verification.headers" | tail -n 1)"
COOKIE_HEADER_LOWER="$(printf '%s' "$COOKIE_HEADER" | tr '[:upper:]' '[:lower:]')"
[[ "$COOKIE_HEADER_LOWER" == *'path=/'* ]] || fail 'development cb_session path was not /'
[[ "$COOKIE_HEADER_LOWER" == *'httponly'* ]] || fail 'cb_session was not HttpOnly'
[[ "$COOKIE_HEADER_LOWER" == *'samesite=lax'* ]] || fail 'cb_session was not SameSite=Lax'
[[ "$COOKIE_HEADER_LOWER" == *'max-age=604800'* ]] || fail 'cb_session lifetime was not seven days'
[[ "$COOKIE_HEADER_LOWER" != *'secure'* ]] || fail 'development cb_session unexpectedly used Secure'

ME_STATUS="$(curl -sS --max-time 5 -D "$TMP_DIR/me.headers" -o "$TMP_DIR/me.json" -w '%{http_code}' \
  -b "$COOKIE_JAR" "$PUBLIC_APP_ORIGIN/api/v1/me")"
http_status 200 "$ME_STATUS" '/me with shared session'
grep -Eiq '^cache-control:[[:space:]]*no-store' "$TMP_DIR/me.headers" || fail '/me omitted Cache-Control: no-store'
ME_USER_ID="$(ME_FILE="$TMP_DIR/me.json" node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const id = JSON.parse(readFileSync(process.env.ME_FILE, "utf8")).data?.id;
  if (!/^[0-9a-f-]{36}$/i.test(id ?? "")) process.exit(1);
  process.stdout.write(id);
')" || fail 'could not read the /me user id'
OWN_TASK_ID="$(new_uuid)"
OWN_CAPABILITY_ID="$(new_uuid)"
OTHER_USER_ID="$(new_uuid)"
OTHER_TASK_ID="$(new_uuid)"
OTHER_CAPABILITY_ID="$(new_uuid)"
OTHER_ACCOUNT="$(new_creator_account)"
pg_scalar "
  INSERT INTO users (id, account, roles) VALUES ('$OTHER_USER_ID', '$OTHER_ACCOUNT', ARRAY['creator']::text[]);
  INSERT INTO tasks (id, owner_user_id, idempotency_key) VALUES ('$OWN_TASK_ID', '$ME_USER_ID', 'e2e-$OWN_TASK_ID');
  INSERT INTO tasks (id, owner_user_id, idempotency_key) VALUES ('$OTHER_TASK_ID', '$OTHER_USER_ID', 'e2e-$OTHER_TASK_ID');
  INSERT INTO capabilities (id, task_id, owner_user_id, name, summary, kind, storage_key, published)
    VALUES ('$OWN_CAPABILITY_ID', '$OWN_TASK_ID', '$ME_USER_ID', 'E2E owned capability', '', 'markdown', 'e2e/owned', false);
  INSERT INTO capabilities (id, task_id, owner_user_id, name, summary, kind, storage_key, published)
    VALUES ('$OTHER_CAPABILITY_ID', '$OTHER_TASK_ID', '$OTHER_USER_ID', 'E2E other capability', '', 'markdown', 'e2e/other', false);
" >/dev/null || fail 'could not seed owner-distinguishing runtime capabilities'

RUNTIME_STATUS="$(curl -sS --max-time 5 -o "$TMP_DIR/runtime.json" -w '%{http_code}' -b "$COOKIE_JAR" "$PUBLIC_APP_ORIGIN/api/v1/runtime/capabilities")"
http_status 200 "$RUNTIME_STATUS" 'runtime capability read with shared session'
ME_FILE="$TMP_DIR/me.json" RUNTIME_FILE="$TMP_DIR/runtime.json" \
OWN_CAPABILITY_ID="$OWN_CAPABILITY_ID" OTHER_CAPABILITY_ID="$OTHER_CAPABILITY_ID" \
node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const me = JSON.parse(readFileSync(process.env.ME_FILE, "utf8"));
  const runtime = JSON.parse(readFileSync(process.env.RUNTIME_FILE, "utf8"));
  if (!/^[0-9a-f-]{36}$/i.test(me.data?.id ?? "")) process.exit(1);
  if (!/^creator-[a-z2-7]{8}$/.test(me.data?.account ?? "")) process.exit(1);
  if (JSON.stringify(me.data?.roles) !== JSON.stringify(["creator"])) process.exit(1);
  if (!Array.isArray(runtime.data)) process.exit(1);
  const owned = runtime.data.find((item) => item?.id === process.env.OWN_CAPABILITY_ID);
  if (!owned || owned.owned !== true) process.exit(1);
  if (runtime.data.some((item) => item?.id === process.env.OTHER_CAPABILITY_ID)) process.exit(1);
' || fail 'authoring and runtime did not resolve the shared Cookie to the same user'

BEARER_STATUS="$(curl -sS --max-time 5 -o "$TMP_DIR/bearer.json" -w '%{http_code}' \
  -b "$COOKIE_JAR" -H "Authorization: Bearer $ALTERNATE_BEARER" "$PUBLIC_APP_ORIGIN/api/v1/me")"
http_status 401 "$BEARER_STATUS" 'authoring Bearer rejection'
assert_auth_error "$TMP_DIR/bearer.json"
AUTHORING_QUERY_STATUS="$(curl -sS --max-time 5 -o "$TMP_DIR/authoring-query-token.json" -w '%{http_code}' \
  -b "$COOKIE_JAR" "$PUBLIC_APP_ORIGIN/api/v1/me?access_token=$ALTERNATE_QUERY_TOKEN")"
http_status 401 "$AUTHORING_QUERY_STATUS" 'authoring query-token rejection'
assert_auth_error "$TMP_DIR/authoring-query-token.json"
RUNTIME_BEARER_STATUS="$(curl -sS --max-time 5 -o "$TMP_DIR/runtime-bearer.json" -w '%{http_code}' \
  -b "$COOKIE_JAR" -H "Authorization: Bearer $ALTERNATE_BEARER" "$PUBLIC_APP_ORIGIN/api/v1/runtime/capabilities")"
http_status 401 "$RUNTIME_BEARER_STATUS" 'runtime Bearer rejection'
assert_auth_error "$TMP_DIR/runtime-bearer.json"
QUERY_STATUS="$(curl -sS --max-time 5 -o "$TMP_DIR/query-token.json" -w '%{http_code}' \
  -b "$COOKIE_JAR" "$PUBLIC_APP_ORIGIN/api/v1/runtime/capabilities?access_token=$ALTERNATE_QUERY_TOKEN")"
http_status 401 "$QUERY_STATUS" 'runtime query-token rejection'
assert_auth_error "$TMP_DIR/query-token.json"
ALTERNATE_SSE_ID="$(new_uuid)"
BEARER_SSE_STATUS="$(curl -sS --max-time 5 -o "$TMP_DIR/bearer-sse.json" -w '%{http_code}' \
  -b "$COOKIE_JAR" -H "Authorization: Bearer $ALTERNATE_BEARER" \
  "$PUBLIC_APP_ORIGIN/api/v1/runtime/sessions/$ALTERNATE_SSE_ID/stream")"
http_status 401 "$BEARER_SSE_STATUS" 'runtime SSE Bearer rejection'
assert_auth_error "$TMP_DIR/bearer-sse.json"
QUERY_SSE_STATUS="$(curl -sS --max-time 5 -o "$TMP_DIR/query-token-sse.json" -w '%{http_code}' \
  -b "$COOKIE_JAR" "$PUBLIC_APP_ORIGIN/api/v1/runtime/sessions/$ALTERNATE_SSE_ID/stream?token=$ALTERNATE_QUERY_TOKEN")"
http_status 401 "$QUERY_SSE_STATUS" 'runtime SSE query-token rejection'
assert_auth_error "$TMP_DIR/query-token-sse.json"

step 'Checking same-site sibling mutation rejection before writes...'
TASK_COUNT_BEFORE="$(pg_scalar 'SELECT count(*) FROM tasks;')"
SESSION_COUNT_BEFORE="$(pg_scalar 'SELECT count(*) FROM sessions;')"
SIBLING_TASK_STATUS="$(node --input-type=module -e 'import { randomUUID } from "node:crypto"; process.stdout.write(JSON.stringify({ idempotencyKey: randomUUID() }));' \
  | curl -sS --max-time 5 -o "$TMP_DIR/sibling-task.json" -w '%{http_code}' \
    -b "$COOKIE_JAR" -X POST "$PUBLIC_APP_ORIGIN/api/v1/tasks" \
    -H 'Origin: https://sibling.example.test' -H 'Sec-Fetch-Site: same-site' \
    -H 'Content-Type: application/json' --data-binary @-)"
http_status 403 "$SIBLING_TASK_STATUS" 'authoring sibling-origin mutation'
assert_auth_error "$TMP_DIR/sibling-task.json"
SIBLING_RUNTIME_STATUS="$(CAPABILITY_ID="$OWN_CAPABILITY_ID" node --input-type=module -e '
    process.stdout.write(JSON.stringify({ capabilityId: process.env.CAPABILITY_ID }));
  ' | curl -sS --max-time 5 -o "$TMP_DIR/sibling-runtime.json" -w '%{http_code}' \
    -b "$COOKIE_JAR" -X POST "$PUBLIC_APP_ORIGIN/api/v1/runtime/sessions" \
    -H 'Origin: https://sibling.example.test' -H 'Sec-Fetch-Site: same-site' \
    -H 'Content-Type: application/json' --data-binary @-)"
http_status 403 "$SIBLING_RUNTIME_STATUS" 'runtime sibling-origin mutation'
assert_auth_error "$TMP_DIR/sibling-runtime.json"
[[ "$(pg_scalar 'SELECT count(*) FROM tasks;')" == "$TASK_COUNT_BEFORE" ]] \
  || fail 'sibling-origin authoring request wrote a task'
[[ "$(pg_scalar 'SELECT count(*) FROM sessions;')" == "$SESSION_COUNT_BEFORE" ]] \
  || fail 'sibling-origin runtime request wrote a session'
SIBLING_PREFLIGHT_STATUS="$(curl -sS --max-time 5 -D "$TMP_DIR/sibling-preflight.headers" \
  -o /dev/null -w '%{http_code}' -X OPTIONS "$PUBLIC_APP_ORIGIN/api/v1/runtime/sessions" \
  -H 'Origin: https://sibling.example.test' -H 'Access-Control-Request-Method: POST')"
[[ "$SIBLING_PREFLIGHT_STATUS" =~ ^4[0-9][0-9]$ ]] || fail 'runtime sibling preflight was not rejected'
if grep -Eiq '^access-control-allow-origin:[[:space:]]*https://sibling\.example\.test' "$TMP_DIR/sibling-preflight.headers"; then
  fail 'runtime CORS reflected a sibling origin'
fi

step 'Checking Nginx proxy failures do not log raw query credentials...'
"${COMPOSE[@]}" stop runtime >/dev/null
PROXY_FAILURE_STATUS="$(curl -sS --max-time 8 -o "$TMP_DIR/proxy-failure.json" -w '%{http_code}' \
  "$PUBLIC_APP_ORIGIN/api/v1/runtime/capabilities?access_token=$PROXY_FAILURE_QUERY" || true)"
[[ "$PROXY_FAILURE_STATUS" == 502 || "$PROXY_FAILURE_STATUS" == 504 ]] \
  || fail 'runtime upstream failure did not reach the expected proxy error path'
"${COMPOSE[@]}" up -d --wait runtime

step 'Checking successful-login session rotation...'
OLD_COOKIE_JAR="$TMP_DIR/old-api.cookies"
cp "$COOKIE_JAR" "$OLD_COOKIE_JAR"
pg_scalar "UPDATE auth_otp_challenges SET created_at = created_at - interval '2 hours', activated_at = activated_at - interval '2 hours', expires_at = expires_at - interval '2 hours', invalidated_at = invalidated_at - interval '2 hours', consumed_at = consumed_at - interval '2 hours';" >/dev/null \
  || fail 'could not age challenge history for session rotation'
"${COMPOSE[@]}" exec -T redis_hot redis-cli FLUSHDB >/dev/null \
  || fail 'could not reset isolated auth rate-limit state'
challenge "$API_EMAIL" 202 'rotation-challenge'
ROTATION_CODE="$(latest_code "$API_EMAIL")" || fail 'could not read the rotation mock OTP'
remember "$ROTATION_CODE"
verify "$API_EMAIL" "$ROTATION_CODE" 200 'rotation-verification' "$COOKIE_JAR"
ROTATED_SESSION_COOKIE="$(awk '$6 == "cb_session" { value = $7 } END { print value }' "$COOKIE_JAR")"
[[ "$ROTATED_SESSION_COOKIE" =~ ^s1\.[A-Za-z0-9_-]{43}$ ]] || fail 'rotated cb_session had an invalid format'
[[ "$ROTATED_SESSION_COOKIE" != "$SESSION_COOKIE" ]] || fail 'successful login did not rotate cb_session'
remember "$ROTATED_SESSION_COOKIE"
for rotated_path in '/api/v1/me' '/api/v1/runtime/capabilities'; do
  old_status="$(curl -sS --max-time 5 -o "$TMP_DIR/rotation-old.json" -w '%{http_code}' \
    -b "$OLD_COOKIE_JAR" "$PUBLIC_APP_ORIGIN$rotated_path")"
  http_status 401 "$old_status" "old session request to $rotated_path"
  new_status="$(curl -sS --max-time 5 -o "$TMP_DIR/rotation-new.json" -w '%{http_code}' \
    -b "$COOKIE_JAR" "$PUBLIC_APP_ORIGIN$rotated_path")"
  http_status 200 "$new_status" "rotated session request to $rotated_path"
done

step 'Checking OTP attempt exhaustion...'
WRONG_EMAIL="$(new_email wrong)"
remember "$WRONG_EMAIL"
challenge "$WRONG_EMAIL" 202 'wrong-challenge'
WRONG_REAL_CODE="$(latest_code "$WRONG_EMAIL")" || fail 'could not read the wrong-attempt mock OTP'
remember "$WRONG_REAL_CODE"
if [[ "$WRONG_REAL_CODE" == '000000' ]]; then WRONG_CODE='999999'; else WRONG_CODE='000000'; fi
WRONG_ERROR_FINGERPRINT=''
for attempt in 1 2 3 4 5; do
  verify "$WRONG_EMAIL" "$WRONG_CODE" 401 "wrong-attempt-${attempt}"
  assert_auth_error "$TMP_DIR/wrong-attempt-${attempt}.json"
  current_fingerprint="$(auth_error_fingerprint "$TMP_DIR/wrong-attempt-${attempt}.json")"
  if [[ -z "$WRONG_ERROR_FINGERPRINT" ]]; then
    WRONG_ERROR_FINGERPRINT="$current_fingerprint"
  else
    [[ "$current_fingerprint" == "$WRONG_ERROR_FINGERPRINT" ]] || fail 'wrong-code responses were distinguishable'
  fi
done
verify "$WRONG_EMAIL" "$WRONG_REAL_CODE" 401 'wrong-after-invalidation'
assert_auth_error "$TMP_DIR/wrong-after-invalidation.json"
[[ "$(auth_error_fingerprint "$TMP_DIR/wrong-after-invalidation.json")" == "$WRONG_ERROR_FINGERPRINT" ]] \
  || fail 'invalidated-code response differed from wrong-code responses'

step 'Checking Redis fail-closed challenge and fail-open verification...'
REDIS_EMAIL="$(new_email redis-existing)"
remember "$REDIS_EMAIL"
challenge "$REDIS_EMAIL" 202 'redis-existing-challenge'
REDIS_CODE="$(latest_code "$REDIS_EMAIL")" || fail 'could not read the Redis-outage mock OTP'
remember "$REDIS_CODE"
REDIS_COOKIE_JAR="$TMP_DIR/redis-verification.cookies"
REDIS_DOWN_EMAIL="$(new_email redis-new)"
remember "$REDIS_DOWN_EMAIL"
"${COMPOSE[@]}" stop redis_hot >/dev/null
redis_active_before="$(pg_scalar "SELECT count(*) FROM auth_otp_challenges WHERE consumed_at IS NULL AND invalidated_at IS NULL;")" \
  || fail 'could not inspect active challenges before Redis failure'
challenge "$REDIS_DOWN_EMAIL" 503 'redis-down-challenge'
redis_active_after="$(pg_scalar "SELECT count(*) FROM auth_otp_challenges WHERE consumed_at IS NULL AND invalidated_at IS NULL;")" \
  || fail 'could not inspect active challenges after Redis failure'
[[ "$redis_active_after" == "$redis_active_before" ]] || fail 'Redis failure created a pending challenge'
REDIS_DOWN_MAIL_STATUS="$(TEST_EMAIL="$REDIS_DOWN_EMAIL" node --input-type=module -e '
    process.stdout.write(JSON.stringify({ to: process.env.TEST_EMAIL }));
  ' | curl -sS --max-time 5 -o "$TMP_DIR/redis-down-mail.json" -w '%{http_code}' \
  -X POST "$RESEND_MOCK_BASE_URL/__test/inbox/latest" \
  -H "Authorization: Bearer $RESEND_MOCK_API_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary @-)"
http_status 404 "$REDIS_DOWN_MAIL_STATUS" 'mock inbox lookup after Redis failure'
verify "$REDIS_EMAIL" "$REDIS_CODE" 200 'redis-down-verification' "$REDIS_COOKIE_JAR"
REDIS_SESSION_COOKIE="$(awk '$6 == "cb_session" { value = $7 } END { print value }' "$REDIS_COOKIE_JAR")"
[[ "$REDIS_SESSION_COOKIE" =~ ^s1\.[A-Za-z0-9_-]{43}$ ]] || fail 'Redis-down verification did not issue cb_session'
remember "$REDIS_SESSION_COOKIE"
"${COMPOSE[@]}" up -d --wait redis_hot
"${COMPOSE[@]}" restart api >/dev/null
"${COMPOSE[@]}" up -d --wait api
REDIS_ME_STATUS="$(curl -sS --max-time 5 -o "$TMP_DIR/redis-recovered-me.json" -w '%{http_code}' \
  -b "$REDIS_COOKIE_JAR" "$PUBLIC_APP_ORIGIN/api/v1/me")"
http_status 200 "$REDIS_ME_STATUS" 'session after Redis and API recovery'

step 'Checking Resend failure classification and old-code preservation...'
PERMANENT_EMAIL="$(new_email provider-permanent-existing)"
remember "$PERMANENT_EMAIL"
set_mock_mode accepted
challenge "$PERMANENT_EMAIL" 202 'provider-permanent-old-challenge'
PERMANENT_OLD_CODE="$(latest_code "$PERMANENT_EMAIL")" || fail 'could not read the existing OTP before provider 422'
remember "$PERMANENT_OLD_CODE"
pg_scalar "UPDATE auth_otp_challenges SET created_at = created_at - interval '61 seconds', activated_at = activated_at - interval '61 seconds', expires_at = expires_at - interval '61 seconds' WHERE consumed_at IS NULL AND invalidated_at IS NULL;" >/dev/null \
  || fail 'could not age the existing challenge before provider 422'
PERMANENT_ACTIVE_BEFORE="$(pg_scalar "SELECT count(*) FROM auth_otp_challenges WHERE consumed_at IS NULL AND invalidated_at IS NULL AND activated_at IS NOT NULL;")"
set_mock_mode permanent
challenge "$PERMANENT_EMAIL" 202 'provider-permanent-existing'
PERMANENT_ACTIVE_AFTER="$(pg_scalar "SELECT count(*) FROM auth_otp_challenges WHERE consumed_at IS NULL AND invalidated_at IS NULL AND activated_at IS NOT NULL;")"
[[ "$PERMANENT_ACTIVE_AFTER" == "$PERMANENT_ACTIVE_BEFORE" ]] || fail 'provider 422 replaced the previous active challenge'
PERMANENT_COOKIE_JAR="$TMP_DIR/provider-permanent.cookies"
set_mock_mode accepted
verify "$PERMANENT_EMAIL" "$PERMANENT_OLD_CODE" 200 'provider-permanent-old-code' "$PERMANENT_COOKIE_JAR"

for provider_case in 'invalid_from:503' 'invalid_request:503' 'rate_limited:503' 'server_error:503' 'timeout:503'; do
  mode="${provider_case%%:*}"
  expected="${provider_case##*:}"
  provider_email="$(new_email "provider-${mode}")"
  remember "$provider_email"
  active_before="$(pg_scalar "SELECT count(*) FROM auth_otp_challenges WHERE consumed_at IS NULL AND invalidated_at IS NULL;")" \
    || fail "could not inspect active challenges before provider mode $mode"
  set_mock_mode "$mode"
  challenge "$provider_email" "$expected" "provider-${mode}"
  active_after="$(pg_scalar "SELECT count(*) FROM auth_otp_challenges WHERE consumed_at IS NULL AND invalidated_at IS NULL;")" \
    || fail "could not inspect active challenges after provider mode $mode"
  [[ "$active_after" == "$active_before" ]] || fail "provider mode $mode left an active challenge"
done
set_mock_mode accepted

step 'Checking PostgreSQL outage and logout behavior...'
PG_EMAIL="$(new_email postgres)"
remember "$PG_EMAIL"
challenge "$PG_EMAIL" 202 'postgres-challenge'
PG_CODE="$(latest_code "$PG_EMAIL")" || fail 'could not read the PostgreSQL-outage mock OTP'
remember "$PG_CODE"
"${COMPOSE[@]}" stop postgres >/dev/null

PG_VERIFY_HEADERS="$TMP_DIR/postgres-verification.headers"
PG_VERIFY_STATUS="$(json_verification "$PG_EMAIL" "$PG_CODE" | curl -sS --max-time 12 \
  -D "$PG_VERIFY_HEADERS" -o "$TMP_DIR/postgres-verification.json" -w '%{http_code}' \
  -X POST "$PUBLIC_APP_ORIGIN/api/v1/auth/email/verifications" \
  -H "Origin: $PUBLIC_APP_ORIGIN" \
  -H 'Content-Type: application/json' \
  --data-binary @- || true)"
http_status 503 "$PG_VERIFY_STATUS" 'verification during PostgreSQL outage'
assert_auth_error "$TMP_DIR/postgres-verification.json"
assert_no_set_cookie "$PG_VERIFY_HEADERS"

PG_LOGOUT_HEADERS="$TMP_DIR/postgres-logout.headers"
PG_LOGOUT_STATUS="$(curl -sS --max-time 12 -D "$PG_LOGOUT_HEADERS" -o "$TMP_DIR/postgres-logout.json" -w '%{http_code}' \
  -b "$COOKIE_JAR" -X POST "$PUBLIC_APP_ORIGIN/api/v1/auth/logout" \
  -H "Origin: $PUBLIC_APP_ORIGIN" \
  -H 'Content-Type: application/json' \
  --data-binary '{}' || true)"
http_status 503 "$PG_LOGOUT_STATUS" 'logout during PostgreSQL outage'
assert_auth_error "$TMP_DIR/postgres-logout.json"
assert_no_set_cookie "$PG_LOGOUT_HEADERS"

"${COMPOSE[@]}" up -d --wait postgres
wait_for_authenticated_me "$COOKIE_JAR"

LOGOUT_STATUS="$(curl -sS --max-time 5 -D "$TMP_DIR/logout.headers" -o "$TMP_DIR/logout.json" -w '%{http_code}' \
  -b "$COOKIE_JAR" -X POST "$PUBLIC_APP_ORIGIN/api/v1/auth/logout" \
  -H "Origin: $PUBLIC_APP_ORIGIN" \
  -H 'Content-Type: application/json' \
  --data-binary '{}')"
http_status 200 "$LOGOUT_STATUS" 'logout'
grep -Eiq '^cache-control:[[:space:]]*no-store' "$TMP_DIR/logout.headers" || fail 'logout omitted Cache-Control: no-store'
grep -Eiq '^set-cookie:[[:space:]]*cb_session=;.*max-age=0.*path=/' "$TMP_DIR/logout.headers" || fail 'logout did not clear the development cb_session at the root path'

for revoked_path in '/api/v1/me' '/api/v1/runtime/capabilities'; do
  revoked_name="$(printf '%s' "$revoked_path" | tr '/?' '__')"
  revoked_status="$(curl -sS --max-time 5 -o "$TMP_DIR/${revoked_name}.json" -w '%{http_code}' \
    -b "$COOKIE_JAR" "$PUBLIC_APP_ORIGIN$revoked_path")"
  http_status 401 "$revoked_status" "revoked session request to $revoked_path"
done
SSE_SESSION_ID="$(node --input-type=module -e 'import { randomUUID } from "node:crypto"; process.stdout.write(randomUUID());')"
SSE_STATUS="$(curl -sS --max-time 5 -D "$TMP_DIR/revoked-sse.headers" -o "$TMP_DIR/revoked-sse.json" -w '%{http_code}' \
  -b "$COOKIE_JAR" "$PUBLIC_APP_ORIGIN/api/v1/runtime/sessions/$SSE_SESSION_ID/stream")"
http_status 401 "$SSE_STATUS" 'new SSE request after logout'
grep -Eiq '^content-type:[[:space:]]*application/json' "$TMP_DIR/revoked-sse.headers" || fail 'revoked SSE request did not return JSON'

step 'Checking client-event pathname sentinels never reach container logs...'
CLIENT_EVENT_STATUS="$(
  CLIENT_EMAIL="$API_EMAIL" CLIENT_OTP="$SECOND_CODE" CLIENT_COOKIE="$SESSION_COOKIE" \
    CLIENT_KEY="$RESEND_MOCK_API_KEY" node --input-type=module -e '
      const path = [
        process.env.CLIENT_EMAIL,
        process.env.CLIENT_OTP,
        "cb_session=" + process.env.CLIENT_COOKIE,
        process.env.CLIENT_KEY,
      ].join("/");
      process.stdout.write(JSON.stringify({
        kind: "api_error",
        traceId: "trace-container-client-event",
        url: "https://client.invalid/" + path,
        route: "/" + path,
        message: "sensitive client event",
      }));
    ' | curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
      -X POST "$PUBLIC_APP_ORIGIN/api/v1/client-events" \
      -H 'Content-Type: application/json' --data-binary @-
)"
http_status 204 "$CLIENT_EVENT_STATUS" 'sensitive-path client event'

step 'Checking container logs for generated sensitive values...'
capture_logs
leak_found=0
for sensitive_log_service in api runtime resend-mock web; do
  service_log="$TMP_DIR/${sensitive_log_service}.log"
  "${COMPOSE[@]}" logs --no-color "$sensitive_log_service" >"$service_log" 2>&1 \
    || fail 'could not capture a service log for the sensitive-value scan'
  leak_index=0
  while IFS= read -r sentinel; do
    leak_index=$((leak_index + 1))
    if [[ -n "$sentinel" ]] && grep -Fq -- "$sentinel" "$service_log"; then
      printf 'sensitive sentinel index %s appeared in %s container logs\n' \
        "$leak_index" "$sensitive_log_service" >&2
      leak_found=1
    fi
  done <"$SENTINEL_FILE"
done
[[ "$leak_found" -eq 0 ]] || fail 'a generated credential, email address, OTP, or Cookie appeared in container logs'

printf 'Resend auth browser and API E2E passed.\n'
