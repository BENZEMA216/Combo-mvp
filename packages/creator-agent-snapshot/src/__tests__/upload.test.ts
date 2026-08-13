import { createHash } from 'node:crypto';
import {
  SnapshotUploadCreateRequestSchema,
  type SnapshotUploadCreateRequest,
} from '@cb/creator-agent-protocol';
import { describe, expect, it } from 'vitest';

import {
  compressDeterministicTar,
  createDeterministicTar,
  createSnapshotManifest,
  decryptAndVerifySnapshotBundle,
  isSnapshotError,
  prepareEncryptedSnapshotUpload,
  sha256Hex,
  snapshotManifestBytes,
  type BuiltSnapshot,
  type SnapshotDataKeyCreationContext,
  type SnapshotDataKeyCreatorPort,
} from '../index.js';

const CREATOR_ID = '0198f00d-6100-7000-8000-000000000001';
const KEY_ID = 'combo-kek/test-2026-08';

function builtSnapshot(): BuiltSnapshot {
  const fileBytes = Buffer.from('# Frozen facts\nmarker=WORKER-UPLOAD-BRIDGE\n');
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
  return Object.freeze({
    manifest,
    manifestBytes,
    archiveBytes,
    snapshotDigest: sha256Hex(manifestBytes),
    archiveDigest: sha256Hex(archiveBytes),
    fileCount: manifest.totals.fileCount,
    expandedBytes: manifest.totals.expandedBytes,
    compressedBytes: archiveBytes.byteLength,
  });
}

function checksum(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('base64');
}

describe('Creator Worker encrypted Snapshot upload preparation', () => {
  it('mints one DEK only after a complete Snapshot and returns two connected cipher objects', async () => {
    const snapshot = builtSnapshot();
    const plaintextKey = Buffer.alloc(32, 0x31);
    const wrappedDek = Buffer.alloc(40, 0x41);
    const unwrapKey = Buffer.from(plaintextKey);
    let creationContext: SnapshotDataKeyCreationContext | undefined;
    const keyEnvelope: SnapshotDataKeyCreatorPort = {
      async createDataKey(context) {
        creationContext = context;
        return { keyId: KEY_ID, wrappedDek, plaintextKey };
      },
    };

    const prepared = await prepareEncryptedSnapshotUpload({
      creatorId: CREATOR_ID,
      snapshot,
      keyEnvelope,
    });
    const request: SnapshotUploadCreateRequest = SnapshotUploadCreateRequestSchema.parse(
      prepared.request,
    );

    expect(creationContext).toEqual({
      creatorId: CREATOR_ID,
      snapshotDigest: snapshot.snapshotDigest,
      archiveDigest: snapshot.archiveDigest,
    });
    expect(request.archive.envelope.cipherBytes).toBe(prepared.archiveObjectBytes.byteLength);
    expect(request.manifest.envelope.cipherBytes).toBe(prepared.manifestObjectBytes.byteLength);
    expect(request.archive.checksumSha256).toBe(checksum(prepared.archiveObjectBytes));
    expect(request.manifest.checksumSha256).toBe(checksum(prepared.manifestObjectBytes));
    expect(request.archive.envelope.nonce).not.toBe(request.manifest.envelope.nonce);
    expect(request.archive.envelope.wrappedDek).toBe(request.manifest.envelope.wrappedDek);
    expect(
      decryptAndVerifySnapshotBundle({
        encryptedManifestBytes: prepared.manifestObjectBytes,
        manifestEnvelope: request.manifest.envelope,
        encryptedArchiveBytes: prepared.archiveObjectBytes,
        archiveEnvelope: request.archive.envelope,
        dataEncryptionKey: unwrapKey,
      }),
    ).toMatchObject({
      snapshotDigest: snapshot.snapshotDigest,
      archiveDigest: snapshot.archiveDigest,
      fileCount: snapshot.fileCount,
      expandedBytes: snapshot.expandedBytes,
    });
    expect(plaintextKey.equals(Buffer.alloc(32))).toBe(true);
    expect(wrappedDek.equals(Buffer.alloc(40))).toBe(true);
  });

  it('rejects an inconsistent built Snapshot before exercising key authority', async () => {
    const snapshot = builtSnapshot();
    let createCalls = 0;
    const keyEnvelope: SnapshotDataKeyCreatorPort = {
      async createDataKey() {
        createCalls += 1;
        return {
          keyId: KEY_ID,
          wrappedDek: Buffer.alloc(40, 1),
          plaintextKey: Buffer.alloc(32, 2),
        };
      },
    };
    await expect(
      prepareEncryptedSnapshotUpload({
        creatorId: CREATOR_ID,
        snapshot: { ...snapshot, archiveDigest: '0'.repeat(64) },
        keyEnvelope,
      }),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_DIGEST_MISMATCH' });
    expect(createCalls).toBe(0);
  });

  it('fails closed and clears provider buffers when key material is malformed', async () => {
    const plaintextKey = Buffer.alloc(31, 0x73);
    const wrappedDek = Buffer.alloc(40, 0x74);
    try {
      await prepareEncryptedSnapshotUpload({
        creatorId: CREATOR_ID,
        snapshot: builtSnapshot(),
        keyEnvelope: {
          async createDataKey() {
            return { keyId: KEY_ID, wrappedDek, plaintextKey };
          },
        },
      });
      expect.fail('expected malformed DEK to fail');
    } catch (error) {
      expect(isSnapshotError(error, 'SNAPSHOT_ENCRYPTION_INVALID')).toBe(true);
      expect(String(error)).not.toContain('secret-provider-detail');
    }
    expect(plaintextKey.equals(Buffer.alloc(31))).toBe(true);
    expect(wrappedDek.equals(Buffer.alloc(40))).toBe(true);
  });
});
