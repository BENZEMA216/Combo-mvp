import { z } from 'zod';

import { RequiredUnicodeScalarNoControlStringSchema } from './primitives.js';

export const BROKER_CAPACITY_BOUNDARY_CORPUS = 'combo.broker-capacity-boundaries/1' as const;

const JsonPointerSchema = RequiredUnicodeScalarNoControlStringSchema.min(1)
  .max(2_048)
  .regex(/^\/(?:[^~]|~[01])*$/u);

const BoundaryProbeSchema = z
  .object({
    delta: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
    value: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    expected: z.enum(['accepted', 'rejected']),
  })
  .strict();

const AdvertisedConstraintSchema = z
  .object({
    artifact: z.enum(['contractSchemas', 'brokerContract']),
    field: z.enum(['maxActiveConversations', 'maxActiveTurns']),
    jsonSchemaKeyword: z.literal('const'),
    artifactPointer: JsonPointerSchema,
  })
  .strict();

/**
 * Digest-bound SCH-004 evidence for the two singleton Broker handshake capacity fields.
 * This corpus proves contract and real transport handshake admission only. It deliberately
 * does not claim Creator/Conversation WIP enforcement, queue capacity, or real inference load.
 */
export const BrokerCapacityBoundaryCorpusSchema = z
  .object({
    protocol: z.literal(BROKER_CAPACITY_BOUNDARY_CORPUS),
    schemaVersion: z.literal(1),
    scope: z.literal('broker-handshake-capacity-singleton-only'),
    evidenceClass: z.literal('contract-and-real-transport-handshake-only'),
    authority: z
      .object({
        technicalPlanSections: z.tuple([
          z.literal('技术方案 §11.1 Worker 握手'),
          z.literal('技术方案 §7.3、§12.8、§17.3 WIP=1'),
        ]),
        testPlanSections: z.tuple([
          z.literal('测试方案 §6.1 SCH-004'),
          z.literal('测试方案 §3.2 E3 Contract/Fake System'),
          z.literal('测试方案 §21.2 Alpha 容量场景'),
        ]),
        testCaseId: z.literal('SCH-004'),
      })
      .strict(),
    exclusions: z.tuple([
      z.literal('agent-version-runtime-policy-max-active-turns'),
      z.literal('creator-and-conversation-wip-enforcement'),
      z.literal('queue-postgresql-advisory-and-sqlite-capacity'),
      z.literal('creator-http-openapi'),
      z.literal('tls-wss-termination-and-public-ingress'),
      z.literal('real-inference-cloud-capacity-and-soak'),
    ]),
    checkedArtifactDigests: z
      .object({
        contractSchemas: z.literal(
          'sha256:ebbd5e475380de98a17e29f4ae2c0d6af3ad6ceaabc7e02bbc335eddc4ed24eb',
        ),
        brokerContract: z.literal(
          'sha256:3e8a6a4f907f3b656ee2cfdac8b4b17f49d42f596c0ffcfa1884d843c343795f',
        ),
        advertisedBrokerContract: z.literal(
          'sha256:347769d71019a3707611d8a9be365b735e2aefcb35f53c55be53787ae98c131f',
        ),
      })
      .strict(),
    baseFixture: z
      .object({
        path: z.literal('broker-handshake.v1.json'),
        digest: z.literal(
          'sha256:c87cec938a3be231a97feca8eec8e1595022f9880893022607c815607f5ab016',
        ),
      })
      .strict(),
    runtimeOwners: z.tuple([
      z.literal('BrokerCapacitySchema'),
      z.literal('BrokerHandshakeUnsignedSchema'),
      z.literal('BrokerHandshakeSchema'),
      z.literal('parseBrokerHandshake'),
    ]),
    advertisedConstraints: z.tuple([
      AdvertisedConstraintSchema.extend({
        artifact: z.literal('contractSchemas'),
        field: z.literal('maxActiveConversations'),
        artifactPointer: z.literal(
          '/schemas/BrokerHandshake/definitions/BrokerHandshake/properties/capacity/properties/maxActiveConversations',
        ),
      }),
      AdvertisedConstraintSchema.extend({
        artifact: z.literal('contractSchemas'),
        field: z.literal('maxActiveTurns'),
        artifactPointer: z.literal(
          '/schemas/BrokerHandshake/definitions/BrokerHandshake/properties/capacity/properties/maxActiveTurns',
        ),
      }),
      AdvertisedConstraintSchema.extend({
        artifact: z.literal('brokerContract'),
        field: z.literal('maxActiveConversations'),
        artifactPointer: z.literal(
          '/schemas/BrokerHandshake/definitions/BrokerHandshake/properties/capacity/properties/maxActiveConversations',
        ),
      }),
      AdvertisedConstraintSchema.extend({
        artifact: z.literal('brokerContract'),
        field: z.literal('maxActiveTurns'),
        artifactPointer: z.literal(
          '/schemas/BrokerHandshake/definitions/BrokerHandshake/properties/capacity/properties/maxActiveTurns',
        ),
      }),
    ]),
    transportOwners: z.tuple([
      z.literal('AgentGateway.acceptHandshake'),
      z.literal('WorkerBrokerClient.createHandshake'),
    ]),
    outcomeCounts: z
      .object({
        protocolRuntime: z.literal(24),
        advertisedArtifacts: z.literal(12),
        gatewayTransport: z.literal(6),
        workerTransport: z.literal(2),
        total: z.literal(44),
      })
      .strict(),
    boundaries: z.tuple([
      z
        .object({
          id: z.literal('broker-capacity-max-active-conversations'),
          field: z.literal('maxActiveConversations'),
          maximum: z.literal(1),
          probes: z.tuple([
            BoundaryProbeSchema.extend({
              delta: z.literal(-1),
              value: z.literal(0),
              expected: z.literal('rejected'),
            }),
            BoundaryProbeSchema.extend({
              delta: z.literal(0),
              value: z.literal(1),
              expected: z.literal('accepted'),
            }),
            BoundaryProbeSchema.extend({
              delta: z.literal(1),
              value: z.literal(2),
              expected: z.literal('rejected'),
            }),
          ]),
        })
        .strict(),
      z
        .object({
          id: z.literal('broker-capacity-max-active-turns'),
          field: z.literal('maxActiveTurns'),
          maximum: z.literal(1),
          probes: z.tuple([
            BoundaryProbeSchema.extend({
              delta: z.literal(-1),
              value: z.literal(0),
              expected: z.literal('rejected'),
            }),
            BoundaryProbeSchema.extend({
              delta: z.literal(0),
              value: z.literal(1),
              expected: z.literal('accepted'),
            }),
            BoundaryProbeSchema.extend({
              delta: z.literal(1),
              value: z.literal(2),
              expected: z.literal('rejected'),
            }),
          ]),
        })
        .strict(),
    ]),
  })
  .strict();

export type BrokerCapacityBoundaryCorpus = z.infer<typeof BrokerCapacityBoundaryCorpusSchema>;
