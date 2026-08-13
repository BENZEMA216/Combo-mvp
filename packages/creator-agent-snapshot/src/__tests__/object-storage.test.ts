import { Readable } from 'node:stream';
import {
  GetObjectCommand,
  PutObjectCommand,
  type GetObjectCommandOutput,
  type PutObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../digest.js';
import { encryptSnapshotArchive, type SnapshotKeyEnvelopePort } from '../encryption.js';
import { isSnapshotError } from '../errors.js';
import { createSnapshotManifest, snapshotManifestBytes } from '../manifest.js';
import {
  S3ImmutableSnapshotObjectStore,
  immutableSnapshotObjectKey,
  snapshotUploadObjectKey,
  type SnapshotCipherIdentity,
  type SnapshotS3CommandClient,
  type SnapshotUploadObject,
} from '../object-storage.js';
import { compressDeterministicTar, createDeterministicTar } from '../tar.js';

type FakeObject = {
  body: Buffer;
  bodyChunks?: unknown[];
  contentLength: number;
  contentType: string | undefined;
  cacheControl: string | undefined;
  checksumSha256: string | undefined;
  metadata: Record<string, string>;
};

function s3Error(name: string, status: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

class FakeSnapshotS3Client implements SnapshotS3CommandClient {
  readonly objects = new Map<string, FakeObject>();
  readonly commands: (PutObjectCommand | GetObjectCommand)[] = [];
  getFailure: unknown;

  async send(command: PutObjectCommand): Promise<PutObjectCommandOutput>;
  async send(command: GetObjectCommand): Promise<GetObjectCommandOutput>;
  async send(
    command: PutObjectCommand | GetObjectCommand,
  ): Promise<PutObjectCommandOutput | GetObjectCommandOutput> {
    this.commands.push(command);
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key;
      if (key === undefined || command.input.Bucket === undefined)
        throw new TypeError('missing key');
      if (command.input.IfNoneMatch !== '*') throw new TypeError('missing conditional put');
      if (this.objects.has(key)) throw s3Error('PreconditionFailed', 412);
      if (!Buffer.isBuffer(command.input.Body)) throw new TypeError('fake expects Buffer body');
      this.objects.set(key, {
        body: Buffer.from(command.input.Body),
        contentLength: command.input.ContentLength ?? -1,
        contentType: command.input.ContentType,
        cacheControl: command.input.CacheControl,
        checksumSha256: command.input.ChecksumSHA256,
        metadata: { ...(command.input.Metadata ?? {}) },
      });
      return { ETag: '"synthetic-etag"', $metadata: { httpStatusCode: 200 } };
    }

    if (this.getFailure !== undefined) throw this.getFailure;
    const key = command.input.Key;
    if (key === undefined || command.input.Bucket === undefined) throw new TypeError('missing key');
    const object = this.objects.get(key);
    if (object === undefined) throw s3Error('NoSuchKey', 404);
    return {
      Body: Readable.from(
        object.bodyChunks ?? [Buffer.from(object.body)],
      ) as GetObjectCommandOutput['Body'],
      ContentLength: object.contentLength,
      ContentType: object.contentType,
      CacheControl: object.cacheControl,
      ChecksumSHA256: object.checksumSha256,
      Metadata: { ...object.metadata },
      $metadata: { httpStatusCode: 200 },
    };
  }

  mutate(key: string, mutate: (object: FakeObject) => void): void {
    const object = this.objects.get(key);
    if (object === undefined) throw new Error('missing fake object');
    mutate(object);
  }
}

const CREATOR_A = '0198f00d-6000-7000-8000-000000000001';
const CREATOR_B = '0198f00d-6000-7000-8000-000000000002';
const UPLOAD_A = '0198f00d-6000-7000-8000-000000000011';
const UPLOAD_B = '0198f00d-6000-7000-8000-000000000012';
const KEY_REFERENCE = 'test-key:v1';
const WRAPPED_DATA_KEY = Buffer.alloc(40, 9);

function tenantStore(
  client: FakeSnapshotS3Client,
  creatorId = CREATOR_A,
): S3ImmutableSnapshotObjectStore {
  return new S3ImmutableSnapshotObjectStore({
    client,
    bucket: 'combo-agent-versions-test',
    creatorId,
  });
}

function uploadFixture(overrides: Partial<SnapshotUploadObject> = {}): SnapshotUploadObject {
  const encryptedObjectBytes = Buffer.from(
    overrides.encryptedObjectBytes ?? Buffer.concat([Buffer.from('CSNPENC1'), Buffer.alloc(29, 7)]),
  );
  return {
    creatorId: CREATOR_A,
    uploadId: UPLOAD_A,
    snapshotDigest: sha256Hex(Buffer.from('snapshot-manifest')),
    archiveDigest: sha256Hex(Buffer.from('archive')),
    cipherDigest: sha256Hex(encryptedObjectBytes),
    cipherBytes: encryptedObjectBytes.byteLength,
    encryptedObjectBytes,
    ...overrides,
  };
}

function identity(upload: SnapshotUploadObject): SnapshotCipherIdentity {
  return {
    creatorId: upload.creatorId,
    snapshotDigest: upload.snapshotDigest,
    archiveDigest: upload.archiveDigest,
    cipherDigest: upload.cipherDigest,
    cipherBytes: upload.cipherBytes,
  };
}

describe('S3 immutable Snapshot object storage', () => {
  it('uses derived tenant keys, exact private metadata and conditional idempotent writes', async () => {
    const client = new FakeSnapshotS3Client();
    const store = tenantStore(client);
    const upload = uploadFixture();

    const firstUpload = await store.putUpload(upload);
    const replayedUpload = await store.putUpload(upload);
    expect(replayedUpload.encryptedObjectBytes).toEqual(firstUpload.encryptedObjectBytes);

    const final = await store.finalizeUpload({ ...identity(upload), uploadId: upload.uploadId });
    const replayedFinal = await store.finalizeUpload({
      ...identity(upload),
      uploadId: upload.uploadId,
    });
    expect(replayedFinal).toEqual(final);
    expect(final.objectKey).toBe(
      immutableSnapshotObjectKey(upload.creatorId, upload.snapshotDigest),
    );

    const putCommands = client.commands.filter(
      (command): command is PutObjectCommand => command instanceof PutObjectCommand,
    );
    expect(putCommands).toHaveLength(3);
    for (const command of putCommands) {
      expect(command.input).toMatchObject({
        Bucket: 'combo-agent-versions-test',
        IfNoneMatch: '*',
        ContentType: 'application/octet-stream',
        CacheControl: 'no-store',
      });
      expect('ACL' in command.input).toBe(false);
      expect(command.input.Metadata).not.toHaveProperty('creator-id');
      expect(command.input.Metadata).not.toHaveProperty('key-reference');
      expect(command.input.Metadata).not.toHaveProperty('wrapped-data-key');
      expect(Object.keys(command.input.Metadata ?? {}).sort()).toEqual([
        'archive-digest',
        'cipher-bytes',
        'cipher-digest',
        'object-state',
        'protocol',
        'snapshot-digest',
      ]);
    }
  });

  it('allows one winner under 100 concurrent identical finalize replays', async () => {
    const client = new FakeSnapshotS3Client();
    const store = tenantStore(client);
    const upload = uploadFixture();
    await store.putUpload(upload);

    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        store.finalizeUpload({ ...identity(upload), uploadId: upload.uploadId }),
      ),
    );
    expect(new Set(results.map((result) => result.cipherDigest))).toEqual(
      new Set([upload.cipherDigest]),
    );
    expect(
      [...client.objects.keys()].filter((key) => key.startsWith(`creators/${CREATOR_A}/`)),
    ).toHaveLength(1);
  });

  it('rejects upload replay conflicts and competing content for one final key', async () => {
    const client = new FakeSnapshotS3Client();
    const store = tenantStore(client);
    const first = uploadFixture();
    await store.putUpload(first);

    const changedBytes = Buffer.concat([Buffer.from('CSNPENC1'), Buffer.alloc(29, 8)]);
    const conflictingUpload = uploadFixture({
      encryptedObjectBytes: changedBytes,
      cipherDigest: sha256Hex(changedBytes),
    });
    await expect(store.putUpload(conflictingUpload)).rejects.toSatisfy((error: unknown) =>
      isSnapshotError(error, 'SNAPSHOT_IMMUTABLE_CONFLICT'),
    );

    const competitor = uploadFixture({
      uploadId: UPLOAD_B,
      encryptedObjectBytes: changedBytes,
      cipherDigest: sha256Hex(changedBytes),
      archiveDigest: sha256Hex(Buffer.from('different-archive')),
    });
    await store.putUpload(competitor);
    await store.finalizeUpload({ ...identity(first), uploadId: first.uploadId });
    await expect(
      store.finalizeUpload({ ...identity(competitor), uploadId: competitor.uploadId }),
    ).rejects.toSatisfy((error: unknown) => isSnapshotError(error, 'SNAPSHOT_IMMUTABLE_CONFLICT'));
  });

  it('fails closed for body, checksum, size or metadata mutation', async () => {
    const mutationCases: ((object: FakeObject) => void)[] = [
      (object) => {
        const index = object.body.length - 1;
        object.body[index] = object.body[index]! ^ 1;
      },
      (object) => {
        object.checksumSha256 = Buffer.alloc(32, 1).toString('base64');
      },
      (object) => {
        object.contentLength += 1;
      },
      (object) => {
        object.metadata['unexpected-private-detail'] = 'must-fail';
      },
      (object) => {
        object.metadata['cipher-digest'] = '0'.repeat(64);
      },
      (object) => {
        object.bodyChunks = [object.body.toString('base64')];
      },
    ];

    for (const mutate of mutationCases) {
      const client = new FakeSnapshotS3Client();
      const store = tenantStore(client);
      const upload = uploadFixture();
      await store.putUpload(upload);
      await store.finalizeUpload({ ...identity(upload), uploadId: upload.uploadId });
      client.mutate(immutableSnapshotObjectKey(upload.creatorId, upload.snapshotDigest), mutate);
      await expect(store.readFinal(identity(upload))).rejects.toSatisfy((error: unknown) =>
        isSnapshotError(error, 'SNAPSHOT_OBJECT_INVALID'),
      );
    }
  });

  it('derives tenant scope and exposes no caller-selected key, list or delete operation', async () => {
    const client = new FakeSnapshotS3Client();
    const store = tenantStore(client);
    const upload = uploadFixture();
    await store.putUpload(upload);
    await store.finalizeUpload({ ...identity(upload), uploadId: upload.uploadId });

    expect(await store.readFinal({ ...identity(upload), creatorId: CREATOR_B })).toBeUndefined();
    await expect(store.putUpload({ ...upload, creatorId: CREATOR_B })).rejects.toSatisfy(
      (error: unknown) => isSnapshotError(error, 'SNAPSHOT_OBJECT_INVALID'),
    );
    expect(
      client.commands.every(
        (command) => command instanceof PutObjectCommand || command instanceof GetObjectCommand,
      ),
    ).toBe(true);
    expect(() => snapshotUploadObjectKey('../creator-a', UPLOAD_A)).toThrowError();
    expect(() => immutableSnapshotObjectKey(CREATOR_A, '../digest')).toThrowError();
  });

  it('does not treat a missing bucket as a missing tenant object', async () => {
    const client = new FakeSnapshotS3Client();
    client.getFailure = s3Error('NoSuchBucket', 404);
    const store = tenantStore(client);
    await expect(store.readFinal(identity(uploadFixture()))).rejects.toSatisfy((error: unknown) =>
      isSnapshotError(error, 'SNAPSHOT_STORAGE_UNAVAILABLE'),
    );
  });

  it('enforces the frozen wrapped-DEK size and sanitizes envelope-provider failures', async () => {
    const client = new FakeSnapshotS3Client();
    const store = tenantStore(client);
    const upload = uploadFixture();
    await store.putUpload(upload);
    await store.finalizeUpload({ ...identity(upload), uploadId: upload.uploadId });
    let unwrapCalls = 0;
    const keyEnvelope: SnapshotKeyEnvelopePort = {
      async createDataKey() {
        throw new Error('not used');
      },
      async unwrapDataKey() {
        unwrapCalls += 1;
        throw Object.assign(new Error('secret provider detail'), {
          name: 'SyntheticKmsError',
          code: 'SYNTHETIC_KMS_FAILURE',
        });
      },
    };

    await expect(
      store.readAndVerify({
        ...identity(upload),
        manifestBytes: Buffer.from('{}'),
        keyReference: KEY_REFERENCE,
        wrappedDataKey: Buffer.alloc(39),
        keyEnvelope,
      }),
    ).rejects.toSatisfy((error: unknown) => isSnapshotError(error, 'SNAPSHOT_OBJECT_INVALID'));
    expect(unwrapCalls).toBe(0);

    let caught: unknown;
    try {
      await store.readAndVerify({
        ...identity(upload),
        manifestBytes: Buffer.from('{}'),
        keyReference: KEY_REFERENCE,
        wrappedDataKey: WRAPPED_DATA_KEY,
        keyEnvelope,
      });
    } catch (error) {
      caught = error;
    }
    expect(isSnapshotError(caught, 'SNAPSHOT_ENCRYPTION_INVALID')).toBe(true);
    expect(JSON.stringify(caught)).not.toContain('secret provider detail');
    expect(unwrapCalls).toBe(1);
  });

  it('reads real encrypted bytes and delegates key unwrap plus full manifest/archive verification', async () => {
    const client = new FakeSnapshotS3Client();
    const store = tenantStore(client);
    const fileBytes = Buffer.from('# Synthetic facts\nmarker=STORAGE-E2-ONLY\n');
    const manifest = createSnapshotManifest([
      {
        path: 'FACTS.md',
        size: fileBytes.byteLength,
        mediaType: 'text/markdown; charset=utf-8',
        sha256: sha256Hex(fileBytes),
      },
    ]);
    const manifestBytes = snapshotManifestBytes(manifest);
    const archiveBytes = compressDeterministicTar(
      createDeterministicTar([{ path: 'FACTS.md', bytes: fileBytes }]),
    );
    const dataKey = Buffer.alloc(32, 3);
    const context = {
      schemaVersion: 1 as const,
      creatorId: CREATOR_A,
      snapshotDigest: sha256Hex(manifestBytes),
      archiveDigest: sha256Hex(archiveBytes),
    };
    const encrypted = encryptSnapshotArchive(archiveBytes, context, dataKey, Buffer.alloc(12, 4));
    const upload = uploadFixture({
      snapshotDigest: context.snapshotDigest,
      archiveDigest: context.archiveDigest,
      cipherDigest: encrypted.cipherDigest,
      cipherBytes: encrypted.objectBytes.byteLength,
      encryptedObjectBytes: encrypted.objectBytes,
    });
    let returnedPlaintextKey: Buffer | undefined;
    const keyEnvelope: SnapshotKeyEnvelopePort = {
      async createDataKey() {
        throw new Error('not used by read verifier');
      },
      async unwrapDataKey(input) {
        expect(input.keyReference).toBe(KEY_REFERENCE);
        expect(input.wrappedKey).toEqual(WRAPPED_DATA_KEY);
        returnedPlaintextKey = Buffer.from(dataKey);
        return returnedPlaintextKey;
      },
    };

    await store.putUpload(upload);
    await store.finalizeUpload({ ...identity(upload), uploadId: upload.uploadId });
    const result = await store.readAndVerify({
      ...identity(upload),
      manifestBytes,
      keyReference: KEY_REFERENCE,
      wrappedDataKey: WRAPPED_DATA_KEY,
      keyEnvelope,
    });
    expect(result.verified).toMatchObject({
      snapshotDigest: context.snapshotDigest,
      archiveDigest: context.archiveDigest,
      fileCount: 1,
      expandedBytes: fileBytes.byteLength,
    });
    expect(returnedPlaintextKey).toEqual(Buffer.alloc(32));
  });
});
