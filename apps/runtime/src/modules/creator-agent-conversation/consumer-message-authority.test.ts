import { createCipheriv, createHash, createHmac } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { canonicalizeJson } from '@cb/creator-agent-protocol';
import type { EncryptedMessage, MessageAad } from '@cb/creator-agent-persistence';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConsumerMessageAuthorityError,
  loadTestConsumerMessageAuthority,
} from './consumer-message-authority.js';

const OWNER_ID = '01900000-0000-7000-8000-000000000201';
const CONVERSATION_ID = '01900000-0000-7000-8000-000000000202';
const MESSAGE_ID = '01900000-0000-7000-8000-000000000203';
const INSTALLATION_ID = '01900000-0000-7000-8000-000000000204';
const DIGEST_KEY = Buffer.alloc(32, 1);
const OLD_KEY = Buffer.alloc(32, 2);
const NEW_KEY = Buffer.alloc(32, 3);
const SESSION_KEY = Buffer.alloc(32, 4);
const signal = new AbortController().signal;

interface MessageKeyFixture {
  keyId: string;
  status: 'ACTIVE' | 'DECRYPT_ONLY';
  encryptionKey: string;
}

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'combo-runtime-message-authority-'));
  roots.push(root);
  return root;
}

function fixture(
  messageKeys: MessageKeyFixture[] = [
    { keyId: 'owner-old', status: 'ACTIVE', encryptionKey: OLD_KEY.toString('base64url') },
  ],
): Record<string, unknown> {
  return {
    protocol: 'combo.gateway-test-keyring/1',
    schemaVersion: 1,
    owners: [
      {
        ownerId: OWNER_ID,
        digestKey: DIGEST_KEY.toString('base64url'),
        messageKeys,
      },
    ],
    workerInstallations: [
      {
        installationId: INSTALLATION_ID,
        sessionKeys: [
          {
            keyId: 'worker-session-v1',
            status: 'ACTIVE',
            encryptionKey: SESSION_KEY.toString('base64url'),
          },
        ],
      },
    ],
  };
}

function writeFixture(
  root: string,
  value: Record<string, unknown> | Buffer | string = fixture(),
  mode = 0o600,
): string {
  const path = join(root, 'keyring.json');
  const bytes = Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value);
  writeFileSync(path, bytes, { mode });
  chmodSync(path, mode);
  return path;
}

function aad(overrides: Partial<MessageAad> = {}): MessageAad {
  return {
    schemaVersion: 1,
    ownerId: OWNER_ID,
    conversationId: CONVERSATION_ID,
    messageId: MESSAGE_ID,
    role: 'USER',
    ...overrides,
  };
}

describe('mounted Test ConsumerMessageAuthority', () => {
  it('derives both digests from one plaintext snapshot and authenticates exact AAD', async () => {
    const authority = loadTestConsumerMessageAuthority(writeFixture(createRoot()));
    const bound = await authority.bindUserMessage({
      creatorId: OWNER_ID,
      text: '你好 Combo',
      signal,
    });
    const expectedRequestDigest = createHmac('sha256', DIGEST_KEY)
      .update('combo:vnext:request:v1\0', 'utf8')
      .update(Buffer.from('你好 Combo', 'utf8'))
      .digest('hex');
    expect(bound.requestDigest).toBe(`hmac-sha256:${expectedRequestDigest}`);

    const encrypted = await bound.seal({
      conversationId: CONVERSATION_ID,
      messageId: MESSAGE_ID,
      signal,
    });
    expect(encrypted.keyId).toBe('owner-old');
    await expect(authority.openMessage({ encrypted, aad: aad(), signal })).resolves.toBe(
      '你好 Combo',
    );
    await expect(
      authority.openMessage({
        encrypted,
        aad: aad({ messageId: '01900000-0000-7000-8000-000000000205' }),
        signal,
      }),
    ).rejects.toMatchObject({ code: 'MESSAGE_AUTHENTICATION_FAILED' });
    await expect(
      bound.seal({
        conversationId: CONVERSATION_ID,
        messageId: MESSAGE_ID,
        signal,
      }),
    ).rejects.toMatchObject({ code: 'MESSAGE_AUTHORITY_UNAVAILABLE' });
  });

  it('seals only with ACTIVE and keeps DECRYPT_ONLY material available for historical opens', async () => {
    const root = createRoot();
    const path = writeFixture(root);
    const oldAuthority = loadTestConsumerMessageAuthority(path);
    const oldEncrypted = await (
      await oldAuthority.bindUserMessage({ creatorId: OWNER_ID, text: 'old', signal })
    ).seal({ conversationId: CONVERSATION_ID, messageId: MESSAGE_ID, signal });

    writeFixture(
      root,
      fixture([
        {
          keyId: 'owner-old',
          status: 'DECRYPT_ONLY',
          encryptionKey: OLD_KEY.toString('base64url'),
        },
        { keyId: 'owner-new', status: 'ACTIVE', encryptionKey: NEW_KEY.toString('base64url') },
      ]),
    );
    const rotatedAuthority = loadTestConsumerMessageAuthority(path);
    await expect(
      rotatedAuthority.openMessage({ encrypted: oldEncrypted, aad: aad(), signal }),
    ).resolves.toBe('old');
    const newEncrypted = await (
      await rotatedAuthority.bindUserMessage({ creatorId: OWNER_ID, text: 'new', signal })
    ).seal({ conversationId: CONVERSATION_ID, messageId: MESSAGE_ID, signal });
    expect(newEncrypted.keyId).toBe('owner-new');
  });

  it('fails closed for cipher/content tampering and fatal UTF-8 plaintext', async () => {
    const authority = loadTestConsumerMessageAuthority(writeFixture(createRoot()));
    const encrypted = await (
      await authority.bindUserMessage({ creatorId: OWNER_ID, text: 'trusted', signal })
    ).seal({ conversationId: CONVERSATION_ID, messageId: MESSAGE_ID, signal });

    await expect(
      authority.openMessage({
        encrypted: { ...encrypted, cipherDigest: '0'.repeat(64) },
        aad: aad(),
        signal,
      }),
    ).rejects.toMatchObject({ code: 'MESSAGE_AUTHENTICATION_FAILED' });
    await expect(
      authority.openMessage({
        encrypted: { ...encrypted, contentDigest: `hmac-sha256:${'0'.repeat(64)}` },
        aad: aad(),
        signal,
      }),
    ).rejects.toMatchObject({ code: 'MESSAGE_AUTHENTICATION_FAILED' });

    const invalidUtf8 = Buffer.from([0xc3, 0x28]);
    const nonce = Buffer.alloc(12, 9);
    const cipher = createCipheriv('aes-256-gcm', OLD_KEY, nonce);
    cipher.setAAD(Buffer.from(canonicalizeJson(aad()), 'utf8'), {
      plaintextLength: invalidUtf8.byteLength,
    });
    const ciphertext = Buffer.concat([cipher.update(invalidUtf8), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const invalidEncrypted: EncryptedMessage = {
      algorithm: 'aes-256-gcm/v1',
      keyId: 'owner-old',
      nonce,
      ciphertext,
      authTag,
      cipherDigest: createHash('sha256')
        .update(nonce)
        .update(ciphertext)
        .update(authTag)
        .digest('hex'),
      contentDigest: `hmac-sha256:${'0'.repeat(64)}`,
      aadVersion: 1,
    };
    await expect(
      authority.openMessage({ encrypted: invalidEncrypted, aad: aad(), signal }),
    ).rejects.toMatchObject({ code: 'MESSAGE_AUTHENTICATION_FAILED' });
  });

  it('rejects non-0600, non-regular, wrong-owner, symlink, duplicate-key and invalid UTF-8 mounts', () => {
    const looseRoot = createRoot();
    expect(() =>
      loadTestConsumerMessageAuthority(writeFixture(looseRoot, fixture(), 0o644)),
    ).toThrowError(ConsumerMessageAuthorityError);

    const directoryRoot = createRoot();
    const directoryPath = join(directoryRoot, 'authority-directory');
    mkdirSync(directoryPath);
    expect(() => loadTestConsumerMessageAuthority(directoryPath)).toThrowError(
      ConsumerMessageAuthorityError,
    );

    const symlinkRoot = createRoot();
    const sourcePath = writeFixture(symlinkRoot);
    const symlinkPath = join(symlinkRoot, 'keyring-link.json');
    symlinkSync(sourcePath, symlinkPath);
    expect(() => loadTestConsumerMessageAuthority(symlinkPath)).toThrowError(
      ConsumerMessageAuthorityError,
    );

    const ownerRoot = createRoot();
    const ownerPath = writeFixture(ownerRoot);
    const realUid = process.getuid?.() ?? 0;
    vi.spyOn(process as unknown as { getuid(): number }, 'getuid').mockReturnValue(realUid + 1);
    expect(() => loadTestConsumerMessageAuthority(ownerPath)).toThrowError(
      ConsumerMessageAuthorityError,
    );
    vi.restoreAllMocks();

    const duplicateRoot = createRoot();
    const serialized = JSON.stringify(fixture()).replace(
      '{"protocol":',
      '{"protocol":"combo.gateway-test-keyring/1","protocol":',
    );
    expect(() =>
      loadTestConsumerMessageAuthority(writeFixture(duplicateRoot, serialized)),
    ).toThrowError(ConsumerMessageAuthorityError);

    const utf8Root = createRoot();
    expect(() =>
      loadTestConsumerMessageAuthority(writeFixture(utf8Root, Buffer.from([0xff, 0xfe]))),
    ).toThrowError(ConsumerMessageAuthorityError);
  });
});
