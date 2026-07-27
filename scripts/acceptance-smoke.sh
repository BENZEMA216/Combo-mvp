#!/usr/bin/env bash
# 主链路 P0 协议验收。匿名边界始终执行；鉴权段只接受调用方提供的临时 Cookie jar。
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3000}"
WEB_BASE="${WEB_BASE:-http://localhost}"
CB_SESSION_COOKIE_JAR="${CB_SESSION_COOKIE_JAR:-}"

pass() { printf '\033[1;32m[pass]\033[0m %s\n' "$*"; }
skip() { printf '\033[1;33m[skip]\033[0m %s\n' "$*"; }
log() { printf '\033[1;34m[accept]\033[0m %s\n' "$*"; }
fail() {
  printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2
  exit 1
}
http_code() { curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$@"; }

command -v curl >/dev/null 2>&1 || fail '需要 curl'
if ! curl -fsS -o /dev/null --max-time 5 "${API_BASE}/health" 2>/dev/null; then
  skip "live 全栈未就绪（${API_BASE}/health 不可达），未执行验收"
  exit 0
fi
ready="$(curl -fsS --max-time 10 "${API_BASE}/ready")" || fail '/ready 不可达'
grep -q '"ready":true' <<<"${ready}" || fail '/ready 未就绪'
pass 'live 栈已就绪'

assert_unauthenticated() {
  local method="$1" path="$2" status
  status="$(http_code -X "${method}" "${API_BASE}${path}")" || fail "${method} ${path} 不可达"
  [[ "${status}" == '401' ]] || fail "${method} ${path} 匿名访问未返回 401"
}

log 'A1 检查主链路端点均已注册并先执行会话校验'
assert_unauthenticated GET '/api/v1/me'
assert_unauthenticated GET '/api/v1/tasks'
assert_unauthenticated GET '/api/v1/capabilities'
assert_unauthenticated POST '/api/v1/tasks'
assert_unauthenticated POST '/api/v1/tasks/00000000-0000-7000-8000-000000000000/retry'
assert_unauthenticated POST '/api/v1/capabilities/00000000-0000-7000-8000-000000000000/publish'
pass 'authoring 主链路匿名边界返回 401'

log 'A2 检查 SSE 只接受 Cookie 且在建流前拒绝替代凭据'
SSE_PATH='/api/v1/tasks/00000000-0000-7000-8000-000000000000/events'
[[ "$(http_code "${API_BASE}${SSE_PATH}")" == '401' ]] || fail '匿名 SSE 未返回 401'
[[ "$(http_code -H 'Authorization: Bearer placeholder' "${API_BASE}${SSE_PATH}")" == '401' ]] \
  || fail 'SSE 错误接受 Bearer'
[[ "$(http_code "${API_BASE}${SSE_PATH}?access_token=placeholder")" == '401' ]] \
  || fail 'SSE 错误接受 query token'
content_type="$(curl -sS --max-time 5 -o /dev/null -w '%{content_type}' "${API_BASE}${SSE_PATH}")"
! grep -qi 'text/event-stream' <<<"${content_type}" || fail '未授权 SSE 在校验前建立了流'
pass 'SSE Cookie-only 边界生效'

log 'A3 检查匿名登出保持幂等且要求可信 JSON 请求'
logout_status="$(
  printf '{}' |
    curl -sS --max-time 10 -o /dev/null -w '%{http_code}' -X POST \
      -H 'Content-Type: application/json' \
      -H "Origin: ${WEB_BASE}" \
      -H 'Sec-Fetch-Site: same-origin' \
      --data-binary @- "${API_BASE}/api/v1/auth/logout"
)" || fail '匿名登出不可达'
[[ "${logout_status}" == '200' ]] || fail '匿名登出未返回 200'
pass '匿名登出返回幂等成功'

log 'A4 检查 runtime 同源反代与会话边界'
if curl -fsS -o /dev/null --max-time 5 "${WEB_BASE}/" 2>/dev/null; then
  [[ "$(http_code "${WEB_BASE}/api/v1/runtime/capabilities")" == '401' ]] \
    || fail '匿名 runtime 受保护路径未返回 401'
  pass 'runtime 同源反代返回 401'
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
wrong_origin_status="$(curl -sS --max-time 20 -b "${CB_SESSION_COOKIE_JAR}" -o /dev/null -w '%{http_code}' \
  -H 'Origin: https://wrong-origin.invalid' -H 'Sec-Fetch-Site: cross-site' \
  -H 'Content-Type: application/json' --data-binary "${REQUEST_BODY}" "${API_BASE}/api/v1/tasks")"
[[ "${wrong_origin_status}" == '403' ]] || fail '携带错误 Origin 的鉴权写请求未返回 403'
first_status="$(curl -sS --max-time 20 -b "${CB_SESSION_COOKIE_JAR}" -o "${TMP_DIR}/first.json" -w '%{http_code}' \
  -H "Origin: ${WEB_BASE}" -H 'Sec-Fetch-Site: same-origin' \
  -H 'Content-Type: application/json' --data-binary "${REQUEST_BODY}" "${API_BASE}/api/v1/tasks")"
second_status="$(curl -sS --max-time 20 -b "${CB_SESSION_COOKIE_JAR}" -o "${TMP_DIR}/second.json" -w '%{http_code}' \
  -H "Origin: ${WEB_BASE}" -H 'Sec-Fetch-Site: same-origin' \
  -H 'Content-Type: application/json' --data-binary "${REQUEST_BODY}" "${API_BASE}/api/v1/tasks")"
[[ "${first_status}" == '201' && "${second_status}" == '200' ]] || fail '建任务幂等状态码不符合契约'
TASK_ID="$(node -e '
const fs=require("node:fs");const a=JSON.parse(fs.readFileSync(process.argv[1]));const b=JSON.parse(fs.readFileSync(process.argv[2]));
if(typeof a?.data?.task?.id!=="string"||a.data.task.id!==b?.data?.task?.id)process.exit(1);process.stdout.write(a.data.task.id);
' "${TMP_DIR}/first.json" "${TMP_DIR}/second.json" 2>/dev/null)" || fail '建任务幂等回放没有返回同一任务'
pass '同一幂等键回放同一任务'

log 'B3 检查任务 SSE 首帧和恢复编号'
frames="$(curl -sS --max-time 4 -b "${CB_SESSION_COOKIE_JAR}" "${API_BASE}/api/v1/tasks/${TASK_ID}/events" 2>/dev/null || true)"
grep -q 'state_snapshot' <<<"${frames}" || fail 'SSE 首帧缺少 state_snapshot'
grep -qE '^id:' <<<"${frames}" || fail 'SSE 帧缺少恢复编号'
pass '鉴权主链路与 SSE 验收通过'
