import { describe, expect, it, vi } from 'vitest';

import { createHostTurnTerminalEvidence } from '@cb/creator-agent-protocol';

import { HostTurnRegistry, type HostTurnHandleLike } from './host-composition.js';
import type { DurableInboundCommandCandidate } from './sqlite-durable-transport.js';
import type {
  DurableReadyConversation,
  LocalInvocationResultCiphertext,
  OpaqueHostDispatchPermit,
  OpaqueHostInterruptPermit,
  ReadyConversationExpectedBinding,
} from './sqlite-invocation-journal.js';
import { WorkerInvocationJournalError } from './sqlite-invocation-journal.js';
import {
  WorkerCommandPump,
  type WorkerCommandPumpJournalPort,
  type WorkerCommandPumpTransportPort,
} from './worker-command-pump.js';
import type { DurableBrokerConnection } from './worker-broker-client.js';

const INSTALLATION_ID = uuid(1);
const CONNECTION_ID = uuid(2);
const WORKER_SESSION_ID = uuid(3);
const DEPLOYMENT_ID = uuid(4);
const LEASE_ID = uuid(5);
const OWNER_TOKEN = 'worker-command-pump-owner-0123456789';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const RESULT_KEY_ID = 'broker-result-key-1';

describe('WorkerCommandPump', () => {
  it('requires one process-start recovery and coalesces repeated recovery calls', async () => {
    const fixture = createPump();
    await expect(fixture.pump.tick(signal())).resolves.toMatchObject({
      status: 'BLOCKED',
      blockReason: 'PROCESS_RECOVERY_REQUIRED',
    });

    await expect(fixture.pump.recoverAfterProcessStart(signal())).resolves.toEqual({
      recoveredHostActions: 0,
      readyConversationsNeedingReattach: 0,
    });
    await expect(fixture.pump.recoverAfterProcessStart(signal())).resolves.toEqual({
      recoveredHostActions: 0,
      readyConversationsNeedingReattach: 0,
    });
    expect(fixture.journal.recoverHostActionsAfterProcessStart).toHaveBeenCalledTimes(1);
    await expect(fixture.pump.tick(signal())).resolves.toMatchObject({ status: 'IDLE' });
    await expect(fixture.pump.drainEvidence(signal())).resolves.toMatchObject({ status: 'IDLE' });
    expect(fixture.broker.flush).not.toHaveBeenCalled();
  });

  it('waits without reading commands when this owner has no active connection', async () => {
    const fixture = createPump({ connection: null });
    await fixture.pump.recoverAfterProcessStart(signal());
    await expect(fixture.pump.tick(signal())).resolves.toEqual({
      status: 'WAITING',
      commands: 0,
      facts: 0,
      cloudAcks: 0,
      waitReason: 'NO_ACTIVE_CONNECTION',
    });
    expect(fixture.transport.readPendingCommands).not.toHaveBeenCalled();
  });

  it('never claims readiness after restart when durable READY needs Host reattachment', async () => {
    const fixture = createPump({
      journalOverrides: {
        countReadyConversationsAfterProcessStart: vi.fn(async () => 1),
      },
    });
    await expect(fixture.pump.recoverAfterProcessStart(signal())).resolves.toEqual({
      recoveredHostActions: 0,
      readyConversationsNeedingReattach: 1,
    });
    await expect(fixture.pump.tick(signal())).resolves.toMatchObject({
      status: 'BLOCKED',
      blockReason: 'READY_HOST_BINDING_MISSING',
    });
    expect(fixture.transport.readPendingCommands).not.toHaveBeenCalled();
  });

  it('provisions conversation.open in two phases and exact-binds the durable Host thread', async () => {
    const expected = readyExpected(20);
    const command = candidate('conversation.open', expected.openCommandId);
    const thread = {
      id: 'host-thread-open-1',
      generation: 7,
      workspaceRootsAcknowledged: true,
    } as const;
    const ready = durableReady(expected, thread.id, uuid(21));
    const fixture = createPump({
      candidates: [command],
      journalOverrides: {
        authorizeConversationOpen: vi.fn(async () => ({ action: 'PROVISION', expected }) as const),
        bindReadyConversation: vi.fn(async () => ready),
      },
      provision: vi.fn(async () => ({
        thread,
        sandboxInstanceId: ready.sandboxInstanceId,
        readyEvidence: { token: 'opaque-ready-evidence' },
      })),
    });
    await fixture.pump.recoverAfterProcessStart(signal());

    await expect(fixture.pump.tick(signal())).resolves.toMatchObject({
      status: 'PROGRESSED',
      commands: 1,
    });
    expect(fixture.registry.threadFor(expected.conversationId)).toEqual(thread);
    expect(fixture.provision).toHaveBeenCalledWith(expected, expect.any(AbortSignal));
    expect(fixture.journal.bindReadyConversation).toHaveBeenCalledWith(
      expect.objectContaining({ command, ownerToken: OWNER_TOKEN }),
    );
  });

  it('blocks a durable READY replay when its process-generation Host binding is absent', async () => {
    const expected = readyExpected(30);
    const command = candidate('conversation.open', expected.openCommandId);
    const ready = durableReady(expected, 'lost-host-thread', uuid(31));
    const fixture = createPump({
      candidates: [command],
      journalOverrides: {
        authorizeConversationOpen: vi.fn(
          async () => ({ action: 'RETURN_READY', conversation: ready }) as const,
        ),
      },
    });
    await fixture.pump.recoverAfterProcessStart(signal());

    await expect(fixture.pump.tick(signal())).resolves.toMatchObject({
      status: 'BLOCKED',
      blockReason: 'READY_HOST_BINDING_MISSING',
      blockedCommandType: 'conversation.open',
    });
    expect(fixture.provision).not.toHaveBeenCalled();
  });

  it('identity-rolls back a definitely uncommitted open provision and retries cleanly', async () => {
    const expected = readyExpected(35);
    const command = candidate('conversation.open', expected.openCommandId);
    const firstThread = {
      id: 'host-thread-open-rollback-1',
      generation: 8,
      workspaceRootsAcknowledged: true,
    } as const;
    const secondThread = {
      id: 'host-thread-open-rollback-2',
      generation: 8,
      workspaceRootsAcknowledged: true,
    } as const;
    let provisionCount = 0;
    const provision = vi.fn(async () => {
      provisionCount += 1;
      const thread = provisionCount === 1 ? firstThread : secondThread;
      return { thread, sandboxInstanceId: uuid(36 + provisionCount), readyEvidence: { thread } };
    });
    const releaseProvision = vi.fn(async () => undefined);
    let bindCount = 0;
    const bindReadyConversation = vi.fn(async () => {
      bindCount += 1;
      if (bindCount === 1) throw new WorkerInvocationJournalError('JOURNAL_CAPACITY');
      return durableReady(expected, secondThread.id, uuid(38));
    });
    const fixture = createPump({
      candidates: [command],
      provision,
      releaseProvision,
      journalOverrides: {
        authorizeConversationOpen: vi.fn(async () => ({ action: 'PROVISION', expected }) as const),
        bindReadyConversation,
      },
    });
    await fixture.pump.recoverAfterProcessStart(signal());
    await expect(fixture.pump.tick(signal())).resolves.toMatchObject({
      status: 'WAITING',
      waitReason: 'CAPACITY_BACKPRESSURE',
    });
    expect(fixture.registry.threadFor(expected.conversationId)).toBeUndefined();
    expect(releaseProvision).toHaveBeenCalledTimes(1);

    await expect(fixture.pump.tick(signal())).resolves.toMatchObject({
      status: 'PROGRESSED',
      commands: 1,
    });
    expect(fixture.registry.threadFor(expected.conversationId)).toEqual(secondThread);
  });

  it('retains and resumes the exact open provision after an ambiguous bind response loss', async () => {
    const expected = readyExpected(39);
    const command = candidate('conversation.open', expected.openCommandId);
    const thread = {
      id: 'host-thread-open-response-loss',
      generation: 10,
      workspaceRootsAcknowledged: true,
    } as const;
    const provisioned = {
      thread,
      sandboxInstanceId: uuid(40),
      readyEvidence: { token: 'stable-provision-evidence' },
    };
    const provision = vi.fn(async () => provisioned);
    const resumeProvision = vi.fn(async () => provisioned);
    let bindCount = 0;
    const fixture = createPump({
      candidates: [command],
      provision,
      resumeProvision,
      journalOverrides: {
        authorizeConversationOpen: vi.fn(async () => ({ action: 'PROVISION', expected }) as const),
        bindReadyConversation: vi.fn(async () => {
          bindCount += 1;
          if (bindCount === 1) throw new Error('ambiguous-after-commit-boundary');
          return durableReady(expected, thread.id, provisioned.sandboxInstanceId);
        }),
      },
    });
    await fixture.pump.recoverAfterProcessStart(signal());
    await expect(fixture.pump.tick(signal())).resolves.toMatchObject({
      status: 'BLOCKED',
      blockReason: 'COMMAND_REJECTED',
    });
    expect(fixture.registry.threadFor(expected.conversationId)).toEqual(thread);
    expect(fixture.releaseProvision).not.toHaveBeenCalled();

    await expect(fixture.pump.tick(signal())).resolves.toMatchObject({
      status: 'PROGRESSED',
      commands: 1,
    });
    expect(provision).toHaveBeenCalledTimes(1);
    expect(resumeProvision).toHaveBeenCalledTimes(1);
  });

  it('dispatches once, serializes the Host terminal, seals once, and unregisters after commit', async () => {
    const conversationId = uuid(40);
    const startCommandId = uuid(41);
    const permit = hostPermit(42, conversationId, startCommandId, 'host-thread-running');
    const command = candidate('invocation.start', startCommandId);
    const registry = new HostTurnRegistry();
    const thread = {
      id: permit.runtimeThreadId,
      generation: 2,
      workspaceRootsAcknowledged: true,
    } as const;
    registry.bindThread(conversationId, thread);
    const sealed = { token: 'sealed-once' } as unknown as LocalInvocationResultCiphertext;
    const sealer = { seal: vi.fn(() => sealed) };
    const writeSucceeded = vi.fn(async () => ({
      sourceEventId: permit.invocationId,
      factDigest: DIGEST,
    }));
    const fixture = createPump({
      registry,
      candidates: [command],
      sealer,
      journalOverrides: {
        start: vi.fn(async () => ({ action: 'DISPATCH_ONCE', permit }) as const),
        dispatchOnce: vi.fn(async () => {
          registry.register({
            permit,
            thread,
            turnId: 'turn-success-1',
            handle: successfulHandle(thread.id, 'turn-success-1', 'durable answer'),
          });
          return {
            sourceEventId: startCommandId,
            factDigest: DIGEST,
            runtimeTurnId: 'turn-success-1',
          };
        }),
        writeSucceeded,
      },
    });
    await fixture.pump.recoverAfterProcessStart(signal());

    await expect(fixture.pump.tick(signal())).resolves.toMatchObject({ commands: 1 });
    await fixture.pump.waitForTerminalObservers();
    expect(fixture.journal.dispatchOnce).toHaveBeenCalledTimes(1);
    expect(sealer.seal).toHaveBeenCalledTimes(1);
    expect(writeSucceeded).toHaveBeenCalledWith(
      expect.objectContaining({
        invocationId: permit.invocationId,
        dispatchNonce: permit.dispatchNonce,
        sourceEventId: permit.invocationId,
        resultCiphertext: sealed,
      }),
    );
    expect(registry.bindingForInvocation(permit.invocationId)).toBeUndefined();
  });

  it('lets the interrupt path own CANCELLED while a terminal observer is waiting', async () => {
    const conversationId = uuid(50);
    const startCommandId = uuid(51);
    const cancelCommandId = uuid(52);
    const permit = hostPermit(53, conversationId, startCommandId, 'host-thread-cancel');
    const interruptPermit = hostInterruptPermit(permit, cancelCommandId, 'turn-cancel-1');
    const registry = new HostTurnRegistry();
    const thread = {
      id: permit.runtimeThreadId,
      generation: 3,
      workspaceRootsAcknowledged: true,
    } as const;
    registry.bindThread(conversationId, thread);
    let resolveTerminal!: (value: ReturnType<typeof cancelledEvidence>) => void;
    const terminal = new Promise<ReturnType<typeof cancelledEvidence>>((resolve) => {
      resolveTerminal = resolve;
    });
    const handle: HostTurnHandleLike = {
      turnId: Promise.resolve(interruptPermit.runtimeTurnId),
      result: new Promise(() => undefined),
      terminal,
      interrupt: async () => {
        throw new Error('journal owns interrupt');
      },
    };
    registry.register({ permit, thread, turnId: interruptPermit.runtimeTurnId, handle });

    let candidates: DurableInboundCommandCandidate[] = [
      candidate('invocation.start', startCommandId),
    ];
    const interruptOnce = vi.fn(async () => {
      resolveTerminal(cancelledEvidence(thread.id, interruptPermit.runtimeTurnId));
      await Promise.resolve();
      return {
        action: 'CANCELLED',
        sourceEventId: permit.invocationId,
        factDigest: DIGEST,
        interruptReceiptDigest: DIGEST,
        replayed: false,
      } as const;
    });
    const markHostEvidenceLost = vi.fn(async () => ({
      sourceEventId: permit.invocationId,
      factDigest: DIGEST,
    }));
    const fixture = createPump({
      registry,
      candidates: () => candidates,
      journalOverrides: {
        start: vi.fn(async () => ({ action: 'RETURN_IN_PROGRESS', state: 'RUNNING' }) as const),
        cancel: vi.fn(async () => ({ action: 'INTERRUPT_ONCE', permit: interruptPermit }) as const),
        interruptOnce,
        markHostEvidenceLost,
      },
    });
    await fixture.pump.recoverAfterProcessStart(signal());
    await fixture.pump.tick(signal());
    expect(fixture.pump.activeTerminalObservers).toBe(1);

    candidates = [candidate('invocation.cancel', cancelCommandId)];
    await fixture.pump.tick(signal());
    await fixture.pump.waitForTerminalObservers();
    expect(interruptOnce).toHaveBeenCalledTimes(1);
    expect(markHostEvidenceLost).not.toHaveBeenCalled();
    expect(registry.bindingForInvocation(permit.invocationId)).toBeUndefined();
  });

  it('keeps an unsupported ordered command PERSISTED while still draining prior facts', async () => {
    const unsupported = candidate('deployment.drain', uuid(60));
    const later = candidate('invocation.prepare', uuid(61));
    const pendingFact = {
      sourceEventId: uuid(62),
      invocationId: uuid(63),
      eventType: 'invocation.failed' as const,
      correlationId: uuid(63),
      factDigest: DIGEST,
    };
    const enqueuePendingFact = vi.fn(async (input) => ({
      deliveryMessageId: input.deliveryMessageId,
      sourceEventId: pendingFact.sourceEventId,
      invocationId: pendingFact.invocationId,
      eventType: pendingFact.eventType,
      connectionId: CONNECTION_ID,
      sequence: '1',
      canonicalDigest: DIGEST,
      factDigest: DIGEST,
    }));
    const prepare = vi.fn();
    const fixture = createPump({
      candidates: [unsupported, later],
      journalOverrides: {
        prepare,
        readPendingFacts: vi.fn(async () => [pendingFact]),
        enqueuePendingFact,
      },
    });
    await fixture.pump.recoverAfterProcessStart(signal());

    await expect(fixture.pump.tick(signal())).resolves.toMatchObject({
      status: 'BLOCKED',
      commands: 0,
      facts: 1,
      blockReason: 'UNSUPPORTED_COMMAND',
      blockedCommandType: 'deployment.drain',
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(enqueuePendingFact).toHaveBeenCalledTimes(1);
    expect(fixture.broker.flush).toHaveBeenCalledTimes(1);
  });

  it('commits trusted Cloud ACK evidence first and uses the current session result key', async () => {
    const ack = {
      connectionId: CONNECTION_ID,
      sequence: '8',
      messageId: uuid(70),
      canonicalDigest: DIGEST,
      acknowledgedDeliveryMessageId: uuid(71),
    };
    const fact = {
      sourceEventId: uuid(72),
      invocationId: uuid(73),
      eventType: 'invocation.succeeded' as const,
      correlationId: uuid(73),
      factDigest: DIGEST,
    };
    const order: string[] = [];
    const markCloudCommitted = vi.fn(async () => {
      order.push('ack');
    });
    const enqueuePendingFact = vi.fn(async (input) => {
      order.push('fact');
      expect(input.brokerKeyId).toBe(RESULT_KEY_ID);
      return {
        deliveryMessageId: input.deliveryMessageId,
        sourceEventId: fact.sourceEventId,
        invocationId: fact.invocationId,
        eventType: fact.eventType,
        connectionId: CONNECTION_ID,
        sequence: '9',
        canonicalDigest: DIGEST,
        factDigest: DIGEST,
      };
    });
    const fixture = createPump({
      journalOverrides: {
        readPendingCloudAcks: vi.fn(async () => [ack]),
        markCloudCommitted,
        readPendingFacts: vi.fn(async () => [fact]),
        enqueuePendingFact,
      },
    });
    await fixture.pump.recoverAfterProcessStart(signal());

    await expect(fixture.pump.tick(signal())).resolves.toMatchObject({
      status: 'PROGRESSED',
      cloudAcks: 1,
      facts: 1,
    });
    expect(order).toEqual(['ack', 'fact']);
    expect(fixture.cloudAckEvidence.evidenceFor).toHaveBeenCalledWith(ack, expect.any(AbortSignal));
    expect(fixture.resultKey.currentResultKey).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: CONNECTION_ID,
        workerSessionId: WORKER_SESSION_ID,
      }),
    );
  });

  it('flushes earlier durable facts even when a later succeeded fact has no result key', async () => {
    const ready = {
      sourceEventId: uuid(75),
      conversationId: uuid(76),
      correlationId: uuid(76),
      factDigest: DIGEST,
    };
    const succeeded = {
      sourceEventId: uuid(77),
      invocationId: uuid(78),
      eventType: 'invocation.succeeded' as const,
      correlationId: uuid(78),
      factDigest: DIGEST,
    };
    const fixture = createPump({
      journalOverrides: {
        readPendingConversationReadyFacts: vi.fn(async () => [ready]),
        readPendingFacts: vi.fn(async () => [succeeded]),
      },
    });
    fixture.resultKey.currentResultKey.mockResolvedValue({ keyId: '' });
    await fixture.pump.recoverAfterProcessStart(signal());

    await expect(fixture.pump.tick(signal())).resolves.toMatchObject({
      status: 'BLOCKED',
      blockReason: 'RESULT_KEY_UNAVAILABLE',
    });
    expect(fixture.journal.enqueuePendingConversationReadyFact).toHaveBeenCalledTimes(1);
    expect(fixture.broker.flush).toHaveBeenCalledTimes(1);
  });

  it('arbitrates an exact Host terminal against a cancel-won durable UNCERTAIN state', async () => {
    const conversationId = uuid(79);
    const startCommandId = uuid(80);
    const permit = hostPermit(81, conversationId, startCommandId, 'host-thread-arbitrated');
    const registry = new HostTurnRegistry();
    const thread = {
      id: permit.runtimeThreadId,
      generation: 9,
      workspaceRootsAcknowledged: true,
    } as const;
    registry.bindThread(conversationId, thread);
    const fixture = createPump({
      registry,
      candidates: [candidate('invocation.start', startCommandId)],
      journalOverrides: {
        start: vi.fn(async () => ({ action: 'DISPATCH_ONCE', permit }) as const),
        dispatchOnce: vi.fn(async () => {
          registry.register({
            permit,
            thread,
            turnId: 'turn-arbitrated',
            handle: successfulHandle(thread.id, 'turn-arbitrated', 'late exact result'),
          });
          return {
            sourceEventId: startCommandId,
            factDigest: DIGEST,
            runtimeTurnId: 'turn-arbitrated',
          };
        }),
        writeSucceeded: vi.fn(async () => {
          throw new WorkerInvocationJournalError('ILLEGAL_LOCAL_TRANSITION');
        }),
        readTerminalDisposition: vi.fn(async () => ({ state: 'UNCERTAIN', terminal: true })),
      },
    });
    await fixture.pump.recoverAfterProcessStart(signal());
    await fixture.pump.tick(signal());
    await fixture.pump.waitForTerminalObservers();
    expect(registry.bindingForInvocation(permit.invocationId)).toBeUndefined();
    await expect(fixture.pump.tick(signal())).resolves.not.toMatchObject({
      blockReason: 'TERMINAL_COMMIT_REJECTED',
    });
  });

  it('retains the live Host binding and blocks after a terminal durable commit failure', async () => {
    const conversationId = uuid(80);
    const startCommandId = uuid(81);
    const permit = hostPermit(82, conversationId, startCommandId, 'host-thread-failed-commit');
    const registry = new HostTurnRegistry();
    const thread = {
      id: permit.runtimeThreadId,
      generation: 4,
      workspaceRootsAcknowledged: true,
    } as const;
    registry.bindThread(conversationId, thread);
    const fixture = createPump({
      registry,
      candidates: [candidate('invocation.start', startCommandId)],
      journalOverrides: {
        start: vi.fn(async () => ({ action: 'DISPATCH_ONCE', permit }) as const),
        dispatchOnce: vi.fn(async () => {
          registry.register({
            permit,
            thread,
            turnId: 'turn-terminal-commit-fails',
            handle: successfulHandle(thread.id, 'turn-terminal-commit-fails', 'answer retained'),
          });
          return {
            sourceEventId: startCommandId,
            factDigest: DIGEST,
            runtimeTurnId: 'turn-terminal-commit-fails',
          };
        }),
        writeSucceeded: vi.fn(async () => {
          throw new Error('durable-commit-rejected');
        }),
      },
    });
    await fixture.pump.recoverAfterProcessStart(signal());
    await fixture.pump.tick(signal());
    await expect(fixture.pump.waitForTerminalObservers()).rejects.toThrow(
      'durable-commit-rejected',
    );
    expect(registry.bindingForInvocation(permit.invocationId)).toBeDefined();
    await expect(fixture.pump.tick(signal())).resolves.toMatchObject({
      status: 'BLOCKED',
      blockReason: 'TERMINAL_COMMIT_REJECTED',
    });
  });
});

type PumpFixtureOptions = Readonly<{
  connection?: DurableBrokerConnection | null;
  candidates?:
    | readonly DurableInboundCommandCandidate[]
    | (() => readonly DurableInboundCommandCandidate[]);
  journalOverrides?: Partial<WorkerCommandPumpJournalPort>;
  registry?: HostTurnRegistry;
  provision?: ReturnType<typeof vi.fn>;
  resumeProvision?: ReturnType<typeof vi.fn>;
  releaseProvision?: ReturnType<typeof vi.fn>;
  sealer?: { seal: ReturnType<typeof vi.fn> };
}>;

function createPump(options: PumpFixtureOptions = {}) {
  const connection = options.connection === undefined ? activeConnection() : options.connection;
  const readCandidates = options.candidates ?? [];
  const transport: WorkerCommandPumpTransportPort = {
    loadOwnedActiveConnection: vi.fn(async () => connection),
    readPendingCommands: vi.fn(async () =>
      typeof readCandidates === 'function' ? readCandidates() : readCandidates,
    ),
  };
  const journal = fakeJournal(options.journalOverrides);
  const registry = options.registry ?? new HostTurnRegistry();
  const broker = { flush: vi.fn(async () => undefined) };
  const provision =
    options.provision ??
    vi.fn(async () => {
      throw new Error('unexpected-provision');
    });
  const resumeProvision =
    options.resumeProvision ??
    vi.fn(async () => {
      throw new Error('unexpected-resume-provision');
    });
  const releaseProvision = options.releaseProvision ?? vi.fn(async () => undefined);
  const resultKey = {
    currentResultKey: vi.fn(async () => ({ keyId: RESULT_KEY_ID })),
  };
  const cloudAckEvidence = {
    evidenceFor: vi.fn(async () => ({ token: 'trusted-cloud-ack' })),
  };
  const sealer =
    options.sealer ??
    ({
      seal: vi.fn(() => ({ token: 'sealed-result' }) as unknown as LocalInvocationResultCiphertext),
    } as const);
  let deliverySequence = 90;
  const pump = new WorkerCommandPump({
    installationId: INSTALLATION_ID,
    ownerToken: OWNER_TOKEN,
    transport,
    journal,
    broker,
    registry,
    conversationRuntime: {
      provision,
      verifyReady: vi.fn(async () => undefined),
      resumeProvision,
      releaseProvision,
    },
    resultSealer: sealer,
    resultKey,
    cloudAckEvidence,
    deliveryMessageIdFactory: () => uuid((deliverySequence += 1)),
  });
  return {
    pump,
    transport,
    journal: journal as WorkerCommandPumpJournalPort & Record<string, ReturnType<typeof vi.fn>>,
    registry,
    broker,
    provision,
    resumeProvision,
    releaseProvision,
    resultKey,
    cloudAckEvidence,
  };
}

function fakeJournal(
  overrides: Partial<WorkerCommandPumpJournalPort> = {},
): WorkerCommandPumpJournalPort {
  const defaults: WorkerCommandPumpJournalPort = {
    authorizeConversationOpen: vi.fn(async () => {
      throw new Error('unexpected-open');
    }),
    bindReadyConversation: vi.fn(async () => {
      throw new Error('unexpected-bind');
    }),
    prepare: vi.fn(async () => ({
      invocationId: uuid(100),
      conversationId: uuid(101),
      prepareCommandId: uuid(102),
      sourceEventId: uuid(102),
      factDigest: DIGEST,
      state: 'PREPARED' as const,
    })),
    start: vi.fn(async () => ({ action: 'RETURN_IN_PROGRESS', state: 'FINAL_READY' }) as const),
    dispatchOnce: vi.fn(async () => ({
      sourceEventId: uuid(103),
      factDigest: DIGEST,
      runtimeTurnId: 'turn-default',
    })),
    cancel: vi.fn(async () => ({ action: 'RETURN_TERMINAL', state: 'FINAL_READY' }) as const),
    interruptOnce: vi.fn(
      async () =>
        ({
          action: 'CANCELLED',
          sourceEventId: uuid(104),
          factDigest: DIGEST,
          interruptReceiptDigest: DIGEST,
          replayed: false,
        }) as const,
    ),
    recoverHostActionsAfterProcessStart: vi.fn(async () => []),
    countReadyConversationsAfterProcessStart: vi.fn(async () => 0),
    writeSucceeded: vi.fn(async (input) => ({
      sourceEventId: input.sourceEventId,
      factDigest: DIGEST,
    })),
    writeFailed: vi.fn(async (input) => ({
      sourceEventId: input.sourceEventId,
      factDigest: DIGEST,
    })),
    markHostEvidenceLost: vi.fn(async (input) => ({
      sourceEventId: input.sourceEventId,
      factDigest: DIGEST,
    })),
    readTerminalDisposition: vi.fn(async () => ({ state: 'RUNNING', terminal: false })),
    readPendingConversationReadyFacts: vi.fn(async () => []),
    enqueuePendingConversationReadyFact: vi.fn(async (input) => ({
      deliveryMessageId: input.deliveryMessageId,
      sourceEventId: input.reference.sourceEventId,
      conversationId: input.reference.conversationId,
      connectionId: input.connectionId,
      sequence: '1',
      canonicalDigest: DIGEST,
      factDigest: input.reference.factDigest,
    })),
    readPendingFacts: vi.fn(async () => []),
    enqueuePendingFact: vi.fn(async (input) => ({
      deliveryMessageId: input.deliveryMessageId,
      sourceEventId: input.reference.sourceEventId,
      invocationId: input.reference.invocationId,
      eventType: input.reference.eventType,
      connectionId: input.connectionId,
      sequence: '1',
      canonicalDigest: DIGEST,
      factDigest: input.reference.factDigest,
    })),
    readPendingCloudAcks: vi.fn(async () => []),
    markCloudCommitted: vi.fn(async () => undefined),
  };
  return Object.assign(defaults, overrides);
}

function activeConnection(): DurableBrokerConnection {
  return Object.freeze({
    installationId: INSTALLATION_ID,
    connectionId: CONNECTION_ID,
    workerSessionId: WORKER_SESSION_ID,
    lease: {
      deploymentId: DEPLOYMENT_ID,
      workerSessionId: WORKER_SESSION_ID,
      leaseId: LEASE_ID,
      fence: '1',
    },
    leaseState: 'ACTIVE',
    leaseGrantedAt: '2026-08-20T00:00:00.000Z',
    leaseExpiresAt: '2026-08-20T01:00:00.000Z',
    inboundCursor: '0',
    outboundCursor: '0',
  });
}

function candidate(
  type: DurableInboundCommandCandidate['type'],
  messageId: string,
): DurableInboundCommandCandidate {
  return Object.freeze({
    connectionId: CONNECTION_ID,
    sequence: '1',
    messageId,
    type,
    canonicalDigest: DIGEST,
    effectState: 'PERSISTED',
  });
}

function readyExpected(seed: number): ReadyConversationExpectedBinding {
  return Object.freeze({
    installationId: INSTALLATION_ID,
    deploymentId: DEPLOYMENT_ID,
    leaseId: LEASE_ID,
    workerSessionId: WORKER_SESSION_ID,
    fence: '1',
    conversationId: uuid(seed),
    agentVersionId: uuid(seed + 1),
    agentVersionDigest: DIGEST,
    snapshotDigest: DIGEST,
    openCommandId: uuid(seed + 2),
  });
}

function durableReady(
  expected: ReadyConversationExpectedBinding,
  runtimeThreadId: string,
  sandboxInstanceId: string,
): DurableReadyConversation {
  return Object.freeze({
    ...expected,
    sandboxInstanceId,
    runtimeThreadId,
    readyEvidenceDigest: DIGEST,
    sourceEventId: expected.openCommandId,
    factDigest: DIGEST,
    cloudState: 'PENDING',
  });
}

function hostPermit(
  seed: number,
  conversationId: string,
  startCommandId: string,
  runtimeThreadId: string,
): OpaqueHostDispatchPermit {
  return Object.freeze({
    installationId: INSTALLATION_ID,
    deploymentId: DEPLOYMENT_ID,
    leaseId: LEASE_ID,
    workerSessionId: WORKER_SESSION_ID,
    fence: '1',
    invocationId: uuid(seed),
    conversationId,
    startCommandId,
    dispatchNonce: uuid(seed + 1),
    agentVersionId: uuid(seed + 2),
    agentVersionDigest: DIGEST,
    snapshotDigest: DIGEST,
    requestDigest: 'hmac-sha256:' + 'b'.repeat(64),
    executionCapabilityDigest: DIGEST,
    deadlineAt: '2026-08-20T01:00:00.000Z',
    sandboxInstanceId: uuid(seed + 3),
    runtimeThreadId,
  });
}

function hostInterruptPermit(
  permit: OpaqueHostDispatchPermit,
  cancelCommandId: string,
  runtimeTurnId: string,
): OpaqueHostInterruptPermit {
  return Object.freeze({
    invocationId: permit.invocationId,
    conversationId: permit.conversationId,
    cancelCommandId,
    cancelReason: 'CONSUMER_REQUEST',
    interruptNonce: uuid(200),
    startCommandId: permit.startCommandId,
    dispatchNonce: permit.dispatchNonce,
    runtimeThreadId: permit.runtimeThreadId,
    runtimeTurnId,
    dispatchReceiptDigest: DIGEST,
    sandboxInstanceId: permit.sandboxInstanceId,
    sandboxAttestationDigest: DIGEST,
  });
}

function successfulHandle(threadId: string, turnId: string, text: string): HostTurnHandleLike {
  return Object.freeze({
    turnId: Promise.resolve(turnId),
    result: Promise.resolve({ text }),
    terminal: Promise.resolve(
      createHostTurnTerminalEvidence({
        threadId,
        turnId,
        outcome: 'SUCCEEDED',
        errorCode: null,
        terminalStatus: 'completed',
        terminalError: 'NONE',
        outputState: 'USABLE',
        completedAt: 1,
      }),
    ),
    interrupt: async () => {
      throw new Error('unexpected-interrupt');
    },
  });
}

function cancelledEvidence(threadId = 'thread-cancel', turnId = 'turn-cancel') {
  return createHostTurnTerminalEvidence({
    threadId,
    turnId,
    outcome: 'CANCELLED',
    errorCode: null,
    terminalStatus: 'interrupted',
    terminalError: 'NONE',
    outputState: 'NOT_APPLICABLE',
    completedAt: 2,
  });
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function uuid(seed: number): string {
  return `00000000-0000-7000-8000-${seed.toString(16).padStart(12, '0')}`;
}
