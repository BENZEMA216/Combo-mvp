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

  it('keeps authentication, roles, and billing after Goal B schema migrations', () => {
    const list = files();
    expect(list.slice(-5)).toEqual([
      '0007_first_party_email_auth.sql',
      '0008_application_database_roles.sql',
      '0009_billing.sql',
      '0010_recharge_qr_channel.sql',
      '0011_recharge_qr_only.sql',
    ]);
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
