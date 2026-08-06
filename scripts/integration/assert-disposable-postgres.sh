#!/usr/bin/env bash
# Guard for integration suites that may truncate or otherwise rewrite PostgreSQL data.
# Authorization alone is insufficient: the URL must also name a loopback database with no
# query/fragment override. Never print DATABASE_URL or any credential derived from it.
set -euo pipefail

fail() {
  printf '\033[1;31m[it:pg-guard:fail]\033[0m %s\n' "$*" >&2
  exit 1
}

: "${DATABASE_URL:?需设置 DATABASE_URL（只允许临时 loopback PostgreSQL）}"
command -v node >/dev/null 2>&1 || fail "需要 Node.js"

if [[ "${GITHUB_ACTIONS:-}" == 'true' && "${CI:-}" == 'true' ]]; then
  : # Trusted GitHub-hosted CI path used by the main reusable workflow.
elif [[ "${COMBO_ALLOW_DESTRUCTIVE_INTEGRATION_DB:-}" == '1' ]]; then
  : # Explicit local opt-in for a disposable database.
else
  fail "破坏性 PostgreSQL 集成只允许 GitHub Actions，或显式设置 COMBO_ALLOW_DESTRUCTIVE_INTEGRATION_DB=1"
fi

if ! DATABASE_URL="$DATABASE_URL" node --input-type=module - <<'NODE'
let url;
try {
  url = new URL(process.env.DATABASE_URL ?? '');
} catch {
  process.exit(1);
}
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const valid =
  new Set(['postgres:', 'postgresql:']).has(url.protocol) &&
  loopbackHosts.has(url.hostname) &&
  /^\/[^/]+$/u.test(url.pathname) &&
  url.search === '' &&
  url.hash === '';
process.exit(valid ? 0 : 1);
NODE
then
  fail "DATABASE_URL 必须是无 query/fragment 的临时 loopback PostgreSQL；拒绝继续"
fi
