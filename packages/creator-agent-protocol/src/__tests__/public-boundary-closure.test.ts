import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { createJsonSchemaBundle } from '../artifacts.js';
import {
  EVIDENCE_MAX_CLOUD_IMAGE_DIGEST_PROPERTIES,
  EVIDENCE_MAX_RUNTIME_VERSION_PROPERTIES,
  EvidenceBundleManifestSchema,
  EvidenceEnvironmentSchema,
  EvidenceReleaseTupleSchema,
  evidenceReleaseTupleFromManifest,
} from '../evidence.js';
import {
  PUBLIC_BOUNDARY_MANUAL_CAPS,
  PUBLIC_BOUNDARY_SOURCE_AST_CENSUS,
  PUBLIC_BOUNDARY_CLOSURE_AUTHORITY,
  PUBLIC_BOUNDARY_CLOSURE_PROTOCOL,
  PublicBoundaryClosureCorpusSchema,
  artifactDigest,
  collectPublicArtifactBoundaryRows,
  collectPublicSourceBoundaryRows,
  type PublicBoundaryClosureCorpus,
} from '../public-boundary-closure.js';
import {
  PUBLIC_MANUAL_CAP_OUTCOME_FIXTURE_PATH,
  PublicManualCapOutcomeFixtureSchema,
  assertPublicManualCapOutcomeSubset,
  expectedPublicManualCapOutcomeRows,
} from '../public-manual-cap-outcomes.js';
import {
  collectPublicStringLengthRows,
  collectPublicStringPatternRows,
} from '../public-string-pattern-census.js';
import {
  VNEXT_REGISTRY_YAML_LIBRARY_MAX_ALIAS_COUNT,
  VNEXT_REGISTRY_YAML_MAX_ALIAS_EXPANSIONS,
  parseVnextRegistryYaml,
} from '../registry.js';

const fixtureUrl = new URL('../../fixtures/public-boundary-closure.v1.json', import.meta.url);
const manualOutcomeFixtureUrl = new URL(
  '../../fixtures/public-manual-cap-outcomes.v1.json',
  import.meta.url,
);
const fixtureDirectoryUrl = new URL('../../fixtures/', import.meta.url);
const artifactUrls = {
  contractSchemas: new URL('../../schemas/contract-schemas.v1.json', import.meta.url),
  brokerContract: new URL('../../schemas/broker-contract.v1.json', import.meta.url),
  openApi: new URL('../../openapi/creator-agent-v1.openapi.json', import.meta.url),
} as const;
const delegatedFixtures = [
  ['protocol-utf8-boundaries.v1.json', 'utf8-boundaries.test.ts'],
  ['protocol-decoded-boundaries.v1.json', 'decoded-boundaries.test.ts'],
  ['protocol-structural-boundaries.v1.json', 'structural-boundaries.test.ts'],
  ['http-idempotency-key-boundaries.v1.json', 'http-idempotency-key-boundaries.test.ts'],
  ['agent-version-resource-boundaries.v1.json', 'resource-boundaries.test.ts'],
  ['broker-capacity-boundaries.v1.json', 'broker-capacity-boundaries.test.ts'],
  [
    'context-tools-closed-world-boundaries.v1.json',
    'context-tools-closed-world-boundaries.test.ts',
  ],
  [
    'execution-capability-upstream-count-boundaries.v1.json',
    'execution-capability-upstream-count-boundaries.test.ts',
  ],
  ['snapshot-resource-boundaries.v1.json', 'snapshot-resource-boundaries.test.ts'],
  ['snapshot-single-file-boundaries.v1.json', 'snapshot-single-file-boundaries.test.ts'],
  ['snapshot-compressed-boundaries.v1.json', 'snapshot-compressed-boundaries.test.ts'],
  [
    'snapshot-compression-ratio-boundaries.v1.json',
    'snapshot-compression-ratio-boundaries.test.ts',
  ],
  ['snapshot-path-boundaries.v1.json', 'snapshot-path-boundaries.test.ts'],
  ['protocol-wire-boundaries.v1.json', 'wire-boundaries.test.ts'],
] as const;

async function createClosureCorpus(): Promise<PublicBoundaryClosureCorpus> {
  const artifactEntries = await Promise.all(
    Object.entries(artifactUrls).map(async ([name, url]) => {
      const bytes = await readFile(url);
      return [name, bytes, JSON.parse(bytes.toString('utf8'))] as const;
    }),
  );
  const documents = Object.fromEntries(
    artifactEntries.map(([name, _bytes, document]) => [name, document]),
  ) as Record<keyof typeof artifactUrls, unknown>;
  const checkedArtifactDigests = Object.fromEntries(
    artifactEntries.map(([name, bytes]) => [name, artifactDigest(bytes)]),
  ) as Record<keyof typeof artifactUrls, `sha256:${string}`>;
  const delegatedFixtureRows = await Promise.all(
    delegatedFixtures.map(async ([path, testFile]) => ({
      path: `packages/creator-agent-protocol/fixtures/${path}`,
      digest: artifactDigest(await readFile(new URL(path, fixtureDirectoryUrl))),
      testFiles: [`packages/creator-agent-protocol/src/__tests__/${testFile}`],
    })),
  );
  const manualOutcomeBytes = await readFile(manualOutcomeFixtureUrl);
  return PublicBoundaryClosureCorpusSchema.parse({
    protocol: PUBLIC_BOUNDARY_CLOSURE_PROTOCOL,
    schemaVersion: 1,
    authority: PUBLIC_BOUNDARY_CLOSURE_AUTHORITY,
    status: 'implemented',
    checkedArtifactDigests,
    sourceRows: collectPublicSourceBoundaryRows(),
    artifactRows: collectPublicArtifactBoundaryRows(documents),
    manualCaps: PUBLIC_BOUNDARY_MANUAL_CAPS,
    manualOutcomeFixture: {
      path: PUBLIC_MANUAL_CAP_OUTCOME_FIXTURE_PATH,
      digest: artifactDigest(manualOutcomeBytes),
    },
    delegatedFixtures: delegatedFixtureRows,
    sourceAstCensus: PUBLIC_BOUNDARY_SOURCE_AST_CENSUS,
    remainingBoundaryClasses: [],
    requiredExternalEvidence: [
      {
        environment: 'T0-LINUX-CI',
        status: 'NOT_RUN',
        command: 'pnpm vnext:test:g0',
        binding: 'clean-source-sha-and-workflow-run-required',
      },
    ],
    nonClaims: [
      'does-not-prove-formal-t0-linux-pass',
      'does-not-complete-snp-008',
      'does-not-prove-transport-storage-or-production',
    ],
  });
}

function digestMap(size: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: size }, (_unused, index) => [
      `image-${index.toString().padStart(3, '0')}`,
      `sha256:${index.toString(16).padStart(64, '0')}`,
    ]),
  );
}

function runtimeVersionMap(size: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: size }, (_unused, index) => [
      `runtime-${index.toString().padStart(3, '0')}`,
      `version-${index.toString().padStart(3, '0')}`,
    ]),
  );
}

function lookupPointer(document: unknown, pointer: string): Record<string, unknown> {
  let current = document;
  for (const segment of pointer
    .slice(1)
    .split('/')
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (current === null || typeof current !== 'object' || !(segment in current)) {
      throw new Error(`PUBLIC_BOUNDARY_POINTER_MISSING:${pointer}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === null || typeof current !== 'object') {
    throw new Error(`PUBLIC_BOUNDARY_POINTER_NOT_OBJECT:${pointer}`);
  }
  return current as Record<string, unknown>;
}

function aliasYaml(count: number): string {
  return `base: &base value\nitems:\n${Array.from({ length: count }, () => '  - *base').join('\n')}\n`;
}

describe('SCH-004 digest-bound public boundary closure', () => {
  it('pins every discovered source and generated-artifact physical row', async () => {
    const actual = await createClosureCorpus();
    if (process.env.PRINT_PUBLIC_BOUNDARY_CLOSURE === '1') {
      process.stdout.write(`PUBLIC_BOUNDARY_CLOSURE_FIXTURE\n${JSON.stringify(actual, null, 2)}\n`);
      expect(actual.sourceRows.length).toBeGreaterThan(0);
      expect(actual.artifactRows.length).toBeGreaterThan(0);
      return;
    }
    const expected = PublicBoundaryClosureCorpusSchema.parse(
      JSON.parse(await readFile(fixtureUrl, 'utf8')),
    );
    expect(actual).toEqual(expected);
  });

  it('binds every string pattern and length row to the actual Zod string census exactly once', () => {
    const sourceRows = collectPublicSourceBoundaryRows();
    const patternRows = sourceRows.filter(({ id }) =>
      /:string-(?:regex|uuid|url|datetime|email)-\d+$/u.test(id),
    );
    const lengthRows = sourceRows.filter(({ id }) => /:string-(?:max|length)-\d+$/u.test(id));
    expect(collectPublicStringPatternRows().map(({ id }) => id)).toEqual(
      patternRows.map(({ id }) => id),
    );
    expect(collectPublicStringLengthRows().map(({ id }) => id)).toEqual(
      lengthRows.map(({ id }) => id),
    );
    for (const row of patternRows) {
      expect(row.evidence).toMatchObject({
        status: 'covered',
        probeId: `public-string-pattern:${row.id}`,
        testFile:
          'packages/creator-agent-protocol/src/__tests__/public-string-pattern-census.test.ts',
      });
    }
  });

  it('binds every manual cap to exact outcomes and a concrete test owner', () => {
    expect(new Set(PUBLIC_BOUNDARY_MANUAL_CAPS.map(({ id }) => id)).size).toBe(
      PUBLIC_BOUNDARY_MANUAL_CAPS.length,
    );
    expect(new Set(PUBLIC_BOUNDARY_MANUAL_CAPS.map(({ evidence }) => evidence.probeId)).size).toBe(
      PUBLIC_BOUNDARY_MANUAL_CAPS.length,
    );
    for (const cap of PUBLIC_BOUNDARY_MANUAL_CAPS) {
      expect(cap.expectedOutcomes).toEqual(
        cap.mode === 'exact'
          ? [
              { delta: -1, accepted: false },
              { delta: 0, accepted: true },
              { delta: 1, accepted: false },
            ]
          : [
              { delta: -1, accepted: true },
              { delta: 0, accepted: true },
              { delta: 1, accepted: false },
            ],
      );
      expect(cap.evidence.status, cap.id).toBe('covered');
      if (cap.evidence.status !== 'covered') throw new Error(`MANUAL_CAP_PENDING:${cap.id}`);
      expect(cap.evidence.testFile, cap.id).toMatch(/\.test\.ts$/u);
      expect(cap.evidence.outcomeFixture, cap.id).toBe(PUBLIC_MANUAL_CAP_OUTCOME_FIXTURE_PATH);
    }
  });

  it('aggregates the exact 21 machine-bound manual outcomes and consumer owners', async () => {
    const fixture = PublicManualCapOutcomeFixtureSchema.parse(
      JSON.parse(await readFile(manualOutcomeFixtureUrl, 'utf8')),
    );
    expect(fixture.rows).toEqual(expectedPublicManualCapOutcomeRows());
    expect(fixture.consumers).toEqual(
      PUBLIC_BOUNDARY_MANUAL_CAPS.map((cap) => {
        if (cap.evidence.status !== 'covered') throw new Error(`MANUAL_CAP_PENDING:${cap.id}`);
        return { probeId: cap.evidence.probeId, testFile: cap.evidence.testFile };
      }).sort((left, right) => left.probeId.localeCompare(right.probeId)),
    );
  });

  it('enforces both Evidence record maxima at actual roots and in generated public schemas', async () => {
    const [manifestFixture, environmentFixture] = await Promise.all([
      readFile(new URL('evidence-bundle-manifest.v1.json', fixtureDirectoryUrl), 'utf8'),
      readFile(new URL('evidence-environment.v1.json', fixtureDirectoryUrl), 'utf8'),
    ]);
    const manifestBase = JSON.parse(manifestFixture) as Record<string, unknown>;
    const environmentBase = JSON.parse(environmentFixture) as Record<string, unknown>;
    const atCloudMaximum = {
      ...manifestBase,
      cloudImageDigests: digestMap(EVIDENCE_MAX_CLOUD_IMAGE_DIGEST_PROPERTIES),
    };
    const belowCloudMaximum = {
      ...manifestBase,
      cloudImageDigests: digestMap(EVIDENCE_MAX_CLOUD_IMAGE_DIGEST_PROPERTIES - 1),
    };
    const aboveCloudMaximum = {
      ...manifestBase,
      cloudImageDigests: digestMap(EVIDENCE_MAX_CLOUD_IMAGE_DIGEST_PROPERTIES + 1),
    };
    expect(EvidenceBundleManifestSchema.safeParse(belowCloudMaximum).success).toBe(true);
    expect(EvidenceBundleManifestSchema.safeParse(atCloudMaximum).success).toBe(true);
    expect(EvidenceBundleManifestSchema.safeParse(aboveCloudMaximum).success).toBe(false);
    const tupleAtMaximum = evidenceReleaseTupleFromManifest(
      EvidenceBundleManifestSchema.parse(atCloudMaximum),
    );
    expect(EvidenceReleaseTupleSchema.safeParse(tupleAtMaximum).success).toBe(true);
    expect(
      EvidenceReleaseTupleSchema.safeParse({
        ...tupleAtMaximum,
        cloudImageDigests: digestMap(EVIDENCE_MAX_CLOUD_IMAGE_DIGEST_PROPERTIES + 1),
      }).success,
    ).toBe(false);

    const atRuntimeMaximum = {
      ...environmentBase,
      runtimeVersions: runtimeVersionMap(EVIDENCE_MAX_RUNTIME_VERSION_PROPERTIES),
    };
    const belowRuntimeMaximum = {
      ...environmentBase,
      runtimeVersions: runtimeVersionMap(EVIDENCE_MAX_RUNTIME_VERSION_PROPERTIES - 1),
    };
    const aboveRuntimeMaximum = {
      ...environmentBase,
      runtimeVersions: runtimeVersionMap(EVIDENCE_MAX_RUNTIME_VERSION_PROPERTIES + 1),
    };
    expect(EvidenceEnvironmentSchema.safeParse(belowRuntimeMaximum).success).toBe(true);
    expect(EvidenceEnvironmentSchema.safeParse(atRuntimeMaximum).success).toBe(true);
    expect(EvidenceEnvironmentSchema.safeParse(aboveRuntimeMaximum).success).toBe(false);

    const bundle = createJsonSchemaBundle();
    for (const pointer of [
      '/schemas/EvidenceBundleManifest/definitions/EvidenceBundleManifest/properties/cloudImageDigests',
      '/schemas/EvidenceReleaseTuple/definitions/EvidenceReleaseTuple/properties/cloudImageDigests',
    ]) {
      expect(lookupPointer(bundle, pointer).maxProperties, pointer).toBe(
        EVIDENCE_MAX_CLOUD_IMAGE_DIGEST_PROPERTIES,
      );
    }
    expect(
      lookupPointer(
        bundle,
        '/schemas/EvidenceEnvironment/definitions/EvidenceEnvironment/properties/runtimeVersions',
      ).maxProperties,
    ).toBe(EVIDENCE_MAX_RUNTIME_VERSION_PROPERTIES);
  });

  it('adapts yaml strict-threshold semantics to the inclusive public 1000-alias cap', async () => {
    expect(VNEXT_REGISTRY_YAML_LIBRARY_MAX_ALIAS_COUNT).toBe(
      VNEXT_REGISTRY_YAML_MAX_ALIAS_EXPANSIONS + 1,
    );
    const belowMaximum = parseVnextRegistryYaml(
      aliasYaml(VNEXT_REGISTRY_YAML_MAX_ALIAS_EXPANSIONS - 1),
    ) as {
      items?: unknown[];
    };
    const atMaximum = parseVnextRegistryYaml(
      aliasYaml(VNEXT_REGISTRY_YAML_MAX_ALIAS_EXPANSIONS),
    ) as {
      items?: unknown[];
    };
    expect(belowMaximum.items).toHaveLength(VNEXT_REGISTRY_YAML_MAX_ALIAS_EXPANSIONS - 1);
    expect(atMaximum.items).toHaveLength(VNEXT_REGISTRY_YAML_MAX_ALIAS_EXPANSIONS);
    expect(() =>
      parseVnextRegistryYaml(aliasYaml(VNEXT_REGISTRY_YAML_MAX_ALIAS_EXPANSIONS + 1)),
    ).toThrow(/Excessive alias count/u);
    const accepted = (count: number): boolean => {
      try {
        parseVnextRegistryYaml(aliasYaml(count));
        return true;
      } catch {
        return false;
      }
    };
    assertPublicManualCapOutcomeSubset(
      JSON.parse(await readFile(manualOutcomeFixtureUrl, 'utf8')),
      'packages/creator-agent-protocol/src/__tests__/public-boundary-closure.test.ts',
      [-1, 0, 1].map((delta) => ({
        probeId: 'manual-cap:registry-yaml-alias:n-minus-one-n-plus-one',
        delta: delta as -1 | 0 | 1,
        accepted: accepted(VNEXT_REGISTRY_YAML_MAX_ALIAS_EXPANSIONS + delta),
      })),
    );
  });
});
