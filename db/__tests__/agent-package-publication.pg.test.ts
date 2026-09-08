import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const enabled = process.env.AGENT_PACKAGE_PUBLICATION_PG_TEST === '1';
const pgDescribe = enabled ? describe : describe.skip;
const digest = () => `sha256:${randomUUID().replaceAll('-', '').repeat(2)}`;
const releaseId = () => `release.agent-package.${randomUUID().replaceAll('-', '')}`;
let sequence = 0;

function requireDisposableDatabase(raw: string) {
  const url = new URL(raw);
  const keys = [...url.searchParams.keys()];
  const socket = url.searchParams.get('host');
  const safeSocket =
    socket !== null && /^\/tmp\/combo-(?:publication|draft)-pg\.[A-Za-z0-9]+$/u.test(socket);
  const local = socket === null && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (!safeSocket && !local) ||
    new Set(keys).size !== keys.length ||
    keys.some((key) => !['host', 'port'].includes(key)) ||
    !(
      /^\/combo_(?:publication|draft)_test_[a-z0-9]{6,32}$/u.test(url.pathname) ||
      (safeSocket && ['/combo_publication_test', '/combo_draft_test'].includes(url.pathname)) ||
      (local && process.env.GITHUB_ACTIONS === 'true' && url.pathname === '/agora')
    )
  )
    throw new Error('publication tests require an explicitly named local disposable database');
}

pgDescribe('exact Agent Package publication and browser transfer on PostgreSQL 16', () => {
  let db: Client;
  let ownerA: string;
  let ownerB: string;
  let packageDigest: string;
  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('AGENT_PACKAGE_PUBLICATION_PG_TEST requires DATABASE_URL');
    requireDisposableDatabase(url);
    db = new Client({ connectionString: url });
    await db.connect();
    expect((await db.query('SHOW server_version')).rows[0]?.server_version).toMatch(/^16[.]/u);
    expect(
      (await db.query('SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1'))
        .rows[0]?.filename,
    ).toBe('0021_agent_package_publication.sql');
  });
  beforeEach(async () => {
    await db.query('BEGIN');
    await db.query('SET LOCAL ROLE combo_api');
    const account = () =>
      `creator-${randomUUID()
        .replaceAll('-', '')
        .slice(0, 8)
        .replace(/[0-9]/gu, (value) => String.fromCharCode(97 + Number(value)))}`;
    ownerA = (await db.query('INSERT INTO users(account) VALUES($1) RETURNING id', [account()]))
      .rows[0].id;
    ownerB = (await db.query('INSERT INTO users(account) VALUES($1) RETURNING id', [account()]))
      .rows[0].id;
    packageDigest = digest();
    await db.query(
      "INSERT INTO agent_packages(package_digest,protocol,owner_user_id) VALUES($1,'combo.agent-package/1',$2)",
      [packageDigest, ownerA],
    );
  });
  afterEach(async () => {
    await db?.query('ROLLBACK');
  });
  afterAll(async () => {
    await db?.end();
  });

  async function rejects(sql: string, values: unknown[], code: string) {
    const point = `publication_failure_${++sequence}`;
    await db.query(`SAVEPOINT ${point}`);
    let error: unknown;
    try {
      await db.query(sql, values);
    } catch (caught) {
      error = caught;
    } finally {
      await db.query(`ROLLBACK TO SAVEPOINT ${point}`);
      await db.query(`RELEASE SAVEPOINT ${point}`);
    }
    expect(error).toMatchObject({ code });
  }
  async function draft(owner = ownerA) {
    const id = `draft.agent-package.${randomUUID().replaceAll('-', '')}`;
    const fingerprint = digest();
    await db.query(
      `INSERT INTO agent_draft_revisions(owner_user_id,draft_id,revision,draft_fingerprint,
      package_digest,snapshot_digest,snapshot_bytes,request_id,view_id)
      VALUES($1,$2,1,$3,$4,$5,100,$6,$7)`,
      [owner, id, fingerprint, packageDigest, digest(), randomUUID(), randomUUID()],
    );
    return { owner, id, fingerprint };
  }
  async function claim(value: Awaited<ReturnType<typeof draft>>) {
    const id = randomUUID();
    await db.query(
      `INSERT INTO agent_package_publisher_claims(claim_id,owner_user_id,package_digest,
      draft_id,draft_revision,draft_fingerprint) VALUES($1,$2,$3,$4,1,$5)`,
      [id, value.owner, packageDigest, value.id, value.fingerprint],
    );
    return id;
  }
  const releaseSql = `INSERT INTO agent_package_releases(release_id,package_digest,owner_user_id,
    protocol,release_scope,idempotency_key,request_sha256,publisher_claim_id)
    VALUES($1,$2,$3,'combo.agent-package-release/1',$4,$5,$6,$7)`;
  async function release(owner: string, claimId: string | null, scope = 'public_link') {
    const id = releaseId();
    await db.query(releaseSql, [
      id,
      packageDigest,
      owner,
      scope,
      randomUUID(),
      'a'.repeat(64),
      claimId,
    ]);
    return id;
  }
  async function transfer(value: Awaited<ReturnType<typeof draft>>) {
    const id = randomUUID();
    const row = (
      await db.query(
        `INSERT INTO agent_package_transfers(transfer_id,name,draft_fingerprint,
      package_digest,secret_sha256,verification_code,created_at,expires_at)
      VALUES($1,'测试助手',$2,$3,$4,'ABCD1234','2100-01-01','2200-01-01') RETURNING *`,
        [id, value.fingerprint, packageDigest, 'b'.repeat(64)],
      )
    ).rows[0];
    return { id, row };
  }
  async function upload(id: string, value: Awaited<ReturnType<typeof draft>>) {
    await db.query(
      "UPDATE agent_package_transfers SET phase='approved',owner_user_id=$2 WHERE transfer_id=$1",
      [id, value.owner],
    );
    await db.query(
      "UPDATE agent_package_transfers SET phase='uploaded',draft_id=$2,draft_revision=1 WHERE transfer_id=$1",
      [id, value.id],
    );
  }

  it('permits independent exact publisher claims without rebinding the first Package owner', async () => {
    const first = await draft();
    const second = await draft(ownerB);
    const ids = await Promise.all([claim(first), claim(second)]);
    await release(ownerA, ids[0]!);
    await release(ownerB, ids[1]!);
    expect(
      (
        await db.query('SELECT owner_user_id FROM agent_packages WHERE package_digest=$1', [
          packageDigest,
        ])
      ).rows[0]?.owner_user_id,
    ).toBe(ownerA);
    expect(
      (
        await db.query('SELECT * FROM agent_package_releases WHERE package_digest=$1', [
          packageDigest,
        ])
      ).rowCount,
    ).toBe(2);
    await rejects(
      releaseSql,
      [releaseId(), packageDigest, ownerB, 'controlled_test', randomUUID(), 'a'.repeat(64), null],
      '23503',
    );
    await rejects(
      releaseSql,
      [releaseId(), packageDigest, ownerB, 'public_link', randomUUID(), 'a'.repeat(64), ids[0]],
      '23503',
    );
    await rejects(
      releaseSql,
      [releaseId(), packageDigest, ownerA, 'public_link', randomUUID(), 'a'.repeat(64), null],
      '23514',
    );
    await rejects(
      releaseSql,
      [releaseId(), packageDigest, ownerA, 'controlled_test', randomUUID(), 'a'.repeat(64), ids[0]],
      '23514',
    );
  });

  it('requires an owned exact private Draft before granting a publishing claim', async () => {
    const value = await draft();
    for (const fields of [
      [ownerB, value.id, value.fingerprint],
      [ownerA, value.id, digest()],
      [ownerA, `draft.agent-package.${'0'.repeat(32)}`, value.fingerprint],
    ]) {
      await rejects(
        `INSERT INTO agent_package_publisher_claims(claim_id,owner_user_id,package_digest,
        draft_id,draft_revision,draft_fingerprint) VALUES($1,$2,$3,$4,1,$5)`,
        [randomUUID(), fields[0], packageDigest, fields[1], fields[2]],
        '23503',
      );
    }
  });

  it('fixes server time and TTL, and only accepts monotonic same-owner transitions', async () => {
    const value = await draft();
    const { id, row } = await transfer(value);
    expect(Math.abs(row.created_at.getTime() - Date.now())).toBeLessThan(5000);
    expect(row.expires_at.getTime() - row.created_at.getTime()).toBe(600_000);
    await rejects(
      "UPDATE agent_package_transfers SET phase='uploaded',owner_user_id=$2,draft_id=$3,draft_revision=1 WHERE transfer_id=$1",
      [id, ownerA, value.id],
      '23514',
    );
    await rejects(
      'UPDATE agent_package_transfers SET approved_at=now() WHERE transfer_id=$1',
      [id],
      '42501',
    );
    await rejects(
      'UPDATE agent_package_transfers SET secret_sha256=$2 WHERE transfer_id=$1',
      [id, 'c'.repeat(64)],
      '42501',
    );
    await db.query(
      "UPDATE agent_package_transfers SET phase='approved',owner_user_id=$2 WHERE transfer_id=$1",
      [id, ownerA],
    );
    await rejects(
      "UPDATE agent_package_transfers SET phase='rejected',owner_user_id=$2 WHERE transfer_id=$1",
      [id, ownerB],
      '55000',
    );
    await db.query('RESET ROLE');
    await rejects(
      "UPDATE agent_package_transfers SET expires_at=now()+interval '1 day' WHERE transfer_id=$1",
      [id],
      '55000',
    );
    await rejects(
      "UPDATE agent_package_transfers SET phase='rejected',approved_at=now() WHERE transfer_id=$1",
      [id],
      '55000',
    );
    await db.query('SET LOCAL ROLE combo_api');
    await db.query("UPDATE agent_package_transfers SET phase='rejected' WHERE transfer_id=$1", [
      id,
    ]);
    await rejects(
      "UPDATE agent_package_transfers SET phase='approved' WHERE transfer_id=$1",
      [id],
      '23514',
    );
    const rejected = (
      await db.query('SELECT * FROM agent_package_transfers WHERE transfer_id=$1', [id])
    ).rows[0];
    expect(rejected.approved_at).not.toBeNull();
    expect(rejected.rejected_at).not.toBeNull();
  });

  it('rejects NULL phase/partial uploads and stamps rejected approval correctly', async () => {
    const value = await draft();
    const { id } = await transfer(value);
    await rejects(
      'UPDATE agent_package_transfers SET phase=NULL WHERE transfer_id=$1',
      [id],
      '23502',
    );
    await db.query(
      "UPDATE agent_package_transfers SET phase='rejected',owner_user_id=$2 WHERE transfer_id=$1",
      [id, ownerA],
    );
    const row = (await db.query('SELECT * FROM agent_package_transfers WHERE transfer_id=$1', [id]))
      .rows[0];
    expect(row.approved_at).toBeNull();
    expect(row.rejected_at).not.toBeNull();
    const next = await transfer(value);
    await db.query(
      "UPDATE agent_package_transfers SET phase='approved',owner_user_id=$2 WHERE transfer_id=$1",
      [next.id, ownerA],
    );
    await rejects(
      "UPDATE agent_package_transfers SET phase='uploaded',draft_id=$2 WHERE transfer_id=$1",
      [next.id, value.id],
      '23514',
    );
  });

  it('requires the exact Draft claim and a public Release, not merely a matching digest', async () => {
    const value = await draft();
    const other = await draft();
    const { id } = await transfer(value);
    await upload(id, value);
    const controlled = await release(ownerA, null, 'controlled_test');
    const wrong = await release(ownerA, await claim(other));
    for (const wrongId of [controlled, wrong]) {
      await rejects(
        "UPDATE agent_package_transfers SET phase='published',release_id=$2 WHERE transfer_id=$1",
        [id, wrongId],
        '23514',
      );
    }
    const correct = await release(ownerA, await claim(value));
    await db.query(
      "UPDATE agent_package_transfers SET phase='published',release_id=$2 WHERE transfer_id=$1",
      [id, correct],
    );
    const row = (await db.query('SELECT * FROM agent_package_transfers WHERE transfer_id=$1', [id]))
      .rows[0];
    expect(row.phase).toBe('published');
    expect(row.published_at).not.toBeNull();
    await rejects(
      "UPDATE agent_package_transfers SET phase='uploaded',release_id=NULL WHERE transfer_id=$1",
      [id],
      '23514',
    );
  });

  it('enforces expiry at the database transition, without waiting or exposing a time override to API', async () => {
    const value = await draft();
    const { id } = await transfer(value);
    await db.query('RESET ROLE');
    // This fixture-only DDL is transactional and only allowed against the guarded disposable DB.
    await db.query(
      'ALTER TABLE agent_package_transfers DISABLE TRIGGER agent_package_transfer_guard',
    );
    await db.query(
      "UPDATE agent_package_transfers SET created_at=now()-interval '11 minutes',expires_at=now()-interval '1 minute' WHERE transfer_id=$1",
      [id],
    );
    await db.query(
      'ALTER TABLE agent_package_transfers ENABLE TRIGGER agent_package_transfer_guard',
    );
    await db.query('SET LOCAL ROLE combo_api');
    await rejects(
      "UPDATE agent_package_transfers SET phase='approved',owner_user_id=$2 WHERE transfer_id=$1",
      [id, ownerA],
      '23514',
    );
  });

  it('retains immutable claims, releases and revocations with minimal application grants', async () => {
    const value = await draft();
    const { id } = await transfer(value);
    const claimId = await claim(value);
    const released = await release(ownerA, claimId);
    await rejects(
      "INSERT INTO agent_package_release_revocations(release_id,owner_user_id,package_digest,reason) VALUES($1,$2,$3,'publisher_request')",
      [released, ownerB, packageDigest],
      '23503',
    );
    await db.query(
      "INSERT INTO agent_package_release_revocations(release_id,owner_user_id,package_digest,reason) VALUES($1,$2,$3,'publisher_request')",
      [released, ownerA, packageDigest],
    );
    for (const table of [
      'agent_package_publisher_claims',
      'agent_package_release_revocations',
      'agent_package_transfers',
    ]) {
      await rejects(`DELETE FROM ${table}`, [], '42501');
      await rejects(`TRUNCATE ${table} CASCADE`, [], '42501');
    }
    await db.query('RESET ROLE');
    for (const table of [
      'agent_package_publisher_claims',
      'agent_package_release_revocations',
      'agent_package_transfers',
    ]) {
      await rejects(`DELETE FROM ${table}`, [], '55000');
      await rejects(`TRUNCATE ${table} CASCADE`, [], '55000');
    }
    await rejects(
      'UPDATE agent_package_publisher_claims SET created_at=now() WHERE claim_id=$1',
      [claimId],
      '55000',
    );
    for (const role of ['combo_worker', 'combo_runtime']) {
      await db.query(`SET LOCAL ROLE ${role}`);
      for (const table of [
        'agent_package_publisher_claims',
        'agent_package_release_revocations',
        'agent_package_transfers',
      ]) {
        await rejects(`SELECT * FROM ${table}`, [], '42501');
      }
      await db.query('RESET ROLE');
    }
    expect(
      (await db.query('SELECT transfer_id FROM agent_package_transfers WHERE transfer_id=$1', [id]))
        .rowCount,
    ).toBe(1);
  });
});
