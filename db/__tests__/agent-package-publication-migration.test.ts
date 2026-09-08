import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'migrations',
    '0021_agent_package_publication.sql',
  ),
  'utf8',
);

describe('0021 exact public Agent Package publication migration', () => {
  it('preserves all historical rows and binds each public publisher to an owned exact Draft', () => {
    expect(sql).toContain(
      'UNIQUE (owner_user_id, draft_id, revision, draft_fingerprint, package_digest)',
    );
    expect(sql).toContain(
      'FOREIGN KEY (owner_user_id, draft_id, draft_revision, draft_fingerprint, package_digest)',
    );
    expect(sql).toContain("release_scope = 'controlled_test' AND publisher_claim_id IS NULL");
    expect(sql).toContain("release_scope = 'public_link' AND publisher_claim_id IS NOT NULL");
    expect(sql).toContain(
      'WHERE package_digest = NEW.package_digest AND owner_user_id = NEW.owner_user_id',
    );
    expect(sql).not.toMatch(
      /(?:UPDATE|DELETE FROM|TRUNCATE|DROP TABLE)\s+agent_(?:packages|package_releases|draft_revisions)/u,
    );
  });
  it('fixes exact transfer identity, server TTL, and public release ancestry', () => {
    expect(sql).toContain('NEW.created_at := clock_timestamp();');
    expect(sql).toContain("NEW.expires_at := NEW.created_at + interval '10 minutes';");
    expect(sql).toContain('clock_timestamp() >= OLD.expires_at');
    expect(sql).toContain("release.release_scope = 'public_link'");
    expect(sql).toContain('claim.owner_user_id, claim.draft_id, claim.draft_revision,');
    expect(sql).toContain('claim.draft_fingerprint, claim.package_digest');
    expect(sql).toContain('NEW.draft_fingerprint, NEW.package_digest');
    expect(sql).toContain("NEW.phase = 'published'");
  });
  it('retains the audit and only grants API state columns, never secret or time updates', () => {
    expect(sql).toContain(
      'GRANT UPDATE (phase, owner_user_id, draft_id, draft_revision, release_id)',
    );
    expect(sql).not.toMatch(/GRANT UPDATE[^;]*(?:secret_sha256|approved_at|expires_at)/u);
    for (const name of ['agent_package_publisher_claims', 'agent_package_release_revocations']) {
      expect(sql).toContain(`BEFORE UPDATE OR DELETE ON ${name}`);
      expect(sql).toContain(`BEFORE TRUNCATE ON ${name}`);
    }
    expect(sql).toContain('BEFORE INSERT OR UPDATE OR DELETE ON agent_package_transfers');
    expect(sql).toContain('BEFORE TRUNCATE ON agent_package_transfers');
    expect(sql).toContain(
      'agent_package_transfers FROM PUBLIC, combo_api, combo_worker, combo_runtime',
    );
  });
});
