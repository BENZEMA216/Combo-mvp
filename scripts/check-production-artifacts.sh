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

legacy_auth_pattern='log'"to|dev"'-login|cb_'"refresh|cb_auth_"'tx|api/v1/'"auth/(login|callback|refresh)|session"'Refresh|refresh'"Token"
legacy_auth_hits=$(
  rg -n -i \
    "$legacy_auth_pattern" \
    apps packages infra scripts .github .env.* \
    --glob '!**/README.md' \
    --glob '!**/*.test.*' \
    --glob '!scripts/integration/db-migrate.sh' \
    --glob '!scripts/check-production-artifacts.sh' \
    | grep -Ev \
      -e '^scripts/start\.sh:[0-9]+:(# Logto 容器；不触碰卷、数据服务或其他 Compose 项目。|OBSOLETE_SERVICES=\(logto logto_db_seed logto_alteration\)|log .*废弃 Logto 容器.*)$' \
    || true
)
if [[ -n "$legacy_auth_hits" ]]; then
  echo 'Active source or configuration still references the removed authentication stack:' >&2
  echo "$legacy_auth_hits" >&2
  exit 1
fi

echo 'Production artifacts and active source contain only the first-party email authentication stack.'
