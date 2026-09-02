import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  resolve(directory, '..', 'v2-migrations', '0012_v2_end_user_identity.sql'),
  'utf8',
);

describe('0012 V2 终端用户身份体系', () => {
  it('creates the four v2 tables distinct from the V1 creator auth tables', () => {
    for (const table of ['v2_users', 'v2_identities', 'v2_auth_challenges', 'v2_sessions']) {
      expect(sql).toContain(`CREATE TABLE ${table} (`);
    }
    // 终端用户身份域不得复用或改写创作者域的 auth_* 表。
    expect(sql).not.toMatch(/ALTER TABLE\s+auth_/i);
    expect(sql).not.toMatch(/REFERENCES\s+users\s*\(/i);
    expect(sql).not.toMatch(/REFERENCES\s+auth_/i);
  });

  it('keeps the spec identity shape with union_id from day one', () => {
    const identities = sql.match(/CREATE TABLE v2_identities \(([\s\S]*?)\n\);/)?.[1];
    expect(identities).toBeDefined();
    for (const column of ['user_id', 'type', 'identifier', 'union_id', 'created_at']) {
      expect(identities).toContain(column);
    }
    expect(identities).toContain("CHECK (type IN ('phone', 'wechat_openid'))");
    expect(identities).toContain('UNIQUE (type, identifier)');
    // union_id 第一天可空，不允许写成 NOT NULL。
    expect(identities).toMatch(/union_id\s+text\s*,/);
  });

  it('stores only digests for challenges and sessions', () => {
    expect(sql).toMatch(/target_digest\s+bytea\s+NOT NULL/);
    expect(sql).toMatch(/code_digest\s+bytea\s+NOT NULL/);
    expect(sql).toMatch(/token_digest\s+bytea\s+NOT NULL UNIQUE/);
    expect(sql).toContain('octet_length(target_digest) = 32');
    expect(sql).toContain('octet_length(code_digest) = 32');
    expect(sql).toContain('octet_length(token_digest) = 32');
    // 挑战和会话表都没有验证码、Cookie 或令牌原文字段。
    const challenges = sql.match(/CREATE TABLE v2_auth_challenges \(([\s\S]*?)\n\);/)?.[1] ?? '';
    const sessions = sql.match(/CREATE TABLE v2_sessions \(([\s\S]*?)\n\);/)?.[1] ?? '';
    expect(challenges).not.toMatch(/^\s*(code|target)\s+text/m);
    expect(sessions).not.toMatch(/^\s*token\s+text/m);
  });

  it('fixes the seven-day session TTL and allows explicit revocation', () => {
    expect(sql).toContain("expires_at = created_at + interval '7 days'");
    expect(sql).toContain('revoked_at   timestamptz');
    expect(sql).toContain("interval '5 minutes'");
    expect(sql).toContain('max_attempts = 5');
  });

  it('creates a hardened authz role with least-privilege grants only on v2 tables', () => {
    expect(sql).toContain('CREATE ROLE combo_authz NOLOGIN NOSUPERUSER');
    expect(sql).toContain('ALTER ROLE combo_authz NOLOGIN NOSUPERUSER');
    expect(sql).toContain('NOBYPASSRLS');
    // 创作者域角色与 PUBLIC 对终端用户表零权限。
    expect(sql).toContain(
      'REVOKE ALL PRIVILEGES ON v2_users, v2_identities, v2_auth_challenges, v2_sessions\n' +
        '  FROM PUBLIC, combo_api, combo_worker, combo_runtime, combo_authz;',
    );
    expect(sql).toContain('GRANT SELECT, INSERT ON v2_users TO combo_authz;');
    expect(sql).toContain('GRANT SELECT, INSERT ON v2_identities TO combo_authz;');
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON v2_auth_challenges TO combo_authz;');
    expect(sql).toContain('GRANT SELECT, INSERT, UPDATE ON v2_sessions TO combo_authz;');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION gen_uuid_v7() TO combo_authz;');
    // authz 不能删除任何行，也不能修改用户与身份既有行。
    expect(sql).not.toMatch(/GRANT[^;]*DELETE[^;]*TO combo_authz/i);
    expect(sql).not.toMatch(/GRANT[^;]*UPDATE[^;]*v2_(users|identities)[^;]*TO combo_authz/i);
    // 创作者域角色不得获得 v2_* 表权限。
    expect(sql).not.toMatch(/GRANT[^;]*v2_[a-z_]+[^;]*TO combo_(api|worker|runtime)/i);
  });
});
