import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(__dirname, '..', 'migrations', '0007_first_party_email_auth.sql');
const sql = readFileSync(migrationPath, 'utf8');

function tableDefinition(table: string): string {
  const match = sql.match(new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`));
  expect(match, `missing table ${table}`).not.toBeNull();
  return match?.[1] ?? '';
}

describe('0007_first_party_email_auth', () => {
  it('在改 users 结构前锁表并拒绝迁移任何已有用户', () => {
    const lockAt = sql.indexOf('LOCK TABLE users IN ACCESS EXCLUSIVE MODE');
    const gateAt = sql.indexOf('IF EXISTS (SELECT 1 FROM users)');
    const alterAt = sql.indexOf('ALTER TABLE users');

    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(gateAt).toBeGreaterThan(lockAt);
    expect(alterAt).toBeGreaterThan(gateAt);
    expect(sql).toContain("USING ERRCODE = '55000'");
  });

  it('把 users 切到本地业务主体并限制 MVP 账号与角色', () => {
    expect(sql).toMatch(/DROP COLUMN logto_user_id/);
    expect(sql).toMatch(/DROP COLUMN email/);
    expect(sql).toMatch(/ADD COLUMN disabled_at timestamptz/);
    expect(sql).toContain('ck_users_account_mvp');
    expect(sql).toContain("account ~ '^creator-[a-z2-7]{8}$'");
    expect(sql).toContain("roles = ARRAY['creator']::text[]");
  });

  it('只创建四张邮箱 MVP 认证表，且每张表默认生成 UUID v7', () => {
    const authTables = [...sql.matchAll(/CREATE TABLE (auth_[a-z_]+) \(/g)].map(
      (match) => match[1],
    );
    expect(authTables).toEqual([
      'auth_identities',
      'auth_otp_challenges',
      'auth_sessions',
      'auth_audit_events',
    ]);
    expect(sql.match(/PRIMARY KEY DEFAULT gen_uuid_v7\(\)/g)).toHaveLength(4);
    expect(sql).not.toMatch(/'phone'|'google'/);
  });

  it('身份只接受 local 邮箱，并同时保证主体唯一和用户单邮箱', () => {
    const identity = tableDefinition('auth_identities');
    expect(identity).toContain("CHECK (provider = 'email')");
    expect(identity).toContain("CHECK (issuer = 'local')");
    expect(identity).toContain('UNIQUE (provider, issuer, subject)');
    expect(identity).toContain('UNIQUE (user_id, provider)');
    expect(identity).toContain("split_part(subject, '@', 2) = lower(split_part(subject, '@', 2))");
    expect(identity).toContain('REFERENCES users(id) ON DELETE CASCADE');
  });

  it('challenge 只允许邮箱登录、32 字节摘要、五次尝试与五分钟期限', () => {
    const challenge = tableDefinition('auth_otp_challenges');
    expect(challenge).toContain("CHECK (channel = 'email')");
    expect(challenge).toContain("CHECK (purpose = 'login')");
    expect(challenge).toContain('CHECK (initiated_by_user_id IS NULL)');
    expect(challenge).toContain('octet_length(target_digest) = 32');
    expect(challenge).toContain('octet_length(code_digest) = 32');
    expect(challenge).toContain('max_attempts = 5');
    expect(challenge).toContain("expires_at <= created_at + interval '5 minutes'");
    expect(challenge).toContain('NOT (consumed_at IS NOT NULL AND invalidated_at IS NOT NULL)');

    expect(sql).toMatch(
      /CREATE UNIQUE INDEX uq_auth_otp_unfinished_target[\s\S]*activated_at IS NOT NULL[\s\S]*consumed_at IS NULL[\s\S]*invalidated_at IS NULL/,
    );
    for (const index of [
      'idx_auth_otp_target_recent',
      'idx_auth_otp_global_recent',
      'idx_auth_otp_gc',
    ]) {
      expect(sql).toContain(`CREATE INDEX ${index}`);
    }
  });

  it('会话只保存 32 字节唯一摘要，固定七天并可撤销', () => {
    const session = tableDefinition('auth_sessions');
    expect(session).toContain('token_digest     bytea       NOT NULL UNIQUE');
    expect(session).toContain("CHECK (auth_method = 'email_otp')");
    expect(session).toContain('octet_length(token_digest) = 32');
    expect(session).toContain("expires_at = created_at + interval '7 days'");
    expect(session).toContain('revoked_at IS NULL OR revoked_at >= created_at');
    expect(session).not.toMatch(/cookie\s+text|token\s+text/i);
    expect(sql).toContain('CREATE INDEX idx_auth_sessions_user_live');
    expect(sql).toContain('CREATE INDEX idx_auth_sessions_gc');
  });

  it('审计事件和值域收敛，details 只能保存一个低敏 result 枚举', () => {
    const audit = tableDefinition('auth_audit_events');
    expect(audit).toMatch(
      /event_type IN \(\s*'otp_requested', 'login_succeeded', 'login_failed', 'logout'\s*\)/,
    );
    expect(audit).toContain("outcome IN ('success', 'failure', 'blocked')");
    expect(audit).toContain("auth_method IS NULL OR auth_method = 'email_otp'");
    expect(audit).toContain("(details - 'result') = '{}'::jsonb");
    expect(audit).toContain("details ->> 'result' IN (");
    expect(audit).not.toMatch(/email\s+text|code\s+text|cookie\s+text|authorization\s+text/i);

    for (const index of [
      'idx_auth_audit_user_recent',
      'idx_auth_audit_type_recent',
      'idx_auth_audit_target_recent',
    ]) {
      expect(sql).toContain(`CREATE INDEX ${index}`);
    }
  });
});
