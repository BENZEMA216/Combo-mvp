import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

import {
  BROKER_MAX_SENSITIVE_CIPHERTEXT_BYTES,
  BrokerEnvelopeSchema,
  ExecutionCapabilitySchema,
  WorkerConversationReadyFactSchema,
  brokerSensitiveMessageAadBytes,
  brokerSensitiveMessageAadDigest,
  brokerSensitiveMessageCipherDigest,
  canonicalSha256,
  canonicalizeJson,
  WorkerInterruptReceiptSchema,
  workerInterruptReceiptDigest,
  executionCapabilitySigningBytes,
  executionCapabilityDigest,
  workerConversationReadyFactDigest,
  validateExecutionCapabilityBinding,
  type BrokerEnvelope,
  type BrokerSensitiveMessage,
  type ExecutionCapability,
  type ExpectedExecutionCapabilityBinding,
} from '@cb/creator-agent-protocol';
import {
  consumeSequence,
  initialSequenceCursor,
  restoreSequenceCursor,
  serializeSequenceCursor,
} from '@cb/creator-agent-broker-journal';
import { afterEach, describe, expect, it } from 'vitest';

import {
  SqliteWorkerBrokerDurableTransport,
  WORKER_TRANSPORT_SCHEMA_VERSION,
  type DurableInboundCommandCandidate,
  type NewWorkerJournalAuthorization,
  type SqliteWorkerTransportOptions,
} from './sqlite-durable-transport.js';
import {
  type SqliteWorkerInvocationJournal,
  assertWorkerConversationReadyIntegrity,
  assertWorkerInvocationIntegrity,
  LocalInvocationPromptCiphertextSchema,
  LocalInvocationResultCiphertextSchema,
  localInvocationPromptAadBytes,
  localInvocationPromptAadDigest,
  localInvocationPromptCipherDigest,
  localInvocationResultAadBytes,
  localInvocationResultAadDigest,
  localInvocationResultCipherDigest,
  sqliteInvocationRowDigest,
  workerInvocationAuthorityRows,
  type BrokerResultReencryptAuthorityPort,
  type CloudInvocationAckAuthorityPort,
  type HostDispatchReceiptAuthorityPort,
  type HostInterruptExpectedBinding,
  type LocalInvocationPromptAad,
  type LocalInvocationPromptCiphertext,
  type LocalPromptAeadAuthorityPort,
  type LocalInvocationResultAad,
  type LocalInvocationResultCiphertext,
  type LocalResultAeadAuthorityPort,
  type OpaqueInvocationCloudAckReference,
  type PendingConversationReadyFactReference,
  type PendingInvocationFactReference,
  type ReadyConversationAuthorityPort,
  type ReadyConversationExpectedBinding,
  type TrustedHostDispatchPort,
  type WorkerInvocationCapabilityAuthorityPort,
} from './sqlite-invocation-journal.js';
import type { DurableBrokerConnection } from './worker-broker-client.js';
import { downgradeToLegacyV3 } from '../test-support/sqlite-legacy-v3.js';
import { downgradeToLegacyV4 } from '../test-support/sqlite-legacy-v4.js';

const { DatabaseSync: SqliteDatabase } = createRequire(import.meta.url)('node:sqlite') as {
  readonly DatabaseSync: typeof DatabaseSync;
};
const OWNER = 'invocation-owner-token-0123456789';
const SHA = (character: string) => character.repeat(64);
const HMAC = (character: string) => `hmac-sha256:${character.repeat(64)}`;
const temporaryDirectories = new Set<string>();

afterEach(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.clear();
});

describe('same-file SQLite Worker Invocation Journal v5', () => {
  it('shares the exact Broker ciphertext byte authority with local Prompt and Result storage', () => {
    const nonce = Buffer.alloc(12, 0x11).toString('base64url');
    const authTag = Buffer.alloc(16, 0x22).toString('base64url');
    const ciphertext = Buffer.alloc(BROKER_MAX_SENSITIVE_CIPHERTEXT_BYTES, 0x33).toString(
      'base64url',
    );
    const promptAad: LocalInvocationPromptAad = {
      schemaVersion: 1,
      installationId: uuid(70_001),
      invocationId: uuid(70_002),
      conversationId: uuid(70_003),
      agentVersionDigest: SHA('a'),
      role: 'USER',
    };
    const prompt = {
      algorithm: 'aes-256-gcm/v1' as const,
      keyScope: 'worker-keychain' as const,
      keyId: 'worker-keychain-prompt-001',
      nonce,
      ciphertext,
      authTag,
      cipherDigest: localInvocationPromptCipherDigest(nonce, ciphertext, authTag),
      requestDigest: HMAC('d'),
      aad: promptAad,
      aadDigest: localInvocationPromptAadDigest(promptAad),
      aadVersion: 1 as const,
    };
    expect(LocalInvocationPromptCiphertextSchema.parse(prompt)).toEqual(prompt);

    const resultAad: LocalInvocationResultAad = {
      schemaVersion: 1,
      installationId: promptAad.installationId,
      invocationId: promptAad.invocationId,
      conversationId: promptAad.conversationId,
      agentVersionDigest: promptAad.agentVersionDigest,
      role: 'ASSISTANT',
    };
    const result = {
      algorithm: 'aes-256-gcm/v1' as const,
      keyScope: 'worker-keychain' as const,
      keyId: 'worker-keychain-result-001',
      nonce,
      ciphertext,
      authTag,
      cipherDigest: localInvocationResultCipherDigest(nonce, ciphertext, authTag),
      resultDigest: HMAC('e'),
      aad: resultAad,
      aadDigest: localInvocationResultAadDigest(resultAad),
      aadVersion: 1 as const,
    };
    expect(LocalInvocationResultCiphertextSchema.parse(result)).toEqual(result);

    const oversizedCiphertext = Buffer.alloc(
      BROKER_MAX_SENSITIVE_CIPHERTEXT_BYTES + 1,
      0x33,
    ).toString('base64url');
    expect(() => localInvocationPromptCipherDigest(nonce, oversizedCiphertext, authTag)).toThrow();
    expect(() => localInvocationResultCipherDigest(nonce, oversizedCiphertext, authTag)).toThrow();
    expect(() =>
      LocalInvocationPromptCiphertextSchema.parse({
        ...prompt,
        ciphertext: oversizedCiphertext,
      }),
    ).toThrow();
    expect(() =>
      LocalInvocationResultCiphertextSchema.parse({
        ...result,
        ciphertext: oversizedCiphertext,
      }),
    ).toThrow();
  });

  it('atomically binds READY, its immutable fact, and its logical outbox', async () => {
    let failReadyCommit = true;
    const fixture = await createInvocationFixture(99, {
      faultInjector(point) {
        if (failReadyCommit && point === 'invocation_bind_ready_conversation.before_commit') {
          throw new Error('fault-ready-before-commit');
        }
      },
    });
    const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    const input = {
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.openReference,
      evidence: { token: 'sandbox-ready' },
      signal: new AbortController().signal,
    };

    await expect(journal.bindReadyConversation(input)).rejects.toThrow('fault-ready-before-commit');
    expect(queryCount(fixture.filename, 'local_conversations')).toBe(0);
    expect(queryCount(fixture.filename, 'local_conversation_ready_facts')).toBe(0);
    expect(queryCount(fixture.filename, 'local_conversation_ready_outbox')).toBe(0);

    failReadyCommit = false;
    const first = await journal.bindReadyConversation(input);
    const replay = await journal.bindReadyConversation(input);
    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      sourceEventId: fixture.openReference.messageId,
      openCommandId: fixture.openReference.messageId,
      cloudState: 'PENDING',
    });
    expect(queryCount(fixture.filename, 'local_conversations')).toBe(1);
    expect(queryCount(fixture.filename, 'local_conversation_ready_facts')).toBe(1);
    expect(queryCount(fixture.filename, 'local_conversation_ready_outbox')).toBe(1);
    expect(
      queryCountWhere(
        fixture.filename,
        'local_conversation_ready_facts',
        `source_event_id = open_command_id AND source_event_id = '${fixture.openReference.messageId}'`,
      ),
    ).toBe(1);
  });

  it('commits logical READY at full wire capacity and pumps it after one exact credit release', async () => {
    const fixture = await createInvocationFixture(98, { maxOutboxRows: 8 });
    const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    const signal = new AbortController().signal;
    let pingSeed = 0;
    while (
      queryCountWhere(
        fixture.filename,
        'transport_outbox',
        `state IN ('UNBOUND', 'PENDING', 'WRITTEN')`,
      ) < 7
    ) {
      const ping = BrokerEnvelopeSchema.parse({
        protocol: 'combo.creator-broker/1',
        schemaVersion: 1,
        kind: 'command',
        type: 'ping',
        messageId: uuid(98_700 + pingSeed),
        correlationId: fixture.state.connectionId,
        connectionId: fixture.state.connectionId,
        sequence: nextSequence(fixture.state),
        sentAt: fixture.state.leaseGrantedAt,
        expiresAt: fixture.state.leaseExpiresAt,
        lease: fixture.state.lease,
        body: { nonce: Buffer.alloc(16, pingSeed + 1).toString('base64url') },
      });
      fixture.state = await commitCommand(
        fixture.adapter,
        fixture.installationId,
        fixture.state,
        ping,
      );
      pingSeed += 1;
      if (pingSeed > 8) throw new Error('wire-capacity-fill-stalled');
    }
    await journal.bindReadyConversation({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.openReference,
      evidence: { token: 'sandbox-ready' },
      signal,
    });
    expect(queryCount(fixture.filename, 'local_conversation_ready_facts')).toBe(1);
    expect(queryCount(fixture.filename, 'local_conversation_ready_outbox')).toBe(1);
    expect(queryCount(fixture.filename, 'local_conversation_ready_deliveries')).toBe(0);
    expect(
      queryCountWhere(
        fixture.filename,
        'local_consumed_commands',
        `command_id = '${fixture.openReference.messageId}' AND disposition = 'APPLIED'`,
      ),
    ).toBe(1);
    const outbound = await fixture.adapter.readOutbound({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      connectionId: fixture.state.connectionId,
      limit: 16,
      signal,
    });
    const released = outbound.find((envelope) => envelope.type === 'lease.accepted');
    if (released === undefined) throw new Error('missing-credit-release-target');
    fixture.state = await commitCommand(
      fixture.adapter,
      fixture.installationId,
      fixture.state,
      readyCloudAckEnvelope(fixture, released.messageId, 'APPLIED', 98_900),
    );
    await expect(
      fixture.adapter.replayPendingConversationReady({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        connectionId: fixture.state.connectionId,
        signal,
      }),
    ).resolves.toEqual({ enqueued: 1, remaining: false });
    expect(queryCount(fixture.filename, 'local_conversation_ready_deliveries')).toBe(1);
  });

  it.each(['APPLIED', 'IDEMPOTENT_REPLAY', 'SECURITY_BLOCK'] as const)(
    're-envelopes one immutable READY fact and records only exact durable %s ACK evidence',
    async (decision) => {
      const fixture = await createInvocationFixture(
        decision === 'APPLIED' ? 97 : decision === 'IDEMPOTENT_REPLAY' ? 96 : 95,
      );
      const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
      const signal = new AbortController().signal;
      const ready = await journal.bindReadyConversation({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        command: fixture.openReference,
        evidence: { token: 'sandbox-ready' },
        signal,
      });
      const pending = await journal.readPendingConversationReadyFacts({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        limit: 10,
        signal,
      });
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        sourceEventId: fixture.openReference.messageId,
        conversationId: fixture.conversationId,
        factDigest: ready.factDigest,
      });
      await enqueueAndCommitReadyCloudAck(
        fixture.adapter,
        journal,
        fixture,
        pending[0]!,
        decision,
        decision === 'APPLIED' ? 97_000 : decision === 'IDEMPOTENT_REPLAY' ? 96_000 : 95_000,
      );
      const expectedState = decision === 'SECURITY_BLOCK' ? 'CLOUD_REJECTED' : 'CLOUD_COMMITTED';
      expect(queryCount(fixture.filename, 'local_conversation_ready_facts')).toBe(1);
      expect(queryCount(fixture.filename, 'local_conversation_ready_outbox')).toBe(1);
      expect(queryCount(fixture.filename, 'local_conversation_ready_outbox_receipts')).toBe(1);
      expect(
        queryCountWhere(
          fixture.filename,
          'local_conversations',
          `ready_cloud_state = '${expectedState}'`,
        ),
      ).toBe(1);
      expect(
        await journal.readPendingConversationReadyFacts({
          installationId: fixture.installationId,
          ownerToken: OWNER,
          limit: 10,
          signal,
        }),
      ).toHaveLength(0);
      if (decision === 'SECURITY_BLOCK') {
        await expect(
          journal.prepare({
            installationId: fixture.installationId,
            ownerToken: OWNER,
            command: fixture.prepareReference,
            signal,
          }),
        ).rejects.toMatchObject({ code: 'CONVERSATION_NOT_READY' });
        expect(queryCount(fixture.filename, 'local_invocations')).toBe(0);
        expect(queryCount(fixture.filename, 'local_invocation_events')).toBe(0);
        expect(queryCount(fixture.filename, 'local_invocation_outbox')).toBe(0);
        expect(fixture.authorities.hostDispatchCalls.count).toBe(0);
        expect(fixture.authorities.hostReceiptCalls.count).toBe(0);
      }
      fixture.adapter.close();
      const reopened = new SqliteWorkerBrokerDurableTransport({ filename: fixture.filename });
      expect(() => reopened.createInvocationJournal(fixture.authorities.options)).not.toThrow();
      reopened.close();
    },
  );

  it('rejects a wrong original installation before Sandbox READY authority or Host', async () => {
    const fixture = await createInvocationFixture(89, {}, { readyOnly: true });
    let readyEvidenceVerifications = 0;
    const journal = fixture.adapter.createInvocationJournal({
      ...fixture.authorities.options,
      readyConversationAuthority: {
        verify(input, expected, now) {
          readyEvidenceVerifications += 1;
          return fixture.authorities.options.readyConversationAuthority.verify(
            input,
            expected,
            now,
          );
        },
      },
    });
    const signal = new AbortController().signal;
    const conversationId = uuid(89_900);
    const wrongInstallationOpen = BrokerEnvelopeSchema.parse({
      ...fixture.openEnvelope,
      messageId: uuid(89_901),
      correlationId: conversationId,
      sequence: nextSequence(fixture.state),
      body: {
        ...fixture.openEnvelope.body,
        conversationId,
        openAuthority: {
          ...fixture.openEnvelope.body.openAuthority,
          installationId: uuid(89_902),
        },
      },
    });
    fixture.state = await commitCommand(
      fixture.adapter,
      fixture.installationId,
      fixture.state,
      wrongInstallationOpen,
    );
    const reference = commandReferenceFromEnvelope(wrongInstallationOpen);
    const before = queryDurableStateSnapshot(fixture.filename);

    await expect(
      journal.bindReadyConversation({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        command: reference,
        evidence: { token: 'must-not-reach-ready-authority' },
        signal,
      }),
    ).rejects.toMatchObject({ code: 'CONVERSATION_CONFLICT' });
    expect(queryDurableStateSnapshot(fixture.filename)).toEqual(before);
    expect(readyEvidenceVerifications).toBe(0);
    expect(fixture.authorities.hostDispatchCalls.count).toBe(0);
  });

  it('rejects a stale outer transport before Sandbox READY authority or Host', async () => {
    const fixture = await createInvocationFixture(90, {}, { readyOnly: true });
    let readyEvidenceVerifications = 0;
    const journal = fixture.adapter.createInvocationJournal({
      ...fixture.authorities.options,
      readyConversationAuthority: {
        verify(input, expected, now) {
          readyEvidenceVerifications += 1;
          return fixture.authorities.options.readyConversationAuthority.verify(
            input,
            expected,
            now,
          );
        },
      },
    });
    const signal = new AbortController().signal;
    await activateReplacementLease(fixture, 90_900);
    const before = queryDurableStateSnapshot(fixture.filename);

    await expect(
      journal.bindReadyConversation({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        command: fixture.openReference,
        evidence: { token: 'must-not-reach-ready-authority' },
        signal,
      }),
    ).rejects.toMatchObject({ code: 'STALE_LEASE' });
    expect(queryDurableStateSnapshot(fixture.filename)).toEqual(before);
    expect(readyEvidenceVerifications).toBe(0);
    expect(fixture.authorities.hostDispatchCalls.count).toBe(0);
  });

  it.each([
    { label: 'PENDING', decision: null, cloudState: 'PENDING', seed: 84 },
    {
      label: 'CLOUD_COMMITTED',
      decision: 'APPLIED',
      cloudState: 'CLOUD_COMMITTED',
      seed: 83,
    },
    {
      label: 'CLOUD_REJECTED',
      decision: 'SECURITY_BLOCK',
      cloudState: 'CLOUD_REJECTED',
      seed: 82,
    },
  ] as const)(
    'rebinds an exact $label READY on a same-Deployment replacement without replacing original authority',
    async ({ decision, cloudState, seed }) => {
      const fixture = await createInvocationFixture(seed);
      let readyEvidenceVerifications = 0;
      const journal = fixture.adapter.createInvocationJournal({
        ...fixture.authorities.options,
        readyConversationAuthority: {
          verify(input, expected, now) {
            readyEvidenceVerifications += 1;
            return fixture.authorities.options.readyConversationAuthority.verify(
              input,
              expected,
              now,
            );
          },
        },
      });
      const signal = new AbortController().signal;
      const originalReady = await journal.bindReadyConversation({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        command: fixture.openReference,
        evidence: { token: 'sandbox-ready' },
        signal,
      });
      expect(originalReady).toMatchObject(fixture.openEnvelope.body.openAuthority);
      if (decision !== null) {
        const [pending] = await journal.readPendingConversationReadyFacts({
          installationId: fixture.installationId,
          ownerToken: OWNER,
          limit: 1,
          signal,
        });
        if (pending === undefined) throw new Error('missing-ready-for-terminal-replay');
        fixture.state = await enqueueAndCommitReadyCloudAck(
          fixture.adapter,
          journal,
          fixture,
          pending,
          decision,
          seed * 10_000,
        );
      }
      expect(queryCount(fixture.filename, 'local_conversation_ready_terminal_tombstones')).toBe(0);
      expect(readyEvidenceVerifications).toBe(1);

      const replacement = await activateReplacementLease(
        fixture,
        seed * 10_000 + 10,
        fixture.openEnvelope.lease.deploymentId,
      );
      const replayedOpen = BrokerEnvelopeSchema.parse({
        ...fixture.openEnvelope,
        connectionId: replacement.connectionId,
        sequence: nextSequence(replacement),
        sentAt: replacement.leaseGrantedAt,
        expiresAt: replacement.leaseExpiresAt,
        lease: replacement.lease,
      }) as Extract<BrokerEnvelope, { type: 'conversation.open' }>;
      const current = await commitCommand(
        fixture.adapter,
        fixture.installationId,
        replacement,
        replayedOpen,
      );
      const replayReference = await commandReference(
        fixture.adapter,
        fixture.installationId,
        current,
        'conversation.open',
      );
      const originalBusinessState = queryReadyBusinessStateSnapshot(fixture.filename);
      await expect(
        journal.bindReadyConversation({
          installationId: fixture.installationId,
          ownerToken: OWNER,
          command: replayReference,
          evidence: { token: 'must-not-be-verified-on-durable-replay' },
          signal,
        }),
      ).resolves.toEqual({ ...originalReady, cloudState });
      expect(queryReadyBusinessStateSnapshot(fixture.filename)).toEqual(originalBusinessState);
      expect(
        queryCountWhere(
          fixture.filename,
          'transport_inbound_frames',
          `connection_id = '${current.connectionId}' AND sequence = '${replayedOpen.sequence}' AND effect_state = 'APPLIED'`,
        ),
      ).toBe(1);
      expect(readyEvidenceVerifications).toBe(1);
      expect(fixture.authorities.hostDispatchCalls.count).toBe(0);

      fixture.state = current;
      const crossDeploymentId = uuid(seed * 10_000 + 20);
      const crossDeployment = await activateReplacementLease(
        fixture,
        seed * 10_000 + 21,
        crossDeploymentId,
      );
      const crossDeploymentOpen = BrokerEnvelopeSchema.parse({
        ...fixture.openEnvelope,
        connectionId: crossDeployment.connectionId,
        sequence: nextSequence(crossDeployment),
        sentAt: crossDeployment.leaseGrantedAt,
        expiresAt: crossDeployment.leaseExpiresAt,
        lease: crossDeployment.lease,
        body: {
          ...fixture.openEnvelope.body,
          openAuthority: {
            ...fixture.openEnvelope.body.openAuthority,
            deploymentId: crossDeploymentId,
          },
        },
      }) as Extract<BrokerEnvelope, { type: 'conversation.open' }>;
      const beforeCrossDeploymentRejection = queryDurableStateSnapshot(fixture.filename);
      await expect(
        commitCommand(
          fixture.adapter,
          fixture.installationId,
          crossDeployment,
          crossDeploymentOpen,
        ),
      ).rejects.toMatchObject({ code: 'SEQUENCE_CONFLICT' });
      expect(queryDurableStateSnapshot(fixture.filename)).toEqual(beforeCrossDeploymentRejection);
      expect(readyEvidenceVerifications).toBe(1);

      const changedOpen = BrokerEnvelopeSchema.parse({
        ...crossDeploymentOpen,
        sequence: nextSequence(crossDeployment),
        body: { ...crossDeploymentOpen.body, snapshotDigest: SHA('c') },
      });
      const beforeChangedBodyRejection = queryDurableStateSnapshot(fixture.filename);
      await expect(
        commitCommand(fixture.adapter, fixture.installationId, crossDeployment, changedOpen),
      ).rejects.toMatchObject({ code: 'SEQUENCE_CONFLICT' });
      expect(queryDurableStateSnapshot(fixture.filename)).toEqual(beforeChangedBodyRejection);
      expect(readyEvidenceVerifications).toBe(1);
      expect(fixture.authorities.hostDispatchCalls.count).toBe(0);
    },
  );

  it.each(['APPLIED', 'IDEMPOTENT_REPLAY', 'SECURITY_BLOCK'] as const)(
    'compacts terminal READY %s evidence, accepts exact current-outer replays, and advances the cursor',
    async (decision) => {
      let transportNow = Date.now();
      const seed = decision === 'APPLIED' ? 87 : decision === 'IDEMPOTENT_REPLAY' ? 86 : 85;
      const fixture = await createInvocationFixture(
        seed,
        { maxConnections: 2, now: () => transportNow },
        { readyOnly: true },
      );
      const signal = new AbortController().signal;
      let readyEvidenceVerifications = 0;
      const journalOptions = {
        ...fixture.authorities.options,
        readyConversationAuthority: {
          verify(input: unknown, expected: ReadyConversationExpectedBinding, now: Date) {
            readyEvidenceVerifications += 1;
            return fixture.authorities.options.readyConversationAuthority.verify(
              input,
              expected,
              now,
            );
          },
        },
      };
      const journal = fixture.adapter.createInvocationJournal(journalOptions);
      const ready = await journal.bindReadyConversation({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        command: fixture.openReference,
        evidence: { token: 'sandbox-ready' },
        signal,
      });
      expect(readyEvidenceVerifications).toBe(1);
      const [pending] = await journal.readPendingConversationReadyFacts({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        limit: 1,
        signal,
      });
      if (pending === undefined) throw new Error('missing-ready-pending');
      const originalConnectionId = fixture.state.connectionId;
      await fixture.adapter.releaseConnection({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        connectionId: originalConnectionId,
        signal,
      });
      const retainedConnection = queryConnectionSnapshot(fixture.filename, originalConnectionId);
      const fillerConnection = await activateReplacementLease(
        fixture,
        seed * 10_000 + 3,
        fixture.state.lease.deploymentId,
        transportNow,
      );
      fixture.state = fillerConnection;
      await expect(
        fixture.adapter.replayPendingConversationReady({
          installationId: fixture.installationId,
          ownerToken: OWNER,
          connectionId: fillerConnection.connectionId,
          signal,
        }),
      ).resolves.toEqual({ enqueued: 1, remaining: false });
      const fillerOutbound = await fixture.adapter.readOutbound({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        connectionId: fillerConnection.connectionId,
        limit: 16,
        signal,
      });
      const delivery = fillerOutbound.find((envelope) => envelope.type === 'conversation.ready');
      if (delivery === undefined) throw new Error('missing-ready-filler-delivery');
      const originalAck = readyCloudAckEnvelope(
        fixture,
        delivery.messageId,
        decision,
        seed * 10_000 + 2,
      );
      fixture.state = await commitCommand(
        fixture.adapter,
        fixture.installationId,
        fixture.state,
        originalAck,
      );
      expect(queryCount(fixture.filename, 'local_conversation_ready_terminal_tombstones')).toBe(0);
      expect(queryCount(fixture.filename, 'local_conversation_ready_outbox_receipts')).toBe(1);
      expect(queryCount(fixture.filename, 'local_invocations')).toBe(0);
      expect(fixture.authorities.hostDispatchCalls.count).toBe(0);
      const retainedFiller = queryConnectionSnapshot(
        fixture.filename,
        fillerConnection.connectionId,
      );
      const blockedReplacementSeed = seed * 10_000 + 5;
      await expect(
        activateReplacementLease(
          fixture,
          blockedReplacementSeed,
          fixture.state.lease.deploymentId,
          transportNow,
          2n,
        ),
      ).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' });
      expect(queryConnectionSnapshot(fixture.filename, originalConnectionId)).toEqual(
        retainedConnection,
      );
      expect(queryConnectionSnapshot(fixture.filename, fillerConnection.connectionId)).toEqual(
        retainedFiller,
      );
      expect(
        queryCountWhere(
          fixture.filename,
          'transport_connections',
          `connection_id = '${uuid(blockedReplacementSeed)}'`,
        ),
      ).toBe(0);
      transportNow += 8 * 24 * 60 * 60 * 1_000;
      await fixture.adapter.acquireInstallation({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        signal,
      });
      await fixture.adapter.pruneRetained({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        signal,
      });
      expect(queryCount(fixture.filename, 'local_conversation_ready_terminal_tombstones')).toBe(1);
      expect(queryCount(fixture.filename, 'local_conversation_ready_facts')).toBe(0);
      expect(queryCount(fixture.filename, 'local_conversation_ready_outbox')).toBe(0);
      expect(queryCount(fixture.filename, 'local_conversation_ready_deliveries')).toBe(0);
      expect(queryCount(fixture.filename, 'local_conversation_ready_outbox_receipts')).toBe(0);
      expect(
        queryCountWhere(
          fixture.filename,
          'transport_inbound_frames',
          `message_id IN ('${fixture.openEnvelope.messageId}', '${originalAck.messageId}')`,
        ),
      ).toBe(0);
      expect(
        queryCountWhere(
          fixture.filename,
          'transport_outbox',
          `response_to_message_id = '${fixture.openEnvelope.messageId}'`,
        ),
      ).toBe(0);
      expect(queryCount(fixture.filename, 'transport_connections')).toBe(1);
      const compactedDatabase = new SqliteDatabase(fixture.filename, { readOnly: true });
      assertWorkerConversationReadyIntegrity(compactedDatabase);
      compactedDatabase.close();

      fixture.adapter.close();
      const reopened = new SqliteWorkerBrokerDurableTransport({
        filename: fixture.filename,
        maxConnections: 2,
        now: () => transportNow,
      });
      fixture.adapter = reopened;
      await reopened.acquireInstallation({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        signal,
      });
      expect(reopened.inspectPragmas().foreignKeys).toBe(1);
      expect(queryForeignKeyTargets(fixture.filename, 'local_conversations')).not.toContain(
        'transport_inbound_frames',
      );
      expect(queryForeignKeyTargets(fixture.filename, 'local_invocations')).toContain(
        'local_conversations',
      );
      expect(
        queryForeignKeyTargets(fixture.filename, 'local_conversation_ready_terminal_tombstones'),
      ).toEqual(['local_conversations']);
      const recoveredJournal = reopened.createInvocationJournal(journalOptions);
      const replacement = await activateReplacementLease(
        fixture,
        seed * 10_000 + 10,
        fixture.state.lease.deploymentId,
        transportNow,
        2n,
      );
      expect(queryCount(fixture.filename, 'transport_connections')).toBe(1);

      const reusedOpenAsPing = BrokerEnvelopeSchema.parse({
        protocol: 'combo.creator-broker/1',
        schemaVersion: 1,
        kind: 'command',
        type: 'ping',
        messageId: fixture.openEnvelope.messageId,
        correlationId: replacement.connectionId,
        connectionId: replacement.connectionId,
        sequence: nextSequence(replacement),
        sentAt: replacement.leaseGrantedAt,
        expiresAt: replacement.leaseExpiresAt,
        lease: replacement.lease,
        body: { nonce: Buffer.alloc(16, seed + 1).toString('base64url') },
      });
      const reusedOpenAsAck = BrokerEnvelopeSchema.parse({
        ...originalAck,
        messageId: fixture.openEnvelope.messageId,
        connectionId: replacement.connectionId,
        sequence: nextSequence(replacement),
        sentAt: replacement.leaseGrantedAt,
        expiresAt: replacement.leaseExpiresAt,
        lease: replacement.lease,
      });
      const reusedOpenAsRevoke = BrokerEnvelopeSchema.parse({
        protocol: 'combo.creator-broker/1',
        schemaVersion: 1,
        kind: 'command',
        type: 'lease.revoke',
        messageId: fixture.openEnvelope.messageId,
        correlationId: replacement.connectionId,
        connectionId: replacement.connectionId,
        sequence: nextSequence(replacement),
        sentAt: replacement.leaseGrantedAt,
        expiresAt: replacement.leaseExpiresAt,
        lease: replacement.lease,
        body: { reason: 'SECURITY', effectiveAt: replacement.leaseGrantedAt },
      });
      const reusedAckAsPing = BrokerEnvelopeSchema.parse({
        ...reusedOpenAsPing,
        messageId: originalAck.messageId,
        body: { nonce: Buffer.alloc(16, seed + 2).toString('base64url') },
      });
      const reusedAckAsOpen = BrokerEnvelopeSchema.parse({
        ...fixture.openEnvelope,
        messageId: originalAck.messageId,
        connectionId: replacement.connectionId,
        sequence: nextSequence(replacement),
        sentAt: replacement.leaseGrantedAt,
        expiresAt: replacement.leaseExpiresAt,
        lease: replacement.lease,
      });
      const reusedAckAsRevoke = BrokerEnvelopeSchema.parse({
        ...reusedOpenAsRevoke,
        messageId: originalAck.messageId,
      });
      const beforeIdentityConflicts = queryDurableStateSnapshot(fixture.filename);
      for (const conflictingIdentity of [
        reusedOpenAsPing,
        reusedOpenAsAck,
        reusedOpenAsRevoke,
        reusedAckAsPing,
        reusedAckAsOpen,
        reusedAckAsRevoke,
      ]) {
        await expect(
          commitCommand(reopened, fixture.installationId, replacement, conflictingIdentity),
        ).rejects.toMatchObject({ code: 'SEQUENCE_CONFLICT' });
        expect(queryDurableStateSnapshot(fixture.filename)).toEqual(beforeIdentityConflicts);
      }

      const replayedOpen = BrokerEnvelopeSchema.parse({
        ...fixture.openEnvelope,
        connectionId: replacement.connectionId,
        sequence: nextSequence(replacement),
        sentAt: replacement.leaseGrantedAt,
        expiresAt: replacement.leaseExpiresAt,
        lease: replacement.lease,
      }) as Extract<BrokerEnvelope, { type: 'conversation.open' }>;
      await expect(
        reopened.replayInbound({
          installationId: fixture.installationId,
          ownerToken: OWNER,
          connectionId: replacement.connectionId,
          envelope: replayedOpen,
          canonicalDigest: canonicalSha256(replayedOpen),
          signal,
        }),
      ).resolves.toBe('NOT_FOUND');
      let current = await commitCommand(
        reopened,
        fixture.installationId,
        replacement,
        replayedOpen,
      );
      const replayedOpenReference = await commandReference(
        reopened,
        fixture.installationId,
        current,
        'conversation.open',
      );
      await expect(
        recoveredJournal.bindReadyConversation({
          installationId: fixture.installationId,
          ownerToken: OWNER,
          command: replayedOpenReference,
          evidence: { token: 'must-not-be-verified-on-compacted-replay' },
          signal,
        }),
      ).resolves.toMatchObject({
        sourceEventId: fixture.openEnvelope.messageId,
        factDigest: ready.factDigest,
        cloudState: decision === 'SECURITY_BLOCK' ? 'CLOUD_REJECTED' : 'CLOUD_COMMITTED',
      });
      expect(readyEvidenceVerifications).toBe(1);
      expect(
        queryCountWhere(
          fixture.filename,
          'transport_inbound_frames',
          `connection_id = '${current.connectionId}' AND sequence = '${replayedOpen.sequence}' AND effect_state = 'APPLIED'`,
        ),
      ).toBe(1);
      expect(fixture.authorities.hostDispatchCalls.count).toBe(0);

      const changedOpen = {
        ...replayedOpen,
        body: { ...replayedOpen.body, snapshotDigest: SHA('e') },
      };
      await expect(
        reopened.replayInbound({
          installationId: fixture.installationId,
          ownerToken: OWNER,
          connectionId: current.connectionId,
          envelope: changedOpen,
          canonicalDigest: canonicalSha256(changedOpen),
          signal,
        }),
      ).rejects.toMatchObject({ code: 'SEQUENCE_CONFLICT' });

      const replayedAck = BrokerEnvelopeSchema.parse({
        ...originalAck,
        connectionId: current.connectionId,
        sequence: nextSequence(current),
        sentAt: current.leaseGrantedAt,
        expiresAt: current.leaseExpiresAt,
        lease: current.lease,
      }) as Extract<BrokerEnvelope, { kind: 'ack'; type: 'message.ack' }>;
      await expect(
        reopened.replayInbound({
          installationId: fixture.installationId,
          ownerToken: OWNER,
          connectionId: current.connectionId,
          envelope: replayedAck,
          canonicalDigest: canonicalSha256(replayedAck),
          signal,
        }),
      ).resolves.toBe('NOT_FOUND');
      current = await commitCommand(reopened, fixture.installationId, current, replayedAck);
      const changedAck = BrokerEnvelopeSchema.parse({
        ...replayedAck,
        body: {
          ...replayedAck.body,
          decision: decision === 'APPLIED' ? 'IDEMPOTENT_REPLAY' : 'APPLIED',
        },
      });
      await expect(
        reopened.replayInbound({
          installationId: fixture.installationId,
          ownerToken: OWNER,
          connectionId: current.connectionId,
          envelope: changedAck,
          canonicalDigest: canonicalSha256(changedAck),
          signal,
        }),
      ).rejects.toMatchObject({ code: 'SEQUENCE_CONFLICT' });

      const ping = BrokerEnvelopeSchema.parse({
        protocol: 'combo.creator-broker/1',
        schemaVersion: 1,
        kind: 'command',
        type: 'ping',
        messageId: uuid(seed * 10_000 + 20),
        correlationId: current.connectionId,
        connectionId: current.connectionId,
        sequence: nextSequence(current),
        sentAt: current.leaseGrantedAt,
        expiresAt: current.leaseExpiresAt,
        lease: current.lease,
        body: { nonce: Buffer.alloc(16, seed).toString('base64url') },
      });
      current = await commitCommand(reopened, fixture.installationId, current, ping);
      expect(current.connectionId).toBe(replacement.connectionId);

      fixture.state = current;
      const crossDeploymentId = uuid(seed * 10_000 + 30);
      const crossDeployment = await activateReplacementLease(
        fixture,
        seed * 10_000 + 31,
        crossDeploymentId,
        transportNow,
      );
      const crossDeploymentOpen = BrokerEnvelopeSchema.parse({
        ...fixture.openEnvelope,
        connectionId: crossDeployment.connectionId,
        sequence: nextSequence(crossDeployment),
        sentAt: crossDeployment.leaseGrantedAt,
        expiresAt: crossDeployment.leaseExpiresAt,
        lease: crossDeployment.lease,
        body: {
          ...fixture.openEnvelope.body,
          openAuthority: {
            ...fixture.openEnvelope.body.openAuthority,
            deploymentId: crossDeploymentId,
          },
        },
      }) as Extract<BrokerEnvelope, { type: 'conversation.open' }>;
      const beforeRejectedOpen = queryConnectionSnapshot(
        fixture.filename,
        crossDeployment.connectionId,
      );
      await expect(
        commitCommand(reopened, fixture.installationId, crossDeployment, crossDeploymentOpen),
      ).rejects.toMatchObject({ code: 'SEQUENCE_CONFLICT' });
      expect(queryConnectionSnapshot(fixture.filename, crossDeployment.connectionId)).toEqual(
        beforeRejectedOpen,
      );
      expect(
        queryCountWhere(
          fixture.filename,
          'transport_inbound_frames',
          `connection_id = '${crossDeployment.connectionId}' AND sequence = '${crossDeploymentOpen.sequence}' AND effect_state = 'PERSISTED'`,
        ),
      ).toBe(0);

      const crossDeploymentAck = BrokerEnvelopeSchema.parse({
        ...originalAck,
        connectionId: crossDeployment.connectionId,
        sequence: nextSequence(crossDeployment),
        sentAt: crossDeployment.leaseGrantedAt,
        expiresAt: crossDeployment.leaseExpiresAt,
        lease: crossDeployment.lease,
      }) as Extract<BrokerEnvelope, { kind: 'ack'; type: 'message.ack' }>;
      await expect(
        reopened.replayInbound({
          installationId: fixture.installationId,
          ownerToken: OWNER,
          connectionId: crossDeployment.connectionId,
          envelope: crossDeploymentAck,
          canonicalDigest: canonicalSha256(crossDeploymentAck),
          signal,
        }),
      ).resolves.toBe('NOT_FOUND');
      const beforeRejectedAck = queryConnectionSnapshot(
        fixture.filename,
        crossDeployment.connectionId,
      );
      await expect(
        commitCommand(reopened, fixture.installationId, crossDeployment, crossDeploymentAck),
      ).rejects.toMatchObject({ code: 'SEQUENCE_CONFLICT' });
      expect(queryConnectionSnapshot(fixture.filename, crossDeployment.connectionId)).toEqual(
        beforeRejectedAck,
      );
      expect(
        queryCountWhere(
          fixture.filename,
          'transport_inbound_frames',
          `connection_id = '${crossDeployment.connectionId}' AND sequence = '${crossDeploymentAck.sequence}' AND message_id = '${crossDeploymentAck.messageId}'`,
        ),
      ).toBe(0);
      expect(queryCount(fixture.filename, 'local_invocations')).toBe(0);
      expect(fixture.authorities.hostDispatchCalls.count).toBe(0);
      reopened.close();
    },
  );

  it('commits the inbound READY ACK, receipt, state, and wire purge all-or-none', async () => {
    let failAckCommit = false;
    const fixture = await createInvocationFixture(94, {
      faultInjector(point) {
        if (failAckCommit && point === 'commit_inbound_reconciliation.before_commit') {
          throw new Error('fault-ready-ack-before-commit');
        }
      },
    });
    const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    const signal = new AbortController().signal;
    await journal.bindReadyConversation({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.openReference,
      evidence: { token: 'sandbox-ready' },
      signal,
    });
    const pending = await journal.readPendingConversationReadyFacts({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      limit: 1,
      signal,
    });
    const delivery = await journal.enqueuePendingConversationReadyFact({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      reference: pending[0]!,
      connectionId: fixture.state.connectionId,
      deliveryMessageId: uuid(94_000),
      signal,
    });
    const ack = readyCloudAckEnvelope(fixture, delivery.deliveryMessageId, 'APPLIED', 94_001);
    const inboundBefore = queryCount(fixture.filename, 'transport_inbound_frames');

    failAckCommit = true;
    await expect(
      commitCommand(fixture.adapter, fixture.installationId, fixture.state, ack),
    ).rejects.toThrow('fault-ready-ack-before-commit');
    expect(queryCount(fixture.filename, 'transport_inbound_frames')).toBe(inboundBefore);
    expect(queryCount(fixture.filename, 'local_conversation_ready_outbox_receipts')).toBe(0);
    expect(
      queryCountWhere(fixture.filename, 'local_conversations', `ready_cloud_state = 'PENDING'`),
    ).toBe(1);
    expect(
      queryCountWhere(
        fixture.filename,
        'transport_outbox',
        `message_id = '${delivery.deliveryMessageId}'`,
      ),
    ).toBe(1);

    failAckCommit = false;
    await commitCommand(fixture.adapter, fixture.installationId, fixture.state, ack);
    expect(queryCount(fixture.filename, 'transport_inbound_frames')).toBe(inboundBefore + 1);
    expect(queryCount(fixture.filename, 'local_conversation_ready_outbox_receipts')).toBe(1);
    expect(
      queryCountWhere(
        fixture.filename,
        'local_conversations',
        `ready_cloud_state = 'CLOUD_COMMITTED'`,
      ),
    ).toBe(1);
    expect(
      queryCountWhere(
        fixture.filename,
        'transport_outbox',
        `message_id = '${delivery.deliveryMessageId}'`,
      ),
    ).toBe(0);
  });

  it('rejects a re-digested READY wire whose strict fact body differs from durable authority', async () => {
    const fixture = await createInvocationFixture(93);
    const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    const signal = new AbortController().signal;
    await journal.bindReadyConversation({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.openReference,
      evidence: { token: 'sandbox-ready' },
      signal,
    });
    const [pending] = await journal.readPendingConversationReadyFacts({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      limit: 1,
      signal,
    });
    const delivery = await journal.enqueuePendingConversationReadyFact({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      reference: pending!,
      connectionId: fixture.state.connectionId,
      deliveryMessageId: uuid(93_000),
      signal,
    });
    redigestReadyWireWithMutation(fixture.filename, delivery.deliveryMessageId, {
      runtimeThreadId: 'thread-tampered',
    });
    const ack = readyCloudAckEnvelope(fixture, delivery.deliveryMessageId, 'APPLIED', 93_001);
    const inboundBefore = queryCount(fixture.filename, 'transport_inbound_frames');
    await expect(
      commitCommand(fixture.adapter, fixture.installationId, fixture.state, ack),
    ).rejects.toThrow();
    expect(queryCount(fixture.filename, 'transport_inbound_frames')).toBe(inboundBefore);
    expect(queryCount(fixture.filename, 'local_conversation_ready_outbox_receipts')).toBe(0);
    expect(
      queryCountWhere(fixture.filename, 'local_conversations', `ready_cloud_state = 'PENDING'`),
    ).toBe(1);
  });

  it('atomically rejects a READY wire with re-digested outer correlation and Deployment', async () => {
    const fixture = await createInvocationFixture(89);
    const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    const signal = new AbortController().signal;
    await journal.bindReadyConversation({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.openReference,
      evidence: { token: 'sandbox-ready' },
      signal,
    });
    const [pending] = await journal.readPendingConversationReadyFacts({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      limit: 1,
      signal,
    });
    const delivery = await journal.enqueuePendingConversationReadyFact({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      reference: pending!,
      connectionId: fixture.state.connectionId,
      deliveryMessageId: uuid(89_000),
      signal,
    });
    redigestReadyWireOuterMutation(fixture.filename, delivery.deliveryMessageId, {
      correlationId: uuid(89_001),
      deploymentId: uuid(89_002),
    });
    const inboundBefore = queryCount(fixture.filename, 'transport_inbound_frames');
    await expect(
      commitCommand(
        fixture.adapter,
        fixture.installationId,
        fixture.state,
        readyCloudAckEnvelope(fixture, delivery.deliveryMessageId, 'APPLIED', 89_003),
      ),
    ).rejects.toThrow();
    expect(queryCount(fixture.filename, 'transport_inbound_frames')).toBe(inboundBefore);
    expect(queryCount(fixture.filename, 'local_conversation_ready_outbox_receipts')).toBe(0);
    expect(queryCount(fixture.filename, 'local_conversation_ready_terminal_tombstones')).toBe(0);
  });

  it('production reconnect pump re-envelopes READY under current Lease without changing original authority', async () => {
    const fixture = await createInvocationFixture(92);
    let readyEvidenceVerifications = 0;
    const journal = fixture.adapter.createInvocationJournal({
      ...fixture.authorities.options,
      readyConversationAuthority: {
        verify(input, expected, now) {
          readyEvidenceVerifications += 1;
          return fixture.authorities.options.readyConversationAuthority.verify(
            input,
            expected,
            now,
          );
        },
      },
    });
    const signal = new AbortController().signal;
    const ready = await journal.bindReadyConversation({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.openReference,
      evidence: { token: 'sandbox-ready' },
      signal,
    });
    expect(queryCount(fixture.filename, 'local_conversation_ready_deliveries')).toBe(1);

    const replacement = await activateReplacementLease(fixture, 92_000);
    await expect(
      fixture.adapter.replayPendingConversationReady({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        connectionId: replacement.connectionId,
        signal,
      }),
    ).resolves.toEqual({ enqueued: 1, remaining: false });
    const outbound = await fixture.adapter.readOutbound({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      connectionId: replacement.connectionId,
      limit: 16,
      signal,
    });
    const wire = outbound.find((envelope) => envelope.type === 'conversation.ready');
    if (wire === undefined || wire.type !== 'conversation.ready') throw new Error('missing-ready');
    expect(wire.lease).toEqual(replacement.lease);
    expect(wire.body).toMatchObject({
      sourceEventId: fixture.openReference.messageId,
      openCommandId: fixture.openReference.messageId,
      conversationId: fixture.conversationId,
      workerSessionId: fixture.state.lease.workerSessionId,
      leaseId: fixture.state.lease.leaseId,
      fence: fixture.state.lease.fence,
      factDigest: ready.factDigest,
    });
    expect(wire.body.workerSessionId).not.toBe(wire.lease.workerSessionId);
    expect(wire.body.fence).not.toBe(wire.lease.fence);
    expect(queryCount(fixture.filename, 'local_conversation_ready_facts')).toBe(1);
    expect(queryCount(fixture.filename, 'local_conversation_ready_deliveries')).toBe(1);
    expect(readyEvidenceVerifications).toBe(1);
  });

  it('accepts late processing only when trusted READY evidence occurred inside the persisted open window', async () => {
    const fixture = await createInvocationFixture(91);
    fixture.authorities.cloudNow.value = Date.parse(fixture.prepareEnvelope.expiresAt) + 5_000;
    const readyAt = new Date(Date.parse(fixture.prepareEnvelope.sentAt) + 500);
    const journal = fixture.adapter.createInvocationJournal({
      ...fixture.authorities.options,
      readyConversationAuthority: {
        verify() {
          return {
            sandboxInstanceId: uuid(900_001),
            runtimeThreadId: 'thread-ready-001',
            evidenceDigest: `sha256:${SHA('7')}`,
            readyAt,
          };
        },
      },
    });
    await expect(
      journal.bindReadyConversation({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        command: fixture.openReference,
        evidence: { token: 'sandbox-ready' },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ sourceEventId: fixture.openReference.messageId });
    expect(queryCount(fixture.filename, 'local_conversation_ready_facts')).toBe(1);
    expect(queryCount(fixture.filename, 'local_conversation_ready_outbox')).toBe(1);
    expect(queryCount(fixture.filename, 'local_conversation_ready_deliveries')).toBe(0);
  });

  it('never prunes a pending READY fact or logical outbox', async () => {
    const fixture = await createInvocationFixture(90);
    const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    await journal.bindReadyConversation({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.openReference,
      evidence: { token: 'sandbox-ready' },
      signal: new AbortController().signal,
    });
    fixture.authorities.cloudNow.value += 8 * 24 * 60 * 60 * 1_000;
    await expect(
      journal.pruneCommittedRetention({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(0);
    expect(queryCount(fixture.filename, 'local_conversation_ready_facts')).toBe(1);
    expect(queryCount(fixture.filename, 'local_conversation_ready_outbox')).toBe(1);
    expect(queryCount(fixture.filename, 'local_conversation_ready_outbox_receipts')).toBe(0);
  });

  it('atomically deduplicates 100 prepares, dispatches once, verifies AEAD, and survives ACK loss', async () => {
    const fixture = await createInvocationFixture(100);
    expect(() =>
      fixture.adapter.createInvocationJournal({
        ...fixture.authorities.options,
        maxPendingFacts: 2,
      }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CAPACITY' }));
    const journal = fixture.adapter.createInvocationJournal({
      ...fixture.authorities.options,
      maxInvocations: 1,
      maxPendingFacts: 3,
    });
    const signal = new AbortController().signal;

    await bindCloudCommittedReady(journal, fixture, signal);
    const prepared = await Promise.all(
      Array.from({ length: 100 }, () =>
        journal.prepare({
          installationId: fixture.installationId,
          ownerToken: OWNER,
          command: fixture.prepareReference,
          signal,
        }),
      ),
    );
    expect(new Set(prepared.map((item) => `${item.sourceEventId}:${item.factDigest}`)).size).toBe(
      1,
    );
    expect(queryCount(fixture.filename, 'local_invocations')).toBe(1);
    expect(queryCount(fixture.filename, 'local_consumed_commands')).toBe(2);
    expect(queryCount(fixture.filename, 'local_invocation_outbox')).toBe(1);
    expect(fixture.authorities.hostReceiptCalls.count).toBe(0);
    expect(
      rawJournalContainsAny(fixture.filename, [
        fixture.prepareEnvelope.body.userMessageCiphertext.nonce,
        fixture.prepareEnvelope.body.userMessageCiphertext.ciphertext,
        fixture.prepareEnvelope.body.userMessageCiphertext.authTag,
      ]),
    ).toBe(false);
    expect(rawJournalContainsAny(fixture.filename, ['secret prompt'])).toBe(false);
    const retainedPrompt = queryJson(
      fixture.filename,
      'SELECT prompt_ciphertext AS value FROM local_invocations',
    ) as LocalInvocationPromptCiphertext;

    const start = await journal.start({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.startReference,
      signal,
    });
    expect(start.action).toBe('DISPATCH_ONCE');
    if (start.action !== 'DISPATCH_ONCE') throw new Error('missing-dispatch-permit');
    expect(start.permit).not.toHaveProperty('executionCapability');
    expect(start.permit).not.toHaveProperty('userMessageCiphertext');
    expect(queryScalar(fixture.filename, 'host_dispatch_intent_count')).toBe(1);

    const started = await journal.dispatchOnce({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      permit: start.permit,
      signal,
    });
    expect(started.runtimeTurnId).toBe('turn-host-1');
    expect(fixture.authorities.hostDispatchCalls).toMatchObject({
      count: 1,
      prompts: ['secret prompt'],
    });
    expect(fixture.authorities.hostReceiptCalls.count).toBe(1);
    expect(queryNullable(fixture.filename, 'local_invocations', 'prompt_ciphertext')).toBeNull();
    expect(
      rawJournalContainsAny(fixture.filename, [
        retainedPrompt.nonce,
        retainedPrompt.ciphertext,
        retainedPrompt.authTag,
      ]),
    ).toBe(false);

    const resultSourceEventId = fixture.invocationId;
    const resultCiphertext = encryptLocalResult(
      'durable assistant result',
      fixture.localResultKey,
      fixture.resultHmacKey,
      fixture.localResultKeyId,
      {
        schemaVersion: 1,
        installationId: fixture.installationId,
        invocationId: fixture.invocationId,
        conversationId: fixture.conversationId,
        agentVersionDigest: SHA('a'),
        role: 'ASSISTANT',
      },
    );
    const final = await journal.writeSucceeded({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      invocationId: fixture.invocationId,
      dispatchNonce: start.permit.dispatchNonce,
      sourceEventId: resultSourceEventId,
      resultCiphertext,
      signal,
    });
    expect(rawJournalContainsAny(fixture.filename, ['durable assistant result'])).toBe(false);
    expect(queryScalar(fixture.filename, 'state')).toBe('FINAL_READY');
    const pendingFacts = await journal.readPendingFacts({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      limit: 10,
      signal,
    });
    expect(pendingFacts).toHaveLength(3);
    const terminalFact = pendingFacts.find((fact) => fact.sourceEventId === final.sourceEventId);
    if (terminalFact === undefined) throw new Error('missing-terminal-fact');
    const terminalAck = await enqueueAndCommitCloudAck(
      fixture.adapter,
      journal,
      fixture,
      terminalFact,
      100_700,
    );
    const terminalWire = queryJson(
      fixture.filename,
      `SELECT envelope_json AS value FROM transport_outbox
       WHERE message_id = '${terminalAck.ack.acknowledgedDeliveryMessageId}'`,
    ) as Extract<BrokerEnvelope, { type: 'invocation.succeeded' }>;
    const terminalWireCanaries = [
      terminalWire.body.resultCiphertext.nonce,
      terminalWire.body.resultCiphertext.ciphertext,
      terminalWire.body.resultCiphertext.authTag,
    ];
    await expect(
      journal.markCloudCommitted({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        ack: { ...terminalAck.ack, canonicalDigest: SHA('f') },
        evidence: { token: 'cloud-committed' },
        signal,
      }),
    ).rejects.toMatchObject({ code: 'OUTBOX_CONFLICT' });
    await expect(
      journal.markCloudCommitted({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        ack: terminalAck.ack,
        evidence: { token: 'forged-cloud-ack' },
        signal,
      }),
    ).rejects.toMatchObject({ code: 'OUTBOX_CONFLICT' });
    fixture.state = terminalAck.state;
    assertLocalIntegrity(fixture.filename);
    fixture.adapter.close();

    const responseLost = new SqliteWorkerBrokerDurableTransport({
      filename: fixture.filename,
      faultInjector(point) {
        if (point === 'invocation_mark_cloud_committed.after_commit') {
          throw new Error('SIMULATED_ACK_RESPONSE_LOSS');
        }
      },
    });
    const afterRestart = responseLost.createInvocationJournal(fixture.authorities.options);
    await expect(
      afterRestart.markCloudCommitted({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        ack: terminalAck.ack,
        evidence: { token: 'cloud-committed' },
        signal,
      }),
    ).rejects.toThrow('SIMULATED_ACK_RESPONSE_LOSS');
    responseLost.close();
    expect(rawJournalContainsAny(fixture.filename, terminalWireCanaries)).toBe(false);
    expect(queryNullable(fixture.filename, 'local_invocations', 'result_ciphertext')).not.toBe(
      null,
    );

    const recovered = new SqliteWorkerBrokerDurableTransport({ filename: fixture.filename });
    const recoveredJournal = recovered.createInvocationJournal(fixture.authorities.options);
    await expect(
      recoveredJournal.markCloudCommitted({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        ack: terminalAck.ack,
        evidence: { token: 'cloud-committed' },
        signal,
      }),
    ).resolves.toBeUndefined();
    expect(queryScalar(fixture.filename, 'state')).toBe('CLOUD_COMMITTED');
    const remainingFacts = await recoveredJournal.readPendingFacts({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      limit: 10,
      signal,
    });
    expect(remainingFacts).toHaveLength(2);
    const retentionJournal = recovered.createInvocationJournal({
      ...fixture.authorities.options,
      cloudClock: { now: () => new Date(Date.now() + 8 * 24 * 60 * 60 * 1_000) },
    });
    await expect(
      retentionJournal.pruneCommittedRetention({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        signal,
      }),
    ).resolves.toBe(0);
    expect(queryCount(fixture.filename, 'local_invocations')).toBe(1);
    let ackState = terminalAck.state;
    let ackSeed = 100_710;
    for (const fact of remainingFacts) {
      const committed = await enqueueAndCommitCloudAck(
        recovered,
        recoveredJournal,
        { ...fixture, state: ackState },
        fact,
        ackSeed,
      );
      ackState = committed.state;
      ackSeed += 2;
      await recoveredJournal.markCloudCommitted({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        ack: committed.ack,
        evidence: { token: 'cloud-committed' },
        signal,
      });
    }
    await expect(
      retentionJournal.pruneCommittedRetention({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        signal,
      }),
    ).resolves.toBe(1);
    expect(queryCount(fixture.filename, 'local_invocations')).toBe(0);
    expect(queryCount(fixture.filename, 'local_invocation_outbox')).toBe(0);
    expect(queryCount(fixture.filename, 'local_invocation_events')).toBe(0);
    expect(queryCount(fixture.filename, 'local_consumed_commands')).toBe(1);
    expect(queryCount(fixture.filename, 'local_conversations')).toBe(1);
    expect(queryScalarFrom(fixture.filename, 'local_conversations', 'state')).toBe('READY');
    expect(
      rawJournalContainsAny(fixture.filename, [
        resultCiphertext.nonce,
        resultCiphertext.ciphertext,
        resultCiphertext.authTag,
      ]),
    ).toBe(false);
    recovered.close();
    const afterPrune = new SqliteWorkerBrokerDurableTransport({ filename: fixture.filename });
    afterPrune.close();
  });

  it('never dispatches an unattempted STARTING permit after process reopen', async () => {
    const fixture = await createInvocationFixture(200);
    const signal = new AbortController().signal;
    let journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    await bindCloudCommittedReady(journal, fixture, signal);
    await journal.prepare({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.prepareReference,
      signal,
    });
    const first = await journal.start({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.startReference,
      signal,
    });
    expect(first.action).toBe('DISPATCH_ONCE');
    fixture.adapter.close();

    const reopened = new SqliteWorkerBrokerDurableTransport({ filename: fixture.filename });
    journal = reopened.createInvocationJournal(fixture.authorities.options);
    const recoveredActions = await journal.recoverHostActionsAfterProcessStart({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      signal,
    });
    expect(recoveredActions).toHaveLength(1);
    expect(queryScalar(fixture.filename, 'state')).toBe('UNCERTAIN');
    expect(queryScalar(fixture.filename, 'host_dispatch_intent_count')).toBe(1);
    const [replayed] = recoveredActions;
    expect(replayed).toMatchObject({ action: 'UNCERTAIN', invocationId: fixture.invocationId });
    expect(fixture.authorities.hostDispatchCalls.count).toBe(0);
    assertLocalIntegrity(fixture.filename);
    reopened.close();
  });

  it('writes only a confirmed Host terminal failure from RUNNING and exact-replays it', async () => {
    const fixture = await createInvocationFixture(201);
    const signal = new AbortController().signal;
    const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    const running = await driveInvocationToRunning(journal, fixture, signal);
    const failed = await journal.writeFailed({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      invocationId: fixture.invocationId,
      dispatchNonce: running.dispatchNonce,
      sourceEventId: fixture.invocationId,
      errorCode: 'TURN_FAILED',
      signal,
    });
    expect(queryScalar(fixture.filename, 'state')).toBe('FAILED');
    await expect(
      journal.writeFailed({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        invocationId: fixture.invocationId,
        dispatchNonce: running.dispatchNonce,
        sourceEventId: fixture.invocationId,
        errorCode: 'TURN_FAILED',
        signal,
      }),
    ).resolves.toEqual(failed);
    await expect(
      journal.writeFailed({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        invocationId: fixture.invocationId,
        dispatchNonce: running.dispatchNonce,
        sourceEventId: fixture.invocationId,
        errorCode: 'TURN_TIMEOUT',
        signal,
      }),
    ).rejects.toMatchObject({ code: 'FINAL_CONFLICT' });
    assertLocalIntegrity(fixture.filename);
    fixture.adapter.close();
  });

  it('marks a live RUNNING invocation uncertain when its Host evidence is lost', async () => {
    const fixture = await createInvocationFixture(202);
    const signal = new AbortController().signal;
    const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    const running = await driveInvocationToRunning(journal, fixture, signal);
    const uncertain = await journal.markHostEvidenceLost({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      invocationId: fixture.invocationId,
      dispatchNonce: running.dispatchNonce,
      sourceEventId: fixture.invocationId,
      signal,
    });
    expect(queryScalar(fixture.filename, 'state')).toBe('UNCERTAIN');
    await expect(
      journal.markHostEvidenceLost({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        invocationId: fixture.invocationId,
        dispatchNonce: running.dispatchNonce,
        sourceEventId: fixture.invocationId,
        signal,
      }),
    ).resolves.toEqual(uncertain);
    const terminal = queryJson(
      fixture.filename,
      `SELECT fact_json AS value FROM local_invocation_events
       WHERE event_type = 'invocation.uncertain'`,
    ) as { reason: string };
    expect(terminal.reason).toBe('HOST_EVIDENCE_LOST');
    assertLocalIntegrity(fixture.filename);
    fixture.adapter.close();
  });

  it('converges a reopened RUNNING invocation without a second Host call', async () => {
    const fixture = await createInvocationFixture(203);
    const signal = new AbortController().signal;
    let journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    await driveInvocationToRunning(journal, fixture, signal);
    expect(fixture.authorities.hostDispatchCalls.count).toBe(1);
    fixture.adapter.close();

    const reopened = new SqliteWorkerBrokerDurableTransport({ filename: fixture.filename });
    journal = reopened.createInvocationJournal(fixture.authorities.options);
    await expect(
      journal.recoverHostActionsAfterProcessStart({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        signal,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ action: 'UNCERTAIN', invocationId: fixture.invocationId }),
    ]);
    expect(fixture.authorities.hostDispatchCalls.count).toBe(1);
    expect(queryScalar(fixture.filename, 'state')).toBe('UNCERTAIN');
    assertLocalIntegrity(fixture.filename);
    reopened.close();
  });

  it('uses an independent cleanup signal when Host aborts and never exposes or redispatches prompt', async () => {
    const fixture = await createInvocationFixture(250);
    const signal = new AbortController().signal;
    const dispatchController = new AbortController();
    let hostCalls = 0;
    const journal = fixture.adapter.createInvocationJournal({
      ...fixture.authorities.options,
      hostDispatchPort: {
        async dispatchOnce() {
          hostCalls += 1;
          dispatchController.abort();
          throw new Error('HOST_TIMEOUT_AFTER_ATTEMPT');
        },
      },
    });
    await bindCloudCommittedReady(journal, fixture, signal);
    await journal.prepare({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.prepareReference,
      signal,
    });
    const retainedPrompt = queryJson(
      fixture.filename,
      'SELECT prompt_ciphertext AS value FROM local_invocations',
    ) as LocalInvocationPromptCiphertext;
    const start = await journal.start({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.startReference,
      signal,
    });
    if (start.action !== 'DISPATCH_ONCE') throw new Error('missing-permit');
    await expect(
      journal.dispatchOnce({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        permit: start.permit,
        signal: dispatchController.signal,
      }),
    ).rejects.toThrow('HOST_TIMEOUT_AFTER_ATTEMPT');
    expect(hostCalls).toBe(1);
    expect(queryScalar(fixture.filename, 'state')).toBe('UNCERTAIN');
    expect(queryNullable(fixture.filename, 'local_invocations', 'prompt_ciphertext')).toBeNull();
    expect(
      rawJournalContainsAny(fixture.filename, [
        retainedPrompt.nonce,
        retainedPrompt.ciphertext,
        retainedPrompt.authTag,
      ]),
    ).toBe(false);
    await expect(
      journal.dispatchOnce({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        permit: start.permit,
        signal,
      }),
    ).rejects.toMatchObject({ code: 'PROMPT_AEAD_INVALID' });
    expect(hostCalls).toBe(1);
    fixture.adapter.close();
  });

  it('cancels PREPARED from the durable zero-attempt counter without entering Host', async () => {
    const fixture = await createInvocationFixture(251);
    const signal = new AbortController().signal;
    const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    await bindCloudCommittedReady(journal, fixture, signal);
    await journal.prepare({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.prepareReference,
      signal,
    });
    const cancel = await appendCancelCommand(fixture, 251_900);
    const decision = await journal.cancel({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: cancel.reference,
      signal,
    });
    expect(decision).toMatchObject({ action: 'CANCELLED', replayed: false });
    if (decision.action !== 'CANCELLED') throw new Error('missing-local-cancelled-fact');
    expect(fixture.authorities.hostDispatchCalls.count).toBe(0);
    expect(fixture.authorities.hostInterruptCalls.count).toBe(0);
    expect(queryScalar(fixture.filename, 'state')).toBe('CANCELLED');
    expect(queryScalar(fixture.filename, 'host_dispatch_attempt_count')).toBe(0);
    const pendingCommands = await fixture.adapter.readPendingCommands({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      connectionId: fixture.state.connectionId,
      limit: 16,
      signal,
    });
    expect(pendingCommands.some((candidate) => candidate.type === 'invocation.start')).toBe(false);
    const receipt = WorkerInterruptReceiptSchema.parse(
      queryJson(
        fixture.filename,
        'SELECT receipt_json AS value FROM local_invocation_interrupt_receipts',
      ),
    );
    expect(receipt).toMatchObject({
      outcome: 'PROVED_NOT_EXECUTED',
      evidenceAuthority: 'LOCAL_DISPATCH_COUNTER',
      dispatchAttemptCount: 0,
      startCommandId: null,
      dispatchNonce: null,
    });
    expect(workerInterruptReceiptDigest(receipt)).toBe(decision.interruptReceiptDigest);
    const cancelled = (
      await journal.readPendingFacts({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        limit: 10,
        signal,
      })
    ).find((fact) => fact.eventType === 'invocation.cancelled');
    if (cancelled === undefined) throw new Error('missing-cancelled-fact');
    await journal.enqueuePendingFact({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      reference: cancelled,
      connectionId: fixture.state.connectionId,
      deliveryMessageId: uuid(251_901),
      signal,
    });
    const wire = queryJson(
      fixture.filename,
      `SELECT envelope_json AS value FROM transport_outbox
       WHERE envelope_type = 'invocation.cancelled'`,
    ) as Extract<BrokerEnvelope, { type: 'invocation.cancelled' }>;
    expect(wire.body.interruptReceipt).toEqual(receipt);
    assertLocalIntegrity(fixture.filename);
    fixture.adapter.close();
    const reopened = new SqliteWorkerBrokerDurableTransport({ filename: fixture.filename });
    expect(() => reopened.createInvocationJournal(fixture.authorities.options)).not.toThrow();
    reopened.close();
  });

  it('durably security-blocks a changed cancel identity before throwing and exact-replays it', async () => {
    const fixture = await createInvocationFixture(258);
    const signal = new AbortController().signal;
    const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    await bindCloudCommittedReady(journal, fixture, signal);
    await journal.prepare({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.prepareReference,
      signal,
    });
    const acceptedCancel = await appendCancelCommand(fixture, 258_900);
    await expect(
      journal.cancel({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        command: acceptedCancel.reference,
        signal,
      }),
    ).resolves.toMatchObject({ action: 'CANCELLED', replayed: false });
    const businessBeforeConflict = {
      state: queryScalar(fixture.filename, 'state'),
      terminalFactDigest: queryScalar(fixture.filename, 'terminal_fact_digest'),
      interruptReceiptDigest: queryScalar(fixture.filename, 'interrupt_receipt_digest'),
      events: queryCount(fixture.filename, 'local_invocation_events'),
      outbox: queryCount(fixture.filename, 'local_invocation_outbox'),
      receipts: queryCount(fixture.filename, 'local_invocation_interrupt_receipts'),
    };

    const conflictingCancel = await appendCancelCommand(fixture, 258_910, 'SECURITY_REVOKE');
    const consumedBeforeConflict = queryCount(fixture.filename, 'local_consumed_commands');
    const rejectConflict = () =>
      journal.cancel({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        command: conflictingCancel.reference,
        signal,
      });
    await expect(rejectConflict()).rejects.toMatchObject({ code: 'CANCEL_COMMAND_CONFLICT' });
    expect({
      state: queryScalar(fixture.filename, 'state'),
      terminalFactDigest: queryScalar(fixture.filename, 'terminal_fact_digest'),
      interruptReceiptDigest: queryScalar(fixture.filename, 'interrupt_receipt_digest'),
      events: queryCount(fixture.filename, 'local_invocation_events'),
      outbox: queryCount(fixture.filename, 'local_invocation_outbox'),
      receipts: queryCount(fixture.filename, 'local_invocation_interrupt_receipts'),
    }).toEqual(businessBeforeConflict);
    expect(queryCount(fixture.filename, 'local_consumed_commands')).toBe(
      consumedBeforeConflict + 1,
    );
    const persisted = new SqliteDatabase(fixture.filename, { readOnly: true });
    expect(
      persisted
        .prepare(`SELECT disposition FROM local_consumed_commands WHERE command_id = ?`)
        .get(conflictingCancel.envelope.messageId),
    ).toEqual({ disposition: 'SECURITY_BLOCK' });
    expect(
      persisted
        .prepare(
          `SELECT effect_state FROM transport_inbound_frames
           WHERE connection_id = ? AND sequence = ?`,
        )
        .get(conflictingCancel.reference.connectionId, conflictingCancel.reference.sequence),
    ).toEqual({ effect_state: 'APPLIED' });
    persisted.close();

    await expect(rejectConflict()).rejects.toMatchObject({ code: 'CANCEL_COMMAND_CONFLICT' });
    expect(queryCount(fixture.filename, 'local_consumed_commands')).toBe(
      consumedBeforeConflict + 1,
    );
    expect({
      state: queryScalar(fixture.filename, 'state'),
      terminalFactDigest: queryScalar(fixture.filename, 'terminal_fact_digest'),
      interruptReceiptDigest: queryScalar(fixture.filename, 'interrupt_receipt_digest'),
      events: queryCount(fixture.filename, 'local_invocation_events'),
      outbox: queryCount(fixture.filename, 'local_invocation_outbox'),
      receipts: queryCount(fixture.filename, 'local_invocation_interrupt_receipts'),
    }).toEqual(businessBeforeConflict);
    assertLocalIntegrity(fixture.filename);
    fixture.adapter.close();
  });

  it('cancels a STARTING intent before its Host attempt and binds the real start IDs', async () => {
    const fixture = await createInvocationFixture(254);
    const signal = new AbortController().signal;
    const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    await bindCloudCommittedReady(journal, fixture, signal);
    await journal.prepare({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.prepareReference,
      signal,
    });
    const start = await journal.start({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.startReference,
      signal,
    });
    if (start.action !== 'DISPATCH_ONCE') throw new Error('missing-starting-permit');
    const cancel = await appendCancelCommand(fixture, 254_900);
    await expect(
      journal.cancel({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        command: cancel.reference,
        signal,
      }),
    ).resolves.toMatchObject({ action: 'CANCELLED', replayed: false });
    const receipt = WorkerInterruptReceiptSchema.parse(
      queryJson(
        fixture.filename,
        'SELECT receipt_json AS value FROM local_invocation_interrupt_receipts',
      ),
    );
    expect(receipt).toMatchObject({
      outcome: 'PROVED_NOT_EXECUTED',
      dispatchAttemptCount: 0,
      startCommandId: fixture.startReference.messageId,
      dispatchNonce: start.permit.dispatchNonce,
    });
    await expect(
      journal.dispatchOnce({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        permit: start.permit,
        signal,
      }),
    ).rejects.toMatchObject({ code: 'PROMPT_AEAD_INVALID' });
    expect(fixture.authorities.hostDispatchCalls.count).toBe(0);
    assertLocalIntegrity(fixture.filename);
    fixture.adapter.close();
    const tampered = new SqliteDatabase(fixture.filename);
    tampered.exec('DROP TRIGGER local_invocation_interrupt_receipts_no_update');
    const receiptRow = tampered
      .prepare('SELECT * FROM local_invocation_interrupt_receipts')
      .get() as Record<string, unknown>;
    const mismatched = WorkerInterruptReceiptSchema.parse({
      ...receipt,
      startCommandId: uuid(254_990),
      dispatchNonce: uuid(254_991),
    });
    const receiptPayload: Record<string, unknown> = {
      ...receiptRow,
      receipt_json: canonicalizeJson(mismatched),
    };
    delete receiptPayload.row_digest;
    tampered
      .prepare(
        `UPDATE local_invocation_interrupt_receipts
         SET receipt_json = ?, row_digest = ? WHERE invocation_id = ?`,
      )
      .run(
        receiptPayload.receipt_json as string,
        sqliteInvocationRowDigest('local_invocation_interrupt_receipts', receiptPayload),
        fixture.invocationId,
      );
    expect(() => assertWorkerInvocationIntegrity(tampered)).toThrow(
      /invalid-local-interrupt-receipt/u,
    );
    tampered.close();
  });

  it('interrupts one exact RUNNING Host turn, persists its receipt, and exact-replays without a second call', async () => {
    const fixture = await createInvocationFixture(252);
    const signal = new AbortController().signal;
    const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    await bindCloudCommittedReady(journal, fixture, signal);
    await journal.prepare({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.prepareReference,
      signal,
    });
    const start = await journal.start({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.startReference,
      signal,
    });
    if (start.action !== 'DISPATCH_ONCE') throw new Error('missing-dispatch-permit');
    await journal.dispatchOnce({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      permit: start.permit,
      signal,
    });
    const cancel = await appendCancelCommand(fixture, 252_900, 'SECURITY_REVOKE');
    const requested = await journal.cancel({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: cancel.reference,
      signal,
    });
    expect(requested.action).toBe('INTERRUPT_ONCE');
    if (requested.action !== 'INTERRUPT_ONCE') throw new Error('missing-interrupt-permit');
    const cancelled = await journal.interruptOnce({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      permit: requested.permit,
      signal,
    });
    expect(cancelled).toMatchObject({ action: 'CANCELLED', replayed: false });
    expect(fixture.authorities.hostInterruptCalls.count).toBe(1);
    expect(fixture.authorities.hostInterruptReceiptCalls.count).toBe(1);
    const replay = await journal.interruptOnce({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      permit: requested.permit,
      signal,
    });
    expect(replay).toEqual({ ...cancelled, replayed: true });
    expect(fixture.authorities.hostInterruptCalls.count).toBe(1);
    expect(queryScalar(fixture.filename, 'interrupt_intent_count')).toBe(1);
    expect(queryScalar(fixture.filename, 'interrupt_attempt_count')).toBe(1);
    expect(queryScalar(fixture.filename, 'interrupt_confirmed_count')).toBe(1);
    const receipt = WorkerInterruptReceiptSchema.parse(
      queryJson(
        fixture.filename,
        'SELECT receipt_json AS value FROM local_invocation_interrupt_receipts',
      ),
    );
    expect(receipt).toMatchObject({
      outcome: 'INTERRUPTED',
      evidenceAuthority: 'HOST',
      runtimeTurnId: 'turn-host-1',
      hostTerminalDigest: `sha256:${SHA('6')}`,
    });
    expect(rawJournalContainsAny(fixture.filename, ['HOST-RAW-INTERRUPT-CANARY'])).toBe(false);
    assertLocalIntegrity(fixture.filename);
    fixture.adapter.close();
    const missingCompanion = new SqliteDatabase(fixture.filename);
    missingCompanion.exec('DELETE FROM local_invocation_interrupt_receipts');
    expect(() => assertWorkerInvocationIntegrity(missingCompanion)).toThrow(
      /invalid-local-invocation-state-binding/u,
    );
    missingCompanion.close();
  });

  it('never reconstructs an interrupt after process loss without a live Host generation', async () => {
    const fixture = await createInvocationFixture(259);
    const signal = new AbortController().signal;
    let journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    await bindCloudCommittedReady(journal, fixture, signal);
    await journal.prepare({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.prepareReference,
      signal,
    });
    const start = await journal.start({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.startReference,
      signal,
    });
    if (start.action !== 'DISPATCH_ONCE') throw new Error('missing-dispatch-permit');
    await journal.dispatchOnce({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      permit: start.permit,
      signal,
    });
    const cancel = await appendCancelCommand(fixture, 259_900);
    await expect(
      journal.cancel({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        command: cancel.reference,
        signal,
      }),
    ).resolves.toMatchObject({ action: 'INTERRUPT_ONCE' });
    fixture.adapter.close();

    const reopened = new SqliteWorkerBrokerDurableTransport({ filename: fixture.filename });
    journal = reopened.createInvocationJournal(fixture.authorities.options);
    const actions = await journal.recoverHostActionsAfterProcessStart({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      signal,
    });
    expect(actions).toHaveLength(1);
    const [action] = actions;
    expect(action).toMatchObject({ action: 'UNCERTAIN', invocationId: fixture.invocationId });
    expect(fixture.authorities.hostInterruptCalls.count).toBe(0);
    expect(queryScalar(fixture.filename, 'state')).toBe('UNCERTAIN');
    assertLocalIntegrity(fixture.filename);
    reopened.close();
  });

  it('returns stable WORKER_BUSY for prepare while one Invocation is CANCEL_REQUESTED', async () => {
    const fixture = await createInvocationFixture(260);
    const signal = new AbortController().signal;
    const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    await bindCloudCommittedReady(journal, fixture, signal);
    await journal.prepare({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.prepareReference,
      signal,
    });
    const start = await journal.start({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.startReference,
      signal,
    });
    if (start.action !== 'DISPATCH_ONCE') throw new Error('missing-dispatch-permit');
    await journal.dispatchOnce({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      permit: start.permit,
      signal,
    });
    const cancel = await appendCancelCommand(fixture, 260_900);
    await journal.cancel({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: cancel.reference,
      signal,
    });
    expect(queryScalar(fixture.filename, 'state')).toBe('CANCEL_REQUESTED');

    const second = pressurePrepareEnvelope(fixture, 260_910);
    fixture.state = await commitCommand(
      fixture.adapter,
      fixture.installationId,
      fixture.state,
      second,
    );
    const secondReference = await commandReference(
      fixture.adapter,
      fixture.installationId,
      fixture.state,
      'invocation.prepare',
    );
    const before = {
      invocations: queryCount(fixture.filename, 'local_invocations'),
      events: queryCount(fixture.filename, 'local_invocation_events'),
      outbox: queryCount(fixture.filename, 'local_invocation_outbox'),
      consumed: queryCount(fixture.filename, 'local_consumed_commands'),
    };
    const permissive = fixture.adapter.createInvocationJournal({
      ...fixture.authorities.options,
      capabilityAuthority: {
        verify(input) {
          const capability = ExecutionCapabilitySchema.parse(input);
          return { capability, capabilityDigest: executionCapabilityDigest(capability) };
        },
        verifyPreviouslyCommitted:
          fixture.authorities.options.capabilityAuthority.verifyPreviouslyCommitted.bind(
            fixture.authorities.options.capabilityAuthority,
          ),
      },
    });
    await expect(
      permissive.prepare({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        command: secondReference,
        signal,
      }),
    ).rejects.toMatchObject({ code: 'WORKER_BUSY' });
    expect({
      invocations: queryCount(fixture.filename, 'local_invocations'),
      events: queryCount(fixture.filename, 'local_invocation_events'),
      outbox: queryCount(fixture.filename, 'local_invocation_outbox'),
      consumed: queryCount(fixture.filename, 'local_consumed_commands'),
    }).toEqual(before);
    assertLocalIntegrity(fixture.filename);
    fixture.adapter.close();
  });

  it('fails RUNNING cancel before mutation when the paired Host interrupt authority is absent', async () => {
    const fixture = await createInvocationFixture(261);
    const signal = new AbortController().signal;
    expect(() =>
      fixture.adapter.createInvocationJournal({
        ...fixture.authorities.options,
        hostInterruptReceiptAuthority: undefined,
      }),
    ).toThrowError(expect.objectContaining({ code: 'INTERRUPT_RECEIPT_INVALID' }));
    const journal = fixture.adapter.createInvocationJournal({
      ...fixture.authorities.options,
      hostInterruptPort: undefined,
      hostInterruptReceiptAuthority: undefined,
    });
    await bindCloudCommittedReady(journal, fixture, signal);
    await journal.prepare({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.prepareReference,
      signal,
    });
    const start = await journal.start({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.startReference,
      signal,
    });
    if (start.action !== 'DISPATCH_ONCE') throw new Error('missing-dispatch-permit');
    await journal.dispatchOnce({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      permit: start.permit,
      signal,
    });
    const cancel = await appendCancelCommand(fixture, 261_900);
    const before = {
      events: queryCount(fixture.filename, 'local_invocation_events'),
      outbox: queryCount(fixture.filename, 'local_invocation_outbox'),
      consumed: queryCount(fixture.filename, 'local_consumed_commands'),
    };
    await expect(
      journal.cancel({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        command: cancel.reference,
        signal,
      }),
    ).rejects.toMatchObject({ code: 'INTERRUPT_RECEIPT_INVALID' });
    expect(queryScalar(fixture.filename, 'state')).toBe('RUNNING');
    expect(queryNullable(fixture.filename, 'local_invocations', 'cancel_command_id')).toBeNull();
    expect({
      events: queryCount(fixture.filename, 'local_invocation_events'),
      outbox: queryCount(fixture.filename, 'local_invocation_outbox'),
      consumed: queryCount(fixture.filename, 'local_consumed_commands'),
    }).toEqual(before);
    fixture.adapter.close();
  });

  it('converts an invalid Host terminal receipt to UNCERTAIN without a second interrupt', async () => {
    const fixture = await createInvocationFixture(255);
    const signal = new AbortController().signal;
    const journal = fixture.adapter.createInvocationJournal({
      ...fixture.authorities.options,
      hostInterruptReceiptAuthority: {
        verify() {
          throw new Error('INVALID_HOST_TERMINAL_BINDING');
        },
      },
    });
    await bindCloudCommittedReady(journal, fixture, signal);
    await journal.prepare({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.prepareReference,
      signal,
    });
    const start = await journal.start({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.startReference,
      signal,
    });
    if (start.action !== 'DISPATCH_ONCE') throw new Error('missing-dispatch-permit');
    await journal.dispatchOnce({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      permit: start.permit,
      signal,
    });
    const cancel = await appendCancelCommand(fixture, 255_900);
    const requested = await journal.cancel({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: cancel.reference,
      signal,
    });
    if (requested.action !== 'INTERRUPT_ONCE') throw new Error('missing-interrupt-permit');
    await expect(
      journal.interruptOnce({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        permit: requested.permit,
        signal,
      }),
    ).rejects.toMatchObject({ code: 'INTERRUPT_RECEIPT_INVALID' });
    expect(fixture.authorities.hostInterruptCalls.count).toBe(1);
    expect(queryScalar(fixture.filename, 'state')).toBe('UNCERTAIN');
    expect(queryScalar(fixture.filename, 'interrupt_attempt_count')).toBe(1);
    expect(queryScalar(fixture.filename, 'interrupt_confirmed_count')).toBe(0);
    expect(queryCount(fixture.filename, 'local_invocation_interrupt_receipts')).toBe(0);
    assertLocalIntegrity(fixture.filename);
    fixture.adapter.close();
  });

  it('hard-aborts an uncooperative Host interrupt and durably converges to CANCEL_NOT_CONFIRMED', async () => {
    const fixture = await createInvocationFixture(253);
    const signal = new AbortController().signal;
    let interruptCalls = 0;
    const journal = fixture.adapter.createInvocationJournal({
      ...fixture.authorities.options,
      hostInterruptPort: {
        interruptOnce() {
          interruptCalls += 1;
          return new Promise<never>(() => undefined);
        },
      },
    });
    await bindCloudCommittedReady(journal, fixture, signal);
    await journal.prepare({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.prepareReference,
      signal,
    });
    const start = await journal.start({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.startReference,
      signal,
    });
    if (start.action !== 'DISPATCH_ONCE') throw new Error('missing-dispatch-permit');
    await journal.dispatchOnce({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      permit: start.permit,
      signal,
    });
    const cancel = await appendCancelCommand(fixture, 253_900);
    const requested = await journal.cancel({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: cancel.reference,
      signal,
    });
    if (requested.action !== 'INTERRUPT_ONCE') throw new Error('missing-interrupt-permit');
    await expect(
      journal.interruptOnce({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        permit: requested.permit,
        signal: AbortSignal.timeout(50),
      }),
    ).rejects.toBeDefined();
    expect(interruptCalls).toBe(1);
    expect(queryScalar(fixture.filename, 'state')).toBe('UNCERTAIN');
    expect(queryCount(fixture.filename, 'local_invocation_interrupt_receipts')).toBe(0);
    expect(
      await journal.recoverUnconfirmedInterrupts({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        signal,
      }),
    ).toBe(0);
    expect(interruptCalls).toBe(1);
    fixture.adapter.close();
    const reopened = new SqliteWorkerBrokerDurableTransport({ filename: fixture.filename });
    const recoveredJournal = reopened.createInvocationJournal({
      ...fixture.authorities.options,
      hostInterruptPort: {
        async interruptOnce() {
          interruptCalls += 1;
          throw new Error('SECOND_INTERRUPT_FORBIDDEN');
        },
      },
    });
    await expect(
      recoveredJournal.cancel({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        command: cancel.reference,
        signal,
      }),
    ).resolves.toMatchObject({ action: 'UNCERTAIN' });
    expect(interruptCalls).toBe(1);
    reopened.close();
  });

  it('serializes final-before-cancel and cancel-before-final without two terminal facts', async () => {
    const signal = new AbortController().signal;
    const finalFirst = await createCompletedFixture(256);
    const finalJournal = finalFirst.adapter.createInvocationJournal(finalFirst.authorities.options);
    const lateCancel = await appendCancelCommand(finalFirst, 256_900);
    await expect(
      finalJournal.cancel({
        installationId: finalFirst.installationId,
        ownerToken: OWNER,
        command: lateCancel.reference,
        signal,
      }),
    ).resolves.toMatchObject({ action: 'RETURN_TERMINAL', state: 'FINAL_READY' });
    expect(finalFirst.authorities.hostInterruptCalls.count).toBe(0);
    finalFirst.adapter.close();

    const cancelFirst = await createInvocationFixture(257);
    const cancelJournal = cancelFirst.adapter.createInvocationJournal(
      cancelFirst.authorities.options,
    );
    await bindCloudCommittedReady(cancelJournal, cancelFirst, signal);
    await cancelJournal.prepare({
      installationId: cancelFirst.installationId,
      ownerToken: OWNER,
      command: cancelFirst.prepareReference,
      signal,
    });
    const start = await cancelJournal.start({
      installationId: cancelFirst.installationId,
      ownerToken: OWNER,
      command: cancelFirst.startReference,
      signal,
    });
    if (start.action !== 'DISPATCH_ONCE') throw new Error('missing-dispatch-permit');
    await cancelJournal.dispatchOnce({
      installationId: cancelFirst.installationId,
      ownerToken: OWNER,
      permit: start.permit,
      signal,
    });
    const cancel = await appendCancelCommand(cancelFirst, 257_900);
    const requested = await cancelJournal.cancel({
      installationId: cancelFirst.installationId,
      ownerToken: OWNER,
      command: cancel.reference,
      signal,
    });
    if (requested.action !== 'INTERRUPT_ONCE') throw new Error('missing-interrupt-permit');
    await expect(
      cancelJournal.writeSucceeded({
        installationId: cancelFirst.installationId,
        ownerToken: OWNER,
        invocationId: cancelFirst.invocationId,
        dispatchNonce: start.permit.dispatchNonce,
        sourceEventId: cancelFirst.invocationId,
        resultCiphertext: encryptLocalResult(
          'late success must lose',
          cancelFirst.localResultKey,
          cancelFirst.resultHmacKey,
          cancelFirst.localResultKeyId,
          {
            schemaVersion: 1,
            installationId: cancelFirst.installationId,
            invocationId: cancelFirst.invocationId,
            conversationId: cancelFirst.conversationId,
            agentVersionDigest: SHA('a'),
            role: 'ASSISTANT',
          },
        ),
        signal,
      }),
    ).rejects.toMatchObject({ code: 'ILLEGAL_LOCAL_TRANSITION' });
    await cancelJournal.interruptOnce({
      installationId: cancelFirst.installationId,
      ownerToken: OWNER,
      permit: requested.permit,
      signal,
    });
    expect(queryScalar(cancelFirst.filename, 'state')).toBe('CANCELLED');
    expect(
      queryCountWhere(
        cancelFirst.filename,
        'local_invocation_events',
        `event_type IN ('invocation.succeeded', 'invocation.cancelled')`,
      ),
    ).toBe(1);
    cancelFirst.adapter.close();
  });

  it('never lets a D2 activation consume a pending D1 READY fact and later sends it on D1', async () => {
    const fixture = await createInvocationFixture(91);
    const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    const signal = new AbortController().signal;
    const ready = await journal.bindReadyConversation({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.openReference,
      evidence: { token: 'sandbox-ready' },
      signal,
    });
    const deploymentD1 = fixture.state.lease.deploymentId;
    const deploymentD2 = uuid(91_900);
    const d2 = await activateReplacementLease(fixture, 91_910, deploymentD2);
    await expect(
      fixture.adapter.replayPendingConversationReady({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        connectionId: d2.connectionId,
        signal,
      }),
    ).resolves.toEqual({ enqueued: 0, remaining: false });
    const d2Outbound = await fixture.adapter.readOutbound({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      connectionId: d2.connectionId,
      limit: 16,
      signal,
    });
    expect(d2Outbound.some((envelope) => envelope.type === 'conversation.ready')).toBe(false);

    const d1 = await activateReplacementLease(fixture, 91_920, deploymentD1);
    await expect(
      fixture.adapter.replayPendingConversationReady({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        connectionId: d1.connectionId,
        signal,
      }),
    ).resolves.toEqual({ enqueued: 1, remaining: false });
    const d1Outbound = await fixture.adapter.readOutbound({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      connectionId: d1.connectionId,
      limit: 16,
      signal,
    });
    const wire = d1Outbound.find((envelope) => envelope.type === 'conversation.ready');
    expect(wire).toMatchObject({
      body: { sourceEventId: ready.sourceEventId, factDigest: ready.factDigest },
      lease: { deploymentId: deploymentD1 },
    });
    fixture.adapter.close();
  });

  it('rechecks durable capability, revocation, and deadline in the synchronous pre-Host boundary', async () => {
    const cases = [
      { mode: 'CAP_EXACT' as const, expectedCode: 'EXECUTION_CAPABILITY_INVALID' },
      { mode: 'CAP_PLUS_ONE' as const, expectedCode: 'EXECUTION_CAPABILITY_INVALID' },
      { mode: 'SYNC_REVOKE' as const, expectedCode: 'EXECUTION_CAPABILITY_INVALID' },
      { mode: 'DEADLINE_WATERMARK_ADVANCE' as const, expectedCode: 'INVOCATION_DEADLINE_EXPIRED' },
      { mode: 'INVALID_FRESH_CLOCK' as const, expectedCode: 'INVOCATION_DEADLINE_EXPIRED' },
    ];
    for (const [index, testCase] of cases.entries()) {
      const fixture = await createInvocationFixture(260 + index);
      const signal = new AbortController().signal;
      const capability = fixture.prepareEnvelope.body.executionCapability;
      const deadlineMs = Date.parse(fixture.prepareEnvelope.body.deadlineAt);
      const capabilityExpiryMs = Date.parse(capability.expiresAt);
      let dispatchBoundary = false;
      let boundaryReads = 0;
      let hostCalls = 0;
      const journal = fixture.adapter.createInvocationJournal({
        ...fixture.authorities.options,
        cloudClock: {
          now() {
            if (!dispatchBoundary) return new Date(fixture.authorities.cloudNow.value);
            boundaryReads += 1;
            if (boundaryReads === 1) return new Date(deadlineMs - 1);
            if (testCase.mode === 'SYNC_REVOKE') {
              fixture.authorities.revokedCapabilityIds.add(capability.capabilityId);
              return new Date(deadlineMs - 1);
            }
            if (testCase.mode === 'INVALID_FRESH_CLOCK') return new Date(Number.NaN);
            if (testCase.mode === 'DEADLINE_WATERMARK_ADVANCE') return new Date(deadlineMs);
            return new Date(capabilityExpiryMs + (testCase.mode === 'CAP_PLUS_ONE' ? 1 : 0));
          },
        },
        hostDispatchPort: {
          async dispatchOnce() {
            hostCalls += 1;
            throw new Error('HOST_MUST_NOT_BE_REACHED');
          },
        },
      });
      await bindCloudCommittedReady(journal, fixture, signal);
      await journal.prepare({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        command: fixture.prepareReference,
        signal,
      });
      const start = await journal.start({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        command: fixture.startReference,
        signal,
      });
      if (start.action !== 'DISPATCH_ONCE') throw new Error('missing-permit');
      dispatchBoundary = true;
      await expect(
        journal.dispatchOnce({
          installationId: fixture.installationId,
          ownerToken: OWNER,
          permit: start.permit,
          signal,
        }),
      ).rejects.toMatchObject({ code: testCase.expectedCode });
      expect(boundaryReads).toBe(2);
      expect(hostCalls).toBe(0);
      expect(queryScalar(fixture.filename, 'state')).toBe('FAILED');
      expect(queryNullable(fixture.filename, 'local_invocations', 'prompt_ciphertext')).toBeNull();
      const terminal = new SqliteDatabase(fixture.filename, { readOnly: true });
      expect(
        terminal
          .prepare(
            `SELECT count(*) AS count FROM local_invocation_events
             WHERE event_type = 'invocation.failed' AND to_state = 'FAILED'`,
          )
          .get(),
      ).toEqual({ count: 1 });
      expect(
        terminal
          .prepare(
            `SELECT count(*) AS count FROM local_invocation_events
             WHERE event_type = 'invocation.uncertain'`,
          )
          .get(),
      ).toEqual({ count: 0 });
      terminal.close();
      dispatchBoundary = false;
      await expect(
        journal.dispatchOnce({
          installationId: fixture.installationId,
          ownerToken: OWNER,
          permit: start.permit,
          signal,
        }),
      ).rejects.toMatchObject({ code: 'PROMPT_AEAD_INVALID' });
      expect(hostCalls).toBe(0);
      fixture.adapter.close();
    }
  });

  it('preserves physical DB/WAL/filesystem reserve for terminal and Cloud reconciliation', async () => {
    let availableBytes = Number.MAX_SAFE_INTEGER;
    let pressureActive = false;
    let filename = '';
    const fixture = await createInvocationFixture(274, {
      maxDatabaseBytes: 8 * 1024 * 1024,
      maxWalBytes: 1024 * 1024,
      minFreeBytes: 1,
      availableFilesystemBytesForTests: () => availableBytes,
      faultInjector(point) {
        if (
          pressureActive &&
          point.startsWith('invocation_') &&
          point.endsWith('.before_commit') &&
          existsSync(`${filename}.recovery-reserve`)
        ) {
          throw Object.assign(new Error('SIMULATED_ENOSPC_WITHOUT_PHYSICAL_RESERVE'), {
            code: 'ENOSPC',
          });
        }
      },
    });
    filename = fixture.filename;
    const signal = new AbortController().signal;
    const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    await bindCloudCommittedReady(journal, fixture, signal);
    await journal.prepare({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.prepareReference,
      signal,
    });
    const start = await journal.start({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.startReference,
      signal,
    });
    if (start.action !== 'DISPATCH_ONCE') throw new Error('missing-permit');
    const physicalReserve = statSync(`${fixture.filename}.recovery-reserve`);
    expect(physicalReserve.size).toBe(1024 * 1024);
    expect(physicalReserve.blocks * 512).toBeGreaterThanOrEqual(physicalReserve.size);

    // A filesystem-pressure probe rejects new admission while leaving STARTING intact.
    availableBytes = 0;
    let admissionError: unknown;
    try {
      await fixture.adapter.enqueueHeartbeat({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        connectionId: fixture.state.connectionId,
        lease: fixture.startEnvelope.lease,
        cloudLeaseExpiresAt: fixture.startEnvelope.expiresAt,
        signal,
      });
    } catch (error) {
      admissionError = error;
    }
    expect(admissionError).toMatchObject({ code: 'CAPACITY_EXCEEDED' });
    expect(queryScalar(fixture.filename, 'state')).toBe('STARTING');
    availableBytes = Number.MAX_SAFE_INTEGER;

    // Fill real SQLite pages with valid, large Broker commands until max_page_count admission
    // rejects. The terminal reserve is protected by the pre-COMMIT freelist floor.
    let admitted = 0;
    for (let index = 0; index < 300; index += 1) {
      const envelope = pressurePrepareEnvelope(fixture, 274_000 + index);
      try {
        fixture.state = await commitCommand(
          fixture.adapter,
          fixture.installationId,
          fixture.state,
          envelope,
        );
        admitted += 1;
      } catch (error) {
        expect(error).toMatchObject({ code: 'CAPACITY_EXCEEDED' });
        break;
      }
    }
    expect(admitted).toBeGreaterThan(50);
    expect(admitted).toBeLessThan(300);
    expect(queryScalar(fixture.filename, 'state')).toBe('STARTING');

    // Under simultaneous filesystem/max-page pressure the real sidecar is removed before the
    // WAL write; the injected ENOSPC guard would fail any fake operation-name-only bypass.
    availableBytes = 0;
    pressureActive = true;
    await journal.dispatchOnce({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      permit: start.permit,
      signal,
    });
    expect(existsSync(`${fixture.filename}.recovery-reserve`)).toBe(true);
    expect(queryPragmaNumber(fixture.filename, 'freelist_count')).toBeGreaterThan(128);
    expect(queryScalar(fixture.filename, 'state')).toBe('RUNNING');
    await journal.writeSucceeded({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      invocationId: fixture.invocationId,
      dispatchNonce: start.permit.dispatchNonce,
      sourceEventId: fixture.invocationId,
      resultCiphertext: encryptLocalResult(
        'pressure-safe result',
        fixture.localResultKey,
        fixture.resultHmacKey,
        fixture.localResultKeyId,
        {
          schemaVersion: 1,
          installationId: fixture.installationId,
          invocationId: fixture.invocationId,
          conversationId: fixture.conversationId,
          agentVersionDigest: SHA('a'),
          role: 'ASSISTANT',
        },
      ),
      signal,
    });
    expect(queryScalar(fixture.filename, 'state')).toBe('FINAL_READY');
    assertLocalIntegrity(fixture.filename);
    fixture.adapter.close();

    // Cloud ACK ingestion and fact polling are ordinary admission and cannot consume reserve.
    // Establish the exact durable ACK while healthy, then prove only the terminal projection can
    // release the physical filesystem reserve when capacity disappears.
    let ackAvailableBytes = Number.MAX_SAFE_INTEGER;
    let ackPressure = false;
    let ackFilename = '';
    const ackFixture = await createCompletedFixture(275, {
      minFreeBytes: 1,
      availableFilesystemBytesForTests: () => ackAvailableBytes,
      faultInjector(point) {
        if (
          ackPressure &&
          point === 'invocation_mark_cloud_committed.before_commit' &&
          existsSync(`${ackFilename}.recovery-reserve`)
        ) {
          throw Object.assign(new Error('SIMULATED_ACK_ENOSPC'), { code: 'ENOSPC' });
        }
      },
    });
    ackFilename = ackFixture.filename;
    const ackJournal = ackFixture.adapter.createInvocationJournal(ackFixture.authorities.options);
    const terminal = (
      await ackJournal.readPendingFacts({
        installationId: ackFixture.installationId,
        ownerToken: OWNER,
        limit: 10,
        signal,
      })
    ).find((fact) => fact.sourceEventId === ackFixture.invocationId);
    if (terminal === undefined) throw new Error('missing-ack-terminal');
    const committed = await enqueueAndCommitCloudAck(
      ackFixture.adapter,
      ackJournal,
      ackFixture,
      terminal,
      275_900,
    );
    ackFixture.state = committed.state;
    ackAvailableBytes = 0;
    ackPressure = true;
    await expect(
      ackJournal.markCloudCommitted({
        installationId: ackFixture.installationId,
        ownerToken: OWNER,
        ack: committed.ack,
        evidence: { token: 'cloud-committed' },
        signal,
      }),
    ).resolves.toBeUndefined();
    expect(existsSync(`${ackFixture.filename}.recovery-reserve`)).toBe(true);
    expect(queryPragmaNumber(ackFixture.filename, 'freelist_count')).toBeGreaterThanOrEqual(192);
    expect(queryScalar(ackFixture.filename, 'state')).toBe('CLOUD_COMMITTED');
    assertLocalIntegrity(ackFixture.filename);
    ackFixture.adapter.close();
  }, 30_000);

  it('keeps an unattempted STARTING intent recoverable without consuming reserve or Prompt', async () => {
    let availableBytes = Number.MAX_SAFE_INTEGER;
    let pressureActive = false;
    let filename = '';
    const fixture = await createInvocationFixture(276, {
      minFreeBytes: 1,
      availableFilesystemBytesForTests: () => availableBytes,
      faultInjector(point) {
        if (
          pressureActive &&
          point === 'invocation_recover_unconfirmed_start.before_commit' &&
          existsSync(`${filename}.recovery-reserve`)
        ) {
          throw Object.assign(new Error('SIMULATED_RECOVERY_ENOSPC'), { code: 'ENOSPC' });
        }
      },
    });
    filename = fixture.filename;
    const signal = new AbortController().signal;
    const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    await bindCloudCommittedReady(journal, fixture, signal);
    await journal.prepare({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.prepareReference,
      signal,
    });
    const retainedPrompt = queryJson(
      fixture.filename,
      'SELECT prompt_ciphertext AS value FROM local_invocations',
    ) as LocalInvocationPromptCiphertext;
    const start = await journal.start({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.startReference,
      signal,
    });
    expect(start.action).toBe('DISPATCH_ONCE');
    availableBytes = 0;
    pressureActive = true;
    await expect(
      journal.recoverUnconfirmedStarts({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        signal,
      }),
    ).resolves.toBe(0);
    expect(existsSync(`${fixture.filename}.recovery-reserve`)).toBe(true);
    expect(queryPragmaNumber(fixture.filename, 'freelist_count')).toBeGreaterThanOrEqual(192);
    expect(queryScalar(fixture.filename, 'state')).toBe('STARTING');
    expect(
      queryNullable(fixture.filename, 'local_invocations', 'prompt_ciphertext'),
    ).not.toBeNull();
    expect(
      rawJournalContainsAny(fixture.filename, [
        retainedPrompt.nonce,
        retainedPrompt.ciphertext,
        retainedPrompt.authTag,
      ]),
    ).toBe(true);
    expect(fixture.authorities.hostDispatchCalls.count).toBe(0);
    fixture.adapter.close();
  });

  it.each([['FAILED', 276_100] as const, ['UNCERTAIN', 276_200] as const])(
    'preserves terminal reserve for a RUNNING to %s Host settlement',
    async (terminal, seed) => {
      let availableBytes = Number.MAX_SAFE_INTEGER;
      let pressureActive = false;
      let filename = '';
      const fixture = await createInvocationFixture(seed, {
        minFreeBytes: 1,
        availableFilesystemBytesForTests: () => availableBytes,
        faultInjector(point) {
          if (
            pressureActive &&
            point.endsWith('.before_commit') &&
            existsSync(`${filename}.recovery-reserve`)
          ) {
            throw Object.assign(new Error('SIMULATED_TERMINAL_ENOSPC'), { code: 'ENOSPC' });
          }
        },
      });
      filename = fixture.filename;
      const signal = new AbortController().signal;
      const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
      const running = await driveInvocationToRunning(journal, fixture, signal);
      availableBytes = 0;
      pressureActive = true;
      if (terminal === 'FAILED') {
        await journal.writeFailed({
          installationId: fixture.installationId,
          ownerToken: OWNER,
          invocationId: fixture.invocationId,
          dispatchNonce: running.dispatchNonce,
          sourceEventId: fixture.invocationId,
          errorCode: 'TURN_FAILED',
          signal,
        });
      } else {
        await journal.markHostEvidenceLost({
          installationId: fixture.installationId,
          ownerToken: OWNER,
          invocationId: fixture.invocationId,
          dispatchNonce: running.dispatchNonce,
          sourceEventId: fixture.invocationId,
          signal,
        });
      }
      expect(queryScalar(fixture.filename, 'state')).toBe(terminal);
      expect(existsSync(`${fixture.filename}.recovery-reserve`)).toBe(true);
      assertLocalIntegrity(fixture.filename);
      fixture.adapter.close();
    },
  );

  it('protects reserve across 1000 exact Cloud ACK replays and fails pinned polling before reserve', async () => {
    const fixture = await createCompletedFixture(277, {
      maxWalBytes: 1024 * 1024,
      minFreeBytes: 1,
    });
    const signal = new AbortController().signal;
    const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    const terminal = (
      await journal.readPendingFacts({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        limit: 10,
        signal,
      })
    ).find((fact) => fact.sourceEventId === fixture.invocationId);
    if (terminal === undefined) throw new Error('missing-replay-terminal');
    const committed = await enqueueAndCommitCloudAck(
      fixture.adapter,
      journal,
      fixture,
      terminal,
      277_900,
    );
    fixture.state = committed.state;
    const ackDigest = canonicalSha256(committed.ackEnvelope);
    const commitEpochBeforeReplays = Number(
      queryScalarFrom(fixture.filename, 'transport_meta', 'commit_epoch'),
    );
    for (let index = 0; index < 1_000; index += 1) {
      await expect(
        fixture.adapter.replayInbound({
          installationId: fixture.installationId,
          ownerToken: OWNER,
          connectionId: fixture.state.connectionId,
          envelope: committed.ackEnvelope,
          canonicalDigest: ackDigest,
          signal,
        }),
      ).resolves.toBe('EXACT_REPLAY');
    }
    expect(Number(queryScalarFrom(fixture.filename, 'transport_meta', 'commit_epoch'))).toBe(
      commitEpochBeforeReplays + 1_000,
    );
    expect(
      queryScalarWhere(
        fixture.filename,
        'transport_inbound_frames',
        'replay_count',
        `message_id = '${committed.ackEnvelope.messageId}'`,
      ),
    ).toBe(1_000);
    expect(queryPragmaNumber(fixture.filename, 'freelist_count')).toBeGreaterThanOrEqual(192);
    const reserve = statSync(`${fixture.filename}.recovery-reserve`);
    expect(reserve.size).toBe(1024 * 1024);
    expect(reserve.blocks * 512).toBeGreaterThanOrEqual(reserve.size);

    const pinnedReader = new SqliteDatabase(fixture.filename, { readOnly: true });
    pinnedReader.exec('BEGIN');
    pinnedReader.prepare('SELECT commit_epoch FROM transport_meta').get();
    let polls = 0;
    let pollingError: unknown;
    while (polls < 1_000) {
      try {
        await journal.readPendingFacts({
          installationId: fixture.installationId,
          ownerToken: OWNER,
          limit: 10,
          signal,
        });
        polls += 1;
      } catch (error) {
        pollingError = error;
        break;
      }
    }
    expect(polls).toBeLessThan(1_000);
    expect(pollingError).toMatchObject({ code: 'CAPACITY_EXCEEDED' });
    expect(queryPragmaNumber(fixture.filename, 'freelist_count')).toBeGreaterThanOrEqual(192);
    expect(existsSync(`${fixture.filename}.recovery-reserve`)).toBe(true);
    pinnedReader.exec('ROLLBACK');
    pinnedReader.close();

    await expect(
      journal.markCloudCommitted({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        ack: committed.ack,
        evidence: { token: 'cloud-committed' },
        signal,
      }),
    ).resolves.toBeUndefined();
    expect(queryScalar(fixture.filename, 'state')).toBe('CLOUD_COMMITTED');
    expect(queryPragmaNumber(fixture.filename, 'freelist_count')).toBeGreaterThanOrEqual(192);
    const replenished = statSync(`${fixture.filename}.recovery-reserve`);
    expect(replenished.blocks * 512).toBeGreaterThanOrEqual(replenished.size);
    assertLocalIntegrity(fixture.filename);
    fixture.adapter.close();
  }, 60_000);

  it('fails closed when a pinned reader blocks Prompt purge checkpoint and truncates before reopen serves', async () => {
    const fixture = await createInvocationFixture(275);
    const signal = new AbortController().signal;
    const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    await bindCloudCommittedReady(journal, fixture, signal);

    const brokerPrompt = fixture.prepareEnvelope.body.userMessageCiphertext;
    const pinnedReader = new SqliteDatabase(fixture.filename, { readOnly: true });
    pinnedReader.exec('BEGIN');
    expect(
      pinnedReader
        .prepare(
          `SELECT envelope_json FROM transport_inbound_frames
           WHERE message_id = ? AND envelope_type = 'invocation.prepare'`,
        )
        .get(fixture.prepareEnvelope.messageId),
    ).toBeDefined();

    await expect(
      journal.prepare({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        command: fixture.prepareReference,
        signal,
      }),
    ).rejects.toMatchObject({ code: 'JOURNAL_BUSY' });
    expect(queryScalar(fixture.filename, 'state')).toBe('PREPARED');
    await expect(
      fixture.adapter.readPendingCommands({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        connectionId: fixture.state.connectionId,
        limit: 16,
        signal,
      }),
    ).rejects.toMatchObject({ code: 'JOURNAL_CORRUPT' });

    pinnedReader.exec('ROLLBACK');
    pinnedReader.close();
    const reopened = new SqliteWorkerBrokerDurableTransport({ filename: fixture.filename });
    expect(() => reopened.createInvocationJournal(fixture.authorities.options)).not.toThrow();
    expect(
      rawJournalContainsAny(fixture.filename, [
        brokerPrompt.nonce,
        brokerPrompt.ciphertext,
        brokerPrompt.authTag,
      ]),
    ).toBe(false);
    reopened.close();
    fixture.adapter.close();
  });

  it('keeps a busy cleanup one-use, reopens UNCERTAIN, and removes the released local Prompt', async () => {
    const fixture = await createInvocationFixture(285);
    const signal = new AbortController().signal;
    let hostCalls = 0;
    const journal = fixture.adapter.createInvocationJournal({
      ...fixture.authorities.options,
      hostDispatchPort: {
        async dispatchOnce() {
          hostCalls += 1;
          throw new Error('HOST_TIMEOUT_AFTER_ATTEMPT');
        },
      },
    });
    await bindCloudCommittedReady(journal, fixture, signal);
    await journal.prepare({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.prepareReference,
      signal,
    });
    const localPrompt = queryJson(
      fixture.filename,
      'SELECT prompt_ciphertext AS value FROM local_invocations',
    ) as LocalInvocationPromptCiphertext;
    const start = await journal.start({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.startReference,
      signal,
    });
    if (start.action !== 'DISPATCH_ONCE') throw new Error('missing-permit');

    const pinnedReader = new SqliteDatabase(fixture.filename, { readOnly: true });
    pinnedReader.exec('BEGIN');
    expect(
      pinnedReader.prepare('SELECT prompt_ciphertext FROM local_invocations').get(),
    ).toBeDefined();
    await expect(
      journal.dispatchOnce({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        permit: start.permit,
        signal,
      }),
    ).rejects.toMatchObject({ code: 'JOURNAL_BUSY' });
    expect(hostCalls).toBe(1);
    expect(queryScalar(fixture.filename, 'state')).toBe('UNCERTAIN');
    expect(queryNullable(fixture.filename, 'local_invocations', 'prompt_ciphertext')).toBeNull();

    pinnedReader.exec('ROLLBACK');
    pinnedReader.close();
    const reopened = new SqliteWorkerBrokerDurableTransport({ filename: fixture.filename });
    const recoveredJournal = reopened.createInvocationJournal({
      ...fixture.authorities.options,
      hostDispatchPort: {
        async dispatchOnce() {
          hostCalls += 1;
          throw new Error('SECOND_HOST_DISPATCH');
        },
      },
    });
    expect(
      await recoveredJournal.recoverUnconfirmedStarts({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        signal,
      }),
    ).toBe(0);
    await expect(
      recoveredJournal.dispatchOnce({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        permit: start.permit,
        signal,
      }),
    ).rejects.toMatchObject({ code: 'PROMPT_AEAD_INVALID' });
    expect(hostCalls).toBe(1);
    expect(
      rawJournalContainsAny(fixture.filename, [
        localPrompt.nonce,
        localPrompt.ciphertext,
        localPrompt.authTag,
      ]),
    ).toBe(false);
    reopened.close();
    fixture.adapter.close();
  });

  it('retains an exact Cloud ACK frame until its local receipt retention can be pruned', async () => {
    const fixture = await createCompletedFixture(290);
    const signal = new AbortController().signal;
    const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    const terminal = (
      await journal.readPendingFacts({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        limit: 10,
        signal,
      })
    ).find((fact) => fact.eventType === 'invocation.succeeded');
    if (terminal === undefined) throw new Error('missing-terminal-fact');
    const committed = await enqueueAndCommitCloudAck(
      fixture.adapter,
      journal,
      fixture,
      terminal,
      290_700,
    );
    await journal.markCloudCommitted({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      ack: committed.ack,
      evidence: { token: 'cloud-committed' },
      signal,
    });
    fixture.adapter.close();

    const futureNow = Date.now() + 8 * 24 * 60 * 60 * 1_000;
    const pruningAdapter = new SqliteWorkerBrokerDurableTransport({
      filename: fixture.filename,
      now: () => futureNow,
    });
    await pruningAdapter.acquireInstallation({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      signal,
    });
    await pruningAdapter.pruneRetained({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      signal,
    });
    const database = new SqliteDatabase(fixture.filename, { readOnly: true });
    expect(
      (
        database
          .prepare(
            `SELECT count(*) AS count FROM transport_inbound_frames
             WHERE connection_id = ? AND sequence = ? AND message_id = ?`,
          )
          .get(committed.ack.connectionId, committed.ack.sequence, committed.ack.messageId) as {
          count: number;
        }
      ).count,
    ).toBe(1);
    database.close();
    pruningAdapter.close();

    const reopened = new SqliteWorkerBrokerDurableTransport({ filename: fixture.filename });
    expect(() => reopened.createInvocationJournal(fixture.authorities.options)).not.toThrow();
    reopened.close();
  });

  it('projects an exact v3 Invocation ACK receipt into self-contained v4 authority', async () => {
    const fixture = await createCompletedFixture(291);
    const signal = new AbortController().signal;
    const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    const terminal = (
      await journal.readPendingFacts({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        limit: 10,
        signal,
      })
    ).find((fact) => fact.eventType === 'invocation.succeeded');
    if (terminal === undefined) throw new Error('missing-v3-migration-terminal-fact');
    const committed = await enqueueAndCommitCloudAck(
      fixture.adapter,
      journal,
      fixture,
      terminal,
      291_700,
      'IDEMPOTENT_REPLAY',
    );
    await journal.markCloudCommitted({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      ack: committed.ack,
      evidence: { token: 'cloud-committed' },
      signal,
    });
    fixture.adapter.close();

    downgradeToLegacyV3(fixture.filename);
    expect(queryPragmaNumber(fixture.filename, 'user_version')).toBe(3);
    expect(
      queryCountWhere(
        fixture.filename,
        `pragma_table_info('local_invocation_outbox_receipts')`,
        `name IN ('ack_decision', 'ack_logical_digest')`,
      ),
    ).toBe(0);
    const legacyDatabase = new SqliteDatabase(fixture.filename, { readOnly: true });
    expect(() => assertWorkerInvocationIntegrity(legacyDatabase)).not.toThrow();
    legacyDatabase.close();

    const migrated = new SqliteWorkerBrokerDurableTransport({ filename: fixture.filename });
    expect(migrated.inspectPragmas().userVersion).toBe(WORKER_TRANSPORT_SCHEMA_VERSION);
    expect(queryCount(fixture.filename, 'transport_connections')).toBe(0);
    expect(queryCount(fixture.filename, 'transport_inbound_frames')).toBe(0);
    expect(queryCount(fixture.filename, 'transport_outbox')).toBe(0);
    expect(queryCount(fixture.filename, 'local_invocation_outbox_receipts')).toBe(1);
    expect(
      queryScalarFrom(fixture.filename, 'local_invocation_outbox_receipts', 'ack_decision'),
    ).toBe('IDEMPOTENT_REPLAY');
    expect(
      queryScalarFrom(fixture.filename, 'local_invocation_outbox_receipts', 'ack_logical_digest'),
    ).toBe(
      canonicalSha256({
        protocol: committed.ackEnvelope.protocol,
        schemaVersion: committed.ackEnvelope.schemaVersion,
        kind: committed.ackEnvelope.kind,
        type: committed.ackEnvelope.type,
        messageId: committed.ackEnvelope.messageId,
        correlationId: committed.ackEnvelope.correlationId,
        body: committed.ackEnvelope.body,
      }),
    );
    const migratedDatabase = new SqliteDatabase(fixture.filename, { readOnly: true });
    expect(() => assertWorkerInvocationIntegrity(migratedDatabase)).not.toThrow();
    migratedDatabase.close();
    expect(() => migrated.createInvocationJournal(fixture.authorities.options)).not.toThrow();
    migrated.close();

    const contentDrift = cloneClosedJournal(fixture.filename);
    rewriteAppendOnlyAuthorityRow(
      contentDrift,
      'local_invocation_outbox_receipts',
      'ack_decision',
      'APPLIED',
    );
    assertLocallyConsistentWorkerJournal(contentDrift);
    expect(() => new SqliteWorkerBrokerDurableTransport({ filename: contentDrift })).toThrowError(
      expect.objectContaining({ code: 'JOURNAL_CORRUPT' }),
    );

    const deletedReceipt = cloneClosedJournal(fixture.filename);
    deleteAppendOnlyAuthorityRow(deletedReceipt, 'local_invocation_outbox_receipts');
    assertLocallyConsistentWorkerJournal(deletedReceipt);
    expect(() => new SqliteWorkerBrokerDurableTransport({ filename: deletedReceipt })).toThrowError(
      expect.objectContaining({ code: 'JOURNAL_CORRUPT' }),
    );

    const reopened = new SqliteWorkerBrokerDurableTransport({ filename: fixture.filename });
    expect(() => reopened.createInvocationJournal(fixture.authorities.options)).not.toThrow();
    reopened.close();
  });

  it('migrates exact v4 dispatch counters to v5 and publishes the interrupt authority atomically', async () => {
    const fixture = await createInvocationFixture(292);
    const signal = new AbortController().signal;
    const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    await bindCloudCommittedReady(journal, fixture, signal);
    await journal.prepare({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.prepareReference,
      signal,
    });
    const start = await journal.start({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.startReference,
      signal,
    });
    if (start.action !== 'DISPATCH_ONCE') throw new Error('missing-v4-dispatch-intent');
    fixture.adapter.close();
    downgradeToLegacyV4(fixture.filename);
    expect(queryPragmaNumber(fixture.filename, 'user_version')).toBe(4);
    expect(
      queryCountWhere(
        fixture.filename,
        `pragma_table_info('local_invocations')`,
        `name = 'host_prompt_release_count'`,
      ),
    ).toBe(1);
    const reopened = new SqliteWorkerBrokerDurableTransport({ filename: fixture.filename });
    expect(reopened.inspectPragmas().userVersion).toBe(WORKER_TRANSPORT_SCHEMA_VERSION);
    expect(queryScalar(fixture.filename, 'host_dispatch_attempt_count')).toBe(0);
    expect(queryCount(fixture.filename, 'local_invocation_interrupt_receipts')).toBe(0);
    expect(
      queryCountWhere(
        fixture.filename,
        `pragma_table_info('local_invocations')`,
        `name = 'host_prompt_release_count'`,
      ),
    ).toBe(0);
    expect(() => reopened.createInvocationJournal(fixture.authorities.options)).not.toThrow();
    const manifest = JSON.parse(readFileSync(`${fixture.filename}.migration-recovery`, 'utf8')) as {
      payload: { legacySlot: { schemaVersion: number }; finalizedSlot: { schemaVersion: number } };
    };
    expect(manifest.payload.legacySlot.schemaVersion).toBe(4);
    expect(manifest.payload.finalizedSlot.schemaVersion).toBe(5);
    reopened.close();
  });

  it('classifies exact legacy v4 CANCELLED as reconciliation-required with zero byte mutation', async () => {
    const fixture = await createInvocationFixture(298);
    const signal = new AbortController().signal;
    const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    await bindCloudCommittedReady(journal, fixture, signal);
    await journal.prepare({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.prepareReference,
      signal,
    });
    const cancel = await appendCancelCommand(fixture, 298_900);
    await journal.cancel({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: cancel.reference,
      signal,
    });
    fixture.adapter.close();
    downgradeToLegacyV4(fixture.filename, { allowCancelledForMigrationTest: true });
    const databaseBefore = readFileSync(fixture.filename);
    const watermarkBefore = readFileSync(`${fixture.filename}.watermark`);
    expect(
      () => new SqliteWorkerBrokerDurableTransport({ filename: fixture.filename }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_RECONCILIATION_REQUIRED' }));
    expect(queryPragmaNumber(fixture.filename, 'user_version')).toBe(4);
    expect(readFileSync(fixture.filename)).toEqual(databaseBefore);
    expect(readFileSync(`${fixture.filename}.watermark`)).toEqual(watermarkBefore);
  });

  it.each([
    'migration.v4_to_v5.after_local_projection',
    'migration.v4_to_v5.after_watermark_fsync',
  ] as const)('rolls back v4 after a late migration deadline at %s', async (faultPoint) => {
    const seed =
      299 +
      [
        'migration.v4_to_v5.after_local_projection',
        'migration.v4_to_v5.after_watermark_fsync',
      ].indexOf(faultPoint);
    const fixture = await createInvocationFixture(seed);
    fixture.adapter.close();
    downgradeToLegacyV4(fixture.filename);
    const databaseBefore = readFileSync(fixture.filename);
    const watermarkBefore = readFileSync(`${fixture.filename}.watermark`);
    const epochBefore = queryScalarFrom(fixture.filename, 'transport_meta', 'commit_epoch');

    expect(
      () =>
        new SqliteWorkerBrokerDurableTransport({
          filename: fixture.filename,
          operationTimeoutMs: 50,
          faultInjector(point) {
            if (point === faultPoint) {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
            }
          },
        }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_ABORTED' }));
    expect(queryPragmaNumber(fixture.filename, 'user_version')).toBe(4);
    expect(readFileSync(fixture.filename)).toEqual(databaseBefore);
    expect(readFileSync(`${fixture.filename}.watermark`)).toEqual(watermarkBefore);
    expect(queryScalarFrom(fixture.filename, 'transport_meta', 'commit_epoch')).toBe(epochBefore);

    const recovered = new SqliteWorkerBrokerDurableTransport({ filename: fixture.filename });
    expect(recovered.inspectPragmas().userVersion).toBe(5);
    recovered.close();
  });

  it.each([
    'migration.v4_to_v5.before_watermark',
    'migration.v4_to_v5.after_watermark_fsync',
    'migration.v4_to_v5.after_commit',
  ] as const)('recovers the exact v4 -> v5 watermark crash at %s', async (faultPoint) => {
    const seed =
      293 +
      [
        'migration.v4_to_v5.before_watermark',
        'migration.v4_to_v5.after_watermark_fsync',
        'migration.v4_to_v5.after_commit',
      ].indexOf(faultPoint);
    const fixture = await createInvocationFixture(seed);
    fixture.adapter.close();
    downgradeToLegacyV4(fixture.filename);
    expect(
      () =>
        new SqliteWorkerBrokerDurableTransport({
          filename: fixture.filename,
          faultInjector(point) {
            if (point === faultPoint) throw new Error(`SIMULATED:${faultPoint}`);
          },
        }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CORRUPT' }));
    const recovered = new SqliteWorkerBrokerDurableTransport({ filename: fixture.filename });
    expect(recovered.inspectPragmas().userVersion).toBe(5);
    expect(() => recovered.createInvocationJournal(fixture.authorities.options)).not.toThrow();
    recovered.close();
  });

  it('keeps retained local Prompt ciphertext out of the v3 migration recovery manifest', async () => {
    const fixture = await createInvocationFixture(291_500);
    const signal = new AbortController().signal;
    const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    await bindCloudCommittedReady(journal, fixture, signal);
    await journal.prepare({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.prepareReference,
      signal,
    });
    const start = await journal.start({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.startReference,
      signal,
    });
    expect(start.action).toBe('DISPATCH_ONCE');
    const retainedPrompt = queryScalar(fixture.filename, 'prompt_ciphertext') as string;
    const retainedPromptFields = JSON.parse(retainedPrompt) as LocalInvocationPromptCiphertext;
    fixture.adapter.close();
    downgradeToLegacyV3(fixture.filename);

    const migrated = new SqliteWorkerBrokerDurableTransport({ filename: fixture.filename });
    expect(migrated.inspectPragmas().userVersion).toBe(WORKER_TRANSPORT_SCHEMA_VERSION);
    expect(() => migrated.createInvocationJournal(fixture.authorities.options)).not.toThrow();
    migrated.close();
    const manifestPath = `${fixture.filename}.migration-recovery`;
    const manifestBytes = readFileSync(manifestPath);
    for (const forbidden of [
      retainedPrompt,
      retainedPromptFields.nonce,
      retainedPromptFields.ciphertext,
      retainedPromptFields.authTag,
      'secret prompt',
    ]) {
      expect(manifestBytes.includes(Buffer.from(forbidden, 'utf8')), forbidden).toBe(false);
    }
    expect(statSync(manifestPath).mode & 0o777).toBe(0o600);
    expect(queryScalar(fixture.filename, 'prompt_ciphertext')).toBe(retainedPrompt);
  });

  it('purges a retired Session result wire and re-encrypts the same fact for the new Session', async () => {
    const fixture = await createCompletedFixture(292);
    const signal = new AbortController().signal;
    const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    const terminal = (
      await journal.readPendingFacts({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        limit: 10,
        signal,
      })
    ).find((fact) => fact.eventType === 'invocation.succeeded');
    if (terminal === undefined) throw new Error('missing-terminal-fact');
    const firstDelivery = await journal.enqueuePendingFact({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      reference: terminal,
      connectionId: fixture.state.connectionId,
      deliveryMessageId: uuid(292_700),
      brokerKeyId: fixture.keyId,
      signal,
    });
    const firstWire = queryJson(
      fixture.filename,
      `SELECT envelope_json AS value FROM transport_outbox
       WHERE message_id = '${firstDelivery.deliveryMessageId}'`,
    ) as Extract<BrokerEnvelope, { type: 'invocation.succeeded' }>;
    const firstWireCanaries = [
      firstWire.body.resultCiphertext.nonce,
      firstWire.body.resultCiphertext.ciphertext,
      firstWire.body.resultCiphertext.authTag,
    ];

    const replacementConnectionId = uuid(292_710);
    const replacementLease = {
      deploymentId: fixture.state.lease.deploymentId,
      leaseId: uuid(292_711),
      workerSessionId: uuid(292_712),
      fence: String(BigInt(fixture.state.lease.fence) + 1n),
    };
    const sentAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const grant = BrokerEnvelopeSchema.parse({
      protocol: 'combo.creator-broker/1',
      schemaVersion: 1,
      kind: 'command',
      type: 'lease.grant',
      messageId: uuid(292_713),
      correlationId: replacementLease.deploymentId,
      connectionId: replacementConnectionId,
      sequence: '0',
      sentAt,
      expiresAt,
      lease: replacementLease,
      body: {
        leaseExpiresAt: expiresAt,
        workerSessionId: replacementLease.workerSessionId,
        generation: '2',
      },
    }) as Extract<BrokerEnvelope, { type: 'lease.grant' }>;
    const grantDigest = canonicalSha256(grant);
    const grantDecision = consumeSequence(
      initialSequenceCursor(replacementConnectionId),
      grant,
      grantDigest,
      Date.parse(sentAt),
    );
    if (grantDecision.type !== 'ACCEPT') throw new Error('replacement-grant');
    const replacementState = await fixture.adapter.activateConnection({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      envelope: grant,
      canonicalDigest: grantDigest,
      inboundCursor: serializeSequenceCursor(grantDecision.cursor),
      signal,
    });
    expect(rawJournalContainsAny(fixture.filename, firstWireCanaries)).toBe(false);
    expect(
      queryNullable(fixture.filename, 'local_invocations', 'result_ciphertext'),
    ).not.toBeNull();

    const secondDelivery = await journal.enqueuePendingFact({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      reference: terminal,
      connectionId: replacementState.connectionId,
      deliveryMessageId: uuid(292_714),
      brokerKeyId: fixture.keyId,
      signal,
    });
    const secondWire = queryJson(
      fixture.filename,
      `SELECT envelope_json AS value FROM transport_outbox
       WHERE message_id = '${secondDelivery.deliveryMessageId}'`,
    ) as Extract<BrokerEnvelope, { type: 'invocation.succeeded' }>;
    expect(secondWire.body.resultCiphertext.aad.workerSessionId).toBe(
      replacementLease.workerSessionId,
    );
    expect(secondWire.body.resultCiphertext.ciphertext).not.toBe(
      firstWire.body.resultCiphertext.ciphertext,
    );
    fixture.adapter.close();
  });

  it('prunes standalone security command tombstones after seven Cloud-time days', async () => {
    const fixture = await createInvocationFixture(295);
    const signal = new AbortController().signal;
    const journal = fixture.adapter.createInvocationJournal({
      ...fixture.authorities.options,
      localPromptAeadAuthority: {
        ...fixture.authorities.options.localPromptAeadAuthority,
        rewrap() {
          throw new Error('AUTHENTICATED_PROMPT_MISMATCH');
        },
      },
    });
    await bindCloudCommittedReady(journal, fixture, signal);
    await expect(
      journal.prepare({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        command: fixture.prepareReference,
        signal,
      }),
    ).rejects.toMatchObject({ code: 'PROMPT_AEAD_INVALID' });
    expect(queryCount(fixture.filename, 'local_invocations')).toBe(0);
    expect(queryCount(fixture.filename, 'local_consumed_commands')).toBe(2);

    fixture.authorities.cloudNow.value += 8 * 24 * 60 * 60 * 1_000;
    await expect(
      journal.pruneCommittedRetention({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        signal,
      }),
    ).resolves.toBe(0);
    expect(queryCount(fixture.filename, 'local_consumed_commands')).toBe(1);
    fixture.adapter.close();
  });

  it('fails closed on prepare conflict and revalidates persisted result AEAD at journal startup', async () => {
    const fixture = await createInvocationFixture(300);
    const signal = new AbortController().signal;
    const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    await bindCloudCommittedReady(journal, fixture, signal);
    await journal.prepare({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.prepareReference,
      signal,
    });

    const conflictMessageId = uuid(300_880);
    const conflicting = await commitCommand(
      fixture.adapter,
      fixture.installationId,
      fixture.state,
      {
        ...fixture.prepareEnvelope,
        messageId: conflictMessageId,
        sequence: nextSequence(fixture.state),
        body: {
          ...fixture.prepareEnvelope.body,
          requestDigest: HMAC('9'),
          userMessageCiphertext: encryptSensitive('conflicting prompt', fixture.contentKey, {
            protocol: 'combo.creator-broker/1',
            schemaVersion: 1,
            envelopeType: 'invocation.prepare',
            messageId: conflictMessageId,
            conversationId: fixture.conversationId,
            invocationId: fixture.invocationId,
            workerSessionId: fixture.workerSessionId,
            role: 'USER',
            keyId: fixture.keyId,
          }),
        },
      },
    );
    await expect(
      journal.prepare({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        command: await commandReference(fixture.adapter, fixture.installationId, conflicting),
        signal,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(fixture.authorities.hostReceiptCalls.count).toBe(0);
    fixture.adapter.close();
    const promptReopened = new SqliteWorkerBrokerDurableTransport({ filename: fixture.filename });
    expect(() =>
      promptReopened.createInvocationJournal({
        ...fixture.authorities.options,
        localPromptAeadAuthority: {
          rewrap: fixture.authorities.options.localPromptAeadAuthority.rewrap,
          open() {
            throw new Error('PROMPT_KEY_REVOKED');
          },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'PROMPT_AEAD_INVALID' }));
    promptReopened.close();

    // Build a complete result in a second fixture, then prove the injected AEAD authority is an
    // independent startup gate even though SQLite row/watermark integrity itself is valid.
    const completed = await createCompletedFixture(301);
    completed.adapter.close();
    const reopened = new SqliteWorkerBrokerDurableTransport({ filename: completed.filename });
    completed.authorities.localResultKeys.set('worker-keychain-v2-301', randomBytes(32));
    expect(() => reopened.createInvocationJournal(completed.authorities.options)).not.toThrow();
    completed.authorities.localResultKeys.delete(completed.localResultKeyId);
    expect(() => reopened.createInvocationJournal(completed.authorities.options)).toThrowError(
      expect.objectContaining({ code: 'FINAL_AEAD_INVALID' }),
    );
    reopened.close();
  });

  it('accepts late durable evidence, preserves exact replay after revoke, and rejects changed replay', async () => {
    const fixture = await createInvocationFixture(350);
    const signal = new AbortController().signal;
    const deadlineMs = Date.parse(fixture.prepareEnvelope.body.deadlineAt);
    const journal = fixture.adapter.createInvocationJournal({
      ...fixture.authorities.options,
      hostDispatchPort: {
        async dispatchOnce() {
          fixture.authorities.cloudNow.value = deadlineMs + 1_000;
          return { token: 'host-receipt', runtimeTurnId: 'turn-late-evidence' };
        },
      },
    });
    await bindCloudCommittedReady(journal, fixture, signal);
    await journal.prepare({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.prepareReference,
      signal,
    });
    const start = await journal.start({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.startReference,
      signal,
    });
    if (start.action !== 'DISPATCH_ONCE') throw new Error('missing-permit');
    const started = await journal.dispatchOnce({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      permit: start.permit,
      signal,
    });
    expect(started.runtimeTurnId).toBe('turn-late-evidence');
    const resultCiphertext = encryptLocalResult(
      'late final',
      fixture.localResultKey,
      fixture.resultHmacKey,
      fixture.localResultKeyId,
      {
        schemaVersion: 1,
        installationId: fixture.installationId,
        invocationId: fixture.invocationId,
        conversationId: fixture.conversationId,
        agentVersionDigest: SHA('a'),
        role: 'ASSISTANT',
      },
    );
    const final = await journal.writeSucceeded({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      invocationId: fixture.invocationId,
      dispatchNonce: start.permit.dispatchNonce,
      sourceEventId: fixture.invocationId,
      resultCiphertext,
      signal,
    });
    const capability = fixture.prepareEnvelope.body.executionCapability;
    fixture.authorities.revokedCapabilityIds.add(capability.capabilityId);
    fixture.authorities.cloudNow.value = Date.parse(capability.expiresAt) + 1;

    await expect(
      journal.prepare({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        command: fixture.prepareReference,
        signal,
      }),
    ).resolves.toMatchObject({ factDigest: expect.any(String) });
    await expect(
      journal.start({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        command: fixture.startReference,
        signal,
      }),
    ).resolves.toMatchObject({ action: 'RETURN_IN_PROGRESS', state: 'FINAL_READY' });

    const replayConnectionId = uuid(350_980);
    const replayLease = {
      deploymentId: fixture.startEnvelope.lease.deploymentId,
      leaseId: uuid(350_981),
      workerSessionId: uuid(350_982),
      fence: String(BigInt(fixture.startEnvelope.lease.fence) + 1n),
    };
    const replaySentAt = new Date(fixture.authorities.cloudNow.value - 1_000).toISOString();
    const replayExpiresAt = new Date(fixture.authorities.cloudNow.value + 60_000).toISOString();
    const replayGrant = BrokerEnvelopeSchema.parse({
      protocol: 'combo.creator-broker/1',
      schemaVersion: 1,
      kind: 'command',
      type: 'lease.grant',
      messageId: uuid(350_983),
      correlationId: replayLease.deploymentId,
      connectionId: replayConnectionId,
      sequence: '0',
      sentAt: replaySentAt,
      expiresAt: replayExpiresAt,
      lease: replayLease,
      body: {
        leaseExpiresAt: replayExpiresAt,
        workerSessionId: replayLease.workerSessionId,
        generation: '2',
      },
    }) as Extract<BrokerEnvelope, { type: 'lease.grant' }>;
    const replayGrantDigest = canonicalSha256(replayGrant);
    const replayGrantDecision = consumeSequence(
      initialSequenceCursor(replayConnectionId),
      replayGrant,
      replayGrantDigest,
      Date.parse(replaySentAt),
    );
    if (replayGrantDecision.type !== 'ACCEPT') throw new Error('replay-grant');
    let replayState = await fixture.adapter.activateConnection({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      envelope: replayGrant,
      canonicalDigest: replayGrantDigest,
      inboundCursor: serializeSequenceCursor(replayGrantDecision.cursor),
      signal,
    });
    const replayStart = BrokerEnvelopeSchema.parse({
      ...fixture.startEnvelope,
      connectionId: replayConnectionId,
      sequence: nextSequence(replayState),
      sentAt: replaySentAt,
      expiresAt: replayExpiresAt,
      lease: replayLease,
    });
    expect(replayStart.messageId).toBe(fixture.startReference.messageId);
    replayState = await commitCommand(
      fixture.adapter,
      fixture.installationId,
      replayState,
      replayStart,
    );
    await expect(
      journal.start({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        command: await commandReference(
          fixture.adapter,
          fixture.installationId,
          replayState,
          'invocation.start',
        ),
        signal,
      }),
    ).resolves.toMatchObject({ action: 'RETURN_IN_PROGRESS', state: 'FINAL_READY' });
    await expect(
      journal.confirmHostDispatch({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        invocationId: fixture.invocationId,
        dispatchNonce: start.permit.dispatchNonce,
        sourceEventId: fixture.startReference.messageId,
        receipt: { token: 'host-receipt', runtimeTurnId: 'turn-late-evidence' },
        signal,
      }),
    ).resolves.toMatchObject({ factDigest: started.factDigest });
    await expect(
      journal.confirmHostDispatch({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        invocationId: fixture.invocationId,
        dispatchNonce: start.permit.dispatchNonce,
        sourceEventId: fixture.startReference.messageId,
        receipt: { token: 'host-receipt', runtimeTurnId: 'turn-changed' },
        signal,
      }),
    ).rejects.toMatchObject({ code: 'HOST_RECEIPT_INVALID' });
    await expect(
      journal.writeSucceeded({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        invocationId: fixture.invocationId,
        dispatchNonce: start.permit.dispatchNonce,
        sourceEventId: fixture.invocationId,
        resultCiphertext,
        signal,
      }),
    ).resolves.toEqual(final);
    const changedCiphertext = encryptLocalResult(
      'late final',
      fixture.localResultKey,
      fixture.resultHmacKey,
      fixture.localResultKeyId,
      resultCiphertext.aad,
    );
    expect(changedCiphertext.resultDigest).toBe(resultCiphertext.resultDigest);
    await expect(
      journal.writeSucceeded({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        invocationId: fixture.invocationId,
        dispatchNonce: start.permit.dispatchNonce,
        sourceEventId: fixture.invocationId,
        resultCiphertext: changedCiphertext,
        signal,
      }),
    ).rejects.toMatchObject({ code: 'FINAL_CONFLICT' });
    fixture.adapter.close();

    const revoked = await createCompletedFixture(351);
    revoked.authorities.revokedCapabilityIds.add(
      revoked.prepareEnvelope.body.executionCapability.capabilityId,
    );
    const revokedJournal = revoked.adapter.createInvocationJournal(revoked.authorities.options);
    const storedResult = JSON.parse(
      String(queryNullable(revoked.filename, 'local_invocations', 'result_ciphertext')),
    ) as LocalInvocationResultCiphertext;
    await expect(
      revokedJournal.writeSucceeded({
        installationId: revoked.installationId,
        ownerToken: OWNER,
        invocationId: revoked.invocationId,
        dispatchNonce: String(queryScalar(revoked.filename, 'dispatch_nonce')),
        sourceEventId: revoked.invocationId,
        resultCiphertext: storedResult,
        signal,
      }),
    ).resolves.toMatchObject({ sourceEventId: revoked.invocationId });
    revoked.adapter.close();
  });

  it('binds local result plaintext, AAD, and current capability before first terminal commit', async () => {
    const fixture = await createInvocationFixture(375);
    const signal = new AbortController().signal;
    const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    await bindCloudCommittedReady(journal, fixture, signal);
    await journal.prepare({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.prepareReference,
      signal,
    });
    const start = await journal.start({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.startReference,
      signal,
    });
    if (start.action !== 'DISPATCH_ONCE') throw new Error('missing-permit');
    await journal.dispatchOnce({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      permit: start.permit,
      signal,
    });
    const aad: LocalInvocationResultAad = {
      schemaVersion: 1,
      installationId: fixture.installationId,
      invocationId: fixture.invocationId,
      conversationId: fixture.conversationId,
      agentVersionDigest: SHA('a'),
      role: 'ASSISTANT',
    };
    const valid = encryptLocalResult(
      'bound result',
      fixture.localResultKey,
      fixture.resultHmacKey,
      fixture.localResultKeyId,
      aad,
    );
    const wrongVersion = encryptLocalResult(
      'bound result',
      fixture.localResultKey,
      fixture.resultHmacKey,
      fixture.localResultKeyId,
      { ...aad, agentVersionDigest: SHA('f') },
    );
    await expect(
      journal.writeSucceeded({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        invocationId: fixture.invocationId,
        dispatchNonce: start.permit.dispatchNonce,
        sourceEventId: fixture.invocationId,
        resultCiphertext: wrongVersion,
        signal,
      }),
    ).rejects.toMatchObject({ code: 'FINAL_AEAD_INVALID' });
    const otherPlaintext = encryptLocalResult(
      'different plaintext',
      fixture.localResultKey,
      fixture.resultHmacKey,
      fixture.localResultKeyId,
      aad,
    );
    await expect(
      journal.writeSucceeded({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        invocationId: fixture.invocationId,
        dispatchNonce: start.permit.dispatchNonce,
        sourceEventId: fixture.invocationId,
        resultCiphertext: { ...otherPlaintext, resultDigest: valid.resultDigest },
        signal,
      }),
    ).rejects.toMatchObject({ code: 'FINAL_AEAD_INVALID' });
    await expect(
      journal.writeSucceeded({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        invocationId: fixture.invocationId,
        dispatchNonce: start.permit.dispatchNonce,
        sourceEventId: fixture.invocationId,
        resultCiphertext: valid,
        resultDigest: valid.resultDigest,
        signal,
      } as Parameters<typeof journal.writeSucceeded>[0] & { resultDigest: string }),
    ).rejects.toMatchObject({ code: 'FINAL_CONFLICT' });
    fixture.authorities.revokedCapabilityIds.add(
      fixture.prepareEnvelope.body.executionCapability.capabilityId,
    );
    await expect(
      journal.writeSucceeded({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        invocationId: fixture.invocationId,
        dispatchNonce: start.permit.dispatchNonce,
        sourceEventId: fixture.invocationId,
        resultCiphertext: valid,
        signal,
      }),
    ).rejects.toMatchObject({ code: 'EXECUTION_CAPABILITY_INVALID' });
    fixture.authorities.revokedCapabilityIds.clear();
    await expect(
      journal.writeSucceeded({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        invocationId: fixture.invocationId,
        dispatchNonce: start.permit.dispatchNonce,
        sourceEventId: fixture.invocationId,
        resultCiphertext: valid,
        signal,
      }),
    ).resolves.toMatchObject({ sourceEventId: fixture.invocationId });
    fixture.adapter.close();
  });

  it('keeps original capability Lease/Fence in facts while a reconnect uses new transport authority', async () => {
    const fixture = await createInvocationFixture(400);
    const signal = new AbortController().signal;
    const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    await bindCloudCommittedReady(journal, fixture, signal);
    await journal.prepare({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.prepareReference,
      signal,
    });

    const replacementLease = {
      deploymentId: fixture.prepareEnvelope.lease.deploymentId,
      leaseId: uuid(400_950),
      workerSessionId: uuid(400_951),
      fence: String(BigInt(fixture.prepareEnvelope.lease.fence) + 1n),
    };
    const replacementConnectionId = uuid(400_952);
    const replacementGrant = BrokerEnvelopeSchema.parse({
      protocol: 'combo.creator-broker/1',
      schemaVersion: 1,
      kind: 'command',
      type: 'lease.grant',
      messageId: uuid(400_953),
      correlationId: replacementLease.deploymentId,
      connectionId: replacementConnectionId,
      sequence: '0',
      sentAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      lease: replacementLease,
      body: {
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        workerSessionId: replacementLease.workerSessionId,
        generation: '2',
      },
    }) as Extract<BrokerEnvelope, { type: 'lease.grant' }>;
    const grantDigest = canonicalSha256(replacementGrant);
    const grantDecision = consumeSequence(
      initialSequenceCursor(replacementConnectionId),
      replacementGrant,
      grantDigest,
      Date.parse(replacementGrant.sentAt),
    );
    if (grantDecision.type !== 'ACCEPT') throw new Error('replacement-grant');
    let replacementState = await fixture.adapter.activateConnection({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      envelope: replacementGrant,
      canonicalDigest: grantDigest,
      inboundCursor: serializeSequenceCursor(grantDecision.cursor),
      signal,
    });
    let replacementPrepare = BrokerEnvelopeSchema.parse({
      ...fixture.prepareEnvelope,
      connectionId: replacementConnectionId,
      sequence: nextSequence(replacementState),
      sentAt: replacementGrant.sentAt,
      expiresAt: replacementGrant.expiresAt,
      lease: replacementLease,
      body: {
        ...fixture.prepareEnvelope.body,
        userMessageCiphertext: encryptSensitive('secret prompt', fixture.contentKey, {
          protocol: 'combo.creator-broker/1',
          schemaVersion: 1,
          envelopeType: 'invocation.prepare',
          messageId: fixture.prepareEnvelope.messageId,
          conversationId: fixture.conversationId,
          invocationId: fixture.invocationId,
          workerSessionId: replacementLease.workerSessionId,
          role: 'USER',
          keyId: fixture.keyId,
        }),
      },
    }) as Extract<BrokerEnvelope, { type: 'invocation.prepare' }>;
    expect(replacementPrepare.messageId).toBe(fixture.prepareEnvelope.messageId);
    expect(canonicalSha256(replacementPrepare)).not.toBe(canonicalSha256(fixture.prepareEnvelope));
    const wrongPromptCiphertext = encryptSensitive(
      'different authenticated prompt',
      fixture.contentKey,
      {
        ...replacementPrepare.body.userMessageCiphertext.aad,
      },
    );
    const wrongPromptPrepare = BrokerEnvelopeSchema.parse({
      ...replacementPrepare,
      body: { ...replacementPrepare.body, userMessageCiphertext: wrongPromptCiphertext },
    });
    replacementState = await commitCommand(
      fixture.adapter,
      fixture.installationId,
      replacementState,
      wrongPromptPrepare,
    );
    await expect(
      journal.prepare({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        command: await commandReference(
          fixture.adapter,
          fixture.installationId,
          replacementState,
          'invocation.prepare',
        ),
        signal,
      }),
    ).rejects.toMatchObject({ code: 'PROMPT_AEAD_INVALID' });
    expect(
      rawJournalContainsAny(fixture.filename, [
        wrongPromptCiphertext.nonce,
        wrongPromptCiphertext.ciphertext,
        wrongPromptCiphertext.authTag,
      ]),
    ).toBe(false);
    replacementPrepare = BrokerEnvelopeSchema.parse({
      ...replacementPrepare,
      sequence: nextSequence(replacementState),
      body: {
        ...replacementPrepare.body,
        userMessageCiphertext: encryptSensitive('secret prompt', fixture.contentKey, {
          ...replacementPrepare.body.userMessageCiphertext.aad,
        }),
      },
    }) as Extract<BrokerEnvelope, { type: 'invocation.prepare' }>;
    replacementState = await commitCommand(
      fixture.adapter,
      fixture.installationId,
      replacementState,
      replacementPrepare,
    );
    const replacementPrepareReference = await commandReference(
      fixture.adapter,
      fixture.installationId,
      replacementState,
      'invocation.prepare',
    );
    const prepared = await journal.prepare({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: replacementPrepareReference,
      signal,
    });
    expect(prepared.sourceEventId).toBe(fixture.prepareEnvelope.messageId);
    const preparedFact = queryJson(
      fixture.filename,
      `SELECT fact_json AS value FROM local_invocation_events
       WHERE event_type = 'invocation.prepared'`,
    ) as { leaseId: string; fence: string; prepareCommandId: string };
    expect(preparedFact).toMatchObject({
      leaseId: fixture.prepareEnvelope.body.executionCapability.leaseId,
      fence: fixture.prepareEnvelope.body.executionCapability.fence,
      prepareCommandId: fixture.prepareEnvelope.messageId,
    });
    expect(preparedFact.leaseId).not.toBe(replacementLease.leaseId);
    const transportDatabase = new SqliteDatabase(fixture.filename, { readOnly: true });
    const prepareCopies = transportDatabase
      .prepare(
        `SELECT effect_state FROM transport_inbound_frames WHERE message_id = ?
         ORDER BY recorded_at_ms`,
      )
      .all(fixture.prepareEnvelope.messageId) as Array<{ effect_state: string }>;
    transportDatabase.close();
    expect(prepareCopies).toEqual([]);
    const sameCommandIdDifferentSemantic = BrokerEnvelopeSchema.parse({
      ...replacementPrepare,
      sequence: nextSequence(replacementState),
      body: { ...replacementPrepare.body, requestDigest: HMAC('e') },
    });
    await expect(
      commitCommand(
        fixture.adapter,
        fixture.installationId,
        replacementState,
        sameCommandIdDifferentSemantic,
      ),
    ).rejects.toMatchObject({ code: 'SEQUENCE_CONFLICT' });
    expect(fixture.authorities.hostReceiptCalls.count).toBe(0);
    const replacementStart = BrokerEnvelopeSchema.parse({
      protocol: 'combo.creator-broker/1',
      schemaVersion: 1,
      kind: 'command',
      type: 'invocation.start',
      messageId: fixture.startReference.messageId,
      correlationId: fixture.invocationId,
      connectionId: replacementConnectionId,
      sequence: nextSequence(replacementState),
      sentAt: replacementGrant.sentAt,
      expiresAt: replacementGrant.expiresAt,
      lease: replacementLease,
      body: {
        invocationId: fixture.invocationId,
        prepareCommandId: fixture.prepareEnvelope.messageId,
        executionCapabilityId: fixture.prepareEnvelope.body.executionCapability.capabilityId,
      },
    });
    replacementState = await commitCommand(
      fixture.adapter,
      fixture.installationId,
      replacementState,
      replacementStart,
    );
    const startReference = await commandReference(
      fixture.adapter,
      fixture.installationId,
      replacementState,
      'invocation.start',
    );
    const decision = await journal.start({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: startReference,
      signal,
    });
    expect(decision.action).toBe('DISPATCH_ONCE');
    if (decision.action !== 'DISPATCH_ONCE') throw new Error('replacement-permit');
    await journal.dispatchOnce({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      permit: decision.permit,
      signal,
    });
    const startedFact = queryJson(
      fixture.filename,
      `SELECT fact_json AS value FROM local_invocation_events
       WHERE event_type = 'invocation.started'`,
    ) as { leaseId: string; fence: string; startCommandId: string };
    expect(startedFact).toMatchObject({
      leaseId: fixture.prepareEnvelope.lease.leaseId,
      fence: fixture.prepareEnvelope.lease.fence,
      startCommandId: replacementStart.messageId,
    });
    expect(startedFact.leaseId).not.toBe(replacementLease.leaseId);
    fixture.adapter.close();
  });

  it('blocks same-installation cross-Deployment start before Host and terminally releases admission', async () => {
    const fixture = await createInvocationFixture(425);
    const signal = new AbortController().signal;
    const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    await bindCloudCommittedReady(journal, fixture, signal);
    await journal.prepare({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.prepareReference,
      signal,
    });
    const replacement = await persistReplacementStart(
      fixture,
      uuid(425_900),
      uuid(425_901),
      425_910,
    );
    await expect(
      journal.start({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        command: replacement.reference,
        signal,
      }),
    ).rejects.toMatchObject({ code: 'START_COMMAND_CONFLICT' });
    expect(fixture.authorities.hostDispatchCalls.count).toBe(0);
    expect(queryScalar(fixture.filename, 'state')).toBe('FAILED');
    expect(queryNullable(fixture.filename, 'local_invocations', 'prompt_ciphertext')).toBeNull();
    expect(
      queryCountWhere(
        fixture.filename,
        'local_invocations',
        "state IN ('PREPARED','STARTING','RUNNING','FINAL_READY')",
      ),
    ).toBe(0);
    const terminal = queryJson(
      fixture.filename,
      `SELECT fact_json AS value FROM local_invocation_events
       WHERE event_type = 'invocation.failed'`,
    ) as { errorCode: string };
    expect(terminal.errorCode).toBe('START_COMMAND_CONFLICT');
    await expect(
      journal.start({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        command: replacement.reference,
        signal,
      }),
    ).resolves.toMatchObject({ action: 'RETURN_IN_PROGRESS', state: 'FAILED' });
    assertLocalIntegrity(fixture.filename);
    fixture.adapter.close();
  });

  it('terminally converges permanent start expiry/revoke while stale transport remains retryable', async () => {
    for (const [index, mode] of ['DEADLINE', 'REVOKED'].entries()) {
      const fixture = await createInvocationFixture(430 + index);
      const signal = new AbortController().signal;
      const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
      await bindCloudCommittedReady(journal, fixture, signal);
      await journal.prepare({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        command: fixture.prepareReference,
        signal,
      });
      if (mode === 'DEADLINE') {
        fixture.authorities.cloudNow.value = Date.parse(fixture.prepareEnvelope.body.deadlineAt);
      } else {
        fixture.authorities.revokedCapabilityIds.add(
          fixture.prepareEnvelope.body.executionCapability.capabilityId,
        );
      }
      const expectedCode =
        mode === 'DEADLINE' ? 'INVOCATION_DEADLINE_EXPIRED' : 'EXECUTION_CAPABILITY_INVALID';
      await expect(
        journal.start({
          installationId: fixture.installationId,
          ownerToken: OWNER,
          command: fixture.startReference,
          signal,
        }),
      ).rejects.toMatchObject({ code: expectedCode });
      expect(fixture.authorities.hostDispatchCalls.count).toBe(0);
      expect(queryScalar(fixture.filename, 'state')).toBe('FAILED');
      expect(queryNullable(fixture.filename, 'local_invocations', 'prompt_ciphertext')).toBeNull();
      expect(
        queryCountWhere(
          fixture.filename,
          'local_invocations',
          "state IN ('PREPARED','STARTING','RUNNING','FINAL_READY')",
        ),
      ).toBe(0);
      expect(
        (
          queryJson(
            fixture.filename,
            `SELECT fact_json AS value FROM local_invocation_events
             WHERE event_type = 'invocation.failed'`,
          ) as { errorCode: string }
        ).errorCode,
      ).toBe(expectedCode);
      assertLocalIntegrity(fixture.filename);
      fixture.adapter.close();
    }

    const stale = await createInvocationFixture(435);
    const signal = new AbortController().signal;
    const journal = stale.adapter.createInvocationJournal(stale.authorities.options);
    await bindCloudCommittedReady(journal, stale, signal);
    await journal.prepare({
      installationId: stale.installationId,
      ownerToken: OWNER,
      command: stale.prepareReference,
      signal,
    });
    await stale.adapter.releaseConnection({
      installationId: stale.installationId,
      ownerToken: OWNER,
      connectionId: stale.state.connectionId,
      signal,
    });
    await expect(
      journal.start({
        installationId: stale.installationId,
        ownerToken: OWNER,
        command: stale.startReference,
        signal,
      }),
    ).rejects.toMatchObject({ code: 'STALE_LEASE' });
    expect(queryScalar(stale.filename, 'state')).toBe('PREPARED');
    expect(queryNullable(stale.filename, 'local_invocations', 'prompt_ciphertext')).not.toBeNull();
    expect(stale.authorities.hostDispatchCalls.count).toBe(0);
    stale.adapter.close();
  });
});

type InvocationFixture = Awaited<ReturnType<typeof createInvocationFixture>>;

async function appendCancelCommand(
  fixture: InvocationFixture,
  seed: number,
  reason:
    | 'CONSUMER_REQUEST'
    | 'DRAIN_DEADLINE'
    | 'SECURITY_REVOKE'
    | 'DEADLINE' = 'CONSUMER_REQUEST',
) {
  const envelope = BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'command',
    type: 'invocation.cancel',
    messageId: uuid(seed),
    correlationId: fixture.invocationId,
    connectionId: fixture.state.connectionId,
    sequence: nextSequence(fixture.state),
    sentAt: fixture.startEnvelope.sentAt,
    expiresAt: fixture.startEnvelope.expiresAt,
    lease: fixture.startEnvelope.lease,
    body: { invocationId: fixture.invocationId, reason },
  }) as Extract<BrokerEnvelope, { type: 'invocation.cancel' }>;
  fixture.state = await commitCommand(
    fixture.adapter,
    fixture.installationId,
    fixture.state,
    envelope,
  );
  return {
    envelope,
    reference: await commandReference(
      fixture.adapter,
      fixture.installationId,
      fixture.state,
      'invocation.cancel',
    ),
  };
}

async function createInvocationFixture(
  seed: number,
  transportOptions: Omit<SqliteWorkerTransportOptions, 'filename' | 'newJournalAuthorization'> = {},
  fixtureOptions: Readonly<{ readyOnly?: boolean }> = {},
) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'combo-invocation-sqlite-')));
  temporaryDirectories.add(directory);
  const filename = join(directory, 'journal-v1.sqlite');
  const nowMs = Date.now();
  const installationId = uuid(seed * 100 + 1);
  const deploymentId = uuid(seed * 100 + 2);
  const connectionId = uuid(seed * 100 + 3);
  const leaseId = uuid(seed * 100 + 4);
  const workerSessionId = uuid(seed * 100 + 5);
  const conversationId = uuid(seed * 100 + 6);
  const invocationId = uuid(seed * 100 + 7);
  const agentVersionId = uuid(seed * 100 + 8);
  const keyId = `worker-session-${seed}`;
  const contentKey = randomBytes(32);
  const localResultKey = randomBytes(32);
  const resultHmacKey = randomBytes(32);
  const requestDigest = requestDomainDigest(Buffer.from('secret prompt', 'utf8'), resultHmacKey);
  const localResultKeyId = `worker-keychain-v1-${seed}`;
  const lease = { deploymentId, leaseId, workerSessionId, fence: String(seed + 1) };
  const sentAt = new Date(nowMs - 1_000).toISOString();
  const expiresAt = new Date(nowMs + 60_000).toISOString();
  const adapter = new SqliteWorkerBrokerDurableTransport({
    filename,
    newJournalAuthorization: authorization(installationId),
    ...transportOptions,
  });
  const signal = new AbortController().signal;
  await adapter.acquireInstallation({ installationId, ownerToken: OWNER, signal });
  const grant = BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'command',
    type: 'lease.grant',
    messageId: uuid(seed * 100 + 9),
    correlationId: deploymentId,
    connectionId,
    sequence: '0',
    sentAt,
    expiresAt,
    lease,
    body: { leaseExpiresAt: expiresAt, workerSessionId, generation: '1' },
  }) as Extract<BrokerEnvelope, { type: 'lease.grant' }>;
  const grantDigest = canonicalSha256(grant);
  const grantDecision = consumeSequence(
    initialSequenceCursor(connectionId),
    grant,
    grantDigest,
    Date.parse(sentAt),
  );
  if (grantDecision.type !== 'ACCEPT') throw new Error('invalid-grant');
  let state = await adapter.activateConnection({
    installationId,
    ownerToken: OWNER,
    envelope: grant,
    canonicalDigest: grantDigest,
    inboundCursor: serializeSequenceCursor(grantDecision.cursor),
    signal,
  });
  const openEnvelope = BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'command',
    type: 'conversation.open',
    messageId: uuid(seed * 100 + 10),
    correlationId: conversationId,
    connectionId,
    sequence: nextSequence(state),
    sentAt,
    expiresAt,
    lease,
    body: {
      conversationId,
      agentVersionId,
      agentVersionDigest: SHA('a'),
      snapshotDigest: SHA('b'),
      visibleTranscriptDigest: HMAC('c'),
      openAuthority: {
        deploymentId,
        installationId,
        workerSessionId,
        leaseId,
        fence: lease.fence,
      },
    },
  }) as Extract<BrokerEnvelope, { type: 'conversation.open' }>;
  state = await commitCommand(adapter, installationId, state, openEnvelope);
  const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const capability = signedCapability(
    {
      protocol: 'combo.execution-capability/1',
      schemaVersion: 1,
      capabilityId: uuid(seed * 100 + 11),
      invocationId,
      conversationId,
      deploymentId,
      agentVersionId,
      agentVersionDigest: SHA('a'),
      workerInstallationId: installationId,
      leaseId,
      fence: lease.fence,
      providerRequestId: uuid(seed * 100 + 12),
      requestDigest,
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      budget: { maxInputTokens: 4096, maxOutputTokens: 1024, maxCostMicros: 1_000_000 },
      notBefore: new Date(nowMs - 2_000).toISOString(),
      expiresAt: new Date(nowMs + 55_000).toISOString(),
      nonce: Buffer.from(`capability-nonce-${seed}`, 'utf8').toString('base64url'),
      signatureAlgorithm: 'ES256',
      signatureEncoding: 'ieee-p1363',
      signature: 'A'.repeat(86),
    },
    keyPair.privateKey,
  );
  const prepareMessageId = uuid(seed * 100 + 13);
  const userCiphertext = encryptSensitive('secret prompt', contentKey, {
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    envelopeType: 'invocation.prepare',
    messageId: prepareMessageId,
    conversationId,
    invocationId,
    workerSessionId,
    role: 'USER',
    keyId,
  });
  const prepareEnvelope = BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'command',
    type: 'invocation.prepare',
    messageId: prepareMessageId,
    correlationId: invocationId,
    connectionId,
    sequence: nextSequence(state),
    sentAt,
    expiresAt,
    lease,
    body: {
      invocationId,
      conversationId,
      clientMessageId: clientUuid(seed * 100 + 14),
      requestDigest,
      userMessageCiphertext: userCiphertext,
      agentVersionId,
      agentVersionDigest: SHA('a'),
      snapshotDigest: SHA('b'),
      deadlineAt: new Date(nowMs + 50_000).toISOString(),
      executionCapability: capability,
    },
  }) as Extract<BrokerEnvelope, { type: 'invocation.prepare' }>;
  if (!fixtureOptions.readyOnly) {
    state = await commitCommand(adapter, installationId, state, prepareEnvelope);
  }
  const startEnvelope = BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'command',
    type: 'invocation.start',
    messageId: uuid(seed * 100 + 15),
    correlationId: invocationId,
    connectionId,
    sequence: nextSequence(state),
    sentAt,
    expiresAt,
    lease,
    body: {
      invocationId,
      prepareCommandId: prepareMessageId,
      executionCapabilityId: capability.capabilityId,
    },
  });
  if (!fixtureOptions.readyOnly) {
    state = await commitCommand(adapter, installationId, state, startEnvelope);
  }
  const authorities = createAuthorities(
    keyPair.publicKey,
    contentKey,
    new Map([[localResultKeyId, localResultKey]]),
    resultHmacKey,
  );
  return {
    filename,
    adapter,
    state,
    installationId,
    conversationId,
    invocationId,
    workerSessionId,
    keyId,
    contentKey,
    localResultKey,
    localResultKeyId,
    resultHmacKey,
    openEnvelope,
    prepareEnvelope,
    startEnvelope,
    openReference: await commandReference(adapter, installationId, state, 'conversation.open'),
    prepareReference: fixtureOptions.readyOnly
      ? commandReferenceFromEnvelope(prepareEnvelope)
      : await commandReference(adapter, installationId, state, 'invocation.prepare'),
    startReference: fixtureOptions.readyOnly
      ? commandReferenceFromEnvelope(startEnvelope)
      : await commandReference(adapter, installationId, state, 'invocation.start'),
    authorities,
  };
}

async function createCompletedFixture(
  seed: number,
  transportOptions: Omit<SqliteWorkerTransportOptions, 'filename' | 'newJournalAuthorization'> = {},
): Promise<InvocationFixture> {
  const fixture = await createInvocationFixture(seed, transportOptions);
  const signal = new AbortController().signal;
  const journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
  await bindCloudCommittedReady(journal, fixture, signal);
  await journal.prepare({
    installationId: fixture.installationId,
    ownerToken: OWNER,
    command: fixture.prepareReference,
    signal,
  });
  const start = await journal.start({
    installationId: fixture.installationId,
    ownerToken: OWNER,
    command: fixture.startReference,
    signal,
  });
  if (start.action !== 'DISPATCH_ONCE') throw new Error('missing-permit');
  await journal.dispatchOnce({
    installationId: fixture.installationId,
    ownerToken: OWNER,
    permit: start.permit,
    signal,
  });
  const sourceEventId = fixture.invocationId;
  await journal.writeSucceeded({
    installationId: fixture.installationId,
    ownerToken: OWNER,
    invocationId: fixture.invocationId,
    dispatchNonce: start.permit.dispatchNonce,
    sourceEventId,
    resultCiphertext: encryptLocalResult(
      'result',
      fixture.localResultKey,
      fixture.resultHmacKey,
      fixture.localResultKeyId,
      {
        schemaVersion: 1,
        installationId: fixture.installationId,
        invocationId: fixture.invocationId,
        conversationId: fixture.conversationId,
        agentVersionDigest: SHA('a'),
        role: 'ASSISTANT',
      },
    ),
    signal,
  });
  return fixture;
}

async function driveInvocationToRunning(
  journal: SqliteWorkerInvocationJournal,
  fixture: InvocationFixture,
  signal: AbortSignal,
): Promise<Readonly<{ dispatchNonce: string }>> {
  await bindCloudCommittedReady(journal, fixture, signal);
  await journal.prepare({
    installationId: fixture.installationId,
    ownerToken: OWNER,
    command: fixture.prepareReference,
    signal,
  });
  const start = await journal.start({
    installationId: fixture.installationId,
    ownerToken: OWNER,
    command: fixture.startReference,
    signal,
  });
  if (start.action !== 'DISPATCH_ONCE') throw new Error('missing-permit');
  await journal.dispatchOnce({
    installationId: fixture.installationId,
    ownerToken: OWNER,
    permit: start.permit,
    signal,
  });
  return Object.freeze({ dispatchNonce: start.permit.dispatchNonce });
}

function pressurePrepareEnvelope(fixture: InvocationFixture, seed: number): BrokerEnvelope {
  const messageId = uuid(seed);
  const invocationId = uuid(seed + 1);
  const plaintext = Buffer.from(
    `pressure-${seed}-`.padEnd(BROKER_MAX_SENSITIVE_CIPHERTEXT_BYTES - 256, 'p'),
    'utf8',
  );
  const requestDigest = requestDomainDigest(plaintext, fixture.resultHmacKey);
  const brokerAad: BrokerSensitiveMessage['aad'] = {
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    envelopeType: 'invocation.prepare',
    messageId,
    conversationId: fixture.conversationId,
    invocationId,
    workerSessionId: fixture.workerSessionId,
    role: 'USER',
    keyId: fixture.keyId,
  };
  const originalCapability = fixture.prepareEnvelope.body.executionCapability;
  const capability = ExecutionCapabilitySchema.parse({
    ...originalCapability,
    capabilityId: uuid(seed + 2),
    invocationId,
    providerRequestId: uuid(seed + 3),
    requestDigest,
    nonce: Buffer.from(`pressure-capability-${seed}`, 'utf8').toString('base64url'),
  });
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'command',
    type: 'invocation.prepare',
    messageId,
    correlationId: invocationId,
    connectionId: fixture.state.connectionId,
    sequence: nextSequence(fixture.state),
    sentAt: fixture.prepareEnvelope.sentAt,
    expiresAt: fixture.prepareEnvelope.expiresAt,
    lease: fixture.prepareEnvelope.lease,
    body: {
      invocationId,
      conversationId: fixture.conversationId,
      clientMessageId: clientUuid(seed + 4),
      requestDigest,
      userMessageCiphertext: encryptSensitive(
        plaintext.toString('utf8'),
        fixture.contentKey,
        brokerAad,
      ),
      agentVersionId: fixture.prepareEnvelope.body.agentVersionId,
      agentVersionDigest: fixture.prepareEnvelope.body.agentVersionDigest,
      snapshotDigest: fixture.prepareEnvelope.body.snapshotDigest,
      deadlineAt: fixture.prepareEnvelope.body.deadlineAt,
      executionCapability: capability,
    },
  });
}

function createAuthorities(
  publicKey: KeyObject,
  brokerContentKey: Buffer,
  localResultKeys: Map<string, Buffer>,
  resultHmacKey: Buffer,
) {
  const hostDispatchCalls = { count: 0, prompts: [] as string[] };
  const hostReceiptCalls = { count: 0 };
  const hostInterruptCalls = { count: 0 };
  const hostInterruptReceiptCalls = { count: 0 };
  const cloudAckCalls = { count: 0 };
  const revokedCapabilityIds = new Set<string>();
  const cloudNow = { value: Date.now() };
  const capabilityAuthority: WorkerInvocationCapabilityAuthorityPort = {
    verify(input, expected, now) {
      return verifyCapability(input, expected, now, publicKey, revokedCapabilityIds);
    },
    verifyPreviouslyCommitted(input, expected, digest, committedAt) {
      const verified = verifyCapability(input, expected, committedAt, publicKey, new Set<string>());
      if (verified.capabilityDigest !== digest) throw new Error('digest-conflict');
      return verified;
    },
  };
  const readyConversationAuthority: ReadyConversationAuthorityPort = {
    verify(input) {
      if ((input as { token?: string }).token !== 'sandbox-ready') throw new Error('not-ready');
      return {
        sandboxInstanceId: uuid(900_001),
        runtimeThreadId: 'thread-ready-001',
        evidenceDigest: `sha256:${SHA('7')}`,
        readyAt: new Date(),
      };
    },
  };
  const hostDispatchPort: TrustedHostDispatchPort = {
    async dispatchOnce(input) {
      hostDispatchCalls.count += 1;
      hostDispatchCalls.prompts.push(Buffer.from(input.userMessage).toString('utf8'));
      return { token: 'host-receipt', runtimeTurnId: `turn-host-${hostDispatchCalls.count}` };
    },
  };
  const hostDispatchReceiptAuthority: HostDispatchReceiptAuthorityPort = {
    verify(input) {
      const receipt = input as { token?: string; runtimeTurnId?: string };
      if (receipt.token !== 'host-receipt' || receipt.runtimeTurnId === undefined)
        throw new Error('bad-receipt');
      hostReceiptCalls.count += 1;
      return {
        runtimeTurnId: receipt.runtimeTurnId,
        dispatchReceiptDigest: `sha256:${SHA('8')}`,
        sandboxAttestationDigest: `sha256:${SHA('9')}`,
      };
    },
  };
  const hostInterruptPort = {
    async interruptOnce({ permit }: { permit: unknown }) {
      hostInterruptCalls.count += 1;
      return { token: 'host-interrupt-terminal', permit, raw: 'HOST-RAW-INTERRUPT-CANARY' };
    },
  };
  const hostInterruptReceiptAuthority = {
    verify(input: unknown, expected: HostInterruptExpectedBinding) {
      const receipt = input as { token?: string; permit?: unknown };
      if (
        receipt.token !== 'host-interrupt-terminal' ||
        canonicalizeJson(receipt.permit) !==
          canonicalizeJson({
            invocationId: expected.invocationId,
            conversationId: expected.conversationId,
            cancelCommandId: expected.cancelCommandId,
            cancelReason: expected.cancelReason,
            interruptNonce: expected.interruptNonce,
            startCommandId: expected.startCommandId,
            dispatchNonce: expected.dispatchNonce,
            runtimeThreadId: expected.runtimeThreadId,
            runtimeTurnId: expected.runtimeTurnId,
            dispatchReceiptDigest: expected.dispatchReceiptDigest,
            sandboxInstanceId: expected.sandboxInstanceId,
            sandboxAttestationDigest: expected.sandboxAttestationDigest,
          })
      ) {
        throw new Error('bad-interrupt-receipt');
      }
      hostInterruptReceiptCalls.count += 1;
      return { hostTerminalDigest: `sha256:${SHA('6')}` };
    },
  };
  const localPromptAeadAuthority: LocalPromptAeadAuthorityPort = {
    rewrap({ brokerCiphertext, brokerAad, localAad, expectedRequestDigest }) {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        brokerContentKey,
        Buffer.from(brokerCiphertext.nonce, 'base64url'),
      );
      decipher.setAAD(brokerSensitiveMessageAadBytes(brokerAad));
      decipher.setAuthTag(Buffer.from(brokerCiphertext.authTag, 'base64url'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(brokerCiphertext.ciphertext, 'base64url')),
        decipher.final(),
      ]);
      const requestDigest = requestDomainDigest(plaintext, resultHmacKey);
      if (requestDigest !== expectedRequestDigest) throw new Error('request-digest-mismatch');
      const local = localResultKeys.entries().next().value as [string, Buffer] | undefined;
      if (local === undefined) throw new Error('missing-local-key');
      return {
        ciphertext: encryptLocalPrompt(plaintext, local[1], resultHmacKey, local[0], localAad),
        requestDigest,
      };
    },
    open({ ciphertext, expectedAad, expectedRequestDigest }) {
      const key = localResultKeys.get(ciphertext.keyId);
      if (key === undefined) throw new Error('unknown-local-key');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(ciphertext.nonce, 'base64url'),
      );
      decipher.setAAD(localInvocationPromptAadBytes(expectedAad));
      decipher.setAuthTag(Buffer.from(ciphertext.authTag, 'base64url'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertext.ciphertext, 'base64url')),
        decipher.final(),
      ]);
      const requestDigest = requestDomainDigest(plaintext, resultHmacKey);
      if (requestDigest !== expectedRequestDigest) throw new Error('request-digest-mismatch');
      return { plaintext, requestDigest };
    },
  };
  const localResultAeadAuthority: LocalResultAeadAuthorityPort = {
    verify(ciphertext, expectedAad) {
      const key = localResultKeys.get(ciphertext.keyId);
      if (key === undefined) throw new Error('unknown-local-key');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(ciphertext.nonce, 'base64url'),
      );
      decipher.setAAD(localInvocationResultAadBytes(expectedAad));
      decipher.setAuthTag(Buffer.from(ciphertext.authTag, 'base64url'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(ciphertext.ciphertext, 'base64url')),
        decipher.final(),
      ]);
      return { resultDigest: resultDomainDigest(plaintext, resultHmacKey) };
    },
  };
  const brokerResultReencryptAuthority: BrokerResultReencryptAuthorityPort = {
    reencrypt({ localCiphertext, localAad, brokerAad }) {
      const key = localResultKeys.get(localCiphertext.keyId);
      if (key === undefined) throw new Error('unknown-local-key');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(localCiphertext.nonce, 'base64url'),
      );
      decipher.setAAD(localInvocationResultAadBytes(localAad));
      decipher.setAuthTag(Buffer.from(localCiphertext.authTag, 'base64url'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(localCiphertext.ciphertext, 'base64url')),
        decipher.final(),
      ]);
      return {
        ciphertext: encryptSensitive(plaintext.toString('utf8'), brokerContentKey, brokerAad),
        resultDigest: resultDomainDigest(plaintext, resultHmacKey),
      };
    },
  };
  const cloudAckAuthority: CloudInvocationAckAuthorityPort = {
    verify(input) {
      if ((input as { token?: string }).token !== 'cloud-committed') throw new Error('bad-ack');
      cloudAckCalls.count += 1;
      return { evidenceDigest: `sha256:${SHA('6')}` };
    },
  };
  return {
    localResultKeys,
    hostDispatchCalls,
    hostReceiptCalls,
    hostInterruptCalls,
    hostInterruptReceiptCalls,
    cloudAckCalls,
    revokedCapabilityIds,
    cloudNow,
    options: {
      capabilityAuthority,
      readyConversationAuthority,
      hostDispatchPort,
      hostDispatchReceiptAuthority,
      hostInterruptPort,
      hostInterruptReceiptAuthority,
      localPromptAeadAuthority,
      localResultAeadAuthority,
      brokerResultReencryptAuthority,
      cloudAckAuthority,
      cloudClock: { now: () => new Date(cloudNow.value) },
    },
  };
}

function verifyCapability(
  input: unknown,
  expected: ExpectedExecutionCapabilityBinding,
  now: Date,
  publicKey: KeyObject,
  revoked: ReadonlySet<string>,
) {
  const result = validateExecutionCapabilityBinding(input, expected, now, revoked, publicKey);
  if (!result.ok) throw new Error(result.reasons.join(','));
  return result;
}

function signedCapability(input: ExecutionCapability, privateKey: KeyObject): ExecutionCapability {
  const signature = sign('sha256', executionCapabilitySigningBytes(input), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return ExecutionCapabilitySchema.parse({ ...input, signature });
}

function encryptSensitive(
  plaintext: string,
  key: Buffer,
  aad: BrokerSensitiveMessage['aad'],
): BrokerSensitiveMessage {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(brokerSensitiveMessageAadBytes(aad));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const nonceText = nonce.toString('base64url');
  const ciphertextText = ciphertext.toString('base64url');
  const authTagText = authTag.toString('base64url');
  return {
    algorithm: 'aes-256-gcm/v1',
    keyScope: 'worker-session',
    keyId: aad.keyId,
    nonce: nonceText,
    ciphertext: ciphertextText,
    authTag: authTagText,
    cipherDigest: brokerSensitiveMessageCipherDigest(nonceText, ciphertextText, authTagText),
    aad,
    aadDigest: brokerSensitiveMessageAadDigest(aad),
    aadVersion: 1,
  };
}

function resultDomainDigest(plaintext: Buffer, key: Buffer): string {
  return `hmac-sha256:${createHmac('sha256', key)
    .update('combo:vnext:result:v1\0', 'utf8')
    .update(plaintext)
    .digest('hex')}`;
}

function requestDomainDigest(plaintext: Buffer, key: Buffer): string {
  return `hmac-sha256:${createHmac('sha256', key)
    .update('combo:vnext:request:v1\0', 'utf8')
    .update(plaintext)
    .digest('hex')}`;
}

function encryptLocalPrompt(
  plaintext: Uint8Array,
  key: Buffer,
  requestHmacKey: Buffer,
  keyId: string,
  aad: LocalInvocationPromptAad,
): LocalInvocationPromptCiphertext {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(localInvocationPromptAadBytes(aad));
  const plaintextBytes = Buffer.from(plaintext);
  const ciphertext = Buffer.concat([cipher.update(plaintextBytes), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const nonceText = nonce.toString('base64url');
  const ciphertextText = ciphertext.toString('base64url');
  const authTagText = authTag.toString('base64url');
  return {
    algorithm: 'aes-256-gcm/v1',
    keyScope: 'worker-keychain',
    keyId,
    nonce: nonceText,
    ciphertext: ciphertextText,
    authTag: authTagText,
    cipherDigest: localInvocationPromptCipherDigest(nonceText, ciphertextText, authTagText),
    requestDigest: requestDomainDigest(plaintextBytes, requestHmacKey),
    aad,
    aadDigest: localInvocationPromptAadDigest(aad),
    aadVersion: 1,
  };
}

function encryptLocalResult(
  plaintext: string,
  key: Buffer,
  resultHmacKey: Buffer,
  keyId: string,
  aad: LocalInvocationResultAad,
): LocalInvocationResultCiphertext {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(localInvocationResultAadBytes(aad));
  const plaintextBytes = Buffer.from(plaintext, 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintextBytes), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const nonceText = nonce.toString('base64url');
  const ciphertextText = ciphertext.toString('base64url');
  const authTagText = authTag.toString('base64url');
  return {
    algorithm: 'aes-256-gcm/v1',
    keyScope: 'worker-keychain',
    keyId,
    nonce: nonceText,
    ciphertext: ciphertextText,
    authTag: authTagText,
    cipherDigest: localInvocationResultCipherDigest(nonceText, ciphertextText, authTagText),
    resultDigest: resultDomainDigest(plaintextBytes, resultHmacKey),
    aad,
    aadDigest: localInvocationResultAadDigest(aad),
    aadVersion: 1,
  };
}

async function persistReplacementStart(
  fixture: InvocationFixture,
  deploymentId: string,
  connectionId: string,
  seed: number,
): Promise<
  Readonly<{ state: DurableBrokerConnection; reference: DurableInboundCommandCandidate }>
> {
  const signal = new AbortController().signal;
  const lease = {
    deploymentId,
    leaseId: uuid(seed + 1),
    workerSessionId: uuid(seed + 2),
    fence: String(seed),
  };
  const grant = BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'command',
    type: 'lease.grant',
    messageId: uuid(seed + 3),
    correlationId: deploymentId,
    connectionId,
    sequence: '0',
    sentAt: fixture.startEnvelope.sentAt,
    expiresAt: fixture.startEnvelope.expiresAt,
    lease,
    body: {
      leaseExpiresAt: fixture.startEnvelope.expiresAt,
      workerSessionId: lease.workerSessionId,
      generation: '2',
    },
  }) as Extract<BrokerEnvelope, { type: 'lease.grant' }>;
  const grantDigest = canonicalSha256(grant);
  const decision = consumeSequence(
    initialSequenceCursor(connectionId),
    grant,
    grantDigest,
    Date.parse(grant.sentAt),
  );
  if (decision.type !== 'ACCEPT') throw new Error('replacement-grant');
  let state = await fixture.adapter.activateConnection({
    installationId: fixture.installationId,
    ownerToken: OWNER,
    envelope: grant,
    canonicalDigest: grantDigest,
    inboundCursor: serializeSequenceCursor(decision.cursor),
    signal,
  });
  const start = BrokerEnvelopeSchema.parse({
    ...fixture.startEnvelope,
    connectionId,
    sequence: nextSequence(state),
    lease,
  }) as Extract<BrokerEnvelope, { type: 'invocation.start' }>;
  state = await commitCommand(fixture.adapter, fixture.installationId, state, start);
  return Object.freeze({
    state,
    reference: await commandReference(
      fixture.adapter,
      fixture.installationId,
      state,
      'invocation.start',
    ),
  });
}

async function activateReplacementLease(
  fixture: InvocationFixture,
  seed: number,
  deploymentId = fixture.state.lease.deploymentId,
  atMs = Date.now(),
  fenceIncrement = 1n,
): Promise<DurableBrokerConnection> {
  const connectionId = uuid(seed);
  const lease = {
    deploymentId,
    leaseId: uuid(seed + 1),
    workerSessionId: uuid(seed + 2),
    fence: String(BigInt(fixture.state.lease.fence) + fenceIncrement),
  };
  const sentAt = new Date(atMs).toISOString();
  const expiresAt = new Date(atMs + 60_000).toISOString();
  const grant = BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'command',
    type: 'lease.grant',
    messageId: uuid(seed + 3),
    correlationId: lease.deploymentId,
    connectionId,
    sequence: '0',
    sentAt,
    expiresAt,
    lease,
    body: { leaseExpiresAt: expiresAt, workerSessionId: lease.workerSessionId, generation: '2' },
  }) as Extract<BrokerEnvelope, { type: 'lease.grant' }>;
  const digest = canonicalSha256(grant);
  const decision = consumeSequence(initialSequenceCursor(connectionId), grant, digest, atMs);
  if (decision.type !== 'ACCEPT') throw new Error('replacement-grant');
  return fixture.adapter.activateConnection({
    installationId: fixture.installationId,
    ownerToken: OWNER,
    envelope: grant,
    canonicalDigest: digest,
    inboundCursor: serializeSequenceCursor(decision.cursor),
    signal: new AbortController().signal,
  });
}

function commandReferenceFromEnvelope(command: BrokerEnvelope) {
  if (command.kind !== 'command') throw new Error('not-command-reference');
  return Object.freeze({
    connectionId: command.connectionId,
    sequence: command.sequence,
    messageId: command.messageId,
    type: command.type,
    canonicalDigest: canonicalSha256(command),
    effectState: 'PERSISTED' as const,
  });
}

async function enqueueAndCommitCloudAck(
  adapter: SqliteWorkerBrokerDurableTransport,
  journal: SqliteWorkerInvocationJournal,
  fixture: InvocationFixture,
  fact: PendingInvocationFactReference,
  seed: number,
  decision: 'APPLIED' | 'IDEMPOTENT_REPLAY' = 'APPLIED',
): Promise<{
  state: DurableBrokerConnection;
  ack: OpaqueInvocationCloudAckReference;
  ackEnvelope: BrokerEnvelope;
}> {
  const signal = new AbortController().signal;
  const delivery = await journal.enqueuePendingFact({
    installationId: fixture.installationId,
    ownerToken: OWNER,
    reference: fact,
    connectionId: fixture.state.connectionId,
    deliveryMessageId: uuid(seed),
    ...(fact.eventType === 'invocation.succeeded' ? { brokerKeyId: fixture.keyId } : {}),
    signal,
  });
  const ackEnvelope = BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'ack',
    type: 'message.ack',
    messageId: uuid(seed + 1),
    correlationId: delivery.deliveryMessageId,
    connectionId: fixture.state.connectionId,
    sequence: nextSequence(fixture.state),
    sentAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    lease: fixture.state.lease,
    body: {
      acknowledgedMessageId: delivery.deliveryMessageId,
      level: 'CLOUD_COMMITTED',
      decision,
    },
  });
  const state = await commitCommand(adapter, fixture.installationId, fixture.state, ackEnvelope);
  const references = await journal.readPendingCloudAcks({
    installationId: fixture.installationId,
    ownerToken: OWNER,
    limit: 128,
    signal,
  });
  const ack = references.find(
    (candidate) => candidate.acknowledgedDeliveryMessageId === delivery.deliveryMessageId,
  );
  if (ack === undefined) throw new Error('missing-cloud-ack-reference');
  return { state, ack, ackEnvelope };
}

async function enqueueAndCommitReadyCloudAck(
  adapter: SqliteWorkerBrokerDurableTransport,
  journal: SqliteWorkerInvocationJournal,
  fixture: InvocationFixture,
  fact: PendingConversationReadyFactReference,
  decision: 'APPLIED' | 'IDEMPOTENT_REPLAY' | 'SECURITY_BLOCK',
  seed: number,
): Promise<DurableBrokerConnection> {
  const signal = new AbortController().signal;
  const delivery = await journal.enqueuePendingConversationReadyFact({
    installationId: fixture.installationId,
    ownerToken: OWNER,
    reference: fact,
    connectionId: fixture.state.connectionId,
    deliveryMessageId: uuid(seed),
    signal,
  });
  const ackEnvelope = readyCloudAckEnvelope(
    fixture,
    delivery.deliveryMessageId,
    decision,
    seed + 1,
  );
  return commitCommand(adapter, fixture.installationId, fixture.state, ackEnvelope);
}

async function bindCloudCommittedReady(
  journal: SqliteWorkerInvocationJournal,
  fixture: InvocationFixture,
  signal: AbortSignal,
): Promise<void> {
  await journal.bindReadyConversation({
    installationId: fixture.installationId,
    ownerToken: OWNER,
    command: fixture.openReference,
    evidence: { token: 'sandbox-ready' },
    signal,
  });
  const [pending] = await journal.readPendingConversationReadyFacts({
    installationId: fixture.installationId,
    ownerToken: OWNER,
    limit: 1,
    signal,
  });
  if (pending === undefined) throw new Error('missing-pending-ready-fact');
  fixture.state = await enqueueAndCommitReadyCloudAck(
    fixture.adapter,
    journal,
    fixture,
    pending,
    'APPLIED',
    9_990_000,
  );
}

function readyCloudAckEnvelope(
  fixture: InvocationFixture,
  deliveryMessageId: string,
  decision: 'APPLIED' | 'IDEMPOTENT_REPLAY' | 'SECURITY_BLOCK',
  seed: number,
): Extract<BrokerEnvelope, { kind: 'ack'; type: 'message.ack' }> {
  return BrokerEnvelopeSchema.parse({
    protocol: 'combo.creator-broker/1',
    schemaVersion: 1,
    kind: 'ack',
    type: 'message.ack',
    messageId: uuid(seed),
    correlationId: deliveryMessageId,
    connectionId: fixture.state.connectionId,
    sequence: nextSequence(fixture.state),
    sentAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    lease: fixture.state.lease,
    body: {
      acknowledgedMessageId: deliveryMessageId,
      level: 'CLOUD_COMMITTED',
      decision,
    },
  }) as Extract<BrokerEnvelope, { kind: 'ack'; type: 'message.ack' }>;
}

function redigestReadyWireWithMutation(
  filename: string,
  deliveryMessageId: string,
  bodyMutation: Readonly<Record<string, unknown>>,
): void {
  const database = new SqliteDatabase(filename);
  const row = database
    .prepare('SELECT envelope_json FROM transport_outbox WHERE message_id = ?')
    .get(deliveryMessageId) as { envelope_json: string };
  const original = BrokerEnvelopeSchema.parse(JSON.parse(row.envelope_json));
  if (original.kind !== 'event' || original.type !== 'conversation.ready') {
    database.close();
    throw new Error('not-ready-wire');
  }
  const mutatedBody = { ...original.body, ...bodyMutation } as Record<string, unknown>;
  delete mutatedBody.factDigest;
  const mutatedFact = WorkerConversationReadyFactSchema.parse(mutatedBody);
  const mutated = BrokerEnvelopeSchema.parse({
    ...original,
    body: { ...mutatedFact, factDigest: workerConversationReadyFactDigest(mutatedFact) },
  });
  database
    .prepare(
      'UPDATE transport_outbox SET envelope_json = ?, canonical_digest = ? WHERE message_id = ?',
    )
    .run(canonicalizeJson(mutated), canonicalSha256(mutated), deliveryMessageId);
  database.close();
}

function redigestReadyWireOuterMutation(
  filename: string,
  deliveryMessageId: string,
  mutation: Readonly<{ correlationId: string; deploymentId: string }>,
): void {
  const database = new SqliteDatabase(filename);
  const row = database
    .prepare('SELECT envelope_json FROM transport_outbox WHERE message_id = ?')
    .get(deliveryMessageId) as { envelope_json: string };
  const original = BrokerEnvelopeSchema.parse(JSON.parse(row.envelope_json));
  if (original.type !== 'conversation.ready') throw new Error('not-ready-wire');
  const mutated = {
    ...original,
    correlationId: mutation.correlationId,
    lease: { ...original.lease, deploymentId: mutation.deploymentId },
  };
  database
    .prepare(
      'UPDATE transport_outbox SET envelope_json = ?, canonical_digest = ? WHERE message_id = ?',
    )
    .run(canonicalizeJson(mutated), canonicalSha256(mutated), deliveryMessageId);
  database.close();
}

async function commitCommand(
  adapter: SqliteWorkerBrokerDurableTransport,
  installationId: string,
  state: DurableBrokerConnection,
  rawEnvelope: unknown,
): Promise<DurableBrokerConnection> {
  const envelope = BrokerEnvelopeSchema.parse(rawEnvelope);
  const digest = canonicalSha256(envelope);
  const decision = consumeSequence(
    restoreSequenceCursor(state.inboundCursor),
    envelope,
    digest,
    Date.parse(envelope.sentAt),
  );
  if (decision.type !== 'ACCEPT') throw new Error('invalid-command-sequence');
  return adapter.commitInbound({
    installationId,
    ownerToken: OWNER,
    connectionId: state.connectionId,
    expectedInboundCursor: state.inboundCursor,
    nextInboundCursor: serializeSequenceCursor(decision.cursor),
    envelope,
    canonicalDigest: digest,
    signal: new AbortController().signal,
  });
}

async function commandReference(
  adapter: SqliteWorkerBrokerDurableTransport,
  installationId: string,
  state: DurableBrokerConnection,
  type?: DurableInboundCommandCandidate['type'],
): Promise<DurableInboundCommandCandidate> {
  const rows = await adapter.readPendingCommands({
    installationId,
    ownerToken: OWNER,
    connectionId: state.connectionId,
    limit: 64,
    signal: new AbortController().signal,
  });
  const row = type === undefined ? rows.at(-1) : rows.find((candidate) => candidate.type === type);
  if (row === undefined) throw new Error(`missing-command:${type ?? 'last'}`);
  return row;
}

function nextSequence(state: DurableBrokerConnection): string {
  return restoreSequenceCursor(state.inboundCursor).nextExpected.toString(10);
}

function authorization(installationId: string): NewWorkerJournalAuthorization {
  return {
    installationId,
    journalGeneration: uuid(999_998),
    authorizationDigest: createHash('sha256').update(`journal:${installationId}`).digest('hex'),
  };
}

function cloneClosedJournal(filename: string): string {
  const checkpoint = new SqliteDatabase(filename);
  checkpoint.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  checkpoint.close();
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'combo-invocation-clone-')));
  temporaryDirectories.add(directory);
  const clone = join(directory, 'journal-v4.sqlite');
  for (const suffix of ['', '.watermark']) {
    const source = `${filename}${suffix}`;
    if (!existsSync(source)) continue;
    copyFileSync(source, `${clone}${suffix}`);
    chmodSync(`${clone}${suffix}`, 0o600);
  }
  return clone;
}

function rewriteAppendOnlyAuthorityRow(
  filename: string,
  table: 'local_invocation_outbox_receipts',
  column: 'ack_decision',
  value: 'APPLIED',
): void {
  const database = new SqliteDatabase(filename);
  database.exec('BEGIN IMMEDIATE');
  try {
    const row = database.prepare(`SELECT * FROM ${table} LIMIT 1`).get() as
      | Record<string, unknown>
      | undefined;
    if (row === undefined || typeof row.receipt_id !== 'number') {
      throw new Error('MISSING_APPEND_ONLY_AUTHORITY_ROW');
    }
    const triggers = database
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'trigger' AND tbl_name = ? ORDER BY name`,
      )
      .all(table) as Array<{ name: string; sql: string }>;
    for (const trigger of triggers) database.exec(`DROP TRIGGER "${trigger.name}"`);
    const payload: Record<string, unknown> = { ...row, [column]: value };
    delete payload.receipt_id;
    delete payload.row_digest;
    const rowDigest = sqliteInvocationRowDigest(table, payload);
    database
      .prepare(`UPDATE ${table} SET ${column} = ?, row_digest = ? WHERE receipt_id = ?`)
      .run(value, rowDigest, row.receipt_id);
    for (const trigger of triggers) database.exec(trigger.sql);
    refreshTestAuthorityDigest(database);
    database.exec('COMMIT');
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (error) {
    database.exec('ROLLBACK');
    database.close();
    throw error;
  }
  database.close();
}

function deleteAppendOnlyAuthorityRow(
  filename: string,
  table: 'local_invocation_outbox_receipts',
): void {
  const database = new SqliteDatabase(filename);
  database.exec('BEGIN IMMEDIATE');
  try {
    const triggers = database
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'trigger' AND tbl_name = ? ORDER BY name`,
      )
      .all(table) as Array<{ name: string; sql: string }>;
    for (const trigger of triggers) database.exec(`DROP TRIGGER "${trigger.name}"`);
    const removed = database.prepare(`DELETE FROM ${table}`).run();
    if (Number(removed.changes) !== 1) throw new Error('MISSING_APPEND_ONLY_AUTHORITY_ROW');
    for (const trigger of triggers) database.exec(trigger.sql);
    refreshTestAuthorityDigest(database);
    database.exec('COMMIT');
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (error) {
    database.exec('ROLLBACK');
    database.close();
    throw error;
  }
  database.close();
}

function refreshTestAuthorityDigest(database: InstanceType<typeof SqliteDatabase>): void {
  const installation = database
    .prepare(
      `SELECT installation_id, highest_owner_epoch FROM transport_installations
       ORDER BY installation_id`,
    )
    .all();
  const owners = database
    .prepare(
      `SELECT installation_id, owner_token_digest, owner_epoch, lease_expires_at_ms,
              acquired_at_ms, updated_at_ms
       FROM transport_installation_owners ORDER BY installation_id`,
    )
    .all();
  const fences = database
    .prepare(
      `SELECT installation_id, deployment_id, highest_fence
       FROM transport_deployment_fences ORDER BY installation_id, deployment_id`,
    )
    .all();
  const authorityDigest = createHash('sha256')
    .update('combo:vnext:worker-authority:v1\0', 'utf8')
    .update(
      canonicalizeJson({
        installation,
        owners,
        fences,
        local: workerInvocationAuthorityRows(database),
      }),
      'utf8',
    )
    .digest('hex');
  database
    .prepare('UPDATE transport_meta SET authority_digest = ? WHERE singleton = 1')
    .run(authorityDigest);
}

function assertLocallyConsistentWorkerJournal(filename: string): void {
  const database = new SqliteDatabase(filename, { readOnly: true });
  const schemaRows = database
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
       WHERE (name LIKE 'transport_%' OR name LIKE 'local_%') AND sql IS NOT NULL
       ORDER BY type, name`,
    )
    .all();
  const meta = database
    .prepare('SELECT schema_digest, authority_digest FROM transport_meta WHERE singleton = 1')
    .get() as { schema_digest: string; authority_digest: string };
  expect(createHash('sha256').update(canonicalizeJson(schemaRows)).digest('hex')).toBe(
    meta.schema_digest,
  );
  const installation = database
    .prepare(
      `SELECT installation_id, highest_owner_epoch FROM transport_installations
       ORDER BY installation_id`,
    )
    .all();
  const owners = database
    .prepare(
      `SELECT installation_id, owner_token_digest, owner_epoch, lease_expires_at_ms,
              acquired_at_ms, updated_at_ms
       FROM transport_installation_owners ORDER BY installation_id`,
    )
    .all();
  const fences = database
    .prepare(
      `SELECT installation_id, deployment_id, highest_fence
       FROM transport_deployment_fences ORDER BY installation_id, deployment_id`,
    )
    .all();
  expect(
    createHash('sha256')
      .update('combo:vnext:worker-authority:v1\0', 'utf8')
      .update(
        canonicalizeJson({
          installation,
          owners,
          fences,
          local: workerInvocationAuthorityRows(database),
        }),
        'utf8',
      )
      .digest('hex'),
  ).toBe(meta.authority_digest);
  expect(() => assertWorkerInvocationIntegrity(database)).not.toThrow();
  expect(() => assertWorkerConversationReadyIntegrity(database)).not.toThrow();
  database.close();
}

function queryCount(filename: string, table: string): number {
  const database = new SqliteDatabase(filename, { readOnly: true });
  const row = database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number };
  database.close();
  return row.count;
}

function queryCountWhere(filename: string, table: string, predicate: string): number {
  const database = new SqliteDatabase(filename, { readOnly: true });
  const row = database
    .prepare(`SELECT count(*) AS count FROM ${table} WHERE ${predicate}`)
    .get() as {
    count: number;
  };
  database.close();
  return row.count;
}

function queryPragmaNumber(filename: string, pragma: string): number {
  const database = new SqliteDatabase(filename, { readOnly: true });
  const row = database.prepare(`PRAGMA ${pragma}`).get() as Record<string, number>;
  database.close();
  const value = Object.values(row)[0];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`invalid-pragma:${pragma}`);
  }
  return value;
}

function queryForeignKeyTargets(filename: string, table: string): string[] {
  const database = new SqliteDatabase(filename, { readOnly: true });
  const rows = database.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
    table: string;
  }>;
  database.close();
  return rows.map((row) => row.table).sort();
}

function queryConnectionSnapshot(filename: string, connectionId: string) {
  const database = new SqliteDatabase(filename, { readOnly: true });
  const row = database
    .prepare(
      `SELECT status, owner_epoch, inbound_cursor, connection_digest
       FROM transport_connections WHERE connection_id = ?`,
    )
    .get(connectionId);
  database.close();
  return row;
}

function queryDurableStateSnapshot(filename: string): Record<string, readonly unknown[]> {
  const database = new SqliteDatabase(filename, { readOnly: true });
  const tables = database
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  const snapshot = Object.fromEntries(
    tables.map(({ name }) => [
      name,
      database.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
    ]),
  );
  database.close();
  return snapshot;
}

function queryReadyBusinessStateSnapshot(filename: string): Record<string, readonly unknown[]> {
  const database = new SqliteDatabase(filename, { readOnly: true });
  const tables = [
    'local_conversations',
    'local_consumed_commands',
    'local_conversation_ready_facts',
    'local_conversation_ready_outbox',
    'local_conversation_ready_deliveries',
    'local_conversation_ready_outbox_receipts',
    'local_conversation_ready_terminal_tombstones',
  ] as const;
  const snapshot = Object.fromEntries(
    tables.map((table) => [
      table,
      database.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all(),
    ]),
  );
  database.close();
  return snapshot;
}

function queryScalar(filename: string, column: string): string | number {
  const database = new SqliteDatabase(filename, { readOnly: true });
  const row = database
    .prepare(`SELECT ${column} AS value FROM local_invocations LIMIT 1`)
    .get() as { value: string | number };
  database.close();
  return row.value;
}

function queryScalarFrom(filename: string, table: string, column: string): string | number {
  const database = new SqliteDatabase(filename, { readOnly: true });
  const row = database.prepare(`SELECT ${column} AS value FROM ${table} LIMIT 1`).get() as {
    value: string | number;
  };
  database.close();
  return row.value;
}

function queryScalarWhere(
  filename: string,
  table: string,
  column: string,
  predicate: string,
): string | number {
  const database = new SqliteDatabase(filename, { readOnly: true });
  const row = database
    .prepare(`SELECT ${column} AS value FROM ${table} WHERE ${predicate}`)
    .get() as {
    value: string | number;
  };
  database.close();
  return row.value;
}

function queryNullable(filename: string, table: string, column: string): string | number | null {
  const database = new SqliteDatabase(filename, { readOnly: true });
  const row = database.prepare(`SELECT ${column} AS value FROM ${table} LIMIT 1`).get() as {
    value: string | number | null;
  };
  database.close();
  return row.value;
}

function rawJournalContainsAny(filename: string, needles: readonly string[]): boolean {
  return ['', '-wal', '-shm'].some((suffix) => {
    const path = `${filename}${suffix}`;
    if (!existsSync(path)) return false;
    const bytes = readFileSync(path);
    return needles.some((needle) => bytes.includes(Buffer.from(needle, 'utf8')));
  });
}

function queryJson(filename: string, sql: string): unknown {
  const database = new SqliteDatabase(filename, { readOnly: true });
  const row = database.prepare(sql).get() as { value: string };
  database.close();
  return JSON.parse(row.value);
}

function assertLocalIntegrity(filename: string): void {
  const database = new SqliteDatabase(filename, { readOnly: true });
  try {
    assertWorkerInvocationIntegrity(database);
  } finally {
    database.close();
  }
}

function uuid(seed: number): string {
  return `00000000-0000-7000-8000-${String(seed).padStart(12, '0')}`;
}

function clientUuid(seed: number): string {
  return `00000000-0000-4000-8000-${String(seed).padStart(12, '0')}`;
}
