import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptMessage,
  encryptMessage,
  MESSAGE_MAX_PLAINTEXT_BYTES,
  MessageAuthenticationError,
  type MessageAad,
} from './message-crypto.js';

const encryptionKey = Buffer.alloc(32, 0x11);
const digestKey = Buffer.alloc(32, 0x22);

function randomUuidV7(): string {
  const value = randomUUID();
  return `${value.slice(0, 14)}7${value.slice(15)}`;
}

function aad(overrides: Partial<MessageAad> = {}): MessageAad {
  return {
    schemaVersion: 1,
    ownerId: randomUuidV7(),
    conversationId: randomUuidV7(),
    messageId: randomUuidV7(),
    role: 'USER',
    ...overrides,
  };
}

describe('message-level AEAD', () => {
  it('round-trips with deterministic NIST-compatible AES-GCM inputs', () => {
    const binding = aad();
    const encrypted = encryptMessage({
      plaintext: 'only encrypted text belongs in PostgreSQL',
      encryptionKey,
      digestKey,
      keyId: 'kms:test:v1',
      aad: binding,
      nonce: Buffer.alloc(12, 0x33),
    });

    expect(encrypted.algorithm).toBe('aes-256-gcm/v1');
    expect(encrypted.nonce.toString('hex')).toBe('33'.repeat(12));
    expect(encrypted.authTag).toHaveLength(16);
    expect(encrypted.cipherDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(encrypted.contentDigest).toMatch(/^hmac-sha256:[a-f0-9]{64}$/u);
    expect(decryptMessage({ encrypted, encryptionKey, aad: binding })).toBe(
      'only encrypted text belongs in PostgreSQL',
    );
  });

  it('uses independent nonces and ciphertext for the same plaintext', () => {
    const binding = aad();
    const first = encryptMessage({
      plaintext: 'same',
      encryptionKey,
      digestKey,
      keyId: 'kms:test:v1',
      aad: binding,
    });
    const second = encryptMessage({
      plaintext: 'same',
      encryptionKey,
      digestKey,
      keyId: 'kms:test:v1',
      aad: binding,
    });
    expect(second.nonce.equals(first.nonce)).toBe(false);
    expect(second.ciphertext.equals(first.ciphertext)).toBe(false);
    expect(second.cipherDigest).not.toBe(first.cipherDigest);
    expect(second.contentDigest).toBe(first.contentDigest);
  });

  it.each(['ASCII', '你好', '😀', 'A界😀\n'])(
    'keeps AES-GCM ciphertext octets equal to %s UTF-8 plaintext bytes with a separate tag',
    (plaintext) => {
      const encrypted = encryptMessage({
        plaintext,
        encryptionKey,
        digestKey,
        keyId: 'kms:test:v1',
        aad: aad(),
      });
      expect(encrypted.ciphertext.byteLength).toBe(Buffer.byteLength(plaintext, 'utf8'));
      expect(encrypted.authTag).toHaveLength(16);
    },
  );

  it.each([
    ['owner', (binding: MessageAad) => ({ ...binding, ownerId: randomUuidV7() })],
    ['conversation', (binding: MessageAad) => ({ ...binding, conversationId: randomUuidV7() })],
    ['message', (binding: MessageAad) => ({ ...binding, messageId: randomUuidV7() })],
    ['role', (binding: MessageAad) => ({ ...binding, role: 'ASSISTANT' as const })],
  ])('rejects a cross-binding %s swap', (_label, mutate) => {
    const binding = aad();
    const encrypted = encryptMessage({
      plaintext: 'bound',
      encryptionKey,
      digestKey,
      keyId: 'kms:test:v1',
      aad: binding,
      nonce: Buffer.alloc(12, 0x44),
    });
    expect(() => decryptMessage({ encrypted, encryptionKey, aad: mutate(binding) })).toThrow(
      MessageAuthenticationError,
    );
  });

  it.each(['ciphertext', 'authTag', 'nonce', 'cipherDigest'] as const)(
    'rejects a %s bit flip without partial plaintext',
    (field) => {
      const binding = aad();
      const encrypted = encryptMessage({
        plaintext: 'secret result',
        encryptionKey,
        digestKey,
        keyId: 'kms:test:v1',
        aad: binding,
        nonce: Buffer.alloc(12, 0x55),
      });
      const mutated = {
        ...encrypted,
        nonce: Buffer.from(encrypted.nonce),
        ciphertext: Buffer.from(encrypted.ciphertext),
        authTag: Buffer.from(encrypted.authTag),
      };
      if (field === 'cipherDigest') {
        mutated.cipherDigest = `${encrypted.cipherDigest[0] === '0' ? '1' : '0'}${encrypted.cipherDigest.slice(1)}`;
      } else {
        mutated[field][0] ^= 1;
      }
      expect(() => decryptMessage({ encrypted: mutated, encryptionKey, aad: binding })).toThrow(
        MessageAuthenticationError,
      );
    },
  );

  it('rejects the wrong key and unknown input sizes with the same stable auth error', () => {
    const binding = aad();
    const encrypted = encryptMessage({
      plaintext: 'secret result',
      encryptionKey,
      digestKey,
      keyId: 'kms:test:v1',
      aad: binding,
    });
    expect(() =>
      decryptMessage({ encrypted, encryptionKey: Buffer.alloc(32, 0x99), aad: binding }),
    ).toThrow(MessageAuthenticationError);
    expect(() =>
      decryptMessage({ encrypted, encryptionKey: Buffer.alloc(31), aad: binding }),
    ).toThrow(MessageAuthenticationError);
  });

  it('enforces exact UTF-8 message bounds before encryption', () => {
    const binding = aad();
    for (const plaintext of ['', '界'.repeat(Math.ceil(MESSAGE_MAX_PLAINTEXT_BYTES / 3) + 1)]) {
      expect(() =>
        encryptMessage({
          plaintext,
          encryptionKey,
          digestKey,
          keyId: 'kms:test:v1',
          aad: binding,
        }),
      ).toThrow(RangeError);
    }
  });
});
