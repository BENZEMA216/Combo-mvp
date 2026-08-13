import { describe, expect, it } from 'vitest';

import {
  aes256GcmEncrypt,
  decryptSnapshotArchive,
  encryptSnapshotArchive,
  isSnapshotError,
  sha256Hex,
} from '../index.js';

describe('Snapshot envelope encryption primitives', () => {
  it('matches the NIST AES-256-GCM known-answer vector', () => {
    const key = Buffer.alloc(32);
    const nonce = Buffer.alloc(12);
    const plaintext = Buffer.alloc(16);
    const encrypted = aes256GcmEncrypt(plaintext, key, nonce);
    expect(encrypted.ciphertext.toString('hex')).toBe('cea7403d4d606b6e074ec5d3baf39d18');
    expect(encrypted.tag.toString('hex')).toBe('d0d1c8a799996bf0265b98b5d48ab919');
  });

  it('authenticates archive bytes and canonical creator/digest AAD', () => {
    const archive = Buffer.from('synthetic authenticated archive bytes');
    const context = {
      schemaVersion: 1 as const,
      creatorId: 'creator-a',
      snapshotDigest: sha256Hex(Buffer.from('manifest')),
      archiveDigest: sha256Hex(archive),
    };
    const key = Buffer.from('11'.repeat(32), 'hex');
    const nonce = Buffer.from('22'.repeat(12), 'hex');
    const encrypted = encryptSnapshotArchive(archive, context, key, nonce);

    expect(
      decryptSnapshotArchive(encrypted.objectBytes, context, key, encrypted.cipherDigest).equals(
        archive,
      ),
    ).toBe(true);
    expect(encrypted.cipherDigest).toBe(sha256Hex(encrypted.objectBytes));
  });

  it('fails closed for ciphertext, tag, digest, key and AAD mutations', () => {
    const archive = Buffer.from('synthetic authenticated archive bytes');
    const context = {
      schemaVersion: 1 as const,
      creatorId: 'creator-a',
      snapshotDigest: sha256Hex(Buffer.from('manifest')),
      archiveDigest: sha256Hex(archive),
    };
    const key = Buffer.from('11'.repeat(32), 'hex');
    const encrypted = encryptSnapshotArchive(
      archive,
      context,
      key,
      Buffer.from('22'.repeat(12), 'hex'),
    );

    const bitFlips = [20, encrypted.objectBytes.length - 1];
    for (const index of bitFlips) {
      const changed = Buffer.from(encrypted.objectBytes);
      changed[index] = changed[index]! ^ 1;
      expectEncryptionFailure(() =>
        decryptSnapshotArchive(changed, context, key, sha256Hex(changed)),
      );
    }
    expectEncryptionFailure(() =>
      decryptSnapshotArchive(encrypted.objectBytes, context, key, '00'.repeat(32)),
    );
    expectEncryptionFailure(() =>
      decryptSnapshotArchive(
        encrypted.objectBytes,
        context,
        Buffer.from('33'.repeat(32), 'hex'),
        encrypted.cipherDigest,
      ),
    );
    expectEncryptionFailure(() =>
      decryptSnapshotArchive(
        encrypted.objectBytes,
        { ...context, creatorId: 'creator-b' },
        key,
        encrypted.cipherDigest,
      ),
    );
  });

  it('rejects malformed key and nonce lengths', () => {
    expectEncryptionFailure(() =>
      aes256GcmEncrypt(Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(12)),
    );
    expectEncryptionFailure(() =>
      aes256GcmEncrypt(Buffer.alloc(0), Buffer.alloc(32), Buffer.alloc(11)),
    );
  });
});

function expectEncryptionFailure(action: () => unknown): void {
  try {
    action();
    expect.fail('expected authenticated decryption failure');
  } catch (error) {
    expect(isSnapshotError(error, 'SNAPSHOT_ENCRYPTION_INVALID')).toBe(true);
  }
}
