import { timingSafeEqual } from 'node:crypto';
import {
  SnapshotArchiveEnvelopeSchema,
  canonicalizeJson,
  parseSnapshotArchiveCipherObject,
  type SnapshotArchiveEnvelope,
} from '@cb/creator-agent-protocol';

import { parseSnapshotManifest, snapshotDigest } from './manifest.js';
import { equalHexDigest, sha256Hex } from './digest.js';
import { fail } from './errors.js';

/** 仅供领域单元测试使用；生产对象存储使用 S3ImmutableSnapshotObjectStore。 */
export type ImmutableSnapshotObject = Readonly<{
  envelope: SnapshotArchiveEnvelope;
  manifestBytes: Uint8Array;
  encryptedObjectBytes: Uint8Array;
}>;

export interface SnapshotObjectRepository {
  putIfAbsent(object: ImmutableSnapshotObject): Promise<ImmutableSnapshotObject>;
  get(creatorId: string, snapshotDigest: string): Promise<ImmutableSnapshotObject | undefined>;
}

function cloneObject(object: ImmutableSnapshotObject): ImmutableSnapshotObject {
  return Object.freeze({
    envelope: structuredClone(object.envelope),
    manifestBytes: Buffer.from(object.manifestBytes),
    encryptedObjectBytes: Buffer.from(object.encryptedObjectBytes),
  });
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function parseObject(object: ImmutableSnapshotObject): SnapshotArchiveEnvelope {
  try {
    const envelope = SnapshotArchiveEnvelopeSchema.parse(object.envelope);
    parseSnapshotArchiveCipherObject(envelope, object.encryptedObjectBytes);
    const manifest = parseSnapshotManifest(object.manifestBytes);
    if (
      !equalHexDigest(snapshotDigest(manifest), envelope.aad.snapshotDigest) ||
      !equalHexDigest(sha256Hex(object.manifestBytes), envelope.aad.snapshotDigest) ||
      !equalHexDigest(sha256Hex(object.encryptedObjectBytes), envelope.cipherDigest) ||
      object.encryptedObjectBytes.byteLength !== envelope.cipherBytes
    ) {
      fail('SNAPSHOT_DIGEST_MISMATCH');
    }
    return envelope;
  } catch {
    fail('SNAPSHOT_DIGEST_MISMATCH');
  }
}

function objectsEqual(left: ImmutableSnapshotObject, right: ImmutableSnapshotObject): boolean {
  return (
    canonicalizeJson(left.envelope) === canonicalizeJson(right.envelope) &&
    bytesEqual(left.manifestBytes, right.manifestBytes) &&
    bytesEqual(left.encryptedObjectBytes, right.encryptedObjectBytes)
  );
}

export class InMemoryImmutableSnapshotRepository implements SnapshotObjectRepository {
  readonly #objects = new Map<string, ImmutableSnapshotObject>();

  async putIfAbsent(object: ImmutableSnapshotObject): Promise<ImmutableSnapshotObject> {
    const envelope = parseObject(object);
    const key = `${envelope.aad.creatorId}\u0000${envelope.aad.snapshotDigest}`;
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
