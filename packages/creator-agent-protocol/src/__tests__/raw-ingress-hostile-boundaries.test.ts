import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { parseBrokerFrame, parseBrokerHandshake } from '../broker.js';
import { canonicalSha256, canonicalizeJson } from '../canonical.js';
import {
  EvidenceBundleIndexSchema,
  EvidenceBundleManifestSchema,
  EvidenceCaseResultSchema,
  EvidenceEnvironmentSchema,
  EvidencePrivacyScanSchema,
  EvidenceReviewerSignoffSchema,
  EvidenceSupportingArtifactPathSchema,
  evidenceBundleIndexDigest,
  evidenceBundleManifestDigest,
  evidencePrivacyScanScopeDigest,
  evidenceReleaseTupleDigest,
  evidenceReviewerSigningBytes,
  evidenceTestSuiteDigest,
  validateEvidenceBundleChain,
  type EvidenceBundleChainInput,
  type EvidenceReviewerSignoff,
} from '../evidence.js';
import {
  SnapshotPublicationCommitMarkerSchema,
  SnapshotPublicationPreparationMarkerSchema,
  SnapshotUploadCreateRequestSchema,
  parseSnapshotPublicationCommitMarker,
  parseSnapshotPublicationPreparationMarker,
  snapshotPublicationCommitMarkerBytes,
  snapshotPublicationPreparationDigest,
  snapshotPublicationPreparationMarkerBytes,
} from '../http.js';
import { ProtocolRawIngressHostileBoundaryCorpusSchema } from '../raw-ingress-hostile-boundaries.js';
import { TestCaseRegistrySchema } from '../registry.js';
import {
  SnapshotArchiveEnvelopeSchema,
  SnapshotManifestEnvelopeSchema,
  snapshotManifestEnvelopeAadDigest,
  snapshotManifestObjectKey,
  snapshotPublicationPreparationObjectKey,
} from '../snapshot.js';
import { readFixture } from './fixture-helpers.js';

const corpusUrl = new URL(
  '../../fixtures/protocol-raw-ingress-hostile-boundaries.v1.json',
  import.meta.url,
);
const fixtureDirectoryUrl = new URL('../../fixtures/', import.meta.url);
const fixtureIndexUrl = new URL('../../fixtures/index.json', import.meta.url);

type PathSegment = string | number;
type ProbeStage = 'raw' | 'schema';
type HostileProbe = Readonly<{ id: string; stage: ProbeStage; canary: string; bytes: Buffer }>;

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function pointerSegments(pointer: string): PathSegment[] {
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => (/^\d+$/u.test(segment) ? Number(segment) : segment));
}

function replacePointer(input: unknown, pointer: string, replacement: unknown): unknown {
  const clone = structuredClone(input);
  const segments = pointerSegments(pointer);
  let current = clone;
  for (const segment of segments.slice(0, -1)) {
    if (current === null || typeof current !== 'object') throw new Error('RAW_POINTER_INVALID');
    current = (current as Record<PathSegment, unknown>)[segment];
  }
  if (current === null || typeof current !== 'object') throw new Error('RAW_POINTER_INVALID');
  (current as Record<PathSegment, unknown>)[segments.at(-1)!] = replacement;
  return clone;
}

function replaceAscii(bytes: Buffer, sentinel: string, replacement: Uint8Array): Buffer {
  const needle = Buffer.from(sentinel, 'utf8');
  const offset = bytes.indexOf(needle);
  if (offset < 0 || bytes.indexOf(needle, offset + needle.byteLength) >= 0) {
    throw new Error(`RAW_SENTINEL_NOT_UNIQUE:${sentinel}`);
  }
  return Buffer.concat([
    bytes.subarray(0, offset),
    Buffer.from(replacement),
    bytes.subarray(offset + needle.byteLength),
  ]);
}

function hostileProbes(
  base: unknown,
  targetPointer: string,
  recipe: {
    canaryPrefix: string;
    malformedUtf8Hex: readonly string[];
    loneSurrogateEscapes: readonly string[];
    forbiddenControlRanges: readonly { start: number; end: number }[];
    allowedControlCodeUnits: readonly number[];
  },
): HostileProbe[] {
  const output: HostileProbe[] = [];
  for (const hex of recipe.malformedUtf8Hex) {
    const canary = `${recipe.canaryPrefix}MALFORMED_${hex}_`;
    const sentinel = `MALFORMED_SENTINEL_${hex}`;
    const seeded = Buffer.from(
      canonicalizeJson(replacePointer(base, targetPointer, `${canary}${sentinel}`)),
      'utf8',
    );
    output.push({
      id: `malformed-${hex}`,
      stage: 'raw',
      canary,
      bytes: replaceAscii(seeded, sentinel, Buffer.from(hex, 'hex')),
    });
  }
  recipe.loneSurrogateEscapes.forEach((escape, index) => {
    const canary = `${recipe.canaryPrefix}SURROGATE_${index}_`;
    const sentinel = `SURROGATE_SENTINEL_${index}`;
    const seeded = Buffer.from(
      canonicalizeJson(replacePointer(base, targetPointer, `${canary}${sentinel}`)),
      'utf8',
    );
    output.push({
      id: `surrogate-${index}`,
      stage: 'raw',
      canary,
      bytes: replaceAscii(seeded, sentinel, Buffer.from(escape, 'ascii')),
    });
  });
  const allowed = new Set(recipe.allowedControlCodeUnits);
  for (const range of recipe.forbiddenControlRanges) {
    for (let codeUnit = range.start; codeUnit <= range.end; codeUnit += 1) {
      if (allowed.has(codeUnit)) continue;
      const canary = `${recipe.canaryPrefix}CONTROL_${codeUnit.toString(16).padStart(2, '0')}_`;
      output.push({
        id: `control-${codeUnit.toString(16).padStart(2, '0')}`,
        stage: 'schema',
        canary,
        bytes: Buffer.from(
          canonicalizeJson(
            replacePointer(base, targetPointer, `${canary}${String.fromCharCode(codeUnit)}`),
          ),
          'utf8',
        ),
      });
    }
  }
  const structuralCanary = (id: string) => `${recipe.canaryPrefix}${id.toUpperCase()}_`;
  const bomCanary = structuralCanary('bom');
  output.push(
    {
      id: 'bom',
      stage: 'raw',
      canary: bomCanary,
      bytes: Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(
          canonicalizeJson(replacePointer(base, targetPointer, `${bomCanary}value`)),
          'utf8',
        ),
      ]),
    },
    {
      id: 'syntax',
      stage: 'raw',
      canary: structuralCanary('syntax'),
      bytes: Buffer.from(`{"${structuralCanary('syntax')}":`, 'utf8'),
    },
    {
      id: 'duplicate-root',
      stage: 'raw',
      canary: structuralCanary('duplicate-root'),
      bytes: Buffer.from(
        `{"${structuralCanary('duplicate-root')}":1,"${structuralCanary('duplicate-root')}":2}`,
        'utf8',
      ),
    },
    {
      id: 'duplicate-nested',
      stage: 'raw',
      canary: structuralCanary('duplicate-nested'),
      bytes: Buffer.from(
        `{"nested":{"${structuralCanary('duplicate-nested')}":1,"${structuralCanary('duplicate-nested')}":2}}`,
        'utf8',
      ),
    },
  );
  const rootCanary = structuralCanary('unknown-root');
  const nestedCanary = structuralCanary('unknown-nested');
  output.push({
    id: 'unknown-root',
    stage: 'schema',
    canary: rootCanary,
    bytes: Buffer.from(
      canonicalizeJson(
        Array.isArray(base) ? { [rootCanary]: true } : { ...(base as object), [rootCanary]: true },
      ),
      'utf8',
    ),
  });
  output.push({
    id: 'unknown-nested',
    stage: 'schema',
    canary: nestedCanary,
    bytes: Buffer.from(
      canonicalizeJson(
        Array.isArray(base)
          ? [...base, { nested: { [nestedCanary]: true } }]
          : { ...(base as object), nested: { [nestedCanary]: true } },
      ),
      'utf8',
    ),
  });
  return output;
}

function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

async function publicationMarkers() {
  const archive = SnapshotArchiveEnvelopeSchema.parse(
    await readFixture('snapshot-envelope.v1.json'),
  );
  const manifestFixture = SnapshotManifestEnvelopeSchema.parse(
    await readFixture('snapshot-manifest-envelope.v1.json'),
  );
  const manifestAad = {
    ...manifestFixture.aad,
    creatorId: archive.aad.creatorId,
    snapshotDigest: archive.aad.snapshotDigest,
    objectKey: snapshotManifestObjectKey(archive.aad.creatorId, archive.aad.snapshotDigest),
    keyId: archive.aad.keyId,
  };
  const manifest = SnapshotManifestEnvelopeSchema.parse({
    ...manifestFixture,
    aad: manifestAad,
    aadDigest: snapshotManifestEnvelopeAadDigest(manifestAad),
    wrappedDek: archive.wrappedDek,
  });
  const request = SnapshotUploadCreateRequestSchema.parse({
    archive: {
      envelope: archive,
      checksumSha256: Buffer.from(archive.cipherDigest, 'hex').toString('base64'),
    },
    manifest: {
      envelope: manifest,
      checksumSha256: Buffer.from(manifest.cipherDigest, 'hex').toString('base64'),
    },
    expandedBytes: 1,
    fileCount: 1,
  });
  const preparation = SnapshotPublicationPreparationMarkerSchema.parse({
    protocol: 'combo.snapshot-publication-preparation/1',
    schemaVersion: 1,
    creatorId: archive.aad.creatorId,
    snapshotDigest: archive.aad.snapshotDigest,
    selectedUploadId: '0198f00d-8000-7000-8000-000000000011',
    request,
  });
  const commit = SnapshotPublicationCommitMarkerSchema.parse({
    protocol: 'combo.snapshot-publication-commit/1',
    schemaVersion: 1,
    creatorId: archive.aad.creatorId,
    snapshotDigest: archive.aad.snapshotDigest,
    preparationKey: snapshotPublicationPreparationObjectKey(
      archive.aad.creatorId,
      archive.aad.snapshotDigest,
    ),
    preparationDigest: snapshotPublicationPreparationDigest(preparation),
  });
  return { preparation, commit };
}

function signEvidenceReview(
  review: EvidenceReviewerSignoff,
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
): EvidenceReviewerSignoff {
  const signature = sign('sha256', evidenceReviewerSigningBytes(review), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return EvidenceReviewerSignoffSchema.parse({ ...review, signature });
}

async function coherentEvidenceChain(): Promise<{
  input: EvidenceBundleChainInput;
  ownerValues: Record<string, unknown>;
}> {
  const indexFixture = EvidenceBundleIndexSchema.parse(
    await readFixture('evidence-bundle-index.v1.json'),
  );
  const manifestFixture = EvidenceBundleManifestSchema.parse(
    await readFixture('evidence-bundle-manifest.v1.json'),
  );
  const resultFixture = EvidenceCaseResultSchema.parse(
    await readFixture('evidence-case-result.v1.json'),
  );
  const environment = EvidenceEnvironmentSchema.parse(
    await readFixture('evidence-environment.v1.json'),
  );
  const signoffFixture = EvidenceReviewerSignoffSchema.parse(
    await readFixture('evidence-reviewer-signoff.v1.json'),
  );
  const opaqueBytes = Object.fromEntries(
    EvidenceSupportingArtifactPathSchema.options
      .filter((path) => path !== 'environment.json' && path !== 'privacy-scan.json')
      .map((path) => [path, Buffer.from(`raw-ingress evidence for ${path}\n`, 'utf8')]),
  ) as Record<string, Uint8Array>;
  const environmentSummary = {
    protocol: 'combo.vnext-evidence-bundle/1',
    schemaVersion: 1,
    environments: [environment],
  };
  const environmentBytes = Buffer.from(canonicalizeJson(environmentSummary), 'utf8');
  const artifactsBeforePrivacy = [
    {
      path: 'environment.json' as const,
      bytes: environmentBytes.byteLength,
      digest: sha256(environmentBytes),
    },
    ...EvidenceSupportingArtifactPathSchema.options
      .filter((path) => path !== 'environment.json' && path !== 'privacy-scan.json')
      .map((path) => ({
        path,
        bytes: opaqueBytes[path]!.byteLength,
        digest: sha256(opaqueBytes[path]!),
      })),
  ];
  const privacyScan = EvidencePrivacyScanSchema.parse({
    protocol: 'combo.vnext-evidence-bundle/1',
    schemaVersion: 1,
    rcId: manifestFixture.rcId,
    scannerId: 'evidence-privacy-scanner',
    scannerVersion: '1.0.0',
    scannedArtifacts: artifactsBeforePrivacy.map(({ path, digest }) => ({ path, digest })),
    scopeDigest: evidencePrivacyScanScopeDigest(
      artifactsBeforePrivacy.map(({ path, digest }) => ({ path, digest })),
    ),
    findingCounts: {
      credentials: 0,
      authorizationMaterial: 0,
      consumerPlaintext: 0,
      creatorProjectContent: 0,
      absolutePaths: 0,
      hiddenReasoning: 0,
      rawRuntimeEvents: 0,
      realThreadTurnIds: 0,
    },
    totalForbiddenFindings: 0,
    status: 'CLEAN',
    scannedAt: '2026-08-13T09:00:00.000Z',
  });
  const privacyBytes = Buffer.from(canonicalizeJson(privacyScan), 'utf8');
  const index = EvidenceBundleIndexSchema.parse({
    ...indexFixture,
    artifacts: [
      ...artifactsBeforePrivacy,
      { path: 'privacy-scan.json', bytes: privacyBytes.byteLength, digest: sha256(privacyBytes) },
    ],
  });
  const registry = TestCaseRegistrySchema.parse({
    protocol: 'combo.vnext-test-registry/1',
    schemaVersion: 1,
    cases: [
      {
        id: 'SCH-005',
        title: 'synthetic raw-ingress hostile case',
        level: 'E1',
        environment: 'T0-LINUX-CI',
        invariants: ['INV-002', 'INV-019'],
        fixture: ['synthetic-raw-ingress'],
        fault: [],
        steps: ['verify raw ingress'],
        assertions: ['all hostile bytes fail closed'],
        evidence: ['synthetic evidence artifact'],
        frequency: 'every-pr',
        owner: 'Protocol',
        reviewer: 'Independent Verifier/SRE',
        gate: 'G0',
        implementation: { status: 'implemented', testFiles: ['synthetic-raw-ingress.test.ts'] },
        releaseTuple: ['creator-agent-protocol@0.1.0'],
        fixtureDigests: [index.artifacts[0]!.digest],
      },
    ],
  });
  const manifestAuthority = EvidenceBundleManifestSchema.parse({
    ...manifestFixture,
    artifactIndexDigest: evidenceBundleIndexDigest(index),
    testCaseRegistryDigest: `sha256:${canonicalSha256(registry)}`,
    results: { pass: 1, fail: 0, blocked: 0, notRun: 0 },
  });
  const result = EvidenceCaseResultSchema.parse({
    ...resultFixture,
    testCaseId: 'SCH-005',
    evidenceLevel: 'E1',
    environmentId: 'T0-LINUX-CI',
    releaseTupleDigest: evidenceReleaseTupleDigest(manifestAuthority),
    artifactDigests: [index.artifacts[0]!.digest],
  });
  const manifest = EvidenceBundleManifestSchema.parse({
    ...manifestAuthority,
    testSuiteDigest: evidenceTestSuiteDigest([result]),
  });
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const unsignedSignoff = EvidenceReviewerSignoffSchema.parse({
    ...signoffFixture,
    rcId: manifest.rcId,
    manifestDigest: evidenceBundleManifestDigest(manifest),
    reviewerKeyId: 'reviewer-key-raw-ingress-001',
    verdict: 'PASS',
    reviewedGates: ['G0'],
    signature: 'A'.repeat(86),
  });
  const signoffValue = signEvidenceReview(unsignedSignoff, keys.privateKey);
  const supportingArtifacts = {
    ...opaqueBytes,
    'environment.json': environmentBytes,
    'privacy-scan.json': privacyBytes,
  } as EvidenceBundleChainInput['supportingArtifacts'];
  const input: EvidenceBundleChainInput = {
    index: Buffer.from(canonicalizeJson(index), 'utf8'),
    supportingArtifacts,
    caseResults: Buffer.from(canonicalizeJson([result]), 'utf8'),
    testCaseRegistry: Buffer.from(canonicalizeJson(registry), 'utf8'),
    manifest: Buffer.from(canonicalizeJson(manifest), 'utf8'),
    signoff: Buffer.from(canonicalizeJson(signoffValue), 'utf8'),
    expected: {
      rcId: signoffValue.rcId,
      manifestDigest: signoffValue.manifestDigest,
      reviewerKeyId: signoffValue.reviewerKeyId,
      reviewedGates: signoffValue.reviewedGates,
    },
    registeredReviewerPublicKey: keys.publicKey,
    revokedReviewerKeyIds: new Set(),
  };
  expect(validateEvidenceBundleChain(input)).toEqual({ ok: true });
  return {
    input,
    ownerValues: {
      'evidence-index': index,
      'evidence-case-results': [result],
      'evidence-test-case-registry': registry,
      'evidence-manifest': manifest,
      'evidence-signoff': signoffValue,
      'evidence-environment': environmentSummary,
      'evidence-privacy-scan': privacyScan,
    },
  };
}

function replaceEvidenceBytes(
  input: EvidenceBundleChainInput,
  inputOwner: string,
  bytes: Uint8Array,
): EvidenceBundleChainInput {
  if (inputOwner.startsWith('supportingArtifacts.')) {
    const path = inputOwner.slice('supportingArtifacts.'.length) as
      | 'environment.json'
      | 'privacy-scan.json';
    return { ...input, supportingArtifacts: { ...input.supportingArtifacts, [path]: bytes } };
  }
  return { ...input, [inputOwner]: bytes } as EvidenceBundleChainInput;
}

function evidenceByteSnapshot(input: EvidenceBundleChainInput): Record<string, string> {
  return {
    index: sha256(input.index),
    caseResults: sha256(input.caseResults),
    testCaseRegistry: sha256(input.testCaseRegistry),
    manifest: sha256(input.manifest),
    signoff: sha256(input.signoff),
    environment: sha256(input.supportingArtifacts['environment.json']!),
    privacyScan: sha256(input.supportingArtifacts['privacy-scan.json']!),
  };
}

describe('digest-bound raw ingress hostile boundaries', () => {
  it('pins authority, fixture index, twelve owners, exclusions, and exact 912 outcomes', async () => {
    const corpusBytes = await readFile(corpusUrl);
    const corpus = ProtocolRawIngressHostileBoundaryCorpusSchema.parse(
      JSON.parse(corpusBytes.toString('utf8')),
    );
    expect(corpus.authority).toEqual({
      testCaseId: 'SCH-005',
      invariants: ['INV-002', 'INV-019'],
      snapshotCaseId: 'SNP-010',
      testPlanSection: '测试方案 §6.1 SCH-005 / §8.3 SNP-010',
    });
    expect(corpus.outcomeCounts).toMatchObject({
      owners: 12,
      perOwner: 76,
      acceptedBaselines: 12,
      rejected: 900,
      total: 912,
    });
    expect(corpus.exclusions).toContain('does-not-complete-sch-005');
    expect(corpus.exclusions).toContain('does-not-complete-snp-010');
    const fixtureIndex = JSON.parse(await readFile(fixtureIndexUrl, 'utf8')) as {
      fixtures: Array<{ path: string; bytes: number; digest: string }>;
    };
    expect(
      fixtureIndex.fixtures.find(
        ({ path }) => path === 'protocol-raw-ingress-hostile-boundaries.v1.json',
      ),
    ).toEqual({
      path: 'protocol-raw-ingress-hostile-boundaries.v1.json',
      bytes: corpusBytes.byteLength,
      digest: sha256(corpusBytes),
    });
    for (const fixture of corpus.baseFixtures) {
      expect(sha256(await readFile(new URL(fixture.path, fixtureDirectoryUrl))), fixture.path).toBe(
        fixture.digest,
      );
    }
  });

  it('runs 304 immutable inputs through four stable ProtocolRawInputError owners', async () => {
    const corpus = ProtocolRawIngressHostileBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(corpusUrl, 'utf8')),
    );
    const markers = await publicationMarkers();
    const ownerValues: Record<string, unknown> = {
      'broker-handshake': await readFixture('broker-handshake.v1.json'),
      'broker-frame': await readFixture('broker-invocation-prepare.v1.json'),
      'snapshot-publication-preparation-marker': markers.preparation,
      'snapshot-publication-commit-marker': markers.commit,
    };
    const parsers = {
      'broker-handshake': parseBrokerHandshake,
      'broker-frame': parseBrokerFrame,
      'snapshot-publication-preparation-marker': parseSnapshotPublicationPreparationMarker,
      'snapshot-publication-commit-marker': parseSnapshotPublicationCommitMarker,
    } as const;
    let outcomes = 0;
    for (const owner of corpus.owners) {
      if (!('expectedCode' in owner) || owner.id === 'snapshot-manifest') continue;
      const base = ownerValues[owner.id]!;
      const baselineBytes =
        owner.id === 'snapshot-publication-preparation-marker'
          ? snapshotPublicationPreparationMarkerBytes(markers.preparation)
          : owner.id === 'snapshot-publication-commit-marker'
            ? snapshotPublicationCommitMarkerBytes(markers.commit)
            : Buffer.from(canonicalizeJson(base), 'utf8');
      expect(() => parsers[owner.id](baselineBytes), `baseline:${owner.id}`).not.toThrow();
      const baselineBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), baselineBytes]);
      const baselineBomBefore = Buffer.from(baselineBom);
      expect(
        caught(() => parsers[owner.id](baselineBom)),
        `baseline-bom:${owner.id}`,
      ).toMatchObject({
        name: 'ProtocolRawInputError',
        code: owner.expectedCode,
      });
      expect(baselineBom, `baseline-bom:${owner.id}:input`).toEqual(baselineBomBefore);
      outcomes += 1;
      const probes = hostileProbes(base, owner.targetPointer, corpus.probes);
      expect(probes).toHaveLength(corpus.outcomeCounts.perOwner - 1);
      for (const probe of probes) {
        expect(
          probe.bytes.includes(Buffer.from(probe.canary, 'utf8')),
          `${owner.id}:${probe.id}:canary`,
        ).toBe(true);
        const before = Buffer.from(probe.bytes);
        const error = caught(() => parsers[owner.id](probe.bytes));
        expect(error, `${owner.id}:${probe.id}`).toMatchObject({
          name: 'ProtocolRawInputError',
          message: owner.expectedCode,
          code: owner.expectedCode,
        });
        expect(error, `${owner.id}:${probe.id}`).not.toHaveProperty('cause');
        expect(error, `${owner.id}:${probe.id}`).not.toHaveProperty('issues');
        expect(error, `${owner.id}:${probe.id}`).not.toHaveProperty('input');
        expect(
          `${String(error)} ${JSON.stringify(error)}`,
          `${owner.id}:${probe.id}`,
        ).not.toContain(probe.canary);
        expect(probe.bytes, `${owner.id}:${probe.id}:input`).toEqual(before);
        outcomes += 1;
      }
    }
    expect(outcomes).toBe(corpus.outcomeCounts.protocolRawErrors);
  }, 15_000);

  it('runs 532 immutable inputs through all seven stable Evidence reason owners', async () => {
    const corpus = ProtocolRawIngressHostileBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(corpusUrl, 'utf8')),
    );
    const evidence = await coherentEvidenceChain();
    let outcomes = 0;
    for (const owner of corpus.owners) {
      if (!('inputOwner' in owner)) continue;
      expect(validateEvidenceBundleChain(evidence.input), `baseline:${owner.id}`).toEqual({
        ok: true,
      });
      const baselineValue = evidence.ownerValues[owner.id];
      const baselineBom = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(canonicalizeJson(baselineValue), 'utf8'),
      ]);
      const baselineBomCandidate = replaceEvidenceBytes(
        evidence.input,
        owner.inputOwner,
        baselineBom,
      );
      const baselineBomBefore = evidenceByteSnapshot(baselineBomCandidate);
      const baselineBomResult = validateEvidenceBundleChain(baselineBomCandidate);
      expect(baselineBomResult.ok, `baseline-bom:${owner.id}`).toBe(false);
      if (baselineBomResult.ok) throw new Error('EXPECTED_EVIDENCE_BOM_REJECTION');
      expect(baselineBomResult.reasons, `baseline-bom:${owner.id}`).toContain(
        owner.expectedRawReason,
      );
      expect(evidenceByteSnapshot(baselineBomCandidate), `baseline-bom:${owner.id}:input`).toEqual(
        baselineBomBefore,
      );
      outcomes += 1;
      const probes = hostileProbes(
        evidence.ownerValues[owner.id],
        owner.targetPointer,
        corpus.probes,
      );
      expect(probes).toHaveLength(corpus.outcomeCounts.perOwner - 1);
      for (const probe of probes) {
        expect(
          probe.bytes.includes(Buffer.from(probe.canary, 'utf8')),
          `${owner.id}:${probe.id}:canary`,
        ).toBe(true);
        const candidate = replaceEvidenceBytes(evidence.input, owner.inputOwner, probe.bytes);
        const before = evidenceByteSnapshot(candidate);
        const result = validateEvidenceBundleChain(candidate);
        expect(result.ok, `${owner.id}:${probe.id}`).toBe(false);
        if (result.ok) throw new Error('EXPECTED_EVIDENCE_REJECTION');
        expect(result.reasons, `${owner.id}:${probe.id}`).toContain(
          probe.stage === 'raw' ? owner.expectedRawReason : owner.expectedSchemaReason,
        );
        expect(JSON.stringify(result), `${owner.id}:${probe.id}`).not.toContain(probe.canary);
        expect(evidenceByteSnapshot(candidate), `${owner.id}:${probe.id}:input`).toEqual(before);
        outcomes += 1;
      }
    }
    expect(outcomes).toBe(corpus.outcomeCounts.evidenceReasons);
  }, 15_000);
});
