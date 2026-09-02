#!/usr/bin/env bash
# 主链路 P0 协议验收。匿名边界始终执行；鉴权段只接受调用方提供的临时 Cookie jar。
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3000}"
WEB_BASE="${WEB_BASE:-http://localhost}"
WEB_ORIGIN="${WEB_BASE%/}"
CB_SESSION_COOKIE_JAR="${CB_SESSION_COOKIE_JAR:-}"
WRONG_ORIGIN='https://wrong-origin.invalid'
ZERO_ID='00000000-0000-7000-8000-000000000000'

pass() { printf '\033[1;32m[pass]\033[0m %s\n' "$*"; }
skip() { printf '\033[1;33m[skip]\033[0m %s\n' "$*"; }
log() { printf '\033[1;34m[accept]\033[0m %s\n' "$*"; }
fail() {
  printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2
  exit 1
}
curl_request() { command curl --disable "$@"; }
http_code() { curl_request -sS --max-time 10 -o /dev/null -w '%{http_code}' "$@"; }

command -v curl >/dev/null 2>&1 || fail '需要 curl'
if ! curl_request -fsS -o /dev/null --max-time 5 "${API_BASE}/health" 2>/dev/null; then
  skip "live 全栈未就绪（${API_BASE}/health 不可达），未执行验收"
  exit 0
fi
ready="$(curl_request -fsS --max-time 10 "${API_BASE}/ready")" || fail '/ready 不可达'
grep -q '"ready":true' <<<"${ready}" || fail '/ready 未就绪'
pass 'live 栈已就绪'

assert_read_requires_auth() {
  local base="$1" path="$2" status
  status="$(http_code "${base}${path}")" || fail "GET ${path} 不可达"
  [[ "${status}" == '401' ]] || fail "GET ${path} 匿名访问未返回 401（实际 ${status}）"
}

assert_browser_write_guards() {
  local method="$1" base="$2" path="$3"
  local no_origin_status wrong_origin_status trusted_origin_status
  no_origin_status="$(http_code -X "${method}" "${base}${path}")" \
    || fail "${method} ${path} 不可达"
  [[ "${no_origin_status}" == '403' ]] \
    || fail "${method} ${path} 缺少 Origin 未返回 403（实际 ${no_origin_status}）"

  wrong_origin_status="$(http_code -X "${method}" \
    -H "Origin: ${WRONG_ORIGIN}" -H 'Sec-Fetch-Site: cross-site' \
    "${base}${path}")" || fail "${method} ${path} 错误 Origin 探针不可达"
  [[ "${wrong_origin_status}" == '403' ]] \
    || fail "${method} ${path} 错误 Origin 未返回 403（实际 ${wrong_origin_status}）"

  trusted_origin_status="$(http_code -X "${method}" \
    -H "Origin: ${WEB_ORIGIN}" -H 'Sec-Fetch-Site: same-origin' \
    "${base}${path}")" || fail "${method} ${path} 可信 Origin 探针不可达"
  [[ "${trusted_origin_status}" == '401' ]] \
    || fail "${method} ${path} 可信 Origin 无会话未返回 401（实际 ${trusted_origin_status}）"
}

assert_trusted_origin_requires_auth() {
  local method="$1" base="$2" path="$3" status
  status="$(http_code -X "${method}" \
    -H "Origin: ${WEB_ORIGIN}" -H 'Sec-Fetch-Site: same-origin' \
    "${base}${path}")" || fail "${method} ${path} 可信 Origin 探针不可达"
  [[ "${status}" == '401' ]] \
    || fail "${method} ${path} 可信 Origin 无会话未返回 401（实际 ${status}）"
}

assert_public_auth_write_guards() {
  local path="$1"
  local no_origin_status wrong_origin_status trusted_origin_status
  no_origin_status="$(http_code -X POST "${API_BASE}${path}")" \
    || fail "POST ${path} 缺少 Origin 探针不可达"
  [[ "${no_origin_status}" == '403' ]] \
    || fail "POST ${path} 缺少 Origin 未返回 403（实际 ${no_origin_status}）"

  wrong_origin_status="$(http_code -X POST \
    -H "Origin: ${WRONG_ORIGIN}" -H 'Sec-Fetch-Site: cross-site' \
    "${API_BASE}${path}")" || fail "POST ${path} 错误 Origin 探针不可达"
  [[ "${wrong_origin_status}" == '403' ]] \
    || fail "POST ${path} 错误 Origin 未返回 403（实际 ${wrong_origin_status}）"

  trusted_origin_status="$(http_code -X POST \
    -H "Origin: ${WEB_ORIGIN}" -H 'Sec-Fetch-Site: same-origin' \
    "${API_BASE}${path}")" || fail "POST ${path} 可信 Origin 探针不可达"
  [[ "${trusted_origin_status}" == '415' ]] \
    || fail "POST ${path} 可信 Origin 空请求未返回 415（实际 ${trusted_origin_status}）"
}

assert_sse_cookie_only() {
  local base="$1" path="$2" label="$3" content_type
  [[ "$(http_code "${base}${path}")" == '401' ]] || fail "匿名 ${label} 未返回 401"
  [[ "$(http_code -H 'Authorization: Bearer placeholder' "${base}${path}")" == '401' ]] \
    || fail "${label} 错误接受 Bearer"
  [[ "$(http_code "${base}${path}?access_token=placeholder")" == '401' ]] \
    || fail "${label} 错误接受 query token"
  content_type="$(curl_request -sS --max-time 5 -o /dev/null -w '%{content_type}' "${base}${path}")"
  ! grep -qi 'text/event-stream' <<<"${content_type}" \
    || fail "未授权 ${label} 在校验前建立了流"
}

log 'A1 检查读端点先拒绝无会话，浏览器写端点先校验来源再拒绝无会话'
AUTHORING_READ_PATHS=(
  '/api/v1/me'
  '/api/v1/tasks'
  "/api/v1/tasks/${ZERO_ID}"
  '/api/v1/capabilities'
  "/api/v1/capabilities/${ZERO_ID}"
  "/api/v1/capabilities/${ZERO_ID}/definition"
  '/api/v1/agent-projects'
  "/api/v1/agent-projects/${ZERO_ID}"
  "/api/v1/agent-projects/${ZERO_ID}/revisions/${ZERO_ID}"
  '/api/v1/billing/wallet'
  "/api/v1/billing/recharge-orders/by-intent/${ZERO_ID}"
  "/api/v1/billing/recharge-orders/${ZERO_ID}"
)
for path in "${AUTHORING_READ_PATHS[@]}"; do
  assert_read_requires_auth "${API_BASE}" "${path}"
done

AUTHORING_WRITE_PROBES=(
  'POST /api/v1/tasks'
  "POST /api/v1/tasks/${ZERO_ID}/retry"
  "POST /api/v1/capabilities/${ZERO_ID}/publish"
  "POST /api/v1/capabilities/${ZERO_ID}/unpublish"
  'POST /api/v1/agent-projects'
  "POST /api/v1/agent-projects/${ZERO_ID}/revisions"
  "POST /api/v1/agent-projects/${ZERO_ID}/tests/${ZERO_ID}/reviews"
  "POST /api/v1/agent-projects/${ZERO_ID}/releases"
  'POST /api/v1/codex-agent-shares'
)
for probe in "${AUTHORING_WRITE_PROBES[@]}"; do
  assert_browser_write_guards "${probe%% *}" "${API_BASE}" "${probe#* }"
done
# 该端点有 10/min 的独立限流；只做一次可信来源下的匿名鉴权探针，避免重跑自触发 429。
assert_trusted_origin_requires_auth POST "${API_BASE}" '/api/v1/billing/recharge-orders'
PUBLIC_AUTH_WRITE_PATHS=(
  '/api/v1/auth/email/challenges'
  '/api/v1/auth/email/verifications'
)
for path in "${PUBLIC_AUTH_WRITE_PATHS[@]}"; do
  assert_public_auth_write_guards "${path}"
done
pass 'authoring 读取鉴权与浏览器写入 Origin-first 边界生效'

log 'A2 检查 SSE 只接受 Cookie 且在建流前拒绝替代凭据'
SSE_PATH="/api/v1/tasks/${ZERO_ID}/events"
assert_sse_cookie_only "${API_BASE}" "${SSE_PATH}" '任务 SSE'
pass '任务 SSE Cookie-only 边界生效'

log 'A3 检查匿名登出的 Origin-first 边界与可信请求幂等性'
logout_no_origin_status="$(
  printf '{}' |
    curl_request -sS --max-time 10 -o /dev/null -w '%{http_code}' -X POST \
      -H 'Content-Type: application/json' \
      --data-binary @- "${API_BASE}/api/v1/auth/logout"
)" || fail '匿名登出缺少 Origin 探针不可达'
[[ "${logout_no_origin_status}" == '403' ]] \
  || fail "匿名登出缺少 Origin 未返回 403（实际 ${logout_no_origin_status}）"
logout_wrong_origin_status="$(
  printf '{}' |
    curl_request -sS --max-time 10 -o /dev/null -w '%{http_code}' -X POST \
      -H 'Content-Type: application/json' \
      -H "Origin: ${WRONG_ORIGIN}" \
      -H 'Sec-Fetch-Site: cross-site' \
      --data-binary @- "${API_BASE}/api/v1/auth/logout"
)" || fail '匿名登出错误 Origin 探针不可达'
[[ "${logout_wrong_origin_status}" == '403' ]] \
  || fail "匿名登出错误 Origin 未返回 403（实际 ${logout_wrong_origin_status}）"
logout_trusted_origin_status="$(
  printf '{}' |
    curl_request -sS --max-time 10 -o /dev/null -w '%{http_code}' -X POST \
      -H 'Content-Type: application/json' \
      -H "Origin: ${WEB_ORIGIN}" \
      -H 'Sec-Fetch-Site: same-origin' \
      --data-binary @- "${API_BASE}/api/v1/auth/logout"
)" || fail '匿名登出不可达'
[[ "${logout_trusted_origin_status}" == '200' ]] \
  || fail "匿名登出可信 Origin 未返回 200（实际 ${logout_trusted_origin_status}）"
pass '匿名登出 Origin-first 边界与幂等成功生效'

log 'A4 检查 runtime 同源反代与会话边界'
if curl_request -fsS -o /dev/null --max-time 5 "${WEB_ORIGIN}/" 2>/dev/null; then
  RUNTIME_READ_PATHS=(
    '/api/v1/runtime/capabilities'
    '/api/v1/runtime/sessions'
    "/api/v1/runtime/sessions/${ZERO_ID}"
    "/api/v1/runtime/artifacts/${ZERO_ID}/content"
    "/api/v1/runtime/agent-tests/${ZERO_ID}"
    "/api/v1/runtime/agent-projects/${ZERO_ID}/tests"
  )
  for path in "${RUNTIME_READ_PATHS[@]}"; do
    assert_read_requires_auth "${WEB_ORIGIN}" "${path}"
  done
  RUNTIME_SSE_PATH="/api/v1/runtime/sessions/${ZERO_ID}/stream"
  assert_sse_cookie_only "${WEB_ORIGIN}" "${RUNTIME_SSE_PATH}" 'Runtime SSE'

  RUNTIME_WRITE_PROBES=(
    'POST /api/v1/runtime/studio/sessions'
    'POST /api/v1/runtime/sessions'
    "PATCH /api/v1/runtime/sessions/${ZERO_ID}"
    "DELETE /api/v1/runtime/sessions/${ZERO_ID}"
    "POST /api/v1/runtime/sessions/${ZERO_ID}/messages"
    "POST /api/v1/runtime/sessions/${ZERO_ID}/interrupt"
    "POST /api/v1/runtime/studio/sessions/${ZERO_ID}/ui-revisions"
    "POST /api/v1/runtime/agent-revisions/${ZERO_ID}/tests"
    "POST /api/v1/runtime/agents/${ZERO_ID}/sessions"
  )
  for probe in "${RUNTIME_WRITE_PROBES[@]}"; do
    assert_browser_write_guards "${probe%% *}" "${WEB_ORIGIN}" "${probe#* }"
  done
  pass 'runtime 同源反代的读取、SSE 与浏览器写入边界生效'
else
  skip 'Web 未起，跳过 runtime 反代检查'
fi

if [[ -z "${CB_SESSION_COOKIE_JAR}" ]]; then
  skip '未提供 CB_SESSION_COOKIE_JAR，鉴权主链路由 resend-auth E2E 覆盖'
  exit 0
fi
[[ -f "${CB_SESSION_COOKIE_JAR}" && -r "${CB_SESSION_COOKIE_JAR}" ]] \
  || fail 'CB_SESSION_COOKIE_JAR 不可读'

log 'B1 使用已通过邮箱验证码建立的临时 Cookie jar 验证会话'
[[ "$(http_code -b "${CB_SESSION_COOKIE_JAR}" "${API_BASE}/api/v1/me")" == '200' ]] \
  || fail 'Cookie jar 中没有有效会话'
pass '临时邮箱会话有效'

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agora-acceptance.XXXXXX")"
chmod 700 "${TMP_DIR}"
trap 'rm -rf "${TMP_DIR}"' EXIT
IDEMPOTENCY_KEY="acceptance-$(date +%s)-$$-${RANDOM}"
REQUEST_BODY="$(node -e 'process.stdout.write(JSON.stringify({idempotencyKey:process.argv[1],description:"acceptance smoke"}))' "${IDEMPOTENCY_KEY}")"

log 'B2 检查错误来源被拒绝且建任务幂等回放携带唯一公开 Origin'
wrong_origin_status="$(curl_request -sS --max-time 20 -b "${CB_SESSION_COOKIE_JAR}" -o /dev/null -w '%{http_code}' \
  -H "Origin: ${WRONG_ORIGIN}" -H 'Sec-Fetch-Site: cross-site' \
  -H 'Content-Type: application/json' --data-binary "${REQUEST_BODY}" "${API_BASE}/api/v1/tasks")"
[[ "${wrong_origin_status}" == '403' ]] || fail '携带错误 Origin 的鉴权写请求未返回 403'
first_status="$(curl_request -sS --max-time 20 -b "${CB_SESSION_COOKIE_JAR}" -o "${TMP_DIR}/first.json" -w '%{http_code}' \
  -H "Origin: ${WEB_ORIGIN}" -H 'Sec-Fetch-Site: same-origin' \
  -H 'Content-Type: application/json' --data-binary "${REQUEST_BODY}" "${API_BASE}/api/v1/tasks")"
second_status="$(curl_request -sS --max-time 20 -b "${CB_SESSION_COOKIE_JAR}" -o "${TMP_DIR}/second.json" -w '%{http_code}' \
  -H "Origin: ${WEB_ORIGIN}" -H 'Sec-Fetch-Site: same-origin' \
  -H 'Content-Type: application/json' --data-binary "${REQUEST_BODY}" "${API_BASE}/api/v1/tasks")"
[[ "${first_status}" == '201' && "${second_status}" == '200' ]] || fail '建任务幂等状态码不符合契约'
TASK_ID="$(node -e '
const fs=require("node:fs");const a=JSON.parse(fs.readFileSync(process.argv[1]));const b=JSON.parse(fs.readFileSync(process.argv[2]));
if(typeof a?.data?.task?.id!=="string"||a.data.task.id!==b?.data?.task?.id)process.exit(1);process.stdout.write(a.data.task.id);
' "${TMP_DIR}/first.json" "${TMP_DIR}/second.json" 2>/dev/null)" || fail '建任务幂等回放没有返回同一任务'
pass '同一幂等键回放同一任务'

log 'B3 检查任务 SSE 首帧和恢复编号'
frames="$(curl_request -sS --max-time 4 -b "${CB_SESSION_COOKIE_JAR}" "${API_BASE}/api/v1/tasks/${TASK_ID}/events" 2>/dev/null || true)"
grep -q 'state_snapshot' <<<"${frames}" || fail 'SSE 首帧缺少 state_snapshot'
grep -qE '^id:' <<<"${frames}" || fail 'SSE 帧缺少恢复编号'
pass '鉴权主链路与 SSE 验收通过'
