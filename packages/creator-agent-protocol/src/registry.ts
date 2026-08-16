import { z } from 'zod';
import { parse } from 'yaml';
import { IsoDateTimeSchema, Sha256DigestSchema } from './primitives.js';

export const TEST_REGISTRY_PROTOCOL = 'combo.vnext-test-registry/1' as const;
export const INVARIANT_REGISTRY_PROTOCOL = 'combo.vnext-invariant-registry/1' as const;
export const DECISION_REGISTRY_PROTOCOL = 'combo.vnext-decision-registry/1' as const;
export const DATA_FLOW_ALLOWLIST_PROTOCOL = 'combo.vnext-data-flow-allowlist/1' as const;
export const BROKER_CONTRACT_REGISTRY_PROTOCOL = 'combo.vnext-broker-contract-registry/1' as const;

export const BrokerContractRegistrySchema = z
  .object({
    protocol: z.literal(BROKER_CONTRACT_REGISTRY_PROTOCOL),
    schemaVersion: z.literal(1),
    contracts: z.tuple([
      z
        .object({
          wireProtocol: z.literal('combo.creator-broker/1'),
          artifactPath: z.literal(
            'packages/creator-agent-protocol/schemas/broker-contract.v1.json',
          ),
          contractDigest: Sha256DigestSchema,
        })
        .strict(),
    ]),
  })
  .strict();
export type BrokerContractRegistry = z.infer<typeof BrokerContractRegistrySchema>;

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
          .strict()
          .superRefine((invariant, context) => {
            assertUniqueValues(invariant.gates, context, ['gates']);
            assertUniqueValues(invariant.owners, context, ['owners']);
          }),
      )
      .length(25),
  })
  .strict()
  .superRefine((registry, context) => {
    assertUniqueSortedIds(
      registry.invariants.map((invariant) => invariant.id),
      context,
      ['invariants'],
    );
  });
export type InvariantRegistry = z.infer<typeof InvariantRegistrySchema>;

export const TestCaseSchema = z
  .object({
    id: TestCaseIdSchema,
    title: z.string().min(1).max(256),
    level: z.enum(['E0', 'E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8']),
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
  .strict()
  .superRefine((testCase, context) => {
    for (const [path, values] of [
      ['invariants', testCase.invariants],
      ['fixture', testCase.fixture],
      ['fault', testCase.fault],
      ['evidence', testCase.evidence],
      ['releaseTuple', testCase.releaseTuple],
      ['implementation.testFiles', testCase.implementation.testFiles],
    ] as const) {
      assertUniqueValues(values, context, path.split('.'));
    }
    if (testCase.implementation.status === 'implemented') {
      if (testCase.implementation.testFiles.length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['implementation', 'testFiles'],
          message: 'implemented case 必须绑定至少一个 test file',
        });
      }
      if (testCase.fixtureDigests.length !== testCase.fixture.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fixtureDigests'],
          message: 'implemented case 的每个 fixture 必须有同位置 digest',
        });
      }
    }
    if (
      testCase.implementation.status === 'planned' &&
      testCase.implementation.testFiles.length !== 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['implementation', 'testFiles'],
        message: 'planned case 不得用未验收 test file 暗示已实现',
      });
    }
  });
export type TestCase = z.infer<typeof TestCaseSchema>;

export const TestCaseRegistrySchema = z
  .object({
    protocol: z.literal(TEST_REGISTRY_PROTOCOL),
    schemaVersion: z.literal(1),
    cases: z.array(TestCaseSchema).min(1),
  })
  .strict()
  .superRefine((registry, context) => {
    assertUniqueSortedIds(
      registry.cases.map((testCase) => testCase.id),
      context,
      ['cases'],
    );
  });
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
          .strict()
          .superRefine((decision, context) => {
            assertUniqueValues(decision.alternatives, context, ['alternatives']);
            assertUniqueValues(decision.evidence, context, ['evidence']);
            assertUniqueValues(decision.reversalTriggers, context, ['reversalTriggers']);
            assertUniqueValues(decision.protocolVersions, context, ['protocolVersions']);
          }),
      )
      .length(20),
  })
  .strict()
  .superRefine((registry, context) => {
    assertUniqueSortedIds(
      registry.decisions.map((decision) => decision.id),
      context,
      ['decisions'],
    );
  });
export type DecisionRegistry = z.infer<typeof DecisionRegistrySchema>;

const DataFlowFieldClassSchema = z.enum(['prompt', 'answer', 'context']);
const DataFlowContentKindSchema = z.enum(['real', 'synthetic-test-only']);
const DataFlowSystemSchema = z.enum([
  'postgresql',
  'postgresql-backup',
  'worker-sqlite',
  'worker-backup',
  'minio',
  'minio-backup',
  'broker-wss',
  'browser',
  'model-request',
  'evidence-vault',
]);
const DataFlowProtectionSchema = z.enum([
  'application-aead',
  'session-aead',
  'browser-memory-only',
  'request-memory-only',
  'evidence-aead',
  'wrapped-key-envelope-metadata',
  'digest-linked-metadata',
]);
const DataFlowAlgorithmSchema = z.enum([
  'aes-256-gcm/v1',
  'worker-session-aes-256-gcm/v1',
  'memory-only',
  'independent-test-aes-256-gcm/v1',
  'rfc3394-aes-256-kw/v1',
  'sha-256/v1',
]);
const DataFlowKeyOwnerSchema = z.enum([
  'combo-kms',
  'worker-keychain',
  'combo-kms-and-worker-keychain',
  'independent-test-kek',
  'none',
]);
const DataFlowAadBindingSchema = z.enum([
  'agentVersionDigest',
  'archiveDigest',
  'artifactPath',
  'cipherObjectFormat',
  'conversationId',
  'creatorId',
  'installationId',
  'invocationId',
  'keyId',
  'messageId',
  'objectKey',
  'ownerId',
  'plaintextBytes',
  'protocol',
  'rcId',
  'role',
  'schemaVersion',
  'snapshotDigest',
  'workerSessionId',
]);

const DataFlowObservationShape = {
  fieldClass: DataFlowFieldClassSchema,
  contentKind: DataFlowContentKindSchema,
  system: DataFlowSystemSchema,
  container: z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/u),
  field: z.string().regex(/^[a-z][A-Za-z0-9_.[\]-]{0,255}$/u),
  protection: DataFlowProtectionSchema,
  algorithm: DataFlowAlgorithmSchema,
  keyOwner: DataFlowKeyOwnerSchema,
  aadBindings: z.array(DataFlowAadBindingSchema).max(12),
} as const;

export const DataFlowObservationSchema = z.object(DataFlowObservationShape).strict();
export type DataFlowObservation = z.infer<typeof DataFlowObservationSchema>;

export const DataFlowFieldSchema = z
  .object({
    fieldId: z.string().regex(/^(?:prompt|answer|context)\.[a-z0-9][a-z0-9._-]{2,255}$/u),
    ...DataFlowObservationShape,
    retention: z.enum([
      'request-lifetime',
      'browser-session',
      'conversation-30-days',
      'backup-14-daily-8-weekly',
      'worker-cloud-committed-plus-7-days',
      'referenced-plus-30-days',
      'evidence-vault-7-days',
    ]),
    deletionOrHold: z.string().min(1).max(1_024),
  })
  .strict()
  .superRefine((field, context) => {
    assertUniqueValues(field.aadBindings, context, ['aadBindings']);
    if (
      field.aadBindings.some(
        (binding, index) => index > 0 && field.aadBindings[index - 1]! >= binding,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aadBindings'],
        message: 'AAD binding 必须按 lexical order 严格递增',
      });
    }
    const memoryOnly =
      field.protection === 'browser-memory-only' || field.protection === 'request-memory-only';
    if (
      memoryOnly !==
      (field.algorithm === 'memory-only' &&
        field.keyOwner === 'none' &&
        field.aadBindings.length === 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['protection'],
        message: 'memory-only location 不得伪造 AEAD；durable/session location 必须有 key 与 AAD',
      });
    }
    if ((field.system === 'evidence-vault') !== (field.contentKind === 'synthetic-test-only')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contentKind'],
        message: 'Evidence Vault 只允许 synthetic-test-only，真实正文永不进入 Evidence',
      });
    }
  });

export const DataFlowAllowlistSchema = z
  .object({
    protocol: z.literal(DATA_FLOW_ALLOWLIST_PROTOCOL),
    schemaVersion: z.literal(1),
    unlistedLocationDisposition: z.literal('SECURITY_LEAK'),
    globallyForbiddenDataClasses: z.tuple([
      z.literal('absolute-path'),
      z.literal('credential'),
      z.literal('reasoning'),
    ]),
    fields: z.array(DataFlowFieldSchema).min(1).max(128),
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((allowlist, context) => {
    assertUniqueSortedIds(
      allowlist.fields.map((field) => field.fieldId),
      context,
      ['fields'],
    );
    const locations = allowlist.fields.map(
      (field) =>
        `${field.fieldClass}\u0000${field.contentKind}\u0000${field.system}\u0000${field.container}\u0000${field.field}`,
    );
    assertUniqueValues(locations, context, ['fields']);
  });
export type DataFlowAllowlist = z.infer<typeof DataFlowAllowlistSchema>;

export type DataFlowDecision =
  | { decision: 'ALLOWED'; fieldId: string }
  | { decision: 'SECURITY_LEAK' };

/** 列表外即泄漏；不存在 store-class 通配符或 encrypted-content-column 豁免。 */
export function decideDataFlowObservation(
  observationInput: unknown,
  allowlistInput: unknown,
): DataFlowDecision {
  const observation = DataFlowObservationSchema.parse(observationInput);
  const allowlist = DataFlowAllowlistSchema.parse(allowlistInput);
  const observed = JSON.stringify(observation);
  const field = allowlist.fields.find((candidate) => {
    const { fieldId: _fieldId, retention: _retention, deletionOrHold: _hold, ...shape } = candidate;
    return JSON.stringify(shape) === observed;
  });
  return field === undefined
    ? { decision: 'SECURITY_LEAK' }
    : { decision: 'ALLOWED', fieldId: field.fieldId };
}

/** Normative YAML loader：支持本仓库 anchors/merge，并对 alias expansion 设硬上限。 */
export function parseVnextRegistryYaml(text: string): unknown {
  return parse(text, { merge: true, maxAliasCount: 1_000, uniqueKeys: true }) as unknown;
}

function assertUniqueValues(
  values: readonly unknown[],
  context: z.RefinementCtx,
  path: (string | number)[],
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path, message: '列表值必须唯一' });
  }
}

function assertUniqueSortedIds(
  ids: readonly string[],
  context: z.RefinementCtx,
  path: (string | number)[],
  requireSorted = true,
): void {
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path, message: 'ID 必须唯一' });
  }
  if (requireSorted && ids.some((id, index) => index > 0 && ids[index - 1]! >= id)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: 'ID 必须按 lexical order 严格递增',
    });
  }
}
