import { randomBytes, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { authSessionCookieName } from '@cb/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../platform/config/env.js';
import type { InfraContext } from '../platform/infra/index.js';
import { registerAgentTransferRoutes } from '../modules/agent-package-release/transfer-routes.js';
import { AgentTransferService } from '../modules/agent-package-release/transfer-service.js';
import { AgentPublicationService } from '../modules/agent-package-release/publication-service.js';
import {
  TransferRequest,
  TransferFailure,
  authenticateTransfer,
  transferReceipt,
} from '../modules/agent-package-release/transfer-contract.js';
import {
  commitPublicPackage,
  readPublicPackage,
} from '../modules/agent-package-release/publication-objects.js';
import { TestObjects } from './agent-draft-fixture.js';
import {
  transferFixture,
  publicationFixture,
  transferPgTarget,
  assertTransferPgInstance,
} from './agent-transfer-fixture.js';
import '../platform/http/fastify.js';

const owner = randomUUID();
const browserCookie = `${authSessionCookieName(false)}=s1.${randomBytes(32).toString('base64url')}`;
const browserHeaders = {
  origin: 'http://localhost',
  'sec-fetch-site': 'same-origin',
  'content-type': 'application/json',
  cookie: browserCookie,
};
const apps: FastifyInstance[] = [];
async function app(environment = 'test') {
  const instance = Fastify({ logger: false });
  const queries: string[] = [];
  const db = {
    query: async (sql: string) => {
      queries.push(sql);
      if (!sql.includes('FROM auth_sessions')) throw new Error('PRIVATE_DATABASE_CANARY');
      return {
        rows: [
          {
            session_id: randomUUID(),
            user_id: owner,
            account: 'creator-test',
            roles: ['creator'],
            disabled_at: null,
          },
        ],
      };
    },
  };
  instance.decorate('infra', {
    db,
    env: {
      ...loadEnv(),
      COMBO_ENVIRONMENT: environment,
      SESSION_COOKIE_SECURE: false,
      PUBLIC_APP_ORIGINS: 'http://localhost',
    },
  } as unknown as InfraContext);
  await instance.register(cookie);
  await instance.register(rateLimit, { global: false });
  await instance.register(registerAgentTransferRoutes, { prefix: '/api/v1' });
  await instance.ready();
  apps.push(instance);
  return { instance, queries };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((instance) => instance.close()));
  vi.restoreAllMocks();
});
describe('Agent transfer HTTP and immutable Package boundaries (no real DB or storage)', () => {
  it('keeps metadata strict and receipts free of owner, credentials and invented revisions', () => {
    const f = transferFixture();
    expect(TransferRequest.parse(f.request)).toEqual(f.request);
    for (const key of ['owner', 'rawTranscript', 'threadId', 'source', 'uploadSecret']) {
      expect(TransferRequest.safeParse({ ...f.request, [key]: 'PRIVATE_CANARY' }).success).toBe(
        false,
      );
    }
    expect(JSON.stringify(f.receipt)).not.toContain(f.secret);
    expect(JSON.stringify(f.receipt)).not.toContain(f.request.secretSha256);
    expect(f.receipt).not.toHaveProperty('owner_user_id');
    expect(() => authenticateTransfer(f.row, f.secret)).not.toThrow();
    expect(() => authenticateTransfer(f.row, `${f.secret.slice(0, -1)}!`)).toThrow();
    expect(() =>
      transferReceipt(
        {
          ...f.row,
          phase: 'uploaded',
          draft_id: 'draft.agent-package.' + 'a'.repeat(32),
          draft_revision: 2,
        },
        'http://localhost',
      ),
    ).toThrow();
  });
  it.each(['development', 'preview', 'production'])(
    'does not register transfer or public routes in %s',
    async (environment) => {
      const { instance, queries } = await app(environment);
      expect(
        (
          await instance.inject({
            method: 'POST',
            url: '/api/v1/agent-package-transfers',
            payload: {},
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await instance.inject({
            url: `/api/v1/agent-package-publications/${publicationFixture().release.releaseId}`,
          })
        ).statusCode,
      ).toBe(404);
      expect(queries).toEqual([]);
    },
  );
  it('rejects browser and alternative credentials before parsing Desktop bodies', async () => {
    const { instance, queries } = await app();
    const create = vi.spyOn(AgentTransferService.prototype, 'create');
    for (const extra of [
      { origin: 'http://localhost' },
      { cookie: browserCookie },
      { authorization: 'Bearer PRIVATE_CANARY' },
      { 'sec-fetch-site': 'none' },
    ]) {
      const response = await instance.inject({
        method: 'POST',
        url: '/api/v1/agent-package-transfers',
        headers: { 'content-type': 'application/json', ...extra },
        payload: '{',
      });
      expect(response.statusCode).toBe(403);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain('PRIVATE_CANARY');
    }
    expect(create).not.toHaveBeenCalled();
    expect(queries).toEqual([]);
  });
  it('authenticates upload before malformed or oversized bodies and never accepts query secrets', async () => {
    const { instance } = await app();
    const f = transferFixture();
    const status = vi
      .spyOn(AgentTransferService.prototype, 'status')
      .mockRejectedValue(new TransferFailure('not_found'));
    const upload = vi.spyOn(AgentTransferService.prototype, 'upload');
    const url = `/api/v1/agent-package-transfers/${f.request.requestId}/upload`;
    for (const payload of ['{', 'x'.repeat(1_048_577)]) {
      const response = await instance.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${f.secret}` },
        payload,
      });
      expect(response.statusCode).toBe(404);
      expect(response.headers['cache-control']).toBe('no-store');
    }
    status.mockResolvedValue(f.receipt);
    expect(
      (
        await instance.inject({
          method: 'POST',
          url: `${url}?access_token=PRIVATE_CANARY`,
          payload: {},
        })
      ).statusCode,
    ).toBe(404);
    expect(upload).not.toHaveBeenCalled();
  });
  it('preserves 413, 415, 429 and safe 503 envelopes', async () => {
    const { instance } = await app();
    const f = transferFixture();
    const create = vi
      .spyOn(AgentTransferService.prototype, 'create')
      .mockRejectedValue(new Error('PRIVATE_DATABASE_CANARY'));
    for (const [type, payload, status] of [
      ['text/plain', '{}', 415],
      ['application/json', 'x'.repeat(4097), 413],
      ['application/json', '{}', 503],
    ] as const) {
      const response = await instance.inject({
        method: 'POST',
        url: '/api/v1/agent-package-transfers',
        headers: { 'content-type': type },
        payload,
      });
      expect(response.statusCode).toBe(status);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain('PRIVATE_DATABASE_CANARY');
    }
    create.mockResolvedValue(f.receipt);
    for (let n = 0; n < 10; n++)
      await instance.inject({
        method: 'POST',
        url: '/api/v1/agent-package-transfers',
        payload: f.request,
      });
    const limited = await instance.inject({
      method: 'POST',
      url: '/api/v1/agent-package-transfers',
      payload: f.request,
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['cache-control']).toBe('no-store');
  });
  it('keeps browser GET readonly and publication Cookie plus exact-Origin only', async () => {
    const { instance } = await app();
    const f = transferFixture();
    const review = vi.spyOn(AgentTransferService.prototype, 'review').mockResolvedValue({
      transfer: f.receipt,
      name: f.request.name,
      draftFingerprint: f.request.draftFingerprint,
      packageDigest: f.request.packageDigest,
    });
    const approve = vi.spyOn(AgentTransferService.prototype, 'approve');
    const publish = vi
      .spyOn(AgentPublicationService.prototype, 'publish')
      .mockResolvedValue(f.receipt);
    const url = `/api/v1/agent-package-transfers/${f.request.requestId}`;
    expect((await instance.inject({ url, headers: { cookie: browserCookie } })).statusCode).toBe(
      200,
    );
    expect(review).toHaveBeenCalledWith(f.request.requestId, owner);
    expect(approve).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    for (const headers of [
      { ...browserHeaders, origin: 'https://evil.example.test' },
      { 'content-type': 'application/json', authorization: `Bearer ${f.secret}` },
      { ...browserHeaders, 'sec-fetch-site': 'same-site' },
    ]) {
      expect(
        (
          await instance.inject({
            method: 'POST',
            url: `${url}/publication`,
            headers,
            payload: '{',
          })
        ).statusCode,
      ).toBe(403);
    }
    expect(
      (
        await instance.inject({
          method: 'POST',
          url: `${url}/publication`,
          headers: { ...browserHeaders, cookie: '', authorization: `Bearer ${f.secret}` },
          payload: {},
        })
      ).statusCode,
    ).toBe(401);
    expect(publish).not.toHaveBeenCalled();
  });
  it('serves public metadata and bare package without resolving a browser identity', async () => {
    const { instance, queries } = await app();
    const publication = publicationFixture();
    vi.spyOn(AgentPublicationService.prototype, 'read').mockResolvedValue(publication);
    const path = `/api/v1/agent-package-publications/${publication.release.releaseId}`;
    const response = await instance.inject({ url: path });
    expect(response.json().data).toEqual(publication);
    const file = await instance.inject({ url: `${path}/package` });
    expect(file.json()).toEqual(publication.package);
    expect(file.headers['content-disposition']).toContain('attachment;');
    expect(file.headers['cache-control']).toBe('no-store');
    expect(queries).toEqual([]);
  });
  it('commits every exact file before manifest, rejects corruption and never publishes private Draft text', async () => {
    const objects = new TestObjects();
    const f = transferFixture();
    await commitPublicPackage(objects, f.upload.candidate);
    expect([...objects.values.keys()].at(-1)).toMatch(/\/agent.json$/u);
    const read = await readPublicPackage(objects, f.upload.candidate.packageDigest);
    expect(read).toEqual(f.upload.candidate);
    expect(JSON.stringify(read)).not.toContain(f.upload.draftText);
    const key = [...objects.values.keys()].find((value) => value.endsWith('/AGENT.md'))!;
    objects.values.set(key, Buffer.from('corrupt'));
    await expect(
      readPublicPackage(objects, f.upload.candidate.packageDigest),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(
      commitPublicPackage(new TestObjects(), {
        ...f.upload.candidate,
        files: [...f.upload.candidate.files, f.upload.candidate.files[0]!],
      }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
  });
  it('checks the disposable instance before any writable test operation', async () => {
    const directory = '/tmp/combo-publication-pg.Safe123/data';
    const raw =
      'postgres://localhost/combo_publication_test?host=/tmp/combo-publication-pg.Safe123&port=55479';
    const env = { COMBO_PUBLICATION_PG_DATA_DIR: directory };
    for (const unsafe of [
      undefined,
      'postgres://localhost/agora',
      `${raw}&host=remote.test`,
      `${raw}&dbname=production`,
      'https://localhost/combo_publication_test',
    ]) {
      expect(() => transferPgTarget(unsafe, env)).toThrow();
    }
    const query = vi
      .fn()
      .mockResolvedValue({ rows: [{ version: '16.13', directory: '/var/lib/postgresql/data' }] });
    await expect(
      assertTransferPgInstance({ query }, transferPgTarget(raw, env), (path) => path),
    ).rejects.toThrow();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![0]).toMatch(/^SELECT current_setting/u);
  });
});
