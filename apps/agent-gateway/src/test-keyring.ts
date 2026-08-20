import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import {
  BrokerSensitiveMessageSchema,
  UuidSchema,
  brokerSensitiveMessageAadBytes,
  brokerSensitiveMessageAadDigest,
  brokerSensitiveMessageCipherDigest,
  canonicalizeJson,
  domainSeparatedHmacSha256,
  parseJsonNoDuplicateKeys,
  type BrokerSensitiveMessage,
} from '@cb/creator-agent-protocol';
import {
  EncryptedMessageSchema,
  MessageAadSchema,
  type EncryptedMessage,
  type MessageAad,
} from '@cb/creator-agent-persistence';
import { z } from 'zod';

import type { GatewayUserMessageSealer } from './lifecycle-outbound.js';
import type { GatewayAssistantMessageSealer } from './postgres-business-event-projector.js';

const MAX_KEYRING_BYTES = 64 * 1_024;
const FatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const CanonicalKeyMaterialSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/u)
  .transform((value, context) => {
    const bytes = Buffer.from(value, 'base64url');
    if (
      bytes.byteLength !== 32 ||
      bytes.toString('base64url') !== value ||
      bytes.every((v) => v === 0)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid key material' });
      return z.NEVER;
    }
    return bytes;
  });
const KeyStatusSchema = z.enum(['ACTIVE', 'DECRYPT_ONLY']);
const OwnerKeySchema = z
  .object({
    keyId: z.string().regex(/^[-A-Za-z0-9_.:/]{1,256}$/u),
    status: KeyStatusSchema,
    encryptionKey: CanonicalKeyMaterialSchema,
  })
  .strict();
const SessionKeySchema = z
  .object({
    keyId: z.string().regex(/^[a-z0-9][a-z0-9._:-]{2,127}$/u),
    status: KeyStatusSchema,
    encryptionKey: CanonicalKeyMaterialSchema,
  })
  .strict();
const TestKeyringSchema = z
  .object({
    protocol: z.literal('combo.gateway-test-keyring/1'),
    schemaVersion: z.literal(1),
    owners: z
      .array(
        z
          .object({
            ownerId: UuidSchema,
            digestKey: CanonicalKeyMaterialSchema,
            messageKeys: z.array(OwnerKeySchema).min(1).max(8),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    workerInstallations: z
      .array(
        z
          .object({
            installationId: UuidSchema,
            sessionKeys: z.array(SessionKeySchema).min(1).max(8),
          })
          .strict(),
      )
      .min(1)
      .max(32),
  })
  .strict()
  .superRefine((keyring, context) => {
    const ownerIds = keyring.owners.map((owner) => owner.ownerId);
    const installationIds = keyring.workerInstallations.map(
      (installation) => installation.installationId,
    );
    const ownerKeyIds = keyring.owners.flatMap((owner) =>
      owner.messageKeys.map((key) => key.keyId),
    );
    const sessionKeyIds = keyring.workerInstallations.flatMap((installation) =>
      installation.sessionKeys.map((key) => key.keyId),
    );
    for (const [path, values] of [
      [['owners'], ownerIds],
      [['workerInstallations'], installationIds],
      [['owners', 'messageKeys'], ownerKeyIds],
      [['workerInstallations', 'sessionKeys'], sessionKeyIds],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path],
          message: 'keyring identities must be globally unique',
        });
      }
    }
    keyring.owners.forEach((owner, ownerIndex) => {
      if (owner.messageKeys.filter((key) => key.status === 'ACTIVE').length !== 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['owners', ownerIndex, 'messageKeys'],
          message: 'owner must have exactly one active message key',
        });
      }
    });
    keyring.workerInstallations.forEach((installation, installationIndex) => {
      if (installation.sessionKeys.filter((key) => key.status === 'ACTIVE').length !== 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['workerInstallations', installationIndex, 'sessionKeys'],
          message: 'installation must have exactly one active session key',
        });
      }
    });
  });

export type GatewayTestKeyringAdapters = Readonly<{
  sealUserMessage: GatewayUserMessageSealer;
  sealAssistantMessage: GatewayAssistantMessageSealer;
}>;

export class GatewayTestKeyringError extends Error {
  public constructor(
    public readonly code:
      | 'TEST_KEYRING_FILE_INVALID'
      | 'TEST_KEYRING_AUTHORITY_UNAVAILABLE'
      | 'TEST_KEYRING_AUTHENTICATION_FAILED',
  ) {
    super(code);
    this.name = 'GatewayTestKeyringError';
  }
}

/** Loads a Test-only mounted keyring. Raw keys never enter process env, logs, or return values. */
export function loadGatewayTestKeyring(path: string): GatewayTestKeyringAdapters {
  try {
    if (!isAbsolute(path) || path.length > 1_024 || containsControlCharacter(path)) {
      throw new Error('path');
    }
    const keyring = readMountedKeyring(path);
    const owners = new Map(keyring.owners.map((owner) => [owner.ownerId, owner]));
    const installations = new Map(
      keyring.workerInstallations.map((installation) => [
        installation.installationId,
        installation,
      ]),
    );
    return Object.freeze({
      sealUserMessage: async (input) => {
        input.signal.throwIfAborted();
        const creatorId = UuidSchema.parse(input.creatorId);
        const installationId = UuidSchema.parse(input.installationId);
        const owner = owners.get(creatorId);
        const installation = installations.get(installationId);
        if (owner === undefined || installation === undefined) throw unavailable();
        const plaintext = openDurableMessage(input.durableMessage, input.durableAad, owner);
        const active = installation.sessionKeys.find((key) => key.status === 'ACTIVE');
        if (active === undefined) throw unavailable();
        input.signal.throwIfAborted();
        return sealBrokerMessage(plaintext, active.keyId, active.encryptionKey, {
          protocol: 'combo.creator-broker/1',
          schemaVersion: 1,
          envelopeType: 'invocation.prepare',
          messageId: UuidSchema.parse(input.command.messageId),
          conversationId: UuidSchema.parse(input.command.conversationId),
          invocationId: UuidSchema.parse(input.command.invocationId),
          workerSessionId: UuidSchema.parse(input.command.workerSessionId),
          role: 'USER',
          keyId: active.keyId,
        });
      },
      sealAssistantMessage: async ({
        resultCiphertext,
        aad,
        signal,
        installationId,
        workerSessionId,
      }) => {
        signal.throwIfAborted();
        const parsedCiphertext = BrokerSensitiveMessageSchema.parse(resultCiphertext);
        if (
          parsedCiphertext.aad.envelopeType !== 'invocation.succeeded' ||
          parsedCiphertext.aad.role !== 'ASSISTANT' ||
          parsedCiphertext.aad.workerSessionId !== UuidSchema.parse(workerSessionId)
        ) {
          throw authenticationFailed();
        }
        const installation = installations.get(UuidSchema.parse(installationId));
        const sessionKey = installation?.sessionKeys.find(
          (candidate) => candidate.keyId === parsedCiphertext.keyId,
        );
        const owner = owners.get(MessageAadSchema.parse(aad).ownerId);
        if (sessionKey === undefined || owner === undefined) throw unavailable();
        const plaintext = openBrokerMessage(parsedCiphertext, sessionKey.encryptionKey);
        const active = owner.messageKeys.find((key) => key.status === 'ACTIVE');
        if (active === undefined) throw unavailable();
        signal.throwIfAborted();
        return {
          encryptedMessage: sealDurableMessage(
            plaintext,
            active.keyId,
            active.encryptionKey,
            owner.digestKey,
            aad,
          ),
          verifiedResultDigest: domainSeparatedHmacSha256(
            'combo:vnext:result:v1',
            owner.digestKey,
            { text: plaintext },
          ),
        };
      },
    });
  } catch (error) {
    if (error instanceof GatewayTestKeyringError) throw error;
    throw new GatewayTestKeyringError('TEST_KEYRING_FILE_INVALID');
  }
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function readMountedKeyring(path: string): z.infer<typeof TestKeyringSchema> {
  // O_NOFOLLOW plus fstat/read on the same descriptor closes the pathname TOCTOU window.
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    const currentUid = process.getuid?.();
    if (
      !stat.isFile() ||
      stat.size < 2 ||
      stat.size > MAX_KEYRING_BYTES ||
      (stat.mode & 0o077) !== 0 ||
      (currentUid !== undefined && stat.uid !== currentUid)
    ) {
      throw new Error('file authority');
    }
    const text = FatalUtf8Decoder.decode(readFileSync(descriptor));
    return TestKeyringSchema.parse(parseJsonNoDuplicateKeys(text));
  } finally {
    closeSync(descriptor);
  }
}

type ParsedKeyring = z.infer<typeof TestKeyringSchema>;
type Owner = ParsedKeyring['owners'][number];

function openDurableMessage(encryptedInput: EncryptedMessage, aadInput: MessageAad, owner: Owner) {
  try {
    const encrypted = EncryptedMessageSchema.parse(encryptedInput);
    const aad = MessageAadSchema.parse(aadInput);
    if (aad.ownerId !== owner.ownerId) throw new Error('owner');
    const key = owner.messageKeys.find((candidate) => candidate.keyId === encrypted.keyId);
    if (key === undefined) throw unavailable();
    const expectedCipherDigest = createHash('sha256')
      .update(encrypted.nonce)
      .update(encrypted.ciphertext)
      .update(encrypted.authTag)
      .digest('hex');
    if (!safeHexEqual(expectedCipherDigest, encrypted.cipherDigest)) throw new Error('cipher');
    const decipher = createDecipheriv('aes-256-gcm', key.encryptionKey, encrypted.nonce);
    decipher.setAAD(Buffer.from(canonicalizeJson(aad), 'utf8'), {
      plaintextLength: encrypted.ciphertext.byteLength,
    });
    decipher.setAuthTag(encrypted.authTag);
    const plaintext = FatalUtf8Decoder.decode(
      Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]),
    );
    const contentDigest = domainSeparatedHmacSha256('combo:vnext:message:v1', owner.digestKey, {
      text: plaintext,
    });
    if (!safeHmacEqual(contentDigest, encrypted.contentDigest)) throw new Error('content');
    return plaintext;
  } catch (error) {
    if (error instanceof GatewayTestKeyringError) throw error;
    throw authenticationFailed();
  }
}

function sealDurableMessage(
  plaintext: string,
  keyId: string,
  encryptionKey: Buffer,
  digestKey: Buffer,
  aadInput: MessageAad,
): EncryptedMessage {
  const aad = MessageAadSchema.parse(aadInput);
  const plaintextBytes = Buffer.from(plaintext, 'utf8');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
  cipher.setAAD(Buffer.from(canonicalizeJson(aad), 'utf8'), {
    plaintextLength: plaintextBytes.byteLength,
  });
  const ciphertext = Buffer.concat([cipher.update(plaintextBytes), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return EncryptedMessageSchema.parse({
    algorithm: 'aes-256-gcm/v1',
    keyId,
    nonce,
    ciphertext,
    authTag,
    cipherDigest: createHash('sha256')
      .update(nonce)
      .update(ciphertext)
      .update(authTag)
      .digest('hex'),
    contentDigest: domainSeparatedHmacSha256('combo:vnext:message:v1', digestKey, {
      text: plaintext,
    }),
    aadVersion: 1,
  });
}

function sealBrokerMessage(
  plaintext: string,
  keyId: string,
  encryptionKey: Buffer,
  aad: Parameters<typeof brokerSensitiveMessageAadBytes>[0],
): BrokerSensitiveMessage {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
  cipher.setAAD(brokerSensitiveMessageAadBytes(aad));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const nonceText = nonce.toString('base64url');
  const ciphertextText = ciphertext.toString('base64url');
  const authTagText = authTag.toString('base64url');
  return BrokerSensitiveMessageSchema.parse({
    algorithm: 'aes-256-gcm/v1',
    keyScope: 'worker-session',
    keyId,
    nonce: nonceText,
    ciphertext: ciphertextText,
    authTag: authTagText,
    cipherDigest: brokerSensitiveMessageCipherDigest(nonceText, ciphertextText, authTagText),
    aad,
    aadDigest: brokerSensitiveMessageAadDigest(aad),
    aadVersion: 1,
  });
}

function openBrokerMessage(message: BrokerSensitiveMessage, encryptionKey: Buffer): string {
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      encryptionKey,
      Buffer.from(message.nonce, 'base64url'),
    );
    decipher.setAAD(brokerSensitiveMessageAadBytes(message.aad));
    decipher.setAuthTag(Buffer.from(message.authTag, 'base64url'));
    return FatalUtf8Decoder.decode(
      Buffer.concat([
        decipher.update(Buffer.from(message.ciphertext, 'base64url')),
        decipher.final(),
      ]),
    );
  } catch {
    throw authenticationFailed();
  }
}

function safeHexEqual(left: string, right: string): boolean {
  try {
    return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
  } catch {
    return false;
  }
}

function safeHmacEqual(left: string, right: string): boolean {
  return safeHexEqual(left.slice('hmac-sha256:'.length), right.slice('hmac-sha256:'.length));
}

function unavailable(): GatewayTestKeyringError {
  return new GatewayTestKeyringError('TEST_KEYRING_AUTHORITY_UNAVAILABLE');
}

function authenticationFailed(): GatewayTestKeyringError {
  return new GatewayTestKeyringError('TEST_KEYRING_AUTHENTICATION_FAILED');
}
