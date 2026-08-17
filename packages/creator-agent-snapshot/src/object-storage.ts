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
  SNAPSHOT_MAX_COMPRESSED_BYTES,
  SNAPSHOT_MAX_MANIFEST_BYTES,
  SNAPSHOT_MAX_PUBLICATION_MARKER_BYTES,
  SNAPSHOT_OBJECT_STORAGE_PROTOCOL,
  SNAPSHOT_PUBLICATION_COMMIT_PROTOCOL,
  SNAPSHOT_PUBLICATION_PREPARATION_PROTOCOL,
  SnapshotPublicationCommitMarkerSchema,
  SnapshotPublicationPreparationMarkerSchema,
  SnapshotUploadCreateRequestSchema,
  SnapshotUploadCreateResponseSchema,
  UuidSchema,
  canonicalizeJson,
  parseSnapshotPublicationCommitMarker,
  parseSnapshotPublicationPreparationMarker,
  parseSnapshotArchiveCipherObject,
  parseSnapshotManifestCipherObject,
  snapshotArchiveObjectKey,
  snapshotManifestObjectKey,
  snapshotPublicationCommitMarkerBytes,
  snapshotPublicationCommitObjectKey,
  snapshotPublicationPreparationMarkerBytes,
  snapshotPublicationPreparationObjectKey,
  type SnapshotArchiveEnvelope,
  type SnapshotManifestEnvelope,
  type SnapshotPublicationCommitMarker,
  type SnapshotPublicationPreparationMarker,
  type SnapshotSignedPutTarget,
  type SnapshotUploadCreateRequest,
  type SnapshotUploadCreateResponse,
} from '@cb/creator-agent-protocol';

import {
  decryptSnapshotArchive,
  decryptSnapshotManifest,
  recreatePreparedSnapshotArchiveCipherObject,
  recreatePreparedSnapshotManifestCipherObject,
  type SnapshotDataKeyUnwrapperPort,
} from './encryption.js';
import { fail, isSnapshotError } from './errors.js';
import { verifySnapshotArchive, type VerifiedSnapshotArchive } from './snapshot.js';

export { SNAPSHOT_OBJECT_STORAGE_PROTOCOL };

const SNAPSHOT_ENCRYPTED_FRAMING_BYTES = 36;
export const MAX_ENCRYPTED_SNAPSHOT_BYTES =
  SNAPSHOT_MAX_COMPRESSED_BYTES + SNAPSHOT_ENCRYPTED_FRAMING_BYTES;
export const MAX_ENCRYPTED_MANIFEST_BYTES =
  SNAPSHOT_MAX_MANIFEST_BYTES + SNAPSHOT_ENCRYPTED_FRAMING_BYTES;
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

type VerifiedSnapshotMaterial = Readonly<{
  verified: VerifiedSnapshotArchive;
  archiveBytes: Buffer;
  manifestBytes: Buffer;
}>;

type PreparedPublication = Readonly<{
  marker: SnapshotPublicationPreparationMarker;
  markerBytes: Buffer;
  markerDigest: string;
  expected: UploadExpectations;
}>;

type CommittedPublication = Readonly<{
  commit: SnapshotPublicationCommitMarker;
  preparation: PreparedPublication;
  stored: StoredSnapshotBundle;
}>;

type CommittedPublicationAuthority = Omit<CommittedPublication, 'stored'>;

type PublicationMarkerKind = 'preparation' | 'commit';
type PublicationIdentity = Readonly<{ creatorId: string; snapshotDigest: string }>;

const REQUIRED_METADATA_KEYS = [
  'archive-digest',
  'cipher-bytes',
  'cipher-digest',
  'object-kind',
  'object-state',
  'protocol',
  'snapshot-digest',
] as const;

const REQUIRED_MARKER_METADATA_KEYS = [
  'body-bytes',
  'body-digest',
  'creator-id',
  'marker-kind',
  'protocol',
  'snapshot-digest',
] as const;
const MARKER_CONTENT_TYPE = 'application/json';

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

export function snapshotPublicationPreparationKey(
  creatorId: string,
  snapshotDigest: string,
): string {
  try {
    return snapshotPublicationPreparationObjectKey(creatorId, snapshotDigest);
  } catch {
    fail('SNAPSHOT_OBJECT_INVALID');
  }
}

export function snapshotPublicationCommitKey(creatorId: string, snapshotDigest: string): string {
  try {
    return snapshotPublicationCommitObjectKey(creatorId, snapshotDigest);
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

function markerMetadata(input: {
  kind: PublicationMarkerKind;
  protocol:
    | typeof SNAPSHOT_PUBLICATION_PREPARATION_PROTOCOL
    | typeof SNAPSHOT_PUBLICATION_COMMIT_PROTOCOL;
  creatorId: string;
  snapshotDigest: string;
  bytes: Uint8Array;
}): SnapshotMetadata {
  return {
    protocol: input.protocol,
    'marker-kind': input.kind,
    'creator-id': input.creatorId,
    'snapshot-digest': input.snapshotDigest,
    'body-digest': sha256Hex(input.bytes),
    'body-bytes': String(input.bytes.byteLength),
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

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
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

function assertExactMarkerMetadata(
  actualInput: Record<string, string> | undefined,
  expected: SnapshotMetadata,
): void {
  const actual = actualInput ?? {};
  const actualKeys = Object.keys(actual).sort();
  if (
    actualKeys.length !== REQUIRED_MARKER_METADATA_KEYS.length ||
    actualKeys.some((key, index) => key !== REQUIRED_MARKER_METADATA_KEYS[index]) ||
    REQUIRED_MARKER_METADATA_KEYS.some((key) => actual[key] !== expected[key])
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
    const requested = this.#expectations(input.request);
    let currentCandidate:
      | Readonly<{ stored: StoredSnapshotBundle; material: VerifiedSnapshotMaterial }>
      | undefined;
    const loadCurrentCandidate = async () => {
      if (currentCandidate !== undefined) return currentCandidate;
      const stored = await this.#readUploadBundle(uploadId, requested);
      currentCandidate = Object.freeze({
        stored,
        material: await this.#verifyBundleMaterial(stored, requested, input.keyEnvelope),
      });
      return currentCandidate;
    };

    try {
      const committedAuthority = await this.#readCommittedAuthority(requested);
      let preparation: PreparedPublication;
      if (committedAuthority !== undefined) {
        preparation = committedAuthority.preparation;
        if (!this.#sameCipherSelection(requested, preparation.expected)) {
          await loadCurrentCandidate();
        }
      } else {
        const existingPreparation = await this.#readPreparation(requested);
        if (existingPreparation === undefined) {
          // Legacy-marker backfill is allowed only for an exact, fully verified pair. A mismatched
          // pre-marker final blocks before a permanent preparation decision is written.
          const legacyArchive = await this.#readFinalForFinalize(requested.archive);
          const legacyManifest = await this.#readFinalForFinalize(requested.manifest);
          if (legacyArchive !== undefined && legacyManifest !== undefined) {
            const stored = Object.freeze({ archive: legacyArchive, manifest: legacyManifest });
            currentCandidate = Object.freeze({
              stored,
              material: await this.#verifyBundleMaterial(stored, requested, input.keyEnvelope),
            });
          } else {
            await loadCurrentCandidate();
          }
          preparation = await this.#putPreparation({
            protocol: SNAPSHOT_PUBLICATION_PREPARATION_PROTOCOL,
            schemaVersion: 1,
            creatorId: this.#creatorId,
            snapshotDigest: requested.archive.snapshotDigest,
            selectedUploadId: uploadId,
            request: requested.request,
          });
        } else {
          preparation = existingPreparation;
        }
      }

      this.#assertSamePlaintextIdentity(requested, preparation.expected);
      if (!this.#sameCipherSelection(requested, preparation.expected)) {
        await loadCurrentCandidate();
      }

      let archive = await this.#readFinalForFinalize(preparation.expected.archive);
      let manifest = await this.#readFinalForFinalize(preparation.expected.manifest);
      let archivePromotionBytes: Uint8Array | undefined;
      let manifestPromotionBytes: Uint8Array | undefined;

      if (archive === undefined || manifest === undefined) {
        const selectedArchive =
          archive ??
          (await this.#readRecoverableUploadObject(
            snapshotUploadObjectKey(
              this.#creatorId,
              preparation.marker.selectedUploadId,
              'archive',
            ),
            preparation.expected.archive,
          ));
        const selectedManifest =
          manifest ??
          (await this.#readRecoverableUploadObject(
            snapshotUploadObjectKey(
              this.#creatorId,
              preparation.marker.selectedUploadId,
              'manifest',
            ),
            preparation.expected.manifest,
          ));

        if (selectedArchive !== undefined && selectedManifest !== undefined) {
          const selected = Object.freeze({
            archive: selectedArchive,
            manifest: selectedManifest,
          });
          const selectedMaterial = await this.#verifyBundleMaterial(
            selected,
            preparation.expected,
            input.keyEnvelope,
          );
          this.#zeroMaterial(selectedMaterial);
          archivePromotionBytes = selectedArchive.encryptedObjectBytes;
          manifestPromotionBytes = selectedManifest.encryptedObjectBytes;
        } else {
          const replacement = await loadCurrentCandidate();
          this.#assertSamePlaintextIdentity(requested, preparation.expected);
          if (this.#sameCipherSelection(requested, preparation.expected)) {
            archivePromotionBytes = replacement.stored.archive.encryptedObjectBytes;
            manifestPromotionBytes = replacement.stored.manifest.encryptedObjectBytes;
          } else {
            const recreated = await this.#recreatePreparedCipherBundle(
              replacement.material,
              preparation.expected,
              input.keyEnvelope,
            );
            archivePromotionBytes = recreated.archive;
            manifestPromotionBytes = recreated.manifest;
          }
        }

        archive ??= await this.#putObject(
          preparation.expected.archive.finalKey,
          preparation.expected.archive,
          archivePromotionBytes,
          'immutable',
        );
        manifest ??= await this.#putObject(
          preparation.expected.manifest.finalKey,
          preparation.expected.manifest,
          manifestPromotionBytes,
          'immutable',
        );
      }

      const stored = Object.freeze({ archive, manifest });
      const verified = await this.#verifyBundle(stored, preparation.expected, input.keyEnvelope);
      if (committedAuthority === undefined) {
        await this.#putCommit({
          protocol: SNAPSHOT_PUBLICATION_COMMIT_PROTOCOL,
          schemaVersion: 1,
          creatorId: this.#creatorId,
          snapshotDigest: preparation.expected.archive.snapshotDigest,
          preparationKey: snapshotPublicationPreparationObjectKey(
            this.#creatorId,
            preparation.expected.archive.snapshotDigest,
          ),
          preparationDigest: preparation.markerDigest,
        });
      }
      return Object.freeze({ stored, verified });
    } finally {
      if (currentCandidate !== undefined) this.#zeroMaterial(currentCandidate.material);
    }
  }

  async readFinalBundle(
    input: SnapshotUploadCreateRequest,
  ): Promise<StoredSnapshotBundle | undefined> {
    const expected = this.#expectations(input);
    return (await this.#readCommittedPublication(expected))?.stored;
  }

  async readAndVerify(input: ReadAndVerifyStoredSnapshotInput): Promise<
    Readonly<{
      stored: StoredSnapshotBundle;
      verified: VerifiedSnapshotArchive;
    }>
  > {
    const expected = this.#expectations(input.request);
    const committed = await this.#readCommittedPublication(expected);
    if (committed === undefined) fail('SNAPSHOT_OBJECT_NOT_FOUND');
    return Object.freeze({
      stored: committed.stored,
      verified: await this.#verifyBundle(
        committed.stored,
        committed.preparation.expected,
        input.keyEnvelope,
      ),
    });
  }

  #expectations(input: SnapshotUploadCreateRequest): UploadExpectations {
    const expected = parseUploadRequest(input);
    if (expected.archive.creatorId !== this.#creatorId) fail('SNAPSHOT_OBJECT_INVALID');
    return expected;
  }

  #sameCipherSelection(left: UploadExpectations, right: UploadExpectations): boolean {
    return canonicalizeJson(left.request) === canonicalizeJson(right.request);
  }

  #assertSamePlaintextIdentity(left: UploadExpectations, right: UploadExpectations): void {
    if (
      left.archive.creatorId !== right.archive.creatorId ||
      left.archive.snapshotDigest !== right.archive.snapshotDigest ||
      left.archive.archiveDigest !== right.archive.archiveDigest ||
      left.archive.envelope.aad.plaintextBytes !== right.archive.envelope.aad.plaintextBytes ||
      left.manifest.envelope.aad.plaintextBytes !== right.manifest.envelope.aad.plaintextBytes ||
      left.request.fileCount !== right.request.fileCount ||
      left.request.expandedBytes !== right.request.expandedBytes
    ) {
      fail('SNAPSHOT_IMMUTABLE_CONFLICT');
    }
  }

  #zeroMaterial(material: VerifiedSnapshotMaterial): void {
    material.archiveBytes.fill(0);
    material.manifestBytes.fill(0);
  }

  async #readUploadBundle(
    uploadId: string,
    expected: UploadExpectations,
  ): Promise<StoredSnapshotBundle> {
    const [archive, manifest] = await Promise.all([
      this.#readObject(
        snapshotUploadObjectKey(this.#creatorId, uploadId, 'archive'),
        expected.archive,
        'upload',
      ),
      this.#readObject(
        snapshotUploadObjectKey(this.#creatorId, uploadId, 'manifest'),
        expected.manifest,
        'upload',
      ),
    ]);
    if (archive === undefined || manifest === undefined) fail('SNAPSHOT_OBJECT_NOT_FOUND');
    return Object.freeze({ archive, manifest });
  }

  async #readRecoverableUploadObject<T extends ObjectExpectation>(
    key: string,
    expectation: T,
  ): Promise<StoredSnapshotCipherObject<T['envelope']> | undefined> {
    try {
      return await this.#readObject(key, expectation, 'upload');
    } catch (error) {
      // A frozen preparation remains authoritative even when its selected temp suffers bit rot.
      // Treat only a proven-invalid temp as unavailable so a separately authenticated replacement
      // can reconstruct the exact prepared cipher. Storage outages still propagate.
      if (isSnapshotError(error, 'SNAPSHOT_OBJECT_INVALID')) return undefined;
      throw error;
    }
  }

  async #readPreparation(expected: UploadExpectations): Promise<PreparedPublication | undefined> {
    const key = snapshotPublicationPreparationObjectKey(
      this.#creatorId,
      expected.archive.snapshotDigest,
    );
    const bytes = await this.#readMarkerBytes({
      key,
      kind: 'preparation',
      protocol: SNAPSHOT_PUBLICATION_PREPARATION_PROTOCOL,
      creatorId: this.#creatorId,
      snapshotDigest: expected.archive.snapshotDigest,
    });
    if (bytes === undefined) return undefined;
    let marker: SnapshotPublicationPreparationMarker;
    try {
      marker = parseSnapshotPublicationPreparationMarker(bytes);
    } catch {
      fail('SNAPSHOT_OBJECT_INVALID');
    }
    if (
      marker.creatorId !== this.#creatorId ||
      marker.snapshotDigest !== expected.archive.snapshotDigest
    ) {
      fail('SNAPSHOT_OBJECT_INVALID');
    }
    return Object.freeze({
      marker,
      markerBytes: bytes,
      markerDigest: sha256Hex(bytes),
      expected: this.#expectations(marker.request),
    });
  }

  async #putPreparation(input: SnapshotPublicationPreparationMarker): Promise<PreparedPublication> {
    let marker: SnapshotPublicationPreparationMarker;
    let bytes: Buffer;
    try {
      marker = SnapshotPublicationPreparationMarkerSchema.parse(input);
      bytes = snapshotPublicationPreparationMarkerBytes(marker);
    } catch {
      fail('SNAPSHOT_OBJECT_INVALID');
    }
    const expected = this.#expectations(marker.request);
    if (
      marker.creatorId !== this.#creatorId ||
      marker.snapshotDigest !== expected.archive.snapshotDigest
    ) {
      fail('SNAPSHOT_OBJECT_INVALID');
    }
    const key = snapshotPublicationPreparationObjectKey(this.#creatorId, marker.snapshotDigest);
    let putError: unknown;
    try {
      await this.#putMarkerBytes({
        key,
        bytes,
        kind: 'preparation',
        protocol: SNAPSHOT_PUBLICATION_PREPARATION_PROTOCOL,
        creatorId: this.#creatorId,
        snapshotDigest: marker.snapshotDigest,
      });
    } catch (error) {
      putError = error;
    }
    const observed = await this.#readPreparation(expected).catch((readError) => {
      if (putError !== undefined) throw putError;
      throw readError;
    });
    if (observed === undefined) {
      if (putError !== undefined) throw putError;
      fail('SNAPSHOT_STORAGE_UNAVAILABLE');
    }
    return observed;
  }

  async #readCommit(
    identity: PublicationIdentity,
  ): Promise<SnapshotPublicationCommitMarker | undefined> {
    const key = snapshotPublicationCommitObjectKey(this.#creatorId, identity.snapshotDigest);
    const bytes = await this.#readMarkerBytes({
      key,
      kind: 'commit',
      protocol: SNAPSHOT_PUBLICATION_COMMIT_PROTOCOL,
      creatorId: this.#creatorId,
      snapshotDigest: identity.snapshotDigest,
    });
    if (bytes === undefined) return undefined;
    let marker: SnapshotPublicationCommitMarker;
    try {
      marker = parseSnapshotPublicationCommitMarker(bytes);
    } catch {
      fail('SNAPSHOT_OBJECT_INVALID');
    }
    if (
      marker.creatorId !== this.#creatorId ||
      marker.snapshotDigest !== identity.snapshotDigest ||
      identity.creatorId !== this.#creatorId
    ) {
      fail('SNAPSHOT_OBJECT_INVALID');
    }
    return marker;
  }

  async #putCommit(input: SnapshotPublicationCommitMarker): Promise<void> {
    let marker: SnapshotPublicationCommitMarker;
    let bytes: Buffer;
    try {
      marker = SnapshotPublicationCommitMarkerSchema.parse(input);
      bytes = snapshotPublicationCommitMarkerBytes(marker);
    } catch {
      fail('SNAPSHOT_OBJECT_INVALID');
    }
    if (marker.creatorId !== this.#creatorId) fail('SNAPSHOT_OBJECT_INVALID');
    let putError: unknown;
    try {
      await this.#putMarkerBytes({
        key: snapshotPublicationCommitObjectKey(marker.creatorId, marker.snapshotDigest),
        bytes,
        kind: 'commit',
        protocol: SNAPSHOT_PUBLICATION_COMMIT_PROTOCOL,
        creatorId: marker.creatorId,
        snapshotDigest: marker.snapshotDigest,
      });
    } catch (error) {
      putError = error;
    }
    const observed = await this.#readCommit({
      creatorId: marker.creatorId,
      snapshotDigest: marker.snapshotDigest,
    }).catch((readError) => {
      if (putError !== undefined) throw putError;
      throw readError;
    });
    if (observed === undefined) {
      if (putError !== undefined) throw putError;
      fail('SNAPSHOT_STORAGE_UNAVAILABLE');
    }
    if (canonicalizeJson(observed) !== canonicalizeJson(marker)) {
      fail('SNAPSHOT_IMMUTABLE_CONFLICT');
    }
  }

  async #readCommittedAuthority(
    expected: UploadExpectations,
  ): Promise<CommittedPublicationAuthority | undefined> {
    const commit = await this.#readCommit({
      creatorId: expected.archive.creatorId,
      snapshotDigest: expected.archive.snapshotDigest,
    });
    if (commit === undefined) return undefined;
    const preparation = await this.#readPreparation(expected);
    if (
      preparation === undefined ||
      commit.preparationKey !==
        snapshotPublicationPreparationObjectKey(this.#creatorId, expected.archive.snapshotDigest) ||
      commit.preparationDigest !== preparation.markerDigest
    ) {
      fail('SNAPSHOT_IMMUTABLE_CONFLICT');
    }
    this.#assertSamePlaintextIdentity(expected, preparation.expected);
    return Object.freeze({ commit, preparation });
  }

  async #readCommittedPublication(
    expected: UploadExpectations,
  ): Promise<CommittedPublication | undefined> {
    const authority = await this.#readCommittedAuthority(expected);
    if (authority === undefined) return undefined;
    const [archive, manifest] = await Promise.all([
      this.#readObject(
        authority.preparation.expected.archive.finalKey,
        authority.preparation.expected.archive,
        'immutable',
      ),
      this.#readObject(
        authority.preparation.expected.manifest.finalKey,
        authority.preparation.expected.manifest,
        'immutable',
      ),
    ]);
    if (archive === undefined || manifest === undefined) fail('SNAPSHOT_IMMUTABLE_CONFLICT');
    return Object.freeze({
      ...authority,
      stored: Object.freeze({ archive, manifest }),
    });
  }

  async #putMarkerBytes(input: {
    key: string;
    bytes: Buffer;
    kind: PublicationMarkerKind;
    protocol:
      | typeof SNAPSHOT_PUBLICATION_PREPARATION_PROTOCOL
      | typeof SNAPSHOT_PUBLICATION_COMMIT_PROTOCOL;
    creatorId: string;
    snapshotDigest: string;
  }): Promise<void> {
    const metadata = markerMetadata(input);
    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: input.key,
          Body: input.bytes,
          ContentLength: input.bytes.byteLength,
          ContentType: MARKER_CONTENT_TYPE,
          CacheControl: CACHE_CONTROL,
          ChecksumSHA256: sha256Base64(input.bytes),
          IfNoneMatch: '*',
          Metadata: metadata,
        }),
      );
    } catch (error) {
      if (isConditionalConflict(error)) return;
      fail('SNAPSHOT_STORAGE_UNAVAILABLE', error);
    }
  }

  async #readMarkerBytes(input: {
    key: string;
    kind: PublicationMarkerKind;
    protocol:
      | typeof SNAPSHOT_PUBLICATION_PREPARATION_PROTOCOL
      | typeof SNAPSHOT_PUBLICATION_COMMIT_PROTOCOL;
    creatorId: string;
    snapshotDigest: string;
  }): Promise<Buffer | undefined> {
    let output: GetObjectCommandOutput;
    try {
      output = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: input.key, ChecksumMode: 'ENABLED' }),
      );
    } catch (error) {
      if (isMissingObject(error)) return undefined;
      fail('SNAPSHOT_STORAGE_UNAVAILABLE', error);
    }
    if (
      output.ContentLength === undefined ||
      !Number.isSafeInteger(output.ContentLength) ||
      output.ContentLength < 1 ||
      output.ContentLength > SNAPSHOT_MAX_PUBLICATION_MARKER_BYTES ||
      output.ContentType !== MARKER_CONTENT_TYPE ||
      output.CacheControl !== CACHE_CONTROL
    ) {
      fail('SNAPSHOT_OBJECT_INVALID');
    }
    const bytes = await readBoundedBody(output.Body, output.ContentLength);
    if (bytes.byteLength !== output.ContentLength) fail('SNAPSHOT_OBJECT_INVALID');
    assertExactMarkerMetadata(output.Metadata, markerMetadata({ ...input, bytes }));
    if (output.ChecksumSHA256 !== sha256Base64(bytes)) fail('SNAPSHOT_OBJECT_INVALID');
    return bytes;
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
    const material = await this.#verifyBundleMaterial(stored, expected, keyEnvelope);
    try {
      return material.verified;
    } finally {
      this.#zeroMaterial(material);
    }
  }

  async #verifyBundleMaterial(
    stored: StoredSnapshotBundle,
    expected: UploadExpectations,
    keyEnvelope: SnapshotDataKeyUnwrapperPort,
  ): Promise<VerifiedSnapshotMaterial> {
    return this.#withUnwrappedDataKey(expected, keyEnvelope, (dataKey) => {
      let manifestBytes: Buffer | undefined;
      let archiveBytes: Buffer | undefined;
      try {
        // Both stored cipher objects passed whole-object framing/digest/metadata validation before
        // unwrap. Neither authenticated plaintext enters a parser until both AEAD tags succeed.
        manifestBytes = decryptSnapshotManifest(
          stored.manifest.encryptedObjectBytes,
          expected.manifest.envelope,
          dataKey,
        );
        archiveBytes = decryptSnapshotArchive(
          stored.archive.encryptedObjectBytes,
          expected.archive.envelope,
          dataKey,
        );
        const verified = verifySnapshotArchive({
          manifestBytes,
          archiveBytes,
          expectedSnapshotDigest: expected.archive.snapshotDigest,
          expectedArchiveDigest: expected.archive.archiveDigest,
        });
        if (
          verified.fileCount !== expected.request.fileCount ||
          verified.expandedBytes !== expected.request.expandedBytes ||
          verified.compressedBytes !== expected.archive.envelope.aad.plaintextBytes ||
          manifestBytes.byteLength !== expected.manifest.envelope.aad.plaintextBytes
        ) {
          fail('SNAPSHOT_DIGEST_MISMATCH');
        }
        return Object.freeze({ verified, manifestBytes, archiveBytes });
      } catch (error) {
        archiveBytes?.fill(0);
        manifestBytes?.fill(0);
        throw error;
      }
    });
  }

  async #recreatePreparedCipherBundle(
    replacement: VerifiedSnapshotMaterial,
    prepared: UploadExpectations,
    keyEnvelope: SnapshotDataKeyUnwrapperPort,
  ): Promise<Readonly<{ archive: Buffer; manifest: Buffer }>> {
    if (
      replacement.verified.snapshotDigest !== prepared.archive.snapshotDigest ||
      replacement.verified.archiveDigest !== prepared.archive.archiveDigest ||
      replacement.verified.compressedBytes !== prepared.archive.envelope.aad.plaintextBytes ||
      replacement.manifestBytes.byteLength !== prepared.manifest.envelope.aad.plaintextBytes ||
      replacement.verified.fileCount !== prepared.request.fileCount ||
      replacement.verified.expandedBytes !== prepared.request.expandedBytes
    ) {
      fail('SNAPSHOT_IMMUTABLE_CONFLICT');
    }
    return this.#withUnwrappedDataKey(prepared, keyEnvelope, (dataKey) => {
      const archive = recreatePreparedSnapshotArchiveCipherObject(
        replacement.archiveBytes,
        prepared.archive.envelope,
        dataKey,
      );
      const manifest = recreatePreparedSnapshotManifestCipherObject(
        replacement.manifestBytes,
        prepared.manifest.envelope,
        dataKey,
      );
      this.#assertObjectBytes(prepared.archive, archive);
      this.#assertObjectBytes(prepared.manifest, manifest);
      return Object.freeze({ archive, manifest });
    });
  }

  async #withUnwrappedDataKey<T>(
    expected: UploadExpectations,
    keyEnvelope: SnapshotDataKeyUnwrapperPort,
    use: (dataKey: Buffer) => T | Promise<T>,
  ): Promise<T> {
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
      return await use(dataKey);
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
