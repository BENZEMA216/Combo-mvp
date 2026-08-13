import { z } from 'zod';
import {
  IsoDateTimeSchema,
  Sha256DigestSchema,
  Sha256HexSchema,
  Utf8TextSchema,
} from './primitives.js';

export const EVIDENCE_BUNDLE_PROTOCOL = 'combo.vnext-evidence-bundle/1' as const;

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
    sandboxAdapterVersion: Utf8TextSchema(128),
    testSuiteDigest: Sha256DigestSchema,
    macosBuild: Utf8TextSchema(128),
    kernelBuild: Utf8TextSchema(128),
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
  });
export type EvidenceBundleManifest = z.infer<typeof EvidenceBundleManifestSchema>;

export const EvidenceArtifactPathSchema = z.enum([
  'manifest.json',
  'environment.json',
  'junit/index.json',
  'contract-fixtures/index.json',
  'digests/index.json',
  'metrics-summary.json',
  'fault-summary.json',
  'isolation-summary.json',
  'dr-summary.json',
  'privacy-scan.json',
  'reviewer-signoff.json',
]);

export const EvidenceBundleIndexSchema = z
  .object({
    protocol: z.literal(EVIDENCE_BUNDLE_PROTOCOL),
    schemaVersion: z.literal(1),
    manifestDigest: Sha256DigestSchema,
    artifacts: z
      .array(
        z
          .object({
            path: EvidenceArtifactPathSchema,
            digest: Sha256DigestSchema,
            bytes: z.number().int().min(0).max(1_073_741_824),
          })
          .strict(),
      )
      .length(11),
  })
  .strict()
  .superRefine((bundle, context) => {
    const paths = new Set(bundle.artifacts.map((artifact) => artifact.path));
    if (paths.size !== 11) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['artifacts'],
        message: 'Evidence Bundle 必须逐项包含 11 个唯一 artifact',
      });
    }
  });
export type EvidenceBundleIndex = z.infer<typeof EvidenceBundleIndexSchema>;

export const EvidenceEnvironmentSchema = z
  .object({
    protocol: z.literal(EVIDENCE_BUNDLE_PROTOCOL),
    schemaVersion: z.literal(1),
    environmentId: z.enum([
      'T0-LINUX-CI',
      'T1-SERVICE-CI',
      'T2-LOCAL-CONTRACT',
      'T3-MAC-REAL-HOST',
      'T4-MAC-ISOLATION',
      'T5-K3S-TEST',
      'T6-FULL-E2E',
      'T7-DR',
    ]),
    os: Utf8TextSchema(256),
    architecture: z.enum(['arm64', 'x64']),
    runtimeVersions: z.record(z.string().min(1).max(64), z.string().min(1).max(256)),
    realComponents: z.array(z.string().min(1).max(128)).max(64),
    substitutedComponents: z.array(z.string().min(1).max(128)).max(64),
    capturedAt: IsoDateTimeSchema,
  })
  .strict();
export type EvidenceEnvironment = z.infer<typeof EvidenceEnvironmentSchema>;
