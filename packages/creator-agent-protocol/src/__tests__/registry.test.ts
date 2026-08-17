import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { currentBrokerContractDigest } from '../artifacts.js';
import { canonicalSha256 } from '../canonical.js';
import {
  BrokerContractRegistrySchema,
  DataFlowAllowlistSchema,
  decideDataFlowObservation,
  DecisionRegistrySchema,
  InvariantRegistrySchema,
  TestCaseRegistrySchema,
  parseVnextRegistryYaml,
  type TestCaseRegistry,
} from '../registry.js';
import { SnapshotArchiveEnvelopeSchema, SnapshotManifestEnvelopeSchema } from '../snapshot.js';
import { readFixture } from './fixture-helpers.js';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const vnextDirectory = join(repositoryRoot, 'tests', 'vnext');
const testPlanPath = join(
  repositoryRoot,
  'docs',
  'vnext',
  'creator-hosted-agent-vnext-test-plan.md',
);
const frozenPlanMirrors = [
  {
    path: join(repositoryRoot, 'docs', 'vnext', 'creator-hosted-agent-vnext-architecture.md'),
    sourceSha256: '523b4637733b505570d091633f5aecca979c6ca3b344f1dcaec2c0f6487c09b8',
  },
  {
    path: testPlanPath,
    sourceSha256: 'b548c9d9d05fa912de19e4cde053222ea08fdb04f326f368bf12ade614be9404',
  },
] as const;

async function readYaml(path: string): Promise<unknown> {
  return parseVnextRegistryYaml(await readFile(path, 'utf8'));
}

async function readCaseRegistries(): Promise<TestCaseRegistry[]> {
  const directory = join(vnextDirectory, 'cases');
  const files = (await readdir(directory)).filter((name) => name.endsWith('.yaml')).sort();
  return Promise.all(
    files.map(async (file) => TestCaseRegistrySchema.parse(await readYaml(join(directory, file)))),
  );
}

const sha256Digest = (bytes: Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

describe('VNext machine-readable contract registries', () => {
  it('keeps both repository plan mirrors byte-exact with their frozen authority digests', async () => {
    const readme = await readFile(join(repositoryRoot, 'docs', 'vnext', 'README.md'), 'utf8');
    for (const mirror of frozenPlanMirrors) {
      const digest = createHash('sha256')
        .update(await readFile(mirror.path))
        .digest('hex');
      expect(digest, mirror.path).toBe(mirror.sourceSha256);
      expect(readme).toContain(`来源 SHA-256：\`${mirror.sourceSha256}\``);
    }
  });

  it('binds the broker registry to the exact standalone JCS contract artifact', async () => {
    const registry = BrokerContractRegistrySchema.parse(
      await readYaml(join(vnextDirectory, 'registries.yaml')),
    );
    const contract = registry.contracts[0];
    const artifact = JSON.parse(
      await readFile(join(repositoryRoot, contract.artifactPath), 'utf8'),
    ) as unknown;

    expect(contract.contractDigest).toBe(currentBrokerContractDigest());
    expect(contract.contractDigest).toBe(`sha256:${canonicalSha256(artifact)}`);
  });
  it('parses exactly 25 invariants, 20 decisions, field-level data-flow locations and 66 cases', async () => {
    const invariants = InvariantRegistrySchema.parse(
      await readYaml(join(vnextDirectory, 'invariants.yaml')),
    );
    const decisions = DecisionRegistrySchema.parse(
      await readYaml(join(vnextDirectory, 'decisions.yaml')),
    );
    const allowlist = DataFlowAllowlistSchema.parse(
      await readYaml(join(vnextDirectory, 'data-flow-allowlist.yaml')),
    );
    const cases = (await readCaseRegistries()).flatMap((registry) => registry.cases);

    expect(invariants.invariants).toHaveLength(25);
    expect(decisions.decisions).toHaveLength(20);
    expect(allowlist.fields.length).toBeGreaterThanOrEqual(18);
    expect(cases).toHaveLength(66);
    expect(new Set(cases.map((testCase) => testCase.id)).size).toBe(66);
  });

  it('counts structural registry text limits in Unicode code points', async () => {
    const input = (await readYaml(join(vnextDirectory, 'invariants.yaml'))) as {
      invariants: Array<{ statement: string; owners: string[] }>;
    };
    const exactStatement = structuredClone(input);
    exactStatement.invariants[0]!.statement = '😀'.repeat(1_024);
    expect(InvariantRegistrySchema.safeParse(exactStatement).success).toBe(true);

    const oversizedStatement = structuredClone(input);
    oversizedStatement.invariants[0]!.statement = '😀'.repeat(1_025);
    expect(InvariantRegistrySchema.safeParse(oversizedStatement).success).toBe(false);

    const exactOwner = structuredClone(input);
    exactOwner.invariants[0]!.owners = ['😀'.repeat(64)];
    expect(InvariantRegistrySchema.safeParse(exactOwner).success).toBe(true);

    const oversizedOwner = structuredClone(input);
    oversizedOwner.invariants[0]!.owners = ['😀'.repeat(65)];
    expect(InvariantRegistrySchema.safeParse(oversizedOwner).success).toBe(false);
  });

  it('keeps test-plan IDs, registry IDs and invariant references bidirectionally exact', async () => {
    const plan = await readFile(testPlanPath, 'utf8');
    const documentedIds = [...plan.matchAll(/`((?:SCH|SNP|AVR|DEP|BRK|FLT)-[A-Z0-9-]+)`/gu)]
      .map((match) => match[1]!)
      .filter((id, index, ids) => ids.indexOf(id) === index)
      .sort();
    const registries = await readCaseRegistries();
    const cases = registries.flatMap((registry) => registry.cases);
    const registeredIds = cases.map((testCase) => testCase.id).sort();
    expect(documentedIds).toEqual(registeredIds);

    const invariantRegistry = InvariantRegistrySchema.parse(
      await readYaml(join(vnextDirectory, 'invariants.yaml')),
    );
    const invariantIds = new Set(invariantRegistry.invariants.map((invariant) => invariant.id));
    for (const testCase of cases) {
      for (const invariantId of testCase.invariants) {
        expect(invariantIds.has(invariantId), `${testCase.id} -> ${invariantId}`).toBe(true);
      }
    }
  });

  it('requires implemented cases to name real tests containing the case ID and exact fixtures', async () => {
    const cases = (await readCaseRegistries()).flatMap((registry) => registry.cases);
    const implemented = cases.filter(
      (testCase) => testCase.implementation.status === 'implemented',
    );
    expect(implemented.length).toBeGreaterThan(0);

    for (const testCase of implemented) {
      for (const testFile of testCase.implementation.testFiles) {
        const source = await readFile(join(repositoryRoot, testFile), 'utf8');
        expect(source, `${testCase.id} missing marker in ${testFile}`).toContain(testCase.id);
      }
      for (const [index, fixture] of testCase.fixture.entries()) {
        const bytes = await readFile(join(repositoryRoot, fixture));
        expect(sha256Digest(bytes), `${testCase.id} fixture ${fixture}`).toBe(
          testCase.fixtureDigests[index],
        );
      }
    }
  });

  it('keeps every ADR document generated with all review sections and freezes RLS roles', async () => {
    const registry = DecisionRegistrySchema.parse(
      await readYaml(join(vnextDirectory, 'decisions.yaml')),
    );
    for (const decision of registry.decisions) {
      const document = await readFile(join(repositoryRoot, decision.document), 'utf8');
      expect(document).toContain(`# ${decision.id}: ${decision.title}`);
      expect(document).toContain(`- Owner: ${decision.owner}`);
      expect(document).toContain(`- Decision date: ${decision.decidedAt}`);
      for (const heading of [
        '## Decision',
        '## Alternatives considered',
        '## Evidence',
        '## Privacy and security impact',
        '## Reversal triggers',
        '## Affected protocol versions',
      ]) {
        expect(document, `${decision.id} missing ${heading}`).toContain(heading);
      }
    }

    const databaseDecision = registry.decisions.find(
      (decision) => decision.id === 'ADR-VNEXT-018',
    )!;
    for (const required of [
      'FORCE RLS',
      'SET LOCAL app.creator_id/app.consumer_id',
      'combo_agent_api',
      'combo_agent_broker',
      'combo_agent_reconciler',
      'combo_agent_migrator',
      'combo_agent_maintenance',
      'NOBYPASSRLS',
    ]) {
      expect(databaseDecision.decision).toContain(required);
    }
  });

  it('makes every Prompt/Answer/Context field location exact and treats unlisted locations as leaks', async () => {
    const allowlist = DataFlowAllowlistSchema.parse(
      await readYaml(join(vnextDirectory, 'data-flow-allowlist.yaml')),
    );
    expect(allowlist.unlistedLocationDisposition).toBe('SECURITY_LEAK');
    expect(allowlist.globallyForbiddenDataClasses).toEqual([
      'absolute-path',
      'credential',
      'reasoning',
    ]);
    expect(new Set(allowlist.fields.map((field) => field.fieldClass))).toEqual(
      new Set(['prompt', 'answer', 'context']),
    );
    expect(
      allowlist.fields.some(
        (field) =>
          field.system === 'postgresql' &&
          field.container === 'agent_messages' &&
          field.field === 'content_ciphertext',
      ),
    ).toBe(true);
    const localPrompt = allowlist.fields.find(
      (field) => field.fieldId === 'prompt.worker-sqlite.local-invocations-prompt-ciphertext',
    );
    expect(localPrompt).toMatchObject({
      fieldClass: 'prompt',
      contentKind: 'real',
      system: 'worker-sqlite',
      container: 'local_invocations',
      field: 'prompt_ciphertext',
      protection: 'application-aead',
      algorithm: 'aes-256-gcm/v1',
      keyOwner: 'worker-keychain',
      aadBindings: [
        'agentVersionDigest',
        'conversationId',
        'installationId',
        'invocationId',
        'role',
        'schemaVersion',
      ],
      retention: 'request-lifetime',
    });
    if (localPrompt === undefined) throw new Error('missing local prompt data-flow authority');
    const {
      fieldId: _localPromptId,
      retention: _localPromptRetention,
      deletionOrHold: _localPromptDeletion,
      ...localPromptObservation
    } = localPrompt;
    expect(
      decideDataFlowObservation({ ...localPromptObservation, system: 'worker-backup' }, allowlist),
    ).toEqual({ decision: 'SECURITY_LEAK' });
    expect(
      allowlist.fields.some(
        (field) =>
          field.system === 'worker-sqlite' &&
          field.container === 'local_invocations' &&
          field.field === 'result_ciphertext' &&
          field.keyOwner === 'worker-keychain',
      ),
    ).toBe(true);
    expect(
      allowlist.fields
        .filter((field) => field.system === 'evidence-vault')
        .every(
          (field) =>
            field.contentKind === 'synthetic-test-only' &&
            field.keyOwner === 'independent-test-kek',
        ),
    ).toBe(true);

    const snapshotEnvelope = SnapshotArchiveEnvelopeSchema.parse(
      await readFixture('snapshot-envelope.v1.json'),
    );
    const authoritativeArchiveAadBindings = [
      'archiveDigest',
      'cipherObjectFormat',
      'creatorId',
      'keyId',
      'objectKey',
      'plaintextBytes',
      'protocol',
      'schemaVersion',
      'snapshotDigest',
    ];
    expect(Object.keys(snapshotEnvelope.aad).sort()).toEqual(authoritativeArchiveAadBindings);
    const manifestEnvelope = SnapshotManifestEnvelopeSchema.parse(
      await readFixture('snapshot-manifest-envelope.v1.json'),
    );
    const authoritativeManifestAadBindings = [
      'cipherObjectFormat',
      'creatorId',
      'keyId',
      'objectKey',
      'plaintextBytes',
      'protocol',
      'schemaVersion',
      'snapshotDigest',
    ];
    expect(Object.keys(manifestEnvelope.aad).sort()).toEqual(authoritativeManifestAadBindings);

    for (const system of ['minio', 'minio-backup'] as const) {
      const archiveCipher = allowlist.fields.find(
        (field) =>
          field.system === system &&
          field.fieldId === `context.${system}.context-snapshot-archive-cipher-object`,
      );
      const manifestCipher = allowlist.fields.find(
        (field) =>
          field.system === system &&
          field.fieldId === `context.${system}.context-snapshot-manifest-cipher-object`,
      );
      expect(archiveCipher?.aadBindings).toEqual(authoritativeArchiveAadBindings);
      expect(manifestCipher?.aadBindings).toEqual(authoritativeManifestAadBindings);
      expect(archiveCipher?.aadBindings).not.toContain('agentVersionDigest');
      expect(manifestCipher?.aadBindings).not.toContain('agentVersionDigest');

      const preparationMarker = allowlist.fields.find(
        (field) =>
          field.system === system &&
          field.fieldId === `context.${system}.context-snapshot-publication-preparation-marker`,
      );
      const commitMarker = allowlist.fields.find(
        (field) =>
          field.system === system &&
          field.fieldId === `context.${system}.context-snapshot-publication-commit-marker`,
      );
      expect(preparationMarker).toMatchObject({
        protection: 'wrapped-key-envelope-metadata',
        algorithm: 'rfc3394-aes-256-kw/v1',
        keyOwner: 'combo-kms',
      });
      expect(preparationMarker?.deletionOrHold).toContain('wrapped DEK');
      expect(commitMarker).toMatchObject({
        protection: 'digest-linked-metadata',
        algorithm: 'sha-256/v1',
        keyOwner: 'none',
        aadBindings: [],
      });
    }

    const known = allowlist.fields[0]!;
    const { fieldId: _id, retention: _retention, deletionOrHold: _hold, ...observation } = known;
    expect(decideDataFlowObservation(observation, allowlist)).toEqual({
      decision: 'ALLOWED',
      fieldId: known.fieldId,
    });
    expect(
      decideDataFlowObservation(
        { ...observation, field: `${observation.field}-unlisted` },
        allowlist,
      ),
    ).toEqual({ decision: 'SECURITY_LEAK' });
    expect(
      decideDataFlowObservation(
        { ...observation, container: 'generic-encrypted-content-column' },
        allowlist,
      ),
    ).toEqual({ decision: 'SECURITY_LEAK' });
  });

  it('rejects duplicate set-like registry values instead of inflating evidence', async () => {
    const invariantRegistry = InvariantRegistrySchema.parse(
      await readYaml(join(vnextDirectory, 'invariants.yaml')),
    );
    expect(
      InvariantRegistrySchema.safeParse({
        ...invariantRegistry,
        invariants: invariantRegistry.invariants.map((invariant, index) =>
          index === 0
            ? { ...invariant, gates: [...invariant.gates, invariant.gates[0]!] }
            : invariant,
        ),
      }).success,
    ).toBe(false);

    const cases = await readCaseRegistries();
    expect(
      TestCaseRegistrySchema.safeParse({
        ...cases[0],
        cases: cases[0]!.cases.map((testCase, index) =>
          index === 0
            ? { ...testCase, releaseTuple: [...testCase.releaseTuple, testCase.releaseTuple[0]!] }
            : testCase,
        ),
      }).success,
    ).toBe(false);
  });
});
