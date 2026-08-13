import { describe, expect, it } from 'vitest';

import { CloudJournalError, InMemoryCloudJournal } from './cloud-journal.js';
import type { LeaseBinding } from './protocol.js';
import { InMemoryWorkerJournal, WorkerJournalError } from './worker-journal.js';

const LEASE: LeaseBinding = {
  deploymentId: 'deployment-a',
  leaseId: 'lease-a',
  fence: '42',
};

function createCloud() {
  const cloud = new InMemoryCloudJournal();
  cloud.createConversation({ id: 'conversation-a', agentVersionId: 'version-a' });
  cloud.createConversation({ id: 'conversation-b', agentVersionId: 'version-a' });
  return cloud;
}

function accept(cloud: InMemoryCloudJournal, overrides: Record<string, string> = {}) {
  return cloud.acceptInvocation({
    invocationId: overrides.invocationId ?? 'invocation-a',
    userMessageId: overrides.userMessageId ?? 'user-message-a',
    conversationId: overrides.conversationId ?? 'conversation-a',
    clientMessageId: overrides.clientMessageId ?? 'client-message-a',
    requestDigest: overrides.requestDigest ?? 'request-digest',
    contentDigest: overrides.contentDigest ?? 'content-digest',
    assignedWorkerId: overrides.assignedWorkerId ?? 'worker-a',
    lease: LEASE,
    prepareCommandId: overrides.prepareCommandId ?? 'prepare-command',
    sourceEventId: overrides.sourceEventId ?? 'api-accepted',
  });
}

function prepare(worker: InMemoryWorkerJournal, overrides: Record<string, string> = {}) {
  return worker.prepare({
    invocationId: overrides.invocationId ?? 'invocation-a',
    conversationId: overrides.conversationId ?? 'conversation-a',
    clientMessageId: overrides.clientMessageId ?? 'client-message-a',
    requestDigest: overrides.requestDigest ?? 'request-digest',
    agentVersionId: overrides.agentVersionId ?? 'version-a',
    lease: LEASE,
    commandId: overrides.commandId ?? 'prepare-command',
    sourceEventId: overrides.sourceEventId ?? 'worker-prepared',
  });
}

function advanceCloudToStarting(cloud: InMemoryCloudJournal) {
  accept(cloud);
  cloud.markDispatchPending('invocation-a', 'broker-dispatch');
  cloud.recordWorkerPersisted({
    invocationId: 'invocation-a',
    workerId: 'worker-a',
    lease: LEASE,
    sourceEventId: 'worker-prepared',
    payloadDigest: 'request-digest',
  });
  cloud.requestStart({
    invocationId: 'invocation-a',
    commandId: 'start-command',
    sourceEventId: 'broker-start',
  });
}

function advanceWorkerToRunning(worker: InMemoryWorkerJournal) {
  prepare(worker);
  worker.start({
    invocationId: 'invocation-a',
    requestDigest: 'request-digest',
    lease: LEASE,
    commandId: 'start-command',
  });
  worker.confirmHostDispatch({
    invocationId: 'invocation-a',
    requestDigest: 'request-digest',
    runtimeTurnId: 'turn-a',
    sourceEventId: 'worker-started',
  });
}

describe('PostgreSQL-style cloud journal reference reducer', () => {
  it('atomically accepts user message, invocation, event, outbox and BUSY projection', () => {
    const cloud = createCloud();
    const invocation = accept(cloud);
    const snapshot = cloud.snapshot();
    expect(invocation.state).toBe('QUEUED');
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.outbox).toHaveLength(1);
    expect(snapshot.conversations.get('conversation-a')).toMatchObject({
      state: 'BUSY',
      activeInvocationId: 'invocation-a',
    });
  });

  it('coalesces same ID/same digest and conflicts same ID/different digest before WIP checks', () => {
    const cloud = createCloud();
    const first = accept(cloud);
    for (let index = 0; index < 100; index += 1) expect(accept(cloud)).toEqual(first);
    expect(() => accept(cloud, { requestDigest: 'different' })).toThrowError(
      expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }),
    );
    expect(cloud.snapshot().invocations).toHaveLength(1);
  });

  it('enforces conversation WIP=1', () => {
    const cloud = createCloud();
    accept(cloud);
    expect(() =>
      accept(cloud, {
        invocationId: 'invocation-b',
        userMessageId: 'user-message-b',
        clientMessageId: 'client-message-b',
        prepareCommandId: 'prepare-command-b',
        sourceEventId: 'api-accepted-b',
      }),
    ).toThrowError(expect.objectContaining({ code: 'CONVERSATION_BUSY' }));
  });

  it('rejects invocation, message and command primary-key collisions without overwriting facts', () => {
    const cloud = createCloud();
    accept(cloud);
    expect(() =>
      accept(cloud, {
        invocationId: 'invocation-a',
        conversationId: 'conversation-b',
        clientMessageId: 'client-message-b',
        userMessageId: 'user-message-b',
        prepareCommandId: 'prepare-command-b',
        sourceEventId: 'api-accepted-b',
      }),
    ).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    expect(() =>
      accept(cloud, {
        invocationId: 'invocation-b',
        conversationId: 'conversation-b',
        clientMessageId: 'client-message-b',
        userMessageId: 'user-message-a',
        prepareCommandId: 'prepare-command-b',
        sourceEventId: 'api-accepted-b',
      }),
    ).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    expect(() =>
      accept(cloud, {
        invocationId: 'invocation-b',
        conversationId: 'conversation-b',
        clientMessageId: 'client-message-b',
        userMessageId: 'user-message-b',
        prepareCommandId: 'prepare-command',
        sourceEventId: 'api-accepted-b',
      }),
    ).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    expect(cloud.snapshot().invocations).toHaveLength(1);
  });

  it('keeps conversation version immutable across create replays', () => {
    const cloud = createCloud();
    expect(() =>
      cloud.createConversation({ id: 'conversation-a', agentVersionId: 'version-b' }),
    ).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    expect(cloud.snapshot().conversations.get('conversation-a')?.agentVersionId).toBe('version-a');
  });

  it('rejects stale assignment fence before projection mutation', () => {
    const cloud = createCloud();
    accept(cloud);
    cloud.markDispatchPending('invocation-a', 'broker-dispatch');
    const before = cloud.snapshot();
    expect(() =>
      cloud.recordWorkerPersisted({
        invocationId: 'invocation-a',
        workerId: 'worker-a',
        lease: { ...LEASE, fence: '41' },
        sourceEventId: 'worker-prepared',
        payloadDigest: 'request-digest',
      }),
    ).toThrowError(expect.objectContaining({ code: 'STALE_FENCE' }));
    expect(cloud.snapshot()).toEqual(before);
  });

  it('replays the same dispatch event without incrementing send attempts twice', () => {
    const cloud = createCloud();
    accept(cloud);
    cloud.markDispatchPending('invocation-a', 'broker-dispatch');
    cloud.markDispatchPending('invocation-a', 'broker-dispatch');
    expect(cloud.snapshot().outbox[0]).toMatchObject({ state: 'SENT', attemptCount: 1 });
    expect(
      cloud.snapshot().events.filter((event) => event.eventType === 'invocation.dispatch_pending'),
    ).toHaveLength(1);
  });

  it('rejects a start command ID collision with an existing outbox command', () => {
    const cloud = createCloud();
    accept(cloud);
    cloud.markDispatchPending('invocation-a', 'broker-dispatch');
    cloud.recordWorkerPersisted({
      invocationId: 'invocation-a',
      workerId: 'worker-a',
      lease: LEASE,
      sourceEventId: 'worker-prepared',
      payloadDigest: 'request-digest',
    });
    expect(() =>
      cloud.requestStart({
        invocationId: 'invocation-a',
        commandId: 'prepare-command',
        sourceEventId: 'broker-start',
      }),
    ).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    expect(cloud.snapshot().invocations.get('invocation-a')?.state).toBe('PERSISTED');
  });

  it('commits final, terminal event, Assistant message and IDLE projection once', () => {
    const cloud = createCloud();
    advanceCloudToStarting(cloud);
    cloud.recordRunning({
      invocationId: 'invocation-a',
      workerId: 'worker-a',
      lease: LEASE,
      sourceEventId: 'worker-started',
      payloadDigest: 'turn-a',
    });
    const input = {
      invocationId: 'invocation-a',
      workerId: 'worker-a',
      lease: LEASE,
      sourceEventId: 'worker-final',
      resultMessageId: 'assistant-a',
      resultDigest: 'result-digest',
      executionCapabilityValid: true,
    };
    for (let index = 0; index < 100; index += 1) {
      expect(cloud.commitFinal(input).state).toBe('SUCCEEDED');
    }
    const snapshot = cloud.snapshot();
    expect(snapshot.messages.filter((message) => message.role === 'ASSISTANT')).toHaveLength(1);
    expect(
      snapshot.events.filter((event) => event.eventType === 'invocation.succeeded'),
    ).toHaveLength(1);
    expect(snapshot.conversations.get('conversation-a')).toMatchObject({ state: 'IDLE' });
  });

  it('permits an old assigned fence final only through its exact valid capability binding', () => {
    const cloud = createCloud();
    advanceCloudToStarting(cloud);
    cloud.recordRunning({
      invocationId: 'invocation-a',
      workerId: 'worker-a',
      lease: LEASE,
      sourceEventId: 'worker-started',
      payloadDigest: 'turn-a',
    });
    const final = {
      invocationId: 'invocation-a',
      workerId: 'worker-a',
      lease: LEASE,
      sourceEventId: 'worker-final',
      resultMessageId: 'assistant-a',
      resultDigest: 'result-digest',
    };
    expect(() => cloud.commitFinal({ ...final, executionCapabilityValid: false })).toThrowError(
      expect.objectContaining({ code: 'STALE_LEASE' }),
    );
    expect(() =>
      cloud.commitFinal({
        ...final,
        lease: { deploymentId: 'deployment-a', leaseId: 'lease-b', fence: '43' },
        executionCapabilityValid: true,
      }),
    ).toThrowError(expect.objectContaining({ code: 'STALE_LEASE' }));
    expect(cloud.commitFinal({ ...final, executionCapabilityValid: true }).state).toBe('SUCCEEDED');
  });

  it('security-blocks a replayed source event with changed body', () => {
    const cloud = createCloud();
    accept(cloud);
    cloud.markDispatchPending('invocation-a', 'broker-dispatch');
    cloud.recordWorkerPersisted({
      invocationId: 'invocation-a',
      workerId: 'worker-a',
      lease: LEASE,
      sourceEventId: 'worker-prepared',
      payloadDigest: 'request-digest',
    });
    expect(() =>
      cloud.recordWorkerPersisted({
        invocationId: 'invocation-a',
        workerId: 'worker-a',
        lease: LEASE,
        sourceEventId: 'worker-prepared',
        payloadDigest: 'changed',
      }),
    ).toThrowError(expect.objectContaining({ code: 'SOURCE_EVENT_CONFLICT' }));
  });

  it('keeps stable cloud journal error identity', () => {
    expect(() => accept(new InMemoryCloudJournal())).toThrowError(CloudJournalError);
  });
});

describe('SQLite-style worker journal reference reducer', () => {
  it('coalesces 100 identical prepare deliveries into one row and one outbox fact', () => {
    const worker = new InMemoryWorkerJournal();
    for (let index = 0; index < 100; index += 1) prepare(worker);
    const snapshot = worker.snapshot();
    expect(snapshot.invocations).toHaveLength(1);
    expect(snapshot.outbox).toHaveLength(1);
    expect(snapshot.activeInvocationId).toBe('invocation-a');
  });

  it('rejects same invocation with different digest and same client ID with another invocation', () => {
    const worker = new InMemoryWorkerJournal();
    prepare(worker);
    expect(() => prepare(worker, { requestDigest: 'changed' })).toThrowError(
      expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }),
    );
    expect(() =>
      prepare(worker, { invocationId: 'invocation-b', commandId: 'prepare-command-b' }),
    ).toThrowError(expect.objectContaining({ code: 'CLIENT_MESSAGE_CONFLICT' }));
  });

  it('rejects a prepare replay that changes the bound lease or fence', () => {
    const worker = new InMemoryWorkerJournal();
    prepare(worker);
    expect(() =>
      worker.prepare({
        invocationId: 'invocation-a',
        conversationId: 'conversation-a',
        clientMessageId: 'client-message-a',
        requestDigest: 'request-digest',
        agentVersionId: 'version-a',
        lease: { ...LEASE, fence: '43' },
        commandId: 'prepare-command',
        sourceEventId: 'worker-prepared',
      }),
    ).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
  });

  it('rejects a local source event ID collision across invocations', () => {
    const worker = new InMemoryWorkerJournal();
    advanceWorkerToRunning(worker);
    worker.writeFinal({
      invocationId: 'invocation-a',
      requestDigest: 'request-digest',
      resultDigest: 'result-digest',
      sourceEventId: 'worker-final',
    });
    worker.markCloudCommitted('invocation-a', 'worker-final');
    expect(() =>
      worker.prepare({
        invocationId: 'invocation-b',
        conversationId: 'conversation-b',
        clientMessageId: 'client-message-b',
        requestDigest: 'request-digest-b',
        agentVersionId: 'version-a',
        lease: LEASE,
        commandId: 'prepare-command-b',
        sourceEventId: 'worker-final',
      }),
    ).toThrowError(expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }));
    expect(worker.snapshot().invocations).toHaveLength(1);
  });

  it('enforces global WIP=1 across conversations', () => {
    const worker = new InMemoryWorkerJournal();
    prepare(worker);
    expect(() =>
      prepare(worker, {
        invocationId: 'invocation-b',
        conversationId: 'conversation-b',
        clientMessageId: 'client-message-b',
        commandId: 'prepare-command-b',
        sourceEventId: 'worker-prepared-b',
      }),
    ).toThrowError(expect.objectContaining({ code: 'WORKER_BUSY' }));
  });

  it('persists start intent once and never confirms a second Host turn', () => {
    const worker = new InMemoryWorkerJournal();
    prepare(worker);
    const start = {
      invocationId: 'invocation-a',
      requestDigest: 'request-digest',
      lease: LEASE,
      commandId: 'start-command',
    };
    worker.start(start);
    worker.start(start);
    const confirm = {
      invocationId: 'invocation-a',
      requestDigest: 'request-digest',
      runtimeTurnId: 'turn-a',
      sourceEventId: 'worker-started',
    };
    worker.confirmHostDispatch(confirm);
    worker.confirmHostDispatch(confirm);
    expect(worker.snapshot().invocations.get('invocation-a')).toMatchObject({
      hostDispatchIntentCount: 1,
      hostDispatchConfirmedCount: 1,
      state: 'RUNNING',
    });
    expect(() => worker.confirmHostDispatch({ ...confirm, runtimeTurnId: 'turn-b' })).toThrowError(
      expect.objectContaining({ code: 'HOST_DISPATCH_ALREADY_CONFIRMED' }),
    );
  });

  it('writes final before submit, replays exact outbox and releases WIP only after cloud ACK', () => {
    const worker = new InMemoryWorkerJournal();
    advanceWorkerToRunning(worker);
    const final = {
      invocationId: 'invocation-a',
      requestDigest: 'request-digest',
      resultDigest: 'result-digest',
      sourceEventId: 'worker-final',
    };
    worker.writeFinal(final);
    worker.writeFinal(final);
    expect(worker.snapshot()).toMatchObject({ activeInvocationId: 'invocation-a' });
    expect(
      worker.snapshot().outbox.filter((event) => event.eventType === 'invocation.succeeded'),
    ).toHaveLength(1);
    worker.markCloudCommitted('invocation-a', 'worker-final');
    expect(() => worker.markCloudCommitted('invocation-a', 'different-final')).toThrowError(
      expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }),
    );
    expect(worker.snapshot().activeInvocationId).toBeUndefined();
    expect(worker.snapshot().invocations.get('invocation-a')?.state).toBe('CLOUD_COMMITTED');
  });

  it('turns STARTING with lost evidence into UNCERTAIN and never reopens it', () => {
    const worker = new InMemoryWorkerJournal();
    prepare(worker);
    worker.start({
      invocationId: 'invocation-a',
      requestDigest: 'request-digest',
      lease: LEASE,
      commandId: 'start-command',
    });
    worker.markUncertain('invocation-a');
    expect(worker.snapshot().invocations.get('invocation-a')?.state).toBe('UNCERTAIN');
    expect(() =>
      worker.start({
        invocationId: 'invocation-a',
        requestDigest: 'request-digest',
        lease: LEASE,
        commandId: 'another-command',
      }),
    ).toThrowError(expect.objectContaining({ code: 'START_COMMAND_CONFLICT' }));
  });

  it('keeps stable worker journal error identity', () => {
    expect(() => new InMemoryWorkerJournal().markUncertain('missing')).toThrowError(
      WorkerJournalError,
    );
  });
});
