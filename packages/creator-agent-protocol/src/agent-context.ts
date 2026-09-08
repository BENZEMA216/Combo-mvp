import { createHash } from 'node:crypto';

import { z } from 'zod';

import { CreatorAgentPackageDraftContentSchema } from './agent-package-draft.js';
import { canonicalizeJson } from './canonical.js';
import { containsNonPortableAgentReference, containsUnsafeAgentText } from './primitives.js';

export const CREATOR_AGENT_CONTEXT_REQUEST_PROTOCOL = 'combo.agent-context-request/1' as const;
export const CREATOR_AGENT_CONTEXT_DRAFT_PROTOCOL = 'combo.agent-context-draft/1' as const;
export const CREATOR_AGENT_CONTEXT_MAX_BYTES = 65_536;

const ContextText = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine(
      (value) =>
        value.trim() === value &&
        value.normalize('NFC') === value &&
        /[\p{L}\p{N}]/u.test(value) &&
        !containsUnsafeAgentText(value) &&
        !containsNonPortableAgentReference(value),
    );

const ContentSchema = CreatorAgentPackageDraftContentSchema.unwrap()
  .extend({
    coverageSummary: ContextText(1_000),
  })
  .strict()
  .readonly();

const RequestSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_CONTEXT_REQUEST_PROTOCOL),
    request: ContextText(2_000),
    content: ContentSchema,
  })
  .strict()
  .readonly();

const SourceSchema = z
  .object({
    kind: z.literal('codex_available_context'),
    verification: z.literal('not_verified'),
    completeness: z.literal('partial_or_unknown'),
  })
  .strict()
  .readonly();

const DraftSchema = z
  .object({
    protocol: z.literal(CREATOR_AGENT_CONTEXT_DRAFT_PROTOCOL),
    request: ContextText(2_000),
    content: ContentSchema,
    source: SourceSchema,
    draftFingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  })
  .strict()
  .readonly();

export type CreatorAgentContextRequest = z.infer<typeof RequestSchema>;
export type CreatorAgentContextDraft = z.infer<typeof DraftSchema>;

const issuedDraftTexts = new WeakMap<CreatorAgentContextDraft, string>();

/** Only bounded JSON text crosses this public input boundary, never arbitrary caller objects. */
export function parseCreatorAgentContextRequest(text: unknown): CreatorAgentContextRequest {
  try {
    return RequestSchema.parse(decode(text));
  } catch {
    throw new TypeError(
      'Agent context request must be bounded JSON with the exact context schema.',
    );
  }
}

export function createCreatorAgentContextDraft(requestText: unknown): CreatorAgentContextDraft {
  const request = parseCreatorAgentContextRequest(requestText);
  const content = request.content;
  const source = Object.freeze({
    kind: 'codex_available_context' as const,
    verification: 'not_verified' as const,
    completeness: 'partial_or_unknown' as const,
  });
  const input = {
    protocol: CREATOR_AGENT_CONTEXT_DRAFT_PROTOCOL,
    request: request.request,
    content,
    source,
  };
  const draft = Object.freeze({ ...input, draftFingerprint: fingerprint(input) });
  issuedDraftTexts.set(draft, canonicalizeJson(draft));
  return draft;
}

export function serializeCreatorAgentContextDraft(draft: CreatorAgentContextDraft): string {
  // Never inspect arbitrary caller objects: only create/parse can issue a frozen Draft.
  const text = issuedDraftTexts.get(draft);
  if (text === undefined)
    throw new TypeError('Agent context Draft must be issued by create or parse.');
  return text;
}

export function parseCreatorAgentContextDraft(text: unknown): CreatorAgentContextDraft {
  try {
    const draft = DraftSchema.parse(decode(text));
    const { draftFingerprint, ...input } = draft;
    const canonicalText = canonicalizeJson(draft);
    if (fingerprint(input) !== draftFingerprint || canonicalText !== text) {
      throw new TypeError('Invalid exact Draft.');
    }
    issuedDraftTexts.set(draft, canonicalText);
    return draft;
  } catch {
    throw new TypeError('Agent context Draft must have exact canonical bytes and fingerprint.');
  }
}

function fingerprint(input: unknown): string {
  return `sha256:${createHash('sha256').update(`${CREATOR_AGENT_CONTEXT_DRAFT_PROTOCOL}:fingerprint\n`).update(canonicalizeJson(input)).digest('hex')}`;
}

function decode(text: unknown): unknown {
  if (
    typeof text !== 'string' ||
    text.length > CREATOR_AGENT_CONTEXT_MAX_BYTES ||
    Buffer.byteLength(text, 'utf8') > CREATOR_AGENT_CONTEXT_MAX_BYTES
  ) {
    throw new TypeError('Invalid bounded text.');
  }
  return JSON.parse(text) as unknown;
}
