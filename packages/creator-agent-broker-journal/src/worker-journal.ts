import { parseFence, type LeaseBinding } from './protocol.js';

export const LOCAL_INVOCATION_STATES = [
  'RECEIVED',
  'PREPARED',
  'STARTING',
  'RUNNING',
  'FINAL_READY',
  'CLOUD_COMMITTED',
  'FAILED',
  'CANCELLED',
  'UNCERTAIN',
] as const;

export type LocalInvocationState = (typeof LOCAL_INVOCATION_STATES)[number];

const LOCAL_TERMINAL = new Set<LocalInvocationState>([
  'CLOUD_COMMITTED',
  'FAILED',
  'CANCELLED',
  'UNCERTAIN',
]);

export interface LocalInvocation {
  readonly invocationId: string;
  readonly conversationId: string;
  readonly clientMessageId: string;
  readonly requestDigest: string;
  readonly agentVersionId: string;
  readonly leaseId: string;
  readonly fence: bigint;
  readonly prepareCommandId: string;
  state: LocalInvocationState;
  startCommandId?: string;
  runtimeTurnId?: string;
  resultDigest?: string;
  resultSourceEventId?: string;
  hostDispatchIntentCount: number;
  hostDispatchConfirmedCount: number;
}

export interface LocalOutboxRecord {
  readonly sourceEventId: string;
  readonly invocationId: string;
  readonly eventType: 'invocation.prepared' | 'invocation.started' | 'invocation.succeeded';
  readonly payloadDigest: string;
  state: 'PENDING' | 'CLOUD_COMMITTED';
  attemptCount: number;
}

export interface WorkerJournalSnapshot {
  readonly invocations: ReadonlyMap<string, LocalInvocation>;
  readonly outbox: readonly LocalOutboxRecord[];
  readonly activeInvocationId?: string;
}

export type WorkerJournalErrorCode =
  | 'IDEMPOTENCY_CONFLICT'
  | 'CLIENT_MESSAGE_CONFLICT'
  | 'WORKER_BUSY'
  | 'INVOCATION_NOT_FOUND'
  | 'STALE_LEASE'
  | 'STALE_FENCE'
  | 'ILLEGAL_LOCAL_TRANSITION'
  | 'START_COMMAND_CONFLICT'
  | 'HOST_DISPATCH_ALREADY_CONFIRMED'
  | 'FINAL_CONFLICT'
  | 'OUTBOX_NOT_FOUND';

export class WorkerJournalError extends Error {
  constructor(readonly code: WorkerJournalErrorCode) {
    super(code);
    this.name = 'WorkerJournalError';
  }
}

export interface WorkerJournalTransactionPort {
  prepare(input: {
    invocationId: string;
    conversationId: string;
    clientMessageId: string;
    requestDigest: string;
    agentVersionId: string;
    lease: LeaseBinding;
    commandId: string;
    sourceEventId: string;
  }): LocalInvocation;
  start(input: {
    invocationId: string;
    requestDigest: string;
    lease: LeaseBinding;
    commandId: string;
  }): LocalInvocation;
  confirmHostDispatch(input: {
    invocationId: string;
    requestDigest: string;
    runtimeTurnId: string;
    sourceEventId: string;
  }): LocalInvocation;
  writeFinal(input: {
    invocationId: string;
    requestDigest: string;
    resultDigest: string;
    sourceEventId: string;
  }): LocalInvocation;
  markCloudCommitted(invocationId: string, sourceEventId: string): LocalInvocation;
  markUncertain(invocationId: string): LocalInvocation;
  snapshot(): WorkerJournalSnapshot;
}

/**
 * SQLite-style reference reducer. Atomic clone-and-swap represents a SQLite
 * transaction, but this memory adapter does not prove WAL, FULL fsync or file modes.
 */
export class InMemoryWorkerJournal implements WorkerJournalTransactionPort {
  private invocations = new Map<string, LocalInvocation>();
  private outbox: LocalOutboxRecord[] = [];
  private activeInvocationId?: string;

  prepare(input: {
    invocationId: string;
    conversationId: string;
    clientMessageId: string;
    requestDigest: string;
    agentVersionId: string;
    lease: LeaseBinding;
    commandId: string;
    sourceEventId: string;
  }): LocalInvocation {
    const existing = this.invocations.get(input.invocationId);
    if (existing) {
      if (existing.requestDigest !== input.requestDigest) {
        throw new WorkerJournalError('IDEMPOTENCY_CONFLICT');
      }
      if (
        existing.conversationId !== input.conversationId ||
        existing.clientMessageId !== input.clientMessageId ||
        existing.agentVersionId !== input.agentVersionId ||
        existing.prepareCommandId !== input.commandId ||
        existing.leaseId !== input.lease.leaseId ||
        existing.fence !== parseFence(input.lease.fence)
      ) {
        throw new WorkerJournalError('IDEMPOTENCY_CONFLICT');
      }
      const preparedEvent = this.outbox.find(
        (item) =>
          item.invocationId === existing.invocationId && item.eventType === 'invocation.prepared',
      );
      if (!preparedEvent || preparedEvent.sourceEventId !== input.sourceEventId) {
        throw new WorkerJournalError('IDEMPOTENCY_CONFLICT');
      }
      return { ...existing };
    }
    const clientReplay = [...this.invocations.values()].find(
      (item) =>
        item.conversationId === input.conversationId &&
        item.clientMessageId === input.clientMessageId,
    );
    if (clientReplay) throw new WorkerJournalError('CLIENT_MESSAGE_CONFLICT');
    if (this.activeInvocationId) throw new WorkerJournalError('WORKER_BUSY');

    return this.atomic((draft) => {
      const invocation: LocalInvocation = {
        invocationId: input.invocationId,
        conversationId: input.conversationId,
        clientMessageId: input.clientMessageId,
        requestDigest: input.requestDigest,
        agentVersionId: input.agentVersionId,
        leaseId: input.lease.leaseId,
        fence: parseFence(input.lease.fence),
        prepareCommandId: input.commandId,
        state: 'PREPARED',
        hostDispatchIntentCount: 0,
        hostDispatchConfirmedCount: 0,
      };
      draft.invocations.set(invocation.invocationId, invocation);
      draft.activeInvocationId = invocation.invocationId;
      draft.appendOutbox({
        sourceEventId: input.sourceEventId,
        invocationId: invocation.invocationId,
        eventType: 'invocation.prepared',
        payloadDigest: invocation.requestDigest,
        state: 'PENDING',
        attemptCount: 0,
      });
      return invocation;
    });
  }

  start(input: {
    invocationId: string;
    requestDigest: string;
    lease: LeaseBinding;
    commandId: string;
  }): LocalInvocation {
    return this.atomic((draft) => {
      const invocation = draft.requireInvocation(input.invocationId);
      draft.assertRequest(invocation, input.requestDigest);
      draft.assertLease(invocation, input.lease);
      if (invocation.startCommandId) {
        if (invocation.startCommandId !== input.commandId) {
          throw new WorkerJournalError('START_COMMAND_CONFLICT');
        }
        return invocation;
      }
      if (invocation.state !== 'PREPARED') {
        throw new WorkerJournalError('ILLEGAL_LOCAL_TRANSITION');
      }
      invocation.startCommandId = input.commandId;
      invocation.state = 'STARTING';
      invocation.hostDispatchIntentCount += 1;
      return invocation;
    });
  }

  confirmHostDispatch(input: {
    invocationId: string;
    requestDigest: string;
    runtimeTurnId: string;
    sourceEventId: string;
  }): LocalInvocation {
    return this.atomic((draft) => {
      const invocation = draft.requireInvocation(input.invocationId);
      draft.assertRequest(invocation, input.requestDigest);
      if (invocation.runtimeTurnId) {
        if (invocation.runtimeTurnId !== input.runtimeTurnId) {
          throw new WorkerJournalError('HOST_DISPATCH_ALREADY_CONFIRMED');
        }
        const startedEvent = draft.outbox.find(
          (item) =>
            item.invocationId === invocation.invocationId &&
            item.eventType === 'invocation.started',
        );
        if (!startedEvent || startedEvent.sourceEventId !== input.sourceEventId) {
          throw new WorkerJournalError('IDEMPOTENCY_CONFLICT');
        }
        return invocation;
      }
      if (invocation.state !== 'STARTING') {
        throw new WorkerJournalError('ILLEGAL_LOCAL_TRANSITION');
      }
      invocation.runtimeTurnId = input.runtimeTurnId;
      invocation.hostDispatchConfirmedCount += 1;
      invocation.state = 'RUNNING';
      draft.appendOutbox({
        sourceEventId: input.sourceEventId,
        invocationId: invocation.invocationId,
        eventType: 'invocation.started',
        payloadDigest: input.runtimeTurnId,
        state: 'PENDING',
        attemptCount: 0,
      });
      return invocation;
    });
  }

  writeFinal(input: {
    invocationId: string;
    requestDigest: string;
    resultDigest: string;
    sourceEventId: string;
  }): LocalInvocation {
    return this.atomic((draft) => {
      const invocation = draft.requireInvocation(input.invocationId);
      draft.assertRequest(invocation, input.requestDigest);
      if (invocation.resultDigest) {
        if (
          invocation.resultDigest !== input.resultDigest ||
          invocation.resultSourceEventId !== input.sourceEventId
        ) {
          throw new WorkerJournalError('FINAL_CONFLICT');
        }
        return invocation;
      }
      if (invocation.state !== 'RUNNING') {
        throw new WorkerJournalError('ILLEGAL_LOCAL_TRANSITION');
      }
      invocation.resultDigest = input.resultDigest;
      invocation.resultSourceEventId = input.sourceEventId;
      invocation.state = 'FINAL_READY';
      draft.appendOutbox({
        sourceEventId: input.sourceEventId,
        invocationId: invocation.invocationId,
        eventType: 'invocation.succeeded',
        payloadDigest: input.resultDigest,
        state: 'PENDING',
        attemptCount: 0,
      });
      return invocation;
    });
  }

  markCloudCommitted(invocationId: string, sourceEventId: string): LocalInvocation {
    return this.atomic((draft) => {
      const invocation = draft.requireInvocation(invocationId);
      if (invocation.state === 'CLOUD_COMMITTED') {
        if (invocation.resultSourceEventId !== sourceEventId) {
          throw new WorkerJournalError('IDEMPOTENCY_CONFLICT');
        }
        return invocation;
      }
      if (invocation.state !== 'FINAL_READY' || invocation.resultSourceEventId !== sourceEventId) {
        throw new WorkerJournalError('ILLEGAL_LOCAL_TRANSITION');
      }
      const record = draft.outbox.find(
        (item) => item.invocationId === invocationId && item.sourceEventId === sourceEventId,
      );
      if (!record) throw new WorkerJournalError('OUTBOX_NOT_FOUND');
      record.state = 'CLOUD_COMMITTED';
      invocation.state = 'CLOUD_COMMITTED';
      if (draft.activeInvocationId === invocationId) delete draft.activeInvocationId;
      return invocation;
    });
  }

  markUncertain(invocationId: string): LocalInvocation {
    return this.atomic((draft) => {
      const invocation = draft.requireInvocation(invocationId);
      if (invocation.state === 'UNCERTAIN') return invocation;
      if (invocation.state !== 'STARTING' && invocation.state !== 'RUNNING') {
        throw new WorkerJournalError('ILLEGAL_LOCAL_TRANSITION');
      }
      invocation.state = 'UNCERTAIN';
      if (draft.activeInvocationId === invocationId) delete draft.activeInvocationId;
      return invocation;
    });
  }

  snapshot(): WorkerJournalSnapshot {
    return {
      invocations: cloneMap(this.invocations),
      outbox: this.outbox.map((item) => ({ ...item })),
      ...(this.activeInvocationId ? { activeInvocationId: this.activeInvocationId } : {}),
    };
  }

  private atomic<T>(operation: (draft: WorkerDraft) => T): T {
    const draft = new WorkerDraft({
      invocations: cloneMap(this.invocations),
      outbox: this.outbox.map((item) => ({ ...item })),
      activeInvocationId: this.activeInvocationId,
    });
    const result = operation(draft);
    this.invocations = draft.invocations;
    this.outbox = draft.outbox;
    this.activeInvocationId = draft.activeInvocationId;
    return { ...result } as T;
  }
}

class WorkerDraft {
  readonly invocations: Map<string, LocalInvocation>;
  readonly outbox: LocalOutboxRecord[];
  activeInvocationId?: string;

  constructor(input: {
    invocations: Map<string, LocalInvocation>;
    outbox: LocalOutboxRecord[];
    activeInvocationId?: string;
  }) {
    this.invocations = input.invocations;
    this.outbox = input.outbox;
    this.activeInvocationId = input.activeInvocationId;
  }

  requireInvocation(invocationId: string): LocalInvocation {
    const invocation = this.invocations.get(invocationId);
    if (!invocation) throw new WorkerJournalError('INVOCATION_NOT_FOUND');
    return invocation;
  }

  assertRequest(invocation: LocalInvocation, requestDigest: string): void {
    if (invocation.requestDigest !== requestDigest) {
      throw new WorkerJournalError('IDEMPOTENCY_CONFLICT');
    }
  }

  assertLease(invocation: LocalInvocation, lease: LeaseBinding): void {
    if (invocation.leaseId !== lease.leaseId) throw new WorkerJournalError('STALE_LEASE');
    if (invocation.fence !== parseFence(lease.fence)) throw new WorkerJournalError('STALE_FENCE');
  }

  appendOutbox(record: LocalOutboxRecord): void {
    const existing = this.outbox.find((item) => item.sourceEventId === record.sourceEventId);
    if (existing) {
      if (
        existing.invocationId !== record.invocationId ||
        existing.eventType !== record.eventType ||
        existing.payloadDigest !== record.payloadDigest
      ) {
        throw new WorkerJournalError('IDEMPOTENCY_CONFLICT');
      }
      return;
    }
    this.outbox.push(record);
  }
}

function cloneMap<T extends object>(source: ReadonlyMap<string, T>): Map<string, T> {
  return new Map([...source].map(([key, value]) => [key, { ...value }]));
}

export function isLocalInvocationTerminal(state: LocalInvocationState): boolean {
  return LOCAL_TERMINAL.has(state);
}
