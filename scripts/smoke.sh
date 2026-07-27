#!/usr/bin/env bash
# 对已启动环境执行不依赖邮件投递的最小健康与认证边界冒烟。
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3000}"
WEB_BASE="${WEB_BASE:-http://localhost}"

pass() { printf '\033[1;32m[pass]\033[0m %s\n' "$*"; }
log() { printf '\033[1;34m[smoke]\033[0m %s\n' "$*"; }
fail() {
  printf '\033[1;31m[fail]\033[0m %s\n' "$*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail '需要 curl'
if ! curl -fsS -o /dev/null --max-time 5 "${API_BASE}/health" 2>/dev/null; then
  fail "API（${API_BASE}）不可达，请先运行 scripts/start.sh"
fi

log '1/5 检查 liveness'
health="$(curl -fsS --max-time 5 "${API_BASE}/health")" || fail '/health 不可达'
grep -q '"status":"ok"' <<<"${health}" || fail '/health 未返回 status=ok'
pass '/health = ok'

log '2/5 检查不依赖邮件供应商的 readiness'
ready="$(curl -fsS --max-time 10 "${API_BASE}/ready")" || fail '/ready 不可达'
for dependency in db redis_queue redis_hot minio llm; do
  grep -q "\"name\":\"${dependency}\"" <<<"${ready}" || fail "/ready 缺依赖键 ${dependency}"
done
grep -q '"ready":true' <<<"${ready}" || fail '/ready 未就绪'
pass '/ready 包含四个必需依赖与可降级 LLM，且不依赖邮件供应商'

log '3/5 检查未知路由错误信封'
not_found_file="$(mktemp "${TMPDIR:-/tmp}/agora-smoke-404.XXXXXX")"
trap 'rm -f "${not_found_file}"' EXIT
not_found_status="$(curl -sS --max-time 5 -o "${not_found_file}" -w '%{http_code}' "${API_BASE}/api/v1/__not_exist__")" \
  || fail '未知路由不可达'
[[ "${not_found_status}" == '404' ]] || fail '未知路由未返回 404'
grep -q '"userMessage"' "${not_found_file}" || fail '404 未返回 ErrorEnvelope'
! grep -q '"code"' "${not_found_file}" || fail '404 暴露内部 code'
pass '未知路由返回安全 ErrorEnvelope'

log '4/5 检查 Cookie-only 会话边界'
anonymous_status="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "${API_BASE}/api/v1/me")" \
  || fail '/me 不可达'
[[ "${anonymous_status}" == '401' ]] || fail '匿名 /me 未返回 401'
bearer_status="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
  -H 'Authorization: Bearer smoke-placeholder' "${API_BASE}/api/v1/me")" || fail 'Bearer 边界检查不可达'
[[ "${bearer_status}" == '401' ]] || fail 'Bearer 被错误地当作浏览器会话'
pass '匿名与 Bearer 请求都不能替代 HttpOnly 会话 Cookie'

log '5/5 检查同源 Web 与 runtime 反代'
if curl -fsS -o /dev/null --max-time 5 "${WEB_BASE}/" 2>/dev/null; then
  runtime_status="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "${WEB_BASE}/api/v1/runtime/capabilities")" \
    || fail 'runtime 反代不可达'
  [[ "${runtime_status}" == '401' ]] || fail '匿名 runtime 受保护路径未返回 401'
  pass 'Web 可达且 runtime 受保护路径经同源反代返回 401'
else
  log 'Web 未起或不可达，跳过可选反代检查'
fi

pass '冒烟全部通过'
