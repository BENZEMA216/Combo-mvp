import { z } from 'zod';

import { Sha256DigestSchema } from './primitives.js';

export const PROTOCOL_DECODED_BOUNDARY_CORPUS = 'combo.protocol-decoded-boundaries/1' as const;

const CheckedArtifactSchema = z.enum(['contract-schemas', 'broker-contract', 'openapi']);

const ArtifactPointerSchema = z
  .object({
    artifact: CheckedArtifactSchema,
    pointer: z
      .string()
      .min(1)
      .max(2_048)
      .regex(/^\/(?:[^~]|~[01])*$/u),
  })
  .strict();

const BoundaryIdSchema = z.enum([
  'p256-p1363-signature',
  'snapshot-nonce',
  'snapshot-auth-tag',
  'snapshot-wrapped-dek',
  'broker-sensitive-nonce',
  'broker-sensitive-ciphertext',
  'broker-sensitive-auth-tag',
]);

const DecodedBoundarySchema = z
  .object({
    id: BoundaryIdSchema,
    minimumBytes: z.number().int().nonnegative(),
    maximumBytes: z.number().int().positive(),
    artifactPointers: z.array(ArtifactPointerSchema).min(1),
  })
  .strict()
  .refine(({ minimumBytes, maximumBytes }) => minimumBytes <= maximumBytes, {
    path: ['minimumBytes'],
    message: 'decoded boundary minimum must not exceed maximum',
  });

const OwnerCaseSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    boundaryId: BoundaryIdSchema,
    runtimeParser: z.enum([
      'BrokerHandshakeSchema',
      'ExecutionCapabilitySchema',
      'SandboxAttestationSchema',
      'EvidenceReviewerSignoffSchema',
      'SnapshotArchiveEnvelopeSchema',
      'SnapshotManifestEnvelopeSchema',
      'BrokerEnvelopeSchema',
    ]),
    fixturePath: z.enum([
      'broker-handshake.v1.json',
      'broker-invocation-prepare.v1.json',
      'sandbox-attestation.v1.json',
      'evidence-reviewer-signoff.v1.json',
      'snapshot-envelope.v1.json',
      'snapshot-manifest-envelope.v1.json',
    ]),
    ownerPointer: z.string().regex(/^(?:|\/(?:[^~]|~[01])*)$/u),
    valuePointer: z.string().regex(/^\/(?:[^~]|~[01])*$/u),
    repair: z.enum(['none', 'broker-sensitive-cipher-digest']),
  })
  .strict();

/**
 * Independent literals and owner routing for the decoded/canonical-base64url subset of SCH-004.
 * It does not claim array, numeric, whole-wire, or canonical-whole-object completeness.
 */
export const ProtocolDecodedBoundaryCorpusSchema = z
  .object({
    protocol: z.literal(PROTOCOL_DECODED_BOUNDARY_CORPUS),
    schemaVersion: z.literal(1),
    scope: z.literal('decoded-and-canonical-base64url-owner-boundaries'),
    checkedArtifactDigests: z
      .object({
        contractSchemas: Sha256DigestSchema,
        brokerContract: Sha256DigestSchema,
        openApi: Sha256DigestSchema,
      })
      .strict(),
    baseFixtureDigests: z
      .object({
        brokerHandshake: Sha256DigestSchema,
        brokerInvocationPrepare: Sha256DigestSchema,
        sandboxAttestation: Sha256DigestSchema,
        evidenceReviewerSignoff: Sha256DigestSchema,
        snapshotEnvelope: Sha256DigestSchema,
        snapshotManifestEnvelope: Sha256DigestSchema,
      })
      .strict(),
    boundaries: z.array(DecodedBoundarySchema).length(7),
    ownerCases: z.array(OwnerCaseSchema).length(13),
    remainingBoundaryClasses: z.tuple([
      z.literal('structural-string-length'),
      z.literal('array-count'),
      z.literal('wire-bytes'),
      z.literal('canonical-json-bytes'),
      z.literal('numeric-bytes'),
    ]),
  })
  .strict()
  .superRefine((corpus, context) => {
    const boundaryIds = corpus.boundaries.map(({ id }) => id);
    if (new Set(boundaryIds).size !== boundaryIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['boundaries'],
        message: 'decoded boundary ids must be unique',
      });
    }
    const requiredBoundaryIds = new Set(BoundaryIdSchema.options);
    if (
      boundaryIds.some((id) => !requiredBoundaryIds.delete(id)) ||
      requiredBoundaryIds.size !== 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['boundaries'],
        message: 'decoded boundary ids must cover the frozen subset exactly once',
      });
    }
    const pointers = corpus.boundaries.flatMap(({ artifactPointers }) =>
      artifactPointers.map(({ artifact, pointer }) => `${artifact}:${pointer}`),
    );
    if (new Set(pointers).size !== pointers.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['boundaries'],
        message: 'decoded artifact pointers must be unique',
      });
    }
    const ownerIds = corpus.ownerCases.map(({ id }) => id);
    if (new Set(ownerIds).size !== ownerIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ownerCases'],
        message: 'decoded owner case ids must be unique',
      });
    }
    const referenced = new Set(corpus.ownerCases.map(({ boundaryId }) => boundaryId));
    for (const boundaryId of boundaryIds) {
      if (!referenced.has(boundaryId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ownerCases'],
          message: `decoded boundary ${boundaryId} has no runtime owner case`,
        });
      }
    }
  });

export type ProtocolDecodedBoundaryCorpus = z.infer<typeof ProtocolDecodedBoundaryCorpusSchema>;
