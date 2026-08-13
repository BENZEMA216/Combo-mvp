import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalSha256, canonicalizeJson, parseJsonNoDuplicateKeys } from './canonical.js';
import {
  Base64UrlSchema,
  IsoDateTimeSchema,
  P256P1363SignatureSchema,
  Sha256DigestSchema,
  Sha256HexSchema,
} from './primitives.js';
import { TestCaseIdSchema, TestCaseRegistrySchema } from './registry.js';
import { verifyP256P1363Signature, type P256PublicKeyInput } from './signatures.js';

export const EVIDENCE_BUNDLE_PROTOCOL = 'combo.vnext-evidence-bundle/1' as const;
export const EVIDENCE_RELEASE_TUPLE_PROTOCOL = 'combo.vnext-release-tuple/1' as const;
const EvidenceTokenSchema = (maximum: number) =>
  z.string().regex(new RegExp(`^[A-Za-z0-9][A-Za-z0-9._+()-]{0,${maximum - 1}}$`, 'u'));
export const EvidenceEnvironmentIdSchema = z.enum([
  'T0-LINUX-CI',
  'T1-SERVICE-CI',
  'T2-LOCAL-CONTRACT',
  'T3-MAC-REAL-HOST',
  'T4-MAC-ISOLATION',
  'T5-K3S-TEST',
  'T6-FULL-E2E',
  'T7-DR',
]);

export const EvidenceResultCountsSchema = z
  .object({
    pass: z.number().int().min(0),
    fail: z.number().int().min(0),
    blocked: z.number().int().min(0),
    notRun: z.number().int().min(0),
  })
  .strict();

export const EvidenceBundleManifestSchema = z
  .object({
    protocol: z.literal(EVIDENCE_BUNDLE_PROTOCOL),
    schemaVersion: z.literal(1),
    rcId: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,127}$/u),
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
    cloudImageDigests: z.record(z.string().regex(/^[a-z][a-z0-9-]{1,63}$/u), Sha256DigestSchema),
    workerArtifactDigest: Sha256DigestSchema,
    codexArtifactDigest: Sha256DigestSchema,
    sandboxImageDigest: Sha256DigestSchema,
    modelProxyArtifactDigest: Sha256DigestSchema,
    agentVersionDigest: Sha256HexSchema,
    snapshotDigest: Sha256HexSchema,
    behaviorContractDigest: Sha256HexSchema,
    runtimePolicyDigest: Sha256HexSchema,
    codexProtocolSchemaDigest: Sha256DigestSchema,
    sandboxAdapter: z.enum(['apple-container', 'lima-vz']),
    sandboxAdapterVersion: EvidenceTokenSchema(128),
    protocolSchemaBundleDigest: Sha256DigestSchema,
    openApiDigest: Sha256DigestSchema,
    invariantRegistryDigest: Sha256DigestSchema,
    testCaseRegistryDigest: Sha256DigestSchema,
    decisionRegistryDigest: Sha256DigestSchema,
    dataFlowAllowlistDigest: Sha256DigestSchema,
    artifactIndexDigest: Sha256DigestSchema,
    testSuiteDigest: Sha256DigestSchema,
    macosBuild: EvidenceTokenSchema(128),
    kernelBuild: EvidenceTokenSchema(128),
    testBuildMode: z.literal('exact-release-artifact-with-locked-one-shot-probe'),
    startedAt: IsoDateTimeSchema,
    finishedAt: IsoDateTimeSchema,
    results: EvidenceResultCountsSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    if (Date.parse(manifest.finishedAt) < Date.parse(manifest.startedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['finishedAt'],
        message: 'finishedAt 不得早于 startedAt',
      });
    }
    if (Object.keys(manifest.cloudImageDigests).length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cloudImageDigests'],
        message: 'Evidence manifest 必须绑定至少一个 Cloud image digest',
      });
    }
    if (Object.values(manifest.results).reduce((sum, value) => sum + value, 0) === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['results'],
        message: 'Evidence manifest 必须汇总至少一个 case result',
      });
    }
  });
export type EvidenceBundleManifest = z.infer<typeof EvidenceBundleManifestSchema>;

export const EvidenceReleaseTupleSchema = z
  .object({
    protocol: z.literal(EVIDENCE_RELEASE_TUPLE_PROTOCOL),
    schemaVersion: z.literal(1),
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
    cloudImageDigests: z.record(z.string().regex(/^[a-z][a-z0-9-]{1,63}$/u), Sha256DigestSchema),
    workerArtifactDigest: Sha256DigestSchema,
    codexArtifactDigest: Sha256DigestSchema,
    sandboxImageDigest: Sha256DigestSchema,
    modelProxyArtifactDigest: Sha256DigestSchema,
    agentVersionDigest: Sha256HexSchema,
    snapshotDigest: Sha256HexSchema,
    behaviorContractDigest: Sha256HexSchema,
    runtimePolicyDigest: Sha256HexSchema,
    codexProtocolSchemaDigest: Sha256DigestSchema,
    sandboxAdapter: z.enum(['apple-container', 'lima-vz']),
    sandboxAdapterVersion: EvidenceTokenSchema(128),
    protocolSchemaBundleDigest: Sha256DigestSchema,
    openApiDigest: Sha256DigestSchema,
    invariantRegistryDigest: Sha256DigestSchema,
    testCaseRegistryDigest: Sha256DigestSchema,
    decisionRegistryDigest: Sha256DigestSchema,
    dataFlowAllowlistDigest: Sha256DigestSchema,
    macosBuild: EvidenceTokenSchema(128),
    kernelBuild: EvidenceTokenSchema(128),
    testBuildMode: z.literal('exact-release-artifact-with-locked-one-shot-probe'),
  })
  .strict();
export type EvidenceReleaseTuple = z.infer<typeof EvidenceReleaseTupleSchema>;

export function evidenceReleaseTupleFromManifest(
  manifest: EvidenceBundleManifest,
): EvidenceReleaseTuple {
  const parsed = EvidenceBundleManifestSchema.parse(manifest);
  return EvidenceReleaseTupleSchema.parse({
    protocol: EVIDENCE_RELEASE_TUPLE_PROTOCOL,
    schemaVersion: 1,
    sourceSha: parsed.sourceSha,
    cloudImageDigests: parsed.cloudImageDigests,
    workerArtifactDigest: parsed.workerArtifactDigest,
    codexArtifactDigest: parsed.codexArtifactDigest,
    sandboxImageDigest: parsed.sandboxImageDigest,
    modelProxyArtifactDigest: parsed.modelProxyArtifactDigest,
    agentVersionDigest: parsed.agentVersionDigest,
    snapshotDigest: parsed.snapshotDigest,
    behaviorContractDigest: parsed.behaviorContractDigest,
    runtimePolicyDigest: parsed.runtimePolicyDigest,
    codexProtocolSchemaDigest: parsed.codexProtocolSchemaDigest,
    sandboxAdapter: parsed.sandboxAdapter,
    sandboxAdapterVersion: parsed.sandboxAdapterVersion,
    protocolSchemaBundleDigest: parsed.protocolSchemaBundleDigest,
    openApiDigest: parsed.openApiDigest,
    invariantRegistryDigest: parsed.invariantRegistryDigest,
    testCaseRegistryDigest: parsed.testCaseRegistryDigest,
    decisionRegistryDigest: parsed.decisionRegistryDigest,
    dataFlowAllowlistDigest: parsed.dataFlowAllowlistDigest,
    macosBuild: parsed.macosBuild,
    kernelBuild: parsed.kernelBuild,
    testBuildMode: parsed.testBuildMode,
  });
}

export function evidenceReleaseTupleDigest(manifest: EvidenceBundleManifest): string {
  return `sha256:${canonicalSha256(evidenceReleaseTupleFromManifest(manifest))}`;
}

export const EvidenceSupportingArtifactPathSchema = z.enum([
  'environment.json',
  'junit/index.json',
  'contract-fixtures/index.json',
  'digests/index.json',
  'metrics-summary.json',
  'fault-summary.json',
  'isolation-summary.json',
  'dr-summary.json',
  'privacy-scan.json',
]);
export type EvidenceSupportingArtifactPath = z.infer<typeof EvidenceSupportingArtifactPathSchema>;

export const EvidenceBundleIndexSchema = z
  .object({
    protocol: z.literal(EVIDENCE_BUNDLE_PROTOCOL),
    schemaVersion: z.literal(1),
    artifacts: z
      .array(
        z
          .object({
            path: EvidenceSupportingArtifactPathSchema,
            digest: Sha256DigestSchema,
            bytes: z.number().int().min(1).max(1_073_741_824),
          })
          .strict(),
      )
      .length(9),
  })
  .strict()
  .superRefine((bundle, context) => {
    const paths = new Set(bundle.artifacts.map((artifact) => artifact.path));
    if (paths.size !== EvidenceSupportingArtifactPathSchema.options.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artifacts'],
        message: 'Evidence artifact index 必须逐项包含全部 9 个 supporting artifact',
      });
    }
    for (const path of EvidenceSupportingArtifactPathSchema.options) {
      if (!paths.has(path)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['artifacts'],
          message: `Evidence artifact index 缺少 ${path}`,
        });
      }
    }
    if (
      bundle.artifacts.some(
        (artifact, index) => artifact.path !== EvidenceSupportingArtifactPathSchema.options[index],
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artifacts'],
        message: 'Evidence artifact index 必须按冻结 path order 排列',
      });
    }
  });
export type EvidenceBundleIndex = z.infer<typeof EvidenceBundleIndexSchema>;

export function evidenceBundleIndexDigest(index: EvidenceBundleIndex): string {
  return `sha256:${canonicalSha256(EvidenceBundleIndexSchema.parse(index))}`;
}

export function evidenceBundleManifestDigest(manifest: EvidenceBundleManifest): string {
  return `sha256:${canonicalSha256(EvidenceBundleManifestSchema.parse(manifest))}`;
}

export const EvidenceEnvironmentSchema = z
  .object({
    protocol: z.literal(EVIDENCE_BUNDLE_PROTOCOL),
    schemaVersion: z.literal(1),
    environmentId: EvidenceEnvironmentIdSchema,
    os: EvidenceTokenSchema(256),
    architecture: z.enum(['arm64', 'x64']),
    runtimeVersions: z.record(EvidenceTokenSchema(64), EvidenceTokenSchema(256)),
    realComponents: z.array(EvidenceTokenSchema(128)).max(64),
    substitutedComponents: z.array(EvidenceTokenSchema(128)).max(64),
    capturedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((environment, context) => {
    for (const [path, values] of [
      ['realComponents', environment.realComponents],
      ['substitutedComponents', environment.substitutedComponents],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [path],
          message: '组件 ID 必须唯一',
        });
      }
      if (values.some((value, index) => index > 0 && values[index - 1]! >= value)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [path],
          message: '组件 ID 必须按 lexical order 严格递增',
        });
      }
    }
    const overlap = environment.realComponents.filter((component) =>
      environment.substitutedComponents.includes(component),
    );
    if (overlap.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['substitutedComponents'],
        message: `同一组件不得同时标记 real/substituted: ${overlap.join(',')}`,
      });
    }
  });
export type EvidenceEnvironment = z.infer<typeof EvidenceEnvironmentSchema>;

export const EvidenceEnvironmentsSchema = z
  .object({
    protocol: z.literal(EVIDENCE_BUNDLE_PROTOCOL),
    schemaVersion: z.literal(1),
    environments: z.array(EvidenceEnvironmentSchema).min(1).max(8),
  })
  .strict()
  .superRefine((summary, context) => {
    const ids = summary.environments.map((environment) => environment.environmentId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Evidence environment ID 必须唯一',
      });
    }
    if (ids.some((id, index) => index > 0 && ids[index - 1]! >= id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Evidence environments 必须按 environmentId lexical order 严格递增',
      });
    }
  });
export type EvidenceEnvironments = z.infer<typeof EvidenceEnvironmentsSchema>;

const EvidencePrivacyScannedArtifactPaths = [
  'environment.json',
  'junit/index.json',
  'contract-fixtures/index.json',
  'digests/index.json',
  'metrics-summary.json',
  'fault-summary.json',
  'isolation-summary.json',
  'dr-summary.json',
] as const;
export const EvidencePrivacyScannedArtifactPathSchema = z.enum(EvidencePrivacyScannedArtifactPaths);
const EvidencePrivacyFindingCountsSchema = z
  .object({
    credentials: z.number().int().min(0),
    authorizationMaterial: z.number().int().min(0),
    consumerPlaintext: z.number().int().min(0),
    creatorProjectContent: z.number().int().min(0),
    absolutePaths: z.number().int().min(0),
    hiddenReasoning: z.number().int().min(0),
    rawRuntimeEvents: z.number().int().min(0),
    realThreadTurnIds: z.number().int().min(0),
  })
  .strict();

export function evidencePrivacyScanScopeDigest(
  scannedArtifacts: readonly {
    path: z.infer<typeof EvidencePrivacyScannedArtifactPathSchema>;
    digest: string;
  }[],
): string {
  return `sha256:${canonicalSha256({
    protocol: EVIDENCE_BUNDLE_PROTOCOL,
    schemaVersion: 1,
    scannedArtifacts,
  })}`;
}

export const EvidencePrivacyScanSchema = z
  .object({
    protocol: z.literal(EVIDENCE_BUNDLE_PROTOCOL),
    schemaVersion: z.literal(1),
    rcId: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,127}$/u),
    scannerId: EvidenceTokenSchema(128),
    scannerVersion: EvidenceTokenSchema(128),
    scannedArtifacts: z
      .array(
        z
          .object({
            path: EvidencePrivacyScannedArtifactPathSchema,
            digest: Sha256DigestSchema,
          })
          .strict(),
      )
      .length(EvidencePrivacyScannedArtifactPaths.length),
    scopeDigest: Sha256DigestSchema,
    findingCounts: EvidencePrivacyFindingCountsSchema,
    totalForbiddenFindings: z.number().int().min(0),
    status: z.enum(['CLEAN', 'FINDINGS']),
    scannedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((scan, context) => {
    if (
      scan.scannedArtifacts.some(
        (artifact, index) => artifact.path !== EvidencePrivacyScannedArtifactPaths[index],
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scannedArtifacts'],
        message: 'Privacy scan 必须按冻结顺序覆盖 privacy-scan.json 之外全部 artifact',
      });
    }
    const total = Object.values(scan.findingCounts).reduce((sum, count) => sum + count, 0);
    if (scan.totalForbiddenFindings !== total) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['totalForbiddenFindings'],
        message: 'Privacy finding total 与分类计数不匹配',
      });
    }
    if ((total === 0) !== (scan.status === 'CLEAN')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'Privacy scan status 必须反映 forbidden finding count',
      });
    }
    if (scan.scopeDigest !== evidencePrivacyScanScopeDigest(scan.scannedArtifacts)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scopeDigest'],
        message: 'Privacy scan scopeDigest 必须绑定全部 scanned artifact digests',
      });
    }
  });
export type EvidencePrivacyScan = z.infer<typeof EvidencePrivacyScanSchema>;

export const EvidenceCaseResultSchema = z
  .object({
    protocol: z.literal(EVIDENCE_BUNDLE_PROTOCOL),
    schemaVersion: z.literal(1),
    testCaseId: TestCaseIdSchema,
    status: z.enum(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN']),
    evidenceLevel: z.enum(['E0', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8']),
    environmentId: EvidenceEnvironmentIdSchema,
    releaseTupleDigest: Sha256DigestSchema,
    startedAt: IsoDateTimeSchema,
    finishedAt: IsoDateTimeSchema,
    assertionCount: z.number().int().min(0),
    artifactDigests: z.array(Sha256DigestSchema).max(1_024),
    blockerCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{2,127}$/u)
      .nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    if (Date.parse(result.finishedAt) < Date.parse(result.startedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['finishedAt'],
        message: 'finishedAt 不得早于 startedAt',
      });
    }
    if (result.status === 'BLOCKED' && result.blockerCode === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['blockerCode'],
        message: 'BLOCKED 必须提供稳定 blockerCode',
      });
    }
    if (result.status !== 'BLOCKED' && result.blockerCode !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['blockerCode'],
        message: '只有 BLOCKED 可携带 blockerCode',
      });
    }
    if (result.status === 'PASS' && result.assertionCount < 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['assertionCount'],
        message: 'PASS 必须至少有一个可核验 assertion',
      });
    }
    if (result.status === 'PASS' && result.artifactDigests.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artifactDigests'],
        message: 'PASS 必须绑定至少一个可核验 artifact digest',
      });
    }
    if (new Set(result.artifactDigests).size !== result.artifactDigests.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artifactDigests'],
        message: 'artifactDigests 必须唯一',
      });
    }
    if (
      result.artifactDigests.some(
        (digest, index) => index > 0 && result.artifactDigests[index - 1]! >= digest,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artifactDigests'],
        message: 'artifactDigests 必须按 lexical order 严格递增',
      });
    }
  });
export type EvidenceCaseResult = z.infer<typeof EvidenceCaseResultSchema>;

export const EvidenceCaseResultsSchema = z
  .array(EvidenceCaseResultSchema)
  .min(1)
  .max(10_000)
  .superRefine((results, context) => {
    const ids = results.map((result) => result.testCaseId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Evidence case result testCaseId 必须唯一',
      });
    }
    if (ids.some((id, index) => index > 0 && ids[index - 1]! >= id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Evidence case results 必须按 testCaseId lexical order 严格递增',
      });
    }
  });

export function evidenceTestSuiteDigest(results: readonly EvidenceCaseResult[]): string {
  return `sha256:${canonicalSha256(EvidenceCaseResultsSchema.parse(results))}`;
}

export const EvidenceReviewerSignoffSchema = z
  .object({
    protocol: z.literal(EVIDENCE_BUNDLE_PROTOCOL),
    schemaVersion: z.literal(1),
    rcId: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,127}$/u),
    manifestDigest: Sha256DigestSchema,
    reviewerId: EvidenceTokenSchema(128),
    reviewerKeyId: z.string().regex(/^[a-z0-9][a-z0-9._:-]{2,127}$/u),
    reviewerRole: z.literal('independent-security-release-reviewer'),
    verdict: z.enum(['PASS', 'FAIL', 'BLOCKED']),
    reviewedGates: z.array(z.enum(['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'])).min(1),
    reviewedAt: IsoDateTimeSchema,
    nonce: Base64UrlSchema.min(22).max(128),
    signatureAlgorithm: z.literal('ES256'),
    signatureEncoding: z.literal('ieee-p1363'),
    signature: P256P1363SignatureSchema,
  })
  .strict()
  .superRefine((signoff, context) => {
    if (
      new Set(signoff.reviewedGates).size !== signoff.reviewedGates.length ||
      signoff.reviewedGates.some(
        (gate, index) => index > 0 && signoff.reviewedGates[index - 1]! >= gate,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewedGates'],
        message: 'reviewedGates 必须唯一且按 lexical order 严格递增',
      });
    }
  });
export type EvidenceReviewerSignoff = z.infer<typeof EvidenceReviewerSignoffSchema>;

export type EvidenceReviewerSignoffExpectedBinding = Pick<
  EvidenceReviewerSignoff,
  'rcId' | 'manifestDigest' | 'reviewerKeyId' | 'reviewedGates'
>;

export function evidenceReviewerSigningBytes(signoff: EvidenceReviewerSignoff): Buffer {
  const { signature: _signature, ...unsigned } = EvidenceReviewerSignoffSchema.parse(signoff);
  return Buffer.from(canonicalizeJson(unsigned), 'utf8');
}

export function validateEvidenceReviewerSignoff(
  input: unknown,
  expected: EvidenceReviewerSignoffExpectedBinding,
  registeredReviewerPublicKey: P256PublicKeyInput,
  revokedReviewerKeyIds: ReadonlySet<string>,
): { ok: true } | { ok: false; reasons: string[] } {
  const parsed = EvidenceReviewerSignoffSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reasons: ['schema'] };
  const signoff = parsed.data;
  if (revokedReviewerKeyIds.has(signoff.reviewerKeyId)) {
    return { ok: false, reasons: ['reviewer-key-revoked'] };
  }
  if (
    !verifyP256P1363Signature(
      evidenceReviewerSigningBytes(signoff),
      signoff.signature,
      registeredReviewerPublicKey,
    )
  ) {
    return { ok: false, reasons: ['signature'] };
  }
  const reasons: string[] = [];
  if (signoff.rcId !== expected.rcId) reasons.push('rcId');
  if (signoff.manifestDigest !== expected.manifestDigest) reasons.push('manifestDigest');
  if (signoff.reviewerKeyId !== expected.reviewerKeyId) reasons.push('reviewerKeyId');
  if (
    signoff.reviewedGates.length !== expected.reviewedGates.length ||
    signoff.reviewedGates.some((gate, index) => gate !== expected.reviewedGates[index])
  ) {
    reasons.push('reviewedGates');
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}

export interface EvidenceBundleChainInput {
  readonly index: unknown;
  readonly supportingArtifacts: Readonly<
    Partial<Record<EvidenceSupportingArtifactPath, Uint8Array>>
  >;
  readonly caseResults: unknown;
  readonly testCaseRegistry: unknown;
  readonly manifest: unknown;
  readonly signoff: unknown;
  readonly expected: EvidenceReviewerSignoffExpectedBinding;
  readonly registeredReviewerPublicKey: P256PublicKeyInput;
  readonly revokedReviewerKeyIds: ReadonlySet<string>;
}

function parseEvidenceJsonArtifact(bytes: Uint8Array): unknown {
  if (bytes.byteLength > 1_048_576) throw new RangeError('structured Evidence artifact 超过 1 MiB');
  return parseJsonNoDuplicateKeys(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export function validateEvidenceBundleChain(
  input: EvidenceBundleChainInput,
): { ok: true } | { ok: false; reasons: string[] } {
  const index = EvidenceBundleIndexSchema.safeParse(input.index);
  const caseResults = EvidenceCaseResultsSchema.safeParse(input.caseResults);
  const testCaseRegistry = TestCaseRegistrySchema.safeParse(input.testCaseRegistry);
  const manifest = EvidenceBundleManifestSchema.safeParse(input.manifest);
  const signoff = EvidenceReviewerSignoffSchema.safeParse(input.signoff);
  const schemaReasons = [
    ...(index.success ? [] : ['index-schema']),
    ...(caseResults.success ? [] : ['case-results-schema']),
    ...(testCaseRegistry.success ? [] : ['test-case-registry-schema']),
    ...(manifest.success ? [] : ['manifest-schema']),
    ...(signoff.success ? [] : ['signoff-schema']),
  ];
  if (
    !index.success ||
    !caseResults.success ||
    !testCaseRegistry.success ||
    !manifest.success ||
    !signoff.success
  ) {
    return { ok: false, reasons: schemaReasons };
  }
  const reasons: string[] = [];
  const testCaseRegistryDigest = `sha256:${canonicalSha256(testCaseRegistry.data)}`;
  if (manifest.data.testCaseRegistryDigest !== testCaseRegistryDigest) {
    reasons.push('testCaseRegistryDigest');
  }
  const requiredCaseIds = testCaseRegistry.data.cases.map((testCase) => testCase.id);
  const actualCaseIds = caseResults.data.map((result) => result.testCaseId);
  if (
    requiredCaseIds.length !== actualCaseIds.length ||
    requiredCaseIds.some((testCaseId, indexPosition) => testCaseId !== actualCaseIds[indexPosition])
  ) {
    reasons.push('testCaseCoverage');
  }
  const casesById = new Map(testCaseRegistry.data.cases.map((testCase) => [testCase.id, testCase]));
  const releaseTupleDigest = evidenceReleaseTupleDigest(manifest.data);
  for (const result of caseResults.data) {
    const testCase = casesById.get(result.testCaseId);
    if (testCase === undefined) continue;
    if (result.evidenceLevel !== testCase.level) {
      reasons.push(`case:${result.testCaseId}:evidenceLevel`);
    }
    if (result.environmentId !== testCase.environment) {
      reasons.push(`case:${result.testCaseId}:environmentId`);
    }
    if (result.releaseTupleDigest !== releaseTupleDigest) {
      reasons.push(`case:${result.testCaseId}:releaseTupleDigest`);
    }
    if (
      testCase.implementation.status === 'planned' &&
      result.status !== 'BLOCKED' &&
      result.status !== 'NOT_RUN'
    ) {
      reasons.push(`case:${result.testCaseId}:planned-result`);
    }
  }
  const requiredReviewedGates = [
    ...new Set(testCaseRegistry.data.cases.map((testCase) => testCase.gate)),
  ].sort();
  if (
    signoff.data.reviewedGates.length !== requiredReviewedGates.length ||
    signoff.data.reviewedGates.some(
      (gate, indexPosition) => gate !== requiredReviewedGates[indexPosition],
    )
  ) {
    reasons.push('reviewedGates');
  }
  const actualArtifactKeys = Object.keys(input.supportingArtifacts).sort();
  const expectedArtifactKeys = [...EvidenceSupportingArtifactPathSchema.options].sort();
  if (
    actualArtifactKeys.length !== expectedArtifactKeys.length ||
    actualArtifactKeys.some((key, indexPosition) => key !== expectedArtifactKeys[indexPosition])
  ) {
    reasons.push('supporting-artifact-set');
  }
  for (const artifact of index.data.artifacts) {
    const bytes = input.supportingArtifacts[artifact.path];
    if (!(bytes instanceof Uint8Array)) {
      reasons.push(`artifact:${artifact.path}:missing`);
      continue;
    }
    if (bytes.byteLength !== artifact.bytes) reasons.push(`artifact:${artifact.path}:bytes`);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (digest !== artifact.digest) reasons.push(`artifact:${artifact.path}:digest`);
  }
  let environments: z.infer<typeof EvidenceEnvironmentsSchema> | null = null;
  const environmentBytes = input.supportingArtifacts['environment.json'];
  if (environmentBytes instanceof Uint8Array) {
    try {
      const parsed = EvidenceEnvironmentsSchema.safeParse(
        parseEvidenceJsonArtifact(environmentBytes),
      );
      if (parsed.success) environments = parsed.data;
      else reasons.push('environment-schema');
    } catch {
      reasons.push('environment-schema');
    }
  }
  if (environments !== null) {
    const environmentIds = new Set(
      environments.environments.map((environment) => environment.environmentId),
    );
    for (const result of caseResults.data) {
      if (!environmentIds.has(result.environmentId)) {
        reasons.push(`case:${result.testCaseId}:environment-unregistered`);
      }
    }
  }

  let privacyScan: EvidencePrivacyScan | null = null;
  const privacyScanBytes = input.supportingArtifacts['privacy-scan.json'];
  if (privacyScanBytes instanceof Uint8Array) {
    try {
      const parsed = EvidencePrivacyScanSchema.safeParse(
        parseEvidenceJsonArtifact(privacyScanBytes),
      );
      if (parsed.success) privacyScan = parsed.data;
      else reasons.push('privacy-scan-schema');
    } catch {
      reasons.push('privacy-scan-schema');
    }
  }
  if (privacyScan !== null) {
    if (privacyScan.rcId !== manifest.data.rcId) reasons.push('privacy-scan-rcId');
    const expectedScannedArtifacts = index.data.artifacts
      .filter((artifact) => artifact.path !== 'privacy-scan.json')
      .map((artifact) => ({
        path: EvidencePrivacyScannedArtifactPathSchema.parse(artifact.path),
        digest: artifact.digest,
      }));
    if (
      privacyScan.scannedArtifacts.length !== expectedScannedArtifacts.length ||
      privacyScan.scannedArtifacts.some(
        (artifact, indexPosition) =>
          artifact.path !== expectedScannedArtifacts[indexPosition]?.path ||
          artifact.digest !== expectedScannedArtifacts[indexPosition]?.digest,
      )
    ) {
      reasons.push('privacy-scan-coverage');
    }
  }
  if (manifest.data.artifactIndexDigest !== evidenceBundleIndexDigest(index.data)) {
    reasons.push('artifactIndexDigest');
  }
  if (manifest.data.testSuiteDigest !== evidenceTestSuiteDigest(caseResults.data)) {
    reasons.push('testSuiteDigest');
  }
  const resultCounts = { pass: 0, fail: 0, blocked: 0, notRun: 0 };
  for (const result of caseResults.data) {
    if (result.status === 'PASS') resultCounts.pass += 1;
    else if (result.status === 'FAIL') resultCounts.fail += 1;
    else if (result.status === 'BLOCKED') resultCounts.blocked += 1;
    else resultCounts.notRun += 1;
  }
  if (
    Object.entries(resultCounts).some(
      ([status, count]) => manifest.data.results[status as keyof typeof resultCounts] !== count,
    )
  ) {
    reasons.push('resultCounts');
  }
  const indexedDigests = new Set(index.data.artifacts.map((artifact) => artifact.digest));
  if (
    caseResults.data.some((result) =>
      result.artifactDigests.some((digest) => !indexedDigests.has(digest)),
    )
  ) {
    reasons.push('case-result-artifact-binding');
  }
  if (signoff.data.manifestDigest !== evidenceBundleManifestDigest(manifest.data)) {
    reasons.push('manifestDigest');
  }
  if (manifest.data.rcId !== signoff.data.rcId || manifest.data.rcId !== input.expected.rcId) {
    reasons.push('rcId');
  }
  const requiredVerdict =
    manifest.data.results.fail > 0 || (privacyScan?.totalForbiddenFindings ?? 0) > 0
      ? 'FAIL'
      : manifest.data.results.blocked > 0 || manifest.data.results.notRun > 0
        ? 'BLOCKED'
        : 'PASS';
  if (signoff.data.verdict !== requiredVerdict) reasons.push('verdict');
  const signatureResult = validateEvidenceReviewerSignoff(
    signoff.data,
    { ...input.expected, reviewedGates: requiredReviewedGates },
    input.registeredReviewerPublicKey,
    input.revokedReviewerKeyIds,
  );
  if (!signatureResult.ok) reasons.push(...signatureResult.reasons);
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons: [...new Set(reasons)] };
}
