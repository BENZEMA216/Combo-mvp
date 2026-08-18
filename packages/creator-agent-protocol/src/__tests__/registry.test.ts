import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv, type AnySchema } from 'ajv';
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

function extractArchitectureDecisionCatalog(markdown: string): Array<{
  architectureDecisionId: string;
  architectureDecisionSummary: string;
}> {
  const section = markdown.match(/^## 25\. ADR 清单\n([\s\S]*?)^---$/mu)?.[1];
  if (section === undefined) throw new Error('frozen architecture mirror missing §25 ADR catalog');
  return [...section.matchAll(/^\| (D\d{3}) \| (.+) \|$/gmu)].map((match) => ({
    architectureDecisionId: match[1]!,
    architectureDecisionSummary: match[2]!,
  }));
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
  it('parses exactly 25 invariants, 34 decisions, field-level data-flow locations and 66 cases', async () => {
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
    expect(decisions.decisions).toHaveLength(34);
    expect(allowlist.fields.length).toBeGreaterThanOrEqual(18);
    expect(cases).toHaveLength(66);
    expect(new Set(cases.map((testCase) => testCase.id)).size).toBe(66);
  });

  it('maps ADR-VNEXT-021..032 bidirectionally to frozen architecture D001..D012', async () => {
    const architecture = await readFile(frozenPlanMirrors[0].path, 'utf8');
    const frozenCatalog = extractArchitectureDecisionCatalog(architecture);
    expect(frozenCatalog).toHaveLength(12);

    const rawRegistry = (await readYaml(join(vnextDirectory, 'decisions.yaml'))) as {
      decisions: Array<Record<string, unknown>>;
    };
    const registry = DecisionRegistrySchema.parse(rawRegistry);
    const mappedCatalog = registry.decisions.slice(20, 32).map((decision, index) => {
      if (!('architectureDecisionId' in decision)) {
        throw new Error(`${decision.id} missing architecture decision mapping`);
      }
      expect(decision.id).toBe(`ADR-VNEXT-${String(index + 21).padStart(3, '0')}`);
      return {
        architectureDecisionId: decision.architectureDecisionId,
        architectureDecisionSummary: decision.architectureDecisionSummary,
      };
    });
    expect(mappedCatalog).toEqual(frozenCatalog);
    for (const decision of [...registry.decisions.slice(0, 20), ...registry.decisions.slice(32)]) {
      expect('architectureDecisionId' in decision, decision.id).toBe(false);
      expect('architectureDecisionSummary' in decision, decision.id).toBe(false);
    }

    const legacyWithMapping = structuredClone(rawRegistry);
    legacyWithMapping.decisions[0]!.architectureDecisionId = 'D001';
    legacyWithMapping.decisions[0]!.architectureDecisionSummary =
      frozenCatalog[0]!.architectureDecisionSummary;
    expect(DecisionRegistrySchema.safeParse(legacyWithMapping).success).toBe(false);

    const missingSummary = structuredClone(rawRegistry);
    delete missingSummary.decisions[20]!.architectureDecisionSummary;
    expect(DecisionRegistrySchema.safeParse(missingSummary).success).toBe(false);

    const duplicateMapping = structuredClone(rawRegistry);
    duplicateMapping.decisions[21]!.architectureDecisionId = 'D001';
    expect(DecisionRegistrySchema.safeParse(duplicateMapping).success).toBe(false);

    const contractBundle = JSON.parse(
      await readFile(
        join(
          repositoryRoot,
          'packages',
          'creator-agent-protocol',
          'schemas',
          'contract-schemas.v1.json',
        ),
        'utf8',
      ),
    ) as { schemas: Record<string, unknown> };
    const validateAdvertised = new Ajv({
      allErrors: true,
      strict: false,
      validateFormats: false,
    }).compile(contractBundle.schemas.DecisionRegistry as AnySchema);
    expect(validateAdvertised(rawRegistry)).toBe(true);
    const oversizedArchitectureTitle = structuredClone(rawRegistry);
    oversizedArchitectureTitle.decisions[20]!.title = '😀'.repeat(257);
    expect(DecisionRegistrySchema.safeParse(oversizedArchitectureTitle).success).toBe(false);
    expect(validateAdvertised(oversizedArchitectureTitle)).toBe(false);
    expect(
      validateAdvertised.errors?.some(
        ({ instancePath, keyword }) =>
          instancePath === '/decisions/20/title' && keyword === 'maxLength',
      ),
    ).toBe(true);
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

  it('binds Gate 0 resource and no-native-fallback traceability explicitly', async () => {
    const invariantRegistry = InvariantRegistrySchema.parse(
      await readYaml(join(vnextDirectory, 'invariants.yaml')),
    );
    expect(invariantRegistry.invariants.find(({ id }) => id === 'INV-024')?.gates).toEqual([
      'G0',
      'G1',
      'G2',
      'G3',
      'G4',
      'G7',
    ]);
    const cases = (await readCaseRegistries()).flatMap((registry) => registry.cases);
    expect(cases.find(({ id }) => id === 'SCH-004')?.invariants).toEqual([
      'INV-001',
      'INV-002',
      'INV-024',
    ]);
    expect(cases.find(({ id }) => id === 'SCH-004')?.implementation).toEqual({
      status: 'implemented',
      testFiles: [
        'packages/creator-agent-protocol/src/__tests__/public-boundary-closure.test.ts',
        'packages/creator-agent-protocol/src/__tests__/public-boundary-row-probes.test.ts',
        'packages/creator-agent-protocol/src/__tests__/public-boundary-actual-roots.test.ts',
        'packages/creator-agent-protocol/src/__tests__/public-string-pattern-census.test.ts',
        'packages/creator-agent-protocol/src/__tests__/public-source-ast-census.test.ts',
        'packages/creator-agent-protocol/src/__tests__/publication-marker-byte-boundaries.test.ts',
        'packages/creator-agent-snapshot/src/__tests__/manifest-canonical-byte-maximum.test.ts',
      ],
    });
    expect(cases.find(({ id }) => id === 'SCH-005')?.invariants).toEqual(['INV-002', 'INV-019']);
    expect(cases.find(({ id }) => id === 'SCH-005')).toMatchObject({
      implementation: {
        status: 'implemented',
        testFiles: expect.arrayContaining([
          'packages/creator-agent-protocol/src/__tests__/sch-005-closure.test.ts',
          'apps/runtime/src/platform/http/vnext-json-body.test.ts',
        ]),
      },
      fixture: expect.arrayContaining([
        'packages/creator-agent-protocol/fixtures/protocol-raw-ingress-hostile-boundaries.v1.json',
        'packages/creator-agent-protocol/fixtures/snapshot-path-boundaries.v1.json',
      ]),
      fixtureDigests: expect.arrayContaining([
        'sha256:dbd9c91121898efe37d36cf6f1bdf06cdc1a47d2209058695d86d2d25b022bab',
      ]),
    });
    expect(cases.find(({ id }) => id === 'SCH-005')?.implementation.testFiles).toEqual([
      'packages/creator-agent-protocol/src/__tests__/sch-005-closure.test.ts',
      'packages/creator-agent-protocol/src/__tests__/utf8-boundaries.test.ts',
      'packages/creator-agent-protocol/src/__tests__/structural-boundaries.test.ts',
      'packages/creator-agent-protocol/src/__tests__/wire-boundaries.test.ts',
      'packages/creator-agent-protocol/src/__tests__/raw-ingress-hostile-boundaries.test.ts',
      'packages/creator-agent-protocol/src/__tests__/snapshot-path-boundaries.test.ts',
      'packages/creator-agent-snapshot/src/__tests__/path-boundaries.test.ts',
      'apps/runtime/src/platform/http/vnext-json-body.test.ts',
      'apps/runtime/src/modules/creator-agent-conversation/routes.integration.test.ts',
    ]);
    expect(cases.find(({ id }) => id === 'SNP-010')).toMatchObject({
      implementation: { status: 'planned', testFiles: [] },
      fixture: expect.arrayContaining([
        'packages/creator-agent-protocol/fixtures/protocol-raw-ingress-hostile-boundaries.v1.json',
      ]),
      fixtureDigests: expect.arrayContaining([
        'sha256:dbd9c91121898efe37d36cf6f1bdf06cdc1a47d2209058695d86d2d25b022bab',
      ]),
    });
    expect(cases.find(({ id }) => id === 'SNP-008')).toEqual(
      expect.objectContaining({
        fixture: [
          'packages/creator-agent-protocol/fixtures/snapshot-compressed-exact-boundary.v1.json',
        ],
        implementation: {
          status: 'implemented',
          testFiles: [
            'packages/creator-agent-snapshot/src/__tests__/compressed-exact-boundary.test.ts',
          ],
        },
        fixtureDigests: ['sha256:3a95d99be3cb60d68b80e2fd1b829baadfb71e2f064704cdf6d6362ce583794e'],
      }),
    );
    expect(cases.find(({ id }) => id === 'SCH-010')?.invariants).toEqual([
      'INV-001',
      'INV-002',
      'INV-021',
    ]);
    expect(cases.find(({ id }) => id === 'SCH-009')?.implementation).toMatchObject({
      status: 'implemented',
      testFiles: ['apps/agent-gateway/src/compatibility.test.ts'],
    });
    expect(cases.find(({ id }) => id === 'SCH-010')?.implementation).toMatchObject({
      status: 'implemented',
      testFiles: expect.arrayContaining([
        'apps/agent-gateway/src/compatibility.test.ts',
        'packages/creator-worker-broker-client/src/postgres-sqlite-vertical.pg.test.ts',
      ]),
    });
  });

  it('binds only the implemented AgentVersion digest semantics to their exact corpus', async () => {
    const cases = (await readCaseRegistries()).flatMap((registry) => registry.cases);
    const fixture =
      'packages/creator-agent-protocol/fixtures/agent-version-digest-semantics.v1.json';
    const testFile =
      'packages/creator-agent-snapshot/src/__tests__/agent-version-digest-semantics.test.ts';
    const digest = 'sha256:b6ee748468b35c06bc2d319970bc781c73d1c9f3671fc0204be9977c8c62c6a9';
    for (const id of ['AVR-001', 'AVR-003', 'AVR-004', 'AVR-006']) {
      expect(
        cases.find((testCase) => testCase.id === id),
        id,
      ).toMatchObject({
        fixture: [fixture],
        implementation: { status: 'implemented', testFiles: [testFile] },
        fixtureDigests: [digest],
      });
    }
    const displayPolicyTestFile =
      'packages/creator-agent-snapshot/src/__tests__/agent-version-display-and-policy.test.ts';
    for (const id of ['AVR-002', 'AVR-005']) {
      expect(
        cases.find((testCase) => testCase.id === id),
        id,
      ).toMatchObject({
        fixture: [fixture],
        implementation: { status: 'implemented', testFiles: [displayPolicyTestFile] },
        fixtureDigests: [digest],
      });
    }
    for (const id of ['AVR-007', 'AVR-008', 'AVR-009']) {
      expect(cases.find((testCase) => testCase.id === id)?.implementation, id).toEqual({
        status: 'planned',
        testFiles: [],
      });
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
      if ('architectureDecisionId' in decision) {
        expect(document).toContain(
          `- Architecture decision: ${decision.architectureDecisionId} — ${decision.architectureDecisionSummary}`,
        );
      } else {
        expect(document).not.toContain('- Architecture decision:');
      }
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
    expect(
      (await readdir(join(repositoryRoot, 'docs', 'vnext', 'adr'))).filter((name) =>
        /^ADR-VNEXT-\d{3}\.md$/u.test(name),
      ),
    ).toHaveLength(34);

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
