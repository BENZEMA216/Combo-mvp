import { createHash, timingSafeEqual } from 'node:crypto';
import { type Readable } from 'node:stream';
import {
  GetObjectCommand,
  PutObjectCommand,
  type GetObjectCommandOutput,
  type PutObjectCommandOutput,
  type S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  CREATOR_AGENT_HTTP_PROTOCOL,
  SNAPSHOT_OBJECT_STORAGE_PROTOCOL,
  SnapshotUploadCreateRequestSchema,
  SnapshotUploadCreateResponseSchema,
  UuidSchema,
  parseSnapshotArchiveCipherObject,
  parseSnapshotManifestCipherObject,
  snapshotArchiveObjectKey,
  snapshotManifestObjectKey,
  type SnapshotArchiveEnvelope,
  type SnapshotManifestEnvelope,
  type SnapshotSignedPutTarget,
  type SnapshotUploadCreateRequest,
  type SnapshotUploadCreateResponse,
} from '@cb/creator-agent-protocol';

import { type SnapshotDataKeyUnwrapperPort } from './encryption.js';
import { fail, isSnapshotError } from './errors.js';
import { decryptAndVerifySnapshotBundle, type VerifiedSnapshotArchive } from './snapshot.js';

export { SNAPSHOT_OBJECT_STORAGE_PROTOCOL };

export const MAX_ENCRYPTED_SNAPSHOT_BYTES = 50 * 1024 * 1024 + 36;
export const MAX_ENCRYPTED_MANIFEST_BYTES = 4 * 1024 * 1024 + 36;
const DATA_ENCRYPTION_KEY_BYTES = 32;
const CONTENT_TYPE = 'application/octet-stream';
const CACHE_CONTROL = 'no-store';
const MAX_SIGNED_PUT_SECONDS = 15 * 60;

export interface SnapshotS3CommandClient {
  send(command: PutObjectCommand): Promise<PutObjectCommandOutput>;
  send(command: GetObjectCommand): Promise<GetObjectCommandOutput>;
}

export interface SnapshotS3PutPresigner {
  presignPut(input: {
    command: PutObjectCommand;
    requiredHeaders: Readonly<Record<string, string>>;
    expiresInSeconds: number;
    signingDate: Date;
  }): Promise<string>;
}

export function createSnapshotS3PutPresigner(client: S3Client): SnapshotS3PutPresigner {
  return {
    async presignPut(input) {
      const headerNames = Object.keys(input.requiredHeaders);
      return getSignedUrl(client, input.command, {
        expiresIn: input.expiresInSeconds,
        signingDate: input.signingDate,
        signableHeaders: new Set(headerNames),
        unhoistableHeaders: new Set(headerNames.filter((name) => name.startsWith('x-amz-'))),
      });
    },
  };
}

export type SnapshotEncryptedUploadBundle = Readonly<{
  uploadId: string;
  request: SnapshotUploadCreateRequest;
  archiveObjectBytes: Uint8Array;
  manifestObjectBytes: Uint8Array;
}>;

export type StoredSnapshotCipherObject<
  TEnvelope extends SnapshotArchiveEnvelope | SnapshotManifestEnvelope =
    | SnapshotArchiveEnvelope
    | SnapshotManifestEnvelope,
> = Readonly<{
  kind: 'archive' | 'manifest';
  envelope: TEnvelope;
  objectKey: string;
  encryptedObjectBytes: Buffer;
}>;

export type StoredSnapshotBundle = Readonly<{
  archive: StoredSnapshotCipherObject<SnapshotArchiveEnvelope>;
  manifest: StoredSnapshotCipherObject<SnapshotManifestEnvelope>;
}>;

export type FinalizeSnapshotUploadInput = Readonly<{
  uploadId: string;
  request: SnapshotUploadCreateRequest;
  keyEnvelope: SnapshotDataKeyUnwrapperPort;
}>;

export type ReadAndVerifyStoredSnapshotInput = Readonly<{
  request: SnapshotUploadCreateRequest;
  keyEnvelope: SnapshotDataKeyUnwrapperPort;
}>;

type ObjectKind = 'archive' | 'manifest';
type ObjectState = 'upload' | 'immutable';
type SnapshotMetadata = Record<string, string>;

type ArchiveExpectation = Readonly<{
  kind: 'archive';
  envelope: SnapshotArchiveEnvelope;
  checksumSha256: string;
  creatorId: string;
  snapshotDigest: string;
  archiveDigest: string;
  cipherDigest: string;
  cipherBytes: number;
  finalKey: string;
}>;

type ManifestExpectation = Readonly<{
  kind: 'manifest';
  envelope: SnapshotManifestEnvelope;
  checksumSha256: string;
  creatorId: string;
  snapshotDigest: string;
  archiveDigest: string;
  cipherDigest: string;
  cipherBytes: number;
  finalKey: string;
}>;

type ObjectExpectation = ArchiveExpectation | ManifestExpectation;
type UploadExpectations = Readonly<{
  request: SnapshotUploadCreateRequest;
  archive: ArchiveExpectation;
  manifest: ManifestExpectation;
}>;

const REQUIRED_METADATA_KEYS = [
  'archive-digest',
  'cipher-bytes',
  'cipher-digest',
  'object-kind',
  'object-state',
  'protocol',
  'snapshot-digest',
] as const;

function parseUploadRequest(input: SnapshotUploadCreateRequest): UploadExpectations {
  const parsed = SnapshotUploadCreateRequestSchema.safeParse(input);
  if (!parsed.success) fail('SNAPSHOT_OBJECT_INVALID');
  const archive = parsed.data.archive.envelope;
  const manifest = parsed.data.manifest.envelope;
  return Object.freeze({
    request: parsed.data,
    archive: Object.freeze({
      kind: 'archive',
      envelope: archive,
      checksumSha256: parsed.data.archive.checksumSha256,
      creatorId: archive.aad.creatorId,
      snapshotDigest: archive.aad.snapshotDigest,
      archiveDigest: archive.aad.archiveDigest,
      cipherDigest: archive.cipherDigest,
      cipherBytes: archive.cipherBytes,
      finalKey: snapshotArchiveObjectKey(archive.aad.creatorId, archive.aad.snapshotDigest),
    }),
    manifest: Object.freeze({
      kind: 'manifest',
      envelope: manifest,
      checksumSha256: parsed.data.manifest.checksumSha256,
      creatorId: manifest.aad.creatorId,
      snapshotDigest: manifest.aad.snapshotDigest,
      archiveDigest: archive.aad.archiveDigest,
      cipherDigest: manifest.cipherDigest,
      cipherBytes: manifest.cipherBytes,
      finalKey: snapshotManifestObjectKey(manifest.aad.creatorId, manifest.aad.snapshotDigest),
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

export function snapshotUploadObjectKey(
  creatorId: string,
  uploadId: string,
  kind: ObjectKind,
): string {
  const creator = UuidSchema.safeParse(creatorId);
  const upload = UuidSchema.safeParse(uploadId);
  if (!creator.success || !upload.success || (kind !== 'archive' && kind !== 'manifest')) {
    fail('SNAPSHOT_OBJECT_INVALID');
  }
  return `uploads/${creator.data}/${upload.data}/${kind}.part`;
}

export function immutableSnapshotObjectKey(creatorId: string, snapshotDigest: string): string {
  try {
    return snapshotArchiveObjectKey(creatorId, snapshotDigest);
  } catch {
    fail('SNAPSHOT_OBJECT_INVALID');
  }
}

export function immutableSnapshotManifestObjectKey(
  creatorId: string,
  snapshotDigest: string,
): string {
  try {
    return snapshotManifestObjectKey(creatorId, snapshotDigest);
  } catch {
    fail('SNAPSHOT_OBJECT_INVALID');
  }
}

function metadataFor(expectation: ObjectExpectation, state: ObjectState): SnapshotMetadata {
  return {
    protocol: SNAPSHOT_OBJECT_STORAGE_PROTOCOL,
    'object-kind': expectation.kind,
    'object-state': state,
    'snapshot-digest': expectation.snapshotDigest,
    'archive-digest': expectation.archiveDigest,
    'cipher-digest': expectation.cipherDigest,
    'cipher-bytes': String(expectation.cipherBytes),
  };
}

function requiredHeadersFor(
  expectation: ObjectExpectation,
): SnapshotSignedPutTarget['requiredHeaders'] {
  const metadata = metadataFor(expectation, 'upload');
  return {
    'cache-control': CACHE_CONTROL,
    'content-length': String(expectation.cipherBytes),
    'content-type': CONTENT_TYPE,
    'if-none-match': '*',
    'x-amz-checksum-sha256': expectation.checksumSha256,
    'x-amz-meta-archive-digest': metadata['archive-digest']!,
    'x-amz-meta-cipher-bytes': metadata['cipher-bytes']!,
    'x-amz-meta-cipher-digest': metadata['cipher-digest']!,
    'x-amz-meta-object-kind': expectation.kind,
    'x-amz-meta-object-state': 'upload',
    'x-amz-meta-protocol': SNAPSHOT_OBJECT_STORAGE_PROTOCOL,
    'x-amz-meta-snapshot-digest': metadata['snapshot-digest']!,
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

function isInsecureLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      url.username === '' &&
      url.password === '' &&
      url.hash === '' &&
      (url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost')
    );
  } catch {
    return false;
  }
}

function presignedObjectLocator(value: string): string {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
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
    for await (const chunk of body as Readable) {
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
  readonly #presigner: SnapshotS3PutPresigner | undefined;
  readonly #bucket: string;
  readonly #creatorId: string;
  readonly #allowInsecureLoopbackPresignedUrls: boolean;

  constructor(input: {
    client: SnapshotS3CommandClient;
    presigner?: SnapshotS3PutPresigner;
    bucket: string;
    creatorId: string;
    /** Disposable local component tests only; production must keep the default false. */
    allowInsecureLoopbackPresignedUrls?: boolean;
  }) {
    assertBucket(input.bucket);
    const creator = UuidSchema.safeParse(input.creatorId);
    if (!creator.success) fail('SNAPSHOT_OBJECT_INVALID');
    this.#client = input.client;
    this.#presigner = input.presigner;
    this.#bucket = input.bucket;
    this.#creatorId = creator.data;
    this.#allowInsecureLoopbackPresignedUrls = input.allowInsecureLoopbackPresignedUrls === true;
  }

  async createUploadSession(input: {
    uploadId: string;
    request: SnapshotUploadCreateRequest;
    expiresInSeconds?: number;
    now?: Date;
  }): Promise<SnapshotUploadCreateResponse> {
    if (this.#presigner === undefined) fail('SNAPSHOT_STORAGE_UNAVAILABLE');
    const uploadId = normalizeUploadId(input.uploadId);
    const expected = this.#expectations(input.request);
    const expiresInSeconds = input.expiresInSeconds ?? MAX_SIGNED_PUT_SECONDS;
    if (
      !Number.isSafeInteger(expiresInSeconds) ||
      expiresInSeconds < 1 ||
      expiresInSeconds > MAX_SIGNED_PUT_SECONDS
    ) {
      fail('SNAPSHOT_OBJECT_INVALID');
    }
    const now = input.now ?? new Date();
    if (Number.isNaN(now.getTime())) fail('SNAPSHOT_OBJECT_INVALID');
    const [archive, manifest] = await Promise.all([
      this.#signTarget(uploadId, expected.archive, expiresInSeconds, now),
      this.#signTarget(uploadId, expected.manifest, expiresInSeconds, now),
    ]);
    const response = {
      protocol: CREATOR_AGENT_HTTP_PROTOCOL,
      uploadId,
      state: 'CREATED' as const,
      uploads: { archive, manifest },
      expiresAt: new Date(now.getTime() + expiresInSeconds * 1_000).toISOString(),
    };
    if (archive.putUrl.startsWith('https://') && manifest.putUrl.startsWith('https://')) {
      return SnapshotUploadCreateResponseSchema.parse(response);
    }
    // This explicit constructor capability exists only for the disposable loopback MinIO E2.
    // It cannot admit a LAN/public plaintext URL or silently weaken the Authoring contract.
    if (
      !this.#allowInsecureLoopbackPresignedUrls ||
      !isInsecureLoopbackUrl(archive.putUrl) ||
      !isInsecureLoopbackUrl(manifest.putUrl) ||
      presignedObjectLocator(archive.putUrl) === presignedObjectLocator(manifest.putUrl)
    ) {
      fail('SNAPSHOT_OBJECT_INVALID');
    }
    return response;
  }

  /** Internal/test helper. Production Worker uploads through createUploadSession Signed PUTs. */
  async putUpload(input: SnapshotEncryptedUploadBundle): Promise<StoredSnapshotBundle> {
    const uploadId = normalizeUploadId(input.uploadId);
    const expected = this.#expectations(input.request);
    this.#assertObjectBytes(expected.archive, input.archiveObjectBytes);
    this.#assertObjectBytes(expected.manifest, input.manifestObjectBytes);
    const archive = await this.#putObject(
      snapshotUploadObjectKey(this.#creatorId, uploadId, 'archive'),
      expected.archive,
      input.archiveObjectBytes,
      'upload',
    );
    const manifest = await this.#putObject(
      snapshotUploadObjectKey(this.#creatorId, uploadId, 'manifest'),
      expected.manifest,
      input.manifestObjectBytes,
      'upload',
    );
    return Object.freeze({ archive, manifest });
  }

  async finalizeUpload(input: FinalizeSnapshotUploadInput): Promise<
    Readonly<{
      stored: StoredSnapshotBundle;
      verified: VerifiedSnapshotArchive;
    }>
  > {
    const uploadId = normalizeUploadId(input.uploadId);
    const expected = this.#expectations(input.request);
    const existingArchive = await this.#readFinalForFinalize(expected.archive);
    const existingManifest = await this.#readFinalForFinalize(expected.manifest);
    if (existingArchive !== undefined && existingManifest !== undefined) {
      const stored = Object.freeze({ archive: existingArchive, manifest: existingManifest });
      return Object.freeze({
        stored,
        verified: await this.#verifyBundle(stored, expected, input.keyEnvelope),
      });
    }

    // P0 ordering: both temp objects are read and fully authenticated before either final key is
    // touched. A corrupt temp therefore cannot reserve an immutable content-addressed key.
    const uploadedArchive = await this.#readObject(
      snapshotUploadObjectKey(this.#creatorId, uploadId, 'archive'),
      expected.archive,
      'upload',
    );
    const uploadedManifest = await this.#readObject(
      snapshotUploadObjectKey(this.#creatorId, uploadId, 'manifest'),
      expected.manifest,
      'upload',
    );
    if (uploadedArchive === undefined || uploadedManifest === undefined) {
      fail('SNAPSHOT_OBJECT_NOT_FOUND');
    }
    const uploaded = Object.freeze({ archive: uploadedArchive, manifest: uploadedManifest });
    const verified = await this.#verifyBundle(uploaded, expected, input.keyEnvelope);

    if (
      existingArchive !== undefined &&
      !bytesEqual(existingArchive.encryptedObjectBytes, uploadedArchive.encryptedObjectBytes)
    ) {
      fail('SNAPSHOT_IMMUTABLE_CONFLICT');
    }
    if (
      existingManifest !== undefined &&
      !bytesEqual(existingManifest.encryptedObjectBytes, uploadedManifest.encryptedObjectBytes)
    ) {
      fail('SNAPSHOT_IMMUTABLE_CONFLICT');
    }

    const archive =
      existingArchive ??
      (await this.#putObject(
        expected.archive.finalKey,
        expected.archive,
        uploadedArchive.encryptedObjectBytes,
        'immutable',
      ));
    const manifest =
      existingManifest ??
      (await this.#putObject(
        expected.manifest.finalKey,
        expected.manifest,
        uploadedManifest.encryptedObjectBytes,
        'immutable',
      ));
    return Object.freeze({ stored: Object.freeze({ archive, manifest }), verified });
  }

  async readFinalBundle(
    input: SnapshotUploadCreateRequest,
  ): Promise<StoredSnapshotBundle | undefined> {
    const expected = this.#expectations(input);
    const [archive, manifest] = await Promise.all([
      this.#readObject(expected.archive.finalKey, expected.archive, 'immutable'),
      this.#readObject(expected.manifest.finalKey, expected.manifest, 'immutable'),
    ]);
    if (archive === undefined && manifest === undefined) return undefined;
    if (archive === undefined || manifest === undefined) fail('SNAPSHOT_IMMUTABLE_CONFLICT');
    return Object.freeze({ archive, manifest });
  }

  async readAndVerify(input: ReadAndVerifyStoredSnapshotInput): Promise<
    Readonly<{
      stored: StoredSnapshotBundle;
      verified: VerifiedSnapshotArchive;
    }>
  > {
    const expected = this.#expectations(input.request);
    const stored = await this.readFinalBundle(expected.request);
    if (stored === undefined) fail('SNAPSHOT_OBJECT_NOT_FOUND');
    return Object.freeze({
      stored,
      verified: await this.#verifyBundle(stored, expected, input.keyEnvelope),
    });
  }

  #expectations(input: SnapshotUploadCreateRequest): UploadExpectations {
    const expected = parseUploadRequest(input);
    if (expected.archive.creatorId !== this.#creatorId) fail('SNAPSHOT_OBJECT_INVALID');
    return expected;
  }

  async #signTarget(
    uploadId: string,
    expectation: ObjectExpectation,
    expiresInSeconds: number,
    signingDate: Date,
  ): Promise<SnapshotSignedPutTarget> {
    const requiredHeaders = requiredHeadersFor(expectation);
    const command = new PutObjectCommand({
      Bucket: this.#bucket,
      Key: snapshotUploadObjectKey(this.#creatorId, uploadId, expectation.kind),
      ContentLength: expectation.cipherBytes,
      ContentType: CONTENT_TYPE,
      CacheControl: CACHE_CONTROL,
      ChecksumSHA256: expectation.checksumSha256,
      IfNoneMatch: '*',
      Metadata: metadataFor(expectation, 'upload'),
    });
    let putUrl: string;
    try {
      putUrl = await this.#presigner!.presignPut({
        command,
        requiredHeaders,
        expiresInSeconds,
        signingDate,
      });
    } catch (error) {
      fail('SNAPSHOT_STORAGE_UNAVAILABLE', error);
    }
    return {
      method: 'PUT',
      putUrl,
      cipherBytes: expectation.cipherBytes,
      cipherDigest: expectation.cipherDigest,
      requiredHeaders,
    };
  }

  async #readFinalForFinalize<T extends ObjectExpectation>(
    expectation: T,
  ): Promise<StoredSnapshotCipherObject<T['envelope']> | undefined> {
    try {
      return await this.#readObject(expectation.finalKey, expectation, 'immutable');
    } catch (error) {
      if (isSnapshotError(error, 'SNAPSHOT_OBJECT_INVALID')) {
        fail('SNAPSHOT_IMMUTABLE_CONFLICT');
      }
      throw error;
    }
  }

  async #putObject<T extends ObjectExpectation>(
    key: string,
    expectation: T,
    bytesInput: Uint8Array,
    state: ObjectState,
  ): Promise<StoredSnapshotCipherObject<T['envelope']>> {
    this.#assertObjectBytes(expectation, bytesInput);
    const bytes = Buffer.from(bytesInput);
    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Body: bytes,
          ContentLength: bytes.byteLength,
          ContentType: CONTENT_TYPE,
          CacheControl: CACHE_CONTROL,
          ChecksumSHA256: expectation.checksumSha256,
          IfNoneMatch: '*',
          Metadata: metadataFor(expectation, state),
        }),
      );
    } catch (error) {
      if (!isConditionalConflict(error)) fail('SNAPSHOT_STORAGE_UNAVAILABLE', error);
      const existing = await this.#readObject(key, expectation, state).catch((readError) => {
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
    const stored = await this.#readObject(key, expectation, state);
    if (stored === undefined) fail('SNAPSHOT_STORAGE_UNAVAILABLE');
    return stored;
  }

  #assertObjectBytes(expectation: ObjectExpectation, bytes: Uint8Array): void {
    try {
      if (expectation.kind === 'archive') {
        parseSnapshotArchiveCipherObject(expectation.envelope, bytes);
      } else {
        parseSnapshotManifestCipherObject(expectation.envelope, bytes);
      }
    } catch {
      fail('SNAPSHOT_OBJECT_INVALID');
    }
    if (sha256Base64(bytes) !== expectation.checksumSha256) fail('SNAPSHOT_OBJECT_INVALID');
  }

  async #verifyBundle(
    stored: StoredSnapshotBundle,
    expected: UploadExpectations,
    keyEnvelope: SnapshotDataKeyUnwrapperPort,
  ): Promise<VerifiedSnapshotArchive> {
    const wrappedDek = Buffer.from(expected.archive.envelope.wrappedDek, 'base64url');
    let unwrapped: Uint8Array | undefined;
    let dataKey: Buffer | undefined;
    try {
      try {
        unwrapped = await keyEnvelope.unwrapDataKey({
          context: expected.archive.envelope.aad,
          keyId: expected.archive.envelope.aad.keyId,
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
      const verified = decryptAndVerifySnapshotBundle({
        encryptedManifestBytes: stored.manifest.encryptedObjectBytes,
        manifestEnvelope: expected.manifest.envelope,
        encryptedArchiveBytes: stored.archive.encryptedObjectBytes,
        archiveEnvelope: expected.archive.envelope,
        dataEncryptionKey: dataKey,
      });
      if (
        verified.fileCount !== expected.request.fileCount ||
        verified.expandedBytes !== expected.request.expandedBytes
      ) {
        fail('SNAPSHOT_DIGEST_MISMATCH');
      }
      return verified;
    } finally {
      dataKey?.fill(0);
      unwrapped?.fill(0);
      wrappedDek.fill(0);
    }
  }

  async #readObject<T extends ObjectExpectation>(
    key: string,
    expectation: T,
    state: ObjectState,
  ): Promise<StoredSnapshotCipherObject<T['envelope']> | undefined> {
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

    const maxBytes =
      expectation.kind === 'archive' ? MAX_ENCRYPTED_SNAPSHOT_BYTES : MAX_ENCRYPTED_MANIFEST_BYTES;
    if (
      output.ContentLength !== expectation.cipherBytes ||
      output.ContentLength > maxBytes ||
      output.ContentType !== CONTENT_TYPE ||
      output.CacheControl !== CACHE_CONTROL
    ) {
      fail('SNAPSHOT_OBJECT_INVALID');
    }
    assertExactMetadata(output.Metadata, metadataFor(expectation, state));
    const bytes = await readBoundedBody(output.Body, expectation.cipherBytes);
    this.#assertObjectBytes(expectation, bytes);
    if (
      output.ChecksumSHA256 !== undefined &&
      output.ChecksumSHA256 !== expectation.checksumSha256
    ) {
      fail('SNAPSHOT_OBJECT_INVALID');
    }
    return Object.freeze({
      kind: expectation.kind,
      envelope: expectation.envelope,
      objectKey: key,
      encryptedObjectBytes: bytes,
    }) as StoredSnapshotCipherObject<T['envelope']>;
  }
}
