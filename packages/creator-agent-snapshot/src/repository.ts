import { timingSafeEqual } from 'node:crypto';

import { parseSnapshotManifest, snapshotDigest } from './manifest.js';
import { equalHexDigest, SHA256_HEX_PATTERN, sha256Hex } from './digest.js';
import { fail } from './errors.js';

export type ImmutableSnapshotObject = Readonly<{
  creatorId: string;
  snapshotDigest: string;
  archiveDigest: string;
  cipherDigest: string;
  manifestBytes: Uint8Array;
  encryptedObjectBytes: Uint8Array;
  keyReference: string;
  wrappedDataKey: Uint8Array;
}>;

export interface SnapshotObjectRepository {
  putIfAbsent(object: ImmutableSnapshotObject): Promise<ImmutableSnapshotObject>;
  get(creatorId: string, snapshotDigest: string): Promise<ImmutableSnapshotObject | undefined>;
}

function cloneObject(object: ImmutableSnapshotObject): ImmutableSnapshotObject {
  return Object.freeze({
    ...object,
    manifestBytes: Buffer.from(object.manifestBytes),
    encryptedObjectBytes: Buffer.from(object.encryptedObjectBytes),
    wrappedDataKey: Buffer.from(object.wrappedDataKey),
  });
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function assertObject(object: ImmutableSnapshotObject): void {
  try {
    const manifest = parseSnapshotManifest(object.manifestBytes);
    if (
      object.creatorId.length === 0 ||
      object.keyReference.length === 0 ||
      !SHA256_HEX_PATTERN.test(object.snapshotDigest) ||
      !SHA256_HEX_PATTERN.test(object.archiveDigest) ||
      !SHA256_HEX_PATTERN.test(object.cipherDigest) ||
      !equalHexDigest(snapshotDigest(manifest), object.snapshotDigest) ||
      !equalHexDigest(sha256Hex(object.manifestBytes), object.snapshotDigest) ||
      !equalHexDigest(sha256Hex(object.encryptedObjectBytes), object.cipherDigest) ||
      object.wrappedDataKey.byteLength === 0
    ) {
      fail('SNAPSHOT_DIGEST_MISMATCH');
    }
  } catch {
    fail('SNAPSHOT_DIGEST_MISMATCH');
  }
}

function objectsEqual(left: ImmutableSnapshotObject, right: ImmutableSnapshotObject): boolean {
  return (
    left.creatorId === right.creatorId &&
    left.snapshotDigest === right.snapshotDigest &&
    left.archiveDigest === right.archiveDigest &&
    left.cipherDigest === right.cipherDigest &&
    left.keyReference === right.keyReference &&
    bytesEqual(left.manifestBytes, right.manifestBytes) &&
    bytesEqual(left.encryptedObjectBytes, right.encryptedObjectBytes) &&
    bytesEqual(left.wrappedDataKey, right.wrappedDataKey)
  );
}

export class InMemoryImmutableSnapshotRepository implements SnapshotObjectRepository {
  readonly #objects = new Map<string, ImmutableSnapshotObject>();

  async putIfAbsent(object: ImmutableSnapshotObject): Promise<ImmutableSnapshotObject> {
    assertObject(object);
    const key = `${object.creatorId}\u0000${object.snapshotDigest}`;
    const existing = this.#objects.get(key);
    if (existing !== undefined) {
      if (!objectsEqual(existing, object)) fail('SNAPSHOT_IMMUTABLE_CONFLICT');
      return cloneObject(existing);
    }
    const stored = cloneObject(object);
    this.#objects.set(key, stored);
    return cloneObject(stored);
  }

  async get(
    creatorId: string,
    snapshotDigest: string,
  ): Promise<ImmutableSnapshotObject | undefined> {
    const stored = this.#objects.get(`${creatorId}\u0000${snapshotDigest}`);
    return stored === undefined ? undefined : cloneObject(stored);
  }
}
