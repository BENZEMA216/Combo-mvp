import { randomBytes } from 'node:crypto';
import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sha256Hex } from '../digest.js';
import { encryptSnapshotArchive, type SnapshotKeyEnvelopePort } from '../encryption.js';
import { isSnapshotError } from '../errors.js';
import { createSnapshotManifest, snapshotManifestBytes } from '../manifest.js';
import {
  S3ImmutableSnapshotObjectStore,
  immutableSnapshotObjectKey,
  type SnapshotCipherIdentity,
  type SnapshotUploadObject,
} from '../object-storage.js';
import { compressDeterministicTar, createDeterministicTar } from '../tar.js';

const requiredEnvironment = [
  'COMBO_SNAPSHOT_MINIO_E2',
  'COMBO_SNAPSHOT_MINIO_ENDPOINT',
  'COMBO_SNAPSHOT_MINIO_ACCESS_KEY',
  'COMBO_SNAPSHOT_MINIO_SECRET_KEY',
  'COMBO_SNAPSHOT_MINIO_BUCKET',
] as const;

function environment(name: (typeof requiredEnvironment)[number]): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`BLOCKED: missing ${name}`);
  }
  return value;
}

type EncryptedFixture = {
  upload: SnapshotUploadObject;
  manifestBytes: Buffer;
  keyReference: string;
  wrappedDataKey: Buffer;
  keyEnvelope: SnapshotKeyEnvelopePort;
};

function identity(upload: SnapshotUploadObject): SnapshotCipherIdentity {
  return {
    creatorId: upload.creatorId,
    snapshotDigest: upload.snapshotDigest,
    archiveDigest: upload.archiveDigest,
    cipherDigest: upload.cipherDigest,
    cipherBytes: upload.cipherBytes,
  };
}

function encryptedFixture(input: {
  creatorId: string;
  uploadId: string;
  marker: string;
}): EncryptedFixture {
  const fileBytes = Buffer.from(`# Synthetic MinIO fixture\nmarker=${input.marker}\n`);
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
  const dataKey = randomBytes(32);
  const context = {
    schemaVersion: 1 as const,
    creatorId: input.creatorId,
    snapshotDigest: sha256Hex(manifestBytes),
    archiveDigest: sha256Hex(archiveBytes),
  };
  const encrypted = encryptSnapshotArchive(archiveBytes, context, dataKey);
  const wrappedDataKey = randomBytes(40);
  const keyReference = 'synthetic-minio-key:v1';
  return {
    upload: {
      creatorId: input.creatorId,
      uploadId: input.uploadId,
      snapshotDigest: context.snapshotDigest,
      archiveDigest: context.archiveDigest,
      cipherDigest: encrypted.cipherDigest,
      cipherBytes: encrypted.objectBytes.byteLength,
      encryptedObjectBytes: encrypted.objectBytes,
    },
    manifestBytes,
    keyReference,
    wrappedDataKey,
    keyEnvelope: {
      async createDataKey() {
        throw new Error('not used by read verifier');
      },
      async unwrapDataKey(request) {
        expect(request.keyReference).toBe(keyReference);
        expect(request.wrappedKey).toEqual(wrappedDataKey);
        return Buffer.from(dataKey);
      },
    },
  };
}

describe('real disposable MinIO Snapshot object storage E2', () => {
  const creatorId = '0198f00d-7000-7000-8000-000000000001';
  let client: S3Client;
  let store: S3ImmutableSnapshotObjectStore;
  let bucket: string;

  beforeAll(async () => {
    expect(environment('COMBO_SNAPSHOT_MINIO_E2')).toBe('1');
    bucket = environment('COMBO_SNAPSHOT_MINIO_BUCKET');
    client = new S3Client({
      endpoint: environment('COMBO_SNAPSHOT_MINIO_ENDPOINT'),
      region: 'us-east-1',
      forcePathStyle: true,
      // MinIO may close the request body connection after a failed If-None-Match
      // precondition. The AWS SDK default retry budget transparently replaces that
      // stale keep-alive socket for the following idempotent GET verification.
      maxAttempts: 3,
      credentials: {
        accessKeyId: environment('COMBO_SNAPSHOT_MINIO_ACCESS_KEY'),
        secretAccessKey: environment('COMBO_SNAPSHOT_MINIO_SECRET_KEY'),
      },
    });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    store = new S3ImmutableSnapshotObjectStore({ client, bucket, creatorId });
  }, 30_000);

  afterAll(() => client?.destroy());

  it('conditionally uploads, finalizes concurrently, rereads and verifies real encrypted bytes', async () => {
    const fixture = encryptedFixture({
      creatorId,
      uploadId: '0198f00d-7000-7000-8000-000000000011',
      marker: 'REAL-MINIO-E2-A',
    });
    await store.putUpload(fixture.upload);
    await store.putUpload(fixture.upload);
    const finalized = await Promise.all(
      Array.from({ length: 32 }, () =>
        store.finalizeUpload({
          ...identity(fixture.upload),
          uploadId: fixture.upload.uploadId,
        }),
      ),
    );
    expect(new Set(finalized.map((object) => object.objectKey)).size).toBe(1);

    const read = await store.readAndVerify({
      ...identity(fixture.upload),
      manifestBytes: fixture.manifestBytes,
      keyReference: fixture.keyReference,
      wrappedDataKey: fixture.wrappedDataKey,
      keyEnvelope: fixture.keyEnvelope,
    });
    expect(read.verified).toMatchObject({
      snapshotDigest: fixture.upload.snapshotDigest,
      archiveDigest: fixture.upload.archiveDigest,
      fileCount: 1,
    });
  });

  it('keeps identical digests tenant-scoped and rejects conflicting upload replay', async () => {
    const fixture = encryptedFixture({
      creatorId: '0198f00d-7000-7000-8000-000000000002',
      uploadId: '0198f00d-7000-7000-8000-000000000012',
      marker: 'REAL-MINIO-E2-B',
    });
    const tenantBStore = new S3ImmutableSnapshotObjectStore({
      client,
      bucket,
      creatorId: fixture.upload.creatorId,
    });
    await tenantBStore.putUpload(fixture.upload);
    await tenantBStore.finalizeUpload({
      ...identity(fixture.upload),
      uploadId: fixture.upload.uploadId,
    });

    expect(
      await tenantBStore.readFinal({
        ...identity(fixture.upload),
        creatorId: '0198f00d-7000-7000-8000-000000000003',
      }),
    ).toBeUndefined();

    const conflictingBytes = Buffer.from(fixture.upload.encryptedObjectBytes);
    const conflictingIndex = conflictingBytes.length - 1;
    conflictingBytes[conflictingIndex] = conflictingBytes[conflictingIndex]! ^ 1;
    await expect(
      tenantBStore.putUpload({
        ...fixture.upload,
        encryptedObjectBytes: conflictingBytes,
        cipherDigest: sha256Hex(conflictingBytes),
      }),
    ).rejects.toSatisfy((error: unknown) => isSnapshotError(error, 'SNAPSHOT_IMMUTABLE_CONFLICT'));
  });

  it('detects a privileged out-of-band body or metadata overwrite on read', async () => {
    const fixture = encryptedFixture({
      creatorId: '0198f00d-7000-7000-8000-000000000004',
      uploadId: '0198f00d-7000-7000-8000-000000000014',
      marker: 'REAL-MINIO-E2-TAMPER',
    });
    const tamperTenantStore = new S3ImmutableSnapshotObjectStore({
      client,
      bucket,
      creatorId: fixture.upload.creatorId,
    });
    await tamperTenantStore.putUpload(fixture.upload);
    await tamperTenantStore.finalizeUpload({
      ...identity(fixture.upload),
      uploadId: fixture.upload.uploadId,
    });

    const mutated = Buffer.from(fixture.upload.encryptedObjectBytes);
    const mutatedIndex = mutated.length - 1;
    mutated[mutatedIndex] = mutated[mutatedIndex]! ^ 1;
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: immutableSnapshotObjectKey(fixture.upload.creatorId, fixture.upload.snapshotDigest),
        Body: mutated,
        ContentLength: mutated.byteLength,
        ContentType: 'application/octet-stream',
        CacheControl: 'no-store',
        Metadata: { deliberately: 'wrong' },
      }),
    );
    await expect(tamperTenantStore.readFinal(identity(fixture.upload))).rejects.toSatisfy(
      (error: unknown) => isSnapshotError(error, 'SNAPSHOT_OBJECT_INVALID'),
    );
  });
});
