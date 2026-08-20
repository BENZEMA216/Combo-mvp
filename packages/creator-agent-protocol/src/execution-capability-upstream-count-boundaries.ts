import { z } from 'zod';

import { Sha256DigestSchema } from './primitives.js';

export const EXECUTION_CAPABILITY_UPSTREAM_COUNT_BOUNDARY_CORPUS =
  'combo.execution-capability-upstream-count-boundaries/1' as const;

const BoundaryProbeCommonSchema = z
  .object({
    id: z.enum(['unused-zero', 'dispatched-one', 'dispatched-two']),
    providerUpstreamRequestCount: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    state: z.enum(['UNUSED', 'DISPATCHED']),
    canonicalRecordDigest: Sha256DigestSchema,
    schemaExpected: z.enum(['accepted', 'rejected']),
    sqliteExpected: z.enum(['accepted', 'rejected']),
  })
  .strict();

/**
 * Digest-bound P0 sub-evidence for the one-use Provider upstream counter.
 * This corpus proves the numeric owner boundary only; it is not the real
 * Provider sink, concurrency/fault matrix, 10k sequence, E4 or E6 gate.
 */
export const ExecutionCapabilityUpstreamCountBoundaryCorpusSchema = z
  .object({
    protocol: z.literal(EXECUTION_CAPABILITY_UPSTREAM_COUNT_BOUNDARY_CORPUS),
    schemaVersion: z.literal(1),
    scope: z.literal('provider-upstream-count-only'),
    evidenceClass: z.literal('schema-decision-contract-and-real-file-sqlite-only'),
    authority: z
      .object({
        invariantId: z.literal('INV-010'),
        severity: z.literal('P0'),
        gates: z.tuple([z.literal('G0'), z.literal('G4')]),
        decisionRegistryId: z.literal('ADR-VNEXT-010'),
        technicalPlanSection: z.literal('技术方案 §12.1 Invocation Journal 与状态机'),
        testPlanSections: z.tuple([
          z.literal('测试方案 §2 INV-010'),
          z.literal('测试方案 §12.1/§12.3 at-most-once'),
          z.literal('测试方案 §16.3 Provider upstream sink'),
        ]),
        additiveRegistryCaseId: z.literal('SCH-004'),
      })
      .strict(),
    checkedArtifactDigests: z
      .object({
        contractSchemas: Sha256DigestSchema,
      })
      .strict(),
    baseFixture: z
      .object({
        path: z.literal('broker-invocation-prepare.v1.json'),
        digest: Sha256DigestSchema,
      })
      .strict(),
    runtimeOwners: z.tuple([
      z.literal('ExecutionCapabilityUseRecordSchema'),
      z.literal('decideExecutionCapabilityUse'),
    ]),
    advertisedConstraint: z
      .object({
        artifact: z.literal('contractSchemas'),
        owner: z.literal('ExecutionCapabilityUseRecord'),
        jsonSchemaKeyword: z.literal('maximum'),
        maximum: z.literal(1),
        artifactPointer: z.literal(
          '/schemas/ExecutionCapabilityUseRecord/definitions/ExecutionCapabilityUseRecord/properties/providerUpstreamRequestCount',
        ),
      })
      .strict(),
    durableOwner: z
      .object({
        owner: z.literal('SqliteExecutionCapabilityUseStore'),
        table: z.literal('execution_capability_uses'),
        column: z.literal('provider_upstream_request_count'),
        check: z.literal('provider_upstream_request_count BETWEEN 0 AND 1'),
        publicGate: z.literal('SqliteVerifiedExecutionCapabilityGate'),
      })
      .strict(),
    outcomeCounts: z
      .object({
        runtimeSchema: z.literal(3),
        runtimeDecision: z.literal(3),
        advertisedContract: z.literal(3),
        realFileSqlite: z.literal(3),
        total: z.literal(12),
      })
      .strict(),
    exclusions: z.tuple([
      z.literal('real-provider-upstream-sink'),
      z.literal('multi-process-concurrency'),
      z.literal('crash-and-network-fault-matrix'),
      z.literal('ten-thousand-random-sequences'),
      z.literal('real-linux-codex-e4'),
      z.literal('chaos-recovery-e6'),
      z.literal('does-not-complete-inv-010'),
      z.literal('does-not-complete-sch-004'),
    ]),
    probes: z.tuple([
      BoundaryProbeCommonSchema.extend({
        id: z.literal('unused-zero'),
        providerUpstreamRequestCount: z.literal(0),
        state: z.literal('UNUSED'),
        canonicalRecordDigest: z.literal(
          'sha256:74a7048591d62084255a0afdcfb9de5a6b65f3524a5acd4358a299b5b52339c0',
        ),
        schemaExpected: z.literal('accepted'),
        sqliteExpected: z.literal('accepted'),
        decisionExpected: z
          .object({
            action: z.literal('DISPATCH_ONCE'),
            nextProviderUpstreamRequestCount: z.literal(1),
          })
          .strict(),
      }).strict(),
      BoundaryProbeCommonSchema.extend({
        id: z.literal('dispatched-one'),
        providerUpstreamRequestCount: z.literal(1),
        state: z.literal('DISPATCHED'),
        canonicalRecordDigest: z.literal(
          'sha256:6738ef1a621793ac4c9e53c9647e61be948722ec2c9f4f9f8fb5aef640f899ae',
        ),
        schemaExpected: z.literal('accepted'),
        sqliteExpected: z.literal('accepted'),
        decisionExpected: z
          .object({
            action: z.literal('RETURN_IN_PROGRESS'),
            existingProviderUpstreamRequestCount: z.literal(1),
          })
          .strict(),
      }).strict(),
      BoundaryProbeCommonSchema.extend({
        id: z.literal('dispatched-two'),
        providerUpstreamRequestCount: z.literal(2),
        state: z.literal('DISPATCHED'),
        canonicalRecordDigest: z.literal(
          'sha256:a6b8008128533f55a4c729e8481073736fca0fa44d6bc12d2e855f48a03e73ab',
        ),
        schemaExpected: z.literal('rejected'),
        sqliteExpected: z.literal('rejected'),
        decisionExpected: z
          .object({
            action: z.literal('SECURITY_BLOCK'),
            code: z.literal('CAPABILITY_LEDGER_INVALID'),
          })
          .strict(),
      }).strict(),
    ]),
  })
  .strict();

export type ExecutionCapabilityUpstreamCountBoundaryCorpus = z.infer<
  typeof ExecutionCapabilityUpstreamCountBoundaryCorpusSchema
>;
