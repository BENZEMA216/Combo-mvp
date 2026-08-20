import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as publicApi from './index.js';
import {
  decryptMessageWithRawKeyForTest as decryptMessage,
  encryptMessageWithRawKeyForTest as encryptMessage,
  MESSAGE_MAX_PLAINTEXT_BYTES,
  MessageAuthenticationError,
  MessageKeyUnavailableError,
  openMessageWithKeyAuthority,
  sealMessageWithKeyAuthority,
  verifyMessageContentDigestWithRawKeyForTest,
  type EncryptedMessage,
  type MessageAad,
  type MessageKeyAuthority,
  type MessageKeyOpenOutcome,
  type MessageKeyOpenRequest,
  type MessageKeySealOutcome,
  type MessageKeySealRequest,
  type MessageKeySecurityAlert,
  type MessageKeySecurityAlertSink,
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
  it('keeps raw-key crypto helpers outside the production package root', () => {
    expect(publicApi).not.toHaveProperty('encryptMessageWithRawKeyForTest');
    expect(publicApi).not.toHaveProperty('decryptMessageWithRawKeyForTest');
    expect(publicApi).not.toHaveProperty('verifyMessageContentDigestWithRawKeyForTest');
    expect(publicApi).toHaveProperty('sealMessageWithKeyAuthority');
    expect(publicApi).toHaveProperty('openMessageWithKeyAuthority');
  });

  it('round-trips with production CSPRNG AES-GCM inputs', () => {
    const binding = aad();
    const encrypted = encryptMessage({
      plaintext: 'only encrypted text belongs in PostgreSQL',
      encryptionKey,
      digestKey,
      keyId: 'kms:test:v1',
      aad: binding,
    });

    expect(encrypted.algorithm).toBe('aes-256-gcm/v1');
    expect(encrypted.nonce).toHaveLength(12);
    expect(encrypted.authTag).toHaveLength(16);
    expect(encrypted.cipherDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(encrypted.contentDigest).toMatch(/^hmac-sha256:[a-f0-9]{64}$/u);
    expect(decryptMessage({ encrypted, encryptionKey, aad: binding })).toBe(
      'only encrypted text belongs in PostgreSQL',
    );
  });

  it('uses independent nonces and ciphertext for the same plaintext', () => {
    const firstBinding = aad();
    const secondBinding = { ...firstBinding, messageId: randomUuidV7() };
    const first = encryptMessage({
      plaintext: 'same',
      encryptionKey,
      digestKey,
      keyId: 'kms:test:v1',
      aad: firstBinding,
    });
    const second = encryptMessage({
      plaintext: 'same',
      encryptionKey,
      digestKey,
      keyId: 'kms:test:v1',
      aad: secondBinding,
    });
    expect(second.nonce.equals(first.nonce)).toBe(false);
    expect(second.ciphertext.equals(first.ciphertext)).toBe(false);
    expect(second.cipherDigest).not.toBe(first.cipherDigest);
    expect(second.contentDigest).toBe(first.contentDigest);
  });

  it('ignores a hostile caller nonce property and always uses production CSPRNG bytes', () => {
    const callerNonce = Buffer.alloc(12, 0x7a);
    const encrypted = encryptMessage({
      plaintext: 'production nonce authority',
      encryptionKey,
      digestKey,
      keyId: 'kms:test:v1',
      aad: aad(),
      nonce: callerNonce,
    } as Parameters<typeof encryptMessage>[0] & { nonce: Buffer });
    expect(encrypted.nonce.equals(callerNonce)).toBe(false);
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

  it.each([
    ['algorithm', (encrypted: EncryptedMessage) => ({ ...encrypted, algorithm: 'unknown/v2' })],
    ['keyId', (encrypted: EncryptedMessage) => ({ ...encrypted, keyId: 'invalid key id' })],
    ['aadVersion', (encrypted: EncryptedMessage) => ({ ...encrypted, aadVersion: 2 })],
  ])('rejects an unknown %s with the same stable auth error', (_field, mutate) => {
    const binding = aad();
    const encrypted = encryptMessage({
      plaintext: 'secret result',
      encryptionKey,
      digestKey,
      keyId: 'kms:test:v1',
      aad: binding,
    });
    expect(() =>
      decryptMessage({
        encrypted: mutate(encrypted) as EncryptedMessage,
        encryptionKey,
        aad: binding,
      }),
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

class TestMessageKeyAuthority implements MessageKeyAuthority {
  public active: TestMessageKey | null = null;
  public readonly keys = new Map<string, TestMessageKey>();
  public cryptoSealCalls = 0;
  public cryptoOpenCalls = 0;

  public async seal(request: MessageKeySealRequest): Promise<MessageKeySealOutcome> {
    const material = this.active;
    if (material === null) return { kind: 'UNAVAILABLE' };
    if (material.status !== 'ACTIVE' || material.ownerId !== request.aad.ownerId) {
      return {
        kind: 'SEALED',
        ownerId: material.ownerId,
        keyId: material.keyId,
        status: material.status,
      } as unknown as MessageKeySealOutcome;
    }
    this.cryptoSealCalls += 1;
    const encrypted = encryptMessage({
      plaintext: request.plaintext,
      encryptionKey: material.encryptionKey,
      digestKey: material.digestKey,
      keyId: material.keyId,
      aad: request.aad,
    });
    return {
      kind: 'SEALED',
      ownerId: material.ownerId,
      keyId: material.keyId,
      status: material.status,
      encrypted,
    } as MessageKeySealOutcome;
  }

  public async open(request: MessageKeyOpenRequest): Promise<MessageKeyOpenOutcome> {
    const material = this.keys.get(`${request.aad.ownerId}:${request.encrypted.keyId}`);
    if (material === undefined) return { kind: 'UNAVAILABLE' };
    this.cryptoOpenCalls += 1;
    try {
      const plaintext = decryptMessage({
        encrypted: request.encrypted,
        encryptionKey: material.encryptionKey,
        aad: request.aad,
      });
      if (
        !verifyMessageContentDigestWithRawKeyForTest(
          plaintext,
          request.encrypted.contentDigest,
          material.digestKey,
        )
      ) {
        return { kind: 'AUTHENTICATION_FAILED' };
      }
      return {
        kind: 'OPENED',
        ownerId: material.ownerId,
        keyId: material.keyId,
        status: material.status,
        plaintext,
      };
    } catch {
      return { kind: 'AUTHENTICATION_FAILED' };
    }
  }
}

interface TestMessageKey {
  ownerId: string;
  keyId: string;
  status: 'ACTIVE' | 'DECRYPT_ONLY';
  encryptionKey: Uint8Array;
  digestKey: Uint8Array;
}

class RecordingMessageKeyAlerts implements MessageKeySecurityAlertSink {
  public readonly alerts: MessageKeySecurityAlert[] = [];

  public async record(alert: MessageKeySecurityAlert): Promise<void> {
    this.alerts.push(alert);
  }
}

describe('keyId-aware Message Key Authority', () => {
  it('rotates ACTIVE to DECRYPT_ONLY while retaining approved historical reads', async () => {
    const ownerId = randomUuidV7();
    const firstAad = aad({ ownerId });
    const secondAad = aad({ ownerId, conversationId: firstAad.conversationId });
    const authority = new TestMessageKeyAuthority();
    const alerts = new RecordingMessageKeyAlerts();
    const firstKey = Buffer.alloc(32, 0x41);
    const secondKey = Buffer.alloc(32, 0x42);
    authority.active = {
      ownerId,
      keyId: 'kms:test:message:v1',
      status: 'ACTIVE',
      encryptionKey: firstKey,
      digestKey,
    };
    authority.keys.set(`${ownerId}:kms:test:message:v1`, {
      ownerId,
      keyId: 'kms:test:message:v1',
      status: 'ACTIVE',
      encryptionKey: firstKey,
      digestKey,
    });
    const first = await sealMessageWithKeyAuthority(
      { plaintext: 'old history', aad: firstAad },
      authority,
      alerts,
    );

    authority.keys.set(`${ownerId}:kms:test:message:v1`, {
      ownerId,
      keyId: 'kms:test:message:v1',
      status: 'DECRYPT_ONLY',
      encryptionKey: firstKey,
      digestKey,
    });
    authority.active = {
      ownerId,
      keyId: 'kms:test:message:v2',
      status: 'ACTIVE',
      encryptionKey: secondKey,
      digestKey,
    };
    authority.keys.set(`${ownerId}:kms:test:message:v2`, {
      ownerId,
      keyId: 'kms:test:message:v2',
      status: 'ACTIVE',
      encryptionKey: secondKey,
      digestKey,
    });
    const second = await sealMessageWithKeyAuthority(
      { plaintext: 'new history', aad: secondAad },
      authority,
      alerts,
    );

    await expect(
      openMessageWithKeyAuthority({ encrypted: first, aad: firstAad }, authority, alerts),
    ).resolves.toBe('old history');
    await expect(
      openMessageWithKeyAuthority({ encrypted: second, aad: secondAad }, authority, alerts),
    ).resolves.toBe('new history');
    expect(first.keyId).toBe('kms:test:message:v1');
    expect(second.keyId).toBe('kms:test:message:v2');
    expect(authority.cryptoSealCalls).toBe(2);
    expect(authority.cryptoOpenCalls).toBe(2);
    expect(alerts.alerts).toEqual([]);
  });

  it('returns BLOCKED and emits only a keyId digest when an old or unknown key is missing', async () => {
    const ownerId = randomUuidV7();
    const binding = aad({ ownerId });
    const authority = new TestMessageKeyAuthority();
    const alerts = new RecordingMessageKeyAlerts();
    authority.active = {
      ownerId,
      keyId: 'kms:test:missing:v1',
      status: 'ACTIVE',
      encryptionKey,
      digestKey,
    };
    const encrypted = await sealMessageWithKeyAuthority(
      { plaintext: 'must not become empty history', aad: binding },
      authority,
      alerts,
    );
    authority.active = null;

    await expect(
      openMessageWithKeyAuthority({ encrypted, aad: binding }, authority, alerts),
    ).rejects.toMatchObject({
      code: 'MESSAGE_KEY_UNAVAILABLE',
      state: 'BLOCKED',
      message: '消息密钥当前不可用',
    });
    expect(alerts.alerts).toHaveLength(1);
    expect(alerts.alerts[0]).toMatchObject({
      reason: 'KEY_UNAVAILABLE',
      ownerId,
      keyIdDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(alerts.alerts)).not.toContain(encrypted.keyId);
    expect(authority.cryptoSealCalls).toBe(1);
    expect(authority.cryptoOpenCalls).toBe(0);
  });

  it.each([
    ['DECRYPT_ONLY active key', 'DECRYPT_ONLY' as const, false],
    ['wrong owner', 'ACTIVE' as const, true],
  ])('blocks a mismatched %s before encryption', async (_label, status, wrongOwner) => {
    const ownerId = randomUuidV7();
    const authority = new TestMessageKeyAuthority();
    const alerts = new RecordingMessageKeyAlerts();
    authority.active = {
      ownerId: wrongOwner ? randomUuidV7() : ownerId,
      keyId: 'kms:test:mismatch:v1',
      status,
      encryptionKey,
      digestKey,
    };
    await expect(
      sealMessageWithKeyAuthority(
        { plaintext: 'never encrypted', aad: aad({ ownerId }) },
        authority,
        alerts,
      ),
    ).rejects.toBeInstanceOf(MessageKeyUnavailableError);
    expect(alerts.alerts).toHaveLength(1);
    expect(alerts.alerts[0]?.reason).toBe('KEY_AUTHORITY_MISMATCH');
    expect(authority.cryptoSealCalls).toBe(0);
  });

  it.each(['ciphertext', 'contentDigest'] as const)(
    'emits a sanitized authentication alert and returns zero plaintext on a %s flip',
    async (field) => {
      const ownerId = randomUuidV7();
      const binding = aad({ ownerId });
      const authority = new TestMessageKeyAuthority();
      const alerts = new RecordingMessageKeyAlerts();
      authority.active = {
        ownerId,
        keyId: 'kms:test:auth:v1',
        status: 'ACTIVE',
        encryptionKey,
        digestKey,
      };
      authority.keys.set(`${ownerId}:kms:test:auth:v1`, {
        ownerId,
        keyId: 'kms:test:auth:v1',
        status: 'ACTIVE',
        encryptionKey,
        digestKey,
      });
      const encrypted = await sealMessageWithKeyAuthority(
        { plaintext: 'no partial plaintext', aad: binding },
        authority,
        alerts,
      );
      const tampered = {
        ...encrypted,
        ciphertext: Buffer.from(encrypted.ciphertext),
      };
      if (field === 'ciphertext') {
        tampered.ciphertext[0] ^= 1;
      } else {
        tampered.contentDigest = `${encrypted.contentDigest.slice(0, -1)}${
          encrypted.contentDigest.endsWith('0') ? '1' : '0'
        }`;
      }
      await expect(
        openMessageWithKeyAuthority({ encrypted: tampered, aad: binding }, authority, alerts),
      ).rejects.toBeInstanceOf(MessageAuthenticationError);
      expect(alerts.alerts.at(-1)).toMatchObject({
        reason: 'MESSAGE_AUTHENTICATION_FAILED',
        ownerId,
      });
      expect(JSON.stringify(alerts.alerts)).not.toContain('no partial plaintext');
    },
  );

  it('fails closed with a stable BLOCKED error when the alert sink is unavailable', async () => {
    const authority = new TestMessageKeyAuthority();
    const canary = 'raw-provider-error-canary';
    const alerts: MessageKeySecurityAlertSink = {
      async record(): Promise<void> {
        throw new Error(canary);
      },
    };
    await expect(
      sealMessageWithKeyAuthority(
        { plaintext: 'must not be encrypted', aad: aad() },
        authority,
        alerts,
      ),
    ).rejects.toMatchObject({
      code: 'MESSAGE_KEY_UNAVAILABLE',
      state: 'BLOCKED',
      message: '消息密钥当前不可用',
    });
    try {
      await sealMessageWithKeyAuthority(
        { plaintext: 'must not be encrypted', aad: aad() },
        authority,
        alerts,
      );
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(canary);
      expect(error).not.toHaveProperty('cause');
    }
  });

  it('sanitizes a raw key-provider failure before returning BLOCKED', async () => {
    const providerCanary = 'kms-provider-credential-canary';
    const authority: MessageKeyAuthority = {
      async seal(): Promise<MessageKeySealOutcome> {
        throw new Error(providerCanary);
      },
      async open(): Promise<MessageKeyOpenOutcome> {
        throw new Error(providerCanary);
      },
    };
    const alerts = new RecordingMessageKeyAlerts();
    let caught: unknown;
    try {
      await sealMessageWithKeyAuthority(
        { plaintext: 'never encrypted', aad: aad() },
        authority,
        alerts,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'MESSAGE_KEY_UNAVAILABLE',
      state: 'BLOCKED',
      message: '消息密钥当前不可用',
    });
    expect(JSON.stringify(caught)).not.toContain(providerCanary);
    expect(caught).not.toHaveProperty('cause');
    expect(alerts.alerts).toHaveLength(1);
    expect(alerts.alerts[0]?.reason).toBe('ACTIVE_KEY_UNAVAILABLE');

    const binding = aad();
    const encrypted = encryptMessage({
      plaintext: 'never opened',
      encryptionKey,
      digestKey,
      keyId: 'kms:test:provider-failure:v1',
      aad: binding,
    });
    await expect(
      openMessageWithKeyAuthority({ encrypted, aad: binding }, authority, alerts),
    ).rejects.toMatchObject({ code: 'MESSAGE_KEY_UNAVAILABLE', state: 'BLOCKED' });
    expect(alerts.alerts.at(-1)?.reason).toBe('KEY_UNAVAILABLE');
  });

  it('returns BLOCKED without plaintext when an authentication alert cannot be persisted', async () => {
    const ownerId = randomUuidV7();
    const binding = aad({ ownerId });
    const authority = new TestMessageKeyAuthority();
    const recordingAlerts = new RecordingMessageKeyAlerts();
    authority.active = {
      ownerId,
      keyId: 'kms:test:alert-failure:v1',
      status: 'ACTIVE',
      encryptionKey,
      digestKey,
    };
    authority.keys.set(`${ownerId}:kms:test:alert-failure:v1`, {
      ...authority.active,
    });
    const encrypted = await sealMessageWithKeyAuthority(
      { plaintext: 'never returned', aad: binding },
      authority,
      recordingAlerts,
    );
    const tampered = {
      ...encrypted,
      contentDigest: `${encrypted.contentDigest.slice(0, -1)}${
        encrypted.contentDigest.endsWith('0') ? '1' : '0'
      }`,
    };
    const failingAlerts: MessageKeySecurityAlertSink = {
      async record(): Promise<void> {
        throw new Error('audit-storage-canary');
      },
    };
    await expect(
      openMessageWithKeyAuthority({ encrypted: tampered, aad: binding }, authority, failingAlerts),
    ).rejects.toMatchObject({
      code: 'MESSAGE_KEY_UNAVAILABLE',
      state: 'BLOCKED',
      message: '消息密钥当前不可用',
    });
  });

  it('fails closed before provider access when the key operation signal is already aborted', async () => {
    const authority = new TestMessageKeyAuthority();
    const alerts = new RecordingMessageKeyAlerts();
    await expect(
      sealMessageWithKeyAuthority(
        { plaintext: 'never encrypted', aad: aad(), signal: AbortSignal.abort() },
        authority,
        alerts,
      ),
    ).rejects.toMatchObject({ code: 'MESSAGE_KEY_UNAVAILABLE', state: 'BLOCKED' });
    expect(alerts.alerts).toHaveLength(1);
    expect(alerts.alerts[0]?.reason).toBe('ACTIVE_KEY_UNAVAILABLE');
  });

  it('rejects invalid plaintext before invoking the opaque authority', async () => {
    let calls = 0;
    const authority: MessageKeyAuthority = {
      async seal(): Promise<MessageKeySealOutcome> {
        calls += 1;
        return { kind: 'UNAVAILABLE' };
      },
      async open(): Promise<MessageKeyOpenOutcome> {
        calls += 1;
        return { kind: 'UNAVAILABLE' };
      },
    };
    const alerts = new RecordingMessageKeyAlerts();
    for (const plaintext of ['', '界'.repeat(Math.ceil(MESSAGE_MAX_PLAINTEXT_BYTES / 3) + 1)]) {
      await expect(
        sealMessageWithKeyAuthority({ plaintext, aad: aad() }, authority, alerts),
      ).rejects.toBeInstanceOf(RangeError);
    }
    expect(calls).toBe(0);
    expect(alerts.alerts).toEqual([]);
  });

  it('locally bounds providers and alert sinks that ignore AbortSignal', async () => {
    const never = new Promise<never>(() => undefined);
    const blockedAuthority: MessageKeyAuthority = {
      seal: async () => never,
      open: async () => never,
    };
    const providerAlerts = new RecordingMessageKeyAlerts();
    const start = Date.now();
    await expect(
      sealMessageWithKeyAuthority(
        { plaintext: 'bounded provider', aad: aad(), signal: AbortSignal.timeout(20) },
        blockedAuthority,
        providerAlerts,
      ),
    ).rejects.toMatchObject({ code: 'MESSAGE_KEY_UNAVAILABLE', state: 'BLOCKED' });
    expect(Date.now() - start).toBeLessThan(1_000);
    expect(providerAlerts.alerts).toHaveLength(1);
    expect(providerAlerts.alerts[0]?.reason).toBe('ACTIVE_KEY_UNAVAILABLE');

    const unavailableAuthority: MessageKeyAuthority = {
      async seal(): Promise<MessageKeySealOutcome> {
        return { kind: 'UNAVAILABLE' };
      },
      async open(): Promise<MessageKeyOpenOutcome> {
        return { kind: 'UNAVAILABLE' };
      },
    };
    const blockedAlerts: MessageKeySecurityAlertSink = {
      async record(): Promise<void> {
        await never;
      },
    };
    await expect(
      sealMessageWithKeyAuthority(
        { plaintext: 'bounded alert', aad: aad(), signal: AbortSignal.timeout(20) },
        unavailableAuthority,
        blockedAlerts,
      ),
    ).rejects.toMatchObject({ code: 'MESSAGE_KEY_UNAVAILABLE', state: 'BLOCKED' });
  });

  it('normalizes a malformed provider outcome without exposing getter errors', async () => {
    const canary = 'malformed-provider-getter-canary';
    const authority: MessageKeyAuthority = {
      async seal(): Promise<MessageKeySealOutcome> {
        return {
          get kind(): 'SEALED' {
            throw new Error(canary);
          },
        } as MessageKeySealOutcome;
      },
      async open(): Promise<MessageKeyOpenOutcome> {
        return { kind: 'UNAVAILABLE' };
      },
    };
    const alerts = new RecordingMessageKeyAlerts();
    let caught: unknown;
    try {
      await sealMessageWithKeyAuthority(
        { plaintext: 'never encrypted', aad: aad() },
        authority,
        alerts,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'MESSAGE_KEY_UNAVAILABLE', state: 'BLOCKED' });
    expect(JSON.stringify(caught)).not.toContain(canary);
    expect(alerts.alerts.at(-1)?.reason).toBe('KEY_AUTHORITY_MISMATCH');
  });
});
