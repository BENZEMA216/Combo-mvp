import { z } from 'zod';
import { IsoDateTimeSchema, Sha256DigestSchema } from './primitives.js';

export const TEST_REGISTRY_PROTOCOL = 'combo.vnext-test-registry/1' as const;
export const INVARIANT_REGISTRY_PROTOCOL = 'combo.vnext-invariant-registry/1' as const;
export const DECISION_REGISTRY_PROTOCOL = 'combo.vnext-decision-registry/1' as const;
export const DATA_FLOW_ALLOWLIST_PROTOCOL = 'combo.vnext-data-flow-allowlist/1' as const;

export const InvariantIdSchema = z.string().regex(/^INV-\d{3}$/u);
export const TestCaseIdSchema = z
  .string()
  .regex(
    /^(?:SCH|SNP|AVR|DEP|BRK|CJR|WJR|HST|RTP|ISO|CRD|CRT|CON|SEC|FLT|PER|K8S|BKP|OBS|E2E|AQL)-[A-Z0-9-]+$/u,
  );

export const InvariantRegistrySchema = z
  .object({
    protocol: z.literal(INVARIANT_REGISTRY_PROTOCOL),
    schemaVersion: z.literal(1),
    invariants: z
      .array(
        z
          .object({
            id: InvariantIdSchema,
            statement: z.string().min(1).max(1_024),
            severity: z.enum(['P0', 'P1']),
            gates: z.array(z.enum(['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'])).min(1),
            owners: z.array(z.string().min(1).max(64)).min(1),
          })
          .strict(),
      )
      .length(25),
  })
  .strict();
export type InvariantRegistry = z.infer<typeof InvariantRegistrySchema>;

export const TestCaseSchema = z
  .object({
    id: TestCaseIdSchema,
    title: z.string().min(1).max(256),
    level: z.enum(['E0', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7']),
    environment: z.enum([
      'T0-LINUX-CI',
      'T1-SERVICE-CI',
      'T2-LOCAL-CONTRACT',
      'T3-MAC-REAL-HOST',
      'T4-MAC-ISOLATION',
      'T5-K3S-TEST',
      'T6-FULL-E2E',
      'T7-DR',
    ]),
    invariants: z.array(InvariantIdSchema).min(1),
    fixture: z.array(z.string().min(1).max(256)).min(1),
    fault: z.array(z.string().min(1).max(256)),
    steps: z.array(z.string().min(1).max(512)),
    assertions: z.array(z.string().min(1).max(512)).min(1),
    evidence: z.array(z.string().min(1).max(256)).min(1),
    frequency: z.enum([
      'every-pr',
      'merge-integration',
      'nightly',
      'runtime-rc',
      'cloud-rc',
      'alpha-release',
    ]),
    owner: z.string().min(1).max(64),
    reviewer: z.string().min(1).max(64),
    gate: z.enum(['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8']),
    implementation: z
      .object({
        status: z.enum(['implemented', 'planned']),
        testFiles: z.array(z.string().min(1).max(512)),
      })
      .strict(),
    releaseTuple: z.array(z.string().min(1).max(128)).min(1),
    fixtureDigests: z.array(Sha256DigestSchema),
  })
  .strict();
export type TestCase = z.infer<typeof TestCaseSchema>;

export const TestCaseRegistrySchema = z
  .object({
    protocol: z.literal(TEST_REGISTRY_PROTOCOL),
    schemaVersion: z.literal(1),
    cases: z.array(TestCaseSchema).min(1),
  })
  .strict();
export type TestCaseRegistry = z.infer<typeof TestCaseRegistrySchema>;

export const DecisionRegistrySchema = z
  .object({
    protocol: z.literal(DECISION_REGISTRY_PROTOCOL),
    schemaVersion: z.literal(1),
    decisions: z
      .array(
        z
          .object({
            id: z.string().regex(/^ADR-VNEXT-\d{3}$/u),
            title: z.string().min(1).max(256),
            status: z.literal('accepted'),
            owner: z.string().min(1).max(64),
            decidedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
            decision: z.string().min(1).max(2_048),
            alternatives: z.array(z.string().min(1).max(1_024)).min(1),
            evidence: z.array(z.string().min(1).max(512)).min(1),
            securityImpact: z.string().min(1).max(2_048),
            reversalTriggers: z.array(z.string().min(1).max(1_024)).min(1),
            protocolVersions: z.array(z.string().min(1).max(128)).min(1),
            document: z.string().regex(/^docs\/vnext\/adr\/ADR-VNEXT-\d{3}\.md$/u),
          })
          .strict(),
      )
      .length(20),
  })
  .strict();
export type DecisionRegistry = z.infer<typeof DecisionRegistrySchema>;

export const DataFlowAllowlistSchema = z
  .object({
    protocol: z.literal(DATA_FLOW_ALLOWLIST_PROTOCOL),
    schemaVersion: z.literal(1),
    fields: z
      .array(
        z
          .object({
            fieldClass: z.enum([
              'prompt',
              'answer',
              'context',
              'control-id',
              'credential',
              'absolute-path',
              'reasoning',
            ]),
            allowedStores: z.array(
              z.enum([
                'pg-message-aead',
                'worker-sqlite-result-aead',
                'minio-snapshot-aead',
                'browser-memory',
                'model-request-ephemeral',
                'evidence-vault-test-only',
              ]),
            ),
            forbiddenStores: z.array(
              z.enum([
                'application-log',
                'audit-event-payload',
                'telemetry',
                'browser-persistent-storage',
                'evidence-public',
                'process-argv',
                'process-env',
              ]),
            ),
            encryption: z.enum([
              'message-aead',
              'snapshot-envelope-aead',
              'ephemeral-only',
              'forbidden',
            ]),
            keyOwner: z.enum(['combo-kms', 'worker-keychain', 'none']),
            retention: z.enum([
              'request-lifetime',
              'sandbox-lifetime',
              '7-days',
              '30-days',
              '90-days',
              'referenced-plus-30-days',
              'never',
            ]),
            deletionOrHold: z.string().min(1).max(1_024),
          })
          .strict(),
      )
      .length(7),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type DataFlowAllowlist = z.infer<typeof DataFlowAllowlistSchema>;
