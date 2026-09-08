import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { authSessionCookieName } from '@cb/shared';
import { createCreatorAgentPackageDraftSnapshotV2 } from '@cb/creator-agent-protocol/agent-package-draft';
import { loadEnv } from '../platform/config/env.js';
import { asTxPool, withTransaction } from '../platform/infra/db-tx.js';
import type { InfraContext } from '../platform/infra/index.js';
import * as objectStore from '../platform/infra/object-store.js';
import { registerAgentDraftRoutes } from '../modules/agent-draft/routes.js';
import { AgentDraftService, PgDraftRepository } from '../modules/agent-draft/service.js';
import {
  assertDisposableDraftDatabase,
  contextUploadFixture,
  draftFixture,
  TestObjects,
  uploadFixture,
} from './agent-draft-fixture.js';
import '../platform/http/fastify.js';

// Opt-in only. Committed append-only synthetic rows remain until this disposable DB is removed.
const enabled = process.env.AGENT_DRAFT_PG_TEST === '1';
const pgDescribe = enabled ? describe : describe.skip;
pgDescribe('private Agent Draft HTTP and PostgreSQL (object storage fake)', () => {
  let admin: Pool;
  let api: Pool;
  let app: FastifyInstance;
  let objects: TestObjects;
  let service: AgentDraftService;
  const owners = [randomUUID(), randomUUID()];
  const cookies = owners.map(() => `s1.${randomBytes(32).toString('base64url')}`);
  const headers = (index = 0) => ({
    origin: 'http://localhost',
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
    cookie: `${authSessionCookieName(false)}=${cookies[index]}`,
  });

  beforeAll(async () => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString)
      throw new Error('AGENT_DRAFT_PG_TEST requires a disposable DATABASE_URL');
    assertDisposableDraftDatabase(connectionString, process.env.GITHUB_ACTIONS === 'true');
    admin = new Pool({ connectionString, max: 2 });
    api = new Pool({ connectionString, options: '-c role=combo_api', max: 6 });
    const head = await admin.query(
      'SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1',
    );
    expect(head.rows[0]?.filename).toBe('0021_agent_package_publication.sql');
    for (const [index, owner] of owners.entries()) {
      const account = `creator-${randomBytes(8)
        .toString('hex')
        .slice(0, 8)
        .replace(/[0-9]/gu, (value) => String.fromCharCode(97 + Number(value)))}`;
      await admin.query('INSERT INTO users(id, account) VALUES($1,$2)', [owner, account]);
      await admin.query(
        "INSERT INTO auth_sessions(user_id,token_digest,auth_method) VALUES($1,$2,'email_otp')",
        [owner, createHash('sha256').update(cookies[index]!).digest()],
      );
    }
  });
  beforeEach(async () => {
    objects = new TestObjects();
    vi.spyOn(objectStore, 'createS3ImmutableObjectStore').mockReturnValue(objects);
    service = new AgentDraftService(new PgDraftRepository(asTxPool(api), api), objects);
    app = Fastify({ logger: false });
    // Only these two dependencies are consumed by the registered production routes.
    app.decorate('infra', {
      db: api,
      env: { ...loadEnv(), SESSION_COOKIE_SECURE: false, PUBLIC_APP_ORIGINS: 'http://localhost' },
    } as InfraContext);
    await app.register(cookie);
    await app.register(rateLimit, { global: false });
    await app.register(registerAgentDraftRoutes, { prefix: '/api/v1' });
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

  it('persists exact bytes, replays HTTP retries, and survives a new service instance', async () => {
    const payload = uploadFixture();
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-package-drafts',
      headers: headers(),
      payload,
    });
    expect(first.statusCode).toBe(201);
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-package-drafts',
      headers: headers(),
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data).toEqual(first.json().data);
    const record = first.json().data;
    const restarted = new AgentDraftService(new PgDraftRepository(asTxPool(api), api), objects);
    expect(await restarted.read(owners[0]!, record.draft.draftId, 1)).toEqual(record);
    const own = await app.inject({
      url: `/api/v1/agent-package-drafts/${record.draft.draftId}/revisions/1`,
      headers: headers(),
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().data.candidate.packageDigest).toBe(payload.candidate.packageDigest);
    const other = await app.inject({
      url: `/api/v1/agent-package-drafts/${record.draft.draftId}/revisions/1`,
      headers: headers(1),
    });
    expect(other.statusCode).toBe(404);
    expect(other.body).not.toContain(record.draft.text);
    expect(own.headers['cache-control']).toBe('no-store');
    expect(other.headers['cache-control']).toBe('no-store');
    expect(objects.writes).toBe(1);
  });
  it('serializes identical concurrent uploads using actual database locks', async () => {
    const payload = uploadFixture();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => service.save(owners[0]!, payload)),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => JSON.stringify(result.record))).size).toBe(1);
    expect(objects.writes).toBe(1);
  });
  it('saves context through the existing Cookie route and reopens it in a fresh Node process', async () => {
    const payload = contextUploadFixture();
    const released = await api.query('SELECT count(*) FROM agent_package_releases');
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-package-drafts',
      headers: headers(),
      payload,
    });
    expect(first.statusCode).toBe(201);
    const record = first.json().data;
    expect(record.protocol).toBe('combo.agent-context-record/1');
    expect(record.storage.revision).toBe(1);
    expect(record.draft.text).toBe(payload.draftText);
    const own = await app.inject({
      url: `/api/v1/agent-package-drafts/${record.storage.draftId}/revisions/1`,
      headers: headers(),
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().data).toEqual(record);
    const other = await app.inject({
      url: `/api/v1/agent-package-drafts/${record.storage.draftId}/revisions/1`,
      headers: headers(1),
    });
    expect(other.statusCode).toBe(404);
    expect(other.body).not.toContain(payload.draftText);
    expect(own.headers['cache-control']).toBe('no-store');
    // Only synthetic fixture objects cross this subprocess boundary. PostgreSQL and
    // the service module are real; object storage remains an explicitly fake adapter.
    const script = `
      import { Pool } from 'pg';
      import { AgentDraftService, PgDraftRepository } from ${JSON.stringify(new URL('../../dist/modules/agent-draft/service.js', import.meta.url).href)};
      import { asTxPool } from ${JSON.stringify(new URL('../../dist/platform/infra/db-tx.js', import.meta.url).href)};
      let input = ''; for await (const chunk of process.stdin) input += chunk;
      const fixture = JSON.parse(input);
      const values = new Map(fixture.objects);
      const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: '-c role=combo_api' });
      try {
        const service = new AgentDraftService(new PgDraftRepository(asTxPool(pool), pool), {
          commit: async () => { throw new Error('Restart read must never write'); },
          read: async ({ key }) => Buffer.from(values.get(key), 'base64'),
        });
        process.stdout.write(JSON.stringify(await service.read(fixture.owner, fixture.draftId, 1)));
      } finally { await pool.end(); }
    `;
    const reopened = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
        cwd: new URL('../..', import.meta.url),
        env: { DATABASE_URL: process.env.DATABASE_URL },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10_000,
      });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
      child.stderr.resume();
      child.on('error', () => reject(new Error('Fresh service process failed')));
      child.on('exit', (code) =>
        code === 0 ? resolve(output) : reject(new Error('Fresh service process failed')),
      );
      child.stdin.end(
        JSON.stringify({
          owner: owners[0],
          draftId: record.storage.draftId,
          objects: [...objects.values].map(([key, bytes]) => [
            key,
            Buffer.from(bytes).toString('base64'),
          ]),
        }),
      );
    });
    expect(JSON.parse(reopened)).toEqual(record);
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-package-drafts',
      headers: headers(),
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data).toEqual(record);
    expect(objects.writes).toBe(1);
    expect((await api.query('SELECT count(*) FROM agent_package_releases')).rows).toEqual(
      released.rows,
    );
  });
  it('serializes context retries and rejects changed content or a V2 request replay', async () => {
    const payload = contextUploadFixture();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => service.saveContext(owners[0]!, payload)),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(objects.writes).toBe(1);
    for (const other of [
      contextUploadFixture(payload.requestId, '另一种方法'),
      uploadFixture(draftFixture(), payload.requestId),
    ]) {
      await expect(service.save(owners[0]!, other)).rejects.toMatchObject({
        kind: 'idempotency_conflict',
      });
    }
    expect(objects.writes).toBe(1);
    const separate = await service.saveContext(owners[1]!, payload);
    expect(separate.created).toBe(true);
    expect(separate.record.candidate.packageDigest).toBe(
      results[0]!.record.candidate.packageDigest,
    );
    const rows = await api.query(
      'SELECT owner_user_id FROM agent_draft_revisions WHERE request_id=$1',
      [payload.requestId],
    );
    expect(new Set(rows.rows.map((row) => row.owner_user_id))).toEqual(new Set(owners));
  });
  it('uses one existing transaction and rolls back a saved context when its caller fails', async () => {
    const payload = contextUploadFixture();
    const single = new Pool({
      connectionString: process.env.DATABASE_URL,
      options: '-c role=combo_api',
      max: 1,
      connectionTimeoutMillis: 1_000,
    });
    try {
      await expect(
        withTransaction(asTxPool(single), async (tx) => {
          const scoped = new AgentDraftService(PgDraftRepository.inTransaction(tx), objects);
          const saved = await scoped.saveContext(owners[0]!, payload);
          expect(await scoped.read(owners[0]!, saved.record.storage.draftId, 1)).toEqual(
            saved.record,
          );
          expect(
            (
              await tx.query('SELECT * FROM agent_draft_revisions WHERE request_id=$1', [
                payload.requestId,
              ])
            ).rows,
          ).toHaveLength(1);
          expect(
            (
              await api.query('SELECT * FROM agent_draft_revisions WHERE request_id=$1', [
                payload.requestId,
              ])
            ).rows,
          ).toHaveLength(0);
          throw new Error('abort-after-private-save');
        }),
      ).rejects.toThrow('abort-after-private-save');
      expect(single.totalCount).toBe(1);
      expect(
        (
          await api.query('SELECT * FROM agent_draft_revisions WHERE request_id=$1', [
            payload.requestId,
          ])
        ).rows,
      ).toHaveLength(0);
      expect(objects.values.size).toBe(1);
      const recovered = await withTransaction(asTxPool(single), async (tx) => {
        const scoped = new AgentDraftService(PgDraftRepository.inTransaction(tx), objects);
        return scoped.saveContext(owners[0]!, payload);
      });
      expect(recovered.created).toBe(true);
      expect(await service.read(owners[0]!, recovered.record.storage.draftId, 1)).toEqual(
        recovered.record,
      );
      expect(objects.values.size).toBe(1);
    } finally {
      await single.end();
    }
  });
  it('rejects altered context content and caller ownership at the authenticated HTTP boundary', async () => {
    const payload = contextUploadFixture();
    for (const bad of [
      { ...payload, ownerUserId: owners[1] },
      {
        ...payload,
        candidate: { ...payload.candidate, compilationReceiptText: 'forged-attestation' },
      },
      { ...payload, draftText: ` ${payload.draftText}` },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/agent-package-drafts',
        headers: headers(),
        payload: bad,
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain('forged-attestation');
    }
    expect(objects.writes).toBe(0);
    expect(
      (
        await api.query('SELECT * FROM agent_draft_revisions WHERE request_id=$1', [
          payload.requestId,
        ])
      ).rows,
    ).toHaveLength(0);
  });
  it('rolls back context metadata after object failure and detects corruption after retry', async () => {
    const payload = contextUploadFixture();
    objects.fail = true;
    await expect(service.saveContext(owners[0]!, payload)).rejects.toMatchObject({
      kind: 'unavailable',
    });
    expect(
      (
        await api.query('SELECT * FROM agent_draft_revisions WHERE request_id=$1', [
          payload.requestId,
        ])
      ).rows,
    ).toHaveLength(0);
    objects.fail = false;
    const saved = await service.saveContext(owners[0]!, payload);
    for (const key of objects.values.keys()) objects.values.set(key, new Uint8Array([0]));
    const response = await app.inject({
      url: `/api/v1/agent-package-drafts/${saved.record.storage.draftId}/revisions/1`,
      headers: headers(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain(payload.draftText);
  });
  it('serializes a reused UUID across different Drafts regardless of UUID letter case', async () => {
    const first = uploadFixture();
    const second = uploadFixture(draftFixture(), first.requestId.toUpperCase());
    const results = await Promise.allSettled([
      service.save(owners[0]!.toUpperCase(), first),
      service.save(owners[0]!, second),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { kind: 'idempotency_conflict' },
    });
    expect(objects.writes).toBe(1);
  });
  it('permits only one competing revision and keeps the original request replay stable', async () => {
    const draft = draftFixture();
    const initial = uploadFixture(draft);
    const saved = await service.save(owners[0]!, initial);
    const { draftFingerprint, ...input } = draft;
    const next = (name: string) =>
      createCreatorAgentPackageDraftSnapshotV2({
        ...input,
        revision: 2,
        parentDraftFingerprint: draftFingerprint,
        content: { ...input.content, name },
      });
    const results = await Promise.allSettled([
      service.save(owners[0]!, uploadFixture(next('版本甲'))),
      service.save(owners[0]!, uploadFixture(next('版本乙'))),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { kind: 'revision_conflict' },
    });
    expect((await service.save(owners[0]!, initial)).record).toEqual(saved.record);
    expect(objects.writes).toBe(2);
  });
  it('rolls back failed object writes and rejects corrupted bytes after commit', async () => {
    const payload = uploadFixture();
    objects.fail = true;
    await expect(service.save(owners[0]!, payload)).rejects.toMatchObject({ kind: 'unavailable' });
    const rows = await api.query('SELECT * FROM agent_draft_revisions WHERE request_id=$1', [
      payload.requestId,
    ]);
    expect(rows.rows).toHaveLength(0);
    objects.fail = false;
    const saved = await service.save(owners[0]!, payload);
    for (const key of objects.values.keys()) objects.values.set(key, new Uint8Array([0]));
    const response = await app.inject({
      url: `/api/v1/agent-package-drafts/${saved.record.draft.draftId}/revisions/1`,
      headers: headers(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('private-storage');
  });
  it('requires Cookie authentication and trusted Origin before body parsing', async () => {
    const cases = [
      { headers: { origin: 'http://localhost', 'content-type': 'application/json' }, status: 401 },
      { headers: { ...headers(), authorization: 'Bearer test-only-token' }, status: 401 },
      { headers: { ...headers(), origin: 'http://evil.test' }, status: 403 },
      { headers: { ...headers(), 'sec-fetch-site': 'same-site' }, status: 403 },
    ];
    for (const entry of cases) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/agent-package-drafts',
        headers: entry.headers,
        payload: 'secret-malformed-body',
      });
      expect(response.statusCode).toBe(entry.status);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain('secret-malformed-body');
      expect(response.json().error).not.toHaveProperty('code');
    }
    expect(objects.writes).toBe(0);
  });
  it('returns safe 400, 413, and 415 responses without storing data', async () => {
    for (const entry of [
      { payload: '{private-invalid-json', type: 'application/json', status: 400 },
      { payload: 'x'.repeat(1_048_577), type: 'application/json', status: 413 },
      { payload: 'private-text', type: 'text/plain', status: 415 },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/agent-package-drafts',
        headers: { ...headers(), 'content-type': entry.type },
        payload: entry.payload,
      });
      expect(response.statusCode).toBe(entry.status);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain('private-');
      expect(response.json().error).not.toHaveProperty('code');
    }
    expect(objects.writes).toBe(0);
  });
  it('rate limits the upload route without dropping no-store protection', async () => {
    for (let index = 0; index < 10; index++) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/agent-package-drafts',
            remoteAddress: '198.51.100.60',
            headers: headers(),
            payload: {},
          })
        ).statusCode,
      ).toBe(400);
    }
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/agent-package-drafts',
      remoteAddress: '198.51.100.60',
      headers: headers(),
      payload: {},
    });
    expect(response.statusCode).toBe(429);
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it('enforces database parent, append-only, and application role restrictions', async () => {
    const saved = await service.save(owners[0]!, uploadFixture());
    for (const sql of [
      'UPDATE agent_draft_revisions SET view_id=view_id WHERE false',
      'DELETE FROM agent_draft_revisions WHERE false',
      'TRUNCATE agent_draft_revisions',
    ]) {
      await expect(admin.query(sql)).rejects.toMatchObject({ code: '55000' });
      await expect(api.query(sql)).rejects.toMatchObject({ code: '42501' });
    }
    await expect(
      api.query(
        `INSERT INTO agent_draft_revisions(owner_user_id,draft_id,revision,draft_fingerprint,parent_fingerprint,package_digest,snapshot_digest,snapshot_bytes,request_id,view_id)
      SELECT owner_user_id,draft_id,3,draft_fingerprint,draft_fingerprint,package_digest,snapshot_digest,snapshot_bytes,$1,view_id FROM agent_draft_revisions WHERE owner_user_id=$2 AND draft_id=$3`,
        [randomUUID(), owners[0], saved.record.draft.draftId],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    for (const role of ['combo_worker', 'combo_runtime']) {
      const restricted = new Pool({
        connectionString: process.env.DATABASE_URL,
        options: `-c role=${role}`,
      });
      try {
        await expect(restricted.query('SELECT * FROM agent_draft_revisions')).rejects.toMatchObject(
          { code: '42501' },
        );
      } finally {
        await restricted.end();
      }
    }
  });
});
