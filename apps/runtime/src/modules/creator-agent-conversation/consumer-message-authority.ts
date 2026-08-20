import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import {
  UuidSchema,
  canonicalizeJson,
  domainSeparatedHmacSha256,
  parseJsonNoDuplicateKeys,
} from '@cb/creator-agent-protocol';
import {
  EncryptedMessageSchema,
  MessageAadSchema,
  type EncryptedMessage,
  type MessageAad,
} from '@cb/creator-agent-persistence';
import { z } from 'zod';

const MAX_KEYRING_BYTES = 64 * 1_024;
const FatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const KeyMaterialSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/u)
  .transform((value, context) => {
    const bytes = Buffer.from(value, 'base64url');
    if (
      bytes.byteLength !== 32 ||
      bytes.toString('base64url') !== value ||
      bytes.every((octet) => octet === 0)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid key material' });
      return z.NEVER;
    }
    return bytes;
  });
const OwnerKeySchema = z
  .object({
    keyId: z.string().regex(/^[-A-Za-z0-9_.:/]{1,256}$/u),
    status: z.enum(['ACTIVE', 'DECRYPT_ONLY']),
    encryptionKey: KeyMaterialSchema,
  })
  .strict();
const SessionKeySchema = z
  .object({
    keyId: z.string().regex(/^[a-z0-9][a-z0-9._:-]{2,127}$/u),
    status: z.enum(['ACTIVE', 'DECRYPT_ONLY']),
    encryptionKey: KeyMaterialSchema,
  })
  .strict();

/** Exact shared Test mount protocol also consumed by Agent Gateway. */
const TestKeyringSchema = z
  .object({
    protocol: z.literal('combo.gateway-test-keyring/1'),
    schemaVersion: z.literal(1),
    owners: z
      .array(
        z
          .object({
            ownerId: UuidSchema,
            digestKey: KeyMaterialSchema,
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
    const identities = [
      ['owners', keyring.owners.map((owner) => owner.ownerId)],
      [
        'workerInstallations',
        keyring.workerInstallations.map((installation) => installation.installationId),
      ],
      [
        'ownerMessageKeys',
        keyring.owners.flatMap((owner) => owner.messageKeys.map((key) => key.keyId)),
      ],
      [
        'workerSessionKeys',
        keyring.workerInstallations.flatMap((installation) =>
          installation.sessionKeys.map((key) => key.keyId),
        ),
      ],
    ] as const;
    for (const [path, values] of identities) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [path],
          message: 'duplicate key identity',
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

export interface BoundConsumerUserMessage {
  readonly requestDigest: string;
  seal(input: {
    conversationId: string;
    messageId: string;
    signal: AbortSignal;
  }): Promise<EncryptedMessage>;
}

/**
 * Owns the authenticated plaintext boundary. Request/content digests and ciphertext are derived
 * from the same UTF-8 value and the same owner key snapshot; callers cannot supply them separately.
 */
export interface ConsumerMessageAuthority {
  bindUserMessage(input: {
    creatorId: string;
    text: string;
    signal: AbortSignal;
  }): Promise<BoundConsumerUserMessage>;
  openMessage(input: {
    encrypted: EncryptedMessage;
    aad: MessageAad;
    signal: AbortSignal;
  }): Promise<string>;
}

export class ConsumerMessageAuthorityError extends Error {
  public constructor(
    public readonly code:
      | 'MESSAGE_AUTHORITY_INVALID'
      | 'MESSAGE_AUTHORITY_UNAVAILABLE'
      | 'MESSAGE_AUTHENTICATION_FAILED',
  ) {
    super(code);
    this.name = 'ConsumerMessageAuthorityError';
  }
}

/** Test-only mounted-file adapter. Raw keys never enter env, logs, SQL, or return values. */
export function loadTestConsumerMessageAuthority(path: string): ConsumerMessageAuthority {
  try {
    if (!isAbsolute(path) || path.length > 1_024 || containsControlCharacter(path)) {
      throw new Error('path');
    }
    const keyring = readMountedKeyring(path);
    const owners = new Map(keyring.owners.map((owner) => [owner.ownerId, owner]));
    const authority: ConsumerMessageAuthority = {
      async bindUserMessage({
        creatorId: rawCreatorId,
        text,
        signal,
      }: {
        creatorId: string;
        text: string;
        signal: AbortSignal;
      }) {
        signal.throwIfAborted();
        const creatorId = UuidSchema.parse(rawCreatorId);
        const plaintext = Buffer.from(text, 'utf8');
        if (plaintext.byteLength < 1 || plaintext.byteLength > 32_768) throw unavailable();
        const owner = owners.get(creatorId);
        const active = owner?.messageKeys.find((key) => key.status === 'ACTIVE');
        if (owner === undefined || active === undefined) throw unavailable();
        const requestDigest = requestDigestFor(plaintext, owner.digestKey);
        let sealed = false;
        return Object.freeze({
          requestDigest,
          async seal({
            conversationId: rawConversationId,
            messageId: rawMessageId,
            signal: sealSignal,
          }: {
            conversationId: string;
            messageId: string;
            signal: AbortSignal;
          }) {
            sealSignal.throwIfAborted();
            if (sealed) throw unavailable();
            sealed = true;
            const aad = MessageAadSchema.parse({
              schemaVersion: 1,
              ownerId: creatorId,
              conversationId: UuidSchema.parse(rawConversationId),
              messageId: UuidSchema.parse(rawMessageId),
              role: 'USER',
            });
            return sealDurableMessage(
              text,
              active.keyId,
              active.encryptionKey,
              owner.digestKey,
              aad,
            );
          },
        });
      },
      async openMessage({
        encrypted,
        aad,
        signal,
      }: {
        encrypted: EncryptedMessage;
        aad: MessageAad;
        signal: AbortSignal;
      }) {
        signal.throwIfAborted();
        const parsedAad = MessageAadSchema.parse(aad);
        const owner = owners.get(parsedAad.ownerId);
        if (owner === undefined) throw unavailable();
        return openDurableMessage(encrypted, parsedAad, owner);
      },
    };
    return Object.freeze(authority);
  } catch (error) {
    if (error instanceof ConsumerMessageAuthorityError) throw error;
    throw new ConsumerMessageAuthorityError('MESSAGE_AUTHORITY_INVALID');
  }
}

function readMountedKeyring(path: string): z.infer<typeof TestKeyringSchema> {
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
    return TestKeyringSchema.parse(
      parseJsonNoDuplicateKeys(FatalUtf8Decoder.decode(readFileSync(descriptor))),
    );
  } finally {
    closeSync(descriptor);
  }
}

type Owner = z.infer<typeof TestKeyringSchema>['owners'][number];

function requestDigestFor(plaintext: Buffer, digestKey: Buffer): string {
  return `hmac-sha256:${createHmac('sha256', digestKey)
    .update('combo:vnext:request:v1\0', 'utf8')
    .update(plaintext)
    .digest('hex')}`;
}

function sealDurableMessage(
  plaintext: string,
  keyId: string,
  encryptionKey: Buffer,
  digestKey: Buffer,
  aad: MessageAad,
): EncryptedMessage {
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

function openDurableMessage(
  encryptedInput: EncryptedMessage,
  aad: MessageAad,
  owner: Owner,
): string {
  try {
    const encrypted = EncryptedMessageSchema.parse(encryptedInput);
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
    const expectedContent = domainSeparatedHmacSha256('combo:vnext:message:v1', owner.digestKey, {
      text: plaintext,
    });
    if (!safeHmacEqual(expectedContent, encrypted.contentDigest)) throw new Error('content');
    return plaintext;
  } catch (error) {
    if (
      error instanceof ConsumerMessageAuthorityError &&
      error.code === 'MESSAGE_AUTHORITY_UNAVAILABLE'
    ) {
      throw error;
    }
    throw new ConsumerMessageAuthorityError('MESSAGE_AUTHENTICATION_FAILED');
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

function unavailable(): ConsumerMessageAuthorityError {
  return new ConsumerMessageAuthorityError('MESSAGE_AUTHORITY_UNAVAILABLE');
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}
