import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  resolve(directory, '..', 'migrations', '0008_application_database_roles.sql'),
  'utf8',
);

describe('0008 application database role isolation', () => {
  it('creates three non-privileged roles with login disabled during DDL', () => {
    for (const role of ['combo_api', 'combo_worker', 'combo_runtime']) {
      expect(sql).toContain(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER`);
      expect(sql).toContain(`ALTER ROLE ${role} NOLOGIN NOSUPERUSER`);
    }
    expect(sql).toContain('NOCREATEROLE');
    expect(sql).toContain('NOBYPASSRLS');
  });

  it('grants authentication writes only to authoring API', () => {
    const apiGrant = sql.match(
      /GRANT SELECT, INSERT, UPDATE, DELETE ON([\s\S]*?)TO combo_api;/,
    )?.[1];
    expect(apiGrant).toContain('auth_sessions');
    expect(apiGrant).toContain('auth_otp_challenges');
    expect(apiGrant).toContain('auth_identities');

    const workerGrant = sql.match(
      /-- worker[^\n]*\nGRANT SELECT, INSERT, UPDATE, DELETE ON([\s\S]*?)TO combo_worker;/,
    )?.[1];
    expect(workerGrant).not.toMatch(/auth_/);

    expect(sql).toContain('GRANT SELECT ON users, auth_sessions, capabilities TO combo_runtime;');
    expect(sql).toContain('GRANT UPDATE (ui_artifact_id) ON capabilities TO combo_runtime;');
    expect(sql).not.toMatch(
      /GRANT UPDATE \((?!ui_artifact_id\))[^)]*\) ON capabilities TO combo_runtime;/i,
    );
    expect(sql).not.toMatch(/GRANT[^;]*INSERT[^;]*auth_sessions[^;]*TO combo_runtime/is);
  });

  it('removes public table and function privileges before adding explicit grants', () => {
    expect(sql).toContain('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    expect(sql).toMatch(
      /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public\s+FROM PUBLIC, combo_api, combo_worker, combo_runtime/,
    );
    expect(sql).toContain('REVOKE ALL PRIVILEGES ON FUNCTION gen_uuid_v7()');
  });
});
