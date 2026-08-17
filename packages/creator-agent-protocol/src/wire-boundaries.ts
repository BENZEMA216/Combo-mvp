import { z } from 'zod';

import { Sha256DigestSchema } from './primitives.js';

export const PROTOCOL_WIRE_BOUNDARY_CORPUS = 'combo.protocol-wire-boundaries/1' as const;

const BaseFixtureSchema = (
  parser: 'parseBrokerHandshake' | 'parseBrokerFrame' | 'validateEvidenceBundleChain',
  path:
    | 'broker-handshake.v1.json'
    | 'broker-invocation-prepare.v1.json'
    | 'evidence-environments.v1.json'
    | 'evidence-privacy-scan.v1.json',
) =>
  z
    .object({
      parser: z.literal(parser),
      path: z.literal(path),
      digest: Sha256DigestSchema,
    })
    .strict();

/**
 * Independent literals and deterministic recipes for the wire/resource subset of SCH-004.
 * The corpus deliberately does not claim the remaining structural or canonical-byte classes.
 */
export const ProtocolWireBoundaryCorpusSchema = z
  .object({
    protocol: z.literal(PROTOCOL_WIRE_BOUNDARY_CORPUS),
    schemaVersion: z.literal(1),
    scope: z.literal('broker-wire-and-parsed-evidence-json-bytes-only'),
    evidenceClass: z.literal('runtime-to-advertised-alignment-only'),
    authorities: z
      .object({
        brokerFrameBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        structuredEvidenceJsonBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
    baseFixtures: z.tuple([
      BaseFixtureSchema('parseBrokerHandshake', 'broker-handshake.v1.json'),
      BaseFixtureSchema('parseBrokerFrame', 'broker-invocation-prepare.v1.json'),
      BaseFixtureSchema('validateEvidenceBundleChain', 'evidence-environments.v1.json'),
      BaseFixtureSchema('validateEvidenceBundleChain', 'evidence-privacy-scan.v1.json'),
    ]),
    structuredEvidenceOwners: z.tuple([
      z.literal('index'),
      z.literal('caseResults'),
      z.literal('testCaseRegistry'),
      z.literal('manifest'),
      z.literal('signoff'),
      z.literal('supportingArtifacts.environment.json'),
      z.literal('supportingArtifacts.privacy-scan.json'),
    ]),
    sizeOffsets: z.tuple([z.literal(-1), z.literal(0), z.literal(1)]),
    paddingByteHex: z.literal('20'),
    malformedUtf8Hex: z.tuple([
      z.literal('80'),
      z.literal('c0af'),
      z.literal('e282'),
      z.literal('eda080'),
      z.literal('f4908080'),
    ]),
    duplicateKeyOwners: z.tuple([z.literal('root'), z.literal('nested')]),
    ingressOwners: z.tuple([
      z.literal('protocol'),
      z.literal('agent-gateway-loopback-websocket'),
      z.literal('worker-broker-client-loopback-websocket'),
    ]),
    advertisedBoundary: z
      .object({
        artifact: z.literal('schemas/broker-contract.v1.json'),
        digest: z.literal(
          'sha256:3e8a6a4f907f3b656ee2cfdac8b4b17f49d42f596c0ffcfa1884d843c343795f',
        ),
        pointer: z.literal('/maxFrameBytes'),
        maximumBytes: z.literal(65_536),
        authorityKind: z.literal('runtime-to-advertised-alignment-only'),
      })
      .strict(),
    actualIngressPhases: z.tuple([
      z.literal('agent-gateway-handshake'),
      z.literal('agent-gateway-established-frame'),
      z.literal('worker-broker-client-first-lease'),
      z.literal('worker-broker-client-established-frame'),
    ]),
    outcomeCounts: z
      .object({
        protocolParsers: z.literal(6),
        actualIngress: z.literal(12),
        total: z.literal(18),
      })
      .strict(),
    actualIngressExclusions: z.tuple([
      z.literal('tls-and-public-wss'),
      z.literal('fragmentation-and-extension-negotiation'),
      z.literal('load-and-backpressure'),
      z.literal('e3-public-cloud-ingress'),
      z.literal('production'),
      z.literal('does-not-freeze-65536-as-product-policy'),
      z.literal('does-not-complete-sch-004'),
    ]),
    remainingBoundaryClasses: z.tuple([
      z.literal('other-structural-string-patterns'),
      z.literal('array-count'),
      z.literal('map-property-count'),
      z.literal('numeric-maximum'),
      z.literal('canonical-json-bytes'),
    ]),
  })
  .strict()
  .superRefine((corpus, context) => {
    if (
      corpus.outcomeCounts.protocolParsers !== 2 * corpus.sizeOffsets.length ||
      corpus.outcomeCounts.actualIngress !==
        corpus.actualIngressPhases.length * corpus.sizeOffsets.length ||
      corpus.outcomeCounts.total !==
        corpus.outcomeCounts.protocolParsers + corpus.outcomeCounts.actualIngress
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outcomeCounts'],
        message: 'wire boundary outcome counts must match owners, phases and offsets',
      });
    }
  });

export type ProtocolWireBoundaryCorpus = z.infer<typeof ProtocolWireBoundaryCorpusSchema>;
