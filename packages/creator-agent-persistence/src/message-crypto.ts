import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  canonicalizeJson,
  domainSeparatedHmacSha256,
  HmacSha256DigestSchema,
  Sha256HexSchema,
  UuidSchema,
} from '@cb/creator-agent-protocol';
import { z } from 'zod';

export const MESSAGE_AEAD_ALGORITHM = 'aes-256-gcm/v1' as const;
export const MESSAGE_AAD_SCHEMA_VERSION = 1 as const;
export const MESSAGE_MAX_PLAINTEXT_BYTES = 32_768;
export const MessageKeyStatusSchema = z.enum(['ACTIVE', 'DECRYPT_ONLY']);
export type MessageKeyStatus = z.infer<typeof MessageKeyStatusSchema>;

export const MessageKeyIdSchema = z.string().regex(/^[-A-Za-z0-9_.:/]{1,256}$/u);

export const MessageRoleSchema = z.enum(['USER', 'ASSISTANT']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const MessageAadSchema = z
  .object({
    schemaVersion: z.literal(MESSAGE_AAD_SCHEMA_VERSION),
    ownerId: UuidSchema,
    conversationId: UuidSchema,
    messageId: UuidSchema,
    role: MessageRoleSchema,
  })
  .strict();
export type MessageAad = z.infer<typeof MessageAadSchema>;

export const EncryptedMessageSchema = z
  .object({
    algorithm: z.literal(MESSAGE_AEAD_ALGORITHM),
    keyId: MessageKeyIdSchema,
    nonce: z.instanceof(Buffer).refine((value) => value.byteLength === 12),
    ciphertext: z
      .instanceof(Buffer)
      .refine((value) => value.byteLength >= 1 && value.byteLength <= 65_536),
    authTag: z.instanceof(Buffer).refine((value) => value.byteLength === 16),
    cipherDigest: Sha256HexSchema,
    contentDigest: HmacSha256DigestSchema,
    aadVersion: z.literal(MESSAGE_AAD_SCHEMA_VERSION),
  })
  .strict();
export type EncryptedMessage = z.infer<typeof EncryptedMessageSchema>;

export interface RawMessageEncryptionInputForTest {
  plaintext: string;
  encryptionKey: Uint8Array;
  digestKey: Uint8Array;
  keyId: string;
  aad: MessageAad;
}

export interface RawMessageDecryptionInputForTest {
  encrypted: EncryptedMessage;
  encryptionKey: Uint8Array;
  aad: MessageAad;
}

export class MessageAuthenticationError extends Error {
  public readonly code = 'MESSAGE_AUTHENTICATION_FAILED';

  public constructor() {
    super('消息认证失败');
    this.name = 'MessageAuthenticationError';
  }
}

export class MessageKeyUnavailableError extends Error {
  public readonly code = 'MESSAGE_KEY_UNAVAILABLE';
  public readonly state = 'BLOCKED';

  public constructor() {
    super('消息密钥当前不可用');
    this.name = 'MessageKeyUnavailableError';
  }
}

export interface MessageKeySealRequest {
  plaintext: string;
  aad: MessageAad;
  signal: AbortSignal;
}

export const MessageKeySealOutcomeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('SEALED'),
      ownerId: UuidSchema,
      keyId: MessageKeyIdSchema,
      status: z.literal('ACTIVE'),
      encrypted: EncryptedMessageSchema,
    })
    .strict(),
  z.object({ kind: z.literal('UNAVAILABLE') }).strict(),
]);
export type MessageKeySealOutcome = z.infer<typeof MessageKeySealOutcomeSchema>;

export interface MessageKeyOpenRequest {
  encrypted: EncryptedMessage;
  aad: MessageAad;
  signal: AbortSignal;
}

export const MessageKeyOpenOutcomeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('OPENED'),
      ownerId: UuidSchema,
      keyId: MessageKeyIdSchema,
      status: MessageKeyStatusSchema,
      plaintext: z.string().refine((value) => {
        const bytes = Buffer.byteLength(value, 'utf8');
        return bytes >= 1 && bytes <= MESSAGE_MAX_PLAINTEXT_BYTES;
      }),
    })
    .strict(),
  z.object({ kind: z.literal('UNAVAILABLE') }).strict(),
  z.object({ kind: z.literal('AUTHENTICATION_FAILED') }).strict(),
]);
export type MessageKeyOpenOutcome = z.infer<typeof MessageKeyOpenOutcomeSchema>;

/**
 * Opaque KMS/keyring boundary. Implementations must keep raw encryption/HMAC key bytes inside
 * the adapter. OPENED is allowed only after AES-GCM authentication and a timing-safe recomputation
 * of combo:vnext:message:v1 contentDigest; missing historical keys return UNAVAILABLE.
 */
export interface MessageKeyAuthority {
  seal(request: MessageKeySealRequest): Promise<MessageKeySealOutcome>;
  open(request: MessageKeyOpenRequest): Promise<MessageKeyOpenOutcome>;
}

export const MessageKeySecurityAlertReasonSchema = z.enum([
  'ACTIVE_KEY_UNAVAILABLE',
  'KEY_UNAVAILABLE',
  'KEY_AUTHORITY_MISMATCH',
  'MESSAGE_AUTHENTICATION_FAILED',
]);
export type MessageKeySecurityAlertReason = z.infer<typeof MessageKeySecurityAlertReasonSchema>;

export interface MessageKeySecurityAlert {
  reason: MessageKeySecurityAlertReason;
  ownerId: string;
  keyIdDigest: `sha256:${string}`;
}

export interface MessageKeySecurityAlertSink {
  record(alert: MessageKeySecurityAlert, signal: AbortSignal): Promise<void>;
}

export interface SealMessageWithKeyAuthorityInput {
  plaintext: string;
  aad: MessageAad;
  signal?: AbortSignal;
}

export interface OpenMessageWithKeyAuthorityInput {
  encrypted: EncryptedMessage;
  aad: MessageAad;
  signal?: AbortSignal;
}

function assertKey(key: Uint8Array, label: string): Buffer {
  const bytes = Buffer.from(key);
  if (bytes.byteLength !== 32) throw new TypeError(`${label} 必须是 32 bytes`);
  return bytes;
}

function aadBytes(aad: MessageAad): Buffer {
  return Buffer.from(canonicalizeJson(MessageAadSchema.parse(aad)), 'utf8');
}

function cipherDigest(nonce: Uint8Array, ciphertext: Uint8Array, authTag: Uint8Array): string {
  return createHash('sha256').update(nonce).update(ciphertext).update(authTag).digest('hex');
}

function cipherDigestMatches(encrypted: EncryptedMessage): boolean {
  return timingSafeEqual(
    Buffer.from(cipherDigest(encrypted.nonce, encrypted.ciphertext, encrypted.authTag), 'hex'),
    Buffer.from(encrypted.cipherDigest, 'hex'),
  );
}

export function encryptMessageWithRawKeyForTest(
  input: RawMessageEncryptionInputForTest,
): EncryptedMessage {
  const plaintext = Buffer.from(input.plaintext, 'utf8');
  if (plaintext.byteLength < 1 || plaintext.byteLength > MESSAGE_MAX_PLAINTEXT_BYTES) {
    throw new RangeError(`消息必须为 1..${MESSAGE_MAX_PLAINTEXT_BYTES} UTF-8 bytes`);
  }
  const keyId = MessageKeyIdSchema.parse(input.keyId);
  const key = assertKey(input.encryptionKey, 'encryptionKey');
  const digestKey = assertKey(input.digestKey, 'digestKey');
  const nonce = randomBytes(12);
  const aad = MessageAadSchema.parse(input.aad);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aadBytes(aad), { plaintextLength: plaintext.byteLength });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    algorithm: MESSAGE_AEAD_ALGORITHM,
    keyId,
    nonce,
    ciphertext,
    authTag,
    cipherDigest: cipherDigest(nonce, ciphertext, authTag),
    contentDigest: domainSeparatedHmacSha256('combo:vnext:message:v1', digestKey, {
      text: input.plaintext,
    }),
    aadVersion: MESSAGE_AAD_SCHEMA_VERSION,
  };
}

export function decryptMessageWithRawKeyForTest(input: RawMessageDecryptionInputForTest): string {
  try {
    const encrypted = EncryptedMessageSchema.parse(input.encrypted);
    const actualDigest = Buffer.from(
      cipherDigest(encrypted.nonce, encrypted.ciphertext, encrypted.authTag),
      'hex',
    );
    const expectedDigest = Buffer.from(encrypted.cipherDigest, 'hex');
    if (!timingSafeEqual(actualDigest, expectedDigest)) throw new Error('cipher digest');
    const key = assertKey(input.encryptionKey, 'encryptionKey');
    const aad = MessageAadSchema.parse(input.aad);
    const decipher = createDecipheriv('aes-256-gcm', key, encrypted.nonce);
    decipher.setAAD(aadBytes(aad), { plaintextLength: encrypted.ciphertext.byteLength });
    decipher.setAuthTag(encrypted.authTag);
    return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    throw new MessageAuthenticationError();
  }
}

/** Test-adapter primitive; intentionally excluded from the package root. */
export function verifyMessageContentDigestWithRawKeyForTest(
  plaintext: string,
  contentDigest: string,
  digestKey: Uint8Array,
): boolean {
  try {
    const expected = HmacSha256DigestSchema.parse(contentDigest);
    const actual = domainSeparatedHmacSha256(
      'combo:vnext:message:v1',
      assertKey(digestKey, 'digestKey'),
      { text: plaintext },
    );
    return timingSafeEqual(
      Buffer.from(actual.slice('hmac-sha256:'.length), 'hex'),
      Buffer.from(expected.slice('hmac-sha256:'.length), 'hex'),
    );
  } catch {
    return false;
  }
}

function keyIdDigest(keyId: string): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update('combo:vnext:message-key-id:v1\0')
    .update(keyId)
    .digest('hex')}`;
}

async function emitKeyAlert(
  sink: MessageKeySecurityAlertSink,
  ownerId: string,
  keyId: string,
  reason: MessageKeySecurityAlertReason,
  signal: AbortSignal,
): Promise<void> {
  try {
    // A provider timeout leaves its operation signal already aborted. Give the redacted alert a
    // separate short budget so a signal-aware durable sink still has one bounded write attempt.
    const alertSignal = signal.aborted ? AbortSignal.timeout(500) : signal;
    await settleWithSignal(
      sink.record({ reason, ownerId, keyIdDigest: keyIdDigest(keyId) }, alertSignal),
      alertSignal,
    );
  } catch {
    throw new MessageKeyUnavailableError();
  }
}

async function settleWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('MESSAGE_KEY_OPERATION_ABORTED'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function parseSealOutcome(value: unknown): MessageKeySealOutcome | null {
  try {
    const parsed = MessageKeySealOutcomeSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseOpenOutcome(value: unknown): MessageKeyOpenOutcome | null {
  try {
    const parsed = MessageKeyOpenOutcomeSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function sealMessageWithKeyAuthority(
  input: SealMessageWithKeyAuthorityInput,
  authority: MessageKeyAuthority,
  alerts: MessageKeySecurityAlertSink,
): Promise<EncryptedMessage> {
  const aad = MessageAadSchema.parse(input.aad);
  const plaintextBytes =
    typeof input.plaintext === 'string' ? Buffer.byteLength(input.plaintext, 'utf8') : 0;
  if (plaintextBytes < 1 || plaintextBytes > MESSAGE_MAX_PLAINTEXT_BYTES) {
    throw new RangeError(`消息必须为 1..${MESSAGE_MAX_PLAINTEXT_BYTES} UTF-8 bytes`);
  }
  const signal = input.signal ?? AbortSignal.timeout(10_000);
  let rawOutcome: MessageKeySealOutcome;
  try {
    signal.throwIfAborted();
    rawOutcome = await settleWithSignal(
      authority.seal({ plaintext: input.plaintext, aad, signal }),
      signal,
    );
    signal.throwIfAborted();
  } catch {
    await emitKeyAlert(alerts, aad.ownerId, 'unresolved', 'ACTIVE_KEY_UNAVAILABLE', signal);
    throw new MessageKeyUnavailableError();
  }
  const outcome = parseSealOutcome(rawOutcome);
  if (outcome === null) {
    await emitKeyAlert(alerts, aad.ownerId, 'invalid', 'KEY_AUTHORITY_MISMATCH', signal);
    throw new MessageKeyUnavailableError();
  }
  if (outcome.kind === 'UNAVAILABLE') {
    await emitKeyAlert(alerts, aad.ownerId, 'unresolved', 'ACTIVE_KEY_UNAVAILABLE', signal);
    throw new MessageKeyUnavailableError();
  }
  let encrypted: EncryptedMessage;
  try {
    encrypted = EncryptedMessageSchema.parse(outcome.encrypted);
  } catch {
    await emitKeyAlert(alerts, aad.ownerId, 'invalid', 'KEY_AUTHORITY_MISMATCH', signal);
    throw new MessageKeyUnavailableError();
  }
  if (
    outcome.ownerId !== aad.ownerId ||
    outcome.status !== 'ACTIVE' ||
    outcome.keyId !== encrypted.keyId ||
    !cipherDigestMatches(encrypted) ||
    encrypted.ciphertext.byteLength !== Buffer.byteLength(input.plaintext, 'utf8')
  ) {
    await emitKeyAlert(
      alerts,
      aad.ownerId,
      MessageKeyIdSchema.safeParse(outcome.keyId).success ? outcome.keyId : 'invalid',
      'KEY_AUTHORITY_MISMATCH',
      signal,
    );
    throw new MessageKeyUnavailableError();
  }
  return encrypted;
}

export async function openMessageWithKeyAuthority(
  input: OpenMessageWithKeyAuthorityInput,
  authority: MessageKeyAuthority,
  alerts: MessageKeySecurityAlertSink,
): Promise<string> {
  let encrypted: EncryptedMessage;
  let aad: MessageAad;
  const signal = input.signal ?? AbortSignal.timeout(10_000);
  try {
    encrypted = EncryptedMessageSchema.parse(input.encrypted);
    aad = MessageAadSchema.parse(input.aad);
  } catch {
    throw new MessageAuthenticationError();
  }
  if (!cipherDigestMatches(encrypted)) {
    await emitKeyAlert(
      alerts,
      aad.ownerId,
      encrypted.keyId,
      'MESSAGE_AUTHENTICATION_FAILED',
      signal,
    );
    throw new MessageAuthenticationError();
  }
  let rawOutcome: MessageKeyOpenOutcome;
  try {
    signal.throwIfAborted();
    rawOutcome = await settleWithSignal(authority.open({ encrypted, aad, signal }), signal);
    signal.throwIfAborted();
  } catch {
    await emitKeyAlert(alerts, aad.ownerId, encrypted.keyId, 'KEY_UNAVAILABLE', signal);
    throw new MessageKeyUnavailableError();
  }
  const outcome = parseOpenOutcome(rawOutcome);
  if (outcome === null) {
    await emitKeyAlert(alerts, aad.ownerId, encrypted.keyId, 'KEY_AUTHORITY_MISMATCH', signal);
    throw new MessageKeyUnavailableError();
  }
  if (outcome.kind === 'UNAVAILABLE') {
    await emitKeyAlert(alerts, aad.ownerId, encrypted.keyId, 'KEY_UNAVAILABLE', signal);
    throw new MessageKeyUnavailableError();
  }
  if (outcome.kind === 'AUTHENTICATION_FAILED') {
    await emitKeyAlert(
      alerts,
      aad.ownerId,
      encrypted.keyId,
      'MESSAGE_AUTHENTICATION_FAILED',
      signal,
    );
    throw new MessageAuthenticationError();
  }
  const plaintextBytes = Buffer.byteLength(outcome.plaintext, 'utf8');
  if (
    outcome.ownerId !== aad.ownerId ||
    outcome.keyId !== encrypted.keyId ||
    !MessageKeyStatusSchema.safeParse(outcome.status).success ||
    plaintextBytes < 1 ||
    plaintextBytes > MESSAGE_MAX_PLAINTEXT_BYTES
  ) {
    await emitKeyAlert(alerts, aad.ownerId, encrypted.keyId, 'KEY_AUTHORITY_MISMATCH', signal);
    throw new MessageKeyUnavailableError();
  }
  return outcome.plaintext;
}
