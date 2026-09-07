#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(cd -- "$script_dir/../.." && pwd -P)
cd "$repo_root"

fail() {
  printf 'V2 数据库迁移验证失败：%s\n' "$*" >&2
  exit 1
}

: "${DATABASE_URL:?需设置 DATABASE_URL}"
: "${POSTGRES_API_PASSWORD:?需设置 POSTGRES_API_PASSWORD}"
: "${POSTGRES_WORKER_PASSWORD:?需设置 POSTGRES_WORKER_PASSWORD}"
: "${POSTGRES_RUNTIME_PASSWORD:?需设置 POSTGRES_RUNTIME_PASSWORD}"
: "${POSTGRES_AUTHZ_PASSWORD:?需设置 POSTGRES_AUTHZ_PASSWORD}"
: "${POSTGRES_BILLING_PASSWORD:?需设置 POSTGRES_BILLING_PASSWORD}"
command -v pnpm >/dev/null 2>&1 || fail '需要 pnpm'
command -v psql >/dev/null 2>&1 || fail '需要 psql'

MIGRATION_RUNS=2 EXPECTED_MIGRATION_HEAD=0016_v2_payment_admission.sql \
  pnpm -F @cb/db migrate:v2

migration_head=$(node --experimental-strip-types db/scripts/migrate-v2.ts --head)
[[ "$migration_head" == 0016_v2_payment_admission.sql ]] || fail "迁移头错误：$migration_head"

applied=$(psql "$DATABASE_URL" -tAc 'SELECT count(*) FROM schema_migrations')
[[ "$applied" == 17 ]] || fail "迁移账本数量错误：$applied"

for table in users tasks uploads capabilities sessions messages turns artifacts audit_llm_calls \
  auth_identities auth_otp_challenges auth_sessions auth_audit_events \
  billing_accounts billing_free_allowances usage_charges recharge_orders \
  payment_attempts payment_callback_events wallet_ledger \
  v2_users v2_identities v2_auth_challenges v2_sessions \
  v2_wallets v2_ledger v2_orders v2_packages v2_holds v2_metering_events \
  v2_billable_calls v2_payment_requests v2_payment_request_keys v2_payment_fund_reservations; do
  exists=$(psql "$DATABASE_URL" -tAc "SELECT to_regclass('public.${table}') IS NOT NULL")
  [[ "$exists" == t ]] || fail "缺基表 $table"
done

for canonical_only_table in agent_projects agent_packages agent_usage_receipts; do
  exists=$(psql "$DATABASE_URL" -tAc \
    "SELECT to_regclass('public.${canonical_only_table}') IS NOT NULL")
  [[ "$exists" == f ]] || fail "V2 链混入正式表 $canonical_only_table"
done

APPLICATION_V2_ROLE_PG_TEST=1 V2_BILLING_UPGRADE_PG_TEST=1 pnpm --dir db exec vitest run \
  __tests__/application-database-v2-roles.pg.test.ts \
  __tests__/v2-role-restoration.pg.test.ts \
  __tests__/v2-billing-idempotency-upgrade.pg.test.ts

pnpm -F @cb/payment-protocol build

BILLING_V2_REPO_PG_TEST=1 BILLING_V2_TEST_DATABASE_URL="$DATABASE_URL" \
  pnpm --dir apps/billing exec vitest run src/__tests__/repo.pg.test.ts src/__tests__/payment-repo.pg.test.ts
