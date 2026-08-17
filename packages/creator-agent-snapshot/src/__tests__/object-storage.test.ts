import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import {
  PutObjectCommand,
  type GetObjectCommand,
  type GetObjectCommandOutput,
  type PutObjectCommandOutput,
} from '@aws-sdk/client-s3';
import {
  SNAPSHOT_ARCHIVE_OBJECT_FORMAT,
  SNAPSHOT_ENVELOPE_PROTOCOL,
  SNAPSHOT_MANIFEST_ENVELOPE_PROTOCOL,
  SNAPSHOT_MANIFEST_OBJECT_FORMAT,
  SnapshotCompressionRatioBoundaryCorpusSchema,
  SnapshotUploadCreateResponseSchema,
  snapshotArchiveObjectKey,
  snapshotManifestObjectKey,
  type SnapshotUploadCreateRequest,
} from '@cb/creator-agent-protocol';
import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../digest.js';
import {
  encryptSnapshotArchiveTestOnly,
  encryptSnapshotManifestTestOnly,
  type SnapshotDataKeyUnwrapperPort,
  type SnapshotKeyEnvelopePort,
} from '../encryption.js';
import { isSnapshotError } from '../errors.js';
import { createSnapshotManifest, snapshotManifestBytes } from '../manifest.js';
import {
  S3ImmutableSnapshotObjectStore,
  immutableSnapshotManifestObjectKey,
  immutableSnapshotObjectKey,
  snapshotPublicationCommitKey,
  snapshotPublicationPreparationKey,
  snapshotUploadObjectKey,
  type SnapshotEncryptedUploadBundle,
  type SnapshotS3CommandClient,
  type SnapshotS3PutPresigner,
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
  readonly putFailures = new Map<string, unknown[]>();
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
      const failures = this.putFailures.get(key);
      if (failures !== undefined && failures.length > 0) {
        const failure = failures.shift();
        if (failures.length === 0) this.putFailures.delete(key);
        throw failure;
      }
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

  failNextPut(key: string, error: unknown): void {
    const failures = this.putFailures.get(key) ?? [];
    failures.push(error);
    this.putFailures.set(key, failures);
  }
}

class FakePresigner implements SnapshotS3PutPresigner {
  readonly calls: Array<{
    command: PutObjectCommand;
    requiredHeaders: Readonly<Record<string, string>>;
    expiresInSeconds: number;
    signingDate: Date;
  }> = [];

  async presignPut(input: {
    command: PutObjectCommand;
    requiredHeaders: Readonly<Record<string, string>>;
    expiresInSeconds: number;
    signingDate: Date;
  }): Promise<string> {
    this.calls.push(input);
    return `https://uploads.example.invalid/${input.command.input.Key}?X-Amz-SignedHeaders=${encodeURIComponent(
      Object.keys(input.requiredHeaders).sort().join(';'),
    )}`;
  }
}

class InsecurePresigner implements SnapshotS3PutPresigner {
  constructor(readonly origin: string) {}

  async presignPut(input: {
    command: PutObjectCommand;
    requiredHeaders: Readonly<Record<string, string>>;
    expiresInSeconds: number;
    signingDate: Date;
  }): Promise<string> {
    return `${this.origin}/${input.command.input.Key}`;
  }
}

const CREATOR_A = '0198f00d-6000-7000-8000-000000000001';
const CREATOR_B = '0198f00d-6000-7000-8000-000000000002';
const UPLOAD_A = '0198f00d-6000-7000-8000-000000000011';
const UPLOAD_B = '0198f00d-6000-7000-8000-000000000012';
const KEY_ID = 'test-key:v1';
const WRAPPED_DEK = Buffer.alloc(40, 9);
const DATA_KEY = Buffer.alloc(32, 7);
const compressionRatioCorpusUrl = new URL(
  '../../../creator-agent-protocol/fixtures/snapshot-compression-ratio-boundaries.v1.json',
  import.meta.url,
);

function checksum(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('base64');
}

type UploadFixture = Readonly<{
  bundle: SnapshotEncryptedUploadBundle;
  request: SnapshotUploadCreateRequest;
  keyEnvelope: SnapshotKeyEnvelopePort;
  dataKeyResult: { value?: Buffer };
  keyId: string;
  wrappedDek: Buffer;
  dataKey: Buffer;
}>;

function uploadFixture(
  options: Partial<{
    creatorId: string;
    uploadId: string;
    marker: string;
    archiveNonceByte: number;
    manifestNonceByte: number;
    keyId: string;
    wrappedDek: Buffer;
    dataKey: Buffer;
    filePath: string;
    fileBytes: Buffer;
    mediaType: string;
  }> = {},
): UploadFixture {
  const creatorId = options.creatorId ?? CREATOR_A;
  const uploadId = options.uploadId ?? UPLOAD_A;
  const marker = options.marker ?? 'SNAPSHOT-SIGNED-PUT-A';
  const keyId = options.keyId ?? KEY_ID;
  const wrappedDek = Buffer.from(options.wrappedDek ?? WRAPPED_DEK);
  const dataKey = Buffer.from(options.dataKey ?? DATA_KEY);
  const filePath = options.filePath ?? 'FACTS.md';
  const fileBytes = options.fileBytes ?? Buffer.from(`# Synthetic facts\nmarker=${marker}\n`);
  const mediaType = options.mediaType ?? 'text/markdown; charset=utf-8';
  const manifest = createSnapshotManifest([
    {
      path: filePath,
      size: fileBytes.byteLength,
      mediaType,
      sha256: sha256Hex(fileBytes),
    },
  ]);
  const manifestBytes = snapshotManifestBytes(manifest);
  const archiveBytes = compressDeterministicTar(
    createDeterministicTar([{ path: filePath, bytes: fileBytes }]),
  );
  const snapshotDigest = sha256Hex(manifestBytes);
  const archive = encryptSnapshotArchiveTestOnly(
    archiveBytes,
    {
      protocol: SNAPSHOT_ENVELOPE_PROTOCOL,
      schemaVersion: 1,
      cipherObjectFormat: SNAPSHOT_ARCHIVE_OBJECT_FORMAT,
      creatorId,
      snapshotDigest,
      archiveDigest: sha256Hex(archiveBytes),
      objectKey: snapshotArchiveObjectKey(creatorId, snapshotDigest),
      plaintextBytes: archiveBytes.byteLength,
      keyId,
    },
    dataKey,
    { keyId, wrappedDek },
    Buffer.alloc(12, options.archiveNonceByte ?? 1),
  );
  const encryptedManifest = encryptSnapshotManifestTestOnly(
    manifestBytes,
    {
      protocol: SNAPSHOT_MANIFEST_ENVELOPE_PROTOCOL,
      schemaVersion: 1,
      cipherObjectFormat: SNAPSHOT_MANIFEST_OBJECT_FORMAT,
      creatorId,
      snapshotDigest,
      objectKey: snapshotManifestObjectKey(creatorId, snapshotDigest),
      plaintextBytes: manifestBytes.byteLength,
      keyId,
    },
    dataKey,
    { keyId, wrappedDek },
    Buffer.alloc(12, options.manifestNonceByte ?? 2),
  );
  const request: SnapshotUploadCreateRequest = {
    archive: { envelope: archive.envelope, checksumSha256: checksum(archive.objectBytes) },
    manifest: {
      envelope: encryptedManifest.envelope,
      checksumSha256: checksum(encryptedManifest.objectBytes),
    },
    expandedBytes: fileBytes.byteLength,
    fileCount: 1,
  };
  const dataKeyResult: { value?: Buffer } = {};
  const keyEnvelope: SnapshotKeyEnvelopePort = {
    async createDataKey() {
      throw new Error('not used by verifier');
    },
    async unwrapDataKey(input) {
      expect(input.keyId).toBe(keyId);
      expect(input.wrappedDek).toEqual(wrappedDek);
      dataKeyResult.value = Buffer.from(dataKey);
      return dataKeyResult.value;
    },
  };
  return {
    request,
    keyEnvelope,
    dataKeyResult,
    keyId,
    wrappedDek,
    dataKey,
    bundle: {
      uploadId,
      request,
      archiveObjectBytes: archive.objectBytes,
      manifestObjectBytes: encryptedManifest.objectBytes,
    },
  };
}

function verifierKeyring(...fixtures: readonly UploadFixture[]): SnapshotDataKeyUnwrapperPort {
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

function tenantStore(
  client: FakeSnapshotS3Client,
  presigner?: FakePresigner,
  creatorId = CREATOR_A,
): S3ImmutableSnapshotObjectStore {
  return new S3ImmutableSnapshotObjectStore({
    client,
    ...(presigner === undefined ? {} : { presigner }),
    bucket: 'combo-agent-versions-test',
    creatorId,
  });
}

describe('S3 immutable Snapshot signed upload and verifier', () => {
  it('returns two exact HTTPS Signed PUT targets after both cipher objects already exist', async () => {
    const client = new FakeSnapshotS3Client();
    const presigner = new FakePresigner();
    const store = tenantStore(client, presigner);
    const fixture = uploadFixture();

    const response = await store.createUploadSession({
      uploadId: fixture.bundle.uploadId,
      request: fixture.request,
      expiresInSeconds: 900,
      now: new Date('2026-08-13T08:00:00.000Z'),
    });
    expect(SnapshotUploadCreateResponseSchema.parse(response)).toEqual(response);
    expect(response.expiresAt).toBe('2026-08-13T08:15:00.000Z');
    expect(presigner.calls).toHaveLength(2);
    expect(presigner.calls.map((call) => call.signingDate.toISOString())).toEqual([
      '2026-08-13T08:00:00.000Z',
      '2026-08-13T08:00:00.000Z',
    ]);
    expect(presigner.calls.map((call) => call.command.input.Key).sort()).toEqual([
      snapshotUploadObjectKey(CREATOR_A, UPLOAD_A, 'archive'),
      snapshotUploadObjectKey(CREATOR_A, UPLOAD_A, 'manifest'),
    ]);

    for (const [kind, target] of Object.entries(response.uploads)) {
      expect(target.requiredHeaders).toEqual({
        'cache-control': 'no-store',
        'content-length': String(target.cipherBytes),
        'content-type': 'application/octet-stream',
        'if-none-match': '*',
        'x-amz-checksum-sha256':
          kind === 'archive'
            ? fixture.request.archive.checksumSha256
            : fixture.request.manifest.checksumSha256,
        'x-amz-meta-archive-digest': fixture.request.archive.envelope.aad.archiveDigest,
        'x-amz-meta-cipher-bytes': String(target.cipherBytes),
        'x-amz-meta-cipher-digest': target.cipherDigest,
        'x-amz-meta-object-kind': kind,
        'x-amz-meta-object-state': 'upload',
        'x-amz-meta-protocol': 'combo.snapshot-object-storage/1',
        'x-amz-meta-snapshot-digest': fixture.request.archive.envelope.aad.snapshotDigest,
      });
      expect(
        decodeURIComponent(new URL(target.putUrl).searchParams.get('X-Amz-SignedHeaders')!),
      ).toBe(Object.keys(target.requiredHeaders).sort().join(';'));
    }
  });

  it('rejects plaintext presigned URLs except under the explicit disposable loopback authority', async () => {
    const fixture = uploadFixture();
    const input = {
      uploadId: fixture.bundle.uploadId,
      request: fixture.request,
    };
    const publicPlaintext = new S3ImmutableSnapshotObjectStore({
      client: new FakeSnapshotS3Client(),
      presigner: new InsecurePresigner('http://storage.example.invalid'),
      bucket: 'combo-agent-versions-test',
      creatorId: CREATOR_A,
      allowInsecureLoopbackPresignedUrls: true,
    });
    await expect(publicPlaintext.createUploadSession(input)).rejects.toSatisfy((error: unknown) =>
      isSnapshotError(error, 'SNAPSHOT_OBJECT_INVALID'),
    );

    const loopbackWithoutAuthority = new S3ImmutableSnapshotObjectStore({
      client: new FakeSnapshotS3Client(),
      presigner: new InsecurePresigner('http://127.0.0.1:9000'),
      bucket: 'combo-agent-versions-test',
      creatorId: CREATOR_A,
    });
    await expect(loopbackWithoutAuthority.createUploadSession(input)).rejects.toSatisfy(
      (error: unknown) => isSnapshotError(error, 'SNAPSHOT_OBJECT_INVALID'),
    );

    const disposableLoopback = new S3ImmutableSnapshotObjectStore({
      client: new FakeSnapshotS3Client(),
      presigner: new InsecurePresigner('http://127.0.0.1:9000'),
      bucket: 'combo-agent-versions-test',
      creatorId: CREATOR_A,
      allowInsecureLoopbackPresignedUrls: true,
    });
    await expect(disposableLoopback.createUploadSession(input)).resolves.toMatchObject({
      uploads: {
        archive: { putUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:9000\//u) },
        manifest: { putUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:9000\//u) },
      },
    });
  });

  it('fully verifies both temp objects before one winner conditionally promotes two final objects', async () => {
    const client = new FakeSnapshotS3Client();
    const store = tenantStore(client);
    const fixture = uploadFixture();
    await store.putUpload(fixture.bundle);

    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        store.finalizeUpload({
          uploadId: fixture.bundle.uploadId,
          request: fixture.request,
          keyEnvelope: fixture.keyEnvelope,
        }),
      ),
    );
    expect(new Set(results.map((result) => result.verified.snapshotDigest))).toEqual(
      new Set([fixture.request.archive.envelope.aad.snapshotDigest]),
    );
    expect(
      [...client.objects.keys()].filter((key) => key.startsWith(`creators/${CREATOR_A}/`)).sort(),
    ).toEqual([
      immutableSnapshotManifestObjectKey(
        CREATOR_A,
        fixture.request.archive.envelope.aad.snapshotDigest,
      ),
      snapshotPublicationCommitKey(CREATOR_A, fixture.request.archive.envelope.aad.snapshotDigest),
      snapshotPublicationPreparationKey(
        CREATOR_A,
        fixture.request.archive.envelope.aad.snapshotDigest,
      ),
      immutableSnapshotObjectKey(CREATOR_A, fixture.request.archive.envelope.aad.snapshotDigest),
    ]);
    expect(fixture.dataKeyResult.value).toEqual(Buffer.alloc(32));
  });

  it('rejects the digest-bound canonical compression bomb before preparation or publication', async () => {
    const corpus = SnapshotCompressionRatioBoundaryCorpusSchema.parse(
      JSON.parse(await readFile(compressionRatioCorpusUrl, 'utf8')),
    );
    const vector = corpus.mechanism.vectors[1];
    const bombBytes = Buffer.alloc(
      corpus.mechanism.bombRecipe.contentBytes,
      Number.parseInt(corpus.mechanism.bombRecipe.byteHex, 16),
    );
    expect(`sha256:${sha256Hex(bombBytes)}`).toBe(vector.digests.content);
    const fixture = uploadFixture({
      filePath: vector.filePath,
      fileBytes: bombBytes,
      mediaType: corpus.mechanism.mediaType,
      archiveNonceByte: 0x31,
      manifestNonceByte: 0x32,
    });
    expect(fixture.request).toMatchObject({ expandedBytes: vector.contentBytes, fileCount: 1 });
    expect(fixture.request.archive.envelope.aad).toMatchObject({
      plaintextBytes: vector.archiveBytes,
      archiveDigest: vector.digests.archive.slice('sha256:'.length),
      snapshotDigest: vector.digests.snapshot.slice('sha256:'.length),
    });

    const client = new FakeSnapshotS3Client();
    const store = tenantStore(client);
    await store.putUpload(fixture.bundle);
    await expect(
      store.finalizeUpload({
        uploadId: fixture.bundle.uploadId,
        request: fixture.request,
        keyEnvelope: fixture.keyEnvelope,
      }),
    ).rejects.toSatisfy((error: unknown) =>
      isSnapshotError(error, 'SNAPSHOT_COMPRESSION_RATIO_EXCEEDED'),
    );

    const digest = fixture.request.archive.envelope.aad.snapshotDigest;
    expect(client.objects.has(snapshotPublicationPreparationKey(CREATOR_A, digest))).toBe(false);
    expect(client.objects.has(immutableSnapshotObjectKey(CREATOR_A, digest))).toBe(false);
    expect(client.objects.has(immutableSnapshotManifestObjectKey(CREATOR_A, digest))).toBe(false);
    expect(client.objects.has(snapshotPublicationCommitKey(CREATOR_A, digest))).toBe(false);
    expect(await store.readFinalBundle(fixture.request)).toBeUndefined();
    expect([...client.objects.keys()].filter((key) => key.startsWith('uploads/'))).toHaveLength(2);
    expect(fixture.dataKeyResult.value).toEqual(Buffer.alloc(32));
  });

  it('keeps a partial final pair invisible and heals it by replaying the prepared temp pair', async () => {
    const client = new FakeSnapshotS3Client();
    const store = tenantStore(client);
    const fixture = uploadFixture();
    await store.putUpload(fixture.bundle);
    const digest = fixture.request.archive.envelope.aad.snapshotDigest;
    const archiveFinalKey = immutableSnapshotObjectKey(CREATOR_A, digest);
    const manifestFinalKey = immutableSnapshotManifestObjectKey(CREATOR_A, digest);
    const preparationKey = snapshotPublicationPreparationKey(CREATOR_A, digest);
    const commitKey = snapshotPublicationCommitKey(CREATOR_A, digest);
    client.failNextPut(manifestFinalKey, s3Error('ServiceUnavailable', 503));

    await expect(
      store.finalizeUpload({
        uploadId: UPLOAD_A,
        request: fixture.request,
        keyEnvelope: fixture.keyEnvelope,
      }),
    ).rejects.toSatisfy((error: unknown) => isSnapshotError(error, 'SNAPSHOT_STORAGE_UNAVAILABLE'));
    expect(client.objects.has(preparationKey)).toBe(true);
    expect(client.objects.has(archiveFinalKey)).toBe(true);
    expect(client.objects.has(manifestFinalKey)).toBe(false);
    expect(client.objects.has(commitKey)).toBe(false);
    expect(await store.readFinalBundle(fixture.request)).toBeUndefined();
    expect(JSON.stringify(client.objects.get(preparationKey)?.metadata)).not.toContain('wrapped');
    expect(JSON.stringify(client.objects.get(preparationKey)?.metadata)).not.toContain(KEY_ID);

    await expect(
      store.finalizeUpload({
        uploadId: UPLOAD_A,
        request: fixture.request,
        keyEnvelope: fixture.keyEnvelope,
      }),
    ).resolves.toMatchObject({ verified: { snapshotDigest: digest } });
    expect(client.objects.has(manifestFinalKey)).toBe(true);
    expect(client.objects.has(commitKey)).toBe(true);
  });

  it('fails closed when a privileged rewrite changes the committed preparation body', async () => {
    const client = new FakeSnapshotS3Client();
    const store = tenantStore(client);
    const fixture = uploadFixture();
    await store.putUpload(fixture.bundle);
    await store.finalizeUpload({
      uploadId: UPLOAD_A,
      request: fixture.request,
      keyEnvelope: fixture.keyEnvelope,
    });

    const digest = fixture.request.archive.envelope.aad.snapshotDigest;
    client.mutate(snapshotPublicationPreparationKey(CREATOR_A, digest), (object) => {
      const rewritten = object.body.toString('utf8').replace(UPLOAD_A, UPLOAD_B);
      expect(rewritten).not.toBe(object.body.toString('utf8'));
      object.body = Buffer.from(rewritten, 'utf8');
      object.contentLength = object.body.byteLength;
      object.checksumSha256 = checksum(object.body);
      object.metadata['body-bytes'] = String(object.body.byteLength);
      object.metadata['body-digest'] = sha256Hex(object.body);
    });

    await expect(
      store.readAndVerify({ request: fixture.request, keyEnvelope: fixture.keyEnvelope }),
    ).rejects.toSatisfy((error: unknown) => isSnapshotError(error, 'SNAPSHOT_IMMUTABLE_CONFLICT'));
  });

  it('rebuilds the exact prepared ciphertext after original temp loss using a verified fresh DEK pair', async () => {
    const client = new FakeSnapshotS3Client();
    const store = tenantStore(client);
    const prepared = uploadFixture();
    await store.putUpload(prepared.bundle);
    const digest = prepared.request.archive.envelope.aad.snapshotDigest;
    client.failNextPut(
      immutableSnapshotManifestObjectKey(CREATOR_A, digest),
      s3Error('ServiceUnavailable', 503),
    );
    await expect(
      store.finalizeUpload({
        uploadId: UPLOAD_A,
        request: prepared.request,
        keyEnvelope: prepared.keyEnvelope,
      }),
    ).rejects.toSatisfy((error: unknown) => isSnapshotError(error, 'SNAPSHOT_STORAGE_UNAVAILABLE'));
    client.objects.delete(snapshotUploadObjectKey(CREATOR_A, UPLOAD_A, 'archive'));
    client.objects.delete(snapshotUploadObjectKey(CREATOR_A, UPLOAD_A, 'manifest'));

    const replacement = uploadFixture({
      uploadId: UPLOAD_B,
      archiveNonceByte: 3,
      manifestNonceByte: 4,
      keyId: 'test-key:v2',
      wrappedDek: Buffer.alloc(40, 10),
      dataKey: Buffer.alloc(32, 8),
    });
    expect(replacement.request.archive.envelope.aad.snapshotDigest).toBe(digest);
    expect(replacement.request.archive.envelope.cipherDigest).not.toBe(
      prepared.request.archive.envelope.cipherDigest,
    );
    await store.putUpload(replacement.bundle);
    const finalized = await store.finalizeUpload({
      uploadId: UPLOAD_B,
      request: replacement.request,
      keyEnvelope: verifierKeyring(prepared, replacement),
    });
    expect(finalized.stored.archive.envelope.cipherDigest).toBe(
      prepared.request.archive.envelope.cipherDigest,
    );
    expect(finalized.stored.manifest.envelope.cipherDigest).toBe(
      prepared.request.manifest.envelope.cipherDigest,
    );
    await expect(
      store.readAndVerify({
        request: replacement.request,
        keyEnvelope: verifierKeyring(prepared, replacement),
      }),
    ).resolves.toMatchObject({ verified: { snapshotDigest: digest } });
  });

  it('concurrent finalize with different cipher generations converges on one committed pair', async () => {
    const client = new FakeSnapshotS3Client();
    const store = tenantStore(client);
    const first = uploadFixture();
    const second = uploadFixture({
      uploadId: UPLOAD_B,
      archiveNonceByte: 7,
      manifestNonceByte: 8,
      keyId: 'test-key:v2',
      wrappedDek: Buffer.alloc(40, 11),
      dataKey: Buffer.alloc(32, 12),
    });
    await Promise.all([store.putUpload(first.bundle), store.putUpload(second.bundle)]);
    const keyEnvelope = verifierKeyring(first, second);
    const results = await Promise.all([
      store.finalizeUpload({ uploadId: UPLOAD_A, request: first.request, keyEnvelope }),
      store.finalizeUpload({ uploadId: UPLOAD_B, request: second.request, keyEnvelope }),
    ]);
    expect(new Set(results.map((result) => result.stored.archive.envelope.cipherDigest)).size).toBe(
      1,
    );
    expect(
      new Set(results.map((result) => result.stored.manifest.envelope.cipherDigest)).size,
    ).toBe(1);
  });

  it('never reserves final keys for an AEAD-corrupt temp and accepts a correct same-digest retry', async () => {
    const client = new FakeSnapshotS3Client();
    const store = tenantStore(client);
    const corrupt = uploadFixture();
    await store.putUpload(corrupt.bundle);

    const manifestKey = snapshotUploadObjectKey(CREATOR_A, UPLOAD_A, 'manifest');
    const mutatedBytes = Buffer.from(corrupt.bundle.manifestObjectBytes);
    mutatedBytes[20] = mutatedBytes[20]! ^ 1;
    const mutatedDigest = sha256Hex(mutatedBytes);
    const mutatedChecksum = checksum(mutatedBytes);
    const corruptedRequest: SnapshotUploadCreateRequest = {
      ...corrupt.request,
      manifest: {
        envelope: { ...corrupt.request.manifest.envelope, cipherDigest: mutatedDigest },
        checksumSha256: mutatedChecksum,
      },
    };
    client.mutate(manifestKey, (object) => {
      object.body = mutatedBytes;
      object.checksumSha256 = mutatedChecksum;
      object.metadata['cipher-digest'] = mutatedDigest;
    });

    await expect(
      store.finalizeUpload({
        uploadId: UPLOAD_A,
        request: corruptedRequest,
        keyEnvelope: corrupt.keyEnvelope,
      }),
    ).rejects.toSatisfy((error: unknown) => isSnapshotError(error, 'SNAPSHOT_ENCRYPTION_INVALID'));
    expect([...client.objects.keys()].some((key) => key.startsWith(`creators/${CREATOR_A}/`))).toBe(
      false,
    );

    const retry = uploadFixture({
      uploadId: UPLOAD_B,
      archiveNonceByte: 3,
      manifestNonceByte: 4,
    });
    expect(retry.request.archive.envelope.aad.snapshotDigest).toBe(
      corrupt.request.archive.envelope.aad.snapshotDigest,
    );
    await store.putUpload(retry.bundle);
    const finalized = await store.finalizeUpload({
      uploadId: UPLOAD_B,
      request: retry.request,
      keyEnvelope: retry.keyEnvelope,
    });
    expect(finalized.verified.fileCount).toBe(1);
  });

  it('adopts the committed verified plaintext identity across a fresh DEK and nonce pair', async () => {
    const client = new FakeSnapshotS3Client();
    const store = tenantStore(client);
    const first = uploadFixture();
    const competitor = uploadFixture({
      uploadId: UPLOAD_B,
      archiveNonceByte: 5,
      manifestNonceByte: 6,
      keyId: 'test-key:v2',
      wrappedDek: Buffer.alloc(40, 10),
      dataKey: Buffer.alloc(32, 8),
    });
    await store.putUpload(first.bundle);
    await store.finalizeUpload({
      uploadId: UPLOAD_A,
      request: first.request,
      keyEnvelope: first.keyEnvelope,
    });
    await store.putUpload(competitor.bundle);
    const adopted = await store.finalizeUpload({
      uploadId: UPLOAD_B,
      request: competitor.request,
      keyEnvelope: verifierKeyring(first, competitor),
    });
    expect(adopted.stored.archive.envelope.cipherDigest).toBe(
      first.request.archive.envelope.cipherDigest,
    );
    expect(adopted.stored.manifest.envelope.cipherDigest).toBe(
      first.request.manifest.envelope.cipherDigest,
    );
  });

  it('repairs a committed missing final from a verified fresh upload when the selected temp is corrupt', async () => {
    const client = new FakeSnapshotS3Client();
    const store = tenantStore(client);
    const prepared = uploadFixture();
    await store.putUpload(prepared.bundle);
    await store.finalizeUpload({
      uploadId: UPLOAD_A,
      request: prepared.request,
      keyEnvelope: prepared.keyEnvelope,
    });

    const digest = prepared.request.archive.envelope.aad.snapshotDigest;
    client.objects.delete(immutableSnapshotManifestObjectKey(CREATOR_A, digest));
    client.mutate(snapshotUploadObjectKey(CREATOR_A, UPLOAD_A, 'manifest'), (object) => {
      object.body[object.body.length - 1] = object.body[object.body.length - 1]! ^ 1;
    });
    await expect(store.readFinalBundle(prepared.request)).rejects.toSatisfy((error: unknown) =>
      isSnapshotError(error, 'SNAPSHOT_IMMUTABLE_CONFLICT'),
    );

    const replacement = uploadFixture({
      uploadId: UPLOAD_B,
      archiveNonceByte: 9,
      manifestNonceByte: 10,
      keyId: 'test-key:v2',
      wrappedDek: Buffer.alloc(40, 12),
      dataKey: Buffer.alloc(32, 13),
    });
    await store.putUpload(replacement.bundle);
    const repaired = await store.finalizeUpload({
      uploadId: UPLOAD_B,
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

  it('rejects client-declared file count or expanded size lies before promotion', async () => {
    const client = new FakeSnapshotS3Client();
    const store = tenantStore(client);
    const fixture = uploadFixture();
    const liedRequest: SnapshotUploadCreateRequest = {
      ...fixture.request,
      expandedBytes: fixture.request.expandedBytes + 1,
      fileCount: fixture.request.fileCount + 1,
    };
    await store.putUpload({ ...fixture.bundle, request: liedRequest });
    await expect(
      store.finalizeUpload({
        uploadId: fixture.bundle.uploadId,
        request: liedRequest,
        keyEnvelope: fixture.keyEnvelope,
      }),
    ).rejects.toSatisfy((error: unknown) => isSnapshotError(error, 'SNAPSHOT_DIGEST_MISMATCH'));
    expect([...client.objects.keys()].some((key) => key.startsWith(`creators/${CREATOR_A}/`))).toBe(
      false,
    );
  });

  it('fails closed for final body, checksum, size, metadata and tenant mutation', async () => {
    const mutationCases: ((object: FakeObject) => void)[] = [
      (object) => {
        object.body[object.body.length - 1] = object.body[object.body.length - 1]! ^ 1;
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
        object.bodyChunks = [object.body.toString('base64')];
      },
    ];
    for (const mutate of mutationCases) {
      const client = new FakeSnapshotS3Client();
      const store = tenantStore(client);
      const fixture = uploadFixture();
      await store.putUpload(fixture.bundle);
      await store.finalizeUpload({
        uploadId: UPLOAD_A,
        request: fixture.request,
        keyEnvelope: fixture.keyEnvelope,
      });
      client.mutate(fixture.request.archive.envelope.aad.objectKey, mutate);
      await expect(
        store.readAndVerify({ request: fixture.request, keyEnvelope: fixture.keyEnvelope }),
      ).rejects.toSatisfy((error: unknown) => isSnapshotError(error, 'SNAPSHOT_OBJECT_INVALID'));
    }

    const tenantB = uploadFixture({ creatorId: CREATOR_B });
    await expect(
      tenantStore(new FakeSnapshotS3Client()).putUpload(tenantB.bundle),
    ).rejects.toSatisfy((error: unknown) => isSnapshotError(error, 'SNAPSHOT_OBJECT_INVALID'));
    expect(() => snapshotUploadObjectKey('../creator', UPLOAD_A, 'archive')).toThrowError();
  });

  it('sanitizes key provider failures and does not unwrap before stored-object validation', async () => {
    const client = new FakeSnapshotS3Client();
    const store = tenantStore(client);
    const fixture = uploadFixture();
    await store.putUpload(fixture.bundle);
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
    client.mutate(snapshotUploadObjectKey(CREATOR_A, UPLOAD_A, 'archive'), (object) => {
      object.metadata['cipher-digest'] = '0'.repeat(64);
    });
    await expect(
      store.finalizeUpload({ uploadId: UPLOAD_A, request: fixture.request, keyEnvelope }),
    ).rejects.toSatisfy((error: unknown) => isSnapshotError(error, 'SNAPSHOT_OBJECT_INVALID'));
    expect(unwrapCalls).toBe(0);

    client.mutate(snapshotUploadObjectKey(CREATOR_A, UPLOAD_A, 'archive'), (object) => {
      object.metadata['cipher-digest'] = fixture.request.archive.envelope.cipherDigest;
    });
    let caught: unknown;
    try {
      await store.finalizeUpload({ uploadId: UPLOAD_A, request: fixture.request, keyEnvelope });
    } catch (error) {
      caught = error;
    }
    expect(isSnapshotError(caught, 'SNAPSHOT_ENCRYPTION_INVALID')).toBe(true);
    expect(JSON.stringify(caught)).not.toContain('secret provider detail');
    expect(unwrapCalls).toBe(1);
  });

  it('does not treat a missing bucket as a missing tenant object', async () => {
    const client = new FakeSnapshotS3Client();
    client.getFailure = s3Error('NoSuchBucket', 404);
    const store = tenantStore(client);
    await expect(store.readFinalBundle(uploadFixture().request)).rejects.toSatisfy(
      (error: unknown) => isSnapshotError(error, 'SNAPSHOT_STORAGE_UNAVAILABLE'),
    );
  });
});
