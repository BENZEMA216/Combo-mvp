import { z } from 'zod';

import { IdSchema, IsoDateTimeSchema } from '../core/ids.js';

export const KNOWLEDGE_AGENT_PRODUCT_KIND = 'knowledge_agent_test' as const;
export const KNOWLEDGE_CAPABILITY_PROTOCOL = 'combo.agent-package-capability/2' as const;
export const AGENT_PACKAGE_RELEASE_PROTOCOL = 'combo.agent-package-release/1' as const;
export const KNOWLEDGE_BUNDLE_PROTOCOL = 'combo.knowledge-bundle/1' as const;
export const AGENT_USAGE_RECEIPT_PROTOCOL = 'combo.agent-usage-receipt/1' as const;
export const KNOWLEDGE_RESOURCE_PATH = 'skills/knowledge/references/knowledge-bundle.json' as const;
export const INSUFFICIENT_EVIDENCE_ANSWER = '现有知识中没有足够证据回答这个问题。' as const;
export const HOSTED_KNOWLEDGE_AGENT_SLUG = 'combo-knowledge' as const;
export const KNOWLEDGE_CITATION_EXCERPT_MAX_UTF8_BYTES = 2 * 1_024;

const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const ANSWER_MAX_UTF8_BYTES = 32 * 1_024;
const ZERO_SOURCE_SHA = '0'.repeat(40);

const CanonicalUuidSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());

export const KnowledgeSha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
export type KnowledgeSha256Digest = z.infer<typeof KnowledgeSha256DigestSchema>;

const ReleaseIdSchema = z.string().regex(/^release[.]agent-package[.][0-9a-f]{32}$/u);
const SourceShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/u)
  .refine(
    (value) => value !== ZERO_SOURCE_SHA,
    'Test Runtime source SHA cannot use the development placeholder',
  );
const RuntimeReleaseIdSchema = z.string().regex(/^release-[0-9a-f]{40}$/u);
const PolicyVersionSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u);
const ChunkIdSchema = z.string().regex(/^chunk[.]knowledge[.][0-9a-f]{32}$/u);
const SourceIdSchema = z.string().regex(/^source[.]knowledge[.][0-9a-f]{32}$/u);
const CENTS_PATTERN = /^(0|[1-9][0-9]{0,18})$/u;

export const KnowledgeCentsSchema = z
  .string()
  .regex(CENTS_PATTERN)
  .refine(
    (value) => !CENTS_PATTERN.test(value) || BigInt(value) <= POSTGRES_BIGINT_MAX,
    'Cents exceed PostgreSQL bigint',
  );
export type KnowledgeCents = z.infer<typeof KnowledgeCentsSchema>;

function parsedCents(value: string): bigint | null {
  if (!CENTS_PATTERN.test(value)) return null;
  const amount = BigInt(value);
  return amount <= POSTGRES_BIGINT_MAX ? amount : null;
}

function containsLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function containsUnsafeDisplayText(value: string): boolean {
  if (containsLoneSurrogate(value) || /\p{Cf}/u.test(value)) return true;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (
      unit <= 0x08 ||
      (unit >= 0x0b && unit <= 0x1f) ||
      (unit >= 0x7f && unit <= 0x9f) ||
      unit === 0x2028 ||
      unit === 0x2029
    ) {
      return true;
    }
  }
  return false;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

const AnswerTextSchema = z
  .string()
  .min(1)
  .max(ANSWER_MAX_UTF8_BYTES)
  .refine((value) => value.normalize('NFC') === value, 'Answer must use NFC')
  .refine((value) => value.trim() === value, 'Answer whitespace must be canonical')
  .refine((value) => !containsUnsafeDisplayText(value), 'Answer contains unsafe text')
  .refine(
    (value) => utf8ByteLength(value) <= ANSWER_MAX_UTF8_BYTES,
    'Answer exceeds the UTF-8 byte limit',
  );

const CitationLabelSchema = z
  .string()
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} _()（）·，。、-]{0,119}$/u)
  .refine((value) => value.normalize('NFC') === value, 'Citation label must use NFC')
  .refine(
    (value) => value.trim() === value && !/ {2,}/u.test(value),
    'Citation label whitespace must be canonical',
  )
  .refine((value) => !containsUnsafeDisplayText(value), 'Citation label contains unsafe text');

/**
 * Display-only projection of exact frozen chunk text. It is deliberately absent from receipts,
 * digests, request fingerprints, validation, and settlement; old Runtime detail can omit it while
 * the fixed hosted entry always projects it from the verified Package bytes.
 */
export const KnowledgeCitationExcerptSchema = z
  .string()
  .min(1)
  .max(KNOWLEDGE_CITATION_EXCERPT_MAX_UTF8_BYTES)
  .refine((value) => value.normalize('NFC') === value, 'Citation excerpt must use NFC')
  .refine((value) => !containsUnsafeDisplayText(value), 'Citation excerpt contains unsafe text')
  .refine(
    (value) => utf8ByteLength(value) <= KNOWLEDGE_CITATION_EXCERPT_MAX_UTF8_BYTES,
    'Citation excerpt exceeds the UTF-8 byte limit',
  );
export type KnowledgeCitationExcerpt = z.infer<typeof KnowledgeCitationExcerptSchema>;

export const LegacyAgentBindingSchema = z
  .object({ productKind: z.literal('legacy_capability') })
  .strict();
export type LegacyAgentBinding = z.infer<typeof LegacyAgentBindingSchema>;

export const KnowledgeAgentBindingSchema = z
  .object({
    productKind: z.literal(KNOWLEDGE_AGENT_PRODUCT_KIND),
    capability: z
      .object({
        id: CanonicalUuidSchema,
        protocol: z.literal(KNOWLEDGE_CAPABILITY_PROTOCOL),
      })
      .strict(),
    release: z
      .object({
        protocol: z.literal(AGENT_PACKAGE_RELEASE_PROTOCOL),
        releaseId: ReleaseIdSchema,
        packageDigest: KnowledgeSha256DigestSchema,
      })
      .strict(),
    releaseScope: z.literal('controlled_test'),
    knowledge: z
      .object({
        protocol: z.literal(KNOWLEDGE_BUNDLE_PROTOCOL),
        resourcePath: z.literal(KNOWLEDGE_RESOURCE_PATH),
        resourceDigest: KnowledgeSha256DigestSchema,
      })
      .strict(),
  })
  .strict();
export type KnowledgeAgentBinding = z.infer<typeof KnowledgeAgentBindingSchema>;

export const AgentBindingSchema = z.discriminatedUnion('productKind', [
  LegacyAgentBindingSchema,
  KnowledgeAgentBindingSchema,
]);
export type AgentBinding = z.infer<typeof AgentBindingSchema>;

const KnowledgeBillingSchema = z
  .object({
    policyVersion: PolicyVersionSchema,
    source: z.enum(['owner', 'free', 'wallet']),
    currency: z.literal('CNY'),
    unitPriceCents: KnowledgeCentsSchema,
    settledCents: KnowledgeCentsSchema,
    freeLimitSnapshot: z.number().int().min(0).max(POSTGRES_INTEGER_MAX),
  })
  .strict();

const KnowledgeRuntimeSchema = z
  .object({
    environment: z.literal('test'),
    releaseId: RuntimeReleaseIdSchema,
    sourceSha: SourceShaSchema,
  })
  .strict();

const KnowledgeAnswerSchema = z
  .object({
    messageId: CanonicalUuidSchema,
    text: AnswerTextSchema,
    responseDigest: KnowledgeSha256DigestSchema,
  })
  .strict();

const AnsweredKnowledgeAnswerSchema = KnowledgeAnswerSchema.refine(
  (answer) => answer.text !== INSUFFICIENT_EVIDENCE_ANSWER,
  {
    path: ['text'],
    message: 'Answered output cannot use the reserved insufficient-evidence text',
  },
);

const InsufficientKnowledgeAnswerSchema = KnowledgeAnswerSchema.extend({
  text: z.literal(INSUFFICIENT_EVIDENCE_ANSWER),
}).strict();

export const KnowledgeCitationSchema = z
  .object({
    chunkId: ChunkIdSchema,
    sourceId: SourceIdSchema,
    displayLabel: CitationLabelSchema,
    /** Optional only for rolling compatibility with detail produced by an older Runtime. */
    excerpt: KnowledgeCitationExcerptSchema.optional(),
  })
  .strict();
export type KnowledgeCitation = z.infer<typeof KnowledgeCitationSchema>;

const HostedAgentPublicTextSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => value.normalize('NFC') === value, 'Hosted Agent text must use NFC')
  .refine((value) => value.trim() === value, 'Hosted Agent text whitespace must be canonical')
  .refine((value) => !containsUnsafeDisplayText(value), 'Hosted Agent text contains unsafe text');

/** Public descriptor for the one fixed hosted consumer Agent; no Registry selector may cross it. */
export const HostedKnowledgeAgentDescriptorSchema = z
  .object({
    slug: z.literal(HOSTED_KNOWLEDGE_AGENT_SLUG),
    name: HostedAgentPublicTextSchema,
    summary: HostedAgentPublicTextSchema,
    billing: z
      .object({
        currency: z.literal('CNY'),
        unitPriceCents: KnowledgeCentsSchema.refine(
          (value) => BigInt(value) > 0n,
          'Hosted Agent unit price must be positive',
        ),
        freeUses: z.number().int().min(0).max(POSTGRES_INTEGER_MAX),
      })
      .strict(),
  })
  .strict();
export type HostedKnowledgeAgentDescriptor = z.infer<typeof HostedKnowledgeAgentDescriptorSchema>;

/** POST /runtime/agents/combo-knowledge/start returns no Capability or Package selectors. */
export const StartHostedKnowledgeAgentResultSchema = z.object({ sessionId: IdSchema }).strict();
export type StartHostedKnowledgeAgentResult = z.infer<typeof StartHostedKnowledgeAgentResultSchema>;

const KnowledgeResultCommonShape = {
  protocol: z.literal(AGENT_USAGE_RECEIPT_PROTOCOL),
  receiptId: CanonicalUuidSchema,
  usageId: CanonicalUuidSchema,
  turnId: CanonicalUuidSchema,
  createdAt: IsoDateTimeSchema,
  binding: KnowledgeAgentBindingSchema,
  billing: KnowledgeBillingSchema,
  runtime: KnowledgeRuntimeSchema,
} as const;

const AnsweredKnowledgeTurnResultSchema = z
  .object({
    ...KnowledgeResultCommonShape,
    outcome: z.literal('answered'),
    validation: z
      .object({ policyVersion: PolicyVersionSchema, code: z.literal('accepted') })
      .strict(),
    answer: AnsweredKnowledgeAnswerSchema,
    citations: z.array(KnowledgeCitationSchema).min(1).max(32),
  })
  .strict();

const InsufficientKnowledgeTurnResultSchema = z
  .object({
    ...KnowledgeResultCommonShape,
    outcome: z.literal('insufficient_evidence'),
    validation: z
      .object({
        policyVersion: PolicyVersionSchema,
        code: z.literal('insufficient_evidence'),
      })
      .strict(),
    answer: InsufficientKnowledgeAnswerSchema,
    citations: z.array(KnowledgeCitationSchema).length(0),
  })
  .strict();

const FailedKnowledgeTurnResultSchema = z
  .object({
    ...KnowledgeResultCommonShape,
    outcome: z.literal('failed'),
    validation: z
      .object({
        policyVersion: PolicyVersionSchema,
        code: z.enum(['not_run', 'rejected', 'unavailable', 'protocol_invalid']),
      })
      .strict(),
    answer: z.null(),
    citations: z.array(KnowledgeCitationSchema).length(0),
  })
  .strict();

const InterruptedKnowledgeTurnResultSchema = z
  .object({
    ...KnowledgeResultCommonShape,
    outcome: z.literal('interrupted'),
    validation: z
      .object({ policyVersion: PolicyVersionSchema, code: z.literal('not_run') })
      .strict(),
    answer: z.null(),
    citations: z.array(KnowledgeCitationSchema).length(0),
  })
  .strict();

/**
 * Owner-visible projection of one immutable database receipt. The Runtime must already have
 * re-read the bound response Message, recomputed responseDigest from its exact UTF-8 text, and
 * resolved citation labels from the frozen Package resource before constructing this view.
 * This shape is not a cryptographic signature or an independently signed receipt.
 */
export const KnowledgeTurnResultSchema = z
  .discriminatedUnion('outcome', [
    AnsweredKnowledgeTurnResultSchema,
    InsufficientKnowledgeTurnResultSchema,
    FailedKnowledgeTurnResultSchema,
    InterruptedKnowledgeTurnResultSchema,
  ])
  .superRefine((result, context) => {
    if (result.runtime.releaseId !== `release-${result.runtime.sourceSha}`) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['runtime', 'releaseId'],
        message: 'Runtime release must match the exact source SHA',
      });
    }

    const unitPrice = parsedCents(result.billing.unitPriceCents);
    const settled = parsedCents(result.billing.settledCents);
    if (unitPrice === null || settled === null) return;
    if (result.billing.source === 'wallet' && unitPrice === 0n) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['billing', 'unitPriceCents'],
        message: 'Wallet billing requires a positive unit price',
      });
    }
    if (result.billing.source === 'wallet' && settled > unitPrice) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['billing', 'settledCents'],
        message: 'Wallet settlement cannot exceed the reserved unit price',
      });
    }
    if (result.outcome === 'answered') {
      if (result.billing.source === 'wallet' ? settled === 0n : settled !== 0n) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['billing', 'settledCents'],
          message: 'Answered settlement does not match its billing source',
        });
      }
    } else if (settled !== 0n) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['billing', 'settledCents'],
        message: 'Only an answered outcome may settle funds',
      });
    }

    const sourceLabels = new Map<string, string>();
    let previousChunkId: string | undefined;
    for (const [index, citation] of result.citations.entries()) {
      if (previousChunkId !== undefined && previousChunkId >= citation.chunkId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['citations', index, 'chunkId'],
          message: 'Citation chunk IDs must be unique and in ascending order',
        });
      }
      previousChunkId = citation.chunkId;
      const existingLabel = sourceLabels.get(citation.sourceId);
      if (existingLabel !== undefined && existingLabel !== citation.displayLabel) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['citations', index, 'displayLabel'],
          message: 'A source ID must map to one exact citation label',
        });
      } else {
        sourceLabels.set(citation.sourceId, citation.displayLabel);
      }
    }
  });
export type KnowledgeTurnResult = z.infer<typeof KnowledgeTurnResultSchema>;

export function knowledgeBindingsEqual(
  left: KnowledgeAgentBinding,
  right: KnowledgeAgentBinding,
): boolean {
  return (
    left.productKind === right.productKind &&
    left.capability.id === right.capability.id &&
    left.capability.protocol === right.capability.protocol &&
    left.release.protocol === right.release.protocol &&
    left.release.releaseId === right.release.releaseId &&
    left.release.packageDigest === right.release.packageDigest &&
    left.releaseScope === right.releaseScope &&
    left.knowledge.protocol === right.knowledge.protocol &&
    left.knowledge.resourcePath === right.knowledge.resourcePath &&
    left.knowledge.resourceDigest === right.knowledge.resourceDigest
  );
}
