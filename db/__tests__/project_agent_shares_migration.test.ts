import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  resolve(directory, '..', 'migrations', '0015_project_agent_shares.sql'),
  'utf8',
);

describe('0015 Project Agent share migration', () => {
  it('stores only owner, immutable manifest, idempotency and a 256-bit public locator', () => {
    expect(sql).toContain('CREATE TABLE project_agent_shares (');
    expect(sql).toContain('owner_user_id');
    expect(sql).toContain('share_token');
    expect(sql).toContain("CHECK (share_token ~ '^[A-Za-z0-9_-]{43}$')");
    expect(sql).toContain('manifest           jsonb');
    expect(sql).toContain('manifest_sha256');
    expect(sql).toContain('UNIQUE (owner_user_id, idempotency_key)');
    for (const forbidden of [
      'repository_files',
      'session_jsonl',
      'cookie',
      'access_token',
      'environment_values',
    ]) {
      expect(sql.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('makes rows immutable and grants only Authoring SELECT/INSERT', () => {
    expect(sql).toContain('trg_project_agent_shares_immutable');
    expect(sql).toContain('EXECUTE FUNCTION reject_agent_immutable_mutation()');
    expect(sql).toContain('GRANT SELECT, INSERT ON project_agent_shares TO combo_api');
    expect(sql).not.toMatch(/GRANT[^;]*(?:UPDATE|DELETE)[^;]*project_agent_shares/is);
    expect(sql).not.toMatch(/project_agent_shares TO combo_(?:worker|runtime)/);
  });
});
