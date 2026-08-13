import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  SNAPSHOT_ARCHIVE_OBJECT_FORMAT,
  SNAPSHOT_ARCHIVE_OBJECT_MAGIC,
  SNAPSHOT_ENVELOPE_PROTOCOL,
  SnapshotArchiveEnvelopeAadSchema,
  SnapshotArchiveEnvelopeSchema,
  parseSnapshotArchiveCipherObject,
  snapshotArchiveEnvelopeAadBytes,
  snapshotArchiveEnvelopeAadDigest,
  type SnapshotArchiveEnvelope,
  type SnapshotArchiveEnvelopeAad,
} from '@cb/creator-agent-protocol';

import { equalHexDigest, sha256Hex } from './digest.js';
import { fail } from './errors.js';

const OBJECT_MAGIC = Buffer.from(SNAPSHOT_ARCHIVE_OBJECT_MAGIC, 'ascii');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const WRAPPED_DEK_BYTES = 40;

export type SnapshotEncryptionContext = SnapshotArchiveEnvelopeAad;

export type EncryptedSnapshotObject = Readonly<{
  envelope: SnapshotArchiveEnvelope;
  objectBytes: Buffer;
}>;

function parseContext(context: SnapshotEncryptionContext): SnapshotArchiveEnvelopeAad {
  const parsed = SnapshotArchiveEnvelopeAadSchema.safeParse(context);
  if (!parsed.success) fail('SNAPSHOT_ENCRYPTION_INVALID');
  return parsed.data;
}

function assertKeyAndNonce(key: Uint8Array, nonce: Uint8Array): void {
  if (
    !(key instanceof Uint8Array) ||
    !(nonce instanceof Uint8Array) ||
    key.byteLength !== KEY_BYTES ||
    nonce.byteLength !== NONCE_BYTES
  ) {
    fail('SNAPSHOT_ENCRYPTION_INVALID');
  }
}

function parseCanonicalBytes(value: string, expectedBytes: number): Buffer {
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.byteLength !== expectedBytes || bytes.toString('base64url') !== value) {
    fail('SNAPSHOT_ENCRYPTION_INVALID');
  }
  return bytes;
}

export type Aes256GcmResult = Readonly<{ ciphertext: Buffer; tag: Buffer }>;

export function aes256GcmEncrypt(
  plaintext: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array = new Uint8Array(),
): Aes256GcmResult {
  assertKeyAndNonce(key, nonce);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Object.freeze({ ciphertext, tag: cipher.getAuthTag() });
  } catch (error) {
    fail('SNAPSHOT_ENCRYPTION_INVALID', error);
  }
}

function encryptSnapshotArchiveWithNonce(
  archiveBytes: Uint8Array,
  contextInput: SnapshotEncryptionContext,
  dataEncryptionKey: Uint8Array,
  keyWrap: Readonly<{ keyId: string; wrappedDek: Uint8Array }>,
  nonce: Uint8Array,
): EncryptedSnapshotObject {
  const context = parseContext(contextInput);
  if (
    !(archiveBytes instanceof Uint8Array) ||
    archiveBytes.byteLength !== context.plaintextBytes ||
    !equalHexDigest(sha256Hex(archiveBytes), context.archiveDigest) ||
    keyWrap === null ||
    typeof keyWrap !== 'object' ||
    typeof keyWrap.keyId !== 'string' ||
    context.keyId !== keyWrap.keyId ||
    !(keyWrap.wrappedDek instanceof Uint8Array) ||
    keyWrap.wrappedDek.byteLength !== WRAPPED_DEK_BYTES
  ) {
    fail('SNAPSHOT_ENCRYPTION_INVALID');
  }
  const encrypted = aes256GcmEncrypt(
    archiveBytes,
    dataEncryptionKey,
    nonce,
    snapshotArchiveEnvelopeAadBytes(context),
  );
  const objectBytes = Buffer.concat([
    OBJECT_MAGIC,
    Buffer.from(nonce),
    encrypted.ciphertext,
    encrypted.tag,
  ]);
  const envelope = SnapshotArchiveEnvelopeSchema.parse({
    protocol: SNAPSHOT_ENVELOPE_PROTOCOL,
    schemaVersion: 1,
    cipherObjectFormat: SNAPSHOT_ARCHIVE_OBJECT_FORMAT,
    algorithm: 'aes-256-gcm/v1',
    keyWrapAlgorithm: 'rfc3394-aes-256-kw/v1',
    aad: context,
    aadDigest: snapshotArchiveEnvelopeAadDigest(context),
    nonce: Buffer.from(nonce).toString('base64url'),
    authTag: encrypted.tag.toString('base64url'),
    wrappedDek: Buffer.from(keyWrap.wrappedDek).toString('base64url'),
    cipherDigest: sha256Hex(objectBytes),
    cipherBytes: objectBytes.byteLength,
  });
  return Object.freeze({ envelope, objectBytes });
}

/** 生产入口：每个加密对象始终生成独立的 96-bit CSPRNG nonce。 */
export function encryptSnapshotArchive(
  archiveBytes: Uint8Array,
  context: SnapshotEncryptionContext,
  dataEncryptionKey: Uint8Array,
  keyWrap: Readonly<{ keyId: string; wrappedDek: Uint8Array }>,
): EncryptedSnapshotObject {
  return encryptSnapshotArchiveWithNonce(
    archiveBytes,
    context,
    dataEncryptionKey,
    keyWrap,
    randomBytes(NONCE_BYTES),
  );
}

/** 只供已知答案和 mutation 测试使用，不从包入口导出。 */
export function encryptSnapshotArchiveTestOnly(
  archiveBytes: Uint8Array,
  context: SnapshotEncryptionContext,
  dataEncryptionKey: Uint8Array,
  keyWrap: Readonly<{ keyId: string; wrappedDek: Uint8Array }>,
  nonce: Uint8Array,
): EncryptedSnapshotObject {
  return encryptSnapshotArchiveWithNonce(archiveBytes, context, dataEncryptionKey, keyWrap, nonce);
}

export function decryptSnapshotArchive(
  objectBytesInput: Uint8Array,
  envelopeInput: SnapshotArchiveEnvelope,
  dataEncryptionKey: Uint8Array,
): Buffer {
  let envelope: SnapshotArchiveEnvelope;
  try {
    envelope = parseSnapshotArchiveCipherObject(envelopeInput, objectBytesInput);
  } catch {
    fail('SNAPSHOT_ENCRYPTION_INVALID');
  }
  const object = Buffer.from(objectBytesInput);
  const nonceStart = OBJECT_MAGIC.byteLength;
  const ciphertextStart = nonceStart + NONCE_BYTES;
  const tagStart = object.byteLength - TAG_BYTES;
  const nonce = object.subarray(nonceStart, ciphertextStart);
  const ciphertext = object.subarray(ciphertextStart, tagStart);
  const tag = object.subarray(tagStart);
  assertKeyAndNonce(dataEncryptionKey, nonce);
  if (
    !nonce.equals(parseCanonicalBytes(envelope.nonce, NONCE_BYTES)) ||
    !tag.equals(parseCanonicalBytes(envelope.authTag, TAG_BYTES))
  ) {
    fail('SNAPSHOT_ENCRYPTION_INVALID');
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', dataEncryptionKey, nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(snapshotArchiveEnvelopeAadBytes(envelope.aad));
    decipher.setAuthTag(tag);
    // update 的未认证明文只保存在本函数局部；final 成功前不会交给 archive parser。
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (
      plaintext.byteLength !== envelope.aad.plaintextBytes ||
      !equalHexDigest(sha256Hex(plaintext), envelope.aad.archiveDigest)
    ) {
      fail('SNAPSHOT_ENCRYPTION_INVALID');
    }
    return plaintext;
  } catch (error) {
    fail('SNAPSHOT_ENCRYPTION_INVALID', error);
  }
}

export type WrappedSnapshotDataKey = Readonly<{
  keyId: string;
  wrappedDek: Uint8Array;
  plaintextKey: Uint8Array;
}>;

export interface SnapshotKeyEnvelopePort {
  createDataKey(context: SnapshotEncryptionContext): Promise<WrappedSnapshotDataKey>;
  unwrapDataKey(input: {
    context: SnapshotEncryptionContext;
    keyId: string;
    wrappedDek: Uint8Array;
  }): Promise<Uint8Array>;
}
