import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'migrations',
    '0016_project_history_agent_flow.sql',
  ),
  'utf8',
);

describe('0016 project-history Agent flow', () => {
  it('persists immutable Drafts and shares while storing only confirmation-token digests', () => {
    for (const table of [
      'project_history_agent_drafts',
      'project_history_agent_confirmations',
      'project_history_agent_shares',
    ]) {
      expect(sql).toContain(`CREATE TABLE ${table} (`);
    }
    expect(sql).toContain('confirmation_token_sha256');
    expect(sql).toContain('share_json_sha256');
    expect(sql).toContain('revision             bigint      NOT NULL CHECK (revision = 1)');
    expect(sql).not.toMatch(/confirmation_token\s+text/iu);
    expect(sql).toContain('trg_project_history_agent_drafts_immutable');
    expect(sql).toContain('trg_project_history_agent_shares_immutable');
    expect(sql).toContain('OLD.consumed_at IS NOT NULL OR OLD.expires_at <= clock_timestamp()');
    expect(sql).toMatch(/IF OLD\.expires_at <= clock_timestamp\(\) THEN\s+--[\s\S]*?RETURN NULL;/u);
    expect(sql).toContain("CHECK (expires_at = created_at + interval '5 minutes')");
    expect(sql).toContain('CREATE FUNCTION issue_project_history_agent_confirmation(');
    expect(sql).toContain('CREATE FUNCTION cleanup_retired_project_history_confirmations(');
    expect(sql.match(/SECURITY DEFINER/gu)).toHaveLength(2);
    expect(sql).toContain('SET search_path = pg_catalog, public');
    expect(sql).toContain('FOR UPDATE OF confirmation SKIP LOCKED');
    expect(sql).not.toContain('expired project history confirmations cannot be consumed');
    expect(sql).not.toContain('DELETE ON project_history_agent_confirmations TO combo_api');
    expect(sql).not.toContain('SELECT, INSERT, UPDATE ON project_history_agent_confirmations');
    expect(sql).toContain(
      'GRANT UPDATE (consumed_at, consumed_share_token) ON project_history_agent_confirmations TO combo_api',
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION issue_project_history_agent_confirmation(uuid, text, bigint, text, text) TO combo_api',
    );
    expect(sql).toContain(
      'GRANT EXECUTE ON FUNCTION cleanup_retired_project_history_confirmations(integer) TO combo_api',
    );
    expect(sql).not.toMatch(
      /confirmation_token_sha256[\s\S]{0,160}REFERENCES project_history_agent_confirmations/iu,
    );
  });

  it('enforces owner idempotency, one share per exact Draft, and API-only writes', () => {
    expect(sql).toContain('UNIQUE (owner_user_id, idempotency_key)');
    expect(sql).toContain('UNIQUE (owner_user_id, source_draft_fingerprint)');
    expect(sql).toContain('TO combo_api');
    expect(sql).not.toMatch(/TO combo_worker|TO combo_runtime/u);
  });
});
