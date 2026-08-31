import { describe, expect, it } from 'vitest';
import {
  createCreatorAgentPackageManifest,
  digestCreatorAgentPackage,
  digestCreatorAgentPackageFile,
  serializeCreatorAgentPackageManifest,
} from '@cb/creator-agent-protocol/agent-package';
import { createCreatorAgentPackageRelease } from '@cb/creator-agent-protocol/agent-package-release';
import {
  CREATOR_KNOWLEDGE_BUNDLE_PROTOCOL,
  CREATOR_KNOWLEDGE_BUNDLE_RESOURCE_PATH,
  CREATOR_KNOWLEDGE_SKILL_PATH,
  serializeCreatorKnowledgeBundle,
} from '@cb/creator-agent-protocol/knowledge-bundle';

import type { Queryable } from '../platform/infra/db.js';
import type { QueryableDb, TxConn, TxPool } from '../platform/infra/db-tx.js';
import {
  ImmutableObjectStoreError,
  type ImmutableObjectCommitInput,
  type ImmutableObjectReadInput,
  type ImmutableObjectStore,
} from '../platform/infra/object-store.js';
import {
  AgentPackageReleaseFailure,
  PgAgentPackageReleaseRepository,
  agentPackageObjectKey,
  agentPackageReleaseRequestFingerprint,
  prepareControlledTestPackage,
  publishControlledTestAgentPackage,
  readControlledTestAgentPackageRelease,
  type AgentPackageReleaseRepository,
  type StoredAgentPackageRelease,
} from '../modules/agent-package-release/service.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
const IDEMPOTENCY_KEY = '33333333-3333-4333-8333-333333333333';
const CREATED_AT = '2026-08-30T00:00:00.000Z';

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function base64(value: Uint8Array): string {
  return Buffer.from(value).toString('base64');
}

function fixture() {
  const agentMarkdown = bytes('# Controlled Knowledge Agent\n\nUse the fixed knowledge skill.\n');
  const knowledgeSkill = bytes(
    '---\nname: knowledge\ndescription: Answer only from the fixed knowledge bundle.\n---\n',
  );
  const content = 'Combo 的唯一交付物是 exact Agent Package。';
  const knowledgeBundle = bytes(
    serializeCreatorKnowledgeBundle({
      protocol: CREATOR_KNOWLEDGE_BUNDLE_PROTOCOL,
      chunks: [
        {
          id: 'chunk.knowledge.00000000000000000000000000000001',
          source: {
            sourceId: 'source.knowledge.00000000000000000000000000000001',
            displayLabel: 'Combo 产品基线',
          },
          content,
          contentDigest: digestCreatorAgentPackageFile(bytes(content)),
        },
      ],
    }),
  );
  const manifest = createCreatorAgentPackageManifest({
    protocol: 'combo.agent-package/1',
    name: 'Controlled Knowledge Agent',
    description: 'Answers from one exact controlled Test knowledge bundle.',
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
        byteLength: knowledgeSkill.byteLength,
        digest: digestCreatorAgentPackageFile(knowledgeSkill),
      },
      {
        path: CREATOR_KNOWLEDGE_BUNDLE_RESOURCE_PATH,
        byteLength: knowledgeBundle.byteLength,
        digest: digestCreatorAgentPackageFile(knowledgeBundle),
      },
    ],
  });
  const agentJson = bytes(serializeCreatorAgentPackageManifest(manifest));
  return {
    manifest,
    packageDigest: digestCreatorAgentPackage(manifest),
    body: {
      idempotencyKey: IDEMPOTENCY_KEY,
      agentJsonBase64: base64(agentJson),
      agentMarkdownBase64: base64(agentMarkdown),
      knowledgeSkillBase64: base64(knowledgeSkill),
      knowledgeBundleBase64: base64(knowledgeBundle),
    },
  };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

class MemoryImmutableStore implements ImmutableObjectStore {
  readonly values = new Map<string, Uint8Array>();
  readonly commits: string[] = [];
  readonly reads: string[] = [];
  corruptReadbackKey: string | null = null;

  async commit(input: ImmutableObjectCommitInput) {
    if (input.signal?.aborted) throw new ImmutableObjectStoreError('aborted');
    this.commits.push(input.key);
    const snapshot = Uint8Array.from(input.bytes);
    const existing = this.values.get(input.key);
    if (existing !== undefined && !equalBytes(existing, snapshot)) {
      throw new ImmutableObjectStoreError('conflict');
    }
    if (existing !== undefined) {
      return { outcome: 'already_committed' as const, size: snapshot.byteLength };
    }
    this.values.set(input.key, snapshot);
    return { outcome: 'created' as const, size: snapshot.byteLength };
  }

  async read(input: ImmutableObjectReadInput): Promise<Uint8Array> {
    if (input.signal?.aborted) throw new ImmutableObjectStoreError('aborted');
    this.reads.push(input.key);
    const value = this.values.get(input.key);
    if (value === undefined) throw new ImmutableObjectStoreError('unavailable');
    if (this.corruptReadbackKey === input.key) return Uint8Array.from([...value, 0]);
    return Uint8Array.from(value);
  }
}

class MemoryReleaseRepository implements AgentPackageReleaseRepository {
  readonly byIdempotency = new Map<
    string,
    { fingerprint: string; packageDigest: string; stored: StoredAgentPackageRelease }
  >();
  readonly byRelease = new Map<
    string,
    { ownerUserId: string; stored: StoredAgentPackageRelease }
  >();
  inserts = 0;

  async createOrRead(input: Parameters<AgentPackageReleaseRepository['createOrRead']>[0]) {
    await Promise.resolve();
    const key = `${input.ownerUserId}/${input.idempotencyKey}`;
    const existing = this.byIdempotency.get(key);
    if (existing !== undefined) {
      if (
        existing.fingerprint !== input.requestFingerprint ||
        existing.packageDigest !== input.release.packageDigest
      ) {
        throw new AgentPackageReleaseFailure('idempotency_conflict');
      }
      return { stored: existing.stored, created: false };
    }
    const stored = { release: input.release, createdAt: CREATED_AT };
    this.byIdempotency.set(key, {
      fingerprint: input.requestFingerprint,
      packageDigest: input.release.packageDigest,
      stored,
    });
    this.byRelease.set(input.release.releaseId, { ownerUserId: input.ownerUserId, stored });
    this.inserts += 1;
    return { stored, created: true };
  }

  async read(ownerUserId: string, releaseId: string): Promise<StoredAgentPackageRelease | null> {
    const found = this.byRelease.get(releaseId);
    return found?.ownerUserId === ownerUserId ? found.stored : null;
  }
}

describe('controlled Test Agent Package release service', () => {
  it('accepts only the fixed canonical Package and commits files before exact agent.json readback', async () => {
    const exact = fixture();
    const store = new MemoryImmutableStore();
    const repo = new MemoryReleaseRepository();

    const result = await publishControlledTestAgentPackage(
      { objectStore: store, repository: repo },
      {
        ownerUserId: OWNER,
        expectedPackageDigest: exact.packageDigest,
        body: exact.body,
      },
    );

    const expectedKeys = [
      'AGENT.md',
      CREATOR_KNOWLEDGE_SKILL_PATH,
      CREATOR_KNOWLEDGE_BUNDLE_RESOURCE_PATH,
      'agent.json',
    ].map((path) => agentPackageObjectKey(exact.packageDigest, path));
    expect(store.commits).toEqual(expectedKeys);
    expect(store.reads).toEqual(expectedKeys);
    expect(result.created).toBe(true);
    expect(result.stored.release).toEqual({
      protocol: 'combo.agent-package-release/1',
      releaseId: expect.stringMatching(/^release\.agent-package\.[0-9a-f]{32}$/u),
      packageDigest: exact.packageDigest,
    });
    expect(result.stored.release.releaseId).not.toBe(
      `release.agent-package.${agentPackageReleaseRequestFingerprint({
        ownerUserId: OWNER,
        idempotencyKey: IDEMPOTENCY_KEY,
        packageDigest: exact.packageDigest,
      }).slice(0, 32)}`,
    );
    expect(JSON.stringify(result.stored.release)).not.toMatch(
      /owner|storage|latest|price|knowledge|idempotency|request/iu,
    );
  });

  it('returns one exact Release under concurrent retries without duplicate Registry insertion', async () => {
    const exact = fixture();
    const store = new MemoryImmutableStore();
    const repo = new MemoryReleaseRepository();
    const results = await Promise.all(
      Array.from({ length: 32 }, () =>
        publishControlledTestAgentPackage(
          { objectStore: store, repository: repo },
          {
            ownerUserId: OWNER,
            expectedPackageDigest: exact.packageDigest,
            body: exact.body,
          },
        ),
      ),
    );

    expect(new Set(results.map(({ stored }) => stored.release.releaseId))).toHaveLength(1);
    expect(results.filter(({ created }) => created)).toHaveLength(1);
    expect(repo.inserts).toBe(1);
    expect(store.values).toHaveLength(4);
  });

  it.each([
    'ownerUserId',
    'storageKey',
    'packageDigest',
    'releaseId',
    'latest',
    'priceCents',
    'knowledgePath',
    'files',
  ])('rejects forbidden client selector %s before touching storage', async (field) => {
    const exact = fixture();
    const store = new MemoryImmutableStore();
    const repo = new MemoryReleaseRepository();
    await expect(
      publishControlledTestAgentPackage(
        { objectStore: store, repository: repo },
        {
          ownerUserId: OWNER,
          expectedPackageDigest: exact.packageDigest,
          body: { ...exact.body, [field]: 'client-controlled' },
        },
      ),
    ).rejects.toMatchObject({ kind: 'validation' });
    expect(store.commits).toHaveLength(0);
  });

  it.each(['YWJjZA', 'YWJjZA==\n', 'YWJjZA-_'])(
    'rejects non-canonical base64 %s',
    (agentMarkdownBase64) => {
      const exact = fixture();
      expect(() => prepareControlledTestPackage({ ...exact.body, agentMarkdownBase64 })).toThrow(
        expect.objectContaining({ kind: 'validation' }),
      );
    },
  );

  it('rejects non-canonical agent.json and manifest/file byte drift', () => {
    const exact = fixture();
    const prettyManifest = bytes(JSON.stringify(exact.manifest, null, 2));
    expect(() =>
      prepareControlledTestPackage({ ...exact.body, agentJsonBase64: base64(prettyManifest) }),
    ).toThrow(expect.objectContaining({ kind: 'validation' }));
    expect(() =>
      prepareControlledTestPackage({
        ...exact.body,
        agentMarkdownBase64: base64(bytes('# changed exact bytes\n')),
      }),
    ).toThrow(expect.objectContaining({ kind: 'validation' }));
  });

  it('rejects an unexpected digest before writing any object', async () => {
    const exact = fixture();
    const store = new MemoryImmutableStore();
    await expect(
      publishControlledTestAgentPackage(
        { objectStore: store, repository: new MemoryReleaseRepository() },
        {
          ownerUserId: OWNER,
          expectedPackageDigest: `sha256:${'f'.repeat(64)}`,
          body: exact.body,
        },
      ),
    ).rejects.toMatchObject({ kind: 'validation' });
    expect(store.commits).toHaveLength(0);
  });

  it('does not create a database marker when object bytes conflict or exact readback drifts', async () => {
    const exact = fixture();
    const firstKey = agentPackageObjectKey(exact.packageDigest, 'AGENT.md');
    const conflictStore = new MemoryImmutableStore();
    conflictStore.values.set(firstKey, bytes('different immutable bytes'));
    const conflictRepo = new MemoryReleaseRepository();
    await expect(
      publishControlledTestAgentPackage(
        { objectStore: conflictStore, repository: conflictRepo },
        { ownerUserId: OWNER, expectedPackageDigest: exact.packageDigest, body: exact.body },
      ),
    ).rejects.toMatchObject({ kind: 'state_conflict' });
    expect(conflictRepo.inserts).toBe(0);

    const driftStore = new MemoryImmutableStore();
    driftStore.corruptReadbackKey = firstKey;
    const driftRepo = new MemoryReleaseRepository();
    await expect(
      publishControlledTestAgentPackage(
        { objectStore: driftStore, repository: driftRepo },
        { ownerUserId: OWNER, expectedPackageDigest: exact.packageDigest, body: exact.body },
      ),
    ).rejects.toMatchObject({ kind: 'state_conflict' });
    expect(driftRepo.inserts).toBe(0);
  });

  it('keeps Release reads owner-scoped and maps aborted storage without exposing keys', async () => {
    const exact = fixture();
    const repo = new MemoryReleaseRepository();
    const result = await publishControlledTestAgentPackage(
      { objectStore: new MemoryImmutableStore(), repository: repo },
      { ownerUserId: OWNER, expectedPackageDigest: exact.packageDigest, body: exact.body },
    );
    await expect(
      readControlledTestAgentPackageRelease(repo, OWNER, result.stored.release.releaseId),
    ).resolves.toEqual(result.stored);
    await expect(
      readControlledTestAgentPackageRelease(repo, OTHER_OWNER, result.stored.release.releaseId),
    ).resolves.toBeNull();

    const controller = new AbortController();
    controller.abort();
    try {
      await publishControlledTestAgentPackage(
        { objectStore: new MemoryImmutableStore(), repository: new MemoryReleaseRepository() },
        {
          ownerUserId: OWNER,
          expectedPackageDigest: exact.packageDigest,
          body: exact.body,
          signal: controller.signal,
        },
      );
      expect.fail('aborted object commit must fail closed');
    } catch (error) {
      expect(error).toMatchObject({ kind: 'unavailable' });
      expect(String(error)).not.toContain(exact.packageDigest);
      expect(String(error)).not.toContain('agent-packages/');
    }
  });
});

interface LoggedQuery {
  sql: string;
  params: unknown[];
}

function transactionFixture(input: {
  release: ReturnType<typeof createCreatorAgentPackageRelease>;
  fingerprint: string;
  existing?: boolean;
}) {
  const log: LoggedQuery[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    log.push({ sql, params });
    const normalized = sql.replace(/\s+/gu, ' ').trim();
    if (normalized.startsWith('SELECT release_id') && normalized.includes('idempotency_key')) {
      return {
        rows: input.existing
          ? [
              {
                release_id: input.release.releaseId,
                package_digest: input.release.packageDigest,
                protocol: input.release.protocol,
                release_scope: 'controlled_test',
                request_sha256: input.fingerprint,
                created_at: CREATED_AT,
              },
            ]
          : [],
        rowCount: input.existing ? 1 : 0,
      };
    }
    if (normalized.startsWith('SELECT owner_user_id')) {
      return { rows: [{ owner_user_id: OWNER, protocol: 'combo.agent-package/1' }], rowCount: 1 };
    }
    if (normalized.startsWith('INSERT INTO agent_package_releases')) {
      return {
        rows: [
          {
            release_id: input.release.releaseId,
            package_digest: input.release.packageDigest,
            protocol: input.release.protocol,
            release_scope: 'controlled_test',
            created_at: CREATED_AT,
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  };
  const connection: TxConn = {
    query: query as QueryableDb['query'],
    release: () => undefined,
  };
  const pool: TxPool = { connect: async () => connection };
  const db: Queryable = { query: query as Queryable['query'] };
  return { log, repository: new PgAgentPackageReleaseRepository(pool, db) };
}

describe('PostgreSQL Agent Package Registry repository', () => {
  it('locks before reading, inserts marker before immutable Release, and uses no mutation privilege', async () => {
    const exact = fixture();
    const fingerprint = agentPackageReleaseRequestFingerprint({
      ownerUserId: OWNER,
      idempotencyKey: IDEMPOTENCY_KEY,
      packageDigest: exact.packageDigest,
    });
    const release = createCreatorAgentPackageRelease({
      protocol: 'combo.agent-package-release/1',
      releaseId: `release.agent-package.${fingerprint.slice(0, 32)}`,
      packageDigest: exact.packageDigest,
    });
    const scripted = transactionFixture({ release, fingerprint });

    await expect(
      scripted.repository.createOrRead({
        ownerUserId: OWNER,
        idempotencyKey: IDEMPOTENCY_KEY,
        requestFingerprint: fingerprint,
        release,
      }),
    ).resolves.toMatchObject({ created: true, stored: { release } });

    const statements = scripted.log.map(({ sql }) => sql.replace(/\s+/gu, ' ').trim());
    expect(statements[0]).toBe('BEGIN');
    expect(statements[1]).toContain('pg_advisory_xact_lock');
    expect(
      statements.findIndex((sql) => sql.startsWith('INSERT INTO agent_packages')),
    ).toBeLessThan(
      statements.findIndex((sql) => sql.startsWith('INSERT INTO agent_package_releases')),
    );
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements.join('\n')).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE)\b/u);
    expect(statements.join('\n')).not.toContain('agent_releases');
    expect(statements.join('\n')).not.toContain(OWNER);
    expect(statements.join('\n')).not.toContain(exact.packageDigest);
  });

  it('replays a matching owner/idempotency row without another insert', async () => {
    const exact = fixture();
    const fingerprint = agentPackageReleaseRequestFingerprint({
      ownerUserId: OWNER,
      idempotencyKey: IDEMPOTENCY_KEY,
      packageDigest: exact.packageDigest,
    });
    const release = createCreatorAgentPackageRelease({
      protocol: 'combo.agent-package-release/1',
      releaseId: `release.agent-package.${fingerprint.slice(0, 32)}`,
      packageDigest: exact.packageDigest,
    });
    const scripted = transactionFixture({ release, fingerprint, existing: true });
    await expect(
      scripted.repository.createOrRead({
        ownerUserId: OWNER,
        idempotencyKey: IDEMPOTENCY_KEY,
        requestFingerprint: fingerprint,
        release,
      }),
    ).resolves.toMatchObject({ created: false, stored: { release } });
    expect(scripted.log.map(({ sql }) => sql).join('\n')).not.toContain('INSERT INTO');
  });

  it('turns a reused idempotency key with a different request into a rollback conflict', async () => {
    const exact = fixture();
    const release = createCreatorAgentPackageRelease({
      protocol: 'combo.agent-package-release/1',
      releaseId: `release.agent-package.${'a'.repeat(32)}`,
      packageDigest: exact.packageDigest,
    });
    const scripted = transactionFixture({ release, fingerprint: 'b'.repeat(64), existing: true });
    await expect(
      scripted.repository.createOrRead({
        ownerUserId: OWNER,
        idempotencyKey: IDEMPOTENCY_KEY,
        requestFingerprint: 'c'.repeat(64),
        release,
      }),
    ).rejects.toMatchObject({ kind: 'idempotency_conflict' });
    expect(scripted.log.map(({ sql }) => sql.trim()).at(-1)).toBe('ROLLBACK');
  });
});
