import { z } from 'zod';

import { Sha256DigestSchema } from './primitives.js';

export const PROTOCOL_VERSION_CORPUS = 'combo.protocol-version-corpus/1' as const;

const DeclaredProtocolVersionSchema = z
  .object({
    wireProtocol: z.string().min(1),
    wireSchemaVersion: z.number().int().positive(),
    supportedProtocolVersions: z.array(z.number().int().positive()).min(1),
    brokerContractDigest: Sha256DigestSchema,
    handshakeFixture: z.string().min(1),
    handshakeFixtureDigest: Sha256DigestSchema,
  })
  .strict();

const RejectedRegistrationIdSchema = z.enum([
  'future-protocol-v2',
  'unknown-capability-key',
  'stale-broker-contract',
  'unaccepted-codex-runtime',
  'unaccepted-codex-protocol',
  'unaccepted-isolation',
]);

const RejectedRegistrationSchema = z
  .object({
    id: RejectedRegistrationIdSchema,
    advertisementLocus: z.literal('creator-oauth-registration'),
    protocolVersions: z.array(z.number().int().positive()).min(1),
    advertisedValue: z.string().nullable(),
    expectedError: z.enum([
      'WORKER_REGISTRATION_INCOMPATIBLE',
      'BROKER_CONTRACT_INCOMPATIBLE',
      'CODEX_RUNTIME_INCOMPATIBLE',
      'CODEX_PROTOCOL_INCOMPATIBLE',
      'ISOLATION_INCOMPATIBLE',
    ]),
  })
  .strict();

/**
 * Digest-bound compatibility vectors. Registration is the trusted advertisement locus; an
 * unparsed or unsigned future wire frame can never mutate Deployment state.
 */
export const ProtocolVersionCorpusSchema = z
  .object({
    protocol: z.literal(PROTOCOL_VERSION_CORPUS),
    schemaVersion: z.literal(1),
    current: DeclaredProtocolVersionSchema,
    declaredPrevious: z.array(DeclaredProtocolVersionSchema).max(8),
    rejectedRegistrations: z.array(RejectedRegistrationSchema).length(6),
  })
  .strict()
  .superRefine((corpus, context) => {
    const ids = corpus.rejectedRegistrations.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rejectedRegistrations'],
        message: 'compatibility rejection IDs must be unique',
      });
    }
    const expected = {
      'future-protocol-v2': 'WORKER_REGISTRATION_INCOMPATIBLE',
      'unknown-capability-key': 'WORKER_REGISTRATION_INCOMPATIBLE',
      'stale-broker-contract': 'BROKER_CONTRACT_INCOMPATIBLE',
      'unaccepted-codex-runtime': 'CODEX_RUNTIME_INCOMPATIBLE',
      'unaccepted-codex-protocol': 'CODEX_PROTOCOL_INCOMPATIBLE',
      'unaccepted-isolation': 'ISOLATION_INCOMPATIBLE',
    } as const;
    if (ids.length === Object.keys(expected).length) {
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
    }
  });

export type ProtocolVersionCorpus = z.infer<typeof ProtocolVersionCorpusSchema>;
