import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { applyMigrationFile, listMigrations, planMigrations } from '../scripts/migrate.ts';
import { provisionApplicationRoleLogins } from '../scripts/provision-app-roles.ts';

const enabled = process.env.AGENT_PACKAGE_PUBLICATION_UPGRADE_PG_TEST === '1';
const pgDescribe = enabled ? describe : describe.skip;
const migration = '0021_agent_package_publication.sql';
const directory = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

pgDescribe('private Draft 0020 to exact publication 0021 upgrade on PostgreSQL 16', () => {
  it('preserves historical rows and controlled writer semantics with a validated additive suffix', async () => {
    const raw = process.env.DATABASE_URL;
    if (!raw) throw new Error('publication upgrade requires a disposable DATABASE_URL');
    const url = new URL(raw);
    const socket = url.searchParams.get('host');
    const local = socket === null && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const safeSocket =
      socket !== null && /^\/tmp\/combo-(?:publication|draft)-pg\.[A-Za-z0-9]+$/u.test(socket);
    const keys = [...url.searchParams.keys()];
    if (
      (!local && !safeSocket) ||
      new Set(keys).size !== keys.length ||
      keys.some((key) => !['host', 'port'].includes(key))
    ) {
      throw new Error('publication upgrade only accepts a local disposable PostgreSQL instance');
    }
    if (
      !['POSTGRES_API_PASSWORD', 'POSTGRES_WORKER_PASSWORD', 'POSTGRES_RUNTIME_PASSWORD'].every(
        (key) => Boolean(process.env[key]),
      )
    )
      throw new Error('test role passwords must be supplied');
    const name = `combo_publication_test_${randomUUID().replaceAll('-', '')}`;
    if (!/^combo_publication_test_[0-9a-f]{32}$/u.test(name))
      throw new Error('unsafe temporary database');
    url.pathname = '/postgres';
    const admin = new Client({ connectionString: url.toString() });
    let upgrade: Client | undefined;
    let created = false;
    await admin.connect();
    try {
      expect((await admin.query('SHOW server_version')).rows[0]?.server_version).toMatch(/^16[.]/u);
      await admin.query(`CREATE DATABASE "${name}"`);
      created = true;
      url.pathname = `/${name}`;
      upgrade = new Client({ connectionString: url.toString() });
      await upgrade.connect();
      await upgrade.query(
        'CREATE TABLE schema_migrations(filename text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())',
      );
      const all = listMigrations();
      const prefix = all.slice(0, all.indexOf(migration));
      expect(prefix.at(-1)).toBe('0020_private_agent_drafts.sql');
      for (const file of prefix)
        await applyMigrationFile(upgrade, file, readFileSync(join(directory, file), 'utf8'));
      await provisionApplicationRoleLogins(upgrade);
      const owner = (
        await upgrade.query("INSERT INTO users(account) VALUES('creator-abcdefgh') RETURNING id")
      ).rows[0].id;
      const packageDigest = `sha256:${'a'.repeat(64)}`;
      const releaseId = `release.agent-package.${randomUUID().replaceAll('-', '')}`;
      const draftId = `draft.agent-package.${randomUUID().replaceAll('-', '')}`;
      const fingerprint = `sha256:${'b'.repeat(64)}`;
      await upgrade.query(
        "INSERT INTO agent_packages(package_digest,protocol,owner_user_id) VALUES($1,'combo.agent-package/1',$2)",
        [packageDigest, owner],
      );
      const releaseSql = `INSERT INTO agent_package_releases(release_id,package_digest,owner_user_id,
        protocol,release_scope,idempotency_key,request_sha256)
        VALUES($1,$2,$3,'combo.agent-package-release/1','controlled_test',$4,$5)`;
      await upgrade.query(releaseSql, [
        releaseId,
        packageDigest,
        owner,
        randomUUID(),
        'c'.repeat(64),
      ]);
      await upgrade.query(
        `INSERT INTO agent_draft_revisions(owner_user_id,draft_id,revision,draft_fingerprint,
        package_digest,snapshot_digest,snapshot_bytes,request_id,view_id)
        VALUES($1,$2,1,$3,$4,$5,100,$6,$7)`,
        [
          owner,
          draftId,
          fingerprint,
          packageDigest,
          `sha256:${'d'.repeat(64)}`,
          randomUUID(),
          randomUUID(),
        ],
      );
      const before = {
        package: (await upgrade.query('SELECT * FROM agent_packages')).rows,
        release: (await upgrade.query('SELECT * FROM agent_package_releases')).rows,
        draft: (await upgrade.query('SELECT * FROM agent_draft_revisions')).rows,
      };
      expect(planMigrations(all, prefix, migration).pending).toEqual([migration]);
      await applyMigrationFile(
        upgrade,
        migration,
        readFileSync(join(directory, migration), 'utf8'),
      );
      const afterReleases = (await upgrade.query('SELECT * FROM agent_package_releases')).rows;
      expect(afterReleases[0]?.publisher_claim_id).toBeNull();
      for (const row of afterReleases) delete row.publisher_claim_id;
      expect(afterReleases).toEqual(before.release);
      expect((await upgrade.query('SELECT * FROM agent_packages')).rows).toEqual(before.package);
      expect((await upgrade.query('SELECT * FROM agent_draft_revisions')).rows).toEqual(
        before.draft,
      );
      expect(
        (
          await upgrade.query(`SELECT conname FROM pg_constraint WHERE NOT convalidated
        AND conrelid IN ('agent_package_releases'::regclass,'agent_package_publisher_claims'::regclass,
          'agent_package_transfers'::regclass,'agent_draft_revisions'::regclass)`)
        ).rows,
      ).toEqual([]);
      for (const table of [
        'agent_package_publisher_claims',
        'agent_package_release_revocations',
        'agent_package_transfers',
      ]) {
        expect((await upgrade.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
      }
      await upgrade.query('SET ROLE combo_api');
      await upgrade.query(releaseSql, [
        `release.agent-package.${randomUUID().replaceAll('-', '')}`,
        packageDigest,
        owner,
        randomUUID(),
        'e'.repeat(64),
      ]);
      await upgrade.query('RESET ROLE');
      const applied = (
        await upgrade.query<{ filename: string }>(
          'SELECT filename FROM schema_migrations ORDER BY filename',
        )
      ).rows.map((row) => row.filename);
      expect(planMigrations(all, applied, migration).pending).toEqual([]);
    } finally {
      if (upgrade) await upgrade.end();
      if (created) await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
    }
  });
});
