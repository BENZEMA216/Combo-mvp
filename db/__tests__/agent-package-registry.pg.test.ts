import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL;
const enabled = process.env.AGENT_PACKAGE_REGISTRY_PG_TEST === '1' && Boolean(databaseUrl);
const pgDescribe = enabled ? describe : describe.skip;

const PACKAGE_PROTOCOL = 'combo.agent-package/1';
const RELEASE_PROTOCOL = 'combo.agent-package-release/1';
const CONTROLLED_TEST_SCOPE = 'controlled_test';
const PACKAGE_DIGEST_A = `sha256:${'a'.repeat(64)}`;
const PACKAGE_DIGEST_B = `sha256:${'b'.repeat(64)}`;

interface RegistryFixture {
  ownerA: string;
  ownerB: string;
  releaseId: string;
  releaseIdempotencyKey: string;
}

interface DatabaseError {
  code?: string;
  constraint?: string;
}

let savepointSequence = 0;

function creatorAccount(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  return `creator-${randomUUID()
    .replaceAll('-', '')
    .slice(0, 8)
    .split('')
    .map((character) => alphabet[Number.parseInt(character, 16)]!)
    .join('')}`;
}

function releaseId(): string {
  return `release.agent-package.${randomUUID().replaceAll('-', '')}`;
}

async function expectDatabaseError(
  client: Client,
  operation: () => Promise<unknown>,
  code: string,
  constraint?: string,
): Promise<void> {
  const savepoint = `registry_expect_${(savepointSequence += 1)}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  let caught: DatabaseError | undefined;
  try {
    await operation();
  } catch (error) {
    caught = error as DatabaseError;
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  }
  expect(caught).toMatchObject({ code });
  if (constraint) expect(caught?.constraint).toBe(constraint);
}

async function insertFixture(client: Client): Promise<RegistryFixture> {
  const ownerA = (
    await client.query<{ id: string }>('INSERT INTO users (account) VALUES ($1) RETURNING id', [
      creatorAccount(),
    ])
  ).rows[0]!.id;
  const ownerB = (
    await client.query<{ id: string }>('INSERT INTO users (account) VALUES ($1) RETURNING id', [
      creatorAccount(),
    ])
  ).rows[0]!.id;

  await client.query(
    `INSERT INTO agent_packages (package_digest, protocol, owner_user_id)
     VALUES ($1, $2, $3), ($4, $2, $5)`,
    [PACKAGE_DIGEST_A, PACKAGE_PROTOCOL, ownerA, PACKAGE_DIGEST_B, ownerB],
  );

  const exactReleaseId = releaseId();
  const releaseIdempotencyKey = randomUUID();
  await client.query(
    `INSERT INTO agent_package_releases (
       release_id, package_digest, owner_user_id, protocol, release_scope,
       idempotency_key, request_sha256
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      exactReleaseId,
      PACKAGE_DIGEST_A,
      ownerA,
      RELEASE_PROTOCOL,
      CONTROLLED_TEST_SCOPE,
      releaseIdempotencyKey,
      'c'.repeat(64),
    ],
  );

  return { ownerA, ownerB, releaseId: exactReleaseId, releaseIdempotencyKey };
}

pgDescribe('canonical Agent Package Registry on PostgreSQL 16', () => {
  const owner = new Client({ connectionString: databaseUrl });

  beforeAll(async () => {
    await owner.connect();
    const version = await owner.query<{ version: string }>(
      "SELECT current_setting('server_version') AS version",
    );
    expect(version.rows[0]?.version).toMatch(/^16[.]/);
  });

  afterAll(async () => {
    await owner.end();
  });

  it('accepts one canonical marker and Release while rejecting drift and rebinding', async () => {
    await owner.query('BEGIN');
    try {
      const releaseDigestCheck = await owner.query<{
        definition: string;
        validated: boolean;
      }>(
        `SELECT pg_get_constraintdef(oid) AS definition, convalidated AS validated
           FROM pg_constraint
          WHERE conrelid = 'agent_package_releases'::regclass
            AND conname = 'ck_agent_package_release_digest'`,
      );
      expect(releaseDigestCheck.rows).toEqual([
        {
          definition: "CHECK ((package_digest ~ '^sha256:[a-f0-9]{64}$'::text))",
          validated: true,
        },
      ]);
      expect(
        (
          await owner.query<{ matches: boolean }>(
            "SELECT $1::text ~ '^sha256:[a-f0-9]{64}$' AS matches",
            [`sha256:${'E'.repeat(64)}`],
          )
        ).rows[0]?.matches,
      ).toBe(false);

      await owner.query('SET LOCAL ROLE combo_api');
      const fixture = await insertFixture(owner);

      await expectDatabaseError(
        owner,
        () =>
          owner.query(
            `INSERT INTO agent_packages (package_digest, protocol, owner_user_id)
             VALUES ($1, $2, $3)`,
            [`sha256:${'A'.repeat(64)}`, PACKAGE_PROTOCOL, fixture.ownerA],
          ),
        '23514',
        'ck_agent_package_digest',
      );
      await expectDatabaseError(
        owner,
        () =>
          owner.query(
            `INSERT INTO agent_packages (package_digest, protocol, owner_user_id)
             VALUES ($1, $2, $3)`,
            [`sha256:${'d'.repeat(64)}`, 'combo.creator-agent-version/3', fixture.ownerA],
          ),
        '23514',
        'ck_agent_package_protocol',
      );
      await expectDatabaseError(
        owner,
        () =>
          owner.query(
            `INSERT INTO agent_packages (package_digest, protocol, owner_user_id)
             VALUES ($1, $2, $3)`,
            [PACKAGE_DIGEST_A, PACKAGE_PROTOCOL, fixture.ownerB],
          ),
        '23505',
        'agent_packages_pkey',
      );

      const releaseValues = [
        releaseId(),
        PACKAGE_DIGEST_A,
        fixture.ownerA,
        RELEASE_PROTOCOL,
        CONTROLLED_TEST_SCOPE,
        randomUUID(),
        'd'.repeat(64),
      ];
      const releaseInsert = `INSERT INTO agent_package_releases (
        release_id, package_digest, owner_user_id, protocol, release_scope,
        idempotency_key, request_sha256
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`;

      await expectDatabaseError(
        owner,
        () =>
          owner.query(releaseInsert, [
            `release.agent-package.${'A'.repeat(32)}`,
            ...releaseValues.slice(1),
          ]),
        '23514',
        'ck_agent_package_release_id',
      );
      await expectDatabaseError(
        owner,
        () =>
          owner.query(releaseInsert, [
            releaseId(),
            `sha256:${'e'.repeat(64)}`,
            ...releaseValues.slice(2),
          ]),
        '23503',
        'fk_agent_package_release_package_owner',
      );
      await expectDatabaseError(
        owner,
        () =>
          owner.query(releaseInsert, [
            releaseId(),
            PACKAGE_DIGEST_A,
            fixture.ownerB,
            ...releaseValues.slice(3),
          ]),
        '23503',
        'fk_agent_package_release_package_owner',
      );
      await expectDatabaseError(
        owner,
        () =>
          owner.query(releaseInsert, [
            releaseId(),
            PACKAGE_DIGEST_A,
            fixture.ownerA,
            'combo.creator-agent-version/3',
            ...releaseValues.slice(4),
          ]),
        '23514',
        'ck_agent_package_release_protocol',
      );
      await expectDatabaseError(
        owner,
        () =>
          owner.query(releaseInsert, [
            releaseId(),
            PACKAGE_DIGEST_A,
            fixture.ownerA,
            RELEASE_PROTOCOL,
            'production',
            ...releaseValues.slice(5),
          ]),
        '23514',
        'ck_agent_package_release_scope',
      );
      await expectDatabaseError(
        owner,
        () =>
          owner.query(releaseInsert, [
            releaseId(),
            PACKAGE_DIGEST_A,
            fixture.ownerA,
            RELEASE_PROTOCOL,
            CONTROLLED_TEST_SCOPE,
            randomUUID(),
            'Z'.repeat(64),
          ]),
        '23514',
        'ck_agent_package_release_request_sha',
      );
      await expectDatabaseError(
        owner,
        () =>
          owner.query(releaseInsert, [
            releaseId(),
            PACKAGE_DIGEST_A,
            fixture.ownerA,
            RELEASE_PROTOCOL,
            CONTROLLED_TEST_SCOPE,
            fixture.releaseIdempotencyKey,
            'e'.repeat(64),
          ]),
        '23505',
        'uq_agent_package_releases_owner_idempotency',
      );
      await expectDatabaseError(
        owner,
        () =>
          owner.query(releaseInsert, [
            fixture.releaseId,
            PACKAGE_DIGEST_B,
            fixture.ownerB,
            RELEASE_PROTOCOL,
            CONTROLLED_TEST_SCOPE,
            randomUUID(),
            'f'.repeat(64),
          ]),
        '23505',
        'agent_package_releases_pkey',
      );
    } finally {
      await owner.query('ROLLBACK');
    }
  });

  it('blocks UPDATE, DELETE, and TRUNCATE even for the migration owner', async () => {
    await owner.query('BEGIN');
    try {
      await owner.query('SET LOCAL ROLE combo_api');
      const fixture = await insertFixture(owner);
      await owner.query('RESET ROLE');

      for (const operation of [
        () =>
          owner.query('UPDATE agent_packages SET committed_at = now() WHERE package_digest = $1', [
            PACKAGE_DIGEST_A,
          ]),
        () =>
          owner.query('DELETE FROM agent_packages WHERE package_digest = $1', [PACKAGE_DIGEST_A]),
        () =>
          owner.query(
            'UPDATE agent_package_releases SET created_at = now() WHERE release_id = $1',
            [fixture.releaseId],
          ),
        () =>
          owner.query('DELETE FROM agent_package_releases WHERE release_id = $1', [
            fixture.releaseId,
          ]),
        // 0018 adds Session/charge/receipt FKs to exact Releases. CASCADE reaches the registry
        // trigger instead of stopping first at PostgreSQL's schema-level TRUNCATE FK guard.
        () => owner.query('TRUNCATE agent_package_releases CASCADE'),
        () => owner.query('TRUNCATE agent_packages, agent_package_releases CASCADE'),
      ]) {
        await expectDatabaseError(owner, operation, '55000');
      }
    } finally {
      await owner.query('ROLLBACK');
    }
  });

  it('keeps Runtime on product columns and leaves worker and PUBLIC at zero', async () => {
    await owner.query('BEGIN');
    try {
      await owner.query('SET LOCAL ROLE combo_api');
      const fixture = await insertFixture(owner);

      for (const operation of [
        () =>
          owner.query('UPDATE agent_packages SET committed_at = now() WHERE package_digest = $1', [
            PACKAGE_DIGEST_A,
          ]),
        () =>
          owner.query('DELETE FROM agent_package_releases WHERE release_id = $1', [
            fixture.releaseId,
          ]),
        () => owner.query('TRUNCATE agent_package_releases'),
      ]) {
        await expectDatabaseError(owner, operation, '42501');
      }

      await owner.query('RESET ROLE');
      for (const table of ['agent_packages', 'agent_package_releases']) {
        for (const privilegeName of ['UPDATE', 'DELETE', 'TRUNCATE']) {
          const privilege = await owner.query<{ allowed: boolean }>(
            'SELECT has_table_privilege($1, $2, $3) AS allowed',
            ['combo_api', `public.${table}`, privilegeName],
          );
          expect(privilege.rows[0]?.allowed, `${table} ${privilegeName}`).toBe(false);
        }
      }
      await owner.query('SET LOCAL ROLE combo_runtime');
      expect(
        (
          await owner.query(
            `SELECT package_digest, protocol
               FROM agent_packages WHERE package_digest = $1`,
            [PACKAGE_DIGEST_A],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await owner.query(
            `SELECT release_id, owner_user_id, package_digest, protocol, release_scope
               FROM agent_package_releases WHERE release_id = $1`,
            [fixture.releaseId],
          )
        ).rowCount,
      ).toBe(1);
      await expectDatabaseError(
        owner,
        () => owner.query('SELECT owner_user_id FROM agent_packages LIMIT 1'),
        '42501',
      );
      await expectDatabaseError(
        owner,
        () => owner.query('SELECT committed_at FROM agent_packages LIMIT 1'),
        '42501',
      );
      await expectDatabaseError(
        owner,
        () => owner.query('SELECT request_sha256 FROM agent_package_releases LIMIT 1'),
        '42501',
      );
      await expectDatabaseError(
        owner,
        () => owner.query('SELECT * FROM agent_package_releases LIMIT 1'),
        '42501',
      );
      await expectDatabaseError(
        owner,
        () =>
          owner.query(
            `INSERT INTO agent_packages (package_digest, protocol, owner_user_id)
             VALUES ($1, $2, $3)`,
            [`sha256:${'f'.repeat(64)}`, PACKAGE_PROTOCOL, fixture.ownerA],
          ),
        '42501',
      );

      await owner.query('RESET ROLE');
      await owner.query('SET LOCAL ROLE combo_worker');
      await expectDatabaseError(
        owner,
        () => owner.query('SELECT package_digest FROM agent_packages LIMIT 1'),
        '42501',
      );
      await expectDatabaseError(
        owner,
        () => owner.query('SELECT release_id FROM agent_package_releases LIMIT 1'),
        '42501',
      );

      await owner.query('RESET ROLE');
      for (const role of ['combo_api', 'combo_worker', 'combo_runtime']) {
        const functionPrivilege = await owner.query<{ allowed: boolean }>(
          `SELECT has_function_privilege(
             $1, 'public.reject_agent_package_registry_mutation()', 'EXECUTE'
           ) AS allowed`,
          [role],
        );
        expect(functionPrivilege.rows[0]?.allowed, `${role} trigger function`).toBe(false);
      }
      const publicGrants = await owner.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM (
             SELECT table_name, privilege_type
               FROM information_schema.table_privileges
              WHERE table_schema = 'public' AND grantee = 'PUBLIC'
             UNION ALL
             SELECT table_name, privilege_type
               FROM information_schema.column_privileges
              WHERE table_schema = 'public' AND grantee = 'PUBLIC'
           ) AS grants
          WHERE table_name IN ('agent_packages', 'agent_package_releases')`,
      );
      expect(publicGrants.rows[0]?.count).toBe(0);
    } finally {
      await owner.query('ROLLBACK');
    }
  });
});
