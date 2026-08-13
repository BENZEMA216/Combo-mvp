import {
  SNAPSHOT_ARCHIVE_OBJECT_FORMAT,
  SNAPSHOT_ENVELOPE_PROTOCOL,
  SNAPSHOT_MANIFEST_ENVELOPE_PROTOCOL,
  SNAPSHOT_MANIFEST_OBJECT_FORMAT,
  SnapshotArchiveEnvelopeSchema,
  snapshotArchiveEnvelopeAadDigest,
  snapshotArchiveObjectKey,
  snapshotManifestEnvelopeAadDigest,
  snapshotManifestObjectKey,
  type SnapshotArchiveEnvelopeAad,
} from '@cb/creator-agent-protocol';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import {
  aes256GcmEncrypt,
  decryptSnapshotArchive,
  decryptSnapshotManifest,
  encryptSnapshotArchive,
  encryptSnapshotManifest,
  isSnapshotError,
  sha256Hex,
} from '../index.js';
import { encryptSnapshotArchiveTestOnly, encryptSnapshotManifestTestOnly } from '../encryption.js';

const CREATOR = '0198f00d-8000-7000-8000-000000000001';
const KEY_ID = 'combo-kek/test-2026-08';
const WRAPPED_DEK = Buffer.alloc(40, 0x44);

function context(archive: Uint8Array): SnapshotArchiveEnvelopeAad {
  const snapshotDigest = sha256Hex(Buffer.from('manifest'));
  return {
    protocol: SNAPSHOT_ENVELOPE_PROTOCOL,
    schemaVersion: 1,
    cipherObjectFormat: SNAPSHOT_ARCHIVE_OBJECT_FORMAT,
    creatorId: CREATOR,
    snapshotDigest,
    archiveDigest: sha256Hex(archive),
    objectKey: snapshotArchiveObjectKey(CREATOR, snapshotDigest),
    plaintextBytes: archive.byteLength,
    keyId: KEY_ID,
  };
}

describe('Snapshot archive envelope encryption primitives', () => {
  it('matches the NIST AES-256-GCM known-answer vector', () => {
    const key = Buffer.alloc(32);
    const nonce = Buffer.alloc(12);
    const plaintext = Buffer.alloc(16);
    const encrypted = aes256GcmEncrypt(plaintext, key, nonce);
    expect(encrypted.ciphertext.toString('hex')).toBe('cea7403d4d606b6e074ec5d3baf39d18');
    expect(encrypted.tag.toString('hex')).toBe('d0d1c8a799996bf0265b98b5d48ab919');
  });

  it('freezes exact binary framing and matches the protocol Envelope golden', async () => {
    const archive = Buffer.from('synthetic authenticated archive bytes');
    const aad = context(archive);
    const key = Buffer.from('11'.repeat(32), 'hex');
    const nonce = Buffer.from('22'.repeat(12), 'hex');
    const encrypted = encryptSnapshotArchiveTestOnly(
      archive,
      aad,
      key,
      { keyId: KEY_ID, wrappedDek: WRAPPED_DEK },
      nonce,
    );

    expect(encrypted.objectBytes.subarray(0, 8).toString('ascii')).toBe('CSNPENC1');
    expect(encrypted.objectBytes.byteLength).toBe(archive.byteLength + 36);
    expect(encrypted.objectBytes.toString('hex')).toBe(
      '43534e50454e4331222222222222222222222222648e693da8aaeb36861fbf493cce8cbb6bfaae831ee4c86b333d6980609700232706df67206eb443833334472f3360b88969f32c39',
    );
    const protocolFixture = SnapshotArchiveEnvelopeSchema.parse(
      JSON.parse(
        await readFile(
          new URL(
            '../../../creator-agent-protocol/fixtures/snapshot-envelope.v1.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ),
    );
    expect(encrypted.envelope).toEqual(protocolFixture);
    expect(encrypted.envelope.cipherDigest).toBe(sha256Hex(encrypted.objectBytes));
    expect(decryptSnapshotArchive(encrypted.objectBytes, encrypted.envelope, key)).toEqual(archive);
  });

  it('production entry creates a fresh CSPRNG nonce for each encrypted object', () => {
    const archive = Buffer.from('same archive');
    const aad = context(archive);
    const key = Buffer.alloc(32, 7);
    const first = encryptSnapshotArchive(archive, aad, key, {
      keyId: KEY_ID,
      wrappedDek: WRAPPED_DEK,
    });
    const second = encryptSnapshotArchive(archive, aad, key, {
      keyId: KEY_ID,
      wrappedDek: WRAPPED_DEK,
    });
    expect(first.envelope.nonce).not.toBe(second.envelope.nonce);
    expect(first.objectBytes).not.toEqual(second.objectBytes);
  });

  it('fails closed for every AAD field and magic nonce ciphertext tag mutation', () => {
    const archive = Buffer.from('synthetic authenticated archive bytes');
    const aad = context(archive);
    const key = Buffer.from('11'.repeat(32), 'hex');
    const encrypted = encryptSnapshotArchiveTestOnly(
      archive,
      aad,
      key,
      { keyId: KEY_ID, wrappedDek: WRAPPED_DEK },
      Buffer.from('22'.repeat(12), 'hex'),
    );

    for (const index of [0, 20]) {
      const changed = Buffer.from(encrypted.objectBytes);
      changed[index] = changed[index]! ^ 1;
      expectEncryptionFailure(() =>
        decryptSnapshotArchive(
          changed,
          { ...encrypted.envelope, cipherDigest: sha256Hex(changed) },
          key,
        ),
      );
    }

    const changedNonce = Buffer.from(encrypted.objectBytes);
    changedNonce[8] = changedNonce[8]! ^ 1;
    expectEncryptionFailure(() =>
      decryptSnapshotArchive(
        changedNonce,
        {
          ...encrypted.envelope,
          nonce: changedNonce.subarray(8, 20).toString('base64url'),
          cipherDigest: sha256Hex(changedNonce),
        },
        key,
      ),
    );
    const changedTag = Buffer.from(encrypted.objectBytes);
    changedTag[changedTag.length - 1] = changedTag[changedTag.length - 1]! ^ 1;
    expectEncryptionFailure(() =>
      decryptSnapshotArchive(
        changedTag,
        {
          ...encrypted.envelope,
          authTag: changedTag.subarray(changedTag.length - 16).toString('base64url'),
          cipherDigest: sha256Hex(changedTag),
        },
        key,
      ),
    );

    const otherCreator = '0198f00d-8000-7000-8000-000000000002';
    const otherSnapshot = 'a'.repeat(64);
    const mutatedAads: ReadonlyArray<readonly [string, SnapshotArchiveEnvelopeAad]> = [
      [
        'creatorId',
        {
          ...aad,
          creatorId: otherCreator,
          objectKey: snapshotArchiveObjectKey(otherCreator, aad.snapshotDigest),
        },
      ],
      [
        'snapshotDigest',
        {
          ...aad,
          snapshotDigest: otherSnapshot,
          objectKey: snapshotArchiveObjectKey(aad.creatorId, otherSnapshot),
        },
      ],
      ['archiveDigest', { ...aad, archiveDigest: 'b'.repeat(64) }],
      ['plaintextBytes', { ...aad, plaintextBytes: aad.plaintextBytes + 1 }],
      ['keyId', { ...aad, keyId: 'combo-kek/other' }],
    ];
    for (const [field, mutatedAad] of mutatedAads) {
      expectEncryptionFailure(
        () =>
          decryptSnapshotArchive(
            encrypted.objectBytes,
            {
              ...encrypted.envelope,
              aad: mutatedAad,
              aadDigest: snapshotArchiveEnvelopeAadDigest(mutatedAad),
              cipherBytes: mutatedAad.plaintextBytes + 36,
            },
            key,
          ),
        field,
      );
    }
    expectEncryptionFailure(() =>
      decryptSnapshotArchive(encrypted.objectBytes, encrypted.envelope, Buffer.alloc(32, 9)),
    );
  });

  it('rejects wrong archive size digest wrap id and malformed key or nonce lengths', () => {
    const archive = Buffer.from('archive');
    const aad = context(archive);
    const key = Buffer.alloc(32, 1);
    expectEncryptionFailure(() =>
      encryptSnapshotArchive(Buffer.concat([archive, Buffer.from('x')]), aad, key, {
        keyId: KEY_ID,
        wrappedDek: WRAPPED_DEK,
      }),
    );
    expectEncryptionFailure(() =>
      encryptSnapshotArchive(archive, aad, key, {
        keyId: 'other-key',
        wrappedDek: WRAPPED_DEK,
      }),
    );
    expectEncryptionFailure(() =>
      encryptSnapshotArchive(archive, aad, key, {
        keyId: KEY_ID,
        wrappedDek: Buffer.alloc(39),
      }),
    );
    expectEncryptionFailure(() => encryptSnapshotArchive(archive, aad, key, undefined as never));
    expectEncryptionFailure(() =>
      aes256GcmEncrypt(Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(12)),
    );
    expectEncryptionFailure(() =>
      aes256GcmEncrypt(Buffer.alloc(0), Buffer.alloc(32), Buffer.alloc(11)),
    );
  });
});

describe('Snapshot manifest envelope encryption primitives', () => {
  it('uses a separate Envelope, magic and nonce while binding canonical manifest bytes', () => {
    const manifestBytes = Buffer.from('{"protocol":"synthetic-manifest"}');
    const snapshotDigest = sha256Hex(manifestBytes);
    const key = Buffer.alloc(32, 0x33);
    const archiveNonce = Buffer.alloc(12, 0x44);
    const manifestNonce = Buffer.alloc(12, 0x55);
    const encrypted = encryptSnapshotManifestTestOnly(
      manifestBytes,
      {
        protocol: SNAPSHOT_MANIFEST_ENVELOPE_PROTOCOL,
        schemaVersion: 1,
        cipherObjectFormat: SNAPSHOT_MANIFEST_OBJECT_FORMAT,
        creatorId: CREATOR,
        snapshotDigest,
        objectKey: snapshotManifestObjectKey(CREATOR, snapshotDigest),
        plaintextBytes: manifestBytes.byteLength,
        keyId: KEY_ID,
      },
      key,
      { keyId: KEY_ID, wrappedDek: WRAPPED_DEK },
      manifestNonce,
    );
    expect(encrypted.objectBytes.subarray(0, 8).toString('ascii')).toBe('CSNPMAN1');
    expect(encrypted.envelope.nonce).not.toBe(archiveNonce.toString('base64url'));
    expect(encrypted.objectBytes.byteLength).toBe(manifestBytes.byteLength + 36);
    expect(decryptSnapshotManifest(encrypted.objectBytes, encrypted.envelope, key)).toEqual(
      manifestBytes,
    );
  });

  it('uses independent production nonces and rejects ciphertext/tag/AAD mutation', () => {
    const manifestBytes = Buffer.from('{"protocol":"synthetic-manifest"}');
    const snapshotDigest = sha256Hex(manifestBytes);
    const aad = {
      protocol: SNAPSHOT_MANIFEST_ENVELOPE_PROTOCOL,
      schemaVersion: 1 as const,
      cipherObjectFormat: SNAPSHOT_MANIFEST_OBJECT_FORMAT,
      creatorId: CREATOR,
      snapshotDigest,
      objectKey: snapshotManifestObjectKey(CREATOR, snapshotDigest),
      plaintextBytes: manifestBytes.byteLength,
      keyId: KEY_ID,
    };
    const key = Buffer.alloc(32, 0x66);
    const first = encryptSnapshotManifest(manifestBytes, aad, key, {
      keyId: KEY_ID,
      wrappedDek: WRAPPED_DEK,
    });
    const second = encryptSnapshotManifest(manifestBytes, aad, key, {
      keyId: KEY_ID,
      wrappedDek: WRAPPED_DEK,
    });
    expect(first.envelope.nonce).not.toBe(second.envelope.nonce);

    const mutated = Buffer.from(first.objectBytes);
    mutated[20] = mutated[20]! ^ 1;
    expectEncryptionFailure(() =>
      decryptSnapshotManifest(
        mutated,
        { ...first.envelope, cipherDigest: sha256Hex(mutated) },
        key,
      ),
    );
    expectEncryptionFailure(() =>
      decryptSnapshotManifest(
        first.objectBytes,
        {
          ...first.envelope,
          aad: { ...first.envelope.aad, keyId: 'other-key' },
          aadDigest: snapshotManifestEnvelopeAadDigest({
            ...first.envelope.aad,
            keyId: 'other-key',
          }),
        },
        key,
      ),
    );
  });
});

function expectEncryptionFailure(action: () => unknown, marker = 'mutation'): void {
  try {
    action();
    expect.fail('expected authenticated decryption failure');
  } catch (error) {
    expect(isSnapshotError(error, 'SNAPSHOT_ENCRYPTION_INVALID'), marker).toBe(true);
  }
}
