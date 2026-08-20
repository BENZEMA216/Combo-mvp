import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  brokerSensitiveMessageAadBytes,
  brokerSensitiveMessageAadDigest,
  brokerSensitiveMessageCipherDigest,
  domainSeparatedHmacSha256,
} from '../../packages/creator-agent-protocol/src/index.js';
import { loadGatewayTestKeyring } from '../../apps/agent-gateway/src/test-keyring.js';
import { loadTestConsumerMessageAuthority } from '../../apps/runtime/src/modules/creator-agent-conversation/consumer-message-authority.js';
import { describe, expect, it } from 'vitest';

const OWNER_ID = '018f0000-0000-7000-8000-000000000001';
const INSTALLATION_ID = '018f0000-0000-7000-8000-000000000002';
const CONVERSATION_ID = '018f0000-0000-7000-8000-000000000003';
const USER_MESSAGE_ID = '018f0000-0000-7000-8000-000000000004';
const PREPARE_COMMAND_ID = '018f0000-0000-7000-8000-000000000005';
const INVOCATION_ID = '018f0000-0000-7000-8000-000000000006';
const WORKER_SESSION_ID = '018f0000-0000-7000-8000-000000000007';
const SUCCEEDED_MESSAGE_ID = '018f0000-0000-7000-8000-000000000008';
const ASSISTANT_MESSAGE_ID = '018f0000-0000-7000-8000-000000000009';
const OWNER_KEY_ID = 'test.owner.active';
const SESSION_KEY_ID = 'test.worker-session.active';
const OWNER_KEY = Buffer.alloc(32, 0x11);
const DIGEST_KEY = Buffer.alloc(32, 0x22);
const SESSION_KEY = Buffer.alloc(32, 0x33);

function mountedKeyring(): { path: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'combo-r3-crypto-'));
  const path = join(directory, 'keyring.json');
  writeFileSync(
    path,
    JSON.stringify({
      protocol: 'combo.gateway-test-keyring/1',
      schemaVersion: 1,
      owners: [
        {
          ownerId: OWNER_ID,
          digestKey: DIGEST_KEY.toString('base64url'),
          messageKeys: [
            {
              keyId: OWNER_KEY_ID,
              status: 'ACTIVE',
              encryptionKey: OWNER_KEY.toString('base64url'),
            },
          ],
        },
      ],
      workerInstallations: [
        {
          installationId: INSTALLATION_ID,
          sessionKeys: [
            {
              keyId: SESSION_KEY_ID,
              status: 'ACTIVE',
              encryptionKey: SESSION_KEY.toString('base64url'),
            },
          ],
        },
      ],
    }),
    { encoding: 'utf8', mode: 0o600 },
  );
  return { path, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

function openWorkerMessage(input: {
  nonce: string;
  ciphertext: string;
  authTag: string;
  aad: Parameters<typeof brokerSensitiveMessageAadBytes>[0];
}): string {
  const decipher = createDecipheriv(
    'aes-256-gcm',
    SESSION_KEY,
    Buffer.from(input.nonce, 'base64url'),
  );
  decipher.setAAD(brokerSensitiveMessageAadBytes(input.aad));
  decipher.setAuthTag(Buffer.from(input.authTag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(input.ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

function sealWorkerAssistant(plaintext: string) {
  const aad = {
    protocol: 'combo.creator-broker/1' as const,
    schemaVersion: 1 as const,
    envelopeType: 'invocation.succeeded' as const,
    messageId: SUCCEEDED_MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    invocationId: INVOCATION_ID,
    workerSessionId: WORKER_SESSION_ID,
    role: 'ASSISTANT' as const,
    keyId: SESSION_KEY_ID,
  };
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', SESSION_KEY, nonce);
  cipher.setAAD(brokerSensitiveMessageAadBytes(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const nonceText = nonce.toString('base64url');
  const ciphertextText = ciphertext.toString('base64url');
  const authTagText = authTag.toString('base64url');
  return {
    algorithm: 'aes-256-gcm/v1' as const,
    keyScope: 'worker-session' as const,
    keyId: SESSION_KEY_ID,
    nonce: nonceText,
    ciphertext: ciphertextText,
    authTag: authTagText,
    cipherDigest: brokerSensitiveMessageCipherDigest(nonceText, ciphertextText, authTagText),
    aad,
    aadDigest: brokerSensitiveMessageAadDigest(aad),
    aadVersion: 1 as const,
  };
}

describe('R3 Runtime and Gateway mounted-keyring boundary', () => {
  it('round-trips USER and ASSISTANT plaintext only through the two real adapters', async () => {
    const fixture = mountedKeyring();
    try {
      const runtime = loadTestConsumerMessageAuthority(fixture.path);
      const gateway = loadGatewayTestKeyring(fixture.path);
      const signal = AbortSignal.timeout(5_000);
      const userPlaintext = 'runtime durable user message -> gateway worker session';
      const bound = await runtime.bindUserMessage({
        creatorId: OWNER_ID,
        text: userPlaintext,
        signal,
      });
      const durableUser = await bound.seal({
        conversationId: CONVERSATION_ID,
        messageId: USER_MESSAGE_ID,
        signal,
      });
      const durableUserAad = {
        schemaVersion: 1 as const,
        ownerId: OWNER_ID,
        conversationId: CONVERSATION_ID,
        messageId: USER_MESSAGE_ID,
        role: 'USER' as const,
      };
      const workerUser = await gateway.sealUserMessage({
        creatorId: OWNER_ID,
        installationId: INSTALLATION_ID,
        durableMessage: durableUser,
        durableAad: durableUserAad,
        command: {
          messageId: PREPARE_COMMAND_ID,
          conversationId: CONVERSATION_ID,
          invocationId: INVOCATION_ID,
          workerSessionId: WORKER_SESSION_ID,
        },
        signal,
      });
      expect(workerUser.aad).toMatchObject({
        messageId: PREPARE_COMMAND_ID,
        conversationId: CONVERSATION_ID,
        invocationId: INVOCATION_ID,
        workerSessionId: WORKER_SESSION_ID,
        role: 'USER',
      });
      expect(openWorkerMessage(workerUser)).toBe(userPlaintext);

      const assistantPlaintext = 'worker result -> gateway durable assistant -> runtime open';
      const durableAssistantAad = {
        schemaVersion: 1 as const,
        ownerId: OWNER_ID,
        conversationId: CONVERSATION_ID,
        messageId: ASSISTANT_MESSAGE_ID,
        role: 'ASSISTANT' as const,
      };
      const sealedAssistant = await gateway.sealAssistantMessage({
        resultCiphertext: sealWorkerAssistant(assistantPlaintext),
        aad: durableAssistantAad,
        signal,
        installationId: INSTALLATION_ID,
        workerSessionId: WORKER_SESSION_ID,
      });
      expect(sealedAssistant.verifiedResultDigest).toBe(
        domainSeparatedHmacSha256('combo:vnext:result:v1', DIGEST_KEY, {
          text: assistantPlaintext,
        }),
      );
      await expect(
        runtime.openMessage({
          encrypted: sealedAssistant.encryptedMessage,
          aad: durableAssistantAad,
          signal,
        }),
      ).resolves.toBe(assistantPlaintext);
    } finally {
      fixture.cleanup();
    }
  });
});
