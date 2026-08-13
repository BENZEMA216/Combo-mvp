import { createHash, timingSafeEqual } from 'node:crypto';
import {
  GetObjectCommand,
  PutObjectCommand,
  type GetObjectCommandOutput,
  type PutObjectCommandOutput,
} from '@aws-sdk/client-s3';
import {
  Sha256HexSchema,
  SnapshotArchiveEnvelopeSchema,
  UuidSchema,
  parseSnapshotArchiveCipherObject,
  snapshotArchiveObjectKey,
  type SnapshotArchiveEnvelope,
} from '@cb/creator-agent-protocol';

import { type SnapshotKeyEnvelopePort } from './encryption.js';
import { fail, isSnapshotError } from './errors.js';
import { decryptAndVerifySnapshot, type VerifiedSnapshotArchive } from './snapshot.js';

export const SNAPSHOT_OBJECT_STORAGE_PROTOCOL = 'combo.snapshot-object-storage/1' as const;
export const MAX_ENCRYPTED_SNAPSHOT_BYTES = 50 * 1024 * 1024 + 36;
const DATA_ENCRYPTION_KEY_BYTES = 32;
const CONTENT_TYPE = 'application/octet-stream';
const CACHE_CONTROL = 'no-store';

export interface SnapshotS3CommandClient {
  send(command: PutObjectCommand): Promise<PutObjectCommandOutput>;
  send(command: GetObjectCommand): Promise<GetObjectCommandOutput>;
}

type SnapshotCipherIdentity = Readonly<{
  creatorId: string;
  snapshotDigest: string;
  archiveDigest: string;
  cipherDigest: string;
  cipherBytes: number;
}>;

export type SnapshotUploadObject = Readonly<{
  uploadId: string;
  envelope: SnapshotArchiveEnvelope;
  encryptedObjectBytes: Uint8Array;
}>;

export type StoredSnapshotCipherObject = Readonly<{
  envelope: SnapshotArchiveEnvelope;
  objectKey: string;
  encryptedObjectBytes: Buffer;
}>;

export type FinalizeSnapshotUploadInput = Readonly<{
  uploadId: string;
  envelope: SnapshotArchiveEnvelope;
}>;

export type ReadAndVerifyStoredSnapshotInput = Readonly<{
  manifestBytes: Uint8Array;
  envelope: SnapshotArchiveEnvelope;
  keyEnvelope: SnapshotKeyEnvelopePort;
}>;

type ObjectState = 'upload' | 'immutable';
type SnapshotMetadata = Record<string, string>;

const REQUIRED_METADATA_KEYS = [
  'archive-digest',
  'cipher-bytes',
  'cipher-digest',
  'object-state',
  'protocol',
  'snapshot-digest',
] as const;

function normalizeIdentity(input: SnapshotCipherIdentity): SnapshotCipherIdentity {
  const parsedCreator = UuidSchema.safeParse(input.creatorId);
  const parsedSnapshot = Sha256HexSchema.safeParse(input.snapshotDigest);
  const parsedArchive = Sha256HexSchema.safeParse(input.archiveDigest);
  const parsedCipher = Sha256HexSchema.safeParse(input.cipherDigest);
  if (
    !parsedCreator.success ||
    !parsedSnapshot.success ||
    !parsedArchive.success ||
    !parsedCipher.success ||
    !Number.isSafeInteger(input.cipherBytes) ||
    input.cipherBytes < 37 ||
    input.cipherBytes > MAX_ENCRYPTED_SNAPSHOT_BYTES
  ) {
    fail('SNAPSHOT_OBJECT_INVALID');
  }
  return Object.freeze({
    creatorId: parsedCreator.data,
    snapshotDigest: parsedSnapshot.data,
    archiveDigest: parsedArchive.data,
    cipherDigest: parsedCipher.data,
    cipherBytes: input.cipherBytes,
  });
}

function parseEnvelope(input: SnapshotArchiveEnvelope): Readonly<{
  envelope: SnapshotArchiveEnvelope;
  identity: SnapshotCipherIdentity;
}> {
  const parsed = SnapshotArchiveEnvelopeSchema.safeParse(input);
  if (!parsed.success) fail('SNAPSHOT_OBJECT_INVALID');
  return Object.freeze({
    envelope: parsed.data,
    identity: normalizeIdentity({
      creatorId: parsed.data.aad.creatorId,
      snapshotDigest: parsed.data.aad.snapshotDigest,
      archiveDigest: parsed.data.aad.archiveDigest,
      cipherDigest: parsed.data.cipherDigest,
      cipherBytes: parsed.data.cipherBytes,
    }),
  });
}

function normalizeUploadId(uploadId: string): string {
  const parsed = UuidSchema.safeParse(uploadId);
  if (!parsed.success) fail('SNAPSHOT_OBJECT_INVALID');
  return parsed.data;
}

function assertBucket(bucket: string): void {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket) || bucket.includes('..')) {
    fail('SNAPSHOT_OBJECT_INVALID');
  }
}

export function snapshotUploadObjectKey(creatorId: string, uploadId: string): string {
  const creator = UuidSchema.safeParse(creatorId);
  const upload = UuidSchema.safeParse(uploadId);
  if (!creator.success || !upload.success) fail('SNAPSHOT_OBJECT_INVALID');
  return `uploads/${creator.data}/${upload.data}.part`;
}

export function immutableSnapshotObjectKey(creatorId: string, snapshotDigest: string): string {
  try {
    return snapshotArchiveObjectKey(creatorId, snapshotDigest);
  } catch {
    fail('SNAPSHOT_OBJECT_INVALID');
  }
}

function metadataFor(identity: SnapshotCipherIdentity, state: ObjectState): SnapshotMetadata {
  return {
    protocol: SNAPSHOT_OBJECT_STORAGE_PROTOCOL,
    'object-state': state,
    'snapshot-digest': identity.snapshotDigest,
    'archive-digest': identity.archiveDigest,
    'cipher-digest': identity.cipherDigest,
    'cipher-bytes': String(identity.cipherBytes),
  };
}

function sha256Base64(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('base64');
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function assertExactMetadata(
  actualInput: Record<string, string> | undefined,
  expected: SnapshotMetadata,
): void {
  const actual = actualInput ?? {};
  const actualKeys = Object.keys(actual).sort();
  if (
    actualKeys.length !== REQUIRED_METADATA_KEYS.length ||
    actualKeys.some((key, index) => key !== REQUIRED_METADATA_KEYS[index]) ||
    REQUIRED_METADATA_KEYS.some((key) => actual[key] !== expected[key])
  ) {
    fail('SNAPSHOT_OBJECT_INVALID');
  }
}

function httpStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const status = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode;
  return typeof status === 'number' ? status : undefined;
}

function errorNames(error: unknown): readonly string[] {
  if (error === null || typeof error !== 'object') return [];
  const candidate = error as { name?: unknown; Code?: unknown; code?: unknown };
  return [candidate.name, candidate.Code, candidate.code].filter(
    (value): value is string => typeof value === 'string',
  );
}

function isConditionalConflict(error: unknown): boolean {
  const names = errorNames(error);
  return (
    httpStatus(error) === 409 ||
    httpStatus(error) === 412 ||
    names.includes('PreconditionFailed') ||
    names.includes('ConditionalRequestConflict')
  );
}

function isMissingObject(error: unknown): boolean {
  const names = errorNames(error);
  return names.includes('NoSuchKey') || names.includes('NotFound');
}

async function readBoundedBody(
  body: GetObjectCommandOutput['Body'],
  maxBytes: number,
): Promise<Buffer> {
  if (body === undefined || body === null || !(Symbol.asyncIterator in Object(body))) {
    fail('SNAPSHOT_OBJECT_INVALID');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of body as AsyncIterable<unknown>) {
      if (!(chunk instanceof Uint8Array)) fail('SNAPSHOT_OBJECT_INVALID');
      if (chunk.byteLength > maxBytes - total) fail('SNAPSHOT_OBJECT_INVALID');
      const bytes = Buffer.from(chunk);
      total += bytes.byteLength;
      chunks.push(bytes);
    }
  } catch (error) {
    if (isSnapshotError(error)) throw error;
    fail('SNAPSHOT_STORAGE_UNAVAILABLE', error);
  }
  return Buffer.concat(chunks, total);
}

export class S3ImmutableSnapshotObjectStore {
  readonly #client: SnapshotS3CommandClient;
  readonly #bucket: string;
  readonly #creatorId: string;

  constructor(input: { client: SnapshotS3CommandClient; bucket: string; creatorId: string }) {
    assertBucket(input.bucket);
    const creator = UuidSchema.safeParse(input.creatorId);
    if (!creator.success) fail('SNAPSHOT_OBJECT_INVALID');
    this.#client = input.client;
    this.#bucket = input.bucket;
    this.#creatorId = creator.data;
  }

  async putUpload(input: SnapshotUploadObject): Promise<StoredSnapshotCipherObject> {
    const { envelope, identity } = parseEnvelope(input.envelope);
    if (identity.creatorId !== this.#creatorId) fail('SNAPSHOT_OBJECT_INVALID');
    const uploadId = normalizeUploadId(input.uploadId);
    try {
      parseSnapshotArchiveCipherObject(envelope, input.encryptedObjectBytes);
    } catch {
      fail('SNAPSHOT_OBJECT_INVALID');
    }
    const bytes = Buffer.from(input.encryptedObjectBytes);
    const key = snapshotUploadObjectKey(identity.creatorId, uploadId);
    const metadata = metadataFor(identity, 'upload');
    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Body: bytes,
          ContentLength: bytes.byteLength,
          ContentType: CONTENT_TYPE,
          CacheControl: CACHE_CONTROL,
          ChecksumSHA256: sha256Base64(bytes),
          IfNoneMatch: '*',
          Metadata: metadata,
        }),
      );
    } catch (error) {
      if (!isConditionalConflict(error)) fail('SNAPSHOT_STORAGE_UNAVAILABLE', error);
      const existing = await this.#readObject(key, envelope, 'upload').catch((readError) => {
        if (isSnapshotError(readError, 'SNAPSHOT_OBJECT_INVALID')) {
          fail('SNAPSHOT_IMMUTABLE_CONFLICT');
        }
        throw readError;
      });
      if (existing === undefined || !bytesEqual(existing.encryptedObjectBytes, bytes)) {
        fail('SNAPSHOT_IMMUTABLE_CONFLICT');
      }
      return existing;
    }
    return this.#requireExactObject(key, envelope, 'upload');
  }

  async finalizeUpload(input: FinalizeSnapshotUploadInput): Promise<StoredSnapshotCipherObject> {
    const { envelope, identity } = parseEnvelope(input.envelope);
    if (identity.creatorId !== this.#creatorId) fail('SNAPSHOT_OBJECT_INVALID');
    const uploadId = normalizeUploadId(input.uploadId);
    const finalKey = immutableSnapshotObjectKey(identity.creatorId, identity.snapshotDigest);

    const alreadyFinal = await this.#readObject(finalKey, envelope, 'immutable').catch((error) => {
      if (isSnapshotError(error, 'SNAPSHOT_OBJECT_INVALID')) {
        fail('SNAPSHOT_IMMUTABLE_CONFLICT');
      }
      throw error;
    });
    if (alreadyFinal !== undefined) return alreadyFinal;

    const uploadKey = snapshotUploadObjectKey(identity.creatorId, uploadId);
    const uploaded = await this.#readObject(uploadKey, envelope, 'upload').catch((error) => {
      if (isSnapshotError(error, 'SNAPSHOT_OBJECT_INVALID')) {
        fail('SNAPSHOT_IMMUTABLE_CONFLICT');
      }
      throw error;
    });
    if (uploaded === undefined) fail('SNAPSHOT_OBJECT_NOT_FOUND');

    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: finalKey,
          Body: uploaded.encryptedObjectBytes,
          ContentLength: identity.cipherBytes,
          ContentType: CONTENT_TYPE,
          CacheControl: CACHE_CONTROL,
          ChecksumSHA256: sha256Base64(uploaded.encryptedObjectBytes),
          IfNoneMatch: '*',
          Metadata: metadataFor(identity, 'immutable'),
        }),
      );
    } catch (error) {
      if (!isConditionalConflict(error)) fail('SNAPSHOT_STORAGE_UNAVAILABLE', error);
      const winner = await this.#readObject(finalKey, envelope, 'immutable').catch((readError) => {
        if (isSnapshotError(readError, 'SNAPSHOT_OBJECT_INVALID')) {
          fail('SNAPSHOT_IMMUTABLE_CONFLICT');
        }
        throw readError;
      });
      if (winner === undefined) fail('SNAPSHOT_STORAGE_UNAVAILABLE');
      return winner;
    }
    return this.#requireExactObject(finalKey, envelope, 'immutable');
  }

  async readFinal(input: SnapshotArchiveEnvelope): Promise<StoredSnapshotCipherObject | undefined> {
    const { envelope, identity } = parseEnvelope(input);
    if (identity.creatorId !== this.#creatorId) return undefined;
    return this.#readObject(
      immutableSnapshotObjectKey(identity.creatorId, identity.snapshotDigest),
      envelope,
      'immutable',
    );
  }

  async readAndVerify(
    input: ReadAndVerifyStoredSnapshotInput,
  ): Promise<Readonly<{ stored: StoredSnapshotCipherObject; verified: VerifiedSnapshotArchive }>> {
    const { envelope } = parseEnvelope(input.envelope);
    const stored = await this.readFinal(envelope);
    if (stored === undefined) fail('SNAPSHOT_OBJECT_NOT_FOUND');
    if (envelope.aad.objectKey !== stored.objectKey) fail('SNAPSHOT_OBJECT_INVALID');
    const wrappedDek = Buffer.from(envelope.wrappedDek, 'base64url');
    let unwrapped: Uint8Array | undefined;
    let dataKey: Buffer | undefined;
    try {
      try {
        unwrapped = await input.keyEnvelope.unwrapDataKey({
          context: envelope.aad,
          keyId: envelope.aad.keyId,
          wrappedDek,
        });
      } catch (error) {
        if (isSnapshotError(error)) throw error;
        fail('SNAPSHOT_ENCRYPTION_INVALID', error);
      }
      if (
        !(unwrapped instanceof Uint8Array) ||
        unwrapped.byteLength !== DATA_ENCRYPTION_KEY_BYTES
      ) {
        fail('SNAPSHOT_ENCRYPTION_INVALID');
      }
      dataKey = Buffer.from(unwrapped);
      const verified = decryptAndVerifySnapshot({
        manifestBytes: input.manifestBytes,
        encryptedObjectBytes: stored.encryptedObjectBytes,
        encryptionEnvelope: envelope,
        dataEncryptionKey: dataKey,
      });
      return Object.freeze({ stored, verified });
    } finally {
      dataKey?.fill(0);
      unwrapped?.fill(0);
      wrappedDek.fill(0);
    }
  }

  async #requireExactObject(
    key: string,
    envelope: SnapshotArchiveEnvelope,
    state: ObjectState,
  ): Promise<StoredSnapshotCipherObject> {
    const stored = await this.#readObject(key, envelope, state);
    if (stored === undefined) fail('SNAPSHOT_STORAGE_UNAVAILABLE');
    return stored;
  }

  async #readObject(
    key: string,
    envelope: SnapshotArchiveEnvelope,
    state: ObjectState,
  ): Promise<StoredSnapshotCipherObject | undefined> {
    const { identity } = parseEnvelope(envelope);
    let output: GetObjectCommandOutput;
    try {
      output = await this.#client.send(
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          ChecksumMode: 'ENABLED',
        }),
      );
    } catch (error) {
      if (isMissingObject(error)) return undefined;
      fail('SNAPSHOT_STORAGE_UNAVAILABLE', error);
    }

    if (
      output.ContentLength !== identity.cipherBytes ||
      output.ContentLength > MAX_ENCRYPTED_SNAPSHOT_BYTES ||
      output.ContentType !== CONTENT_TYPE ||
      output.CacheControl !== CACHE_CONTROL
    ) {
      fail('SNAPSHOT_OBJECT_INVALID');
    }
    assertExactMetadata(output.Metadata, metadataFor(identity, state));
    const bytes = await readBoundedBody(output.Body, identity.cipherBytes);
    try {
      parseSnapshotArchiveCipherObject(envelope, bytes);
    } catch {
      fail('SNAPSHOT_OBJECT_INVALID');
    }
    if (output.ChecksumSHA256 !== undefined && output.ChecksumSHA256 !== sha256Base64(bytes)) {
      fail('SNAPSHOT_OBJECT_INVALID');
    }
    return Object.freeze({
      envelope,
      objectKey: key,
      encryptedObjectBytes: bytes,
    });
  }
}
