import { z } from 'zod';

import {
  RequiredUnicodeScalarNoControlStringSchema,
  Sha256DigestSchema,
  Utf8TextSchema,
} from './primitives.js';

export const PROTOCOL_VERSION_CORPUS = 'combo.protocol-version-corpus/1' as const;
export const EXACT_WORKER_PROFILE_MATCHER = 'combo.exact-worker-profile-matcher/1' as const;

export const WorkerCompatibilityProfileIdSchema = z.enum(['worker-n-minus-one', 'worker-n']);
export type WorkerCompatibilityProfileId = z.infer<typeof WorkerCompatibilityProfileIdSchema>;

export const GatewayCompatibilityReleaseIdSchema = z.enum(['gateway-n-minus-one', 'gateway-n']);
export type GatewayCompatibilityReleaseId = z.infer<typeof GatewayCompatibilityReleaseIdSchema>;

const ExactWorkerCompatibilityIdentityShape = {
  workerVersion: Utf8TextSchema(128),
  supportedProtocolVersions: z.tuple([z.literal(1)]),
  codexRuntimeArtifacts: z.tuple([Sha256DigestSchema]),
  codexProtocolSchemaDigests: z.tuple([Sha256DigestSchema]),
  isolationModes: z.tuple([z.enum(['apple-container-v1', 'lima-vz-v1'])]),
  brokerContractDigest: Sha256DigestSchema,
} as const;

/** One executable Worker release profile. Lists remain wire-shaped but are exact singletons. */
export const ExactWorkerCompatibilityIdentitySchema = z
  .object(ExactWorkerCompatibilityIdentityShape)
  .strict();
export type ExactWorkerCompatibilityIdentity = z.infer<
  typeof ExactWorkerCompatibilityIdentitySchema
>;

const DeclaredProtocolVersionSchema = z
  .object({
    profileId: WorkerCompatibilityProfileIdSchema,
    wireProtocol: z.literal('combo.creator-broker/1'),
    wireSchemaVersion: z.literal(1),
    ...ExactWorkerCompatibilityIdentityShape,
    handshakeFixture: RequiredUnicodeScalarNoControlStringSchema,
    handshakeFixtureDigest: Sha256DigestSchema,
  })
  .strict();

const GatewayReleaseSchema = z
  .object({
    releaseId: GatewayCompatibilityReleaseIdSchema,
    wireProtocol: z.literal('combo.creator-broker/1'),
    wireSchemaVersion: z.literal(1),
    brokerContractDigest: Sha256DigestSchema,
    matcher: z.literal(EXACT_WORKER_PROFILE_MATCHER),
    acceptedWorkerProfileIds: z
      .array(WorkerCompatibilityProfileIdSchema)
      .length(2)
      .refine((values) => new Set(values).size === values.length, 'profile IDs must be unique'),
  })
  .strict();

const DeclaredCompatibilityPairSchema = z
  .object({
    gatewayReleaseId: GatewayCompatibilityReleaseIdSchema,
    workerProfileId: WorkerCompatibilityProfileIdSchema,
  })
  .strict();

const RejectedRegistrationIdSchema = z.enum([
  'future-protocol-v2',
  'future-worker-version',
  'unknown-capability-key',
  'native-macos',
  'stale-broker-contract',
  'unaccepted-codex-runtime',
  'unaccepted-codex-protocol',
  'unaccepted-isolation',
  'undeclared-cross-mix',
]);

const RejectedRegistrationSchema = z
  .object({
    id: RejectedRegistrationIdSchema,
    advertisementLocus: z.literal('creator-oauth-registration'),
    protocolVersions: z.array(z.number().int().positive()).min(1),
    advertisedValue: RequiredUnicodeScalarNoControlStringSchema.nullable(),
    expectedError: z.enum([
      'WORKER_REGISTRATION_INCOMPATIBLE',
      'WORKER_VERSION_INCOMPATIBLE',
      'BROKER_CONTRACT_INCOMPATIBLE',
      'CODEX_RUNTIME_INCOMPATIBLE',
      'CODEX_PROTOCOL_INCOMPATIBLE',
      'ISOLATION_INCOMPATIBLE',
    ]),
  })
  .strict();

const expectedPairIds = Object.freeze(
  [
    'gateway-n-minus-one:worker-n-minus-one',
    'gateway-n-minus-one:worker-n',
    'gateway-n:worker-n-minus-one',
    'gateway-n:worker-n',
  ].sort(),
);

/**
 * Digest-bound N-1/N compatibility vectors. Registration is the trusted advertisement locus; an
 * unparsed or unsigned future wire frame can never mutate Deployment state. This corpus freezes
 * only G0 matching and does not claim Runtime, Snapshot, public WSS, or Deployment readiness.
 */
export const ProtocolVersionCorpusSchema = z
  .object({
    protocol: z.literal(PROTOCOL_VERSION_CORPUS),
    schemaVersion: z.literal(1),
    current: DeclaredProtocolVersionSchema,
    declaredPrevious: z.tuple([DeclaredProtocolVersionSchema]),
    gatewayReleases: z.tuple([GatewayReleaseSchema, GatewayReleaseSchema]),
    declaredPairs: z.array(DeclaredCompatibilityPairSchema).length(4),
    rejectedRegistrations: z.array(RejectedRegistrationSchema).length(9),
  })
  .strict()
  .superRefine((corpus, context) => {
    if (corpus.current.profileId !== 'worker-n') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['current', 'profileId'],
        message: 'current profile must be worker-n',
      });
    }
    if (corpus.declaredPrevious[0].profileId !== 'worker-n-minus-one') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['declaredPrevious', 0, 'profileId'],
        message: 'declared previous profile must be worker-n-minus-one',
      });
    }
    const profiles = [corpus.declaredPrevious[0], corpus.current];
    if (new Set(profiles.map(({ workerVersion }) => workerVersion)).size !== profiles.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['declaredPrevious'],
        message: 'N-1 and N worker versions must be distinct',
      });
    }
    if (
      new Set(profiles.map(({ handshakeFixture }) => handshakeFixture)).size !== profiles.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['declaredPrevious'],
        message: 'N-1 and N must bind distinct handshake fixtures',
      });
    }

    const gatewayIds = corpus.gatewayReleases.map(({ releaseId }) => releaseId).sort();
    if (gatewayIds.join(',') !== 'gateway-n,gateway-n-minus-one') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['gatewayReleases'],
        message: 'corpus must declare exactly Gateway N-1 and N',
      });
    }
    for (const [index, gateway] of corpus.gatewayReleases.entries()) {
      const accepted = [...gateway.acceptedWorkerProfileIds].sort().join(',');
      if (accepted !== 'worker-n,worker-n-minus-one') {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['gatewayReleases', index, 'acceptedWorkerProfileIds'],
          message: 'each Gateway release must explicitly accept Worker N-1 and N',
        });
      }
      if (
        !profiles.every(
          ({ brokerContractDigest }) => brokerContractDigest === gateway.brokerContractDigest,
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['gatewayReleases', index, 'brokerContractDigest'],
          message: 'declared Gateway/Worker pair must bind one exact Broker contract digest',
        });
      }
    }

    const pairIds = corpus.declaredPairs
      .map(({ gatewayReleaseId, workerProfileId }) => `${gatewayReleaseId}:${workerProfileId}`)
      .sort();
    if (
      new Set(pairIds).size !== pairIds.length ||
      pairIds.join(',') !== expectedPairIds.join(',')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['declaredPairs'],
        message: 'declared pairs must be the complete Gateway N-1/N by Worker N-1/N matrix',
      });
    }

    const ids = corpus.rejectedRegistrations.map(({ id }) => id);
    const expected = {
      'future-protocol-v2': 'WORKER_REGISTRATION_INCOMPATIBLE',
      'future-worker-version': 'WORKER_VERSION_INCOMPATIBLE',
      'unknown-capability-key': 'WORKER_REGISTRATION_INCOMPATIBLE',
      'native-macos': 'WORKER_REGISTRATION_INCOMPATIBLE',
      'stale-broker-contract': 'BROKER_CONTRACT_INCOMPATIBLE',
      'unaccepted-codex-runtime': 'CODEX_RUNTIME_INCOMPATIBLE',
      'unaccepted-codex-protocol': 'CODEX_PROTOCOL_INCOMPATIBLE',
      'unaccepted-isolation': 'ISOLATION_INCOMPATIBLE',
      'undeclared-cross-mix': 'CODEX_RUNTIME_INCOMPATIBLE',
    } as const;
    if (new Set(ids).size !== ids.length || ids.length !== Object.keys(expected).length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rejectedRegistrations'],
        message: 'compatibility rejection IDs must be complete and unique',
      });
      return;
    }
    for (const [index, vector] of corpus.rejectedRegistrations.entries()) {
      if (vector.expectedError !== expected[vector.id]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rejectedRegistrations', index, 'expectedError'],
          message: 'compatibility rejection must use its exact durable reason',
        });
      }
      if (
        (vector.id === 'future-protocol-v2' && vector.advertisedValue !== null) ||
        (vector.id !== 'future-protocol-v2' && vector.advertisedValue === null)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rejectedRegistrations', index, 'advertisedValue'],
          message: 'compatibility rejection must bind its exact advertised value shape',
        });
      }
    }
  });

export type ProtocolVersionCorpus = z.infer<typeof ProtocolVersionCorpusSchema>;
