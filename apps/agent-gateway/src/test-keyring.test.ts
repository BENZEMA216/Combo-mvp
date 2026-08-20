import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  brokerSensitiveMessageAadBytes,
  brokerSensitiveMessageAadDigest,
  brokerSensitiveMessageCipherDigest,
  canonicalizeJson,
  domainSeparatedHmacSha256,
} from '@cb/creator-agent-protocol';
import type { EncryptedMessage, MessageAad } from '@cb/creator-agent-persistence';
import { afterEach, describe, expect, it } from 'vitest';

import { loadGatewayTestKeyring } from './test-keyring.js';

const OWNER_ID = '0198f00d-7000-7000-8000-000000000001';
const INSTALLATION_ID = '0198f00d-7000-7000-8000-000000000002';
const CONVERSATION_ID = '0198f00d-7000-7000-8000-000000000003';
const INVOCATION_ID = '0198f00d-7000-7000-8000-000000000004';
const USER_MESSAGE_ID = '0198f00d-7000-7000-8000-000000000005';
const COMMAND_ID = '0198f00d-7000-7000-8000-000000000006';
const WORKER_SESSION_ID = '0198f00d-7000-7000-8000-000000000007';
const ASSISTANT_MESSAGE_ID = '0198f00d-7000-7000-8000-000000000008';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('mounted Gateway Test keyring', () => {
  it('authenticates and re-seals USER and ASSISTANT messages without env key material', async () => {
    const ownerEncryptionKey = randomBytes(32);
    const ownerDigestKey = randomBytes(32);
    const workerSessionKey = randomBytes(32);
    const path = await writeKeyring({ ownerEncryptionKey, ownerDigestKey, workerSessionKey });
    const adapters = loadGatewayTestKeyring(path);
    const durableAad: MessageAad = {
      schemaVersion: 1,
      ownerId: OWNER_ID,
      conversationId: CONVERSATION_ID,
      messageId: USER_MESSAGE_ID,
      role: 'USER',
    };
    const durableMessage = durableCiphertext(
      'strict local user prompt',
      ownerEncryptionKey,
      ownerDigestKey,
      durableAad,
    );

    const sealedUser = await adapters.sealUserMessage({
      creatorId: OWNER_ID,
      installationId: INSTALLATION_ID,
      durableMessage,
      durableAad,
      command: {
        messageId: COMMAND_ID,
        conversationId: CONVERSATION_ID,
        invocationId: INVOCATION_ID,
        workerSessionId: WORKER_SESSION_ID,
      },
      signal: AbortSignal.timeout(5_000),
    });
    expect(openBrokerCiphertext(sealedUser, workerSessionKey)).toBe('strict local user prompt');
    expect(sealedUser.aad).toMatchObject({
      envelopeType: 'invocation.prepare',
      messageId: COMMAND_ID,
      conversationId: CONVERSATION_ID,
      invocationId: INVOCATION_ID,
      workerSessionId: WORKER_SESSION_ID,
      role: 'USER',
    });

    const assistantTransport = brokerCiphertext('strict local assistant result', workerSessionKey, {
      protocol: 'combo.creator-broker/1',
      schemaVersion: 1,
      envelopeType: 'invocation.succeeded',
      messageId: '0198f00d-7000-7000-8000-000000000009',
      conversationId: CONVERSATION_ID,
      invocationId: INVOCATION_ID,
      workerSessionId: WORKER_SESSION_ID,
      role: 'ASSISTANT',
      keyId: 'worker-session-test-1',
    });
    const assistantAad: MessageAad = {
      schemaVersion: 1,
      ownerId: OWNER_ID,
      conversationId: CONVERSATION_ID,
      messageId: ASSISTANT_MESSAGE_ID,
      role: 'ASSISTANT',
    };
    const sealedAssistant = await adapters.sealAssistantMessage({
      resultCiphertext: assistantTransport,
      aad: assistantAad,
      signal: AbortSignal.timeout(5_000),
      installationId: INSTALLATION_ID,
      workerSessionId: WORKER_SESSION_ID,
    });
    expect(
      openDurableCiphertext(sealedAssistant.encryptedMessage, ownerEncryptionKey, assistantAad),
    ).toBe('strict local assistant result');
    expect(sealedAssistant.verifiedResultDigest).toBe(
      domainSeparatedHmacSha256('combo:vnext:result:v1', ownerDigestKey, {
        text: 'strict local assistant result',
      }),
    );
  });

  it('rejects a group-readable, symlinked, malformed, or incomplete mounted file', async () => {
    const ownerEncryptionKey = randomBytes(32);
    const ownerDigestKey = randomBytes(32);
    const workerSessionKey = randomBytes(32);
    const path = await writeKeyring({ ownerEncryptionKey, ownerDigestKey, workerSessionKey });
    await chmod(path, 0o640);
    expect(() => loadGatewayTestKeyring(path)).toThrow('TEST_KEYRING_FILE_INVALID');

    await chmod(path, 0o600);
    const document = await readFile(path, 'utf8');
    await writeFile(
      path,
      document.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
      { mode: 0o600 },
    );
    expect(() => loadGatewayTestKeyring(path)).toThrow('TEST_KEYRING_FILE_INVALID');

    await writeFile(path, document, { mode: 0o600 });
    const linkPath = `${path}.link`;
    await symlink(path, linkPath);
    expect(() => loadGatewayTestKeyring(linkPath)).toThrow('TEST_KEYRING_FILE_INVALID');

    await writeFile(path, '{"protocol":"future"}', { mode: 0o600 });
    expect(() => loadGatewayTestKeyring(path)).toThrow('TEST_KEYRING_FILE_INVALID');
  });

  it('fails closed when durable USER authentication or key authority does not match', async () => {
    const ownerEncryptionKey = randomBytes(32);
    const ownerDigestKey = randomBytes(32);
    const workerSessionKey = randomBytes(32);
    const path = await writeKeyring({ ownerEncryptionKey, ownerDigestKey, workerSessionKey });
    const adapters = loadGatewayTestKeyring(path);
    const durableAad: MessageAad = {
      schemaVersion: 1,
      ownerId: OWNER_ID,
      conversationId: CONVERSATION_ID,
      messageId: USER_MESSAGE_ID,
      role: 'USER',
    };
    const durableMessage = durableCiphertext(
      'strict local user prompt',
      ownerEncryptionKey,
      ownerDigestKey,
      durableAad,
    );

    await expect(
      adapters.sealUserMessage({
        creatorId: OWNER_ID,
        installationId: INSTALLATION_ID,
        durableMessage: { ...durableMessage, cipherDigest: 'f'.repeat(64) },
        durableAad,
        command: {
          messageId: COMMAND_ID,
          conversationId: CONVERSATION_ID,
          invocationId: INVOCATION_ID,
          workerSessionId: WORKER_SESSION_ID,
        },
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toThrow('TEST_KEYRING_AUTHENTICATION_FAILED');
  });

  it('rejects authenticated non-UTF-8 plaintext and exact ASSISTANT authority drift', async () => {
    const ownerEncryptionKey = randomBytes(32);
    const ownerDigestKey = randomBytes(32);
    const workerSessionKey = randomBytes(32);
    const path = await writeKeyring({ ownerEncryptionKey, ownerDigestKey, workerSessionKey });
    const adapters = loadGatewayTestKeyring(path);
    const durableAad: MessageAad = {
      schemaVersion: 1,
      ownerId: OWNER_ID,
      conversationId: CONVERSATION_ID,
      messageId: USER_MESSAGE_ID,
      role: 'USER',
    };
    const malformedUser = durableCiphertextBytes(
      Buffer.from([0xc3, 0x28]),
      ownerEncryptionKey,
      ownerDigestKey,
      durableAad,
    );
    await expect(
      adapters.sealUserMessage({
        creatorId: OWNER_ID,
        installationId: INSTALLATION_ID,
        durableMessage: malformedUser,
        durableAad,
        command: {
          messageId: COMMAND_ID,
          conversationId: CONVERSATION_ID,
          invocationId: INVOCATION_ID,
          workerSessionId: WORKER_SESSION_ID,
        },
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toThrow('TEST_KEYRING_AUTHENTICATION_FAILED');

    const assistantAad: MessageAad = {
      schemaVersion: 1,
      ownerId: OWNER_ID,
      conversationId: CONVERSATION_ID,
      messageId: ASSISTANT_MESSAGE_ID,
      role: 'ASSISTANT',
    };
    const assistantTransport = brokerCiphertextBytes(Buffer.from([0xc3, 0x28]), workerSessionKey, {
      protocol: 'combo.creator-broker/1',
      schemaVersion: 1,
      envelopeType: 'invocation.succeeded',
      messageId: '0198f00d-7000-7000-8000-000000000009',
      conversationId: CONVERSATION_ID,
      invocationId: INVOCATION_ID,
      workerSessionId: WORKER_SESSION_ID,
      role: 'ASSISTANT',
      keyId: 'worker-session-test-1',
    });
    await expect(
      adapters.sealAssistantMessage({
        resultCiphertext: assistantTransport,
        aad: assistantAad,
        signal: AbortSignal.timeout(5_000),
        installationId: INSTALLATION_ID,
        workerSessionId: WORKER_SESSION_ID,
      }),
    ).rejects.toThrow('TEST_KEYRING_AUTHENTICATION_FAILED');
    await expect(
      adapters.sealAssistantMessage({
        resultCiphertext: assistantTransport,
        aad: assistantAad,
        signal: AbortSignal.timeout(5_000),
        installationId: INSTALLATION_ID,
        workerSessionId: '0198f00d-7000-7000-8000-000000000099',
      }),
    ).rejects.toThrow('TEST_KEYRING_AUTHENTICATION_FAILED');
  });
});

async function writeKeyring(keys: {
  ownerEncryptionKey: Buffer;
  ownerDigestKey: Buffer;
  workerSessionKey: Buffer;
}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'combo-gateway-test-keyring-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'keyring.json');
  await writeFile(
    path,
    JSON.stringify({
      protocol: 'combo.gateway-test-keyring/1',
      schemaVersion: 1,
      owners: [
        {
          ownerId: OWNER_ID,
          digestKey: keys.ownerDigestKey.toString('base64url'),
          messageKeys: [
            {
              keyId: 'owner-message-test-1',
              status: 'ACTIVE',
              encryptionKey: keys.ownerEncryptionKey.toString('base64url'),
            },
          ],
        },
      ],
      workerInstallations: [
        {
          installationId: INSTALLATION_ID,
          sessionKeys: [
            {
              keyId: 'worker-session-test-1',
              status: 'ACTIVE',
              encryptionKey: keys.workerSessionKey.toString('base64url'),
            },
          ],
        },
      ],
    }),
    { mode: 0o600 },
  );
  return path;
}

function durableCiphertext(
  plaintext: string,
  encryptionKey: Buffer,
  digestKey: Buffer,
  aad: MessageAad,
): EncryptedMessage {
  return durableCiphertextBytes(
    Buffer.from(plaintext, 'utf8'),
    encryptionKey,
    digestKey,
    aad,
    plaintext,
  );
}

function durableCiphertextBytes(
  plaintextBytes: Buffer,
  encryptionKey: Buffer,
  digestKey: Buffer,
  aad: MessageAad,
  digestText = '',
): EncryptedMessage {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
  cipher.setAAD(Buffer.from(canonicalizeJson(aad), 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintextBytes), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    algorithm: 'aes-256-gcm/v1',
    keyId: 'owner-message-test-1',
    nonce,
    ciphertext,
    authTag,
    cipherDigest: createHash('sha256')
      .update(nonce)
      .update(ciphertext)
      .update(authTag)
      .digest('hex'),
    contentDigest: domainSeparatedHmacSha256('combo:vnext:message:v1', digestKey, {
      text: digestText,
    }),
    aadVersion: 1,
  };
}

function openDurableCiphertext(
  encrypted: EncryptedMessage,
  encryptionKey: Buffer,
  aad: MessageAad,
): string {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, encrypted.nonce);
  decipher.setAAD(Buffer.from(canonicalizeJson(aad), 'utf8'));
  decipher.setAuthTag(encrypted.authTag);
  return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString('utf8');
}

function brokerCiphertext(
  plaintext: string,
  encryptionKey: Buffer,
  aad: Parameters<typeof brokerSensitiveMessageAadBytes>[0],
) {
  return brokerCiphertextBytes(Buffer.from(plaintext, 'utf8'), encryptionKey, aad);
}

function brokerCiphertextBytes(
  plaintextBytes: Buffer,
  encryptionKey: Buffer,
  aad: Parameters<typeof brokerSensitiveMessageAadBytes>[0],
) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, nonce);
  cipher.setAAD(brokerSensitiveMessageAadBytes(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintextBytes), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const nonceText = nonce.toString('base64url');
  const ciphertextText = ciphertext.toString('base64url');
  const authTagText = authTag.toString('base64url');
  return {
    algorithm: 'aes-256-gcm/v1' as const,
    keyScope: 'worker-session' as const,
    keyId: aad.keyId,
    nonce: nonceText,
    ciphertext: ciphertextText,
    authTag: authTagText,
    cipherDigest: brokerSensitiveMessageCipherDigest(nonceText, ciphertextText, authTagText),
    aad,
    aadDigest: brokerSensitiveMessageAadDigest(aad),
    aadVersion: 1 as const,
  };
}

function openBrokerCiphertext(
  message: ReturnType<typeof brokerCiphertext>,
  encryptionKey: Buffer,
): string {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey,
    Buffer.from(message.nonce, 'base64url'),
  );
  decipher.setAAD(brokerSensitiveMessageAadBytes(message.aad));
  decipher.setAuthTag(Buffer.from(message.authTag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(message.ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}
