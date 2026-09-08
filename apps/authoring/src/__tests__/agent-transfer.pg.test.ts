import { createHash, randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { Pool } from 'pg';
import { authSessionCookieName } from '@cb/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../platform/config/env.js';
import { asTxPool, withTransaction, type TxPool } from '../platform/infra/db-tx.js';
import type { InfraContext } from '../platform/infra/index.js';
import * as objectStore from '../platform/infra/object-store.js';
import { registerAgentTransferRoutes } from '../modules/agent-package-release/transfer-routes.js';
import { AgentTransferService } from '../modules/agent-package-release/transfer-service.js';
import { AgentPublicationService } from '../modules/agent-package-release/publication-service.js';
import {
  transferFixture,
  transferPgTarget,
  assertTransferPgInstance,
} from './agent-transfer-fixture.js';
import { contextUploadFixture, TestObjects } from './agent-draft-fixture.js';
import '../platform/http/fastify.js';

const pgDescribe = process.env.AGENT_TRANSFER_PG_TEST === '1' ? describe : describe.skip;
pgDescribe('browser-approved Agent transfer (real PostgreSQL16, synthetic objects)', () => {
  let admin: Pool;
  let api: Pool;
  let app: FastifyInstance;
  let objects: TestObjects;
  let transfer: AgentTransferService;
  let publication: AgentPublicationService;
  const owners = [randomUUID(), randomUUID()];
  const tokens = owners.map(() => `s1.${randomBytes(32).toString('base64url')}`);
  const headers = (n = 0) => ({
    origin: 'http://localhost',
    'content-type': 'application/json',
    'sec-fetch-site': 'same-origin',
    cookie: `${authSessionCookieName(false)}=${tokens[n]}`,
  });
  beforeAll(async () => {
    const target = transferPgTarget(process.env.DATABASE_URL);
    admin = new Pool({ connectionString: target.connectionString, max: 2 });
    // Nothing writable may precede this real instance check.
    await assertTransferPgInstance(admin, target);
    expect(
      (await admin.query('SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1'))
        .rows[0]?.filename,
    ).toBe('0021_agent_package_publication.sql');
    api = new Pool({
      connectionString: target.connectionString,
      options: '-c role=combo_api',
      max: 1,
    });
    for (const [n, owner] of owners.entries()) {
      const account = `creator-${randomBytes(8)
        .toString('hex')
        .slice(0, 8)
        .replace(/[0-9]/gu, (value) => String.fromCharCode(97 + Number(value)))}`;
      await admin.query('INSERT INTO users(id,account) VALUES($1,$2)', [owner, account]);
      await admin.query(
        "INSERT INTO auth_sessions(user_id,token_digest,auth_method) VALUES($1,$2,'email_otp')",
        [owner, createHash('sha256').update(tokens[n]!).digest()],
      );
    }
  });
  beforeEach(async () => {
    objects = new TestObjects();
    vi.spyOn(objectStore, 'createS3ImmutableObjectStore').mockReturnValue(objects);
    transfer = new AgentTransferService(asTxPool(api), api, objects, 'http://localhost');
    publication = new AgentPublicationService(asTxPool(api), api, objects, 'http://localhost');
    app = Fastify({ logger: false });
    app.decorate('infra', {
      db: api,
      env: {
        ...loadEnv(),
        COMBO_ENVIRONMENT: 'test',
        SESSION_COOKIE_SECURE: false,
        PUBLIC_APP_ORIGINS: 'http://localhost',
      },
    } as InfraContext);
    await app.register(cookie);
    await app.register(rateLimit, { global: false });
    await app.register(registerAgentTransferRoutes, { prefix: '/api/v1' });
    await app.ready();
  });
  afterEach(async () => {
    await app?.close();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await api?.end();
    await admin?.end();
  });
  async function created(f = transferFixture(), owner = owners[0]!) {
    const pending = await transfer.create(f.request);
    const approval = { ...f.approval, verificationCode: pending.verificationCode };
    await transfer.approve(f.request.requestId, owner, approval);
    return { ...f, approval };
  }
  async function uploaded(f = transferFixture(), owner = owners[0]!) {
    const value = await created(f, owner);
    const saved = await transfer.upload(value.request.requestId, value.secret, value.upload);
    return { ...value, saved };
  }
  const publishBody = (f: ReturnType<typeof transferFixture>, requestId = randomUUID()) => ({
    requestId,
    draftFingerprint: f.request.draftFingerprint,
    packageDigest: f.request.packageDigest,
    confirmPublic: true,
  });
  async function expire(id: string) {
    // Test-only transactional fixture mutation, scoped to one row in the already verified instance.
    await withTransaction(asTxPool(admin), async (tx) => {
      await tx.query(
        'ALTER TABLE agent_package_transfers DISABLE TRIGGER agent_package_transfer_guard',
      );
      await tx.query(
        "UPDATE agent_package_transfers SET created_at=statement_timestamp()-interval '11 minutes',expires_at=statement_timestamp()-interval '1 minute' WHERE transfer_id=$1::uuid",
        [id],
      );
      await tx.query(
        'ALTER TABLE agent_package_transfers ENABLE TRIGGER agent_package_transfer_guard',
      );
    });
  }
  it('runs the actual HTTP create-review-approve-upload-publish-read flow with exact bytes and Cookie boundaries', async () => {
    const f = transferFixture();
    const base = `/api/v1/agent-package-transfers/${f.request.requestId}`;
    const createdResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-package-transfers',
      payload: f.request,
    });
    expect(createdResponse.statusCode).toBe(200);
    const pending = createdResponse.json().data;
    expect(pending.phase).toBe('pending_approval');
    expect((await app.inject({ url: base, headers: headers() })).statusCode).toBe(200);
    expect(
      (
        await admin.query('SELECT phase FROM agent_package_transfers WHERE transfer_id=$1', [
          f.request.requestId,
        ])
      ).rows[0].phase,
    ).toBe('pending_approval');
    const uploadHeaders = {
      'content-type': 'application/json',
      authorization: `Bearer ${f.secret}`,
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${base}/upload`,
          headers: uploadHeaders,
          payload: f.upload,
        })
      ).statusCode,
    ).toBe(409);
    expect(objects.writes).toBe(0);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${base}/approval`,
          headers: headers(),
          payload: { ...f.approval, verificationCode: pending.verificationCode },
        })
      ).statusCode,
    ).toBe(200);
    const saved = await app.inject({
      method: 'POST',
      url: `${base}/upload`,
      headers: uploadHeaders,
      payload: f.upload,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data.phase).toBe('uploaded');
    const review = await app.inject({ url: base, headers: headers() });
    expect(review.json().data.review).toEqual(f.upload.candidate);
    expect((await app.inject({ url: base, headers: headers(1) })).statusCode).toBe(404);
    const body = publishBody(f);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `${base}/publication`,
          headers: headers(),
          payload: { ...body, confirmPublic: false },
        })
      ).statusCode,
    ).toBe(400);
    const published = await app.inject({
      method: 'POST',
      url: `${base}/publication`,
      headers: headers(),
      payload: body,
    });
    expect(published.statusCode, published.body).toBe(200);
    const receipt = published.json().data;
    const publicPath = `/api/v1/agent-package-publications/${receipt.release.releaseId}`;
    const publicRead = await app.inject({ url: publicPath });
    expect(publicRead.statusCode).toBe(200);
    expect(publicRead.json().data.package).toEqual(f.upload.candidate);
    expect(publicRead.json().data.sourceVerification).toBe('not_verified');
    expect(publicRead.body).not.toContain(f.upload.draftText);
    expect(publicRead.body).not.toContain(f.secret);
    const download = await app.inject({ url: `${publicPath}/package` });
    expect(download.json()).toEqual(f.upload.candidate);
    expect(download.headers['content-disposition']).toContain('attachment;');
    const restarted = new AgentPublicationService(asTxPool(api), api, objects, 'http://localhost');
    expect((await restarted.read(receipt.release.releaseId)).package).toEqual(f.upload.candidate);
  });
  it('binds the first approving account atomically and rejects swapped fingerprints and ids', async () => {
    const f = transferFixture();
    const pending = await transfer.create(f.request);
    expect(await transfer.create(f.request)).toEqual(pending);
    await expect(transfer.create({ ...f.request, name: '另一个名字' })).rejects.toMatchObject({
      kind: 'conflict',
    });
    await expect(
      transfer.approve(f.request.requestId, owners[0]!, {
        ...f.approval,
        verificationCode: pending.verificationCode,
        packageDigest: `sha256:${'a'.repeat(64)}`,
      }),
    ).rejects.toMatchObject({ kind: 'conflict' });
    const results = await Promise.allSettled(
      owners.map((owner) =>
        transfer.approve(f.request.requestId, owner, {
          ...f.approval,
          verificationCode: pending.verificationCode,
        }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(
      transfer.upload(f.request.requestId, f.secret, { ...f.upload, requestId: randomUUID() }),
    ).rejects.toMatchObject({ kind: 'conflict' });
    expect(objects.writes).toBe(0);
    await expect(
      transfer.status(
        f.request.requestId,
        `combo_transfer_${randomBytes(32).toString('base64url')}`,
      ),
    ).rejects.toMatchObject({ kind: 'not_found' });
  });
  it('serializes uploads and publication retries with a one-connection pool and preserves separate owner claims', async () => {
    const f = await created();
    const saved = await Promise.all(
      Array.from({ length: 5 }, () => transfer.upload(f.request.requestId, f.secret, f.upload)),
    );
    expect(new Set(saved.map((value) => value.saved?.draftId)).size).toBe(1);
    expect(
      (
        await admin.query(
          'SELECT count(*)::int AS n FROM agent_draft_revisions WHERE owner_user_id=$1 AND request_id=$2',
          [owners[0], f.request.requestId],
        )
      ).rows[0].n,
    ).toBe(1);
    const request = publishBody(f);
    const releases = await Promise.all(
      Array.from({ length: 4 }, () =>
        publication.publish(f.request.requestId, owners[0]!, request),
      ),
    );
    expect(new Set(releases.map((value) => value.release?.releaseId)).size).toBe(1);
    await expect(
      publication.publish(f.request.requestId, owners[0]!, publishBody(f)),
    ).rejects.toMatchObject({ kind: 'conflict' });
    const second = await uploaded(transferFixture(), owners[1]!);
    expect(second.request.packageDigest).toBe(f.request.packageDigest);
    const other = await publication.publish(
      second.request.requestId,
      owners[1]!,
      publishBody(second),
    );
    expect(other.release?.releaseId).not.toBe(releases[0]!.release?.releaseId);
    const claims = await admin.query(
      'SELECT DISTINCT owner_user_id FROM agent_package_publisher_claims WHERE package_digest=$1 AND owner_user_id=ANY($2::uuid[])',
      [f.request.packageDigest, owners],
    );
    expect(claims.rows).toHaveLength(2);
  });
  it('resolves real multi-connection row-lock races for approval, upload and publication', async () => {
    const applicationName = `transfer-race-${randomUUID()}`;
    const concurrent = new Pool({
      connectionString: transferPgTarget(process.env.DATABASE_URL).connectionString,
      options: '-c role=combo_api',
      application_name: applicationName,
      max: 4,
    });
    const racingTransfer = new AgentTransferService(
      asTxPool(concurrent),
      concurrent,
      objects,
      'http://localhost',
    );
    const racingPublication = new AgentPublicationService(
      asTxPool(concurrent),
      concurrent,
      objects,
      'http://localhost',
    );
    // Hold the actual row until PostgreSQL confirms that two distinct backends wait for locks.
    // This distinguishes database contention from Promise.all queued behind a max:1 pool.
    async function race<T>(id: string, actions: (() => Promise<T>)[]) {
      const blocker = await admin.connect();
      let pending: Promise<PromiseSettledResult<T>[]> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'SELECT transfer_id FROM agent_package_transfers WHERE transfer_id=$1 FOR UPDATE',
          [id],
        );
        pending = Promise.allSettled(actions.map((action) => action()));
        let waiting = 0;
        const deadline = Date.now() + 3000;
        while (waiting < actions.length && Date.now() < deadline) {
          waiting = (
            await admin.query(
              "SELECT count(DISTINCT pid)::int AS n FROM pg_stat_activity WHERE application_name=$1 AND state='active' AND wait_event_type='Lock'",
              [applicationName],
            )
          ).rows[0].n;
          if (waiting < actions.length) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(actions.length);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        // Always settle in-flight writes before the caller closes the connection pool.
        if (pending) await pending;
      }
      return pending!;
    }
    try {
      const f = transferFixture();
      const receipt = await racingTransfer.create(f.request);
      const approval = { ...f.approval, verificationCode: receipt.verificationCode };
      const approvals = await race(
        f.request.requestId,
        owners.map((owner) => () => racingTransfer.approve(f.request.requestId, owner, approval)),
      );
      expect(approvals.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
      expect(approvals.filter((value) => value.status === 'rejected')).toMatchObject([
        { reason: { kind: 'not_found' } },
      ]);
      const owner = owners[approvals.findIndex((value) => value.status === 'fulfilled')]!;
      const uploads = await race(
        f.request.requestId,
        Array.from(
          { length: 2 },
          () => () => racingTransfer.upload(f.request.requestId, f.secret, f.upload),
        ),
      );
      expect(uploads.every((value) => value.status === 'fulfilled')).toBe(true);
      const uploadedReceipt = await racingTransfer.status(f.request.requestId, f.secret);
      const body = publishBody(f);
      const published = await race(
        f.request.requestId,
        Array.from(
          { length: 2 },
          () => () => racingPublication.publish(f.request.requestId, owner, body),
        ),
      );
      expect(published.every((value) => value.status === 'fulfilled')).toBe(true);
      const ids = published.map(
        (value) => value.status === 'fulfilled' && value.value.release!.releaseId,
      );
      expect(new Set(ids).size).toBe(1);
      expect(
        (
          await admin.query(
            'SELECT count(*)::int AS n FROM agent_draft_revisions WHERE owner_user_id=$1 AND request_id=$2',
            [owner, f.request.requestId],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await admin.query(
            'SELECT count(*)::int AS n FROM agent_package_publisher_claims WHERE owner_user_id=$1 AND draft_id=$2',
            [owner, uploadedReceipt.saved!.draftId],
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await admin.query(
            'SELECT count(*)::int AS n FROM agent_package_releases WHERE owner_user_id=$1 AND idempotency_key=$2',
            [owner, body.requestId],
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      await concurrent.end();
    }
  });
  it('rolls back private indexing and phase together after a post-object failure, then retries the same intent', async () => {
    const f = await created();
    const wrapped: TxPool = {
      connect: async () => {
        const client = await asTxPool(api).connect();
        return {
          release: () => client.release(),
          query: async (sql, params) => {
            if (sql.includes("SET phase='uploaded'")) throw new Error('PRIVATE_FAILURE_CANARY');
            return client.query(sql, params);
          },
        };
      },
    };
    await expect(
      new AgentTransferService(wrapped, api, objects, 'http://localhost').upload(
        f.request.requestId,
        f.secret,
        f.upload,
      ),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    expect(
      (
        await admin.query(
          'SELECT count(*)::int AS n FROM agent_draft_revisions WHERE request_id=$1',
          [f.request.requestId],
        )
      ).rows[0].n,
    ).toBe(0);
    expect((await transfer.status(f.request.requestId, f.secret)).phase).toBe('approved');
    expect((await transfer.upload(f.request.requestId, f.secret, f.upload)).phase).toBe('uploaded');
  });
  it('rejects expired approval/upload while a Cookie owner can recover and publish an already saved upload', async () => {
    const pending = transferFixture();
    const receipt = await transfer.create(pending.request);
    await expire(pending.request.requestId);
    await expect(
      transfer.approve(pending.request.requestId, owners[0]!, {
        ...pending.approval,
        verificationCode: receipt.verificationCode,
      }),
    ).rejects.toMatchObject({ kind: 'expired' });
    const approved = await created();
    await expire(approved.request.requestId);
    await expect(
      transfer.upload(approved.request.requestId, approved.secret, approved.upload),
    ).rejects.toMatchObject({ kind: 'expired' });
    const saved = await uploaded();
    await expire(saved.request.requestId);
    await expect(transfer.status(saved.request.requestId, saved.secret)).rejects.toMatchObject({
      kind: 'expired',
    });
    expect((await transfer.review(saved.request.requestId, owners[0]!)).review).toEqual(
      saved.upload.candidate,
    );
    expect(
      (await publication.publish(saved.request.requestId, owners[0]!, publishBody(saved))).phase,
    ).toBe('published');
  });
  it('does not create a release after failed object writes or silently cross an old controlled-publication key', async () => {
    const f = await uploaded(
      transferFixture(
        contextUploadFixture(randomUUID(), `独立测试${randomBytes(4).toString('hex')}`),
      ),
    );
    const body = publishBody(f);
    objects.fail = true;
    await expect(publication.publish(f.request.requestId, owners[0]!, body)).rejects.toMatchObject({
      kind: 'unavailable',
    });
    expect((await transfer.status(f.request.requestId, f.secret)).phase).toBe('uploaded');
    expect(
      (
        await admin.query(
          'SELECT count(*)::int AS n FROM agent_package_releases WHERE owner_user_id=$1 AND idempotency_key=$2',
          [owners[0], body.requestId],
        )
      ).rows[0].n,
    ).toBe(0);
    objects.fail = false;
    await api.query(
      "INSERT INTO agent_packages(package_digest,protocol,owner_user_id) VALUES($1,'combo.agent-package/1',$2)",
      [f.request.packageDigest, owners[0]],
    );
    await api.query(
      "INSERT INTO agent_package_releases(release_id,package_digest,owner_user_id,protocol,release_scope,idempotency_key,request_sha256) VALUES($1,$2,$3,'combo.agent-package-release/1','controlled_test',$4,$5)",
      [
        `release.agent-package.${randomBytes(16).toString('hex')}`,
        f.request.packageDigest,
        owners[0],
        body.requestId,
        'a'.repeat(64),
      ],
    );
    await expect(publication.publish(f.request.requestId, owners[0]!, body)).rejects.toMatchObject({
      kind: 'conflict',
    });
    expect((await publication.publish(f.request.requestId, owners[0]!, publishBody(f))).phase).toBe(
      'published',
    );
  });
  it('fails closed for revoked and corrupted public packages without exposing a partial package', async () => {
    const f = await uploaded();
    const result = await publication.publish(f.request.requestId, owners[0]!, publishBody(f));
    const id = result.release!.releaseId;
    const key = [...objects.values.keys()].find(
      (value) => value.startsWith('agent-packages/') && value.endsWith('/AGENT.md'),
    )!;
    const exact = objects.values.get(key)!;
    objects.values.set(key, Buffer.from('PRIVATE_CORRUPTION_CANARY'));
    const bad = await app.inject({ url: `/api/v1/agent-package-publications/${id}` });
    expect(bad.statusCode).toBe(503);
    expect(bad.body).not.toContain('PRIVATE_CORRUPTION_CANARY');
    objects.values.set(key, exact);
    await api.query(
      "INSERT INTO agent_package_release_revocations(release_id,owner_user_id,package_digest,reason) VALUES($1,$2,$3,'publisher_request')",
      [id, owners[0], f.request.packageDigest],
    );
    await expect(publication.read(id)).rejects.toMatchObject({ kind: 'not_found' });
    expect(
      (await app.inject({ url: `/api/v1/agent-package-publications/${id}/package` })).statusCode,
    ).toBe(404);
  });
  it('retains rejection and never interprets approval or a Desktop secret as publication authority', async () => {
    const f = transferFixture();
    const pending = await transfer.create(f.request);
    const rejection = {
      ...f.approval,
      decision: 'reject',
      verificationCode: pending.verificationCode,
    };
    const result = await transfer.approve(f.request.requestId, owners[0]!, rejection);
    expect(result.phase).toBe('rejected');
    expect(await transfer.approve(f.request.requestId, owners[0]!, rejection)).toEqual(result);
    await expect(transfer.upload(f.request.requestId, f.secret, f.upload)).rejects.toMatchObject({
      kind: 'conflict',
    });
    await expect(
      publication.publish(f.request.requestId, owners[0]!, publishBody(f)),
    ).rejects.toMatchObject({ kind: 'conflict' });
    await expect(
      transfer.approve(f.request.requestId, owners[1]!, rejection),
    ).rejects.toMatchObject({ kind: 'not_found' });
    expect(objects.writes).toBe(0);
  });
  it('rolls back public claim and release if final transfer transition fails, preserving exact retry', async () => {
    const f = await uploaded();
    const body = publishBody(f);
    const wrapped: TxPool = {
      connect: async () => {
        const client = await asTxPool(api).connect();
        return {
          release: () => client.release(),
          query: async (sql, params) => {
            if (sql.includes("SET phase='published'")) throw new Error('PRIVATE_COMMIT_CANARY');
            return client.query(sql, params);
          },
        };
      },
    };
    await expect(
      new AgentPublicationService(wrapped, api, objects, 'http://localhost').publish(
        f.request.requestId,
        owners[0]!,
        body,
      ),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    expect((await transfer.status(f.request.requestId, f.secret)).phase).toBe('uploaded');
    expect(
      (
        await admin.query(
          'SELECT count(*)::int AS n FROM agent_package_releases WHERE owner_user_id=$1 AND idempotency_key=$2',
          [owners[0], body.requestId],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await admin.query(
          'SELECT count(*)::int AS n FROM agent_package_publisher_claims WHERE owner_user_id=$1 AND draft_id=$2',
          [owners[0], f.saved.saved!.draftId],
        )
      ).rows[0].n,
    ).toBe(0);
    expect((await publication.publish(f.request.requestId, owners[0]!, body)).phase).toBe(
      'published',
    );
  });
});
