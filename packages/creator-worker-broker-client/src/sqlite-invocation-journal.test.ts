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
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

import {
  BrokerEnvelopeSchema,
  ExecutionCapabilitySchema,
  brokerSensitiveMessageAadBytes,
  brokerSensitiveMessageAadDigest,
  brokerSensitiveMessageCipherDigest,
  canonicalSha256,
  executionCapabilitySigningBytes,
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
  type DurableInboundCommandCandidate,
  type NewWorkerJournalAuthorization,
  type SqliteWorkerTransportOptions,
} from './sqlite-durable-transport.js';
import {
  type SqliteWorkerInvocationJournal,
  assertWorkerInvocationIntegrity,
  localInvocationPromptAadBytes,
  localInvocationPromptAadDigest,
  localInvocationPromptCipherDigest,
  localInvocationResultAadBytes,
  localInvocationResultAadDigest,
  localInvocationResultCipherDigest,
  type BrokerResultReencryptAuthorityPort,
  type CloudInvocationAckAuthorityPort,
  type HostDispatchReceiptAuthorityPort,
  type LocalInvocationPromptAad,
  type LocalInvocationPromptCiphertext,
  type LocalPromptAeadAuthorityPort,
  type LocalInvocationResultAad,
  type LocalInvocationResultCiphertext,
  type LocalResultAeadAuthorityPort,
  type OpaqueInvocationCloudAckReference,
  type PendingInvocationFactReference,
  type ReadyConversationAuthorityPort,
  type TrustedHostDispatchPort,
  type WorkerInvocationCapabilityAuthorityPort,
} from './sqlite-invocation-journal.js';
import type { DurableBrokerConnection } from './worker-broker-client.js';

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

describe('same-file SQLite Worker Invocation Journal v2', () => {
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

    await journal.bindReadyConversation({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.openReference,
      evidence: { token: 'sandbox-ready' },
      signal,
    });
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

  it('never reissues a STARTING permit after reopen and converts unknown dispatch to UNCERTAIN', async () => {
    const fixture = await createInvocationFixture(200);
    const signal = new AbortController().signal;
    let journal = fixture.adapter.createInvocationJournal(fixture.authorities.options);
    await journal.bindReadyConversation({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.openReference,
      evidence: { token: 'sandbox-ready' },
      signal,
    });
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
    expect(
      await journal.recoverUnconfirmedStarts({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        signal,
      }),
    ).toBe(1);
    expect(queryScalar(fixture.filename, 'state')).toBe('UNCERTAIN');
    expect(queryScalar(fixture.filename, 'host_dispatch_intent_count')).toBe(1);
    await expect(
      journal.start({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        command: fixture.startReference,
        signal,
      }),
    ).resolves.toMatchObject({ action: 'RETURN_IN_PROGRESS', state: 'UNCERTAIN' });
    expect(fixture.authorities.hostReceiptCalls.count).toBe(0);
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
    await journal.bindReadyConversation({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.openReference,
      evidence: { token: 'sandbox-ready' },
      signal,
    });
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
      await journal.bindReadyConversation({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        command: fixture.openReference,
        evidence: { token: 'sandbox-ready' },
        signal,
      });
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
    await journal.bindReadyConversation({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.openReference,
      evidence: { token: 'sandbox-ready' },
      signal,
    });
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

  it('uses the same physical reserve to recover STARTING as UNCERTAIN and purge Prompt', async () => {
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
    await journal.bindReadyConversation({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.openReference,
      evidence: { token: 'sandbox-ready' },
      signal,
    });
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
    ).resolves.toBe(1);
    expect(existsSync(`${fixture.filename}.recovery-reserve`)).toBe(true);
    expect(queryPragmaNumber(fixture.filename, 'freelist_count')).toBeGreaterThanOrEqual(192);
    expect(queryScalar(fixture.filename, 'state')).toBe('UNCERTAIN');
    expect(queryNullable(fixture.filename, 'local_invocations', 'prompt_ciphertext')).toBeNull();
    expect(
      rawJournalContainsAny(fixture.filename, [
        retainedPrompt.nonce,
        retainedPrompt.ciphertext,
        retainedPrompt.authTag,
      ]),
    ).toBe(false);
    expect(fixture.authorities.hostDispatchCalls.count).toBe(0);
    fixture.adapter.close();
  });

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
    await journal.bindReadyConversation({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.openReference,
      evidence: { token: 'sandbox-ready' },
      signal,
    });

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
    await journal.bindReadyConversation({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.openReference,
      evidence: { token: 'sandbox-ready' },
      signal,
    });
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
    await journal.bindReadyConversation({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.openReference,
      evidence: { token: 'sandbox-ready' },
      signal,
    });
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
    await journal.bindReadyConversation({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.openReference,
      evidence: { token: 'sandbox-ready' },
      signal,
    });
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
    await journal.bindReadyConversation({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.openReference,
      evidence: { token: 'sandbox-ready' },
      signal,
    });
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
    await journal.bindReadyConversation({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.openReference,
      evidence: { token: 'sandbox-ready' },
      signal,
    });
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
    await journal.bindReadyConversation({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.openReference,
      evidence: { token: 'sandbox-ready' },
      signal,
    });
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
    await journal.bindReadyConversation({
      installationId: fixture.installationId,
      ownerToken: OWNER,
      command: fixture.openReference,
      evidence: { token: 'sandbox-ready' },
      signal,
    });
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
      await journal.bindReadyConversation({
        installationId: fixture.installationId,
        ownerToken: OWNER,
        command: fixture.openReference,
        evidence: { token: 'sandbox-ready' },
        signal,
      });
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
    await journal.bindReadyConversation({
      installationId: stale.installationId,
      ownerToken: OWNER,
      command: stale.openReference,
      evidence: { token: 'sandbox-ready' },
      signal,
    });
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

async function createInvocationFixture(
  seed: number,
  transportOptions: Omit<SqliteWorkerTransportOptions, 'filename' | 'newJournalAuthorization'> = {},
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
    },
  });
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
      clientMessageId: uuid(seed * 100 + 14),
      requestDigest,
      userMessageCiphertext: userCiphertext,
      agentVersionId,
      agentVersionDigest: SHA('a'),
      snapshotDigest: SHA('b'),
      deadlineAt: new Date(nowMs + 50_000).toISOString(),
      executionCapability: capability,
    },
  }) as Extract<BrokerEnvelope, { type: 'invocation.prepare' }>;
  state = await commitCommand(adapter, installationId, state, prepareEnvelope);
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
  state = await commitCommand(adapter, installationId, state, startEnvelope);
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
    prepareEnvelope,
    startEnvelope,
    openReference: await commandReference(adapter, installationId, state, 'conversation.open'),
    prepareReference: await commandReference(adapter, installationId, state, 'invocation.prepare'),
    startReference: await commandReference(adapter, installationId, state, 'invocation.start'),
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
  await journal.bindReadyConversation({
    installationId: fixture.installationId,
    ownerToken: OWNER,
    command: fixture.openReference,
    evidence: { token: 'sandbox-ready' },
    signal,
  });
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

function pressurePrepareEnvelope(fixture: InvocationFixture, seed: number): BrokerEnvelope {
  const messageId = uuid(seed);
  const invocationId = uuid(seed + 1);
  const plaintext = Buffer.from(`pressure-${seed}-`.repeat(3_000), 'utf8');
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
      clientMessageId: uuid(seed + 4),
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
    cloudAckCalls,
    revokedCapabilityIds,
    cloudNow,
    options: {
      capabilityAuthority,
      readyConversationAuthority,
      hostDispatchPort,
      hostDispatchReceiptAuthority,
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

async function enqueueAndCommitCloudAck(
  adapter: SqliteWorkerBrokerDurableTransport,
  journal: SqliteWorkerInvocationJournal,
  fixture: InvocationFixture,
  fact: PendingInvocationFactReference,
  seed: number,
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
      decision: 'APPLIED',
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
