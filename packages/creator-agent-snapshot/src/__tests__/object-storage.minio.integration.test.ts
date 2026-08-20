import { createHash, randomBytes } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommand,
  type GetObjectCommandOutput,
  type PutObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { type SnapshotUploadCreateRequest } from '@cb/creator-agent-protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sha256Hex } from '../digest.js';
import { type SnapshotDataKeyUnwrapperPort, type SnapshotKeyEnvelopePort } from '../encryption.js';
import { isSnapshotError } from '../errors.js';
import { createSnapshotManifest, snapshotManifestBytes } from '../manifest.js';
import {
  S3ImmutableSnapshotObjectStore,
  createSnapshotS3PutPresigner,
  immutableSnapshotManifestObjectKey,
  immutableSnapshotObjectKey,
  snapshotUploadObjectKey,
  type SnapshotEncryptedUploadBundle,
  type SnapshotS3CommandClient,
} from '../object-storage.js';
import { compressDeterministicTar, createDeterministicTar } from '../tar.js';
import { prepareEncryptedSnapshotUpload } from '../upload.js';

const _requiredEnvironment = [
  'COMBO_SNAPSHOT_MINIO_E2',
  'COMBO_SNAPSHOT_MINIO_ENDPOINT',
  'COMBO_SNAPSHOT_MINIO_ACCESS_KEY',
  'COMBO_SNAPSHOT_MINIO_SECRET_KEY',
  'COMBO_SNAPSHOT_MINIO_BUCKET',
] as const;

function environment(name: (typeof _requiredEnvironment)[number]): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`BLOCKED: missing ${name}`);
  return value;
}

function checksum(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('base64');
}

type EncryptedFixture = Readonly<{
  bundle: SnapshotEncryptedUploadBundle;
  request: SnapshotUploadCreateRequest;
  keyEnvelope: SnapshotKeyEnvelopePort;
  keyId: string;
  wrappedDek: Buffer;
  dataKey: Buffer;
}>;

async function encryptedFixture(input: {
  creatorId: string;
  uploadId: string;
  marker: string;
}): Promise<EncryptedFixture> {
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
  const unwrapKey = Buffer.from(dataKey);
  const snapshotDigest = sha256Hex(manifestBytes);
  const archiveDigest = sha256Hex(archiveBytes);
  const keyId = 'synthetic-minio-key:v1';
  const wrappedDek = randomBytes(40);
  const expectedWrappedDek = Buffer.from(wrappedDek);
  const prepared = await prepareEncryptedSnapshotUpload({
    creatorId: input.creatorId,
    snapshot: {
      manifest,
      manifestBytes,
      archiveBytes,
      snapshotDigest,
      archiveDigest,
      fileCount: manifest.totals.fileCount,
      expandedBytes: manifest.totals.expandedBytes,
      compressedBytes: archiveBytes.byteLength,
    },
    keyEnvelope: {
      async createDataKey(context) {
        expect(context).toEqual({ creatorId: input.creatorId, snapshotDigest, archiveDigest });
        return { keyId, plaintextKey: dataKey, wrappedDek };
      },
    },
  });
  const request: SnapshotUploadCreateRequest = prepared.request;
  expect(request.archive.checksumSha256).toBe(checksum(prepared.archiveObjectBytes));
  expect(request.manifest.checksumSha256).toBe(checksum(prepared.manifestObjectBytes));
  return {
    request,
    keyId,
    wrappedDek: expectedWrappedDek,
    dataKey: unwrapKey,
    bundle: {
      uploadId: input.uploadId,
      request,
      archiveObjectBytes: prepared.archiveObjectBytes,
      manifestObjectBytes: prepared.manifestObjectBytes,
    },
    keyEnvelope: {
      async createDataKey() {
        throw new Error('not used by verifier');
      },
      async unwrapDataKey(requestInput) {
        expect(requestInput.keyId).toBe(keyId);
        expect(requestInput.wrappedDek).toEqual(expectedWrappedDek);
        return Buffer.from(unwrapKey);
      },
    },
  };
}

function verifierKeyring(...fixtures: readonly EncryptedFixture[]): SnapshotDataKeyUnwrapperPort {
  return {
    async unwrapDataKey(input) {
      const fixture = fixtures.find(
        (candidate) =>
          candidate.keyId === input.keyId && candidate.wrappedDek.equals(input.wrappedDek),
      );
      if (fixture === undefined) throw new Error('unknown synthetic wrapped key');
      return Buffer.from(fixture.dataKey);
    },
  };
}

class FailOncePutClient implements SnapshotS3CommandClient {
  #failed = false;

  constructor(
    readonly delegate: S3Client,
    readonly key: string,
  ) {}

  async send(command: PutObjectCommand): Promise<PutObjectCommandOutput>;
  async send(command: GetObjectCommand): Promise<GetObjectCommandOutput>;
  async send(
    command: PutObjectCommand | GetObjectCommand,
  ): Promise<PutObjectCommandOutput | GetObjectCommandOutput> {
    if (command instanceof PutObjectCommand) {
      if (!this.#failed && command.input.Key === this.key) {
        this.#failed = true;
        throw Object.assign(new Error('synthetic manifest promotion outage'), {
          name: 'ServiceUnavailable',
          $metadata: { httpStatusCode: 503 },
        });
      }
      return this.delegate.send(command);
    }
    return this.delegate.send(command);
  }
}

async function signedPut(
  target: {
    putUrl: string;
    requiredHeaders: Record<string, string>;
  },
  bytes: Uint8Array,
  mutate?: (headers: Record<string, string>) => void,
): Promise<Response> {
  const headers = { ...target.requiredHeaders };
  mutate?.(headers);
  return fetch(target.putUrl, { method: 'PUT', headers, body: Buffer.from(bytes) });
}

describe('real disposable MinIO Snapshot signed upload + verify-before-promote E2', () => {
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
      maxAttempts: 3,
      credentials: {
        accessKeyId: environment('COMBO_SNAPSHOT_MINIO_ACCESS_KEY'),
        secretAccessKey: environment('COMBO_SNAPSHOT_MINIO_SECRET_KEY'),
      },
    });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    store = new S3ImmutableSnapshotObjectStore({
      client,
      presigner: createSnapshotS3PutPresigner(client),
      bucket,
      creatorId,
      allowInsecureLoopbackPresignedUrls: true,
    });
  }, 30_000);

  afterAll(() => client?.destroy());

  it('uses two real presigned PUTs, exact signed headers, full verification and 32-way finalize', async () => {
    const fixture = await encryptedFixture({
      creatorId,
      uploadId: '0198f00d-7000-7000-8000-000000000011',
      marker: 'REAL-MINIO-SIGNED-E2-A',
    });
    const session = await store.createUploadSession({
      uploadId: fixture.bundle.uploadId,
      request: fixture.request,
      expiresInSeconds: 900,
    });
    for (const target of Object.values(session.uploads)) {
      const signedHeaders = new Set(
        (new URL(target.putUrl).searchParams.get('X-Amz-SignedHeaders') ?? '').split(';'),
      );
      expect(Object.keys(target.requiredHeaders).every((header) => signedHeaders.has(header))).toBe(
        true,
      );
    }
    const [archiveResponse, manifestResponse] = await Promise.all([
      signedPut(session.uploads.archive, fixture.bundle.archiveObjectBytes),
      signedPut(session.uploads.manifest, fixture.bundle.manifestObjectBytes),
    ]);
    expect(archiveResponse.status).toBe(200);
    expect(manifestResponse.status).toBe(200);

    const finalized = await Promise.all(
      Array.from({ length: 32 }, () =>
        store.finalizeUpload({
          uploadId: fixture.bundle.uploadId,
          request: fixture.request,
          keyEnvelope: fixture.keyEnvelope,
        }),
      ),
    );
    expect(new Set(finalized.map((result) => result.verified.snapshotDigest))).toEqual(
      new Set([fixture.request.archive.envelope.aad.snapshotDigest]),
    );
    const read = await store.readAndVerify({
      request: fixture.request,
      keyEnvelope: fixture.keyEnvelope,
    });
    expect(read.verified).toMatchObject({ fileCount: 1, expandedBytes: expect.any(Number) });
  });

  it('the real signature rejects a missing bound header before object creation', async () => {
    const fixture = await encryptedFixture({
      creatorId,
      uploadId: '0198f00d-7000-7000-8000-000000000012',
      marker: 'REAL-MINIO-SIGNED-E2-HEADER',
    });
    const session = await store.createUploadSession({
      uploadId: fixture.bundle.uploadId,
      request: fixture.request,
    });
    const rejected = await signedPut(
      session.uploads.archive,
      fixture.bundle.archiveObjectBytes,
      (headers) => delete headers['x-amz-meta-cipher-digest'],
    );
    expect([400, 403]).toContain(rejected.status);
    const accepted = await signedPut(session.uploads.archive, fixture.bundle.archiveObjectBytes);
    const manifest = await signedPut(session.uploads.manifest, fixture.bundle.manifestObjectBytes);
    expect(accepted.status).toBe(200);
    expect(manifest.status).toBe(200);
    await expect(
      store.finalizeUpload({
        uploadId: fixture.bundle.uploadId,
        request: fixture.request,
        keyEnvelope: fixture.keyEnvelope,
      }),
    ).resolves.toMatchObject({ verified: { fileCount: 1 } });
  });

  it('a privileged corrupt temp never occupies final keys; a correct same-digest uploadId succeeds', async () => {
    const first = await encryptedFixture({
      creatorId,
      uploadId: '0198f00d-7000-7000-8000-000000000013',
      marker: 'REAL-MINIO-SIGNED-E2-RETRY',
    });
    const firstSession = await store.createUploadSession({
      uploadId: first.bundle.uploadId,
      request: first.request,
    });
    expect(
      (await signedPut(firstSession.uploads.archive, first.bundle.archiveObjectBytes)).status,
    ).toBe(200);
    expect(
      (await signedPut(firstSession.uploads.manifest, first.bundle.manifestObjectBytes)).status,
    ).toBe(200);
    const corruptManifest = Buffer.from(first.bundle.manifestObjectBytes);
    corruptManifest[20] = corruptManifest[20]! ^ 1;
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: snapshotUploadObjectKey(creatorId, first.bundle.uploadId, 'manifest'),
        Body: corruptManifest,
        ContentLength: corruptManifest.byteLength,
        ContentType: 'application/octet-stream',
        CacheControl: 'no-store',
        Metadata: {
          protocol: 'combo.snapshot-object-storage/1',
          'object-kind': 'manifest',
          'object-state': 'upload',
          'snapshot-digest': first.request.archive.envelope.aad.snapshotDigest,
          'archive-digest': first.request.archive.envelope.aad.archiveDigest,
          'cipher-digest': first.request.manifest.envelope.cipherDigest,
          'cipher-bytes': String(first.request.manifest.envelope.cipherBytes),
        },
      }),
    );
    await expect(
      store.finalizeUpload({
        uploadId: first.bundle.uploadId,
        request: first.request,
        keyEnvelope: first.keyEnvelope,
      }),
    ).rejects.toSatisfy((error: unknown) => isSnapshotError(error, 'SNAPSHOT_OBJECT_INVALID'));
    expect(await store.readFinalBundle(first.request)).toBeUndefined();

    const retry = await encryptedFixture({
      creatorId,
      uploadId: '0198f00d-7000-7000-8000-000000000014',
      marker: 'REAL-MINIO-SIGNED-E2-RETRY',
    });
    expect(retry.request.archive.envelope.aad.snapshotDigest).toBe(
      first.request.archive.envelope.aad.snapshotDigest,
    );
    const retrySession = await store.createUploadSession({
      uploadId: retry.bundle.uploadId,
      request: retry.request,
    });
    await signedPut(retrySession.uploads.archive, retry.bundle.archiveObjectBytes);
    await signedPut(retrySession.uploads.manifest, retry.bundle.manifestObjectBytes);
    await expect(
      store.finalizeUpload({
        uploadId: retry.bundle.uploadId,
        request: retry.request,
        keyEnvelope: retry.keyEnvelope,
      }),
    ).resolves.toMatchObject({ verified: { fileCount: 1 } });
  });

  it('keeps archive-only promotion invisible and replays the original prepared temp pair', async () => {
    const fixture = await encryptedFixture({
      creatorId,
      uploadId: '0198f00d-7000-7000-8000-000000000016',
      marker: 'REAL-MINIO-PUBLICATION-CRASH-REPLAY',
    });
    await store.putUpload(fixture.bundle);
    const digest = fixture.request.archive.envelope.aad.snapshotDigest;
    const failpointStore = new S3ImmutableSnapshotObjectStore({
      client: new FailOncePutClient(client, immutableSnapshotManifestObjectKey(creatorId, digest)),
      bucket,
      creatorId,
    });
    await expect(
      failpointStore.finalizeUpload({
        uploadId: fixture.bundle.uploadId,
        request: fixture.request,
        keyEnvelope: fixture.keyEnvelope,
      }),
    ).rejects.toSatisfy((error: unknown) => isSnapshotError(error, 'SNAPSHOT_STORAGE_UNAVAILABLE'));
    expect(await store.readFinalBundle(fixture.request)).toBeUndefined();
    await expect(
      store.finalizeUpload({
        uploadId: fixture.bundle.uploadId,
        request: fixture.request,
        keyEnvelope: fixture.keyEnvelope,
      }),
    ).resolves.toMatchObject({ verified: { snapshotDigest: digest } });
  });

  it('recovers a prepared pair after original temp loss from a fresh DEK and nonce upload', async () => {
    const prepared = await encryptedFixture({
      creatorId,
      uploadId: '0198f00d-7000-7000-8000-000000000017',
      marker: 'REAL-MINIO-PUBLICATION-LOST-TEMP',
    });
    await store.putUpload(prepared.bundle);
    const digest = prepared.request.archive.envelope.aad.snapshotDigest;
    const failpointStore = new S3ImmutableSnapshotObjectStore({
      client: new FailOncePutClient(client, immutableSnapshotManifestObjectKey(creatorId, digest)),
      bucket,
      creatorId,
    });
    await expect(
      failpointStore.finalizeUpload({
        uploadId: prepared.bundle.uploadId,
        request: prepared.request,
        keyEnvelope: prepared.keyEnvelope,
      }),
    ).rejects.toSatisfy((error: unknown) => isSnapshotError(error, 'SNAPSHOT_STORAGE_UNAVAILABLE'));
    expect(await store.readFinalBundle(prepared.request)).toBeUndefined();
    await Promise.all([
      client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: snapshotUploadObjectKey(creatorId, prepared.bundle.uploadId, 'archive'),
        }),
      ),
      client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: snapshotUploadObjectKey(creatorId, prepared.bundle.uploadId, 'manifest'),
        }),
      ),
    ]);

    const replacement = await encryptedFixture({
      creatorId,
      uploadId: '0198f00d-7000-7000-8000-000000000018',
      marker: 'REAL-MINIO-PUBLICATION-LOST-TEMP',
    });
    expect(replacement.request.archive.envelope.aad.snapshotDigest).toBe(digest);
    expect(replacement.request.archive.envelope.cipherDigest).not.toBe(
      prepared.request.archive.envelope.cipherDigest,
    );
    await store.putUpload(replacement.bundle);
    const finalized = await store.finalizeUpload({
      uploadId: replacement.bundle.uploadId,
      request: replacement.request,
      keyEnvelope: verifierKeyring(prepared, replacement),
    });
    expect(finalized.stored.archive.envelope.cipherDigest).toBe(
      prepared.request.archive.envelope.cipherDigest,
    );
    expect(finalized.stored.manifest.envelope.cipherDigest).toBe(
      prepared.request.manifest.envelope.cipherDigest,
    );
  });

  it('repairs a committed missing final after restore from a verified fresh upload', async () => {
    const prepared = await encryptedFixture({
      creatorId,
      uploadId: '0198f00d-7000-7000-8000-000000000021',
      marker: 'REAL-MINIO-COMMITTED-MISSING-FINAL',
    });
    await store.putUpload(prepared.bundle);
    await store.finalizeUpload({
      uploadId: prepared.bundle.uploadId,
      request: prepared.request,
      keyEnvelope: prepared.keyEnvelope,
    });
    const digest = prepared.request.archive.envelope.aad.snapshotDigest;
    await Promise.all([
      client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: immutableSnapshotManifestObjectKey(creatorId, digest),
        }),
      ),
      client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: snapshotUploadObjectKey(creatorId, prepared.bundle.uploadId, 'archive'),
        }),
      ),
      client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: snapshotUploadObjectKey(creatorId, prepared.bundle.uploadId, 'manifest'),
        }),
      ),
    ]);
    await expect(store.readFinalBundle(prepared.request)).rejects.toSatisfy((error: unknown) =>
      isSnapshotError(error, 'SNAPSHOT_IMMUTABLE_CONFLICT'),
    );

    const replacement = await encryptedFixture({
      creatorId,
      uploadId: '0198f00d-7000-7000-8000-000000000022',
      marker: 'REAL-MINIO-COMMITTED-MISSING-FINAL',
    });
    await store.putUpload(replacement.bundle);
    const repaired = await store.finalizeUpload({
      uploadId: replacement.bundle.uploadId,
      request: replacement.request,
      keyEnvelope: verifierKeyring(prepared, replacement),
    });
    expect(repaired.stored.manifest.envelope.cipherDigest).toBe(
      prepared.request.manifest.envelope.cipherDigest,
    );
    await expect(
      store.readAndVerify({
        request: replacement.request,
        keyEnvelope: verifierKeyring(prepared, replacement),
      }),
    ).resolves.toMatchObject({ verified: { snapshotDigest: digest } });
  });

  it('concurrent real MinIO finalize with fresh cipher generations converges on one marker', async () => {
    const first = await encryptedFixture({
      creatorId,
      uploadId: '0198f00d-7000-7000-8000-000000000019',
      marker: 'REAL-MINIO-PUBLICATION-CONCURRENT',
    });
    const second = await encryptedFixture({
      creatorId,
      uploadId: '0198f00d-7000-7000-8000-000000000020',
      marker: 'REAL-MINIO-PUBLICATION-CONCURRENT',
    });
    await Promise.all([store.putUpload(first.bundle), store.putUpload(second.bundle)]);
    const keyEnvelope = verifierKeyring(first, second);
    const finalized = await Promise.all([
      store.finalizeUpload({
        uploadId: first.bundle.uploadId,
        request: first.request,
        keyEnvelope,
      }),
      store.finalizeUpload({
        uploadId: second.bundle.uploadId,
        request: second.request,
        keyEnvelope,
      }),
    ]);
    expect(
      new Set(finalized.map((result) => result.stored.archive.envelope.cipherDigest)).size,
    ).toBe(1);
    expect(
      new Set(finalized.map((result) => result.stored.manifest.envelope.cipherDigest)).size,
    ).toBe(1);
  });

  it('detects privileged overwrite of either immutable object', async () => {
    const fixture = await encryptedFixture({
      creatorId,
      uploadId: '0198f00d-7000-7000-8000-000000000015',
      marker: 'REAL-MINIO-SIGNED-E2-TAMPER',
    });
    await store.putUpload(fixture.bundle);
    await store.finalizeUpload({
      uploadId: fixture.bundle.uploadId,
      request: fixture.request,
      keyEnvelope: fixture.keyEnvelope,
    });
    const mutated = Buffer.from(fixture.bundle.archiveObjectBytes);
    mutated[mutated.length - 1] = mutated[mutated.length - 1]! ^ 1;
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: immutableSnapshotObjectKey(
          creatorId,
          fixture.request.archive.envelope.aad.snapshotDigest,
        ),
        Body: mutated,
        ContentLength: mutated.byteLength,
        ContentType: 'application/octet-stream',
        CacheControl: 'no-store',
        Metadata: { deliberately: 'wrong' },
      }),
    );
    await expect(
      store.readAndVerify({ request: fixture.request, keyEnvelope: fixture.keyEnvelope }),
    ).rejects.toSatisfy((error: unknown) => isSnapshotError(error, 'SNAPSHOT_OBJECT_INVALID'));
    await expect(
      client.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: immutableSnapshotManifestObjectKey(
            creatorId,
            fixture.request.archive.envelope.aad.snapshotDigest,
          ),
        }),
      ),
    ).resolves.toBeDefined();
  });
});
