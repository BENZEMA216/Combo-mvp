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

export interface EncryptedMessage {
  algorithm: typeof MESSAGE_AEAD_ALGORITHM;
  keyId: string;
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
  cipherDigest: string;
  contentDigest: string;
  aadVersion: typeof MESSAGE_AAD_SCHEMA_VERSION;
}

export interface EncryptMessageInput {
  plaintext: string;
  encryptionKey: Uint8Array;
  digestKey: Uint8Array;
  keyId: string;
  aad: MessageAad;
  nonce?: Uint8Array;
}

export interface DecryptMessageInput {
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

export function encryptMessage(input: EncryptMessageInput): EncryptedMessage {
  const plaintext = Buffer.from(input.plaintext, 'utf8');
  if (plaintext.byteLength < 1 || plaintext.byteLength > MESSAGE_MAX_PLAINTEXT_BYTES) {
    throw new RangeError(`消息必须为 1..${MESSAGE_MAX_PLAINTEXT_BYTES} UTF-8 bytes`);
  }
  if (!/^[-A-Za-z0-9_.:/]{1,256}$/u.test(input.keyId)) throw new TypeError('keyId 不合法');
  const key = assertKey(input.encryptionKey, 'encryptionKey');
  const digestKey = assertKey(input.digestKey, 'digestKey');
  const nonce = input.nonce === undefined ? randomBytes(12) : Buffer.from(input.nonce);
  if (nonce.byteLength !== 12) throw new TypeError('AES-GCM nonce 必须是 12 bytes');
  const aad = MessageAadSchema.parse(input.aad);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aadBytes(aad), { plaintextLength: plaintext.byteLength });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    algorithm: MESSAGE_AEAD_ALGORITHM,
    keyId: input.keyId,
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

export function decryptMessage(input: DecryptMessageInput): string {
  try {
    const encrypted = input.encrypted;
    if (encrypted.algorithm !== MESSAGE_AEAD_ALGORITHM) throw new Error('algorithm');
    if (encrypted.aadVersion !== MESSAGE_AAD_SCHEMA_VERSION) throw new Error('aad version');
    if (encrypted.nonce.byteLength !== 12 || encrypted.authTag.byteLength !== 16) {
      throw new Error('shape');
    }
    Sha256HexSchema.parse(encrypted.cipherDigest);
    HmacSha256DigestSchema.parse(encrypted.contentDigest);
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
