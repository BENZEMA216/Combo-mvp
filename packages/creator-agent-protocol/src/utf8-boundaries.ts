import { z } from 'zod';

import { Sha256DigestSchema } from './primitives.js';

export const PROTOCOL_UTF8_BOUNDARY_CORPUS = 'combo.protocol-utf8-boundaries/1' as const;

const CheckedArtifactSchema = z.enum(['contract-schemas', 'broker-contract', 'openapi']);

const Utf8ArtifactPointerSchema = z
  .object({
    artifact: CheckedArtifactSchema,
    pointer: z
      .string()
      .min(1)
      .max(2_048)
      .regex(/^\/(?:[^~]|~[01])*$/u),
  })
  .strict();

const Utf8BoundarySchema = z
  .object({
    maxBytes: z.number().int().positive(),
    generators: z.tuple([z.literal('ascii'), z.literal('cjk'), z.literal('emoji')]),
    artifactPointers: z.array(Utf8ArtifactPointerSchema).min(1),
  })
  .strict();

/**
 * Independent, digest-bound evidence inventory for the UTF-8-byte subset of SCH-004.
 * It deliberately does not claim array, decoded-byte, whole-wire, or canonical-byte coverage.
 */
export const ProtocolUtf8BoundaryCorpusSchema = z
  .object({
    protocol: z.literal(PROTOCOL_UTF8_BOUNDARY_CORPUS),
    schemaVersion: z.literal(1),
    scope: z.literal('utf8-byte-limits-only'),
    checkedArtifactDigests: z
      .object({
        contractSchemas: Sha256DigestSchema,
        brokerContract: Sha256DigestSchema,
        openApi: Sha256DigestSchema,
      })
      .strict(),
    boundaries: z.array(Utf8BoundarySchema).min(1),
    remainingBoundaryClasses: z.tuple([
      z.literal('structural-string-length'),
      z.literal('array-count'),
      z.literal('decoded-bytes'),
      z.literal('wire-bytes'),
      z.literal('canonical-json-bytes'),
      z.literal('numeric-bytes'),
    ]),
  })
  .strict()
  .superRefine((corpus, context) => {
    const maxima = corpus.boundaries.map(({ maxBytes }) => maxBytes);
    if (new Set(maxima).size !== maxima.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['boundaries'],
        message: 'UTF-8 boundary maxima must be unique',
      });
    }
    const pointers = corpus.boundaries.flatMap(({ artifactPointers }) =>
      artifactPointers.map(({ artifact, pointer }) => `${artifact}:${pointer}`),
    );
    if (new Set(pointers).size !== pointers.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['boundaries'],
        message: 'UTF-8 artifact pointers must be unique',
      });
    }
  });

export type ProtocolUtf8BoundaryCorpus = z.infer<typeof ProtocolUtf8BoundaryCorpusSchema>;
