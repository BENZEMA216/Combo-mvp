#!/usr/bin/env bash
# 生产构建产物不得包含测试、fixture 或测试辅助文件。
set -euo pipefail

leaked_files=$(
  find apps packages -type f -path '*/dist/*' \
    \( -path '*/__tests__/*' -o -path '*/test/*' -o -name '*.test.*' -o -name '*.spec.*' \) \
    -print
)

if [[ -n "${leaked_files}" ]]; then
  echo 'Test-only files found in production artifacts:' >&2
  echo "${leaked_files}" >&2
  exit 1
fi

if grep -Eq 'resend-mock|/__test/' \
  infra/docker-compose.yml infra/docker-compose.prod.yml \
  infra/Dockerfile.api infra/Dockerfile.runtime infra/Dockerfile.web; then
  echo 'Test mail infrastructure is referenced by a production artifact.' >&2
  exit 1
fi

if grep -Eq \
  'COPY --from=build[[:space:]]+/app/db[[:space:]]+\./db([[:space:]]|$)|COPY --from=build.*(__tests__|/tests/)' \
  infra/Dockerfile.api infra/Dockerfile.runtime infra/Dockerfile.web; then
  echo 'A production runtime stage copies a project test tree or the complete database source tree.' >&2
  exit 1
fi

set +e
auth_scan_hits="$(node scripts/production-auth-scan.mjs apps packages infra scripts .github .env.compose.example .env.local.example)"
auth_scan_status=$?
set -e
if [[ "$auth_scan_status" -ne 0 ]]; then
  echo 'Production source contains a removed auth reference or credential-shaped value:' >&2
  echo "$auth_scan_hits" >&2
  exit 1
fi

echo 'Production artifacts and active source contain only the first-party email authentication stack.'
