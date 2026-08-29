import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(
  resolve(directory, '..', 'migrations', '0017_agent_package_registry.sql'),
  'utf8',
);

function tableDefinition(table: 'agent_packages' | 'agent_package_releases'): string {
  const definition = sql.match(new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`))?.[1];
  expect(definition, `missing ${table} definition`).toBeDefined();
  return definition!;
}

describe('0017 canonical Agent Package Registry migration', () => {
  it('uses the Package digest as the only Package identity and keeps its marker minimal', () => {
    const packages = tableDefinition('agent_packages');

    expect(packages).toMatch(/package_digest\s+text\s+PRIMARY KEY/);
    expect(packages).toContain("CHECK (package_digest ~ '^sha256:[a-f0-9]{64}$')");
    expect(packages).toContain("CHECK (protocol = 'combo.agent-package/1')");
    expect(packages).toMatch(/owner_user_id\s+uuid\s+NOT NULL REFERENCES users\(id\)/);
    expect(packages).toContain('UNIQUE (package_digest, owner_user_id)');

    for (const forbidden of [
      'package_id',
      'storage_key',
      'manifest',
      'knowledge_bundle',
      'latest',
      'idempotency_key',
      'request_sha256',
    ]) {
      expect(packages, `agent_packages must not store ${forbidden}`).not.toContain(forbidden);
    }
    expect(packages).not.toMatch(/\nid\s+uuid/);
  });

  it('binds one strict controlled Test Release to the exact Package and owner', () => {
    const releases = tableDefinition('agent_package_releases');

    expect(releases).toContain("CHECK (release_id ~ '^release[.]agent-package[.][0-9a-f]{32}$')");
    expect(releases).toContain("CHECK (package_digest ~ '^sha256:[a-f0-9]{64}$')");
    expect(releases).toContain("CHECK (protocol = 'combo.agent-package-release/1')");
    expect(releases).toContain("CHECK (release_scope = 'controlled_test')");
    expect(releases).toMatch(/idempotency_key\s+uuid\s+NOT NULL/);
    expect(releases).toContain("CHECK (request_sha256 ~ '^[a-f0-9]{64}$')");
    expect(releases).toContain('UNIQUE (release_id, package_digest)');
    expect(releases).toContain('UNIQUE (owner_user_id, idempotency_key)');
    expect(releases).toContain(
      'FOREIGN KEY (package_digest, owner_user_id)\n    REFERENCES agent_packages (package_digest, owner_user_id)',
    );
    expect(releases).not.toContain('package_id');

    for (const legacy of [
      'REFERENCES agent_releases',
      'agent_revision_id',
      'runtime_bundle_sha256',
    ]) {
      expect(sql, `0017 must not depend on ${legacy}`).not.toContain(legacy);
    }
  });

  it('rejects owner UPDATE, DELETE, and TRUNCATE on both immutable tables', () => {
    expect(sql).toContain(
      'CREATE FUNCTION reject_agent_package_registry_mutation() RETURNS trigger',
    );
    expect(sql).toContain("USING ERRCODE = '55000'");
    for (const table of ['agent_packages', 'agent_package_releases']) {
      expect(sql).toContain(
        `CREATE TRIGGER trg_${table}_immutable\n  BEFORE UPDATE OR DELETE ON ${table}`,
      );
      expect(sql).toContain(
        `CREATE TRIGGER trg_${table}_no_truncate\n  BEFORE TRUNCATE ON ${table}`,
      );
    }
  });

  it('gives API append access, Runtime only product columns, and worker or PUBLIC nothing', () => {
    expect(sql).toMatch(
      /REVOKE ALL PRIVILEGES ON agent_packages, agent_package_releases\s+FROM PUBLIC, combo_api, combo_worker, combo_runtime/,
    );
    expect(sql).toContain(
      'GRANT SELECT, INSERT ON agent_packages, agent_package_releases TO combo_api;',
    );
    expect(sql).toContain(
      'GRANT SELECT (package_digest, protocol)\n  ON agent_packages TO combo_runtime;',
    );
    expect(sql).toContain(
      'GRANT SELECT (release_id, owner_user_id, package_digest, protocol, release_scope)\n  ON agent_package_releases TO combo_runtime;',
    );
    expect(sql).not.toMatch(/GRANT[^;]+ON agent_packages[^;]+TO combo_worker/is);
    expect(sql).not.toMatch(/GRANT[^;]+ON agent_package_releases[^;]+TO combo_worker/is);
    expect(sql).not.toMatch(
      /GRANT SELECT ON agent_(?:packages|package_releases) TO combo_runtime/i,
    );
  });
});
