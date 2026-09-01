import type { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';
import {
  CREATOR_AGENT_PACKAGE_PROTOCOL,
  createCreatorAgentPackageManifest,
  digestCreatorAgentPackage,
  digestCreatorAgentPackageFile,
  serializeCreatorAgentPackageManifest,
} from '@cb/creator-agent-protocol/agent-package';
import {
  createCreatorAgentPackageRelease,
  type CreatorAgentPackageRelease,
} from '@cb/creator-agent-protocol/agent-package-release';
import {
  CREATOR_KNOWLEDGE_BUNDLE_PROTOCOL,
  CREATOR_KNOWLEDGE_BUNDLE_RESOURCE_PATH,
  CREATOR_KNOWLEDGE_SKILL_PATH,
  serializeCreatorKnowledgeBundle,
} from '@cb/creator-agent-protocol/knowledge-bundle';
import {
  HOSTED_KNOWLEDGE_AGENT_SLUG,
  HostedKnowledgeAgentDescriptorSchema,
  KnowledgeCitationExcerptSchema,
  KnowledgeTurnResultSchema,
  StartHostedKnowledgeAgentResultSchema,
} from '@cb/shared';
import { describe, expect, it, vi } from 'vitest';

import { ALL_ENDPOINTS } from '../bootstrap/routes.js';
import {
  AGENT_PACKAGE_OBJECT_BUCKET,
  agentPackageObjectKey,
  boundedFrozenCitationExcerpt,
} from '../modules/knowledge-agent/resolver.js';
import type { Env, KnowledgeAgentTestGate } from '../platform/config/env.js';
import { FakeDb, FakeObjectStore, silentLog } from './fakes.js';

const CREATOR = '00000000-0000-4000-8000-000000000201';
const CONSUMER = '00000000-0000-4000-8000-000000000202';
const CAPABILITY_ID = '00000000-0000-4000-8000-000000000203';
const SOURCE_SHA = '6'.repeat(40);

interface Candidate {
  db: FakeDb;
  store: FakeObjectStore;
  env: Env;
  gate: KnowledgeAgentTestGate;
  release: CreatorAgentPackageRelease;
  packageDigest: string;
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function candidate(): Promise<Candidate> {
  const db = new FakeDb();
  const store = new FakeObjectStore();
  db.seedCapability({
    id: CAPABILITY_ID,
    owner_user_id: CREATOR,
    published: true,
    kind: 'knowledge',
    name: '数据库可变名称',
    summary: '数据库可变摘要',
  });
  const agentMarkdown = bytes('# Agent\nUse frozen knowledge.');
  const skillMarkdown = bytes('# Knowledge\nSearch before answering.');
  const content = 'Combo 的免费额度可以用于前三次成功回答。';
  const bundleBytes = bytes(
    serializeCreatorKnowledgeBundle({
      protocol: CREATOR_KNOWLEDGE_BUNDLE_PROTOCOL,
      chunks: [
        {
          id: `chunk.knowledge.${'1'.repeat(32)}`,
          source: {
            sourceId: `source.knowledge.${'2'.repeat(32)}`,
            displayLabel: '公开计费手册',
          },
          content,
          contentDigest: digestCreatorAgentPackageFile(bytes(content)),
        },
      ],
    }),
  );
  const manifest = createCreatorAgentPackageManifest({
    protocol: CREATOR_AGENT_PACKAGE_PROTOCOL,
    name: 'Combo 知识助手',
    description: '基于已发布知识回答陌生问题。',
    instructions: 'AGENT.md',
    skills: [CREATOR_KNOWLEDGE_SKILL_PATH],
    files: [
      {
        path: 'AGENT.md',
        byteLength: agentMarkdown.byteLength,
        digest: digestCreatorAgentPackageFile(agentMarkdown),
      },
      {
        path: CREATOR_KNOWLEDGE_SKILL_PATH,
        byteLength: skillMarkdown.byteLength,
        digest: digestCreatorAgentPackageFile(skillMarkdown),
      },
      {
        path: CREATOR_KNOWLEDGE_BUNDLE_RESOURCE_PATH,
        byteLength: bundleBytes.byteLength,
        digest: digestCreatorAgentPackageFile(bundleBytes),
      },
    ],
  });
  const packageDigest = digestCreatorAgentPackage(manifest);
  const release = createCreatorAgentPackageRelease({
    protocol: 'combo.agent-package-release/1',
    releaseId: `release.agent-package.${'3'.repeat(32)}`,
    packageDigest,
  });
  const gate: KnowledgeAgentTestGate = {
    protocol: 'combo.knowledge-agent-runtime-test-gate/2',
    sourceSha: SOURCE_SHA,
    publisherUserId: CREATOR,
    capabilityId: CAPABILITY_ID,
    releaseId: release.releaseId,
    packageDigest,
    validatorPolicyVersion: 'knowledge-agent-grounded-validator-v2',
  };
  const env = {
    COMBO_ENVIRONMENT: 'test',
    COMBO_SOURCE_SHA: SOURCE_SHA,
    COMBO_RELEASE_ID: `release-${SOURCE_SHA}`,
    COMBO_BUILT_AT: '2026-09-02T00:00:00.000Z',
    COMBO_RELEASE_MANIFEST_DIGEST: `sha256:${'4'.repeat(64)}`,
    COMBO_WEB_ASSET_MANIFEST: `sha256:${'5'.repeat(64)}`,
    COMBO_KNOWLEDGE_AGENT_TEST_GATE: JSON.stringify(gate),
    RUNTIME_BILLING_FREE_USES: 3,
    RUNTIME_BILLING_UNIT_PRICE_CENTS: 1,
  } as Env;
  db.seedAgentPackageRegistry({
    packageDigest,
    releaseId: release.releaseId,
    ownerUserId: CREATOR,
  });
  for (const [path, body] of [
    ['agent.json', bytes(serializeCreatorAgentPackageManifest(manifest))],
    ['AGENT.md', agentMarkdown],
    [CREATOR_KNOWLEDGE_SKILL_PATH, skillMarkdown],
    [CREATOR_KNOWLEDGE_BUNDLE_RESOURCE_PATH, bundleBytes],
  ] as const) {
    await store.putObject(
      AGENT_PACKAGE_OBJECT_BUCKET,
      agentPackageObjectKey(packageDigest, path),
      body,
    );
  }
  return { db, store, env, gate, release, packageDigest };
}

function handler(method: 'GET' | 'POST', url: string): RouteHandlerMethod {
  const endpoint = ALL_ENDPOINTS.find((item) => item.method === method && item.url === url);
  if (!endpoint) throw new Error(`missing ${method} ${url}`);
  return endpoint.handler;
}

function request(input: Candidate, body?: unknown): FastifyRequest {
  return {
    id: 'trace-hosted-entry',
    auth: { userId: CONSUMER, account: 'creator-consumer', roles: ['creator'] },
    body,
    params: {},
    query: {},
    log: silentLog,
    server: { infra: { db: input.db, objectStore: input.store, env: input.env } },
  } as unknown as FastifyRequest;
}

async function call(
  route: RouteHandlerMethod,
  req: FastifyRequest,
): Promise<{
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
}> {
  const captured = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
  };
  const reply = {
    code(statusCode: number) {
      captured.statusCode = statusCode;
      return reply;
    },
    header(name: string, value: string) {
      captured.headers[name] = value;
      return reply;
    },
    send(body: unknown) {
      captured.body = body;
      return reply;
    },
  } as unknown as FastifyReply;
  await (route as (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>)(req, reply);
  return captured;
}

describe('fixed hosted consumer knowledge Agent entry', () => {
  it('keeps the public entry schemas strict and free of internal binding selectors', () => {
    const descriptor = {
      slug: HOSTED_KNOWLEDGE_AGENT_SLUG,
      name: 'Combo 知识助手',
      summary: '基于已发布知识回答陌生问题。',
      billing: { currency: 'CNY', unitPriceCents: '1', freeUses: 3 },
    };
    expect(HostedKnowledgeAgentDescriptorSchema.safeParse(descriptor).success).toBe(true);
    for (const internal of [
      { capabilityId: CAPABILITY_ID },
      { publisherUserId: CREATOR },
      { releaseId: `release.agent-package.${'3'.repeat(32)}` },
      { packageDigest: `sha256:${'2'.repeat(64)}` },
      { sourceSha: SOURCE_SHA },
      { gate: 'combo.knowledge-agent-runtime-test-gate/2' },
      { instructions: 'private prompt' },
      { objectKey: 'agent-packages/private' },
    ]) {
      expect(
        HostedKnowledgeAgentDescriptorSchema.safeParse({ ...descriptor, ...internal }).success,
      ).toBe(false);
    }

    const sessionId = '99999999-9999-4999-8999-999999999999';
    expect(StartHostedKnowledgeAgentResultSchema.safeParse({ sessionId }).success).toBe(true);
    expect(
      StartHostedKnowledgeAgentResultSchema.safeParse({ sessionId, capabilityId: CAPABILITY_ID })
        .success,
    ).toBe(false);
  });

  it('opens at the recovery-order maximum and fails closed above it before Package reads', async () => {
    const maximum = await candidate();
    maximum.env.RUNTIME_BILLING_UNIT_PRICE_CENTS = 99_999_999;
    const descriptor = await call(
      handler('GET', '/runtime/agents/combo-knowledge'),
      request(maximum),
    );
    expect(descriptor).toMatchObject({
      statusCode: 200,
      body: { data: { billing: { unitPriceCents: '99999999' } } },
    });
    const started = await call(
      handler('POST', '/runtime/agents/combo-knowledge/start'),
      request(maximum, {}),
    );
    expect(started.statusCode).toBe(201);
    expect(maximum.db.sessions.size).toBe(1);

    const overflow = await candidate();
    overflow.env.RUNTIME_BILLING_UNIT_PRICE_CENTS = 100_000_000;
    const packageRead = vi.spyOn(overflow.store, 'getObjectBounded');
    const unavailableDescriptor = await call(
      handler('GET', '/runtime/agents/combo-knowledge'),
      request(overflow),
    );
    const unavailableStart = await call(
      handler('POST', '/runtime/agents/combo-knowledge/start'),
      request(overflow, {}),
    );
    expect(unavailableDescriptor.statusCode).toBe(503);
    expect(unavailableStart.statusCode).toBe(503);
    expect(overflow.db.sessions.size).toBe(0);
    expect(packageRead).not.toHaveBeenCalled();
  });

  it('returns a strict Package-backed descriptor without any internal selector or Session write', async () => {
    const current = await candidate();
    const response = await call(
      handler('GET', '/runtime/agents/combo-knowledge'),
      request(current),
    );
    expect(response).toMatchObject({
      statusCode: 200,
      headers: { 'cache-control': 'private, no-store' },
      body: {
        data: {
          slug: 'combo-knowledge',
          name: 'Combo 知识助手',
          summary: '基于已发布知识回答陌生问题。',
          billing: { currency: 'CNY', unitPriceCents: '1', freeUses: 3 },
        },
      },
    });
    expect(current.db.sessions.size).toBe(0);
    for (const forbidden of [
      'capability',
      'publisher',
      'releaseId',
      'packageDigest',
      'sourceSha',
      'gate',
      'instructions',
      'agent-packages/',
    ]) {
      expect(JSON.stringify(response.body)).not.toContain(forbidden);
    }
  });

  it('starts one exact frozen v2 Session and returns only its id', async () => {
    const current = await candidate();
    const response = await call(
      handler('POST', '/runtime/agents/combo-knowledge/start'),
      request(current, {}),
    );
    expect(response.statusCode).toBe(201);
    const data = (response.body as { data: Record<string, unknown> }).data;
    expect(Object.keys(data)).toEqual(['sessionId']);
    expect(data.sessionId).toEqual(expect.any(String));
    expect(current.db.sessions.get(String(data.sessionId))).toMatchObject({
      owner_user_id: CONSUMER,
      capability_id: CAPABILITY_ID,
      product_kind: 'knowledge_agent_test',
      release_id: current.release.releaseId,
      package_digest: current.packageDigest,
    });
  });

  it('maps closed, v1, drifted, and missing selections to 404 with zero Session writes', async () => {
    const cases = await Promise.all([candidate(), candidate(), candidate(), candidate()]);
    cases[0]!.env.COMBO_KNOWLEDGE_AGENT_TEST_GATE = '';
    cases[1]!.env.COMBO_KNOWLEDGE_AGENT_TEST_GATE = JSON.stringify({
      ...cases[1]!.gate,
      protocol: 'combo.knowledge-agent-runtime-test-gate/1',
      validatorPolicyVersion: 'knowledge-agent-test-validator-v1',
      cases: [
        {
          questionDigest: `sha256:${'7'.repeat(64)}`,
          answer: '固定答案。',
          citationChunkIds: [`chunk.knowledge.${'1'.repeat(32)}`],
        },
      ],
    });
    cases[2]!.db.agentPackageReleases.get(cases[2]!.release.releaseId)!.package_digest =
      `sha256:${'8'.repeat(64)}`;
    cases[3]!.db.capabilities.clear();

    for (const current of cases) {
      const response = await call(
        handler('POST', '/runtime/agents/combo-knowledge/start'),
        request(current, {}),
      );
      expect(response.statusCode).toBe(404);
      expect(current.db.sessions.size).toBe(0);
    }
  });

  it('maps real Package dependency failure to 503 and rejects a non-empty start body', async () => {
    const unavailable = await candidate();
    vi.spyOn(unavailable.store, 'getObjectBounded').mockRejectedValueOnce(
      new Error('private provider detail'),
    );
    const unavailableResponse = await call(
      handler('POST', '/runtime/agents/combo-knowledge/start'),
      request(unavailable, {}),
    );
    expect(unavailableResponse.statusCode).toBe(503);
    expect(JSON.stringify(unavailableResponse.body)).not.toContain('private provider detail');
    expect(unavailable.db.sessions.size).toBe(0);

    const invalidBody = await candidate();
    const invalidResponse = await call(
      handler('POST', '/runtime/agents/combo-knowledge/start'),
      request(invalidBody, { capabilityId: CAPABILITY_ID }),
    );
    expect(invalidResponse.statusCode).toBe(400);
    expect(invalidBody.db.sessions.size).toBe(0);
  });
});

describe('frozen citation excerpt projection', () => {
  it('accepts the display-only excerpt on a receipt and rejects unsafe or unbounded text', () => {
    expect(KnowledgeCitationExcerptSchema.safeParse('冻结知识片段。').success).toBe(true);
    expect(KnowledgeCitationExcerptSchema.safeParse('a'.repeat(2 * 1_024)).success).toBe(true);
    expect(KnowledgeCitationExcerptSchema.safeParse('a'.repeat(2 * 1_024 + 1)).success).toBe(false);
    expect(KnowledgeCitationExcerptSchema.safeParse('e\u0301').success).toBe(false);
    expect(KnowledgeCitationExcerptSchema.safeParse('safe\u202Ehidden').success).toBe(false);

    expect(
      KnowledgeTurnResultSchema.safeParse({
        protocol: 'combo.agent-usage-receipt/1',
        receiptId: '11111111-1111-4111-8111-111111111111',
        usageId: '22222222-2222-4222-8222-222222222222',
        turnId: '33333333-3333-4333-8333-333333333333',
        createdAt: '2026-09-02T10:00:00+08:00',
        binding: {
          productKind: 'knowledge_agent_test',
          capability: { id: CAPABILITY_ID, protocol: 'combo.agent-package-capability/2' },
          release: {
            protocol: 'combo.agent-package-release/1',
            releaseId: `release.agent-package.${'3'.repeat(32)}`,
            packageDigest: `sha256:${'2'.repeat(64)}`,
          },
          releaseScope: 'controlled_test',
          knowledge: {
            protocol: 'combo.knowledge-bundle/1',
            resourcePath: CREATOR_KNOWLEDGE_BUNDLE_RESOURCE_PATH,
            resourceDigest: `sha256:${'4'.repeat(64)}`,
          },
        },
        billing: {
          policyVersion: 'runtime-usage-v1',
          source: 'free',
          currency: 'CNY',
          unitPriceCents: '1',
          settledCents: '0',
          freeLimitSnapshot: 3,
        },
        validation: {
          policyVersion: 'knowledge-agent-grounded-validator-v2',
          code: 'accepted',
        },
        runtime: {
          environment: 'test',
          releaseId: `release-${SOURCE_SHA}`,
          sourceSha: SOURCE_SHA,
        },
        outcome: 'answered',
        answer: {
          messageId: '44444444-4444-4444-8444-444444444444',
          text: '冻结知识片段。',
          responseDigest: `sha256:${'5'.repeat(64)}`,
        },
        citations: [
          {
            chunkId: `chunk.knowledge.${'1'.repeat(32)}`,
            sourceId: `source.knowledge.${'2'.repeat(32)}`,
            displayLabel: '公开规范',
            excerpt: '冻结知识片段。',
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('returns only an exact code-point-safe prefix within 2 KiB', () => {
    const source = `${'甲'.repeat(700)}末尾不应出现`;
    const excerpt = boundedFrozenCitationExcerpt(source);

    expect(excerpt).toBe('甲'.repeat(682));
    expect(Buffer.byteLength(excerpt, 'utf8')).toBe(2_046);
    expect(source.startsWith(excerpt)).toBe(true);
  });
});
