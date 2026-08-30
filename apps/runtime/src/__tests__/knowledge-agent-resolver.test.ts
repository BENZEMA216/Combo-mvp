import {
  CREATOR_AGENT_PACKAGE_PROTOCOL,
  createCreatorAgentPackageManifest,
  digestCreatorAgentPackage,
  digestCreatorAgentPackageFile,
  serializeCreatorAgentPackageManifest,
} from '@cb/creator-agent-protocol/agent-package';
import { createCreatorAgentPackageCapability } from '@cb/creator-agent-protocol/agent-package-capability';
import { createCreatorAgentPackageRelease } from '@cb/creator-agent-protocol/agent-package-release';
import {
  CREATOR_KNOWLEDGE_BUNDLE_PROTOCOL,
  CREATOR_KNOWLEDGE_BUNDLE_RESOURCE_PATH,
  CREATOR_KNOWLEDGE_SKILL_PATH,
  serializeCreatorKnowledgeBundle,
} from '@cb/creator-agent-protocol/knowledge-bundle';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { KnowledgeAgentTestGate } from '../platform/config/env.js';
import type { Queryable } from '../platform/infra/db.js';
import {
  AGENT_PACKAGE_OBJECT_BUCKET,
  agentPackageObjectKey,
  resolveKnowledgeAgentPackage,
} from '../modules/knowledge-agent/resolver.js';
import { FakeObjectStore } from './fakes.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const CAPABILITY_ID = '22222222-2222-4222-8222-222222222222';
const SOURCE_SHA = 'a'.repeat(40);
const GATE_ENV_KEYS = [
  'NODE_ENV',
  'DATABASE_URL',
  'REDIS_URL',
  'S3_ENDPOINT',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'PUBLIC_APP_ORIGINS',
  'SESSION_COOKIE_SECURE',
  'RUNTIME_BILLING_FREE_USES',
  'RUNTIME_BILLING_UNIT_PRICE_CENTS',
  'COMBO_ENVIRONMENT',
  'COMBO_SOURCE_SHA',
  'COMBO_RELEASE_ID',
  'COMBO_BUILT_AT',
  'COMBO_RELEASE_MANIFEST_DIGEST',
  'COMBO_WEB_ASSET_MANIFEST',
  'COMBO_KNOWLEDGE_AGENT_TEST_GATE',
] as const;
const originalGateEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of GATE_ENV_KEYS) originalGateEnv.set(key, process.env[key]);
});

afterEach(() => {
  for (const key of GATE_ENV_KEYS) {
    const value = originalGateEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalGateEnv.clear();
  vi.resetModules();
});

function setDeployedInfrastructure(): void {
  process.env.NODE_ENV = 'production';
  process.env.DATABASE_URL = 'postgres://runtime:runtime@database.invalid/runtime';
  process.env.REDIS_URL = 'redis://redis.invalid:6379';
  process.env.S3_ENDPOINT = 'https://objects.invalid';
  process.env.S3_ACCESS_KEY = 'test-placeholder';
  process.env.S3_SECRET_KEY = 'test-placeholder';
  process.env.PUBLIC_APP_ORIGINS = 'https://combo.example,https://review.combo.example';
  process.env.SESSION_COOKIE_SECURE = 'true';
  process.env.RUNTIME_BILLING_FREE_USES = '3';
  process.env.RUNTIME_BILLING_UNIT_PRICE_CENTS = '1';
  process.env.COMBO_SOURCE_SHA = SOURCE_SHA;
  process.env.COMBO_RELEASE_ID = `release-${SOURCE_SHA}`;
  process.env.COMBO_BUILT_AT = '2026-07-28T00:00:00.000Z';
  process.env.COMBO_RELEASE_MANIFEST_DIGEST = `sha256:${'b'.repeat(64)}`;
  process.env.COMBO_WEB_ASSET_MANIFEST = `sha256:${'c'.repeat(64)}`;
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function fixture() {
  const agentMarkdown = bytes('# Knowledge Agent\nAnswer only from retrieved evidence.');
  const skillMarkdown = bytes('# Knowledge\nSearch before submitting an answer.');
  const content = 'Combo 的受控 Test 知识内容。';
  const bundleText = serializeCreatorKnowledgeBundle({
    protocol: CREATOR_KNOWLEDGE_BUNDLE_PROTOCOL,
    chunks: [
      {
        id: `chunk.knowledge.${'1'.repeat(32)}`,
        source: {
          sourceId: `source.knowledge.${'2'.repeat(32)}`,
          displayLabel: '公开测试资料',
        },
        content,
        contentDigest: digestCreatorAgentPackageFile(bytes(content)),
      },
    ],
  });
  const bundleBytes = bytes(bundleText);
  const manifest = createCreatorAgentPackageManifest({
    protocol: CREATOR_AGENT_PACKAGE_PROTOCOL,
    name: '受控知识 Agent',
    description: '只回答固定公开测试资料。',
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
  const projection = createCreatorAgentPackageCapability({
    version: 2,
    protocol: 'combo.agent-package-capability/2',
    release,
  });
  const gate: KnowledgeAgentTestGate = {
    protocol: 'combo.knowledge-agent-runtime-test-gate/1',
    sourceSha: SOURCE_SHA,
    publisherUserId: OWNER,
    capabilityId: CAPABILITY_ID,
    releaseId: release.releaseId,
    packageDigest,
    validatorPolicyVersion: 'knowledge-agent-test-validator-v1',
    cases: [
      {
        questionDigest: `sha256:${'4'.repeat(64)}`,
        answer: '受控答案。',
        citationChunkIds: [`chunk.knowledge.${'1'.repeat(32)}`],
      },
    ],
  };
  return { agentMarkdown, skillMarkdown, bundleBytes, manifest, packageDigest, projection, gate };
}

function registryDb(
  candidate = fixture(),
  overrides: Partial<{
    release_id: string;
    package_digest: string;
    owner_user_id: string;
    release_protocol: string;
    release_scope: string;
    package_protocol: string;
  }> = {},
): Queryable & { query: ReturnType<typeof vi.fn> } {
  return {
    query: vi.fn(async () => ({
      rows: [
        {
          release_id: candidate.projection.release.releaseId,
          package_digest: candidate.packageDigest,
          owner_user_id: OWNER,
          release_protocol: 'combo.agent-package-release/1',
          release_scope: 'controlled_test',
          package_protocol: CREATOR_AGENT_PACKAGE_PROTOCOL,
          ...overrides,
        },
      ],
      rowCount: 1,
    })),
  } as Queryable & { query: ReturnType<typeof vi.fn> };
}

async function seedPackage(store: FakeObjectStore, candidate = fixture()): Promise<void> {
  const entries = [
    ['agent.json', bytes(serializeCreatorAgentPackageManifest(candidate.manifest))],
    ['AGENT.md', candidate.agentMarkdown],
    [CREATOR_KNOWLEDGE_SKILL_PATH, candidate.skillMarkdown],
    [CREATOR_KNOWLEDGE_BUNDLE_RESOURCE_PATH, candidate.bundleBytes],
  ] as const;
  for (const [path, body] of entries) {
    await store.putObject(
      AGENT_PACKAGE_OBJECT_BUCKET,
      agentPackageObjectKey(candidate.packageDigest, path),
      body,
    );
  }
}

function resolveInput(
  candidate = fixture(),
  store = new FakeObjectStore(),
  db = registryDb(candidate),
) {
  return {
    candidate,
    store,
    db,
    input: {
      db,
      objectStore: store,
      capability: {
        id: CAPABILITY_ID,
        name: '投影名称',
        summary: '投影摘要',
        kind: 'knowledge',
        published: true,
        ownerUserId: OWNER,
      },
      projection: candidate.projection,
      gate: candidate.gate,
    },
  };
}

describe('exact knowledge Agent Package resolver', () => {
  it('joins the Registry, derives digest-only keys and verifies every exact Package file', async () => {
    const context = resolveInput();
    await seedPackage(context.store, context.candidate);

    const resolved = await resolveKnowledgeAgentPackage(context.input);

    expect(resolved.binding).toMatchObject({
      capability: { id: CAPABILITY_ID, protocol: 'combo.agent-package-capability/2' },
      release: context.candidate.projection.release,
      knowledge: {
        resourcePath: CREATOR_KNOWLEDGE_BUNDLE_RESOURCE_PATH,
        resourceDigest: context.candidate.manifest.files[2]!.digest,
      },
    });
    expect(resolved.instructions).toContain('Answer only from retrieved evidence.');
    expect(resolved.instructions).toContain('Search before submitting an answer.');
    expect(resolved.knowledge.chunks[0]?.source.displayLabel).toBe('公开测试资料');
    expect(context.db.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM agent_package_releases'),
      [
        context.candidate.projection.release.releaseId,
        context.candidate.projection.release.packageDigest,
      ],
      undefined,
    );
    expect([...context.store.objects.keys()]).toEqual(
      expect.arrayContaining([
        `${AGENT_PACKAGE_OBJECT_BUCKET}/agent-packages/sha256/${context.candidate.packageDigest.slice('sha256:'.length)}/agent.json`,
      ]),
    );
  });

  it('keeps a missing or mismatched Test gate closed before DB or object access', async () => {
    const context = resolveInput();
    for (const gate of [null, { ...context.candidate.gate, capabilityId: OWNER }]) {
      await expect(resolveKnowledgeAgentPackage({ ...context.input, gate })).rejects.toMatchObject({
        failure: 'closed',
      });
    }
    expect(context.db.query).not.toHaveBeenCalled();
    expect(context.store.objects.size).toBe(0);
  });

  it.each([
    ['owner', { owner_user_id: '33333333-3333-4333-8333-333333333333' }],
    ['release protocol', { release_protocol: 'legacy' }],
    ['scope', { release_scope: 'production' }],
    ['package protocol', { package_protocol: 'legacy' }],
  ])('fails closed on Registry %s drift', async (_label, overrides) => {
    const candidate = fixture();
    const context = resolveInput(
      candidate,
      new FakeObjectStore(),
      registryDb(candidate, overrides),
    );
    await expect(resolveKnowledgeAgentPackage(context.input)).rejects.toMatchObject({
      failure: 'invalid_registry',
    });
  });

  it('rejects a manifest whose recomputed digest differs from the Registry selector', async () => {
    const context = resolveInput();
    await seedPackage(context.store, context.candidate);
    const changed = createCreatorAgentPackageManifest({
      ...context.candidate.manifest,
      description: '另一份合法但 digest 不同的 Package。',
    });
    context.store.seedText(
      AGENT_PACKAGE_OBJECT_BUCKET,
      agentPackageObjectKey(context.candidate.packageDigest, 'agent.json'),
      serializeCreatorAgentPackageManifest(changed),
    );

    await expect(resolveKnowledgeAgentPackage(context.input)).rejects.toMatchObject({
      failure: 'invalid_package',
    });
  });

  it('rejects tampered file bytes and invalid UTF-8', async () => {
    for (const replacement of [bytes('# Knowledge Agenx'), new Uint8Array([0xff])]) {
      const context = resolveInput();
      await seedPackage(context.store, context.candidate);
      await context.store.putObject(
        AGENT_PACKAGE_OBJECT_BUCKET,
        agentPackageObjectKey(context.candidate.packageDigest, 'AGENT.md'),
        replacement,
      );
      await expect(resolveKnowledgeAgentPackage(context.input)).rejects.toMatchObject({
        failure: 'invalid_package',
      });
    }
  });

  it('propagates an abort as a stable category without provider details', async () => {
    const context = resolveInput();
    await seedPackage(context.store, context.candidate);
    const controller = new AbortController();
    controller.abort();

    await expect(
      resolveKnowledgeAgentPackage({ ...context.input, signal: controller.signal }),
    ).rejects.toMatchObject({ failure: 'aborted' });
  });
});

describe('controlled knowledge Agent Test gate configuration', () => {
  it('activates only for the exact Test release SHA', async () => {
    const candidate = fixture();
    setDeployedInfrastructure();
    process.env.COMBO_ENVIRONMENT = 'test';
    process.env.COMBO_KNOWLEDGE_AGENT_TEST_GATE = JSON.stringify(candidate.gate);
    vi.resetModules();

    const { knowledgeAgentTestGateFromEnv, loadEnv } = await import('../platform/config/env.js');
    expect(knowledgeAgentTestGateFromEnv(loadEnv())).toEqual(candidate.gate);

    vi.resetModules();
    process.env.COMBO_KNOWLEDGE_AGENT_TEST_GATE = JSON.stringify({
      ...candidate.gate,
      sourceSha: 'f'.repeat(40),
    });
    const drifted = await import('../platform/config/env.js');
    expect(drifted.knowledgeAgentTestGateFromEnv(drifted.loadEnv())).toBeNull();
  });

  it.each(['preview', 'production'])('rejects gate material outside Test (%s)', async (stage) => {
    const candidate = fixture();
    setDeployedInfrastructure();
    process.env.COMBO_ENVIRONMENT = stage;
    process.env.COMBO_KNOWLEDGE_AGENT_TEST_GATE = JSON.stringify(candidate.gate);
    vi.resetModules();

    const { loadEnv } = await import('../platform/config/env.js');
    expect(() => loadEnv()).toThrowError(/COMBO_KNOWLEDGE_AGENT_TEST_GATE/u);
    try {
      loadEnv();
    } catch (error) {
      expect(String(error)).not.toContain(candidate.gate.publisherUserId);
      expect(String(error)).not.toContain(candidate.gate.packageDigest);
      expect(String(error)).not.toContain(candidate.gate.cases[0]!.answer);
    }
  });

  it('rejects non-canonical, extra-field and unsorted oracle data without echoing it', async () => {
    const candidate = fixture();
    for (const raw of [
      ` ${JSON.stringify(candidate.gate)}`,
      JSON.stringify({ ...candidate.gate, privateMarker: 'must-not-appear' }),
      JSON.stringify({
        ...candidate.gate,
        cases: [
          { ...candidate.gate.cases[0], questionDigest: `sha256:${'f'.repeat(64)}` },
          candidate.gate.cases[0],
        ],
      }),
    ]) {
      setDeployedInfrastructure();
      process.env.COMBO_ENVIRONMENT = 'test';
      process.env.COMBO_KNOWLEDGE_AGENT_TEST_GATE = raw;
      vi.resetModules();
      const { loadEnv } = await import('../platform/config/env.js');
      expect(() => loadEnv()).toThrowError(/COMBO_KNOWLEDGE_AGENT_TEST_GATE/u);
    }
  });
});
