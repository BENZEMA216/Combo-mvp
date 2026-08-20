import { describe, expect, it } from 'vitest';

import { RegisteredExecutionCapabilityAuthority } from './capability-authority.js';
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
import { applyReconciliationDecision } from './reconciliation.js';

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

function acknowledgeGenericCommand(
  cloud: InMemoryCloudJournal,
  lease: ReturnType<typeof setup>['lease'],
  invocationId: string,
  commandId: string,
  index: number,
): void {
  const common = {
    commandId,
    invocationId,
    workerInstallationId: IDS.worker,
    lease,
    canonicalDigest: REQUEST_DIGEST,
  } as const;
  cloud.acknowledgeOutbox({ ...common, level: 'RECEIVED' });
  cloud.acknowledgeOutbox({
    ...common,
    level: 'PERSISTED',
    durableProof: {
      journal: 'WORKER_SQLITE',
      transactionId: `sqlite-${commandId}-${index}`,
      canonicalDigest: REQUEST_DIGEST,
    },
  });
}

function sequentialUuid(index: number, slot: number): string {
  const group = index.toString(16).padStart(4, '0');
  const suffix = (BigInt(index) * 16n + BigInt(slot)).toString(16).padStart(12, '0');
  return `0198f00d-${group}-7000-8000-${suffix}`;
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

  it('durably applies PERSISTED plus lost-local reconciliation as UNCERTAIN', () => {
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

    const applied = applyReconciliationDecision(test.cloud, {
      invocationId: IDS.invocationA,
      sourceEventId: 'reconcile-journal-lost',
      uncertaintyReason: 'JOURNAL_LOST',
      evidence: {
        cloudState: 'PERSISTED',
        localState: 'MISSING',
        hostEvidence: 'UNAVAILABLE',
        leaseState: 'REVOKED',
        executionCapability: 'VALID_FOR_INVOCATION',
        bindingDigestsMatch: true,
      },
    });
    expect(applied).toMatchObject({
      result: { decision: 'MARK_UNCERTAIN', automaticInferenceAllowed: false },
      cloudState: 'UNCERTAIN',
      mutationApplied: true,
    });
    expect(test.cloud.snapshot().invocations.get(IDS.invocationA)).toMatchObject({
      state: 'UNCERTAIN',
      uncertaintyReason: 'JOURNAL_LOST',
    });
    expect(test.cloud.snapshot().conversations.get(IDS.conversationA)).toMatchObject({
      state: 'IDLE',
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
    [
      {
        deploymentId: 'deployment-other',
        leaseId: IDS.lease,
        workerSessionId: IDS.workerSession,
        fence: '0',
      },
      'STALE_LEASE',
    ],
    [
      {
        deploymentId: IDS.deployment,
        leaseId: 'lease-other',
        workerSessionId: IDS.workerSession,
        fence: '0',
      },
      'STALE_LEASE',
    ],
    [
      {
        deploymentId: IDS.deployment,
        leaseId: IDS.lease,
        workerSessionId: IDS.workerSession,
        fence: '1',
      },
      'STALE_FENCE',
    ],
    [
      {
        deploymentId: IDS.deployment,
        leaseId: IDS.lease,
        workerSessionId: '0198f00d-0000-7000-8000-000000000099',
        fence: '0',
      },
      'STALE_LEASE',
    ],
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
    const base = setup();
    const revocations = new Set<string>();
    const authority = new RegisteredExecutionCapabilityAuthority(
      base.signed.publicKey,
      revocations,
    );
    const cloud = new InMemoryCloudJournal(base.registry, authority);
    cloud.createConversation({ id: IDS.conversationA, agentVersionId: IDS.agentVersion });
    cloud.createConversation({ id: IDS.conversationB, agentVersionId: IDS.agentVersion });
    const test = { ...base, cloud };
    advanceCloudToRunning(test);
    const original = finalInput(test);
    expect(test.cloud.commitFinal(original).state).toBe('SUCCEEDED');
    revocations.add(test.signed.capability.capabilityId);
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
    const tamperedSignature = {
      ...test.signed.capability,
      signature: `${test.signed.capability.signature[0] === 'A' ? 'B' : 'A'}${test.signed.capability.signature.slice(1)}`,
    };
    for (const mutation of [
      { workerInstallationId: 'worker-other' },
      { lease: { ...test.lease, deploymentId: 'deployment-other' } },
      { executionCapability: changedCapability },
      { executionCapability: tamperedSignature },
      { resultDigest: 'changed-result' },
      { sourceEventId: 'changed-source' },
    ]) {
      expect(() => test.cloud.commitFinal({ ...original, ...mutation })).toThrow();
      expect(test.cloud.snapshot()).toEqual(snapshot);
    }
  });

  it('restores terminal Cloud outbox retention watermarks and rejects archive corruption', () => {
    const test = setup();
    advanceCloudToRunning(test);
    test.cloud.commitFinal(finalInput(test));
    expect(test.cloud.pruneTerminalOutbox(NOW_MS + 6)).toBe(2);
    const serialized = test.cloud.serialize();
    expect(
      InMemoryCloudJournal.restore(serialized, test.registry, test.signed.authority).snapshot(),
    ).toEqual(test.cloud.snapshot());

    const corrupted = JSON.parse(serialized) as {
      archivedOutbox: Array<{ retainedUntilMs: number }>;
    };
    corrupted.archivedOutbox[0]!.retainedUntilMs += 1;
    expect(() =>
      InMemoryCloudJournal.restore(JSON.stringify(corrupted), test.registry, test.signed.authority),
    ).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    const negativeWatermark = JSON.parse(serialized) as {
      archivedOutbox: Array<{ archivedAtMs: number; retainedUntilMs: number }>;
    };
    negativeWatermark.archivedOutbox[0]!.archivedAtMs = -1;
    negativeWatermark.archivedOutbox[0]!.retainedUntilMs = -1 + 7 * 24 * 60 * 60 * 1_000;
    expect(() =>
      InMemoryCloudJournal.restore(
        JSON.stringify(negativeWatermark),
        test.registry,
        test.signed.authority,
      ),
    ).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    const missingSession = JSON.parse(serialized) as {
      invocations: Array<{ assignmentWorkerSessionId?: string }>;
    };
    delete missingSession.invocations[0]!.assignmentWorkerSessionId;
    expect(() =>
      InMemoryCloudJournal.restore(
        JSON.stringify(missingSession),
        test.registry,
        test.signed.authority,
      ),
    ).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
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
    expect(() => restored.expireOutbox(Number.NaN)).toThrowError(
      expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }),
    );
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
    expect(
      capped.requestStart({
        invocationId: IDS.invocationA,
        workerInstallationId: IDS.worker,
        lease: test.lease,
        sourceEventId: 'broker-start',
        nowMs: NOW_MS + 2,
        commandId: 'start-command',
        executionCapability: test.signed.capability,
        expectedExecutionCapability: test.signed.expected,
      }).state,
    ).toBe('STARTING');

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

  it('completes and prunes 1001 sequential invocations with bounded active outboxes', () => {
    const test = setup();
    const cloud = new InMemoryCloudJournal(test.registry, test.signed.authority, 1);
    const worker = new InMemoryWorkerJournal(test.signed.authority, 3);
    cloud.createConversation({ id: IDS.conversationA, agentVersionId: IDS.agentVersion });
    let firstAcceptInput: AcceptInvocationInput | undefined;
    let firstPrepareInput: WorkerPrepareInput | undefined;

    for (let index = 0; index < 1_001; index += 1) {
      const invocationId = sequentialUuid(index, 1);
      const capabilityId = sequentialUuid(index, 2);
      const providerRequestId = sequentialUuid(index, 3);
      const candidate = createSignedCapabilityFixture({
        capabilityId,
        invocationId,
        providerRequestId,
        nonce: Buffer.from(`sequential-capability-nonce-${index}`, 'utf8').toString('base64url'),
      });
      const executionCapability = signCapability(candidate.capability, test.signed.privateKey);
      const prepareCommandId = `prepare-${index}`;
      const startCommandId = `start-${index}`;
      const workerPreparedEventId = `worker-prepared-${index}`;
      const workerStartedEventId = `worker-started-${index}`;
      const workerFinalEventId = `worker-final-${index}`;
      const accept = {
        invocationId,
        userMessageId: `user-message-${index}`,
        conversationId: IDS.conversationA,
        clientMessageId: `client-message-${index}`,
        requestDigest: REQUEST_DIGEST,
        contentDigest: `content-${index}`,
        agentVersionDigest: AGENT_VERSION_DIGEST,
        providerRequestId,
        workerInstallationId: IDS.worker,
        lease: test.lease,
        executionCapability,
        expectedExecutionCapability: candidate.expected,
        nowMs: NOW_MS,
        prepareCommandId,
        sourceEventId: `api-accepted-${index}`,
      } as const;
      if (index === 0) firstAcceptInput = accept;
      cloud.acceptInvocation(accept);
      cloud.markDispatchPending({
        invocationId,
        workerInstallationId: IDS.worker,
        lease: test.lease,
        sourceEventId: `broker-dispatch-${index}`,
        nowMs: NOW_MS + 1,
      });
      const prepare = {
        invocationId,
        conversationId: IDS.conversationA,
        clientMessageId: `client-message-${index}`,
        requestDigest: REQUEST_DIGEST,
        agentVersionId: IDS.agentVersion,
        agentVersionDigest: AGENT_VERSION_DIGEST,
        providerRequestId,
        workerInstallationId: IDS.worker,
        lease: test.lease,
        executionCapability,
        expectedExecutionCapability: candidate.expected,
        nowMs: NOW_MS,
        commandId: prepareCommandId,
        sourceEventId: workerPreparedEventId,
      } as const;
      if (index === 0) firstPrepareInput = prepare;
      worker.prepare(prepare);
      acknowledgeGenericCommand(cloud, test.lease, invocationId, prepareCommandId, index);
      cloud.recordWorkerPersisted({
        invocationId,
        workerInstallationId: IDS.worker,
        lease: test.lease,
        sourceEventId: workerPreparedEventId,
        payloadDigest: REQUEST_DIGEST,
      });
      cloud.requestStart({
        invocationId,
        workerInstallationId: IDS.worker,
        lease: test.lease,
        sourceEventId: `broker-start-${index}`,
        nowMs: NOW_MS + 2,
        commandId: startCommandId,
        executionCapability,
        expectedExecutionCapability: candidate.expected,
      });
      worker.start({
        invocationId,
        requestDigest: REQUEST_DIGEST,
        workerInstallationId: IDS.worker,
        lease: test.lease,
        nowMs: NOW_MS + 2,
        commandId: startCommandId,
        executionCapability,
        expectedExecutionCapability: candidate.expected,
      });
      acknowledgeGenericCommand(cloud, test.lease, invocationId, startCommandId, index);
      worker.confirmHostDispatch({
        invocationId,
        requestDigest: REQUEST_DIGEST,
        runtimeTurnId: `turn-${index}`,
        sourceEventId: workerStartedEventId,
        nowMs: NOW_MS + 3,
      });
      cloud.recordRunning({
        invocationId,
        workerInstallationId: IDS.worker,
        lease: test.lease,
        sourceEventId: workerStartedEventId,
        payloadDigest: `turn-${index}`,
      });
      worker.writeFinal({
        invocationId,
        requestDigest: REQUEST_DIGEST,
        resultDigest: `result-${index}`,
        sourceEventId: workerFinalEventId,
        nowMs: NOW_MS + 4,
      });
      cloud.commitFinal({
        invocationId,
        workerInstallationId: IDS.worker,
        lease: test.lease,
        sourceEventId: workerFinalEventId,
        resultMessageId: `result-message-${index}`,
        resultDigest: `result-${index}`,
        executionCapability,
        expectedExecutionCapability: candidate.expected,
        nowMs: NOW_MS + 5,
      });
      worker.markCloudCommitted(invocationId, workerFinalEventId);
      expect(cloud.pruneTerminalOutbox(NOW_MS + 6)).toBe(2);
      expect(worker.pruneTerminalOutbox(NOW_MS + 6)).toBe(3);
    }

    expect(cloud.snapshot()).toMatchObject({ outbox: [] });
    expect(cloud.snapshot().archivedOutbox).toHaveLength(2_002);
    expect(cloud.snapshot().invocations.size).toBe(1_001);
    expect(worker.snapshot().outbox).toEqual([]);
    expect(worker.snapshot().archivedOutbox).toHaveLength(3_003);
    expect(worker.snapshot().invocations.size).toBe(1_001);

    expect(firstAcceptInput).toBeDefined();
    expect(firstPrepareInput).toBeDefined();
    expect(cloud.acceptInvocation(firstAcceptInput!).state).toBe('SUCCEEDED');
    expect(worker.prepare(firstPrepareInput!).state).toBe('CLOUD_COMMITTED');
    expect(cloud.pruneExpiredArchive(NOW_MS + 6 + 7 * 24 * 60 * 60 * 1_000 - 1)).toBe(0);
    expect(worker.pruneExpiredArchive(NOW_MS + 6 + 7 * 24 * 60 * 60 * 1_000 - 1)).toBe(0);

    const retentionDeadline = NOW_MS + 6 + 7 * 24 * 60 * 60 * 1_000;
    expect(cloud.pruneExpiredArchive(retentionDeadline)).toBe(2_002);
    expect(worker.pruneExpiredArchive(retentionDeadline)).toBe(3_003);
    expect(cloud.snapshot().archivedOutbox).toEqual([]);
    expect(worker.snapshot().archivedOutbox).toEqual([]);
    expect(() =>
      cloud.acknowledgeOutbox({
        commandId: 'prepare-0',
        invocationId: sequentialUuid(0, 1),
        workerInstallationId: IDS.worker,
        lease: test.lease,
        level: 'PERSISTED',
        canonicalDigest: REQUEST_DIGEST,
        durableProof: {
          journal: 'WORKER_SQLITE',
          transactionId: 'sqlite-prepare-0-0',
          canonicalDigest: REQUEST_DIGEST,
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'OUTBOX_NOT_FOUND' }));
    // Cloud terminal projection and Worker terminal invocation remain the
    // authoritative rehydration sources after the seven-day outbox archive expires.
    expect(cloud.acceptInvocation(firstAcceptInput!).state).toBe('SUCCEEDED');
    expect(worker.prepare(firstPrepareInput!).state).toBe('CLOUD_COMMITTED');
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

  it('restores terminal Worker outbox retention watermarks and rejects archive duplicates', () => {
    const test = setup();
    advanceWorkerToRunning(test);
    test.worker.writeFinal({
      invocationId: IDS.invocationA,
      requestDigest: REQUEST_DIGEST,
      resultDigest: 'result-digest',
      sourceEventId: 'worker-final',
      nowMs: NOW_MS + 3,
    });
    test.worker.markCloudCommitted(IDS.invocationA, 'worker-final');
    expect(test.worker.pruneTerminalOutbox(NOW_MS + 4)).toBe(3);
    const serialized = test.worker.serialize();
    expect(InMemoryWorkerJournal.restore(serialized, test.signed.authority).snapshot()).toEqual(
      test.worker.snapshot(),
    );

    const corrupted = JSON.parse(serialized) as {
      outbox: unknown[];
      archivedOutbox: unknown[];
    };
    corrupted.outbox.push(corrupted.archivedOutbox[0]);
    expect(() =>
      InMemoryWorkerJournal.restore(JSON.stringify(corrupted), test.signed.authority),
    ).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    const negativeWatermark = JSON.parse(serialized) as {
      archivedOutbox: Array<{ archivedAtMs: number; retainedUntilMs: number }>;
    };
    negativeWatermark.archivedOutbox[0]!.archivedAtMs = -1;
    negativeWatermark.archivedOutbox[0]!.retainedUntilMs = -1 + 7 * 24 * 60 * 60 * 1_000;
    expect(() =>
      InMemoryWorkerJournal.restore(JSON.stringify(negativeWatermark), test.signed.authority),
    ).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    const missingSession = JSON.parse(serialized) as {
      invocations: Array<{ workerSessionId?: string }>;
    };
    delete missingSession.invocations[0]!.workerSessionId;
    expect(() =>
      InMemoryWorkerJournal.restore(JSON.stringify(missingSession), test.signed.authority),
    ).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
  });

  it('serializes/reconstructs exact binding and preserves expired outbox facts', () => {
    const test = setup();
    test.worker.prepare(basePrepareInput(test));
    const restored = InMemoryWorkerJournal.restore(test.worker.serialize(), test.signed.authority);
    expect(restored.snapshot()).toEqual(test.worker.snapshot());
    expect(() => restored.expireOutbox(Number.NaN)).toThrowError(
      expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }),
    );
    expect(restored.expireOutbox(DEADLINE_MS)).toHaveLength(1);
    expect(restored.snapshot().outbox[0]?.state).toBe('EXPIRED');
  });
});
