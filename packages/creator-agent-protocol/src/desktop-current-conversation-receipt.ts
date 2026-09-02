import { createHash, verify as verifySignature, type KeyLike } from 'node:crypto';
import { isProxy } from 'node:util/types';

import { z } from 'zod';

import { canonicalFingerprint, canonicalizeJson } from './canonical.js';
import { Sha256DigestSchema, containsLoneSurrogate, type Sha256Digest } from './primitives.js';

export const DESKTOP_CURRENT_CONVERSATION_RUN_RECEIPT_PROTOCOL =
  'combo.desktop-current-conversation-run-receipt/1' as const;
export const DESKTOP_CURRENT_CONVERSATION_RUN_RECEIPT_MAX_BYTES = 65_536;

const EVENT_FINGERPRINT_DOMAIN = 'combo.desktop-current-conversation-run-receipt/1:event' as const;
const SIGNATURE_MESSAGE_DOMAIN =
  'combo.desktop-current-conversation-run-receipt/1:signature-message' as const;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const SAFE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+:-]{0,127}$/u;
const SAFE_KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RUN_ID_PATTERN =
  /^run\.creator-conversation\.[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DRAFT_ID_PATTERN = /^draft\.agent-package\.[0-9a-f]{32}$/u;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ED25519_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/u;

const EventTypeSchema = z.enum([
  'DIRECT_USER_CREATOR_ITEM_ACCEPTED',
  'CURRENT_CONVERSATION_SOURCE_ATTESTED',
  'TYPED_AGENT_PACKAGE_DRAFT_RENDERED',
  'DRAFT_TERMINAL_RESULT',
]);

const EventInputObjectSchema = z
  .object({
    sequence: z.number().int().min(0).max(3),
    type: EventTypeSchema,
    occurredAt: z.string().regex(CANONICAL_TIMESTAMP_PATTERN),
    previousEventDigest: Sha256DigestSchema.nullable(),
  })
  .strict();
const EventInputSchema = EventInputObjectSchema.readonly();

export const DesktopCurrentConversationRunEventSchema = EventInputObjectSchema.extend({
  eventDigest: Sha256DigestSchema,
})
  .strict()
  .readonly();
export type DesktopCurrentConversationRunEvent = z.infer<
  typeof DesktopCurrentConversationRunEventSchema
>;

const EnvironmentSchema = z
  .object({
    desktopBundleId: z.literal('com.openai.codex'),
    desktopVersion: z.string().regex(SAFE_VERSION_PATTERN),
    desktopBuild: z.string().regex(SAFE_VERSION_PATTERN),
    comboPluginVersion: z.string().regex(SAFE_VERSION_PATTERN),
    creatorWorkerVersion: z.string().regex(SAFE_VERSION_PATTERN),
    creatorProtocolVersion: z.string().regex(SAFE_VERSION_PATTERN),
    serviceVersion: z.string().regex(SAFE_VERSION_PATTERN),
  })
  .strict()
  .readonly();

const SourceSchema = z
  .object({
    sourceBoundary: z.literal('desktop_attested_active_current_task'),
    snapshotBoundary: z.literal('before_direct_creator_item'),
    visibility: z.literal('user_visible_items_only'),
    completeness: z.literal('complete'),
    rawStored: z.literal(false),
    snapshotCommitmentScheme: z.literal('host_hmac_sha256_per_run/1'),
    snapshotCommitment: Sha256DigestSchema,
    selectedVisibleItemCount: z.number().int().min(1).max(500_000),
    omittedVisibleItemCount: z.literal(0),
    truncatedItemCount: z.literal(0),
    nonVisibleItemCount: z.literal(0),
    taskBindingScheme: z.literal('host_hmac_sha256_per_run/1'),
    taskBindingTag: Sha256DigestSchema,
  })
  .strict()
  .readonly();

const EgressSchema = z
  .object({
    policy: z.literal('sealed_snapshot_verbatim_and_credential_scan/1'),
    verdict: z.literal('passed'),
    snapshotCommitment: Sha256DigestSchema,
    creatorRequestDigest: Sha256DigestSchema,
    extractedCandidateDigest: Sha256DigestSchema,
  })
  .strict()
  .readonly();

const ProjectionSchema = z
  .object({
    status: z.literal('typed_v2_draft_created'),
    snapshotCommitment: Sha256DigestSchema,
    creatorRequestDigest: Sha256DigestSchema,
    extractedCandidateDigest: Sha256DigestSchema,
    draftFingerprint: Sha256DigestSchema,
  })
  .strict()
  .readonly();

const DraftSchema = z
  .object({
    protocol: z.literal('combo.agent-package-draft/2'),
    draftId: z.string().regex(DRAFT_ID_PATTERN),
    revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    draftFingerprint: Sha256DigestSchema,
    renderSurface: z.literal('codex_desktop_same_task_agent_package_draft'),
    renderStatus: z.literal('visible'),
    taskBindingTag: Sha256DigestSchema,
  })
  .strict()
  .readonly();

const ZeroCountersSchema = z
  .object({
    additionalCreatorProjectScans: z.literal(0),
    additionalCreatorProjectFileReads: z.literal(0),
    additionalCreatorProjectFileWrites: z.literal(0),
    creatorCliOrBridgeChildProcesses: z.literal(0),
    hookTrustWrites: z.literal(0),
    pluginOrMcpThreadStoreReads: z.literal(0),
    rawSessionFileReads: z.literal(0),
    userTerminalActions: z.literal(0),
    forbiddenFallbackAttempts: z.literal(0),
  })
  .strict()
  .readonly();

const DesktopObservationSchema = z
  .object({
    authority: z.literal('codex_desktop_host'),
    coverage: z.literal('complete_creator_window'),
    counters: ZeroCountersSchema,
  })
  .strict()
  .readonly();

const expectedEventTypes = [
  'DIRECT_USER_CREATOR_ITEM_ACCEPTED',
  'CURRENT_CONVERSATION_SOURCE_ATTESTED',
  'TYPED_AGENT_PACKAGE_DRAFT_RENDERED',
  'DRAFT_TERMINAL_RESULT',
] as const;

export const DesktopCurrentConversationRunReceiptPayloadSchema = z
  .object({
    candidateCommit: z.string().regex(COMMIT_PATTERN),
    runId: z.string().regex(RUN_ID_PATTERN),
    environment: EnvironmentSchema,
    creatorRequestDigest: Sha256DigestSchema,
    source: SourceSchema,
    egress: EgressSchema,
    projection: ProjectionSchema,
    draft: DraftSchema,
    events: z.array(DesktopCurrentConversationRunEventSchema).length(expectedEventTypes.length),
    observation: DesktopObservationSchema,
    terminalResult: z.literal('draft_visible'),
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.source.taskBindingTag !== payload.draft.taskBindingTag) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['draft', 'taskBindingTag'],
        message: 'Source and Draft render must belong to the same active task',
      });
    }
    if (
      payload.egress.snapshotCommitment !== payload.source.snapshotCommitment ||
      payload.egress.creatorRequestDigest !== payload.creatorRequestDigest
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['egress'],
        message: 'Host egress receipt must bind the exact source and request',
      });
    }
    if (
      payload.projection.snapshotCommitment !== payload.source.snapshotCommitment ||
      payload.projection.creatorRequestDigest !== payload.creatorRequestDigest ||
      payload.projection.extractedCandidateDigest !== payload.egress.extractedCandidateDigest ||
      payload.projection.draftFingerprint !== payload.draft.draftFingerprint
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['projection'],
        message: 'Host projection must bind the guarded candidate to the exact typed Draft',
      });
    }
    let previousEventDigest: Sha256Digest | null = null;
    let previousTimestamp = -1;
    for (const [index, event] of payload.events.entries()) {
      const timestamp = Date.parse(event.occurredAt);
      if (
        event.sequence !== index ||
        event.type !== expectedEventTypes[index] ||
        event.previousEventDigest !== previousEventDigest ||
        event.eventDigest !== digestEventInput(event) ||
        !Number.isFinite(timestamp) ||
        new Date(timestamp).toISOString() !== event.occurredAt ||
        timestamp < previousTimestamp
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['events', index],
          message: 'Run events must form the exact ordered event hash chain',
        });
      }
      previousEventDigest = event.eventDigest;
      previousTimestamp = timestamp;
    }
  })
  .readonly();
export type DesktopCurrentConversationRunReceiptPayload = z.infer<
  typeof DesktopCurrentConversationRunReceiptPayloadSchema
>;

const SignatureObjectSchema = z
  .object({
    algorithm: z.literal('ed25519'),
    issuer: z.literal('openai_codex_desktop_host'),
    keyId: z.string().regex(SAFE_KEY_ID_PATTERN),
    value: z.string().regex(ED25519_SIGNATURE_PATTERN),
  })
  .strict();
const SignatureSchema = SignatureObjectSchema.readonly();

export const DesktopCurrentConversationRunReceiptSchema = z
  .object({
    protocol: z.literal(DESKTOP_CURRENT_CONVERSATION_RUN_RECEIPT_PROTOCOL),
    payload: DesktopCurrentConversationRunReceiptPayloadSchema,
    signature: SignatureSchema,
  })
  .strict()
  .readonly();
export type DesktopCurrentConversationRunReceipt = z.infer<
  typeof DesktopCurrentConversationRunReceiptSchema
>;

export type DesktopCurrentConversationRunReceiptTrust = Readonly<{
  expectedCandidateCommit: string;
  trustedKeys: readonly Readonly<{
    issuer: 'openai_codex_desktop_host';
    keyId: string;
    publicKey: KeyLike;
  }>[];
}>;

const SignatureMetadataSchema = SignatureObjectSchema.omit({ value: true }).readonly();

export function createDesktopCurrentConversationRunEvent(
  input: unknown,
): DesktopCurrentConversationRunEvent {
  const eventInput = exactDetached(EventInputSchema, input, 'Desktop run event');
  return exactDetached(
    DesktopCurrentConversationRunEventSchema,
    { ...eventInput, eventDigest: digestEventInput(eventInput) },
    'Desktop run event',
  );
}

export function serializeDesktopCurrentConversationRunReceiptPayload(input: unknown): string {
  return canonicalizeJson(
    exactDetached(
      DesktopCurrentConversationRunReceiptPayloadSchema,
      input,
      'Desktop current-conversation run receipt payload',
    ),
  );
}

export function serializeDesktopCurrentConversationRunReceiptSignatureMessage(
  payloadInput: unknown,
  signatureInput: unknown,
): string {
  const payload = exactDetached(
    DesktopCurrentConversationRunReceiptPayloadSchema,
    payloadInput,
    'Desktop current-conversation run receipt payload',
  );
  const signature = exactDetached(
    SignatureMetadataSchema,
    signatureInput,
    'Desktop current-conversation run receipt signature metadata',
  );
  return `${SIGNATURE_MESSAGE_DOMAIN}\n${canonicalizeJson({
    protocol: DESKTOP_CURRENT_CONVERSATION_RUN_RECEIPT_PROTOCOL,
    payload,
    signature,
  })}`;
}

export function verifyDesktopCurrentConversationRunReceipt(
  input: unknown,
  trust: DesktopCurrentConversationRunReceiptTrust,
): DesktopCurrentConversationRunReceipt {
  const receipt = exactDetached(
    DesktopCurrentConversationRunReceiptSchema,
    input,
    'Desktop current-conversation run receipt',
  );
  const checkedTrust = snapshotTrust(trust);
  if (receipt.payload.candidateCommit !== checkedTrust.expectedCandidateCommit) {
    throw new TypeError('Desktop run receipt does not match the expected candidate commit');
  }
  const trustedKey = checkedTrust.trustedKeys.find(
    (entry) => entry.issuer === receipt.signature.issuer && entry.keyId === receipt.signature.keyId,
  );
  if (trustedKey === undefined) {
    throw new TypeError('Desktop run receipt lacks a trusted Desktop Host signature');
  }
  let valid = false;
  try {
    const signature = Buffer.from(receipt.signature.value, 'base64url');
    valid =
      signature.length === 64 &&
      signature.toString('base64url') === receipt.signature.value &&
      verifySignature(
        null,
        Buffer.from(
          serializeDesktopCurrentConversationRunReceiptSignatureMessage(receipt.payload, {
            algorithm: receipt.signature.algorithm,
            issuer: receipt.signature.issuer,
            keyId: receipt.signature.keyId,
          }),
          'utf8',
        ),
        trustedKey.publicKey,
        signature,
      );
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new TypeError('Desktop run receipt lacks a trusted Desktop Host signature');
  }
  return receipt;
}

export function serializeDesktopCurrentConversationRunReceipt(
  input: unknown,
  trust: DesktopCurrentConversationRunReceiptTrust,
): string {
  return canonicalizeJson(verifyDesktopCurrentConversationRunReceipt(input, trust));
}

export function parseDesktopCurrentConversationRunReceipt(
  text: string,
  trust: DesktopCurrentConversationRunReceiptTrust,
): DesktopCurrentConversationRunReceipt {
  if (
    typeof text !== 'string' ||
    Buffer.byteLength(text, 'utf8') > DESKTOP_CURRENT_CONVERSATION_RUN_RECEIPT_MAX_BYTES
  ) {
    throw new TypeError('Desktop current-conversation run receipt exceeds the byte limit');
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new TypeError('Desktop current-conversation run receipt is not valid JSON');
  }
  const receipt = verifyDesktopCurrentConversationRunReceipt(value, trust);
  if (canonicalizeJson(receipt) !== text) {
    throw new TypeError('Desktop current-conversation run receipt is not exact canonical JSON');
  }
  return receipt;
}

export function digestDesktopCurrentConversationRunReceipt(
  input: unknown,
  trust: DesktopCurrentConversationRunReceiptTrust,
): Sha256Digest {
  const bytes = serializeDesktopCurrentConversationRunReceipt(input, trust);
  return Sha256DigestSchema.parse(
    `sha256:${createHash('sha256').update(bytes, 'utf8').digest('hex')}`,
  );
}

function digestEventInput(input: {
  sequence: number;
  type: z.infer<typeof EventTypeSchema>;
  occurredAt: string;
  previousEventDigest: Sha256Digest | null;
}): Sha256Digest {
  return canonicalFingerprint(EVENT_FINGERPRINT_DOMAIN, {
    sequence: input.sequence,
    type: input.type,
    occurredAt: input.occurredAt,
    previousEventDigest: input.previousEventDigest,
  });
}

function snapshotTrust(
  trust: DesktopCurrentConversationRunReceiptTrust,
): DesktopCurrentConversationRunReceiptTrust {
  try {
    const trustValues = exactDataProperties(trust, ['expectedCandidateCommit', 'trustedKeys']);
    const expectedCandidateCommit = trustValues.expectedCandidateCommit;
    const rawTrustedKeys = trustValues.trustedKeys;
    if (
      typeof expectedCandidateCommit !== 'string' ||
      !COMMIT_PATTERN.test(expectedCandidateCommit)
    ) {
      throw new TypeError();
    }
    if (!Array.isArray(rawTrustedKeys) || isProxy(rawTrustedKeys) || rawTrustedKeys.length < 1) {
      throw new TypeError();
    }
    const keyDescriptors = Object.getOwnPropertyDescriptors(rawTrustedKeys);
    const keyNames = Reflect.ownKeys(keyDescriptors).filter((key) => key !== 'length');
    if (
      keyNames.length !== rawTrustedKeys.length ||
      keyNames.some((key, index) => typeof key !== 'string' || key !== String(index))
    ) {
      throw new TypeError();
    }
    const trustedKeys = keyNames.map((key) => {
      const descriptor = keyDescriptors[key as string];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError();
      }
      const entry = exactDataProperties(descriptor.value, ['issuer', 'keyId', 'publicKey']);
      if (
        entry.issuer !== 'openai_codex_desktop_host' ||
        typeof entry.keyId !== 'string' ||
        !SAFE_KEY_ID_PATTERN.test(entry.keyId)
      ) {
        throw new TypeError();
      }
      return Object.freeze({
        issuer: 'openai_codex_desktop_host' as const,
        keyId: entry.keyId,
        publicKey: entry.publicKey as KeyLike,
      });
    });
    if (new Set(trustedKeys.map(({ keyId }) => keyId)).size !== trustedKeys.length) {
      throw new TypeError();
    }
    return Object.freeze({
      expectedCandidateCommit,
      trustedKeys: Object.freeze(trustedKeys),
    });
  } catch {
    throw new TypeError('Desktop run receipt trust configuration is invalid');
  }
}

function exactDataProperties(
  input: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || isProxy(input)) throw new TypeError();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))) {
    throw new TypeError();
  }
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError();
    }
    values[key] = descriptor.value;
  }
  if (allowedKeys.some((key) => !Object.hasOwn(values, key))) throw new TypeError();
  return values;
}

function exactDetached<Schema extends z.ZodTypeAny>(
  schema: Schema,
  input: unknown,
  label: string,
): z.output<Schema> {
  const snapshot = snapshotJson(input, 0, { nodes: 0, bytes: 0 });
  const before = canonicalizeJson(snapshot);
  if (Buffer.byteLength(before, 'utf8') > DESKTOP_CURRENT_CONVERSATION_RUN_RECEIPT_MAX_BYTES) {
    throw new TypeError(`${label} exceeds the byte limit`);
  }
  const parsed = schema.parse(snapshot);
  if (canonicalizeJson(parsed) !== before) throw new TypeError(`${label} is not exact`);
  return deepFreeze(parsed);
}

function snapshotJson(
  input: unknown,
  depth: number,
  budget: { nodes: number; bytes: number },
): unknown {
  budget.nodes += 1;
  if (budget.nodes > 4_096 || depth > 20) throw new TypeError('Receipt is too complex');
  if (input === null || typeof input === 'boolean') return input;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new TypeError('Receipt is not canonical JSON');
    return input;
  }
  if (typeof input === 'string') {
    budget.bytes += Buffer.byteLength(input, 'utf8');
    if (
      budget.bytes > DESKTOP_CURRENT_CONVERSATION_RUN_RECEIPT_MAX_BYTES ||
      containsLoneSurrogate(input)
    ) {
      throw new TypeError('Receipt exceeds the byte limit');
    }
    return input;
  }
  if (typeof input !== 'object' || isProxy(input)) {
    throw new TypeError('Receipt must contain plain JSON values');
  }
  if (Array.isArray(input)) {
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors).filter((key) => key !== 'length');
    if (
      keys.length !== input.length ||
      keys.some((key, index) => typeof key !== 'string' || key !== String(index))
    ) {
      throw new TypeError('Receipt arrays must be dense');
    }
    return keys.map((key) => {
      const descriptor = descriptors[key as string];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError('Receipt properties must be enumerable data properties');
      }
      return snapshotJson(descriptor.value, depth + 1, budget);
    });
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Receipt must contain plain JSON objects');
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || containsLoneSurrogate(key)) {
      throw new TypeError('Receipt contains a malformed key');
    }
    const descriptor = descriptors[key];
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError('Receipt properties must be enumerable data properties');
    }
    budget.bytes += Buffer.byteLength(key, 'utf8');
    if (budget.bytes > DESKTOP_CURRENT_CONVERSATION_RUN_RECEIPT_MAX_BYTES) {
      throw new TypeError('Receipt exceeds the byte limit');
    }
    output[key] = snapshotJson(descriptor.value, depth + 1, budget);
  }
  return output;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
