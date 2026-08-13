import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { canonicalJsonBytes } from './canonical-json.js';
import { equalHexDigest, SHA256_HEX_PATTERN, sha256Hex } from './digest.js';
import { fail } from './errors.js';

const OBJECT_MAGIC = Buffer.from('CSNPENC1', 'ascii');
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export type SnapshotEncryptionContext = Readonly<{
  schemaVersion: 1;
  creatorId: string;
  snapshotDigest: string;
  archiveDigest: string;
}>;

export type EncryptedSnapshotObject = Readonly<{
  schemaVersion: 1;
  algorithm: 'AES-256-GCM';
  objectBytes: Buffer;
  cipherDigest: string;
  nonce: Buffer;
}>;

function assertContext(context: SnapshotEncryptionContext): void {
  if (
    context.schemaVersion !== 1 ||
    typeof context.creatorId !== 'string' ||
    context.creatorId.length === 0 ||
    Buffer.byteLength(context.creatorId, 'utf8') > 256 ||
    !SHA256_HEX_PATTERN.test(context.snapshotDigest) ||
    !SHA256_HEX_PATTERN.test(context.archiveDigest)
  ) {
    fail('SNAPSHOT_ENCRYPTION_INVALID');
  }
}

function assertKeyAndNonce(key: Uint8Array, nonce: Uint8Array): void {
  if (key.byteLength !== KEY_BYTES || nonce.byteLength !== NONCE_BYTES) {
    fail('SNAPSHOT_ENCRYPTION_INVALID');
  }
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

export function encryptSnapshotArchive(
  archiveBytes: Uint8Array,
  context: SnapshotEncryptionContext,
  dataEncryptionKey: Uint8Array,
  nonce: Uint8Array = randomBytes(NONCE_BYTES),
): EncryptedSnapshotObject {
  assertContext(context);
  if (!equalHexDigest(sha256Hex(archiveBytes), context.archiveDigest)) {
    fail('SNAPSHOT_DIGEST_MISMATCH');
  }
  const aad = canonicalJsonBytes(context);
  const encrypted = aes256GcmEncrypt(archiveBytes, dataEncryptionKey, nonce, aad);
  const objectBytes = Buffer.concat([
    OBJECT_MAGIC,
    Buffer.from(nonce),
    encrypted.ciphertext,
    encrypted.tag,
  ]);
  return Object.freeze({
    schemaVersion: 1,
    algorithm: 'AES-256-GCM',
    objectBytes,
    cipherDigest: sha256Hex(objectBytes),
    nonce: Buffer.from(nonce),
  });
}

export function decryptSnapshotArchive(
  objectBytes: Uint8Array,
  context: SnapshotEncryptionContext,
  dataEncryptionKey: Uint8Array,
  expectedCipherDigest: string,
): Buffer {
  assertContext(context);
  const object = Buffer.from(objectBytes);
  if (
    !equalHexDigest(sha256Hex(object), expectedCipherDigest) ||
    object.byteLength < OBJECT_MAGIC.byteLength + NONCE_BYTES + TAG_BYTES ||
    !object.subarray(0, OBJECT_MAGIC.byteLength).equals(OBJECT_MAGIC)
  ) {
    fail('SNAPSHOT_ENCRYPTION_INVALID');
  }

  const nonceStart = OBJECT_MAGIC.byteLength;
  const ciphertextStart = nonceStart + NONCE_BYTES;
  const tagStart = object.byteLength - TAG_BYTES;
  const nonce = object.subarray(nonceStart, ciphertextStart);
  const ciphertext = object.subarray(ciphertextStart, tagStart);
  const tag = object.subarray(tagStart);
  assertKeyAndNonce(dataEncryptionKey, nonce);

  try {
    const decipher = createDecipheriv('aes-256-gcm', dataEncryptionKey, nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(canonicalJsonBytes(context));
    decipher.setAuthTag(tag);
    // update 的未认证明文只保存在本函数局部；final 成功前不会交给 archive parser。
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (!equalHexDigest(sha256Hex(plaintext), context.archiveDigest)) {
      fail('SNAPSHOT_DIGEST_MISMATCH');
    }
    return plaintext;
  } catch (error) {
    fail('SNAPSHOT_ENCRYPTION_INVALID', error);
  }
}

export type WrappedSnapshotDataKey = Readonly<{
  keyReference: string;
  wrappedKey: Uint8Array;
  plaintextKey: Uint8Array;
}>;

export interface SnapshotKeyEnvelopePort {
  createDataKey(context: SnapshotEncryptionContext): Promise<WrappedSnapshotDataKey>;
  unwrapDataKey(input: {
    context: SnapshotEncryptionContext;
    keyReference: string;
    wrappedKey: Uint8Array;
  }): Promise<Uint8Array>;
}
