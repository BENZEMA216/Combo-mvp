import { z } from 'zod';

import { Sha256DigestSchema } from './primitives.js';

export const PROTOCOL_RAW_INGRESS_HOSTILE_BOUNDARY_CORPUS =
  'combo.protocol-raw-ingress-hostile-boundaries/1' as const;

const BaseFixtureSchema = z
  .object({
    path: z.string().min(1).max(128),
    digest: Sha256DigestSchema,
  })
  .strict();

const ProtocolErrorOwnerSchema = z
  .object({
    id: z.enum([
      'broker-handshake',
      'broker-frame',
      'snapshot-publication-preparation-marker',
      'snapshot-publication-commit-marker',
    ]),
    package: z.literal('@cb/creator-agent-protocol'),
    parser: z.enum([
      'parseBrokerHandshake',
      'parseBrokerFrame',
      'parseSnapshotPublicationPreparationMarker',
      'parseSnapshotPublicationCommitMarker',
    ]),
    fixtureRecipe: z.enum([
      'broker-handshake-fixture',
      'broker-prepare-fixture',
      'derived-preparation-marker',
      'derived-commit-marker',
    ]),
    targetPointer: z.string().startsWith('/').max(256),
    expectedCode: z.enum([
      'BROKER_HANDSHAKE_INVALID',
      'BROKER_FRAME_INVALID',
      'SNAPSHOT_PREPARATION_MARKER_INVALID',
      'SNAPSHOT_COMMIT_MARKER_INVALID',
    ]),
  })
  .strict();

const EvidenceOwnerSchema = z
  .object({
    id: z.enum([
      'evidence-index',
      'evidence-case-results',
      'evidence-test-case-registry',
      'evidence-manifest',
      'evidence-signoff',
      'evidence-environment',
      'evidence-privacy-scan',
    ]),
    package: z.literal('@cb/creator-agent-protocol'),
    parser: z.literal('validateEvidenceBundleChain'),
    inputOwner: z.enum([
      'index',
      'caseResults',
      'testCaseRegistry',
      'manifest',
      'signoff',
      'supportingArtifacts.environment.json',
      'supportingArtifacts.privacy-scan.json',
    ]),
    targetPointer: z.string().startsWith('/').max(256),
    expectedRawReason: z.string().min(1).max(96),
    expectedSchemaReason: z.string().min(1).max(96),
  })
  .strict();

const SnapshotOwnerSchema = z
  .object({
    id: z.literal('snapshot-manifest'),
    package: z.literal('@cb/creator-agent-snapshot'),
    parser: z.literal('parseSnapshotManifest'),
    fixtureRecipe: z.literal('snapshot-manifest-fixture'),
    targetPointer: z.literal('/files/0/path'),
    expectedCode: z.literal('SNAPSHOT_ARCHIVE_INVALID'),
  })
  .strict();

/**
 * Direct-public-parser evidence only. This matrix does not claim real socket, object-store,
 * HTTP, process, or durable-business side effects; each call must leave its input bytes intact.
 */
export const ProtocolRawIngressHostileBoundaryCorpusSchema = z
  .object({
    protocol: z.literal(PROTOCOL_RAW_INGRESS_HOSTILE_BOUNDARY_CORPUS),
    schemaVersion: z.literal(1),
    scope: z.literal('broker-marker-evidence-and-snapshot-json-ingress-only'),
    evidenceClass: z.literal('direct-public-parser-hostile-matrix-only'),
    authority: z
      .object({
        testCaseId: z.literal('SCH-005'),
        invariants: z.tuple([z.literal('INV-002'), z.literal('INV-019')]),
        snapshotCaseId: z.literal('SNP-010'),
        testPlanSection: z.literal('测试方案 §6.1 SCH-005 / §8.3 SNP-010'),
      })
      .strict(),
    baseFixtures: z.tuple([
      BaseFixtureSchema.extend({
        path: z.literal('broker-handshake.v1.json'),
        digest: z.literal(
          'sha256:b6ed51697a3af8b31a3e2c17693b35791359b744d94107e3d942582ff102c11f',
        ),
      }).strict(),
      BaseFixtureSchema.extend({
        path: z.literal('broker-invocation-prepare.v1.json'),
        digest: z.literal(
          'sha256:74e7f1da4c8d9380a3e03b5e9d0cca65ba44cb1aeeeefd41e2504e583a44d2de',
        ),
      }).strict(),
      BaseFixtureSchema.extend({
        path: z.literal('snapshot-envelope.v1.json'),
        digest: z.literal(
          'sha256:4beebe50ab28e454e3136c908feefb7df3fe97dc02e846882231614722a3dfe9',
        ),
      }).strict(),
      BaseFixtureSchema.extend({
        path: z.literal('snapshot-manifest-envelope.v1.json'),
        digest: z.literal(
          'sha256:5daaeaccbcabf1eac51dc06e467c8464b4b65b7fd12cfbaae0d450c1581940fd',
        ),
      }).strict(),
      BaseFixtureSchema.extend({
        path: z.literal('evidence-bundle-index.v1.json'),
        digest: z.literal(
          'sha256:654759f29954dbead6bdeb3b13301a90afc3d328460d9292c1b2332ffaf0a2cb',
        ),
      }).strict(),
      BaseFixtureSchema.extend({
        path: z.literal('evidence-bundle-manifest.v1.json'),
        digest: z.literal(
          'sha256:99bb2e91df30706472c02acbcf7d23a5dcc772f16fd28754266f584d8f5a0f4a',
        ),
      }).strict(),
      BaseFixtureSchema.extend({
        path: z.literal('evidence-case-result.v1.json'),
        digest: z.literal(
          'sha256:a4fb707bd3b5e82a0125ee8b3cf0dd3a7e24f31f5a554c2d4cf1289212c1fd4f',
        ),
      }).strict(),
      BaseFixtureSchema.extend({
        path: z.literal('evidence-environment.v1.json'),
        digest: z.literal(
          'sha256:5f6d858f2269537861bdd4dad925033e3851a541633037e48da2c50c61a8e3f8',
        ),
      }).strict(),
      BaseFixtureSchema.extend({
        path: z.literal('evidence-privacy-scan.v1.json'),
        digest: z.literal(
          'sha256:a99eb81b3747adf032306fd7cc2c992859ec1e09a3a981eee4a937b15e17a9d0',
        ),
      }).strict(),
      BaseFixtureSchema.extend({
        path: z.literal('evidence-reviewer-signoff.v1.json'),
        digest: z.literal(
          'sha256:8168d6903059304a5eaf836f620eb7acc3a0fce7688499ef3e52042f8d10b92b',
        ),
      }).strict(),
      BaseFixtureSchema.extend({
        path: z.literal('snapshot-manifest.v1.json'),
        digest: z.literal(
          'sha256:d77fc869ee4f4c9b616fb8277b482515b22e9fe957214c63964436d302359088',
        ),
      }).strict(),
    ]),
    owners: z.tuple([
      ProtocolErrorOwnerSchema.extend({
        id: z.literal('broker-handshake'),
        parser: z.literal('parseBrokerHandshake'),
        fixtureRecipe: z.literal('broker-handshake-fixture'),
        targetPointer: z.literal('/workerVersion'),
        expectedCode: z.literal('BROKER_HANDSHAKE_INVALID'),
      }).strict(),
      ProtocolErrorOwnerSchema.extend({
        id: z.literal('broker-frame'),
        parser: z.literal('parseBrokerFrame'),
        fixtureRecipe: z.literal('broker-prepare-fixture'),
        targetPointer: z.literal('/body/executionCapability/model'),
        expectedCode: z.literal('BROKER_FRAME_INVALID'),
      }).strict(),
      ProtocolErrorOwnerSchema.extend({
        id: z.literal('snapshot-publication-preparation-marker'),
        parser: z.literal('parseSnapshotPublicationPreparationMarker'),
        fixtureRecipe: z.literal('derived-preparation-marker'),
        targetPointer: z.literal('/request/archive/envelope/aad/keyId'),
        expectedCode: z.literal('SNAPSHOT_PREPARATION_MARKER_INVALID'),
      }).strict(),
      ProtocolErrorOwnerSchema.extend({
        id: z.literal('snapshot-publication-commit-marker'),
        parser: z.literal('parseSnapshotPublicationCommitMarker'),
        fixtureRecipe: z.literal('derived-commit-marker'),
        targetPointer: z.literal('/preparationKey'),
        expectedCode: z.literal('SNAPSHOT_COMMIT_MARKER_INVALID'),
      }).strict(),
      EvidenceOwnerSchema.extend({
        id: z.literal('evidence-index'),
        inputOwner: z.literal('index'),
        targetPointer: z.literal('/artifacts/0/path'),
        expectedRawReason: z.literal('index-json'),
        expectedSchemaReason: z.literal('index-schema'),
      }).strict(),
      EvidenceOwnerSchema.extend({
        id: z.literal('evidence-case-results'),
        inputOwner: z.literal('caseResults'),
        targetPointer: z.literal('/0/testCaseId'),
        expectedRawReason: z.literal('case-results-json'),
        expectedSchemaReason: z.literal('case-results-schema'),
      }).strict(),
      EvidenceOwnerSchema.extend({
        id: z.literal('evidence-test-case-registry'),
        inputOwner: z.literal('testCaseRegistry'),
        targetPointer: z.literal('/cases/0/title'),
        expectedRawReason: z.literal('test-case-registry-json'),
        expectedSchemaReason: z.literal('test-case-registry-schema'),
      }).strict(),
      EvidenceOwnerSchema.extend({
        id: z.literal('evidence-manifest'),
        inputOwner: z.literal('manifest'),
        targetPointer: z.literal('/rcId'),
        expectedRawReason: z.literal('manifest-json'),
        expectedSchemaReason: z.literal('manifest-schema'),
      }).strict(),
      EvidenceOwnerSchema.extend({
        id: z.literal('evidence-signoff'),
        inputOwner: z.literal('signoff'),
        targetPointer: z.literal('/reviewerKeyId'),
        expectedRawReason: z.literal('signoff-json'),
        expectedSchemaReason: z.literal('signoff-schema'),
      }).strict(),
      EvidenceOwnerSchema.extend({
        id: z.literal('evidence-environment'),
        inputOwner: z.literal('supportingArtifacts.environment.json'),
        targetPointer: z.literal('/environments/0/runtimeVersions/node'),
        expectedRawReason: z.literal('artifact:environment.json:json'),
        expectedSchemaReason: z.literal('environment-schema'),
      }).strict(),
      EvidenceOwnerSchema.extend({
        id: z.literal('evidence-privacy-scan'),
        inputOwner: z.literal('supportingArtifacts.privacy-scan.json'),
        targetPointer: z.literal('/scannerId'),
        expectedRawReason: z.literal('artifact:privacy-scan.json:json'),
        expectedSchemaReason: z.literal('privacy-scan-schema'),
      }).strict(),
      SnapshotOwnerSchema,
    ]),
    probes: z
      .object({
        canaryPrefix: z.literal('RAW_INGRESS_HOSTILE_CANARY_'),
        malformedUtf8Hex: z.tuple([
          z.literal('80'),
          z.literal('c0af'),
          z.literal('e282'),
          z.literal('eda080'),
          z.literal('f4908080'),
        ]),
        loneSurrogateEscapes: z.tuple([z.literal('\\ud800'), z.literal('\\udc00')]),
        forbiddenControlRanges: z.tuple([
          z.object({ start: z.literal(0x00), end: z.literal(0x1f) }).strict(),
          z.object({ start: z.literal(0x7f), end: z.literal(0x9f) }).strict(),
        ]),
        allowedControlCodeUnits: z.tuple([z.literal(0x09), z.literal(0x0a), z.literal(0x0d)]),
        structural: z.tuple([
          z.literal('bom'),
          z.literal('syntax'),
          z.literal('duplicate-root'),
          z.literal('duplicate-nested'),
          z.literal('unknown-root'),
          z.literal('unknown-nested'),
        ]),
      })
      .strict(),
    outcomeCounts: z
      .object({
        owners: z.literal(12),
        perOwner: z.literal(76),
        acceptedBaselines: z.literal(12),
        malformedUtf8: z.literal(60),
        loneSurrogates: z.literal(24),
        forbiddenControls: z.literal(744),
        structural: z.literal(72),
        rejected: z.literal(900),
        protocolRawErrors: z.literal(304),
        evidenceReasons: z.literal(532),
        snapshotErrors: z.literal(76),
        total: z.literal(912),
      })
      .strict(),
    exclusions: z.tuple([
      z.literal('real-gateway-worker-socket-full-matrix'),
      z.literal('object-storage-business-side-effects'),
      z.literal('http-request-roots-covered-by-sch-005-closure'),
      z.literal('runtime-json-bytes-covered-by-vnext-json-body-test'),
      z.literal('registry-yaml-public-errors'),
      z.literal('content-encoding-and-chunked-ingress'),
      z.literal('t0-linux-ci-evidence'),
      z.literal('does-not-complete-snp-010'),
    ]),
  })
  .strict()
  .superRefine((corpus, context) => {
    const controls =
      corpus.probes.forbiddenControlRanges.reduce(
        (count, range) => count + range.end - range.start + 1,
        0,
      ) - corpus.probes.allowedControlCodeUnits.length;
    const hostilePerOwner =
      corpus.probes.malformedUtf8Hex.length +
      corpus.probes.loneSurrogateEscapes.length +
      controls +
      corpus.probes.structural.length;
    if (
      controls !== 62 ||
      corpus.owners.length !== corpus.outcomeCounts.owners ||
      hostilePerOwner + 1 !== corpus.outcomeCounts.perOwner ||
      corpus.outcomeCounts.acceptedBaselines !== corpus.owners.length ||
      corpus.outcomeCounts.rejected !== corpus.owners.length * hostilePerOwner ||
      corpus.outcomeCounts.total !==
        corpus.outcomeCounts.acceptedBaselines + corpus.outcomeCounts.rejected ||
      corpus.outcomeCounts.total !==
        corpus.outcomeCounts.protocolRawErrors +
          corpus.outcomeCounts.evidenceReasons +
          corpus.outcomeCounts.snapshotErrors
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcomeCounts'],
        message: 'raw-ingress hostile outcome counts must remain exact',
      });
    }
  });

export type ProtocolRawIngressHostileBoundaryCorpus = z.infer<
  typeof ProtocolRawIngressHostileBoundaryCorpusSchema
>;
