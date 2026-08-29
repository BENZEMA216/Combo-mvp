import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '..', 'migrations');

function files(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}
function allSql(): string {
  return files()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'))
    .join('\n');
}

// 2026-07-04 重设计基线：三层八表（设计真源见飞书文档「Combo 数据库表设计」）。
// 本套测试守护基线完整性；此后新增迁移按编号追加，本文件按需补断言。

const TABLES = [
  // 身份层
  'users',
  // 流水线层
  'tasks',
  'uploads',
  // 能力层
  'capabilities',
  // 试用层
  'sessions',
  'messages',
  'artifacts',
  // 保留的审计表
  'audit_llm_calls',
];

// 旧结构的表绝不允许回潮（完整清单见 git 历史；抽代表性的几张守门）。
const LEGACY_TABLES = [
  'jobs',
  'idempotency_keys',
  'drafts',
  'raw_snapshots',
  'session_segments',
  'import_uploads',
  'import_pairings',
  'capability_candidates',
  'capability_versions',
  'publications',
  'marketplace_listings',
  'outbox_events',
  'notifications',
  'stream_events',
  'rt_chat_sessions',
];

describe('migrations', () => {
  it('are ordered by numeric prefix, baseline first', () => {
    const list = files();
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0]).toBe('0000_baseline_schema.sql');
    const prefixes = list.map((f) => f.slice(0, 4));
    expect(prefixes).toEqual([...prefixes].sort());
  });

  it(`baseline defines all ${TABLES.length} tables of the redesign`, () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0000_baseline_schema.sql'), 'utf-8');
    for (const t of TABLES) {
      expect(sql, `missing table ${t}`).toContain(`CREATE TABLE ${t} (`);
    }
    // 全量对齐：CREATE TABLE 数量与清单一致（多一张都算漂移）。
    expect(sql.match(/CREATE TABLE /g)?.length).toBe(TABLES.length);
  });

  it('legacy tables never come back', () => {
    const sql = allSql();
    for (const t of LEGACY_TABLES) {
      expect(sql, `legacy table ${t} reappeared`).not.toContain(`CREATE TABLE ${t} (`);
    }
  });

  it('the full chain creates only the current data model', () => {
    const created = [...allSql().matchAll(/CREATE TABLE\s+([a-z][a-z0-9_]*)\s*\(/gi)]
      .map((match) => match[1]!.toLowerCase())
      .sort();
    expect(created).toEqual(
      [
        ...TABLES,
        'turns',
        'auth_identities',
        'auth_otp_challenges',
        'auth_sessions',
        'auth_audit_events',
        'billing_accounts',
        'billing_free_allowances',
        'usage_charges',
        'recharge_orders',
        'payment_attempts',
        'payment_callback_events',
        'wallet_ledger',
        'agent_projects',
        'agent_revisions',
        'agent_tests',
        'agent_test_reviews',
        'agent_releases',
        'oauth_clients',
        'oauth_authorization_requests',
        'oauth_authorization_codes',
        'oauth_access_tokens',
        'oauth_refresh_tokens',
        'project_agent_shares',
        'project_history_agent_drafts',
        'project_history_agent_confirmations',
        'project_history_agent_shares',
      ].sort(),
    );
    expect(created.some((table) => /^rt_(?:chat|studio)_/.test(table))).toBe(false);
    expect(created.some((table) => /(?:^|_)run_events$/.test(table))).toBe(false);
  });

  it('tasks carries the two orthogonal state axes plus lease and idempotency', () => {
    const sql = allSql();
    // 双轴状态：step 只有 upload/extract（发布不在这个轴上）；status 三态。
    expect(sql).toMatch(/current_step IN \('upload', 'extract'\)/);
    expect(sql).toMatch(/status IN \('running', 'succeeded', 'failed'\)/);
    for (const col of ['lease_owner', 'lease_expires_at', 'retry_count', 'last_error']) {
      expect(sql).toContain(col);
    }
    // 建任务幂等：唯一约束在表内。
    expect(sql).toMatch(/idempotency_key\s+text\s+NOT NULL UNIQUE/);
  });

  it('big content stays in object storage: storage_key columns exist, no content columns', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0000_baseline_schema.sql'), 'utf-8');
    // uploads/capabilities/artifacts 均以 storage_key 指向 MinIO。
    expect(sql.match(/storage_key/g)!.length).toBeGreaterThanOrEqual(3);
    // 产物不再把正文存库（旧 rt_chat_artifact_versions.content 的教训）。
    expect(sql).not.toMatch(/content\s+text/);
  });

  it('messages keep session-scoped ordering and native agent format', () => {
    const sql = allSql();
    expect(sql).toContain('uq_messages_session_seq UNIQUE (session_id, seq)');
    expect(sql).toMatch(/role IN \('user', 'assistant', 'tool'\)/);
  });

  it('0003 adds autonomous turns and per-turn message ordering', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0003_turns.sql'), 'utf-8');
    expect(sql).toContain('CREATE TABLE turns (');
    expect(sql).toMatch(/status IN \('running', 'completed', 'failed', 'interrupted'\)/);
    expect(sql).toContain("WHERE status = 'running'");
    expect(sql).toContain(
      'uq_messages_turn_idx ON messages (turn_id, idx) WHERE turn_id IS NOT NULL',
    );
    expect(sql).toContain('idx_messages_turn ON messages (turn_id) WHERE turn_id IS NOT NULL');
    expect(sql).toContain('CONSTRAINT uq_turns_id_session UNIQUE (id, session_id)');
    expect(sql).toContain(
      'CONSTRAINT fk_artifacts_turn_session\n  FOREIGN KEY (turn_id, session_id)\n  REFERENCES turns (id, session_id)\n  ON DELETE CASCADE',
    );
    expect(sql).toContain(
      'CONSTRAINT fk_messages_turn_session\n  FOREIGN KEY (turn_id, session_id)\n  REFERENCES turns (id, session_id)',
    );
    expect(sql).toContain('idx_artifacts_turn ON artifacts (turn_id) WHERE turn_id IS NOT NULL');
    expect(sql).toContain('ADD COLUMN idx int');
    expect(sql).toContain('ALTER COLUMN seq DROP NOT NULL');
  });

  it('0004 separates Studio sessions and atomically reuses one active design session', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0004_studio_sessions.sql'), 'utf-8');
    expect(sql).toMatch(/ADD COLUMN mode text NOT NULL DEFAULT 'consume'/);
    expect(sql).toMatch(/mode IN \('consume', 'studio'\)/);
    expect(sql).toContain('uq_sessions_active_studio_owner_capability');
    expect(sql).toContain('ON sessions (owner_user_id, capability_id)');
    expect(sql).toContain("WHERE status = 'active' AND mode = 'studio'");
  });

  it('0005 lets each capability point at one current Studio UI artifact', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0005_capability_current_ui.sql'), 'utf-8');
    expect(sql).toMatch(/ADD COLUMN ui_artifact_id uuid REFERENCES artifacts\(id\)/);
    expect(sql).toContain('ON DELETE SET NULL');
    expect(sql).toContain('uq_capabilities_ui_artifact');
    expect(sql).toContain('WHERE ui_artifact_id IS NOT NULL');
  });

  it('0006 rejects historical duplicates before enforcing one running turn per session', () => {
    const sql = readFileSync(
      join(MIGRATIONS_DIR, '0006_one_running_turn_per_session.sql'),
      'utf-8',
    );
    expect(sql).toMatch(
      /status = 'running'[\s\S]+GROUP BY session_id[\s\S]+HAVING count\(\*\) > 1/,
    );
    expect(sql).toContain('RAISE EXCEPTION');
    expect(sql).toContain(
      "CREATE UNIQUE INDEX uq_turns_session_running\n  ON turns (session_id)\n  WHERE status = 'running'",
    );
    expect(sql).not.toMatch(/UPDATE\s+turns/i);
  });

  it('keeps authentication, roles, billing, and Agent Builder after Goal B schema migrations', () => {
    const list = files();
    expect(list.slice(-10)).toEqual([
      '0007_first_party_email_auth.sql',
      '0008_application_database_roles.sql',
      '0009_billing.sql',
      '0010_recharge_qr_channel.sql',
      '0011_recharge_qr_only.sql',
      '0012_agent_builder_v1.sql',
      '0013_external_mcp_oauth.sql',
      '0014_agent_test_reviews.sql',
      '0015_project_agent_shares.sql',
      '0016_project_history_agent_flow.sql',
    ]);
  });

  it('0014 freezes a two-axis three-case quality review into every new Release', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0014_agent_test_reviews.sql'), 'utf-8');
    expect(sql).toContain('CREATE TABLE agent_test_reviews (');
    expect(sql).toContain('uq_agent_test_reviews_project_test');
    expect(sql).toContain('uq_agent_test_reviews_project_idempotency');
    expect(sql).toContain('trg_agent_test_reviews_validate');
    expect(sql).toContain('trg_agent_test_reviews_immutable');
    expect(sql).toContain("value ->> 'executionStatus' NOT IN ('completed', 'failed')");
    expect(sql).toContain(
      "value ->> 'qualityVerdict' NOT IN ('passed', 'failed', 'accepted_exception')",
    );
    expect(sql).toContain('accepted exception requires reason and impact');
    expect(sql).toContain('ADD COLUMN qualifying_review_id uuid');
    expect(sql).toContain('ADD COLUMN review_sha256 char(64)');
    expect(sql).toContain('LEFT JOIN agent_test_reviews r');
    expect(sql).toContain(
      "review_status IS NULL OR review_status NOT IN ('passed', 'accepted_exception')",
    );
    expect(sql).toContain('GRANT SELECT, INSERT ON agent_test_reviews TO combo_api');
    expect(sql).toContain('GRANT SELECT ON agent_test_reviews TO combo_runtime');
    expect(sql).not.toMatch(/GRANT[^;]*(?:UPDATE|DELETE)[^;]*agent_test_reviews[^;]*TO combo_/is);
  });

  it('0013 stores only OAuth secret digests, bounds cleanup and minimizes app grants', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0013_external_mcp_oauth.sql'), 'utf-8');
    for (const table of [
      'oauth_clients',
      'oauth_authorization_requests',
      'oauth_authorization_codes',
      'oauth_access_tokens',
      'oauth_refresh_tokens',
    ]) {
      expect(sql).toContain(`CREATE TABLE ${table} (`);
    }
    expect(sql).not.toMatch(/access_token\s+text|refresh_token\s+text|authorization_code\s+text/i);
    expect(sql).toContain("grant_types = ARRAY['authorization_code', 'refresh_token']::text[]");
    expect(sql).toContain('CREATE FUNCTION cleanup_expired_oauth_artifacts(batch_size integer)');
    expect(sql).toContain('CREATE FUNCTION register_oauth_client(');
    expect(sql).toContain('registration_digest        bytea       NOT NULL UNIQUE');
    expect(sql).toContain(
      "pg_advisory_xact_lock(hashtextextended('combo.oauth.dcr.capacity.v1', 0))",
    );
    expect(sql).toContain('IF client_count >= 4096 THEN');
    expect(sql).toContain("candidate.last_used_at <= now() - interval '10 minutes'");
    expect(sql).toContain('FOR UPDATE OF candidate SKIP LOCKED');
    expect(sql).toContain("target.last_used_at <= now() - interval '10 minutes'");
    expect(sql).toContain("client.last_used_at <= now() - interval '30 days'");
    for (const index of [
      'idx_oauth_authorization_requests_client',
      'idx_oauth_authorization_codes_client',
      'idx_oauth_access_tokens_client',
      'idx_oauth_refresh_tokens_client',
    ]) {
      expect(sql).toContain(`CREATE INDEX ${index}`);
    }
    expect(sql).toMatch(/LEAST\(GREATEST\(COALESCE\(batch_size, 1\), 1\), 100\)/);
    expect(sql.match(/LIMIT bounded_limit/g)).toHaveLength(5);
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION cleanup_expired_oauth_artifacts(integer) TO combo_api',
    );
    expect(sql).toContain('GRANT SELECT ON oauth_clients TO combo_api');
    expect(sql).toContain('GRANT UPDATE (last_used_at) ON oauth_clients TO combo_api');
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION register_oauth_client(text, bytea, text, text[], text[], text[], text)',
    );
    expect(sql).not.toContain('GRANT SELECT, INSERT ON oauth_clients TO combo_api');
    expect(sql).not.toMatch(/GRANT[^;]*DELETE[^;]*oauth_[^;]*TO combo_api/is);
    expect(sql).toContain(
      'GRANT UPDATE (used_at, revoked_at) ON oauth_refresh_tokens TO combo_api',
    );
    expect(sql).toContain('GRANT SELECT ON oauth_access_tokens TO combo_runtime');
    expect(sql).not.toMatch(
      /GRANT (?:INSERT|UPDATE|DELETE)[^;]*oauth_access_tokens TO combo_runtime/i,
    );
  });

  it('0012 freezes Revision and Release while pinning Test and Session to exact hashes', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0012_agent_builder_v1.sql'), 'utf-8');
    for (const table of ['agent_projects', 'agent_revisions', 'agent_tests', 'agent_releases']) {
      expect(sql).toContain(`CREATE TABLE ${table} (`);
    }
    expect(sql).toContain('trg_agent_revisions_immutable');
    expect(sql).toContain('trg_agent_releases_immutable');
    expect(sql).toContain('trg_agent_tests_transition');
    expect(sql).toContain('trg_agent_release_requires_passed_test');
    expect(sql).toContain('ADD COLUMN agent_project_id uuid');
    expect(sql).toContain('ADD COLUMN agent_revision_id uuid');
    expect(sql).toContain('ADD COLUMN agent_release_id uuid');
    expect(sql).toContain('REFERENCES agent_revisions (id, entry_capability_id)');
    expect(sql).toContain('trg_sessions_agent_pins_immutable');
    expect(sql).toContain('ck_sessions_agent_project_revision_pair');
    expect(sql).toContain('uq_artifacts_direct_agent_ui_request');
    expect(sql).toContain('output_contract       jsonb');
    expect(sql).toContain('request_key           text');
    expect(sql).toContain('lease_token           uuid');
    expect(sql).toContain('lease_expires_at      timestamptz');
    expect(sql).toContain("status = 'starting' AND session_id IS NULL AND turn_id IS NULL");
    expect(sql).toContain('lease_token IS NOT NULL AND lease_expires_at IS NOT NULL');
    expect(sql).toContain('uq_agent_tests_project_request');
    expect(sql).toContain('idx_agent_tests_project_created');
    expect(sql).toContain('ON agent_tests (project_id, created_at DESC, id DESC)');
    expect(sql).toContain('FOREIGN KEY (session_id, agent_revision_id)');
    expect(sql).toContain(
      'FOREIGN KEY (project_id, agent_revision_id, runtime_bundle_sha256, ui_sha256)',
    );
    expect(sql).toContain(
      'FOREIGN KEY (qualifying_test_id, project_id, agent_revision_id, runtime_bundle_sha256, ui_sha256)',
    );
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON agent_tests TO combo_runtime');
  });

  it('0002 rejects a PostgreSQL event ledger instead of bridging or deleting it', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0002_drop_stream_events.sql'), 'utf-8');
    expect(sql).toContain("to_regclass('public.stream_events')");
    expect(sql).toContain('RAISE EXCEPTION');
    expect(sql).not.toMatch(/\b(?:CREATE|DROP|ALTER)\s+TABLE\s+stream_events\b/i);
  });

  it('provides gen_uuid_v7 helper in the baseline', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0000_baseline_schema.sql'), 'utf-8');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION gen_uuid_v7()');
  });
});
