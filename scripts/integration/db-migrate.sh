#!/usr/bin/env bash
# 集成：业务迁移端到端（O-05 / O-07）。对一个可达的 PostgreSQL 跑全部迁移，断言迁移文件全部记账、
# 当前终态表集合精确、关键命名约束存在。CI 用临时 PG 容器即可（不需 Docker compose 全栈）。
# 入参：DATABASE_URL（必填，指向可达 PG）。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

log() { printf '\033[1;34m[it:db]\033[0m %s\n' "$*"; }
fail() {
  printf '\033[1;31m[it:db:fail]\033[0m %s\n' "$*" >&2
  exit 1
}

: "${DATABASE_URL:?需设置 DATABASE_URL（指向可达 PostgreSQL）}"
: "${POSTGRES_API_PASSWORD:?需设置 POSTGRES_API_PASSWORD}"
: "${POSTGRES_WORKER_PASSWORD:?需设置 POSTGRES_WORKER_PASSWORD}"
: "${POSTGRES_RUNTIME_PASSWORD:?需设置 POSTGRES_RUNTIME_PASSWORD}"
command -v pnpm >/dev/null 2>&1 || fail "需要 pnpm"
command -v psql >/dev/null 2>&1 || fail "需要 psql（断言 schema 用）"

# 1) 跑迁移
log "执行迁移 ..."
EXPECTED_MIGRATION_HEAD=0017_agent_session_usage_receipts.sql \
  pnpm -C "$ROOT_DIR" -F @cb/db migrate

# 2) 断言迁移文件全部记账
log "断言 schema_migrations 记账数 = 迁移文件数 ..."
expected="$(find "${ROOT_DIR}/db/migrations" -name '*.sql' | wc -l | tr -d ' ')"
applied="$(psql "$DATABASE_URL" -tAc 'SELECT count(*) FROM schema_migrations')"
[ "$applied" = "$expected" ] || fail "记账数 ${applied} != 迁移文件数 ${expected}"
log "记账 ${applied}/${expected} ✓"

# 3) 断言迁移终态表精确；除 runner 账本外只允许当前模型与 Test 已发布兼容前缀。
for tbl in users tasks uploads capabilities sessions messages turns artifacts audit_llm_calls \
  auth_identities auth_otp_challenges auth_sessions auth_audit_events \
  billing_accounts billing_free_allowances usage_charges recharge_orders \
  payment_attempts payment_callback_events wallet_ledger \
  agent_packages agent_package_releases agent_usage_receipts \
  agent_projects agent_revisions agent_tests agent_test_reviews agent_releases \
  project_agent_shares \
  oauth_clients oauth_authorization_requests oauth_authorization_codes \
  oauth_access_tokens oauth_refresh_tokens; do
  exists="$(psql "$DATABASE_URL" -tAc "SELECT to_regclass('public.${tbl}') IS NOT NULL")"
  [ "$exists" = "t" ] || fail "缺基表 ${tbl}"
done
expected_tables='agent_package_releases,agent_packages,agent_projects,agent_releases,agent_revisions,agent_test_reviews,agent_tests,agent_usage_receipts,artifacts,audit_llm_calls,auth_audit_events,auth_identities,auth_otp_challenges,auth_sessions,billing_accounts,billing_free_allowances,capabilities,messages,oauth_access_tokens,oauth_authorization_codes,oauth_authorization_requests,oauth_clients,oauth_refresh_tokens,payment_attempts,payment_callback_events,project_agent_shares,recharge_orders,sessions,tasks,turns,uploads,usage_charges,users,wallet_ledger'
actual_tables="$(psql "$DATABASE_URL" -tAc "
  SELECT string_agg(tablename, ',' ORDER BY tablename)
  FROM pg_tables
  WHERE schemaname = 'public' AND tablename <> 'schema_migrations'
")"
[ "$actual_tables" = "$expected_tables" ] ||
  fail "迁移终态表集合漂移：${actual_tables}"
log "迁移终态表集合精确 ✓"

# 4) 断言关键命名约束存在（基线固定约束名抽样：状态 CHECK、消息序唯一键）
for con in ck_tasks_step ck_tasks_status ck_uploads_status ck_sessions_status ck_messages_role ck_turns_status uq_messages_session_seq uq_turns_id_session fk_artifacts_turn_session fk_messages_turn_session; do
  exists="$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM pg_constraint WHERE conname='${con}'")"
  [ "$exists" = "1" ] || fail "缺命名约束 ${con}（实际 ${exists}）"
done
# account 大小写唯一性靠函数唯一索引（不在 pg_constraint 里），单独断言
uq_idx="$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM pg_indexes WHERE indexname='uq_users_account_lower'")"
[ "$uq_idx" = "1" ] || fail "缺唯一索引 uq_users_account_lower（实际 ${uq_idx}）"
running_turn_idx="$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM pg_indexes WHERE indexname='uq_turns_session_running' AND indexdef LIKE '%UNIQUE INDEX%WHERE (status = ''running''::text)%'")"
[ "$running_turn_idx" = "1" ] || fail "缺安全部分唯一索引 uq_turns_session_running（实际 ${running_turn_idx}）"

# 在回滚事务内构造最小归属链，真实断言第二个 running Turn 只命中目标索引。
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 >/dev/null <<'SQL'
BEGIN;
DO $$
DECLARE
  user_id uuid;
  task_id uuid;
  capability_id uuid;
  session_id uuid;
  violated_constraint text;
BEGIN
  INSERT INTO users (account)
  VALUES ('creator-aaaaaaa2') RETURNING id INTO user_id;
  INSERT INTO tasks (owner_user_id, idempotency_key)
  VALUES (user_id, 'sandbox-index-check') RETURNING id INTO task_id;
  INSERT INTO capabilities (task_id, owner_user_id, name, storage_key)
  VALUES (task_id, user_id, 'check', 'check') RETURNING id INTO capability_id;
  INSERT INTO sessions (capability_id, owner_user_id)
  VALUES (capability_id, user_id) RETURNING id INTO session_id;
  INSERT INTO turns (id, session_id, status) VALUES (gen_random_uuid(), session_id, 'running');

  BEGIN
    INSERT INTO turns (id, session_id, status) VALUES (gen_random_uuid(), session_id, 'running');
    RAISE EXCEPTION 'duplicate running Turn unexpectedly succeeded';
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS violated_constraint = CONSTRAINT_NAME;
    IF violated_constraint <> 'uq_turns_session_running' THEN
      RAISE EXCEPTION 'unexpected unique constraint: %', violated_constraint;
    END IF;
  END;
END
$$;
ROLLBACK;
SQL
log "关键命名约束与单 Session 单 running Turn 齐全 ✓"

# 在另一个回滚事务里暂时移除索引并构造历史重复，执行真实 0006 文件。
# 必须由迁移自己的显式检查先失败，连接退出后 DROP 与测试数据都应回滚。
set +e
historical_error="$({
  cat <<'SQL'
BEGIN;
DROP INDEX uq_turns_session_running;
DO $$
DECLARE
  user_id uuid;
  task_id uuid;
  capability_id uuid;
  session_id uuid;
BEGIN
  INSERT INTO users (account)
  VALUES ('creator-bbbbbbb2') RETURNING id INTO user_id;
  INSERT INTO tasks (owner_user_id, idempotency_key)
  VALUES (user_id, 'sandbox-history-check') RETURNING id INTO task_id;
  INSERT INTO capabilities (task_id, owner_user_id, name, storage_key)
  VALUES (task_id, user_id, 'history-check', 'history-check') RETURNING id INTO capability_id;
  INSERT INTO sessions (capability_id, owner_user_id)
  VALUES (capability_id, user_id) RETURNING id INTO session_id;
  INSERT INTO turns (id, session_id, status)
  VALUES (gen_random_uuid(), session_id, 'running'),
         (gen_random_uuid(), session_id, 'running');
END
$$;
SQL
  cat "${ROOT_DIR}/db/migrations/0006_one_running_turn_per_session.sql"
} | psql "$DATABASE_URL" -v ON_ERROR_STOP=1 2>&1)"
historical_status=$?
set -e
[ "$historical_status" -ne 0 ] || fail "0006 未拒绝历史重复 running Turn"
case "$historical_error" in
  *"cannot create uq_turns_session_running: duplicate running turns exist"*) ;;
  *) fail "0006 没有由显式历史重复检查失败" ;;
esac
post_failure_idx="$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM pg_indexes WHERE indexname='uq_turns_session_running'")"
post_failure_rows="$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM users WHERE account='creator-bbbbbbb2'")"
[ "$post_failure_idx" = "1" ] || fail "0006 失败事务没有恢复唯一索引"
[ "$post_failure_rows" = "0" ] || fail "0006 失败事务遗留测试数据"
log "0006 历史重复检查与事务回滚齐全 ✓"

# 5) 幂等：再跑一次不应报错、不应重复记账
log "二次迁移（幂等）..."
MIGRATION_RUNS=2 EXPECTED_MIGRATION_HEAD=0017_agent_session_usage_receipts.sql \
  pnpm -C "$ROOT_DIR" -F @cb/db migrate
applied2="$(psql "$DATABASE_URL" -tAc 'SELECT count(*) FROM schema_migrations')"
[ "$applied2" = "$expected" ] || fail "二次迁移后记账数变化 ${applied2} != ${expected}"

log "真实 PostgreSQL 16 Agent Package Registry 约束与权限 ..."
AGENT_PACKAGE_REGISTRY_PG_TEST=1 \
  pnpm --dir "${ROOT_DIR}/db" exec vitest run __tests__/agent-package-registry.pg.test.ts

log "真实 PostgreSQL 16 Agent Session freeze、terminal receipts、并发与角色权限 ..."
AGENT_SESSION_RECEIPTS_PG_TEST=1 \
  pnpm --dir "${ROOT_DIR}/db" exec vitest run \
    __tests__/agent-session-receipts.pg.test.ts \
    __tests__/agent-session-response-message.pg.test.ts \
    __tests__/agent-session-receipts-roles.pg.test.ts

log "真实 PostgreSQL 16 从 0016 升级到 0017 ..."
AGENT_SESSION_RECEIPTS_UPGRADE_PG_TEST=1 \
  pnpm --dir "${ROOT_DIR}/db" exec vitest run __tests__/agent-session-receipts-upgrade.pg.test.ts

log "迁移集成全部通过 ✓"
