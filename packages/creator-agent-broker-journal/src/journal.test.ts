import { describe, expect, it } from 'vitest';

import { InMemoryCloudJournal, type AcceptInvocationInput } from './cloud-journal.js';
import {
  AGENT_VERSION_DIGEST,
  DEADLINE_MS,
  IDS,
  NOW_MS,
  REQUEST_DIGEST,
  createLeaseAuthority,
  createSignedCapabilityFixture,
  signCapability,
} from './reference-fixture.js';
import { InMemoryWorkerJournal, type WorkerPrepareInput } from './worker-journal.js';

function setup() {
  const signed = createSignedCapabilityFixture();
  const { registry, lease } = createLeaseAuthority();
  const cloud = new InMemoryCloudJournal(registry, signed.authority);
  cloud.createConversation({ id: IDS.conversationA, agentVersionId: IDS.agentVersion });
  cloud.createConversation({ id: IDS.conversationB, agentVersionId: IDS.agentVersion });
  const worker = new InMemoryWorkerJournal(signed.authority);
  return { signed, registry, lease, cloud, worker };
}

function acceptInput(
  setupResult: ReturnType<typeof setup>,
  overrides: Partial<AcceptInvocationInput> = {},
): AcceptInvocationInput {
  return { ...baseAcceptInput(setupResult), ...overrides };
}

function baseAcceptInput(setupResult: ReturnType<typeof setup>): AcceptInvocationInput {
  return {
    invocationId: IDS.invocationA,
    userMessageId: IDS.userMessage,
    conversationId: IDS.conversationA,
    clientMessageId: 'client-message-a',
    requestDigest: REQUEST_DIGEST,
    contentDigest: 'content-digest',
    agentVersionDigest: AGENT_VERSION_DIGEST,
    providerRequestId: IDS.providerRequest,
    workerInstallationId: IDS.worker,
    lease: setupResult.lease,
    executionCapability: setupResult.signed.capability,
    expectedExecutionCapability: setupResult.signed.expected,
    nowMs: NOW_MS,
    prepareCommandId: 'prepare-command',
    sourceEventId: 'api-accepted',
  };
}

function prepareInput(
  setupResult: ReturnType<typeof setup>,
  overrides: Partial<WorkerPrepareInput> = {},
): WorkerPrepareInput {
  return { ...basePrepareInput(setupResult), ...overrides };
}

function basePrepareInput(setupResult: ReturnType<typeof setup>): WorkerPrepareInput {
  return {
    invocationId: IDS.invocationA,
    conversationId: IDS.conversationA,
    clientMessageId: 'client-message-a',
    requestDigest: REQUEST_DIGEST,
    agentVersionId: IDS.agentVersion,
    agentVersionDigest: AGENT_VERSION_DIGEST,
    providerRequestId: IDS.providerRequest,
    workerInstallationId: IDS.worker,
    lease: setupResult.lease,
    executionCapability: setupResult.signed.capability,
    expectedExecutionCapability: setupResult.signed.expected,
    nowMs: NOW_MS,
    commandId: 'prepare-command',
    sourceEventId: 'worker-prepared',
  };
}

function persistCommandAck(setupResult: ReturnType<typeof setup>, commandId: string): void {
  const common = {
    commandId,
    invocationId: IDS.invocationA,
    workerInstallationId: IDS.worker,
    lease: setupResult.lease,
    canonicalDigest: REQUEST_DIGEST,
  } as const;
  setupResult.cloud.acknowledgeOutbox({ ...common, level: 'RECEIVED' });
  setupResult.cloud.acknowledgeOutbox({
    ...common,
    level: 'PERSISTED',
    durableProof: {
      journal: 'WORKER_SQLITE',
      transactionId: `sqlite-${commandId}`,
      canonicalDigest: REQUEST_DIGEST,
    },
  });
}

function advanceCloudToRunning(setupResult: ReturnType<typeof setup>) {
  const { cloud, lease, signed } = setupResult;
  cloud.acceptInvocation(baseAcceptInput(setupResult));
  cloud.markDispatchPending({
    invocationId: IDS.invocationA,
    workerInstallationId: IDS.worker,
    lease,
    sourceEventId: 'broker-dispatch',
    nowMs: NOW_MS + 1,
  });
  persistCommandAck(setupResult, 'prepare-command');
  cloud.recordWorkerPersisted({
    invocationId: IDS.invocationA,
    workerInstallationId: IDS.worker,
    lease,
    sourceEventId: 'worker-prepared',
    payloadDigest: REQUEST_DIGEST,
  });
  cloud.requestStart({
    invocationId: IDS.invocationA,
    workerInstallationId: IDS.worker,
    lease,
    sourceEventId: 'broker-start',
    nowMs: NOW_MS + 2,
    commandId: 'start-command',
    executionCapability: signed.capability,
    expectedExecutionCapability: signed.expected,
  });
  persistCommandAck(setupResult, 'start-command');
  cloud.recordRunning({
    invocationId: IDS.invocationA,
    workerInstallationId: IDS.worker,
    lease,
    sourceEventId: 'worker-started',
    payloadDigest: 'turn-a',
  });
}

function advanceWorkerToRunning(setupResult: ReturnType<typeof setup>) {
  const { worker, lease, signed } = setupResult;
  worker.prepare(basePrepareInput(setupResult));
  worker.start({
    invocationId: IDS.invocationA,
    requestDigest: REQUEST_DIGEST,
    workerInstallationId: IDS.worker,
    lease,
    nowMs: NOW_MS + 1,
    commandId: 'start-command',
    executionCapability: signed.capability,
    expectedExecutionCapability: signed.expected,
  });
  worker.confirmHostDispatch({
    invocationId: IDS.invocationA,
    requestDigest: REQUEST_DIGEST,
    runtimeTurnId: 'turn-a',
    sourceEventId: 'worker-started',
    nowMs: NOW_MS + 2,
  });
}

function finalInput(setupResult: ReturnType<typeof setup>) {
  return {
    invocationId: IDS.invocationA,
    workerInstallationId: IDS.worker,
    lease: setupResult.lease,
    sourceEventId: 'worker-final',
    resultMessageId: IDS.resultMessage,
    resultDigest: 'result-digest',
    executionCapability: setupResult.signed.capability,
    expectedExecutionCapability: setupResult.signed.expected,
    nowMs: NOW_MS + 3,
  };
}

describe('PostgreSQL-style E1 cloud reducer', () => {
  it('atomically binds request, deployment, worker, lease/fence, signed capability and outbox', () => {
    const test = setup();
    const invocation = test.cloud.acceptInvocation(baseAcceptInput(test));
    const snapshot = test.cloud.snapshot();
    expect(invocation).toMatchObject({
      state: 'QUEUED',
      deploymentId: IDS.deployment,
      workerInstallationId: IDS.worker,
      assignmentLeaseId: IDS.lease,
      executionCapabilityDeadlineAtMs: DEADLINE_MS,
    });
    expect(invocation.executionCapabilityDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.outbox).toHaveLength(1);
    expect(snapshot.conversations.get(IDS.conversationA)).toMatchObject({
      state: 'BUSY',
      activeInvocationId: IDS.invocationA,
    });
  });

  it('coalesces exact replay 100 times and rejects same ID with changed input', () => {
    const test = setup();
    const first = test.cloud.acceptInvocation(baseAcceptInput(test));
    for (let replay = 0; replay < 100; replay += 1) {
      expect(test.cloud.acceptInvocation(baseAcceptInput(test))).toEqual(first);
    }
    expect(() =>
      test.cloud.acceptInvocation(
        acceptInput(test, { requestDigest: `hmac-sha256:${'9'.repeat(64)}` }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    expect(test.cloud.snapshot().invocations.size).toBe(1);
  });

  it('does not confuse transport RECEIVED with a durable Worker SQLite ACK', () => {
    const test = setup();
    test.cloud.acceptInvocation(baseAcceptInput(test));
    test.cloud.markDispatchPending({
      invocationId: IDS.invocationA,
      workerInstallationId: IDS.worker,
      lease: test.lease,
      sourceEventId: 'broker-dispatch',
      nowMs: NOW_MS + 1,
    });
    const common = {
      commandId: 'prepare-command',
      invocationId: IDS.invocationA,
      workerInstallationId: IDS.worker,
      lease: test.lease,
      canonicalDigest: REQUEST_DIGEST,
    } as const;
    expect(test.cloud.acknowledgeOutbox({ ...common, level: 'RECEIVED' })).toMatchObject({
      state: 'SENT',
      ackLevel: 'RECEIVED',
    });
    expect(() =>
      test.cloud.recordWorkerPersisted({
        invocationId: IDS.invocationA,
        workerInstallationId: IDS.worker,
        lease: test.lease,
        sourceEventId: 'worker-prepared',
        payloadDigest: REQUEST_DIGEST,
      }),
    ).toThrowError(expect.objectContaining({ code: 'OUTBOX_ACK_INVALID' }));
    expect(() =>
      test.cloud.acknowledgeOutbox({
        ...common,
        level: 'PERSISTED',
        durableProof: {
          journal: 'CLOUD_POSTGRESQL',
          transactionId: 'wrong-journal',
          canonicalDigest: REQUEST_DIGEST,
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'OUTBOX_ACK_INVALID' }));

    persistCommandAck(test, 'prepare-command');
    const committed = test.cloud.snapshot().outbox[0];
    expect(committed).toMatchObject({ state: 'ACKED', ackLevel: 'PERSISTED' });
    const restored = InMemoryCloudJournal.restore(
      test.cloud.serialize(),
      test.registry,
      test.signed.authority,
    );
    expect(restored.snapshot().outbox[0]).toEqual(committed);
    expect(() =>
      restored.acknowledgeOutbox({
        ...common,
        level: 'PERSISTED',
        durableProof: {
          journal: 'WORKER_SQLITE',
          transactionId: 'changed-proof',
          canonicalDigest: REQUEST_DIGEST,
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'OUTBOX_ACK_INVALID' }));
  });

  it('enforces conversation WIP=1 before accepting a second invocation', () => {
    const test = setup();
    test.cloud.acceptInvocation(baseAcceptInput(test));
    expect(() =>
      test.cloud.acceptInvocation(
        acceptInput(test, {
          invocationId: IDS.invocationB,
          userMessageId: '0198f00d-0000-7000-8000-00000000000d',
          clientMessageId: 'client-message-b',
          prepareCommandId: 'prepare-command-b',
          sourceEventId: 'api-accepted-b',
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'CONVERSATION_BUSY' }));
  });

  it('allows exact acceptance replay after lease revoke but rejects new work without live authority', () => {
    const test = setup();
    test.cloud.acceptInvocation(baseAcceptInput(test));
    test.registry.revoke(IDS.deployment);
    expect(test.cloud.acceptInvocation(baseAcceptInput(test)).id).toBe(IDS.invocationA);
    expect(() =>
      test.cloud.acceptInvocation(
        acceptInput(test, {
          invocationId: IDS.invocationB,
          conversationId: IDS.conversationB,
          userMessageId: '0198f00d-0000-7000-8000-00000000000d',
          clientMessageId: 'client-message-b',
          prepareCommandId: 'prepare-command-b',
          sourceEventId: 'api-accepted-b',
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'STALE_LEASE' }));
  });

  it('rejects a tampered signed capability before any projection mutation', () => {
    const test = setup();
    const capability = test.signed.capability;
    const tampered = {
      ...capability,
      signature: `${capability.signature[0] === 'A' ? 'B' : 'A'}${capability.signature.slice(1)}`,
    };
    const before = test.cloud.snapshot();
    expect(() =>
      test.cloud.acceptInvocation(acceptInput(test, { executionCapability: tampered })),
    ).toThrowError(expect.objectContaining({ code: 'EXECUTION_CAPABILITY_INVALID' }));
    expect(test.cloud.snapshot()).toEqual(before);
  });

  it('requires current lease authority and exact signed capability before start', () => {
    const test = setup();
    test.cloud.acceptInvocation(baseAcceptInput(test));
    test.cloud.markDispatchPending({
      invocationId: IDS.invocationA,
      workerInstallationId: IDS.worker,
      lease: test.lease,
      sourceEventId: 'broker-dispatch',
      nowMs: NOW_MS + 1,
    });
    persistCommandAck(test, 'prepare-command');
    test.cloud.recordWorkerPersisted({
      invocationId: IDS.invocationA,
      workerInstallationId: IDS.worker,
      lease: test.lease,
      sourceEventId: 'worker-prepared',
      payloadDigest: REQUEST_DIGEST,
    });
    const before = test.cloud.snapshot();
    test.registry.revoke(IDS.deployment);
    expect(() =>
      test.cloud.requestStart({
        invocationId: IDS.invocationA,
        workerInstallationId: IDS.worker,
        lease: test.lease,
        sourceEventId: 'broker-start',
        nowMs: NOW_MS + 2,
        commandId: 'start-command',
        executionCapability: test.signed.capability,
        expectedExecutionCapability: test.signed.expected,
      }),
    ).toThrowError(expect.objectContaining({ code: 'STALE_LEASE' }));
    expect(test.cloud.snapshot()).toEqual(before);
  });

  it.each([
    [{ deploymentId: 'deployment-other', leaseId: IDS.lease, fence: '0' }, 'STALE_LEASE'],
    [{ deploymentId: IDS.deployment, leaseId: 'lease-other', fence: '0' }, 'STALE_LEASE'],
    [{ deploymentId: IDS.deployment, leaseId: IDS.lease, fence: '1' }, 'STALE_FENCE'],
  ] as const)('rejects mismatched assignment %j', (lease, code) => {
    const test = setup();
    test.cloud.acceptInvocation(baseAcceptInput(test));
    test.cloud.markDispatchPending({
      invocationId: IDS.invocationA,
      workerInstallationId: IDS.worker,
      lease: test.lease,
      sourceEventId: 'broker-dispatch',
      nowMs: NOW_MS + 1,
    });
    const before = test.cloud.snapshot();
    expect(() =>
      test.cloud.recordWorkerPersisted({
        invocationId: IDS.invocationA,
        workerInstallationId: IDS.worker,
        lease,
        sourceEventId: 'worker-prepared',
        payloadDigest: REQUEST_DIGEST,
      }),
    ).toThrowError(expect.objectContaining({ code }));
    expect(test.cloud.snapshot()).toEqual(before);
  });

  it('authenticates the full original terminal request before exact replay and inserts one answer', () => {
    const test = setup();
    advanceCloudToRunning(test);
    const original = finalInput(test);
    expect(test.cloud.commitFinal(original).state).toBe('SUCCEEDED');
    expect(test.cloud.commitFinal({ ...original, nowMs: DEADLINE_MS + 60_000 }).state).toBe(
      'SUCCEEDED',
    );
    const snapshot = test.cloud.snapshot();
    expect(snapshot.messages.filter((message) => message.role === 'ASSISTANT')).toHaveLength(1);
    expect(
      snapshot.events.filter((event) => event.eventType === 'invocation.succeeded'),
    ).toHaveLength(1);

    const changedCapability = signCapability(
      { ...test.signed.capability, model: 'different-model' },
      test.signed.privateKey,
    );
    for (const mutation of [
      { workerInstallationId: 'worker-other' },
      { lease: { ...test.lease, deploymentId: 'deployment-other' } },
      { executionCapability: changedCapability },
      { resultDigest: 'changed-result' },
      { sourceEventId: 'changed-source' },
    ]) {
      expect(() => test.cloud.commitFinal({ ...original, ...mutation })).toThrow();
      expect(test.cloud.snapshot()).toEqual(snapshot);
    }
  });

  it('serializes/reconstructs durable state and bounds/retains expired outbox facts', () => {
    const test = setup();
    test.cloud.acceptInvocation(baseAcceptInput(test));
    const restored = InMemoryCloudJournal.restore(
      test.cloud.serialize(),
      test.registry,
      test.signed.authority,
    );
    expect(restored.snapshot()).toEqual(test.cloud.snapshot());
    expect(restored.expireOutbox(DEADLINE_MS)).toHaveLength(1);
    expect(restored.snapshot().outbox[0]?.state).toBe('EXPIRED');

    const capped = new InMemoryCloudJournal(test.registry, test.signed.authority, 1);
    capped.createConversation({ id: IDS.conversationA, agentVersionId: IDS.agentVersion });
    capped.acceptInvocation(baseAcceptInput({ ...test, cloud: capped }));
    capped.markDispatchPending({
      invocationId: IDS.invocationA,
      workerInstallationId: IDS.worker,
      lease: test.lease,
      sourceEventId: 'broker-dispatch',
      nowMs: NOW_MS + 1,
    });
    persistCommandAck({ ...test, cloud: capped }, 'prepare-command');
    capped.recordWorkerPersisted({
      invocationId: IDS.invocationA,
      workerInstallationId: IDS.worker,
      lease: test.lease,
      sourceEventId: 'worker-prepared',
      payloadDigest: REQUEST_DIGEST,
    });
    expect(() =>
      capped.requestStart({
        invocationId: IDS.invocationA,
        workerInstallationId: IDS.worker,
        lease: test.lease,
        sourceEventId: 'broker-start',
        nowMs: NOW_MS + 2,
        commandId: 'start-command',
        executionCapability: test.signed.capability,
        expectedExecutionCapability: test.signed.expected,
      }),
    ).toThrowError(expect.objectContaining({ code: 'OUTBOX_CAPACITY' }));

    const journalCapped = new InMemoryCloudJournal(test.registry, test.signed.authority, 10, 1);
    journalCapped.createConversation({
      id: IDS.conversationA,
      agentVersionId: IDS.agentVersion,
    });
    expect(() =>
      journalCapped.createConversation({
        id: IDS.conversationB,
        agentVersionId: IDS.agentVersion,
      }),
    ).toThrowError(expect.objectContaining({ code: 'JOURNAL_CAPACITY' }));
  });
});

describe('SQLite-style E1 worker reducer', () => {
  it('coalesces 100 exact prepares into one invocation and one transactional outbox fact', () => {
    const test = setup();
    for (let replay = 0; replay < 100; replay += 1) {
      test.worker.prepare(basePrepareInput(test));
    }
    const snapshot = test.worker.snapshot();
    expect(snapshot.invocations.size).toBe(1);
    expect(snapshot.outbox).toHaveLength(1);
    expect(snapshot.activeInvocationId).toBe(IDS.invocationA);
  });

  it('rejects same invocation with changed input and keeps deployment in the binding', () => {
    const test = setup();
    test.worker.prepare(basePrepareInput(test));
    expect(() =>
      test.worker.prepare(prepareInput(test, { requestDigest: `hmac-sha256:${'9'.repeat(64)}` })),
    ).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    expect(() =>
      test.worker.prepare(
        prepareInput(test, { lease: { ...test.lease, deploymentId: 'deployment-other' } }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
  });

  it('rejects invalid capability and enforces global worker WIP=1', () => {
    const invalid = setup();
    expect(() =>
      invalid.worker.prepare(
        prepareInput(invalid, {
          executionCapability: { ...invalid.signed.capability, signature: 'A'.repeat(86) },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'EXECUTION_CAPABILITY_INVALID' }));

    const test = setup();
    test.worker.prepare(basePrepareInput(test));
    expect(() =>
      test.worker.prepare(
        prepareInput(test, {
          invocationId: IDS.invocationB,
          conversationId: IDS.conversationB,
          clientMessageId: 'client-message-b',
          commandId: 'prepare-command-b',
          sourceEventId: 'worker-prepared-b',
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'WORKER_BUSY' }));
  });

  it('persists start intent before Host dispatch and never accepts a second command', () => {
    const test = setup();
    test.worker.prepare(basePrepareInput(test));
    const start = {
      invocationId: IDS.invocationA,
      requestDigest: REQUEST_DIGEST,
      workerInstallationId: IDS.worker,
      lease: test.lease,
      nowMs: NOW_MS + 1,
      commandId: 'start-command',
      executionCapability: test.signed.capability,
      expectedExecutionCapability: test.signed.expected,
    } as const;
    for (let replay = 0; replay < 100; replay += 1) test.worker.start(start);
    expect(test.worker.snapshot().invocations.get(IDS.invocationA)).toMatchObject({
      state: 'STARTING',
      hostDispatchIntentCount: 1,
      hostDispatchConfirmedCount: 0,
    });
    expect(() => test.worker.start({ ...start, commandId: 'second-start' })).toThrowError(
      expect.objectContaining({ code: 'START_COMMAND_CONFLICT' }),
    );
  });

  it.each([
    ['markFailed', 'FAILED', 'invocation.failed'],
    ['markCancelled', 'CANCELLED', 'invocation.cancelled'],
    ['markUncertain', 'UNCERTAIN', 'invocation.uncertain'],
  ] as const)(
    '%s commits terminal projection and outbox in one transaction',
    (method, state, eventType) => {
      const test = setup();
      test.worker.prepare(basePrepareInput(test));
      if (method === 'markFailed') {
        test.worker.markFailed({
          invocationId: IDS.invocationA,
          sourceEventId: 'terminal',
          errorDigest: 'error',
        });
      } else if (method === 'markCancelled') {
        test.worker.markCancelled({
          invocationId: IDS.invocationA,
          sourceEventId: 'terminal',
          interruptEvidenceDigest: 'interrupt',
        });
      } else {
        test.worker.markUncertain({
          invocationId: IDS.invocationA,
          sourceEventId: 'terminal',
          reasonDigest: 'unknown',
        });
      }
      const snapshot = test.worker.snapshot();
      expect(snapshot.invocations.get(IDS.invocationA)?.state).toBe(state);
      expect(snapshot.outbox.at(-1)).toMatchObject({ eventType, state: 'PENDING' });
      expect(snapshot.activeInvocationId).toBeUndefined();
    },
  );

  it('persists one local final, replays it exactly and marks the matching outbox committed', () => {
    const test = setup();
    advanceWorkerToRunning(test);
    const final = {
      invocationId: IDS.invocationA,
      requestDigest: REQUEST_DIGEST,
      resultDigest: 'result-digest',
      sourceEventId: 'worker-final',
      nowMs: NOW_MS + 3,
    };
    for (let replay = 0; replay < 100; replay += 1) test.worker.writeFinal(final);
    expect(test.worker.expireOutbox(DEADLINE_MS + 1)).toHaveLength(2);
    expect(
      test.worker.snapshot().outbox.find((event) => event.eventType === 'invocation.succeeded'),
    ).toMatchObject({ state: 'PENDING', payloadDigest: 'result-digest' });
    test.worker.markCloudCommitted(IDS.invocationA, 'worker-final');
    const snapshot = test.worker.snapshot();
    expect(snapshot.invocations.get(IDS.invocationA)).toMatchObject({
      state: 'CLOUD_COMMITTED',
      cloudCommitted: true,
    });
    expect(
      snapshot.outbox.filter((event) => event.eventType === 'invocation.succeeded'),
    ).toHaveLength(1);
    expect(snapshot.outbox.at(-1)?.state).toBe('CLOUD_COMMITTED');
  });

  it('serializes/reconstructs exact binding and preserves expired outbox facts', () => {
    const test = setup();
    test.worker.prepare(basePrepareInput(test));
    const restored = InMemoryWorkerJournal.restore(test.worker.serialize(), test.signed.authority);
    expect(restored.snapshot()).toEqual(test.worker.snapshot());
    expect(restored.expireOutbox(DEADLINE_MS)).toHaveLength(1);
    expect(restored.snapshot().outbox[0]?.state).toBe('EXPIRED');
  });
});
