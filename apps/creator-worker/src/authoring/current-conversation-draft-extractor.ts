import { isProxy } from 'node:util/types';
import { createHash } from 'node:crypto';

import {
  CreatorAgentPackageCurrentConversationSourceSchema,
  CreatorAgentPackageDraftContentSchema,
  digestCreatorAgentPackageCreatorRequestV2,
  verifyCreatorAgentPackageCreatorRequestV2,
  type CreatorAgentPackageCurrentConversationSource,
  type CreatorAgentPackageCreatorRequestV2,
  type CreatorAgentPackageDraftContent,
} from '@cb/creator-agent-protocol/agent-package-draft';
import { z } from 'zod';

export const CURRENT_CONVERSATION_DRAFT_EXTRACTION_PROTOCOL =
  'combo.creator-conversation-draft-extraction/1' as const;

const DEFAULT_TURN_TIMEOUT_MS = 2 * 60_000;
const MAX_TURN_TIMEOUT_MS = 5 * 60_000;
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

const CurrentConversationAttestationSchema = z
  .object({
    trigger: z.literal('direct_user_creator_item'),
    sourceBoundary: z.literal('desktop_attested_active_current_task'),
    snapshotBoundary: z.literal('before_direct_creator_item'),
    visibility: z.literal('user_visible_items_only'),
    snapshotCompleteness: z.enum(['complete', 'incomplete']),
    rawStored: z.boolean(),
    snapshotDigest: z.string().regex(SHA256_DIGEST_PATTERN),
    selectedVisibleItemCount: z.number().int().nonnegative().max(500_000),
    creatorRequestDigest: z.string().regex(SHA256_DIGEST_PATTERN),
  })
  .strict();

const GeneratedConversationDraftSchema = z
  .object({
    protocol: z.literal(CURRENT_CONVERSATION_DRAFT_EXTRACTION_PROTOCOL),
    name: z.string().min(1).max(80),
    description: z.string().min(1).max(500),
    instructions: z.string().min(1).max(8_000),
    starterPrompts: z.array(z.string().min(1).max(1_000)).min(1).max(5),
    outputDescription: z.string().min(1).max(1_000),
    coverageSummary: z.string().min(1).max(1_000),
  })
  .strict();

const CurrentConversationEgressReceiptSchema = z
  .object({
    policy: z.literal('sealed_snapshot_verbatim_and_credential_scan/1'),
    verdict: z.literal('passed'),
    snapshotDigest: z.string().regex(SHA256_DIGEST_PATTERN),
    creatorRequestDigest: z.string().regex(SHA256_DIGEST_PATTERN),
    extractedDraftDigest: z.string().regex(SHA256_DIGEST_PATTERN),
  })
  .strict();

const AcceptedConversationExtractionResultSchema = z
  .object({
    status: z.literal('accepted'),
    draft: GeneratedConversationDraftSchema,
    egressReceipt: CurrentConversationEgressReceiptSchema,
  })
  .strict();

const RejectedConversationExtractionResultSchema = z
  .object({
    status: z.literal('rejected'),
    reason: z.literal('verbatim_or_credential_detected'),
  })
  .strict();

const SafeConversationExtractionResultSchema = z.discriminatedUnion('status', [
  AcceptedConversationExtractionResultSchema,
  RejectedConversationExtractionResultSchema,
]);

export const CURRENT_CONVERSATION_DRAFT_OUTPUT_SCHEMA = deepFreeze({
  type: 'object',
  additionalProperties: false,
  required: [
    'protocol',
    'name',
    'description',
    'instructions',
    'starterPrompts',
    'outputDescription',
    'coverageSummary',
  ],
  properties: {
    protocol: {
      type: 'string',
      enum: [CURRENT_CONVERSATION_DRAFT_EXTRACTION_PROTOCOL],
    },
    name: { type: 'string', minLength: 1, maxLength: 80 },
    description: { type: 'string', minLength: 1, maxLength: 500 },
    instructions: { type: 'string', minLength: 1, maxLength: 8_000 },
    starterPrompts: {
      type: 'array',
      minItems: 1,
      maxItems: 5,
      items: { type: 'string', minLength: 1, maxLength: 1_000 },
    },
    outputDescription: { type: 'string', minLength: 1, maxLength: 1_000 },
    coverageSummary: { type: 'string', minLength: 1, maxLength: 1_000 },
  },
});

const CURRENT_CONVERSATION_DRAFT_DEVELOPER_INSTRUCTIONS = [
  'Use only the sealed user-visible snapshot from the current task.',
  'Do not use tools, files, Projects, session stores, hidden rollout items, or outside knowledge.',
  'Extract the reusable method rather than copying the conversation transcript.',
  'Do not include paths, URLs, task identifiers, credentials, or raw conversation text.',
  'Return exactly one structured Agent Package Draft extraction.',
].join(' ');

export type CurrentConversationSourceLease = Readonly<{
  readAttestation(): unknown;
  assertStillCurrent(): Promise<void>;
  /**
   * The Host passes only outputSchema to the model, checks the candidate against its sealed
   * snapshot for verbatim and credential leakage, and wraps only an accepted candidate with the
   * Host-owned egress receipt. The model never creates that receipt.
   */
  extractStructuredWithEgressGuard(
    input: CurrentConversationStructuredExtractionInput,
  ): Promise<unknown>;
  close(): Promise<void>;
}>;

export type CurrentConversationStructuredExtractionInput = Readonly<{
  mode: 'snapshot_only_no_tools';
  creatorRequest: string;
  developerInstructions: string;
  outputSchema: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
}>;

export type AmbientCurrentConversationDraftHostPort = Readonly<{
  openCurrentConversationSource(input: {
    creatorRequestDigest: string;
    signal?: AbortSignal;
  }): Promise<CurrentConversationSourceLease>;
}>;

export type CreatorAgentPackageCurrentConversationExtraction = Readonly<{
  source: CreatorAgentPackageCurrentConversationSource;
  content: CreatorAgentPackageDraftContent;
}>;

export type CreatorAgentPackageCurrentConversationExtractionOptions = Readonly<{
  creatorRequest: CreatorAgentPackageCreatorRequestV2;
  signal?: AbortSignal;
  turnTimeoutMs?: number;
}>;

export type CreatorAgentPackageCurrentConversationExtractionDependencies = Readonly<{
  ambientHost: AmbientCurrentConversationDraftHostPort;
}>;

export type CreatorAgentPackageCurrentConversationExtractionErrorCode =
  | 'AGENT_PACKAGE_CONVERSATION_CANCELLED'
  | 'AGENT_PACKAGE_CONVERSATION_DRAFT_CONFIGURATION_INVALID'
  | 'AGENT_PACKAGE_CONVERSATION_SOURCE_UNAVAILABLE'
  | 'AGENT_PACKAGE_CONVERSATION_SOURCE_BINDING_INVALID'
  | 'AGENT_PACKAGE_CONVERSATION_SOURCE_INCOMPLETE'
  | 'AGENT_PACKAGE_CONVERSATION_SOURCE_CHANGED'
  | 'AGENT_PACKAGE_CONVERSATION_HOST_FAILED'
  | 'AGENT_PACKAGE_CONVERSATION_OUTPUT_REJECTED'
  | 'AGENT_PACKAGE_CONVERSATION_OUTPUT_INVALID'
  | 'AGENT_PACKAGE_CONVERSATION_STOP_INCOMPLETE';

export class CreatorAgentPackageCurrentConversationExtractionError extends Error {
  public constructor(
    public readonly code: CreatorAgentPackageCurrentConversationExtractionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CreatorAgentPackageCurrentConversationExtractionError';
  }
}

export async function extractCreatorAgentPackageDraftFromCurrentConversationWithDependencies(
  rawOptions: unknown,
  rawDependencies: unknown,
): Promise<CreatorAgentPackageCurrentConversationExtraction> {
  const options = snapshotOptions(rawOptions);
  const dependencies = snapshotDependencies(rawDependencies);
  const creatorRequestDigest = digestCreatorAgentPackageCreatorRequestV2(options.creatorRequest);
  if (signalAborted(options.signal)) throw extractionError('AGENT_PACKAGE_CONVERSATION_CANCELLED');

  let rawLease: unknown;
  try {
    rawLease = await dependencies.openCurrentConversationSource.call(
      dependencies.ambientHost,
      Object.freeze({
        creatorRequestDigest,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }),
    );
  } catch {
    throw extractionError(
      signalAborted(options.signal)
        ? 'AGENT_PACKAGE_CONVERSATION_CANCELLED'
        : 'AGENT_PACKAGE_CONVERSATION_SOURCE_UNAVAILABLE',
    );
  }

  let lease: ReturnType<typeof snapshotLease>;
  try {
    lease = snapshotLease(rawLease);
  } catch {
    try {
      await closeMalformedLease(rawLease);
    } catch {
      throw extractionError('AGENT_PACKAGE_CONVERSATION_STOP_INCOMPLETE');
    }
    throw extractionError('AGENT_PACKAGE_CONVERSATION_SOURCE_BINDING_INVALID');
  }
  let failure: CreatorAgentPackageCurrentConversationExtractionErrorCode | undefined;
  let rawGenerated: unknown;
  let attestation: z.infer<typeof CurrentConversationAttestationSchema> | undefined;
  try {
    try {
      const rawAttestation = lease.readAttestation.call(lease.receiver);
      attestation = CurrentConversationAttestationSchema.parse(snapshotJson(rawAttestation));
      if (
        attestation.snapshotCompleteness !== 'complete' ||
        attestation.selectedVisibleItemCount < 1
      ) {
        failure = 'AGENT_PACKAGE_CONVERSATION_SOURCE_INCOMPLETE';
      } else if (
        attestation.rawStored !== false ||
        attestation.creatorRequestDigest !== creatorRequestDigest
      ) {
        failure = 'AGENT_PACKAGE_CONVERSATION_SOURCE_BINDING_INVALID';
      }
    } catch {
      failure = 'AGENT_PACKAGE_CONVERSATION_SOURCE_BINDING_INVALID';
    }

    if (failure === undefined) {
      try {
        await lease.assertStillCurrent.call(lease.receiver);
      } catch {
        failure = 'AGENT_PACKAGE_CONVERSATION_SOURCE_CHANGED';
      }
    }

    if (failure === undefined) {
      try {
        rawGenerated = await lease.extractStructuredWithEgressGuard.call(
          lease.receiver,
          Object.freeze({
            mode: 'snapshot_only_no_tools',
            creatorRequest: options.creatorRequest.request,
            developerInstructions: CURRENT_CONVERSATION_DRAFT_DEVELOPER_INSTRUCTIONS,
            outputSchema: CURRENT_CONVERSATION_DRAFT_OUTPUT_SCHEMA,
            timeoutMs: options.turnTimeoutMs,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
          }),
        );
      } catch {
        failure = signalAborted(options.signal)
          ? 'AGENT_PACKAGE_CONVERSATION_CANCELLED'
          : 'AGENT_PACKAGE_CONVERSATION_HOST_FAILED';
      }

      try {
        await lease.assertStillCurrent.call(lease.receiver);
      } catch {
        failure = 'AGENT_PACKAGE_CONVERSATION_SOURCE_CHANGED';
      }
    }
  } finally {
    try {
      await lease.close.call(lease.receiver);
    } catch {
      failure = 'AGENT_PACKAGE_CONVERSATION_STOP_INCOMPLETE';
    }
  }

  if (failure !== undefined) throw extractionError(failure);
  if (attestation === undefined || rawGenerated === undefined) {
    throw extractionError('AGENT_PACKAGE_CONVERSATION_OUTPUT_INVALID');
  }

  let result: z.infer<typeof SafeConversationExtractionResultSchema>;
  try {
    result = SafeConversationExtractionResultSchema.parse(snapshotJson(rawGenerated));
  } catch {
    throw extractionError('AGENT_PACKAGE_CONVERSATION_OUTPUT_INVALID');
  }
  if (result.status === 'rejected') {
    throw extractionError('AGENT_PACKAGE_CONVERSATION_OUTPUT_REJECTED');
  }
  const generated = result.draft;
  if (
    result.egressReceipt.snapshotDigest !== attestation.snapshotDigest ||
    result.egressReceipt.creatorRequestDigest !== creatorRequestDigest ||
    result.egressReceipt.extractedDraftDigest !== digestGeneratedConversationDraft(generated)
  ) {
    throw extractionError('AGENT_PACKAGE_CONVERSATION_OUTPUT_REJECTED');
  }
  try {
    const content = CreatorAgentPackageDraftContentSchema.parse({
      name: generated.name,
      description: generated.description,
      instructions: generated.instructions,
      starterPrompts: generated.starterPrompts,
      outputDescription: generated.outputDescription,
    });
    const source = CreatorAgentPackageCurrentConversationSourceSchema.parse({
      kind: 'current_conversation',
      sourceBoundary: attestation.sourceBoundary,
      snapshotBoundary: attestation.snapshotBoundary,
      visibility: attestation.visibility,
      snapshotCompleteness: 'complete',
      rawStored: false,
      snapshotDigest: attestation.snapshotDigest,
      selectedVisibleItemCount: attestation.selectedVisibleItemCount,
      coverageSummary: generated.coverageSummary,
    });
    return Object.freeze({ source, content });
  } catch {
    throw extractionError('AGENT_PACKAGE_CONVERSATION_OUTPUT_INVALID');
  }
}

type CheckedOptions = Readonly<{
  creatorRequest: CreatorAgentPackageCreatorRequestV2;
  signal?: AbortSignal;
  turnTimeoutMs: number;
}>;

function snapshotOptions(input: unknown): CheckedOptions {
  try {
    const values = exactDataProperties(input, ['creatorRequest', 'signal', 'turnTimeoutMs']);
    const creatorRequest = verifyCreatorAgentPackageCreatorRequestV2(values.creatorRequest);
    const signal = values.signal;
    const turnTimeoutMs = values.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    if (
      (signal !== undefined && !(signal instanceof AbortSignal)) ||
      !Number.isSafeInteger(turnTimeoutMs) ||
      (turnTimeoutMs as number) < 1_000 ||
      (turnTimeoutMs as number) > MAX_TURN_TIMEOUT_MS
    ) {
      throw new TypeError('invalid extraction options');
    }
    return Object.freeze({
      creatorRequest,
      ...(signal === undefined ? {} : { signal: signal as AbortSignal }),
      turnTimeoutMs: turnTimeoutMs as number,
    });
  } catch {
    throw extractionError('AGENT_PACKAGE_CONVERSATION_DRAFT_CONFIGURATION_INVALID');
  }
}

export function digestGeneratedConversationDraftForEgress(input: unknown): string {
  const generated = GeneratedConversationDraftSchema.parse(snapshotJson(input));
  return digestGeneratedConversationDraft(generated);
}

function digestGeneratedConversationDraft(
  generated: z.infer<typeof GeneratedConversationDraftSchema>,
): string {
  const bytes = JSON.stringify(generated);
  return `sha256:${createHash('sha256').update(bytes, 'utf8').digest('hex')}`;
}

function snapshotDependencies(input: unknown): Readonly<{
  ambientHost: object;
  openCurrentConversationSource: AmbientCurrentConversationDraftHostPort['openCurrentConversationSource'];
}> {
  try {
    const values = exactDataProperties(input, ['ambientHost']);
    const ambientHost = values.ambientHost;
    const hostValues = exactDataProperties(ambientHost, ['openCurrentConversationSource']);
    if (typeof hostValues.openCurrentConversationSource !== 'function') {
      throw new TypeError('invalid ambient Host port');
    }
    return Object.freeze({
      ambientHost: ambientHost as object,
      openCurrentConversationSource:
        hostValues.openCurrentConversationSource as AmbientCurrentConversationDraftHostPort['openCurrentConversationSource'],
    });
  } catch {
    throw extractionError('AGENT_PACKAGE_CONVERSATION_DRAFT_CONFIGURATION_INVALID');
  }
}

function snapshotLease(input: unknown): Readonly<{
  receiver: object;
  readAttestation: CurrentConversationSourceLease['readAttestation'];
  assertStillCurrent: CurrentConversationSourceLease['assertStillCurrent'];
  extractStructuredWithEgressGuard: CurrentConversationSourceLease['extractStructuredWithEgressGuard'];
  close: CurrentConversationSourceLease['close'];
}> {
  try {
    const values = exactDataProperties(input, [
      'readAttestation',
      'assertStillCurrent',
      'extractStructuredWithEgressGuard',
      'close',
    ]);
    if (
      typeof values.readAttestation !== 'function' ||
      typeof values.assertStillCurrent !== 'function' ||
      typeof values.extractStructuredWithEgressGuard !== 'function' ||
      typeof values.close !== 'function'
    ) {
      throw new TypeError('invalid current-conversation lease');
    }
    return Object.freeze({
      receiver: input as object,
      readAttestation: values.readAttestation as CurrentConversationSourceLease['readAttestation'],
      assertStillCurrent:
        values.assertStillCurrent as CurrentConversationSourceLease['assertStillCurrent'],
      extractStructuredWithEgressGuard:
        values.extractStructuredWithEgressGuard as CurrentConversationSourceLease['extractStructuredWithEgressGuard'],
      close: values.close as CurrentConversationSourceLease['close'],
    });
  } catch {
    throw extractionError('AGENT_PACKAGE_CONVERSATION_SOURCE_BINDING_INVALID');
  }
}

async function closeMalformedLease(input: unknown): Promise<void> {
  if (typeof input !== 'object' || input === null || isProxy(input)) {
    throw new TypeError('lease has no safe receiver');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('lease has no safe receiver');
  }
  const descriptor = Object.getOwnPropertyDescriptor(input, 'close');
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !('value' in descriptor) ||
    typeof descriptor.value !== 'function'
  ) {
    throw new TypeError('lease has no safe close method');
  }
  await Reflect.apply(descriptor.value as CurrentConversationSourceLease['close'], input, []);
}

function exactDataProperties(
  input: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || isProxy(input)) {
    throw new TypeError('value must be a plain object');
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('value must be a plain object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))) {
    throw new TypeError('value contains an unknown field');
  }
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('value must use enumerable data properties');
    }
    values[key] = descriptor.value;
  }
  return values;
}

function snapshotJson(input: unknown, depth = 0, nodes = { value: 0 }): unknown {
  nodes.value += 1;
  if (depth > 16 || nodes.value > 2_048) throw new TypeError('structured output is too complex');
  if (input === null || typeof input === 'boolean' || typeof input === 'string') return input;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new TypeError('structured output is not JSON');
    return input;
  }
  if (typeof input !== 'object' || isProxy(input)) {
    throw new TypeError('structured output must contain only plain JSON');
  }
  if (Array.isArray(input)) {
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors).filter((key) => key !== 'length');
    if (
      keys.length !== input.length ||
      keys.some((key, index) => typeof key !== 'string' || key !== String(index))
    ) {
      throw new TypeError('structured output must contain dense arrays');
    }
    return keys.map((key) => {
      const descriptor = descriptors[key as string];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('structured output must use data properties');
      }
      return snapshotJson(descriptor.value, depth + 1, nodes);
    });
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('structured output must contain plain objects');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new TypeError('structured output contains a symbol');
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('structured output must use data properties');
    }
    output[key] = snapshotJson(descriptor.value, depth + 1, nodes);
  }
  return output;
}

function extractionError(
  code: CreatorAgentPackageCurrentConversationExtractionErrorCode,
): CreatorAgentPackageCurrentConversationExtractionError {
  const messages: Record<CreatorAgentPackageCurrentConversationExtractionErrorCode, string> = {
    AGENT_PACKAGE_CONVERSATION_CANCELLED: 'Current-conversation Draft extraction was cancelled.',
    AGENT_PACKAGE_CONVERSATION_DRAFT_CONFIGURATION_INVALID:
      'Current-conversation Draft extraction is not configured safely.',
    AGENT_PACKAGE_CONVERSATION_SOURCE_UNAVAILABLE:
      'The active current-conversation source is unavailable.',
    AGENT_PACKAGE_CONVERSATION_SOURCE_BINDING_INVALID:
      'The current-conversation source binding is invalid.',
    AGENT_PACKAGE_CONVERSATION_SOURCE_INCOMPLETE:
      'The current conversation is incomplete for Draft extraction.',
    AGENT_PACKAGE_CONVERSATION_SOURCE_CHANGED:
      'The active conversation changed during Draft extraction.',
    AGENT_PACKAGE_CONVERSATION_HOST_FAILED:
      'The current conversation could not be extracted safely.',
    AGENT_PACKAGE_CONVERSATION_OUTPUT_REJECTED:
      'Current-conversation extraction did not pass the Host egress boundary.',
    AGENT_PACKAGE_CONVERSATION_OUTPUT_INVALID:
      'Current-conversation extraction returned an invalid Draft result.',
    AGENT_PACKAGE_CONVERSATION_STOP_INCOMPLETE:
      'The current-conversation source could not be closed safely.',
  };
  return new CreatorAgentPackageCurrentConversationExtractionError(code, messages[code]);
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
