import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  resolve(directory, '..', 'v2-migrations', '0014_v2_email_login.sql'),
  'utf8',
);

describe('0014 V2 登录标识切换为邮箱', () => {
  it('extends the identity type constraint to email while keeping existing types legal', () => {
    expect(sql).toContain('ALTER TABLE v2_identities DROP CONSTRAINT ck_v2_identity_type');
    expect(sql).toContain("CHECK (type IN ('phone', 'wechat_openid', 'email'))");
  });

  it('relaxes identifier to a generic non-empty length constraint and drops the phone format rule', () => {
    expect(sql).toContain('ALTER TABLE v2_identities DROP CONSTRAINT ck_v2_identity_identifier');
    expect(sql).toContain('char_length(identifier) BETWEEN 1 AND 254');
    expect(sql).toContain("identifier !~ '[[:cntrl:]]'");
    // 手机号格式假设不再固化在库约束里；也不允许换成新的格式判定。
    expect(sql).toContain('ALTER TABLE v2_identities DROP CONSTRAINT ck_v2_identity_phone');
    expect(sql).not.toMatch(/ADD CONSTRAINT ck_v2_identity_(phone|email)/i);
  });

  it('allows the email channel for challenges and email_otp for sessions', () => {
    expect(sql).toContain('ALTER TABLE v2_auth_challenges DROP CONSTRAINT ck_v2_challenge_channel');
    expect(sql).toContain("CHECK (channel IN ('phone', 'email'))");
    expect(sql).toContain('ALTER TABLE v2_sessions DROP CONSTRAINT ck_v2_session_method');
    expect(sql).toContain("CHECK (auth_method IN ('dev_phone_otp', 'email_otp'))");
  });

  it('only redefines constraints in place and never rewrites or backfills existing rows', () => {
    // 只动 v2_ 终端用户域的三张表，只换约束，不建表、不删表、不改列、不迁移数据。
    expect(sql).not.toMatch(/CREATE\s+TABLE/i);
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
    expect(sql).not.toMatch(/ALTER\s+(?!TABLE\s+v2_(identities|auth_challenges|sessions)\b)/i);
    expect(sql).not.toMatch(/\bUPDATE\s+v2_/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\s+v2_/i);
    expect(sql).not.toMatch(/\bINSERT\s+INTO\s+v2_/i);
    // 不放行新权限：角色授权在 0012 已落定。
    expect(sql).not.toMatch(/\bGRANT\b|\bREVOKE\b/i);
  });
});
