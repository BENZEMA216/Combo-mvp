import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
import * as receiver from '../modules/agent-package-release/receiver-handoff.js';
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
      for (const path of [
        `/agent-package-publications/${publicationFixture().release.releaseId}/codex-installation`,
        `/agent-package-receivers/v1/${'a'.repeat(64)}.mjs`,
      ]) {
        expect((await instance.inject({ url: `/api/v1${path}` })).statusCode).toBe(404);
      }
    },
  );
  it('rejects browser and alternative credentials before parsing Desktop bodies', async () => {
    const create = vi.spyOn(AgentTransferService.prototype, 'create');
    for (const extra of [
      { origin: 'http://localhost' },
      { cookie: browserCookie },
      { authorization: 'Bearer PRIVATE_CANARY' },
      { 'sec-fetch-site': 'none' },
      { 'sec-fetch-dest': 'empty' },
      { 'sec-fetch-user': '?1' },
      { 'sec-fetch-mode': 'navigate' },
      { 'sec-fetch-mode': 'no-cors' },
      { 'sec-fetch-mode': 'same-origin' },
      { 'sec-fetch-mode': 'cors, navigate' },
      { 'sec-fetch-mode': '' },
    ]) {
      const { instance, queries } = await app();
      const response = await instance.inject({
        method: 'POST',
        url: '/api/v1/agent-package-transfers',
        headers: { 'content-type': 'application/json', ...extra },
        payload: '{',
      });
      expect(response.statusCode).toBe(403);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain('PRIVATE_CANARY');
      expect(queries).toEqual([]);
    }
    expect(create).not.toHaveBeenCalled();
  });
  it('accepts actual Node fetch transport while rejecting browser metadata combined with cors', async () => {
    const { instance } = await app();
    const f = transferFixture();
    const observed: { mode: unknown; site: unknown; origin: unknown; cookie: unknown }[] = [];
    instance.server.on('request', (req) => {
      observed.push({
        mode: req.headers['sec-fetch-mode'],
        site: req.headers['sec-fetch-site'],
        origin: req.headers.origin,
        cookie: req.headers.cookie,
      });
    });
    const create = vi.spyOn(AgentTransferService.prototype, 'create').mockResolvedValue(f.receipt);
    vi.spyOn(AgentTransferService.prototype, 'status').mockResolvedValue(f.receipt);
    vi.spyOn(AgentTransferService.prototype, 'upload').mockResolvedValue(f.receipt);
    const origin = await instance.listen({ host: '127.0.0.1', port: 0 });
    for (const [path, body, authorization] of [
      ['/agent-package-transfers', f.request, undefined],
      [`/agent-package-transfers/${f.request.requestId}/status`, {}, `Bearer ${f.secret}`],
      [`/agent-package-transfers/${f.request.requestId}/upload`, f.upload, `Bearer ${f.secret}`],
    ] as const) {
      const response = await globalThis.fetch(`${origin}/api/v1${path}`, {
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          ...(authorization ? { authorization } : {}),
        },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ data: f.receipt });
    }
    expect(observed).toEqual(
      Array.from({ length: 3 }, () => ({
        mode: 'cors',
        site: undefined,
        origin: undefined,
        cookie: undefined,
      })),
    );
    const browserMetadata: Record<string, string>[] = [
      { cookie: browserCookie },
      { origin: 'http://localhost' },
      { 'sec-fetch-site': 'none' },
      { 'sec-fetch-dest': 'empty' },
      { 'sec-fetch-user': '?1' },
    ];
    for (const extra of browserMetadata) {
      const response = await globalThis.fetch(`${origin}/api/v1/agent-package-transfers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...extra },
        body: '{',
      });
      expect(response.status).toBe(403);
      await response.arrayBuffer();
    }
    expect(create).toHaveBeenCalledTimes(1);
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
  it('serves an anonymous pinned receiver handoff without running code or resolving a user', async () => {
    const { instance, queries } = await app();
    const publication = publicationFixture();
    const bytes = Buffer.from('throw new Error("MUST_NOT_EXECUTE_IN_API");\n');
    const hex = createHash('sha256').update(bytes).digest('hex');
    const artifact = { bytes, digest: `sha256:${hex}`, filename: `${hex}.mjs` };
    const read = vi.spyOn(AgentPublicationService.prototype, 'read').mockResolvedValue(publication);
    vi.spyOn(receiver, 'getAgentReceiverArtifact').mockResolvedValue(artifact);
    const upload = vi.spyOn(AgentTransferService.prototype, 'upload');
    const publish = vi.spyOn(AgentPublicationService.prototype, 'publish');
    const response = await instance.inject({
      url: `/api/v1/agent-package-publications/${publication.release.releaseId}/codex-installation`,
      headers: { host: 'attacker.example.test', cookie: browserCookie },
    });
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data).toMatchObject({
      protocol: 'combo.codex-agent-installation-handoff/1',
      release: publication.release,
      shareUrl: publication.shareUrl,
      receiver: {
        profileVersion: 'combo.agent-package-receiver-text/1',
        url: `http://localhost/api/v1/agent-package-receivers/v1/${hex}.mjs`,
        digest: artifact.digest,
        command: 'install',
        arguments: {
          '--share-url': publication.shareUrl,
          '--package-digest': publication.release.packageDigest,
        },
      },
      runtime: { status: 'not_run' },
    });
    expect(JSON.stringify(data)).not.toContain('attacker.example.test');
    expect(JSON.stringify(data)).not.toContain(browserCookie);
    expect(data).not.toHaveProperty('package');
    expect(data).not.toHaveProperty('publisher');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(read).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith(publication.release.releaseId);
    const script = await instance.inject({
      url: `/api/v1/agent-package-receivers/v1/${hex}.mjs`,
    });
    expect(script.statusCode).toBe(200);
    expect(script.rawPayload).toEqual(bytes);
    expect(script.headers['content-type']).toContain('text/javascript');
    expect(script.headers['content-disposition']).toContain(`combo-agent-receiver-${hex}.mjs`);
    expect(script.headers['x-content-type-options']).toBe('nosniff');
    expect(script.headers['cache-control']).toBe('no-store');
    expect(read).toHaveBeenCalledTimes(1);
    expect(queries).toEqual([]);
    expect(upload).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
  it('distributes the real built receiver bytes through their exact hash address', async () => {
    const { instance, queries } = await app();
    const publication = publicationFixture();
    vi.spyOn(AgentPublicationService.prototype, 'read').mockResolvedValue(publication);
    // No receiver mock: fail if the application export or bundled build asset is missing.
    const artifact = await receiver.getAgentReceiverArtifact();
    expect(artifact.bytes.byteLength).toBeGreaterThan(0);
    expect(artifact.bytes.byteLength).toBeLessThanOrEqual(1024 * 1024);
    const hex = createHash('sha256').update(artifact.bytes).digest('hex');
    expect(artifact.digest).toBe(`sha256:${hex}`);
    expect(artifact.filename).toBe(`${hex}.mjs`);
    const handoff = await instance.inject({
      url: `/api/v1/agent-package-publications/${publication.release.releaseId}/codex-installation`,
    });
    expect(handoff.statusCode).toBe(200);
    expect(handoff.json().data.receiver.digest).toBe(artifact.digest);
    const download = await instance.inject({
      url: new URL(handoff.json().data.receiver.url).pathname,
    });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload).toEqual(artifact.bytes);
    expect(queries).toEqual([]);
  });
  it('rejects unavailable, revoked, rebound and query-bearing handoffs without exposing raw errors', async () => {
    const { instance, queries } = await app();
    const publication = publicationFixture();
    const path = `/api/v1/agent-package-publications/${publication.release.releaseId}/codex-installation`;
    const read = vi.spyOn(AgentPublicationService.prototype, 'read');
    const artifact = vi.spyOn(receiver, 'getAgentReceiverArtifact');
    for (const [error, status] of [
      [new TransferFailure('not_found'), 404],
      [new Error('PRIVATE_STORAGE_PATH'), 503],
    ] as const) {
      read.mockRejectedValue(error);
      const response = await instance.inject({ url: path });
      expect(response.statusCode).toBe(status);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).not.toContain('PRIVATE_STORAGE_PATH');
    }
    expect(artifact).not.toHaveBeenCalled();
    read.mockResolvedValue({
      ...publication,
      release: {
        ...publication.release,
        releaseId:
          `release.agent-package.${'f'.repeat(32)}` as typeof publication.release.releaseId,
      },
    });
    expect((await instance.inject({ url: path })).statusCode).toBe(503);
    expect(artifact).not.toHaveBeenCalled();
    read.mockResolvedValue(publication);
    artifact.mockRejectedValue(new Error('PRIVATE_ARTIFACT_PATH'));
    const missing = await instance.inject({ url: path });
    expect(missing.statusCode).toBe(503);
    expect(missing.body).not.toContain('PRIVATE_ARTIFACT_PATH');
    read.mockClear();
    artifact.mockClear();
    for (const url of [
      `${path}?access_token=PRIVATE_CANARY`,
      '/api/v1/agent-package-publications/invalid/codex-installation',
      `/api/v1/agent-package-receivers/v1/${'a'.repeat(64)}.mjs?latest=1`,
      '/api/v1/agent-package-receivers/v1/latest.mjs',
    ]) {
      expect((await instance.inject({ url })).statusCode).toBe(404);
    }
    expect(read).not.toHaveBeenCalled();
    expect(artifact).not.toHaveBeenCalled();
    expect(queries).toEqual([]);
  });
  it('never serves different bytes at an earlier receiver digest URL', async () => {
    const { instance, queries } = await app();
    const bytes = Buffer.from('export {};\n');
    const hex = createHash('sha256').update(bytes).digest('hex');
    vi.spyOn(receiver, 'getAgentReceiverArtifact').mockResolvedValue({
      bytes,
      digest: `sha256:${hex}`,
      filename: `${hex}.mjs`,
    });
    const response = await instance.inject({
      url: `/api/v1/agent-package-receivers/v1/${'a'.repeat(64)}.mjs`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('export');
    expect(queries).toEqual([]);
  });
  it('keeps acquisition instructions exact, non-executing and separate from Agent content', () => {
    const publication = publicationFixture();
    const prompt = receiver.agentReceiverPrompt(
      'http://localhost',
      publication.release.releaseId,
      publication.release.packageDigest,
    );
    expect(prompt).toContain(publication.shareUrl);
    expect(prompt).toContain(
      `/api/v1/agent-package-publications/${publication.release.releaseId}/codex-installation`,
    );
    expect(prompt).toContain(publication.release.packageDigest);
    expect(prompt).toContain('不重新提取或编译');
    expect(prompt).toContain('不覆盖已有文件');
    expect(prompt).not.toContain('curl');
    expect(() =>
      receiver.agentReceiverPrompt(
        'http://localhost/private',
        publication.release.releaseId,
        publication.release.packageDigest,
      ),
    ).toThrow();
    expect(() =>
      receiver.agentReceiverPrompt('http://localhost', 'latest', publication.release.packageDigest),
    ).toThrow();
    expect(() =>
      receiver.agentReceiverPrompt(
        'http://localhost',
        publication.release.releaseId,
        'wrong-digest',
      ),
    ).toThrow();
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
